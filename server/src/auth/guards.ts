import type { FastifyReply, FastifyRequest } from "fastify";
import { HttpError, type Deps } from "../context.js";
import type { Prisma, Role, User } from "../generated/prisma/client.js";
import { safeEqual } from "./tokens.js";

export const SESSION_COOKIE = "uic_session";
/** Sliding: a session ends after 30 days without use (it's renewed at most hourly while used)... */
export const SESSION_TTL_S = 30 * 24 * 3600;
/** ...and 90 days after sign-in at the latest, so everyone signs in with Google again now and then. */
export const SESSION_MAX_S = 90 * 24 * 3600;
const SESSION_RENEW_AFTER_S = 3600;
/** "Last seen" on the Health page is updated at most this often per computer. */
const SEEN_EVERY_MS = 5 * 60_000;

export function sessionCookieOptions(deps: Deps) {
  return { httpOnly: true, secure: deps.config.NODE_ENV === "production", sameSite: "lax" as const, path: "/", maxAge: SESSION_TTL_S };
}

/** "desktop" + app version for UIC Dialer for Windows (its user agent ends with UICDialer/x.y.z), else the browser. */
export function describeClient(userAgent: string | undefined): { kind: "desktop" | "browser"; label: string } {
  const ua = userAgent ?? "";
  const app = /UICDialer\/([\w.-]+)/.exec(ua);
  if (app) return { kind: "desktop", label: `UIC Dialer for Windows ${app[1]}` };
  const browser =
    (/Edg\/(\d+)/.exec(ua) && `Edge ${/Edg\/(\d+)/.exec(ua)![1]}`) ||
    (/Firefox\/(\d+)/.exec(ua) && `Firefox ${/Firefox\/(\d+)/.exec(ua)![1]}`) ||
    (/Chrome\/(\d+)/.exec(ua) && `Chrome ${/Chrome\/(\d+)/.exec(ua)![1]}`) ||
    (/Version\/(\d+).*Safari/.exec(ua) && `Safari ${/Version\/(\d+)/.exec(ua)![1]}`) ||
    "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  return { kind: "browser", label: os ? `${browser} on ${os}` : browser };
}

/**
 * Sets a fresh session cookie. A new sign-in (no [sid]) also records the computer in web_sessions, so admins see
 * it with the phones and can revoke it. [since] = original sign-in time (unix seconds), kept across renewals.
 */
export async function issueSession(
  deps: Deps,
  req: FastifyRequest,
  reply: FastifyReply,
  uid: string,
  opts: { since?: number; sid?: string } = {},
) {
  const since = opts.since ?? Math.floor(Date.now() / 1000);
  let sid = opts.sid;
  if (!sid) {
    const { kind, label } = describeClient(req.headers["user-agent"]);
    sid = (await deps.db.webSession.create({ data: { userId: uid, kind, label }, select: { id: true } })).id;
  }
  const session = await deps.tokens.seal({ typ: "session", uid, since, sid }, SESSION_TTL_S);
  reply.setCookie(SESSION_COOKIE, session, sessionCookieOptions(deps));
  return sid;
}

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : undefined;
}

/** App requests: access JWT + device not revoked + user active (checked every call). */
export function requireDevice(deps: Deps) {
  return async (req: FastifyRequest) => {
    const token = bearer(req);
    if (!token) throw new HttpError(401, "Missing token");
    let claims;
    try {
      claims = await deps.tokens.verifyAccess(token);
    } catch {
      throw new HttpError(401, "Invalid or expired token");
    }
    const device = await deps.db.device.findUnique({ where: { id: claims.deviceId }, include: { user: true } });
    if (!device || device.userId !== claims.userId || device.revokedAt || !device.user.active) {
      throw new HttpError(401, "Device revoked or user inactive");
    }
    const { user, ...rest } = device;
    req.user = user;
    req.device = rest;
  };
}

/**
 * Dashboard requests: encrypted session cookie + user still active.
 * The Android app uses the same endpoints with its access token (no cookie, so no CSRF check).
 */
export function requireSession(deps: Deps, roles?: Role[]) {
  const device = requireDevice(deps);
  return async (req: FastifyRequest, reply?: FastifyReply) => {
    if (bearer(req)) {
      await device(req);
      if (roles && !roles.includes(req.user!.role)) throw new HttpError(403, "Forbidden");
      return;
    }
    const cookie = req.cookies[SESSION_COOKIE];
    if (!cookie) throw new HttpError(401, "Not signed in");
    let uid: unknown;
    let iat = 0;
    let since = 0;
    let sid: string | undefined;
    try {
      const claims = await deps.tokens.unseal(cookie);
      // Only real session cookies: a sealed desktop code or OIDC state must not work as a session.
      if (claims["typ"] === "session") uid = claims["uid"];
      iat = typeof claims["iat"] === "number" ? claims["iat"] : 0;
      since = typeof claims["since"] === "number" ? claims["since"] : iat;
      sid = typeof claims["sid"] === "string" ? claims["sid"] : undefined;
    } catch {
      throw new HttpError(401, "Session expired");
    }
    const [user, web] = await Promise.all([
      typeof uid === "string" ? deps.db.user.findUnique({ where: { id: uid } }) : null,
      sid ? deps.db.webSession.findUnique({ where: { id: sid }, select: { userId: true, revokedAt: true, lastSeenAt: true } }) : null,
    ]);
    if (!user?.active) throw new HttpError(401, "Not signed in");
    // Revoked by an admin (or signed out), or the record is gone: this computer must sign in again.
    if (sid && (!web || web.revokedAt || web.userId !== user.id)) throw new HttpError(401, "Signed out");
    if (roles && !roles.includes(user.role)) throw new HttpError(403, "Forbidden");
    // CSRF: state-changing requests must come from our own origin.
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin !== new URL(deps.config.PUBLIC_URL).origin) throw new HttpError(403, "Bad origin");
    }
    const now = Math.floor(Date.now() / 1000);
    if (now - since > SESSION_MAX_S) throw new HttpError(401, "Session expired");
    // Keep active users signed in: renew the cookie (at most hourly) while it's being used. A cookie from before
    // sessions were recorded gets a record now, so the computer shows on the Health page.
    if (reply && (!sid || now - iat > SESSION_RENEW_AFTER_S)) await issueSession(deps, req, reply, user.id, { since, ...(sid ? { sid } : {}) });
    if (sid && web && Date.now() - web.lastSeenAt.getTime() > SEEN_EVERY_MS) {
      await deps.db.webSession.update({ where: { id: sid }, data: { lastSeenAt: new Date() } }).catch(() => {});
    }
    req.webSessionId = sid;
    req.user = user;
  };
}

export function requireWorker(deps: Deps) {
  return async (req: FastifyRequest) => {
    const token = bearer(req);
    if (!token || !safeEqual(token, deps.config.WORKER_TOKEN)) throw new HttpError(401, "Bad worker token");
  };
}

/** Which calls a dashboard user may see. */
export function callScope(user: User): Prisma.CallWhereInput {
  if (user.role === "ADMIN") return {};
  if (user.role === "MANAGER" && user.team) return { user: { team: user.team } };
  return { userId: user.id };
}

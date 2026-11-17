import type { FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { claimsToIdentity } from "../auth/google.js";
import { SESSION_COOKIE, SESSION_TTL_S } from "../auth/guards.js";
import { AccessDeniedError, resolveUser } from "../auth/users.js";
import { HttpError, type Deps } from "../context.js";

const OIDC_COOKIE = "uic_oidc";

const GoogleLogin = z.object({
  idToken: z.string().min(10).max(4096),
  device: z.object({
    installId: z.string().min(8).max(100),
    model: z.string().max(100).optional(),
    androidVersion: z.string().max(20).optional(),
    appVersion: z.string().max(40).optional(),
  }),
});
/** Desktop app (UIC Dialer) sign-in: PKCE-style S256 challenge from the app; the code comes back via uicdialer://. */
export const DESKTOP_SCHEME = "uicdialer";
const DESKTOP_CODE_TTL_S = 120;
const Challenge = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const DesktopStart = z.object({ desktop: Challenge.optional() });
const DesktopExchange = z.object({ code: z.string().min(20).max(4096), verifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/) });
const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const RefreshBody = z.object({ refreshToken: z.string().min(20).max(200) });

const publicUser = (u: { id: string; email: string; name: string | null; role: string }) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
});

export async function authRoutes(app: FastifyInstance, deps: Deps) {
  const strict = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

  // ---- Android app ------------------------------------------------------

  app.post("/v1/auth/google", strict, async (req) => {
    const body = GoogleLogin.parse(req.body);
    let identity;
    try {
      identity = await deps.verifyGoogle(body.idToken);
    } catch {
      throw new HttpError(401, "Invalid Google token");
    }
    let user;
    try {
      user = await resolveUser(deps.db, deps.config, identity);
    } catch (e) {
      if (e instanceof AccessDeniedError) throw new HttpError(403, e.message);
      throw e;
    }
    const d = body.device;
    const info = { model: d.model ?? null, androidVersion: d.androidVersion ?? null, appVersion: d.appVersion ?? null };
    const device = await deps.db.device.upsert({
      where: { userId_installId: { userId: user.id, installId: d.installId } },
      create: { userId: user.id, installId: d.installId, ...info, lastSeenAt: new Date() },
      // Signing in again on the same install re-enables a device an admin revoked.
      update: { ...info, lastSeenAt: new Date(), revokedAt: null },
    });
    const tokens = await deps.tokens.issueForDevice(user.id, device.id);
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      user: publicUser(user),
    };
  });

  app.post("/v1/auth/refresh", strict, async (req) => {
    const { refreshToken } = RefreshBody.parse(req.body);
    const rotated = await deps.tokens.rotate(refreshToken);
    if (!rotated) throw new HttpError(401, "Refresh token invalid");
    return {
      accessToken: rotated.accessToken,
      refreshToken: rotated.refreshToken,
      expiresIn: rotated.expiresIn,
      user: publicUser(rotated.user),
    };
  });

  app.post("/v1/auth/logout", strict, async (req, reply) => {
    const { refreshToken } = RefreshBody.parse(req.body);
    await deps.tokens.revokeRefresh(refreshToken);
    return reply.code(204).send();
  });

  // ---- Web dashboard ----------------------------------------------------

  const secure = deps.config.NODE_ENV === "production";
  const cookieOpts = { httpOnly: true, secure, sameSite: "lax" as const, path: "/" };

  // Desktop exchange codes already used (single uic-api instance; entries expire with the code).
  const usedCodes = new Map<string, number>();

  app.get("/auth/google", strict, async (req, reply) => {
    if (!deps.oidc) throw new HttpError(503, "Dashboard sign-in is not configured");
    const { desktop } = DesktopStart.parse(req.query);
    const { url, verifier, state, nonce } = await deps.oidc.start();
    const sealed = await deps.tokens.seal({ verifier, state, nonce, ...(desktop ? { desktop } : {}) }, 600);
    reply.setCookie(OIDC_COOKIE, sealed, { ...cookieOpts, maxAge: 600 });
    return reply.redirect(url);
  });

  app.get("/auth/google/callback", strict, async (req, reply) => {
    if (!deps.oidc) throw new HttpError(503, "Dashboard sign-in is not configured");
    const sealed = req.cookies[OIDC_COOKIE];
    reply.clearCookie(OIDC_COOKIE, cookieOpts);
    if (!sealed) return reply.redirect("/?error=expired");
    try {
      const checks = await deps.tokens.unseal(sealed);
      const currentUrl = new URL(req.url, deps.config.PUBLIC_URL);
      const claims = await deps.oidc.finish(currentUrl, {
        verifier: String(checks["verifier"]),
        state: String(checks["state"]),
        nonce: String(checks["nonce"]),
      });
      const user = await resolveUser(deps.db, deps.config, claimsToIdentity(claims));
      if (typeof checks["desktop"] === "string") {
        // Signed in from the desktop app's browser tab: hand a one-time code back to the app instead of a cookie.
        const code = await deps.tokens.seal({ uid: user.id, ch: checks["desktop"], jti: randomUUID() }, DESKTOP_CODE_TTL_S);
        const target = escapeHtml(`${DESKTOP_SCHEME}://auth?code=${encodeURIComponent(code)}`);
        return reply
          .type("text/html; charset=utf-8")
          .header("cache-control", "no-store")
          .send(
            `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="0;url=${target}">` +
              `<title>UIC Dialer</title><body style="font:16px system-ui;margin:3rem auto;max-width:28rem;text-align:center">` +
              `<p>Signed in. Returning to UIC Dialer…</p><p><a href="${target}">Open UIC Dialer</a></p><p>You can close this tab.</p>`,
          );
      }
      const session = await deps.tokens.seal({ uid: user.id }, SESSION_TTL_S);
      reply.setCookie(SESSION_COOKIE, session, { ...cookieOpts, maxAge: SESSION_TTL_S });
      return reply.redirect("/");
    } catch (e) {
      req.log.warn({ err: e }, "dashboard sign-in failed");
      const reason = e instanceof AccessDeniedError ? "denied" : "failed";
      return reply.redirect(`/?error=${reason}`);
    }
  });

  app.get("/auth/desktop/exchange", strict, async (req, reply) => {
    const { code, verifier } = DesktopExchange.parse(req.query);
    let claims;
    try {
      claims = await deps.tokens.unseal(code);
    } catch {
      return reply.redirect("/?error=expired");
    }
    const { uid, ch, jti } = claims;
    if (typeof uid !== "string" || typeof ch !== "string" || typeof jti !== "string" || s256(verifier) !== ch) {
      return reply.redirect("/?error=failed");
    }
    const now = Date.now();
    for (const [k, exp] of usedCodes) if (exp < now) usedCodes.delete(k);
    if (usedCodes.has(jti)) return reply.redirect("/?error=expired");
    usedCodes.set(jti, now + DESKTOP_CODE_TTL_S * 1000);
    const user = await deps.db.user.findUnique({ where: { id: uid } });
    if (!user?.active) return reply.redirect("/?error=denied");
    const session = await deps.tokens.seal({ uid: user.id }, SESSION_TTL_S);
    reply.setCookie(SESSION_COOKIE, session, { ...cookieOpts, maxAge: SESSION_TTL_S });
    return reply.redirect("/");
  });

  app.post("/auth/logout", async (req, reply) => {
    if (req.headers.origin !== new URL(deps.config.PUBLIC_URL).origin) throw new HttpError(403, "Bad origin");
    reply.clearCookie(SESSION_COOKIE, cookieOpts);
    return reply.code(204).send();
  });
}

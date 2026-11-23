import type { FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { claimsToIdentity } from "../auth/google.js";
import { SESSION_COOKIE, issueSession } from "../auth/guards.js";
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
/** Header the desktop app adds when it redeems its sign-in code (see desktop/src/main.js). */
export const DESKTOP_HEADER = "x-uic-desktop";
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
    const sealed = await deps.tokens.seal({ typ: "oidc", verifier, state, nonce, ...(desktop ? { desktop } : {}) }, 600);
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
      if (checks["typ"] !== "oidc") throw new Error("Not an OIDC state cookie");
      const currentUrl = new URL(req.url, deps.config.PUBLIC_URL);
      const claims = await deps.oidc.finish(currentUrl, {
        verifier: String(checks["verifier"]),
        state: String(checks["state"]),
        nonce: String(checks["nonce"]),
      });
      const user = await resolveUser(deps.db, deps.config, claimsToIdentity(claims));
      if (typeof checks["desktop"] === "string") {
        // Signed in from the desktop app's browser tab: hand a one-time code back to the app instead of a cookie.
        const code = await deps.tokens.seal({ typ: "desktop_code", uid: user.id, ch: checks["desktop"], jti: randomUUID() }, DESKTOP_CODE_TTL_S);
        const target = escapeHtml(`${DESKTOP_SCHEME}://auth?code=${encodeURIComponent(code)}&state=${encodeURIComponent(checks["desktop"])}`);
        return reply
          .type("text/html; charset=utf-8")
          .header("cache-control", "no-store")
          .send(
            desktopReturnPage(target),
          );
      }
      await issueSession(deps, reply, user.id);
      return reply.redirect("/");
    } catch (e) {
      req.log.warn({ err: e }, "dashboard sign-in failed");
      const reason = e instanceof AccessDeniedError ? "denied" : "failed";
      return reply.redirect(`/?error=${reason}`);
    }
  });

  app.get("/auth/desktop/exchange", strict, async (req, reply) => {
    // Only the desktop app sends this header. A link or form on another site can't add it, so a victim's
    // browser can't be signed in as someone else (login CSRF).
    if (req.headers[DESKTOP_HEADER] !== "1") return reply.redirect("/?error=failed");
    const { code, verifier } = DesktopExchange.parse(req.query);
    let claims;
    try {
      claims = await deps.tokens.unseal(code);
    } catch {
      return reply.redirect("/?error=expired");
    }
    const { typ, uid, ch, jti } = claims;
    if (typ !== "desktop_code" || typeof uid !== "string" || typeof ch !== "string" || typeof jti !== "string" || s256(verifier) !== ch) {
      return reply.redirect("/?error=failed");
    }
    const now = Date.now();
    for (const [k, exp] of usedCodes) if (exp < now) usedCodes.delete(k);
    if (usedCodes.has(jti)) return reply.redirect("/?error=expired");
    usedCodes.set(jti, now + DESKTOP_CODE_TTL_S * 1000);
    const user = await deps.db.user.findUnique({ where: { id: uid } });
    if (!user?.active) return reply.redirect("/?error=denied");
    await issueSession(deps, reply, user.id);
    return reply.redirect("/");
  });

  app.post("/auth/logout", async (req, reply) => {
    if (req.headers.origin !== new URL(deps.config.PUBLIC_URL).origin) throw new HttpError(403, "Bad origin");
    reply.clearCookie(SESSION_COOKIE, cookieOpts);
    return reply.code(204).send();
  });
}

const LOGO = "data:image/png;base64,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";

/** Browser tab after a desktop sign-in: hands the one-time code to the app (uicdialer://), styled like the app. */
function desktopReturnPage(target: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=${target}"><title>Signed in · UIC Dialer</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fb;color:#0f172a;font:15px/1.5 "Segoe UI",system-ui,sans-serif}
.card{background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(15,23,42,.08);padding:2.5rem 2.25rem;max-width:24rem;width:calc(100% - 2rem);text-align:center}
img{width:64px;height:64px}
.tick{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:#16a34a;color:#fff;font-weight:700;margin:.75rem auto .25rem}
h1{font-size:1.3rem;margin:.25rem 0}
p{margin:.35rem 0;color:#475569}
a.btn{display:inline-block;margin-top:1.1rem;padding:.65rem 1.5rem;border-radius:999px;background:#1e4f8c;color:#fff;text-decoration:none;font-weight:600}
a.btn:hover{background:#173f70}
.small{font-size:13px;color:#94a3b8;margin-top:1rem}
</style></head><body><main class="card">
<img src="${LOGO}" alt="UIC">
<div class="tick">&#10003;</div>
<h1>You're signed in</h1>
<p>UIC Dialer is opening on your computer.</p>
<a class="btn" href="${target}">Open UIC Dialer</a>
<p class="small">Nothing happened? Click the button above. You can close this tab.</p>
</main></body></html>`;
}

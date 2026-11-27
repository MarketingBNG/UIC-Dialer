import { createHash } from "node:crypto";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyServerOptions } from "fastify";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { HttpError, type Deps } from "./context.js";
import { activityRoutes } from "./routes/activity.js";
import { authRoutes } from "./routes/auth.js";
import { callRoutes } from "./routes/calls.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { deviceRoutes } from "./routes/device.js";
import { firefliesRoutes } from "./routes/fireflies.js";
import { followupRoutes } from "./routes/followups.js";
import { importRoutes } from "./routes/import.js";
import { publishRoutes } from "./routes/publish.js";
import { realtimeRoutes } from "./realtime.js";
import { internalRoutes } from "./routes/internal.js";
import { dncRoutes } from "./routes/dnc.js";
import { leadRoutes } from "./routes/leads.js";
import { listRoutes } from "./routes/lists.js";
import { outcomeRoutes } from "./routes/outcomes.js";
import { teamRoutes } from "./routes/team.js";

export async function buildApp(deps: Deps, opts: FastifyServerOptions = {}) {
  const app = Fastify({
    trustProxy: true, // behind Coolify's reverse proxy
    bodyLimit: 1024 * 1024, // JSON bodies; audio is streamed separately
    ...opts,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https://*.googleusercontent.com"],
        mediaSrc: ["'self'"],
        connectSrc: ["'self'"],
        // shadcn/Radix position popovers and menus with inline style attributes, and Sonner injects its CSS.
        // Inline styles can't run code; scripts stay 'self' only.
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'", "https://accounts.google.com"],
      },
    },
  });
  await app.register(cookie);
  // Counted per signed-in person/phone (their token or session), not per IP: a whole office shares one IP.
  await app.register(rateLimit, {
    max: 600,
    timeWindow: "1 minute",
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      if (auth) return "t:" + createHash("sha256").update(auth).digest("hex").slice(0, 32);
      const session = /(?:^|;\s*)uic_session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
      if (session) return "s:" + createHash("sha256").update(session).digest("hex").slice(0, 32);
      return "ip:" + req.ip;
    },
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ ...err.extra, error: err.message, ...(err.code ? { code: err.code } : {}) });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "Invalid request", issues: err.issues.map((i) => ({ path: i.path, message: i.message })) });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: "Internal error" });
  });

  // Built dashboard (React SPA), served from the same origin.
  // Built: dist/src/app.js -> dist/public. Dev (tsx src/app.ts): falls back to dist/public too.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = [path.resolve(here, "../public"), path.resolve(here, "../dist/public")].find((d) =>
    existsSync(path.join(d, "index.html")),
  );
  app.get("/health", { config: { rateLimit: false } }, async (req, reply) => {
    // The dashboard also has a /health page: a browser loading it (reload, bookmark) gets the app, not this JSON.
    // Health checks (curl, Coolify, uptime monitors) don't ask for text/html.
    if (publicDir && req.headers.accept?.includes("text/html")) return reply.sendFile("index.html");
    await deps.db.$queryRaw`SELECT 1`;
    return { ok: true };
  });

  // Root level on purpose: its onResponse hook must see every route registered below.
  await realtimeRoutes(app, deps);
  await app.register(async (s) => authRoutes(s, deps));
  await app.register(async (s) => deviceRoutes(s, deps));
  await app.register(async (s) => callRoutes(s, deps));
  await app.register(async (s) => internalRoutes(s, deps));
  await app.register(async (s) => importRoutes(s, deps));
  await app.register(async (s) => publishRoutes(s, deps));
  await app.register(async (s) => dashboardRoutes(s, deps));
  await app.register(async (s) => firefliesRoutes(s, deps));
  await app.register(async (s) => activityRoutes(s, deps));
  await app.register(async (s) => followupRoutes(s, deps));
  await app.register(async (s) => outcomeRoutes(s, deps));
  await app.register(async (s) => listRoutes(s, deps));
  await app.register(async (s) => dncRoutes(s, deps));
  await app.register(async (s) => leadRoutes(s, deps));
  await app.register(async (s) => teamRoutes(s, deps));

  if (publicDir) {
    await app.register(fastifyStatic, {
      root: publicDir,
      wildcard: false,
      // Built files under /assets/ have a content hash in the name, so they never change: the browser and the
      // Windows app keep them for good and start without downloading them again. index.html is always re-checked
      // so a new release (new file names) shows up on the next load.
      cacheControl: false,
      setHeaders: (res, filePath) => {
        const immutable = /[\\/]assets[\\/]/.test(filePath);
        res.header("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
      },
    });
    app.setNotFoundHandler((req, reply) => {
      const isApi = /^\/(api|v1|internal|auth)\b/.test(req.url);
      if (req.method === "GET" && !isApi) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "Not found" });
    });
  }

  return app;
}

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import pg from "pg";
import { requireSession } from "./auth/guards.js";
import { currentUser, type Deps } from "./context.js";

/**
 * Live "something changed" notices for the dashboard / Windows app and the phone app.
 *
 * Events carry no data, only a topic (and the owning user for per-rep topics); clients
 * refetch with their own auth, so nothing leaks. Every successful write request is
 * mapped to a topic in one onResponse hook, which also covers the transcription worker
 * (it reports results through /internal/*). Events cross server instances through
 * Postgres LISTEN/NOTIFY.
 */

export type Topic = "activity" | "contacts" | "followups" | "calls" | "lists" | "settings";
export interface ChangeEvent {
  topic: Topic;
  /** Owner of the change; null = relevant to everyone. */
  userId: string | null;
}

const CHANNEL = "uic_changes";
const HEARTBEAT_MS = 25_000;
/** Streams are closed after this so the client reconnects and is re-authenticated. */
const MAX_STREAM_MS = 30 * 60_000;
const MAX_STREAMS_PER_USER = 10;

/** Route pattern -> topic. Per-rep topics are scoped to the owner; the rest go to everyone. */
export function topicFor(method: string, route: string): Topic | null {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
  if (/^\/(v1|api)\/activities/.test(route)) return "activity";
  if (/^\/(v1|api)\/followups/.test(route)) return "followups";
  if (/^\/(v1|api)\/(contacts|dnc)/.test(route)) return "contacts";
  if (route === "/v1/calls" || /^\/api\/calls\//.test(route)) return "calls";
  if (/^\/internal\/calls\/|^\/internal\/jobs\/:jobId\/(result|translation|summary|score)$/.test(route)) return "calls";
  if (/^\/(v1|api)\/(call-lists|my\/call-list-items)|^\/api\/lists?\b/.test(route)) return "lists";
  if (/^\/api\/(outcomes|templates|scripts|targets)/.test(route)) return "settings";
  return null;
}

const SCOPED: ReadonlySet<Topic> = new Set(["activity", "followups", "calls"]);

interface Stream {
  userId: string;
  seesAll: boolean;
  send: (e: ChangeEvent) => void;
  end: () => void;
}

export class Realtime {
  private readonly streams = new Set<Stream>();
  private readonly instance = randomUUID();
  private listener: pg.Client | undefined;
  private closed = false;
  private retryMs = 1000;

  constructor(
    private readonly deps: Pick<Deps, "db" | "config">,
    private readonly log: FastifyInstance["log"],
  ) {}

  /** Delivers locally and to other instances. Never throws. */
  async publish(e: ChangeEvent): Promise<void> {
    this.deliver(e);
    try {
      const payload = JSON.stringify({ ...e, from: this.instance });
      await this.deps.db.$executeRaw`SELECT pg_notify(${CHANNEL}, ${payload})`;
    } catch (err) {
      this.log.warn({ err }, "realtime: notify failed");
    }
  }

  subscribe(s: Stream): () => void {
    this.streams.add(s);
    void this.ensureListener();
    return () => this.streams.delete(s);
  }

  countFor(userId: string): number {
    let n = 0;
    for (const s of this.streams) if (s.userId === userId) n++;
    return n;
  }

  get size(): number {
    return this.streams.size;
  }

  private deliver(e: ChangeEvent): void {
    const scoped = SCOPED.has(e.topic) && e.userId !== null;
    for (const s of this.streams) {
      if (!scoped || s.seesAll || s.userId === e.userId) s.send(e);
    }
  }

  /** One LISTEN connection per instance, opened on the first subscriber, reconnected with backoff. */
  private async ensureListener(): Promise<void> {
    if (this.listener || this.closed) return;
    const client = new pg.Client({ connectionString: this.deps.config.DATABASE_URL });
    this.listener = client;
    const retry = () => {
      if (this.listener !== client) return;
      this.listener = undefined;
      void client.end().catch(() => {});
      if (this.closed) return;
      setTimeout(() => void this.ensureListener(), this.retryMs).unref();
      this.retryMs = Math.min(this.retryMs * 2, 60_000);
    };
    client.on("error", (err) => {
      this.log.warn({ err }, "realtime: listener error");
      retry();
    });
    client.on("end", retry);
    client.on("notification", (msg) => {
      try {
        const e = JSON.parse(msg.payload ?? "") as ChangeEvent & { from?: string };
        if (e.from !== this.instance) this.deliver({ topic: e.topic, userId: e.userId ?? null });
      } catch {
        /* ignore malformed */
      }
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      this.retryMs = 1000;
    } catch (err) {
      this.log.warn({ err }, "realtime: listener connect failed");
      retry();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const s of [...this.streams]) s.end();
    const c = this.listener;
    this.listener = undefined;
    if (c) await c.end().catch(() => {});
  }
}

/** Owner of a worker write: the call's rep. */
async function workerOwner(deps: Deps, req: FastifyRequest): Promise<string | null> {
  const p = (req.params ?? {}) as Record<string, string | undefined>;
  try {
    if (p["callId"]) return (await deps.db.call.findUnique({ where: { id: p["callId"] }, select: { userId: true } }))?.userId ?? null;
    if (p["jobId"]) {
      const job = await deps.db.job.findUnique({ where: { id: p["jobId"] }, select: { callId: true } });
      if (job) return (await deps.db.call.findUnique({ where: { id: job.callId }, select: { userId: true } }))?.userId ?? null;
    }
  } catch {
    /* fall through: broadcast */
  }
  return null;
}

export async function realtimeRoutes(app: FastifyInstance, deps: Deps) {
  const rt = new Realtime(deps, app.log);
  app.decorate("realtime", rt);
  app.addHook("onClose", async () => rt.close());

  // Must be called on the root instance (not inside app.register) so this hook sees every route.
  app.addHook("onResponse", async (req, reply) => {
    if (reply.statusCode >= 300) return;
    const topic = topicFor(req.method, req.routeOptions.url ?? "");
    if (!topic) return;
    const userId = req.user?.id ?? (req.url.startsWith("/internal/") ? await workerOwner(deps, req) : null);
    await rt.publish({ topic, userId: SCOPED.has(topic) ? userId : null });
  });

  const anyone = { preHandler: requireSession(deps), config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };
  app.get("/api/events", anyone, async (req, reply) => {
    const user = currentUser(req);
    if (rt.countFor(user.id) >= MAX_STREAMS_PER_USER) {
      return reply.code(429).send({ error: "Too many live connections" });
    }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const write = (chunk: string) => {
      if (!res.writableEnded) res.write(chunk);
    };
    // Tell the client how soon to retry, and that it's connected (it refetches on "ready").
    write(`retry: 3000\nevent: ready\ndata: {}\n\n`);
    const unsubscribe = rt.subscribe({
      userId: user.id,
      seesAll: user.role !== "AGENT",
      send: (e) => write(`event: change\ndata: ${JSON.stringify(e)}\n\n`),
      end: () => {
        done();
        res.end();
      },
    });
    const beat = setInterval(() => write(`: ping\n\n`), HEARTBEAT_MS);
    const done = () => {
      clearInterval(beat);
      clearTimeout(expire);
      unsubscribe();
    };
    const expire = setTimeout(() => {
      done();
      res.end();
    }, MAX_STREAM_MS);
    req.raw.on("close", done);
  });
}

declare module "fastify" {
  interface FastifyInstance {
    realtime: Realtime;
  }
}

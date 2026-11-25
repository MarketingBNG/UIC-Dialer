import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { requireDevice } from "../auth/guards.js";
import { HttpError, currentDevice, currentUser, type Deps } from "../context.js";
import { hashKey } from "../privacy/clientNumbers.js";
import { getSettings } from "../settings.js";
import { SimReport, setSimNumber, upsertSims } from "../devices/sims.js";

const Heartbeat = z.object({
  appVersion: z.string().max(40).optional(),
  pendingCount: z.number().int().min(0).max(10_000_000),
  permissionsOk: z.boolean(),
  freeBytes: z.number().int().min(0).optional(),
  lastSyncAt: z.iso.datetime().optional(),
  // M4 (all optional so older apps keep working).
  standbyBucket: z.number().int().min(0).max(1000).nullable().optional(),
  lastStopReason: z.number().int().min(-512).max(1000).nullable().optional(),
  calls7d: z.number().int().min(0).max(100_000).nullable().optional(),
  recordings7d: z.number().int().min(0).max(100_000).nullable().optional(),
  autostartIntent: z.string().max(200).nullable().optional(),
  defaultDialer: z.string().max(200).nullable().optional(),
  /** The SIMs in the phone right now; absent from older apps or without phone-state permission. */
  sims: z.array(SimReport).max(8).optional(),
});

const SimNumber = z.object({ simKey: z.string().min(1).max(100), number: z.string().max(40).nullish() });
const M4_FIELDS = ["standbyBucket", "lastStopReason", "calls7d", "recordings7d", "autostartIntent", "defaultDialer"] as const;

export async function deviceRoutes(app: FastifyInstance, deps: Deps) {
  const auth = { preHandler: requireDevice(deps) };

  app.get("/v1/device/config", auth, async (req) => {
    const user = currentUser(req);
    const { deviceConfig } = await getSettings(deps.db);
    return { ...deviceConfig, excludedNumbers: user.excludedNumbers };
  });

  /**
   * Business-only mode: sha256 of each client-list number key (last 10 digits), never the numbers themselves.
   * The phone uploads a call to a saved personal contact only when its number's hash is in this list.
   */
  /** ETag = sha256 of the sorted keys, so an unchanged list answers 304 instead of up to ~13 MB of JSON. */
  app.get("/v1/device/client-numbers", auth, async (req, reply) => {
    const rows = await deps.db.clientNumber.findMany({ select: { key: true }, orderBy: { key: "asc" } });
    const etag = `"${createHash("sha256").update(rows.map((r) => r.key).join(",")).digest("hex")}"`;
    reply.header("etag", etag);
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();
    return { hashes: rows.map((r) => hashKey(r.key)) };
  });

  app.post("/v1/device/heartbeat", auth, async (req, reply) => {
    const body = Heartbeat.parse(req.body);
    // The app drops nulls from its JSON, so an M4 heartbeat that omits a field means "now unknown": clear it
    // instead of keeping a stale value (and a stale alert). Older apps send none of these and keep them as-is.
    const m4 = M4_FIELDS.some((k) => k in body);
    const health = <T,>(v: T | null | undefined): T | null | undefined => (m4 ? v ?? null : undefined);
    await deps.db.device.update({
      where: { id: currentDevice(req).id },
      data: {
        appVersion: body.appVersion ?? undefined,
        pendingCount: body.pendingCount,
        permissionsOk: body.permissionsOk,
        freeBytes: body.freeBytes !== undefined ? BigInt(body.freeBytes) : undefined,
        lastSyncAt: body.lastSyncAt ? new Date(body.lastSyncAt) : undefined,
        standbyBucket: health(body.standbyBucket),
        lastStopReason: health(body.lastStopReason),
        calls7d: health(body.calls7d),
        recordings7d: health(body.recordings7d),
        autostartIntent: health(body.autostartIntent),
        defaultDialer: health(body.defaultDialer),
        lastSeenAt: new Date(),
      },
    });
    if (body.sims?.length) await upsertSims(deps.db, currentDevice(req).id, body.sims, deps.config.DEFAULT_PHONE_REGION);
    return reply.code(204).send();
  });

  /** This phone's SIMs, so the app can ask for any number it doesn't know yet. */
  app.get("/v1/device/sims", auth, async (req) => {
    const sims = await deps.db.deviceSim.findMany({ where: { deviceId: currentDevice(req).id }, orderBy: { slot: "asc" } });
    return { sims: sims.map((s) => ({ key: s.simKey, slot: s.slot, carrier: s.carrier, number: s.number, numberSetBy: s.numberSetBy })) };
  });

  /** The rep types the number of one of their SIMs. An admin-set number can only be changed from the dashboard. */
  app.put("/v1/device/sims", auth, async (req, reply) => {
    const body = SimNumber.parse(req.body);
    const deviceId = currentDevice(req).id;
    const cur = await deps.db.deviceSim.findUnique({ where: { deviceId_simKey: { deviceId, simKey: body.simKey } } });
    if (cur?.numberSetBy === "ADMIN") throw new HttpError(409, "Your admin set this number; ask them to change it");
    if (!(await setSimNumber(deps.db, deviceId, body.simKey, body.number ?? null, "USER", deps.config.DEFAULT_PHONE_REGION))) {
      throw new HttpError(400, "That doesn't look like a phone number");
    }
    return reply.code(204).send();
  });

  app.get("/v1/app/latest", auth, async () => {
    const { latestApp } = await getSettings(deps.db);
    if (!latestApp) return { available: false };
    return { available: true, ...latestApp, downloadPath: "/v1/app/download" };
  });

  // Public link for first installs (people without the app yet). Sign-in still limits who can use it.
  const sendApk = async (_req: unknown, reply: import("fastify").FastifyReply) => {
    const { latestApp } = await getSettings(deps.db);
    if (!latestApp) throw new HttpError(404, "No app published");
    // Inside the mounted storage dir so it survives redeploys.
    const file = path.join(deps.storage.root, "apk", latestApp.fileName);
    const found = await stat(file).catch(() => null);
    if (!found?.isFile()) throw new HttpError(404, "App file missing");
    reply.header("content-length", found.size);
    reply.header("content-type", "application/vnd.android.package-archive");
    reply.header("content-disposition", `attachment; filename="${latestApp.fileName}"`);
    return reply.send(createReadStream(file));
  };
  app.get("/v1/app/download", auth, sendApk);
  app.get("/app.apk", sendApk);
}

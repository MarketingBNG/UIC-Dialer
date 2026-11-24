import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError, type Deps } from "../context.js";
import { Prisma, type CallSource, type DialVia } from "../generated/prisma/client.js";
import { LINK_WINDOW_MS, closeMissedTasks, linkCallToActivity } from "../activity/service.js";
import { decideCallVia } from "../activity/via.js";
import { toE164 } from "../phone.js";
import { upsertSims } from "../devices/sims.js";
import { ChecksumMismatchError, UploadTooLargeError, mimeFromContentType } from "../storage/local.js";

export const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

export const CheckBody = z.object({ hashes: z.array(sha256Hex).min(1).max(500) });

export const CallMeta = z.object({
  originalSha256: sha256Hex,
  phoneNumber: z.string().max(40).optional(),
  contactName: z.string().max(200).optional(),
  direction: z.enum(["INCOMING", "OUTGOING", "MISSED", "UNKNOWN"]).default("UNKNOWN"),
  startedAt: z.iso.datetime({ offset: true }),
  durationS: z.number().int().min(0).max(24 * 3600).optional(),
  originalName: z.string().max(255).optional(),
  /** The SIM the call used (call log PHONE_ACCOUNT_ID), its slot and carrier. */
  simKey: z.string().min(1).max(100).optional(),
  simSlot: z.number().int().min(0).max(8).optional(),
  simCarrier: z.string().max(100).optional(),
});
export type CallMeta = z.infer<typeof CallMeta>;

/** Live calls are transcribed before backlog/imported ones. */
export const PRIORITY: Record<CallSource, number> = { LIVE: 10, BACKLOG: 0, IMPORT: 0 };

/** Which of these original-file hashes are already fully uploaded for this user? */
export async function knownHashes(deps: Deps, userId: string, hashes: string[]): Promise<string[]> {
  const rows = await deps.db.call.findMany({
    where: { userId, originalSha256: { in: hashes }, status: { not: "PENDING_UPLOAD" } },
    select: { originalSha256: true },
  });
  return rows.map((r) => r.originalSha256);
}

/** Registers call metadata; idempotent on (user, original file hash). */
export async function registerCall(
  deps: Deps,
  userId: string,
  deviceId: string | null,
  source: CallSource,
  body: CallMeta,
  bodyVia?: DialVia,
): Promise<{ callId: string; alreadyUploaded: boolean }> {
  const data = {
    deviceId,
    source,
    phoneRaw: body.phoneNumber ?? null,
    phoneE164: toE164(body.phoneNumber, deps.config.DEFAULT_PHONE_REGION) ?? null,
    contactName: body.contactName ?? null,
    direction: body.direction,
    startedAt: new Date(body.startedAt),
    durationS: body.durationS ?? null,
    originalName: body.originalName ?? null,
    simKey: body.simKey ?? null,
    simSlot: body.simSlot ?? null,
    simCarrier: body.simCarrier ?? null,
  };
  const key = { userId_originalSha256: { userId, originalSha256: body.originalSha256 } };
  let existing = await deps.db.call.findUnique({ where: key });
  if (!existing) {
    try {
      existing = await deps.db.call.create({ data: { ...data, userId, originalSha256: body.originalSha256 } });
    } catch (e) {
      // The same recording registered twice at once: continue with the row the other request created.
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
      existing = await deps.db.call.findUniqueOrThrow({ where: key });
      if (existing.status !== "PENDING_UPLOAD") return { callId: existing.id, alreadyUploaded: true };
    }
  } else {
    if (existing.status !== "PENDING_UPLOAD") return { callId: existing.id, alreadyUploaded: true };
    existing = await deps.db.call.update({ where: { id: existing.id }, data });
  }
  let call = existing;
  if (deviceId && body.simKey) {
    await upsertSims(deps.db, deviceId, [{ key: body.simKey, slot: body.simSlot, carrier: body.simCarrier }], deps.config.DEFAULT_PHONE_REGION, call.startedAt, false);
  }
  // Imported files carry no dialling history.
  if (!call.via && source !== "IMPORT") call = await setCallVia(deps, call, bodyVia);
  if (call.phoneE164 && (call.direction === "OUTGOING" || (call.direction === "INCOMING" && (call.durationS ?? 0) > 0))) {
    await closeMissedTasks(deps.db, userId, call.phoneE164, call.startedAt);
  }
  // The rep may have logged the call's outcome in the dialer before the recording was found.
  await linkCallToActivity(deps, call);
  return { callId: call.id, alreadyUploaded: false };
}

type CallRow = Awaited<ReturnType<Deps["db"]["call"]["create"]>>;

class IntentTaken extends Error {}

/** Decides an outgoing call's via; a desktop dial intent near the start time is claimed at most once. */
async function setCallVia(deps: Deps, call: CallRow, bodyVia: DialVia | undefined): Promise<CallRow> {
  if (call.direction !== "OUTGOING") return call;

  if (bodyVia !== "APP" && call.phoneE164) {
    const at = call.startedAt.getTime();
    const intents = await deps.db.dialIntent.findMany({
      where: {
        userId: call.userId,
        phoneE164: call.phoneE164,
        callId: null,
        createdAt: { gte: new Date(at - LINK_WINDOW_MS), lte: new Date(at + LINK_WINDOW_MS) },
      },
      select: { id: true, createdAt: true },
    });
    intents.sort((a, b) => Math.abs(a.createdAt.getTime() - at) - Math.abs(b.createdAt.getTime() - at));
    const laptopVia = decideCallVia(call.direction, bodyVia, true);
    for (const intent of intents) {
      // Claim the intent and set via together: a concurrent run that already set via gets no claim.
      const r = await deps.db.$transaction(async (tx) => {
        const set = await tx.call.updateMany({ where: { id: call.id, via: null }, data: { via: laptopVia } });
        if (set.count === 0) return "via-set" as const;
        const { count } = await tx.dialIntent.updateMany({ where: { id: intent.id, callId: null }, data: { callId: call.id } });
        if (count === 0) throw new IntentTaken();
        return "claimed" as const;
      }).catch((e) => {
        if (e instanceof IntentTaken) return "taken" as const;
        throw e;
      });
      if (r === "claimed") return { ...call, via: laptopVia };
      if (r === "via-set") return { ...call, via: (await deps.db.call.findUniqueOrThrow({ where: { id: call.id }, select: { via: true } })).via };
    }
  }
  const via = decideCallVia(call.direction, bodyVia, false);
  if (!via) return call;
  await deps.db.call.updateMany({ where: { id: call.id, via: null }, data: { via } });
  return { ...call, via };
}

/** Marks the call UPLOADED and queues transcription; only one concurrent upload wins the transition. */
async function markStored(
  deps: Deps,
  call: { id: string; source: CallSource },
  rel: string,
  saved: { sha256: string; size: number },
  mime: string,
): Promise<boolean> {
  return deps.db.$transaction(async (tx) => {
    const { count } = await tx.call.updateMany({
      where: { id: call.id, status: "PENDING_UPLOAD" },
      data: {
        status: "UPLOADED",
        filePath: rel,
        fileSize: BigInt(saved.size),
        uploadSha256: saved.sha256,
        mimeType: mime,
        uploadedAt: new Date(),
      },
    });
    if (count === 1) await tx.job.create({ data: { callId: call.id, priority: PRIORITY[call.source] } });
    return count === 1;
  });
}

/** markStored; a losing concurrent upload of a different file removes its own copy (never the winner's). */
async function markStoredOrDiscard(
  deps: Deps,
  call: { id: string; source: CallSource },
  rel: string,
  saved: { sha256: string; size: number },
  mime: string,
): Promise<boolean> {
  const won = await markStored(deps, call, rel, saved, mime);
  if (!won) {
    const winner = await deps.db.call.findUnique({ where: { id: call.id }, select: { filePath: true } });
    if (winner?.filePath !== rel) await deps.storage.remove(rel);
  }
  return won;
}

const intHeader = (v: string | string[] | undefined): number | undefined => {
  if (typeof v !== "string" || !/^\d{1,15}$/.test(v)) return undefined;
  return Number(v);
};

/** Partial uploads being written right now (this process; the server runs as a single instance). */
const activePartials = new Set<string>();

export type StoreResult = { callId: string; alreadyUploaded: boolean; complete: boolean; received?: number };

/**
 * Streams the request body to disk, verifying X-Content-SHA256, then marks the
 * call UPLOADED and queues its transcription job (exactly once).
 *
 * Resumable mode (the app sends Upload-Offset and Upload-Length): bytes are appended to a partial file kept
 * across dropped connections; Upload-Offset must equal what the server already has (else 409 with the right
 * offset in the Upload-Offset header). The checksum covers the whole file and is checked once it is complete.
 * Without those headers the body is the whole file, as before.
 */
export async function storeAudio(
  deps: Deps,
  req: FastifyRequest,
  userId: string,
  callId: string,
  reply?: { header: (k: string, v: string | number) => unknown },
): Promise<StoreResult> {
  const maxBytes = deps.config.MAX_UPLOAD_MB * 1024 * 1024;
  const mime = mimeFromContentType(req.headers["content-type"]);
  if (!mime) throw new HttpError(415, "Unsupported audio type");
  const expected = sha256Hex.safeParse(req.headers["x-content-sha256"]);
  if (!expected.success) throw new HttpError(400, "Missing or invalid X-Content-SHA256");
  const offset = intHeader(req.headers["upload-offset"]);
  const total = intHeader(req.headers["upload-length"]);
  if (offset !== undefined && total === undefined) throw new HttpError(400, "Upload-Offset needs Upload-Length");
  if ((total ?? Number(req.headers["content-length"] ?? 0)) > maxBytes) throw new HttpError(413, "File too large");

  const call = await deps.db.call.findFirst({ where: { id: callId, userId } });
  if (!call) throw new HttpError(404, "Call not found");
  if (call.status !== "PENDING_UPLOAD") return { callId: call.id, alreadyUploaded: true, complete: true };

  const rel = deps.storage.callPath(userId, call.id, call.startedAt, mime, expected.data);

  if (offset !== undefined && total !== undefined) {
    // One writer per partial file. A dropped request can still be flushing its last bytes when the phone's
    // retry arrives; letting both append would interleave them and corrupt the file.
    const key = `${call.id}.${expected.data}`;
    if (activePartials.has(key)) {
      reply?.header("upload-offset", await deps.storage.partialSize(call.id, expected.data));
      throw new HttpError(409, "An upload of this file is still in progress; try again shortly");
    }
    activePartials.add(key);
    let size: number;
    try {
      const have = await deps.storage.partialSize(call.id, expected.data);
      if (offset !== have) {
        reply?.header("upload-offset", have);
        throw new HttpError(409, `Upload offset mismatch; server has ${have} bytes`);
      }
      size = await deps.storage.appendPartial(req.raw, call.id, expected.data, maxBytes);
    } catch (e) {
      if (e instanceof UploadTooLargeError) throw new HttpError(413, "File too large");
      throw e;
    } finally {
      activePartials.delete(key);
    }
    if (size < total) return { callId: call.id, alreadyUploaded: false, complete: false, received: size };
    if (size > total) {
      await deps.storage.removePartial(call.id, expected.data);
      throw new HttpError(422, "More bytes than Upload-Length");
    }
    let saved;
    try {
      saved = await deps.storage.finishPartial(call.id, expected.data, rel);
    } catch (e) {
      if (e instanceof ChecksumMismatchError) throw new HttpError(422, "Checksum mismatch");
      throw e;
    }
    const won = await markStoredOrDiscard(deps, call, rel, saved, mime);
    return { callId: call.id, alreadyUploaded: !won, complete: true };
  }

  let saved;
  try {
    // Verified before it is moved into place, so a corrupt upload never touches a stored file.
    saved = await deps.storage.save(req.raw, rel, maxBytes, expected.data);
  } catch (e) {
    if (e instanceof UploadTooLargeError) throw new HttpError(413, "File too large");
    if (e instanceof ChecksumMismatchError) throw new HttpError(422, "Checksum mismatch");
    throw e;
  }
  const won = await markStoredOrDiscard(deps, call, rel, saved, mime);
  return { callId: call.id, alreadyUploaded: !won, complete: true };
}

/** How many bytes of this upload the server has (for resuming), or that it is already complete. */
export async function audioProgress(
  deps: Deps,
  userId: string,
  callId: string,
  sha256: string,
): Promise<{ complete: boolean; received: number }> {
  const call = await deps.db.call.findFirst({ where: { id: callId, userId }, select: { id: true, status: true } });
  if (!call) throw new HttpError(404, "Call not found");
  if (call.status !== "PENDING_UPLOAD") return { complete: true, received: 0 };
  return { complete: false, received: await deps.storage.partialSize(call.id, sha256) };
}

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireDevice, requireSession } from "../auth/guards.js";
import { HttpError, currentUser, type Deps } from "../context.js";
import { Prisma } from "../generated/prisma/client.js";
import { toE164 } from "../phone.js";
import { isDnc } from "../activity/dnc.js";
import { FollowUpPatch, MissedItem, followUpsToday, patchTask, phoneStatus, saveMissed } from "../activity/followups.js";

const DialIntentBody = z.object({
  clientId: z.uuid(),
  phone: z.string().trim().min(1).max(40),
  // Dial a do-not-call number anyway (the rep confirmed).
  override: z.boolean().optional(),
});
const VersionQuery = z.object({ v: z.string().max(5).optional() });
const isV2 = (req: FastifyRequest) => Number(VersionQuery.parse(req.query).v ?? "1") >= 2;
const taskParam = (req: FastifyRequest) => z.uuid().parse((req.params as { taskId: string }).taskId);

const intentDto = (i: { id: string; clientId: string; phoneE164: string; createdAt: Date }) => ({
  id: i.id,
  clientId: i.clientId,
  phoneE164: i.phoneE164,
  createdAt: i.createdAt,
});

/** Stage 1: today's follow-ups, missed-call tasks, desktop dial intents and the rep's phone status. */
export async function followupRoutes(app: FastifyInstance, deps: Deps) {
  const device = { preHandler: requireDevice(deps) };
  const anyone = { preHandler: requireSession(deps) };

  // ---- Phone app ----

  /** Missed calls from the phone's call log (1..50); each item succeeds or fails on its own. */
  app.post("/v1/followups/missed", device, async (req) => {
    const raw = z.object({ items: z.array(z.unknown()).min(1).max(50) }).parse(req.body).items;
    const userId = currentUser(req).id;
    const results = [];
    for (const item of raw) {
      const parsed = MissedItem.safeParse(item);
      const clientId = typeof (item as { clientId?: unknown })?.clientId === "string" ? (item as { clientId: string }).clientId : null;
      if (!parsed.success) {
        results.push({ clientId, ok: false, status: 400, error: parsed.error.issues[0]?.message ?? "Invalid item" });
        continue;
      }
      try {
        results.push({ clientId, ok: true, ...(await saveMissed(deps, userId, parsed.data)) });
      } catch (e) {
        if (!(e instanceof HttpError) || e.statusCode >= 500) throw e; // server trouble: the phone retries the batch
        results.push({ clientId, ok: false, status: e.statusCode, error: e.message });
      }
    }
    return { results };
  });

  app.get("/v1/followups/today", device, async (req) => followUpsToday(deps, currentUser(req).id, new Date(), { v2: isV2(req) }));

  app.patch("/v1/followups/:taskId", device, async (req) =>
    patchTask(deps, currentUser(req).id, taskParam(req), FollowUpPatch.parse(req.body)),
  );

  // ---- Dashboard / desktop ----

  app.get("/api/followups/today", anyone, async (req) => followUpsToday(deps, currentUser(req).id, new Date(), { v2: isV2(req) }));

  app.patch("/api/followups/:taskId", anyone, async (req) =>
    patchTask(deps, currentUser(req).id, taskParam(req), FollowUpPatch.parse(req.body)),
  );

  /** A tel: click on the dashboard; the next outgoing call on that number is then labelled "via laptop". */
  app.post("/api/dial-intents", anyone, async (req) => {
    const userId = currentUser(req).id;
    const body = DialIntentBody.parse(req.body);
    const phoneE164 = toE164(body.phone, deps.config.DEFAULT_PHONE_REGION);
    if (!phoneE164) throw new HttpError(400, "Invalid phone number");
    const own = (i: Parameters<typeof intentDto>[0] & { userId: string }) => {
      if (i.userId !== userId) throw new HttpError(409, "clientId already used");
      return intentDto(i);
    };
    const prior = await deps.db.dialIntent.findUnique({ where: { clientId: body.clientId } });
    if (prior) return own(prior);
    if (!body.override && (await isDnc(deps.db, phoneE164))) {
      throw new HttpError(409, "Number is on the do-not-call list", "DNC");
    }
    try {
      return intentDto(await deps.db.dialIntent.create({ data: { clientId: body.clientId, userId, phoneE164 } }));
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return own(await deps.db.dialIntent.findUniqueOrThrow({ where: { clientId: body.clientId } }));
      }
      throw e;
    }
  });

  app.get("/api/me/phone", anyone, async (req) => phoneStatus(deps, currentUser(req).id));
}

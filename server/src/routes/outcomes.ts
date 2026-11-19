import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireDevice, requireSession } from "../auth/guards.js";
import { HttpError, currentUser, type Deps } from "../context.js";
import { OutcomeInput, checkOutcomeCombo, outcomeDto } from "../activity/outcomes.js";
import { scriptDto } from "../lists/service.js";
import { audit } from "../audit.js";

const idParam = (req: FastifyRequest) => z.uuid().parse((req.params as { id: string }).id);
const AllQuery = z.object({ all: z.enum(["1", "true", "0", "false"]).optional() });
const wantsAll = (req: FastifyRequest) => ["1", "true"].includes(AllQuery.parse(req.query).all ?? "");

const Section = z.object({ heading: z.string().trim().min(1).max(40), text: z.string().trim().max(2000) });
const ScriptBody = z.object({
  name: z.string().trim().min(1).max(100),
  sections: z.array(Section).min(1).max(10),
  active: z.boolean().optional(),
});
const TemplateBody = z.object({
  name: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(1000),
  whatsapp: z.boolean(),
  sms: z.boolean(),
  active: z.boolean().optional(),
});

const templateDto = (t: { id: string; name: string; body: string; whatsapp: boolean; sms: boolean; active: boolean; sortOrder: number }) => ({
  id: t.id,
  name: t.name,
  body: t.body,
  whatsapp: t.whatsapp,
  sms: t.sms,
  active: t.active,
  sortOrder: t.sortOrder,
});

/** Stage 2 admin catalogs: custom call outcomes, call scripts, WhatsApp/SMS message templates. */
export async function outcomeRoutes(app: FastifyInstance, deps: Deps) {
  const device = { preHandler: requireDevice(deps) };
  const anyone = { preHandler: requireSession(deps) };
  const managers = { preHandler: requireSession(deps, ["ADMIN", "MANAGER"]) };
  const admins = { preHandler: requireSession(deps, ["ADMIN"]) };
  const order = [{ sortOrder: "asc" as const }, { label: "asc" as const }];

  // ---- Outcomes ----

  app.get("/v1/outcomes", device, async () => ({
    items: (await deps.db.outcomeDef.findMany({ where: { active: true }, orderBy: order })).map(outcomeDto),
  }));

  app.get("/api/outcomes", anyone, async (req) => {
    const all = wantsAll(req) && currentUser(req).role === "ADMIN";
    return { items: (await deps.db.outcomeDef.findMany({ where: all ? {} : { active: true }, orderBy: order })).map(outcomeDto) };
  });

  app.post("/api/outcomes", admins, async (req, reply) => {
    const body = OutcomeInput.parse(req.body);
    checkOutcomeCombo(body);
    const last = await deps.db.outcomeDef.aggregate({ _max: { sortOrder: true } });
    const o = await deps.db.outcomeDef.create({
      data: {
        label: body.label,
        color: body.color.toUpperCase(),
        baseOutcome: body.baseOutcome,
        rule: body.rule,
        retryHours: body.rule === "RETRY" ? (body.retryHours ?? null) : null,
        addToDnc: body.rule === "REMOVE_FROM_LISTS" ? (body.addToDnc ?? false) : false,
        active: body.active ?? true,
        sortOrder: (last._max.sortOrder ?? 0) + 10,
      },
    });
    await audit(deps, req, "OUTCOME_CHANGE", { created: o.id, label: o.label });
    return reply.code(201).send(outcomeDto(o));
  });

  app.put("/api/outcomes/order", admins, async (req) => {
    const { ids } = z.object({ ids: z.array(z.uuid()).min(1).max(200) }).parse(req.body);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, "Duplicate ids");
    await deps.db.$transaction(ids.map((id, i) => deps.db.outcomeDef.updateMany({ where: { id }, data: { sortOrder: i * 10 } })));
    await audit(deps, req, "OUTCOME_CHANGE", { order: ids });
    return { items: (await deps.db.outcomeDef.findMany({ orderBy: order })).map(outcomeDto) };
  });

  app.patch("/api/outcomes/:id", admins, async (req) => {
    const id = idParam(req);
    const patch = OutcomeInput.partial().parse(req.body);
    const cur = await deps.db.outcomeDef.findUnique({ where: { id } });
    if (!cur) throw new HttpError(404, "Outcome not found");
    const next = {
      baseOutcome: patch.baseOutcome ?? cur.baseOutcome,
      rule: patch.rule ?? cur.rule,
      retryHours: patch.retryHours !== undefined ? patch.retryHours : cur.retryHours,
    };
    checkOutcomeCombo(next);
    const o = await deps.db.outcomeDef.update({
      where: { id },
      data: {
        label: patch.label,
        color: patch.color?.toUpperCase(),
        baseOutcome: patch.baseOutcome,
        rule: patch.rule,
        retryHours: next.rule === "RETRY" ? next.retryHours : null,
        addToDnc: next.rule === "REMOVE_FROM_LISTS" ? (patch.addToDnc ?? cur.addToDnc) : false,
        active: patch.active,
      },
    });
    await audit(deps, req, "OUTCOME_CHANGE", { outcomeId: id, ...patch });
    return outcomeDto(o);
  });

  // ---- Scripts ----

  /** A script the rep may read: it is on a list assigned to them. */
  app.get("/v1/scripts/:id", device, async (req) => {
    const s = await deps.db.callScript.findFirst({
      where: { id: idParam(req), lists: { some: { state: { not: "ARCHIVED" }, assignees: { some: { userId: currentUser(req).id } } } } },
    });
    if (!s) throw new HttpError(404, "Script not found");
    return scriptDto(s);
  });

  app.get("/api/scripts", managers, async () => {
    const rows = await deps.db.callScript.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }], include: { _count: { select: { lists: true } } } });
    return { items: rows.map((s) => ({ ...scriptDto(s), listCount: s._count.lists })) };
  });

  app.post("/api/scripts", admins, async (req, reply) => {
    const body = ScriptBody.parse(req.body);
    const s = await deps.db.callScript.create({ data: { name: body.name, sections: body.sections, active: body.active ?? true } });
    await audit(deps, req, "CALL_LIST_CHANGE", { scriptCreated: s.id, name: s.name });
    return reply.code(201).send(scriptDto(s));
  });

  app.patch("/api/scripts/:id", admins, async (req) => {
    const id = idParam(req);
    const patch = ScriptBody.partial().parse(req.body);
    if (!(await deps.db.callScript.findUnique({ where: { id }, select: { id: true } }))) throw new HttpError(404, "Script not found");
    const s = await deps.db.callScript.update({ where: { id }, data: { name: patch.name, sections: patch.sections, active: patch.active } });
    await audit(deps, req, "CALL_LIST_CHANGE", { scriptId: id, fields: Object.keys(patch) });
    return scriptDto(s);
  });

  // ---- Message templates ----

  const templateOrder = [{ sortOrder: "asc" as const }, { name: "asc" as const }];

  app.get("/v1/templates", device, async () => ({
    items: (await deps.db.messageTemplate.findMany({ where: { active: true }, orderBy: templateOrder })).map(templateDto),
  }));

  app.get("/api/templates", anyone, async (req) => {
    const all = wantsAll(req) && currentUser(req).role === "ADMIN";
    return { items: (await deps.db.messageTemplate.findMany({ where: all ? {} : { active: true }, orderBy: templateOrder })).map(templateDto) };
  });

  app.post("/api/templates", admins, async (req, reply) => {
    const body = TemplateBody.parse(req.body);
    if (!body.whatsapp && !body.sms) throw new HttpError(400, "Pick WhatsApp, SMS or both");
    const last = await deps.db.messageTemplate.aggregate({ _max: { sortOrder: true } });
    const t = await deps.db.messageTemplate.create({ data: { ...body, active: body.active ?? true, sortOrder: (last._max.sortOrder ?? 0) + 10 } });
    await audit(deps, req, "TEMPLATE_CHANGE", { created: t.id, name: t.name });
    return reply.code(201).send(templateDto(t));
  });

  app.patch("/api/templates/:id", admins, async (req) => {
    const id = idParam(req);
    const patch = TemplateBody.partial().parse(req.body);
    const cur = await deps.db.messageTemplate.findUnique({ where: { id } });
    if (!cur) throw new HttpError(404, "Template not found");
    if (!(patch.whatsapp ?? cur.whatsapp) && !(patch.sms ?? cur.sms)) throw new HttpError(400, "Pick WhatsApp, SMS or both");
    const t = await deps.db.messageTemplate.update({ where: { id }, data: patch });
    await audit(deps, req, "TEMPLATE_CHANGE", { templateId: id, fields: Object.keys(patch) });
    return templateDto(t);
  });

  app.delete("/api/templates/:id", admins, async (req, reply) => {
    const id = idParam(req);
    const r = await deps.db.messageTemplate.deleteMany({ where: { id } });
    if (r.count === 0) throw new HttpError(404, "Template not found");
    await audit(deps, req, "TEMPLATE_CHANGE", { deleted: id });
    return reply.code(204).send();
  });
}

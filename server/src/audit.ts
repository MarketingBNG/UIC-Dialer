import type { FastifyRequest } from "fastify";
import type { Deps } from "./context.js";
import type { AuditAction } from "./generated/prisma/client.js";

/** Audit actions added in stage 2/3: GET /api/audit returns them only with ?v=2 (old apps' Kotlin enum). */
export const V2_AUDIT_ACTIONS = [
  "CALL_LIST_CHANGE",
  "CONTACT_IMPORT",
  "DNC_CHANGE",
  "LEAD_SOURCE_CHANGE",
  "OUTCOME_CHANGE",
  "TEMPLATE_CHANGE",
  "TARGET_CHANGE",
] as const satisfies readonly AuditAction[];

/** Writes an audit row; failures are logged, never fail the request. */
export async function audit(deps: Deps, req: FastifyRequest, action: AuditAction, detail?: object, callId?: string) {
  await deps.db.auditLog
    .create({ data: { userId: req.user?.id ?? null, action, callId: callId ?? null, detail: detail ?? undefined, ip: req.ip } })
    .catch((err: unknown) => req.log.error({ err, action }, "audit write failed"));
}

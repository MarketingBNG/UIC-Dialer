import type { FastifyReply, FastifyRequest } from "fastify";
import type { GoogleVerifier } from "./auth/google.js";
import type { TokenService } from "./auth/tokens.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { Device, User } from "./generated/prisma/client.js";
import type { LocalStorage } from "./storage/local.js";

export interface Deps {
  config: Config;
  db: Db;
  storage: LocalStorage;
  tokens: TokenService;
  verifyGoogle: GoogleVerifier;
  /** Dashboard OIDC; absent when GOOGLE_WEB_CLIENT_SECRET is not configured. */
  oidc?: import("./auth/oidc.js").DashboardOidc | undefined;
  /** Zoho CRM sync; absent when ZOHO_REFRESH_TOKEN is not configured. */
  crm?: import("./crm/sync.js").CrmSync | undefined;
  /** The CRM loop's global health (auth / outage backoff), for the dashboard. */
  crmLoop?: import("./crm/sync.js").CrmLoop | undefined;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: User;
    device?: Device;
  }
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    /** Machine-readable reason sent as `code` (e.g. DNC, LIST_PAUSED, NOT_ASSIGNED, OUTCOME_NEEDS_DATE, EXISTS). */
    readonly code?: string,
    /** Extra JSON fields sent next to `error` / `code` (e.g. { contactId }). */
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function currentUser(req: FastifyRequest): User {
  if (!req.user) throw new HttpError(401, "Not signed in");
  return req.user;
}

export function currentDevice(req: FastifyRequest): Device {
  if (!req.device) throw new HttpError(401, "No device");
  return req.device;
}

export type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideCallVia } from "../src/activity/via.js";
import { setupTestApp, sha256, uniqueEmail } from "./helpers.js";

describe("decideCallVia", () => {
  it("applies APP > intent > phone dialer for outgoing calls only", () => {
    expect(decideCallVia("OUTGOING", "APP", true)).toBe("APP");
    expect(decideCallVia("OUTGOING", undefined, true)).toBe("LAPTOP");
    expect(decideCallVia("OUTGOING", null, false)).toBe("PHONE_DIALER");
    for (const d of ["INCOMING", "MISSED", "UNKNOWN"] as const) expect(decideCallVia(d, "APP", true)).toBeNull();
  });
});

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(async () => {
  await t.app.close();
  await t.db.$disconnect();
});

const randomMobile = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const iso = (d: Date) => d.toISOString();

async function registerCall(headers: Record<string, string>, phone: string, extra: Record<string, unknown> = {}) {
  const res = await t.app.inject({
    method: "POST",
    url: "/v1/calls",
    headers,
    payload: { originalSha256: sha256(randomUUID()), phoneNumber: phone, direction: "OUTGOING", startedAt: iso(new Date()), durationS: 30, ...extra },
  });
  expect(res.statusCode).toBe(201);
  return t.db.call.findUniqueOrThrow({ where: { id: res.json().callId } });
}

async function intent(session: { cookie: string; origin: string }, phone: string, clientId = randomUUID()) {
  return t.app.inject({ method: "POST", url: "/api/dial-intents", headers: session, payload: { clientId, phone } });
}

describe("call via", () => {
  it("labels a call after a desktop dial intent LAPTOP and claims the intent once", async () => {
    const email = uniqueEmail("rep");
    const rep = await t.loginDevice(email);
    const session = await t.sessionFor(email);
    const phone = randomMobile();
    const clientId = randomUUID();
    const res = await intent(session, phone, clientId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ clientId, phoneE164: `+91${phone}` });
    // Idempotent for the same user, 409 for another.
    expect((await intent(session, phone, clientId)).json().id).toBe(res.json().id);
    const other = uniqueEmail("rep");
    await t.loginDevice(other);
    expect((await intent(await t.sessionFor(other), phone, clientId)).statusCode).toBe(409);
    expect((await intent(session, "12")).statusCode).toBe(400);

    const first = await registerCall(rep.headers, phone);
    expect(first.via).toBe("LAPTOP");
    const claimed = await t.db.dialIntent.findUniqueOrThrow({ where: { clientId } });
    expect(claimed.callId).toBe(first.id);
    // The intent is used up: the next call on the number came from the phone's dialer.
    expect((await registerCall(rep.headers, phone)).via).toBe("PHONE_DIALER");
  });

  it("binds at most one intent to a call under concurrent retries", async () => {
    const email = uniqueEmail("rep");
    const rep = await t.loginDevice(email);
    const session = await t.sessionFor(email);
    const phone = randomMobile();
    const c1 = randomUUID();
    const c2 = randomUUID();
    await intent(session, phone, c1);
    await intent(session, phone, c2);
    // A PENDING_UPLOAD retry of the same call after its via was set.
    const sha = sha256(randomUUID());
    const call = await registerCall(rep.headers, phone, { originalSha256: sha });
    expect(call.via).toBe("LAPTOP");
    // Undo it and send two concurrent retries: only one intent may end up bound to the call.
    await t.db.call.update({ where: { id: call.id }, data: { via: null } });
    await t.db.dialIntent.updateMany({ where: { clientId: { in: [c1, c2] } }, data: { callId: null } });
    const both = await Promise.all([1, 2].map(() => registerCall(rep.headers, phone, { originalSha256: sha })));
    expect(both.map((c) => c.id)).toEqual([call.id, call.id]);
    expect((await t.db.call.findUniqueOrThrow({ where: { id: call.id } })).via).toBe("LAPTOP");
    const bound = await t.db.dialIntent.findMany({ where: { clientId: { in: [c1, c2] }, callId: { not: null } } });
    expect(bound).toHaveLength(1);
  });

  it("lets the phone's APP report win, keeps incoming calls unlabelled", async () => {
    const email = uniqueEmail("rep");
    const rep = await t.loginDevice(email);
    const phone = randomMobile();
    await intent(await t.sessionFor(email), phone);
    expect((await registerCall(rep.headers, phone, { via: "APP" })).via).toBe("APP");
    expect((await registerCall(rep.headers, phone, { direction: "INCOMING" })).via).toBeNull();
    // The intent was not consumed by the APP call.
    expect((await registerCall(rep.headers, phone)).via).toBe("LAPTOP");
  });

  it("copies the call's via to the activity it links to", async () => {
    const rep = await t.loginDevice(uniqueEmail("rep"));
    const phone = randomMobile();
    const at = new Date();
    // Activity first (no via), then the recording.
    const act = await t.app.inject({
      method: "POST",
      url: "/v1/activities",
      headers: rep.headers,
      payload: { clientId: randomUUID(), phone, type: "CALL", outcome: "INTERESTED", occurredAt: iso(at) },
    });
    expect(act.json().activity.via).toBeNull();
    const call = await registerCall(rep.headers, phone, { startedAt: iso(at) });
    const a = await t.db.activity.findUniqueOrThrow({ where: { id: act.json().activity.id } });
    expect(a).toMatchObject({ callId: call.id, via: "PHONE_DIALER" });

    // Recording first, then an activity that names its own via keeps it.
    const phone2 = randomMobile();
    await registerCall(rep.headers, phone2, { via: "APP" });
    const act2 = await t.app.inject({
      method: "POST",
      url: "/v1/activities",
      headers: rep.headers,
      payload: { clientId: randomUUID(), phone: phone2, type: "CALL", occurredAt: iso(new Date()) },
    });
    expect(act2.json().activity.via).toBe("APP");
    // via is ignored for non-CALL activities.
    const note = await t.app.inject({
      method: "POST",
      url: "/v1/activities",
      headers: rep.headers,
      payload: { clientId: randomUUID(), phone: phone2, type: "NOTE", note: "x", via: "APP", occurredAt: iso(new Date()) },
    });
    expect(note.json().activity.via).toBeNull();
  });

  it("marks a dashboard outcome LAPTOP when its clientId was a dial intent", async () => {
    const email = uniqueEmail("rep");
    await t.loginDevice(email);
    const session = await t.sessionFor(email);
    const phone = randomMobile();
    const clientId = randomUUID();
    await intent(session, phone, clientId);
    const res = await t.app.inject({
      method: "POST",
      url: "/api/activities",
      headers: session,
      payload: { clientId, phone, type: "CALL", outcome: "NO_ANSWER", occurredAt: iso(new Date()) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().activity.via).toBe("LAPTOP");
  });
});

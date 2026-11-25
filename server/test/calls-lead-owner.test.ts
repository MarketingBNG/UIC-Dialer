import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestApp, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(async () => {
  await t.app.close();
  await t.db.$disconnect();
});

const mobile = () => `+919${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

describe("calls list: lead owner", () => {
  it("shows the lead's name and owner, and filters by lead owner", async () => {
    const adminEmail = uniqueEmail("ladmin");
    await t.db.user.create({ data: { email: adminEmail, role: "ADMIN" } });
    const admin = await t.sessionFor(adminEmail);
    const owner = await t.db.user.create({ data: { email: uniqueEmail("owner"), name: "Owner One", role: "AGENT" } });
    const rep = await t.db.user.create({ data: { email: uniqueEmail("rep"), role: "AGENT" } });
    const leadPhone = mobile();
    const otherPhone = mobile();
    await t.db.contact.create({ data: { phoneE164: leadPhone, name: "Real Lead", company: "Acme", ownerId: owner.id } });
    const base = { userId: rep.id, startedAt: new Date(), status: "UPLOADED" as const };
    const leadCall = await t.db.call.create({ data: { ...base, phoneE164: leadPhone, contactName: "phone name", originalSha256: randomUUID() } });
    const otherCall = await t.db.call.create({ data: { ...base, phoneE164: otherPhone, originalSha256: randomUUID() } });

    const all = (await t.app.inject({ url: `/api/calls?v=2&userId=${rep.id}`, headers: admin })).json().items;
    const got = all.find((c: { id: string }) => c.id === leadCall.id);
    expect(got.lead).toMatchObject({ name: "Real Lead", company: "Acme", owner: { id: owner.id, name: "Owner One" } });
    expect(all.find((c: { id: string }) => c.id === otherCall.id).lead).toBeNull();

    const byOwner = (await t.app.inject({ url: `/api/calls?v=2&ownerId=${owner.id}`, headers: admin })).json().items;
    expect(byOwner.map((c: { id: string }) => c.id)).toEqual([leadCall.id]);
  });
});

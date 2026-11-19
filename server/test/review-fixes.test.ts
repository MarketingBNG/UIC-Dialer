import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_OUTCOME_IDS } from "../src/activity/outcomes.js";
import { followUpsDone } from "../src/activity/stats.js";
import { addItems } from "../src/lists/service.js";
import { setupTestApp, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
let team: string;
let mgr: Record<string, string>;
beforeAll(async () => {
  t = await setupTestApp();
  team = `team-${randomUUID().slice(0, 6)}`;
  const email = uniqueEmail("rfmgr");
  await t.db.user.create({ data: { email, role: "MANAGER", team } });
  mgr = await t.sessionFor(email);
});
afterAll(async () => {
  await t.app.close();
  await t.db.$disconnect();
});

type H = Record<string, string>;
const randomMobile = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const inject = (method: "GET" | "POST" | "PATCH", url: string, headers: H, payload?: object) =>
  t.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
const teamRep = () => t.loginDevice(uniqueEmail("rfrep"), "AGENT", team);
const next = (headers: H, listId: string) => inject("POST", `/v1/call-lists/${listId}/next`, headers, {});

describe("CSV import respects the manager's contact scope", () => {
  it("leaves another team's contact alone, keeps it off the list, and shows it only as an aggregate", async () => {
    const rep = await teamRep();
    const outsider = await t.db.user.create({ data: { email: uniqueEmail("rfout"), team: `other-${randomUUID().slice(0, 4)}` } });
    const foreign = await t.db.contact.create({ data: { phoneE164: `+91${randomMobile()}`, name: "Their client", company: "Theirs", ownerId: outsider.id } });
    const mine = await t.db.contact.create({ data: { phoneE164: `+91${randomMobile()}`, name: "Old name", ownerId: rep.user.id } });
    const fresh = randomMobile();
    const list = (
      await inject("POST", "/api/call-lists", mgr, { name: `L ${randomUUID().slice(0, 4)}`, assigneeIds: [rep.user.id], contactIds: [mine.id] })
    ).json();
    const csv = `Name,Phone,Company\nHijack,${foreign.phoneE164.slice(3)},Mine now\nNew name,${mine.phoneE164.slice(3)},\nBrand new,${fresh},`;

    const preview = (await inject("POST", "/api/contacts/import/preview", mgr, { csv })).json();
    expect(preview).toMatchObject({ new: 1, existing: 2, existingElsewhere: 1 });
    // Per row the foreign number looks like any existing one: no per-row "not yours" detail.
    expect(new Set(preview.sample.map((r: { status: string }) => r.status))).toEqual(new Set(["existing", "new"]));

    const res = await inject("POST", "/api/contacts/import", mgr, { csv, mapping: preview.mapping, listId: list.id });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ created: 1, updated: 1, ownedElsewhere: 1 });
    expect(res.json().contactIds).not.toContain(foreign.id);
    expect(await t.db.contact.findUniqueOrThrow({ where: { id: foreign.id } })).toMatchObject({ name: "Their client", company: "Theirs", ownerId: outsider.id });
    expect((await t.db.contact.findUniqueOrThrow({ where: { id: mine.id } })).name).toBe("New name");
    const onList = (await t.db.callListItem.findMany({ where: { listId: list.id } })).map((i) => i.contactId);
    expect(onList).not.toContain(foreign.id);
    expect(onList).toHaveLength(2);
  });

  it("recognises more phone headers and lets the user override header detection", async () => {
    const csv = `Name,Tel\nAsha,${randomMobile()}`;
    const auto = (await inject("POST", "/api/contacts/import/preview", mgr, { csv })).json();
    expect(auto).toMatchObject({ hasHeader: true, columns: ["Name", "Tel"], bad: 0, new: 1 });
    const odd = `Name,Ring me\nAsha,${randomMobile()}`;
    const guessed = (await inject("POST", "/api/contacts/import/preview", mgr, { csv: odd })).json();
    // Read as data: the header row (and, with the phone guessed in column 0, every row) is a bad number.
    expect(guessed).toMatchObject({ hasHeader: false, new: 0 });
    const fixed = (await inject("POST", "/api/contacts/import/preview", mgr, { csv: odd, hasHeader: true, mapping: { phone: 1, name: 0, company: null, city: null } })).json();
    expect(fixed).toMatchObject({ hasHeader: true, columns: ["Name", "Ring me"], bad: 0, new: 1 });
  });
});

describe("late outcomes on call-list items", () => {
  async function setup() {
    const a = await teamRep();
    const b = await teamRep();
    const c = await t.db.contact.create({ data: { phoneE164: `+91${randomMobile()}` } });
    const list = (await inject("POST", "/api/call-lists", mgr, { name: `L ${randomUUID().slice(0, 4)}`, assigneeIds: [a.user.id, b.user.id], contactIds: [c.id] })).json();
    const retry = await t.db.outcomeDef.create({ data: { label: `Retry ${randomUUID().slice(0, 4)}`, color: "#999999", baseOutcome: "NO_ANSWER", rule: "RETRY", retryHours: 2 } });
    const held = (await next(a.headers, list.id)).json().item;
    // A goes offline; the lease runs out and B takes the item.
    await t.db.callListItem.update({ where: { id: held.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    expect((await next(b.headers, list.id)).json().item.id).toBe(held.id);
    const log = (h: H, outcomeId: string, occurredAt: Date) =>
      inject("POST", "/v1/activities", h, { clientId: randomUUID(), phone: c.phoneE164, type: "CALL", outcomeId, occurredAt: occurredAt.toISOString(), callListItemId: held.id });
    return { a, b, itemId: held.id as string, retry, log };
  }

  it("never reopens an item another rep finished", async () => {
    const { a, b, itemId, retry, log } = await setup();
    const aCalledAt = new Date(Date.now() - 10 * 60_000);
    expect((await log(b.headers, DEFAULT_OUTCOME_IDS.INTERESTED, new Date())).statusCode).toBe(200);
    expect((await log(a.headers, retry.id, aCalledAt)).statusCode).toBe(200);
    const item = await t.db.callListItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(item).toMatchObject({ state: "DONE", doneById: b.user.id, lastOutcome: "INTERESTED", retryAt: null, attempts: 2 });
  });

  it("does not knock another rep's live claim off the item", async () => {
    const { a, b, itemId, retry, log } = await setup();
    expect((await log(a.headers, retry.id, new Date(Date.now() - 5 * 60_000))).statusCode).toBe(200);
    const item = await t.db.callListItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(item).toMatchObject({ state: "IN_PROGRESS", claimedById: b.user.id, attempts: 1 });
    expect(item.leaseUntil!.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("addItems", () => {
  it("concurrent adds to one list never share positions", async () => {
    const rep = await teamRep();
    const list = (await inject("POST", "/api/call-lists", mgr, { name: `L ${randomUUID().slice(0, 4)}`, assigneeIds: [rep.user.id], contactIds: [] })).json();
    const batch = async () => {
      const ids = [];
      for (let i = 0; i < 5; i++) ids.push((await t.db.contact.create({ data: { phoneE164: `+91${randomMobile()}` } })).id);
      return ids;
    };
    const [one, two] = [await batch(), await batch()];
    await Promise.all([addItems(t.db, list.id, one), addItems(t.db, list.id, two)]);
    const items = await t.db.callListItem.findMany({ where: { listId: list.id }, orderBy: { position: "asc" } });
    expect(items).toHaveLength(10);
    expect(new Set(items.map((i) => i.position)).size).toBe(10);
    // Each batch stays together, in its own order.
    const order = items.map((i) => i.contactId);
    const firstBatch = one.includes(order[0]!) ? one : two;
    expect(order.slice(0, 5)).toEqual(firstBatch);
  });
});

describe("followUpsDone", () => {
  it("counts only the activity that answered the open follow-up, not every later call", async () => {
    const rep = await t.db.user.create({ data: { email: uniqueEmail("rffu") } });
    const c = await t.db.contact.create({ data: { phoneE164: `+91${randomMobile()}`, ownerId: rep.id } });
    const base = new Date("2026-03-01T05:00:00Z");
    const at = (h: number) => new Date(base.getTime() + h * 3600_000);
    const act = (occurredAt: Date, extra: object = {}) =>
      t.db.activity.create({ data: { clientId: randomUUID(), contactId: c.id, userId: rep.id, type: "CALL", occurredAt, ...extra } });
    await act(at(-48), { outcome: "CALL_BACK", followUpAt: at(0) });
    await act(at(1)); // answers the follow-up
    await act(at(24)); // second call: not a follow-up
    await act(at(48), { type: "WHATSAPP" }); // nor this
    const done = await followUpsDone(t.db, [rep.id], at(-1), at(72));
    expect(done.get(rep.id)).toBe(1);
  });
});

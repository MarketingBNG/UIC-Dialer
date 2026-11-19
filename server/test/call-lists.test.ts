import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_OUTCOME_IDS } from "../src/activity/outcomes.js";
import { numberKey } from "../src/privacy/clientNumbers.js";
import { setupTestApp, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
let team: string;
let mgrEmail: string;
let mgr: Record<string, string>;
beforeAll(async () => {
  t = await setupTestApp();
  team = `team-${randomUUID().slice(0, 6)}`;
  mgrEmail = uniqueEmail("lmgr");
  await t.db.user.create({ data: { email: mgrEmail, role: "MANAGER", team } });
  mgr = await t.sessionFor(mgrEmail);
});
afterAll(async () => {
  await t.app.close();
  await t.db.$disconnect();
});

type H = Record<string, string>;
const randomMobile = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const inject = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, headers: H, payload?: object) =>
  t.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

/** A rep in the manager's team, signed in as a phone. */
const teamRep = () => t.loginDevice(uniqueEmail("lrep"), "AGENT", team);

/** Contacts owned by `ownerId` (in the manager's scope when the owner is in the team). */
async function contacts(n: number, ownerId: string | null, extra: object = {}) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(await t.db.contact.create({ data: { phoneE164: `+91${randomMobile()}`, name: `C${i}`, ownerId, ...extra } }));
  }
  return rows;
}

async function createList(headers: H, body: object) {
  const res = await inject("POST", "/api/call-lists", headers, { name: `List ${randomUUID().slice(0, 4)}`, ...body });
  return res;
}
const next = (headers: H, listId: string) => inject("POST", `/v1/call-lists/${listId}/next`, headers, {});

describe("creating lists", () => {
  it("from contactIds: scope, DNC exclusion, duplicates, order", async () => {
    const rep = await teamRep();
    const mine = await contacts(3, rep.user.id);
    const outsider = await t.db.user.create({ data: { email: uniqueEmail("lout"), team: "other-team" } });
    const [foreign] = await contacts(1, outsider.id);
    await t.db.dncNumber.create({ data: { key: numberKey(mine[1]!.phoneE164), raw: mine[1]!.phoneE164 } });
    const res = await createList(mgr, {
      assigneeIds: [rep.user.id],
      contactIds: [mine[2]!.id, mine[0]!.id, mine[1]!.id, mine[0]!.id, foreign!.id],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ added: 2, excludedDnc: 1, excludedDuplicate: 1, state: "ACTIVE" });
    expect(body.progress).toMatchObject({ total: 2, pending: 2, done: 0 });
    expect(body.assignees.map((a: { id: string }) => a.id)).toEqual([rep.user.id]);
    const items = await t.db.callListItem.findMany({ where: { listId: body.id }, orderBy: { position: "asc" } });
    expect(items.map((i) => i.contactId)).toEqual([mine[2]!.id, mine[0]!.id]);
    expect(await t.db.auditLog.count({ where: { action: "CALL_LIST_CHANGE", detail: { path: ["created"], equals: body.id } } })).toBe(1);
  });

  it("from a filter, and validates the body and assignees", async () => {
    const rep = await teamRep();
    const tag = `Pune${randomUUID().slice(0, 6)}`;
    await contacts(2, rep.user.id, { city: tag });
    const res = await createList(mgr, { assigneeIds: [rep.user.id], filter: { q: tag } });
    expect(res.json()).toMatchObject({ added: 2 });
    expect((await createList(mgr, { assigneeIds: [rep.user.id] })).statusCode).toBe(400);
    expect((await createList(mgr, { assigneeIds: [rep.user.id], contactIds: [], filter: {} })).statusCode).toBe(400);
    const outsider = await t.db.user.create({ data: { email: uniqueEmail("lout"), team: "elsewhere" } });
    expect((await createList(mgr, { assigneeIds: [outsider.id], contactIds: [] })).statusCode).toBe(403);
    const agent = await teamRep();
    expect((await createList(agent.headers, { assigneeIds: [agent.user.id], contactIds: [] })).statusCode).toBe(403);
  });

  it("a manager may list unowned contacts (CSV imports without an owner)", async () => {
    const rep = await teamRep();
    const unowned = await contacts(1, null);
    const res = await createList(mgr, { assigneeIds: [rep.user.id], contactIds: [unowned[0]!.id] });
    expect(res.json().added).toBe(1);
  });
});

describe("rep session", () => {
  it("assignees see the list; others get 403 NOT_ASSIGNED", async () => {
    const rep = await teamRep();
    const other = await teamRep();
    const cs = await contacts(1, null);
    const list = (await createList(mgr, { assigneeIds: [rep.user.id], contactIds: cs.map((c) => c.id) })).json();
    const mine = (await inject("GET", "/v1/call-lists", rep.headers)).json().items;
    const found = mine.find((l: { id: string }) => l.id === list.id);
    expect(found).toMatchObject({ name: list.name, script: null, progress: { total: 1 } });
    expect(found.assignees).toBeUndefined();
    expect((await inject("GET", "/v1/call-lists", other.headers)).json().items.map((l: { id: string }) => l.id)).not.toContain(list.id);
    const denied = await next(other.headers, list.id);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe("NOT_ASSIGNED");
    // Dashboard twin.
    const dash = await inject("GET", "/api/my/call-lists", rep.headers);
    expect(dash.json().items.map((l: { id: string }) => l.id)).toContain(list.id);
    // The assignee can read the list detail, the other rep can't.
    expect((await inject("GET", `/api/call-lists/${list.id}`, rep.headers)).statusCode).toBe(200);
    expect((await inject("GET", `/api/call-lists/${list.id}`, other.headers)).statusCode).toBe(404);
  });

  it("next is idempotent while the lease holds; the list contact becomes visible to the rep", async () => {
    const rep = await teamRep();
    const cs = await contacts(2, null);
    const list = (await createList(mgr, { assigneeIds: [rep.user.id], contactIds: cs.map((c) => c.id) })).json();
    const a = (await next(rep.headers, list.id)).json();
    expect(a.item.contact.id).toBe(cs[0]!.id);
    expect(a.item.state).toBe("IN_PROGRESS");
    expect(a.progress).toMatchObject({ total: 2, inProgress: 1, pending: 1 });
    const again = (await next(rep.headers, list.id)).json();
    expect(again.item.id).toBe(a.item.id);
    // repContactScope: the assignee can read the (unowned) list contact by phone.
    const byPhone = await inject("GET", `/v1/contacts/by-phone?phone=${encodeURIComponent(cs[0]!.phoneE164)}`, rep.headers);
    expect(byPhone.json().contact.id).toBe(cs[0]!.id);
  });

  it("two reps never get the same item", async () => {
    const reps = await Promise.all([teamRep(), teamRep(), teamRep(), teamRep()]);
    const cs = await contacts(6, null);
    const list = (await createList(mgr, { assigneeIds: reps.map((r) => r.user.id), contactIds: cs.map((c) => c.id) })).json();
    const got = await Promise.all(reps.map((r) => next(r.headers, list.id)));
    const ids = got.map((g) => g.json().item.id);
    expect(new Set(ids).size).toBe(4);
  });

  it("an expired lease is reclaimed by another rep; skip moves on; paused gives 409; empty gives LIST_EMPTY", async () => {
    const a = await teamRep();
    const b = await teamRep();
    const cs = await contacts(2, null);
    const list = (await createList(mgr, { assigneeIds: [a.user.id, b.user.id], contactIds: cs.map((c) => c.id) })).json();
    const held = (await next(a.headers, list.id)).json().item;
    await t.db.callListItem.update({ where: { id: held.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    expect((await inject("GET", `/api/call-lists/${list.id}`, mgr)).json().list.progress).toMatchObject({ pending: 2, inProgress: 0 });
    const taken = (await next(b.headers, list.id)).json().item;
    expect(taken.id).toBe(held.id);
    expect(taken.claimedBy.id).toBe(b.user.id);

    // Skip by someone who doesn't hold it: 409. B skips: SKIPPED, and B gets the next one.
    expect((await inject("POST", `/v1/call-lists/items/${held.id}/skip`, a.headers, {})).statusCode).toBe(409);
    const skipped = await inject("POST", `/v1/call-lists/items/${held.id}/skip`, b.headers, {});
    expect(skipped.json().item.contact.id).toBe(cs[1]!.id);
    expect((await t.db.callListItem.findUniqueOrThrow({ where: { id: held.id } })).state).toBe("SKIPPED");

    // Release (pause) returns B's item to the pool.
    expect((await inject("POST", `/v1/call-lists/${list.id}/release`, b.headers, {})).statusCode).toBe(204);
    expect((await t.db.callListItem.findFirstOrThrow({ where: { listId: list.id, contactId: cs[1]!.id } })).state).toBe("PENDING");

    await inject("PATCH", `/api/call-lists/${list.id}`, mgr, { state: "PAUSED" });
    const paused = await next(a.headers, list.id);
    expect(paused.statusCode).toBe(409);
    expect(paused.json().code).toBe("LIST_PAUSED");
    await inject("PATCH", `/api/call-lists/${list.id}`, mgr, { state: "ACTIVE" });
    const last = (await next(a.headers, list.id)).json().item;
    await inject("POST", `/v1/call-lists/items/${last.id}/skip`, a.headers, {});
    const empty = await next(a.headers, list.id);
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ item: null, code: "LIST_EMPTY", progress: { total: 2, done: 2, skipped: 2 } });
  });

  it("a number put on DNC after it was added is removed lazily and never handed out", async () => {
    const rep = await teamRep();
    const cs = await contacts(2, null);
    const list = (await createList(mgr, { assigneeIds: [rep.user.id], contactIds: cs.map((c) => c.id) })).json();
    await t.db.dncNumber.create({ data: { key: numberKey(cs[0]!.phoneE164), raw: cs[0]!.phoneE164 } });
    const got = (await next(rep.headers, list.id)).json();
    expect(got.item.contact.id).toBe(cs[1]!.id);
    expect(got.progress.removed).toBe(1);
  });

  it("an outcome with callListItemId sets the item DONE, updates progress and results, and claims the owner", async () => {
    const rep = await teamRep();
    const cs = await contacts(2, null);
    const list = (await createList(mgr, { assigneeIds: [rep.user.id], contactIds: cs.map((c) => c.id) })).json();
    const item = (await next(rep.headers, list.id)).json().item;
    const res = await inject("POST", "/v1/activities", rep.headers, {
      clientId: randomUUID(),
      phone: item.contact.phoneE164,
      type: "CALL",
      outcomeId: DEFAULT_OUTCOME_IDS.INTERESTED,
      occurredAt: new Date().toISOString(),
      callListItemId: item.id,
      durationS: 40,
    });
    expect(res.json().activity.callListItemId).toBe(item.id);
    // First activity on an unowned contact makes the rep its owner.
    expect(res.json().contact.owner.id).toBe(rep.user.id);
    const done = await t.db.callListItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(done).toMatchObject({ state: "DONE", attempts: 1, doneById: rep.user.id, claimedById: null, lastOutcome: "INTERESTED" });
    const following = (await next(rep.headers, list.id)).json();
    expect(following.item.contact.id).toBe(cs[1]!.id);
    expect(following.progress).toMatchObject({ total: 2, done: 1, inProgress: 1 });
    expect(following.results).toEqual([{ outcomeId: DEFAULT_OUTCOME_IDS.INTERESTED, label: "Interested", color: "#16A34A", count: 1 }]);
  });

  it("manager item actions: remove and reset; archive hides the list", async () => {
    const rep = await teamRep();
    const cs = await contacts(2, null);
    const list = (await createList(mgr, { assigneeIds: [rep.user.id], contactIds: cs.map((c) => c.id) })).json();
    const detail = (await inject("GET", `/api/call-lists/${list.id}?limit=1`, mgr)).json();
    expect(detail.items).toHaveLength(1);
    expect(detail.nextCursor).not.toBeNull();
    const page2 = (await inject("GET", `/api/call-lists/${list.id}?limit=1&cursor=${detail.nextCursor}`, mgr)).json();
    expect(page2.items[0].contact.id).toBe(cs[1]!.id);
    const itemId = detail.items[0].id;
    expect((await inject("DELETE", `/api/call-lists/${list.id}/items/${itemId}`, mgr)).statusCode).toBe(204);
    const reset = await inject("POST", `/api/call-lists/${list.id}/items/${itemId}/reset`, mgr);
    expect(reset.json()).toMatchObject({ id: itemId, state: "PENDING" });
    const added = await inject("POST", `/api/call-lists/${list.id}/items`, mgr, { contactIds: [cs[0]!.id, ...(await contacts(1, null)).map((c) => c.id)] });
    expect(added.json()).toMatchObject({ added: 1, excludedDuplicate: 1 });
    await inject("PATCH", `/api/call-lists/${list.id}`, mgr, { state: "ARCHIVED" });
    expect((await inject("GET", "/api/call-lists", mgr)).json().items.map((l: { id: string }) => l.id)).not.toContain(list.id);
    expect((await inject("GET", "/api/call-lists?state=ARCHIVED", mgr)).json().items.map((l: { id: string }) => l.id)).toContain(list.id);
    expect((await inject("GET", "/v1/call-lists", rep.headers)).json().items.map((l: { id: string }) => l.id)).not.toContain(list.id);
  });

  it("the phone reads a list's script only when it is on a list assigned to the rep", async () => {
    const rep = await teamRep();
    const other = await teamRep();
    const script = await t.db.callScript.create({ data: { name: "Intro", sections: [{ heading: "Open", text: "Hello" }] } });
    const cs = await contacts(1, null);
    const list = (await createList(mgr, { assigneeIds: [rep.user.id], contactIds: cs.map((c) => c.id), scriptId: script.id })).json();
    expect(list.script).toEqual({ id: script.id, name: "Intro" });
    const mine = (await inject("GET", "/v1/call-lists", rep.headers)).json().items.find((l: { id: string }) => l.id === list.id);
    expect(mine.script).toMatchObject({ id: script.id, sections: [{ heading: "Open", text: "Hello" }] });
    expect((await inject("GET", `/v1/scripts/${script.id}`, rep.headers)).statusCode).toBe(200);
    expect((await inject("GET", `/v1/scripts/${script.id}`, other.headers)).statusCode).toBe(404);
  });
});

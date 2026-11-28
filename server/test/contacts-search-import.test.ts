import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { autoMapping, parseCsv } from "../src/activity/csv.js";
import { numberKey } from "../src/privacy/clientNumbers.js";
import { setupTestApp, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
let admin: Record<string, string>;
let adminId: string;
beforeAll(async () => {
  t = await setupTestApp();
  const email = uniqueEmail("cadmin");
  adminId = (await t.db.user.create({ data: { email, role: "ADMIN" } })).id;
  admin = await t.sessionFor(email);
});
afterAll(async () => {
  await t.app.close();
  await t.db.$disconnect();
});

type H = Record<string, string>;
const randomMobile = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const inject = (method: "GET" | "POST" | "PATCH", url: string, headers: H, payload?: object) =>
  t.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
const activity = (headers: H, phone: string, body: Record<string, unknown> = {}) =>
  inject("POST", "/v1/activities", headers, { clientId: randomUUID(), phone, type: "CALL", occurredAt: new Date().toISOString(), ...body });
const ids = (res: { json: () => { items: { id: string }[] } }) => res.json().items.map((c) => c.id);

describe("contacts search and filters", () => {
  it("searches by note, city and digits (scoped to the rep)", async () => {
    const rep = await t.loginDevice(uniqueEmail("crep"));
    const other = await t.loginDevice(uniqueEmail("crep"));
    const word = `gstr${randomUUID().slice(0, 6)}`;
    const phone = randomMobile();
    const c = (await activity(rep.headers, phone, { note: `asked about ${word} filing`, outcome: "INTERESTED" })).json().contact;
    const o = (await activity(other.headers, randomMobile(), { note: `${word} too` })).json().contact;
    const byNote = await inject("GET", `/v1/contacts?q=${word}`, rep.headers);
    expect(ids(byNote)).toEqual([c.id]);
    // A number typed with a leading 0 or +91 still finds the contact.
    expect(ids(await inject("GET", `/v1/contacts?q=0${phone}`, rep.headers))).toEqual([c.id]);
    expect(ids(await inject("GET", `/v1/contacts?q=${encodeURIComponent(`+91 ${phone}`)}`, rep.headers))).toEqual([c.id]);
    const city = `Nagpur${randomUUID().slice(0, 4)}`;
    expect((await inject("PATCH", `/v1/contacts/${c.id}`, rep.headers, { city })).json().city).toBe(city);
    expect(ids(await inject("GET", `/v1/contacts?q=${city.toLowerCase()}`, rep.headers))).toEqual([c.id]);
    expect(ids(await inject("GET", `/v1/contacts?q=${phone.slice(-6)}`, rep.headers))).toContain(c.id);
    // Admin sees both on the dashboard. Search is fuzzy (trigram), so similar words other tests left in the
    // shared DB may match too: check both are there, not the exact count.
    expect(ids(await inject("GET", `/api/contacts?q=${word}`, admin))).toEqual(expect.arrayContaining([c.id, o.id]));
  });

  it("filters: interested, callback, never, mine; dnc on the dashboard", async () => {
    const rep = await t.loginDevice(uniqueEmail("crep"));
    const hot = (await activity(rep.headers, randomMobile(), { outcome: "INTERESTED" })).json().contact.id;
    const cb = (await activity(rep.headers, randomMobile(), { outcome: "CALL_BACK", followUpAt: new Date(Date.now() + 3600_000).toISOString() })).json().contact.id;
    const msgPhone = randomMobile();
    const msg = (await activity(rep.headers, msgPhone, { type: "WHATSAPP" })).json().contact.id;
    const f = async (filter: string) => ids(await inject("GET", `/v1/contacts?filter=${filter}&limit=100`, rep.headers));
    expect(await f("interested")).toEqual([hot]);
    expect(await f("callback")).toEqual([cb]);
    expect(await f("never")).toEqual([msg]);
    expect((await f("mine")).sort()).toEqual([hot, cb, msg].sort());
    await t.db.dncNumber.create({ data: { key: numberKey(msgPhone), raw: msgPhone, reason: "asked" } });
    const dnc = await inject("GET", `/api/contacts?filter=dnc&limit=100`, admin);
    expect(ids(dnc)).toContain(msg);
    expect(ids(dnc)).not.toContain(hot);
    const row = dnc.json().items.find((c: { id: string }) => c.id === msg);
    expect(row.dnc).toMatchObject({ reason: "asked" });
    expect(row.activityCount).toBe(1);
  });
});

describe("CSV parser", () => {
  it("handles quotes, escaped quotes, commas and newlines in quotes, CRLF, BOM", () => {
    const text = '﻿Name,Phone,Note\r\n"Shah, Priya",98765 43210,"said ""hi""\nbye"\r\n\r\nRavi,9123456780,\n';
    expect(parseCsv(text)).toEqual([
      ["Name", "Phone", "Note"],
      ["Shah, Priya", "98765 43210", 'said "hi"\nbye'],
      ["Ravi", "9123456780", ""],
    ]);
  });
  it("uses ; or tab when the first line has no comma", () => {
    expect(parseCsv("Name;Mobile\nA;9876543210")).toEqual([["Name", "Mobile"], ["A", "9876543210"]]);
    expect(parseCsv("Name\tMobile\nA\t9876543210")).toEqual([["Name", "Mobile"], ["A", "9876543210"]]);
  });
  it("auto-maps headers, or finds the phone column without one", () => {
    expect(autoMapping(parseCsv("Full Name,Mobile Number,Firm,Town\nA,1,B,C"))).toEqual({
      hasHeader: true,
      mapping: { name: 0, phone: 1, company: 2, city: 3 },
    });
    expect(autoMapping(parseCsv("Asha,Acme,+91 98765 43210"))).toEqual({
      hasHeader: false,
      mapping: { name: null, phone: 2, company: null, city: null },
    });
  });
});

describe("CSV import", () => {
  it("previews new / existing / bad / dnc / duplicates", async () => {
    const existing = randomMobile();
    await t.db.contact.create({ data: { phoneE164: `+91${existing}`, name: "Old" } });
    const blocked = randomMobile();
    await t.db.dncNumber.create({ data: { key: blocked, raw: blocked } });
    const fresh = randomMobile();
    const csv = `Name,Phone,Company,City\nNew One,${fresh},Acme,Pune\nOld,${existing},,\nBad,12345,,\nBlocked,${blocked},,\nDup,${fresh},,\n`;
    const res = await inject("POST", "/api/contacts/import/preview", admin, { csv });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      columns: ["Name", "Phone", "Company", "City"],
      hasHeader: true,
      mapping: { name: 0, phone: 1, company: 2, city: 3 },
      total: 5,
      new: 1,
      existing: 1,
      bad: 1,
      dnc: 1,
      duplicateInFile: 1,
      badSample: ["row 4: 12345"],
    });
    expect(res.json().sample[0]).toEqual({ name: "New One", phoneE164: `+91${fresh}`, company: "Acme", city: "Pune", status: "new" });
    const agent = await t.loginDevice(uniqueEmail("crep"));
    expect((await inject("POST", "/api/contacts/import/preview", agent.headers, { csv })).statusCode).toBe(403);
  });

  it("imports: creates and updates, returns contactIds, appends to a list without DNC, audits", async () => {
    const existing = randomMobile();
    const old = await t.db.contact.create({ data: { phoneE164: `+91${existing}`, name: "Old", company: "Keep", status: "INTERESTED" } });
    const a = randomMobile();
    const blocked = randomMobile();
    await t.db.dncNumber.create({ data: { key: blocked, raw: blocked } });
    const owner = await t.db.user.create({ data: { email: uniqueEmail("cown") } });
    const list = await t.db.callList.create({ data: { name: "Imported", createdById: adminId, assignees: { create: [{ userId: owner.id }] } } });
    const csv = `${a};Asha;Mumbai\n${existing};Renamed;\n${blocked};Blocked;\nnope;X;\n`;
    const res = await inject("POST", "/api/contacts/import", admin, {
      csv,
      mapping: { name: 1, phone: 0, company: null, city: 2 },
      ownerId: owner.id,
      listId: list.id,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ created: 2, updated: 1, skipped: 1, dncSkippedFromList: 1 });
    expect(body.contactIds).toHaveLength(3);
    const created = await t.db.contact.findUniqueOrThrow({ where: { phoneE164: `+91${a}` } });
    expect(created).toMatchObject({ name: "Asha", city: "Mumbai", ownerId: owner.id, source: "csv" });
    expect(body.contactIds[0]).toBe(created.id);
    const updated = await t.db.contact.findUniqueOrThrow({ where: { id: old.id } });
    expect(updated).toMatchObject({ name: "Renamed", company: "Keep", status: "INTERESTED", ownerId: null });
    const items = await t.db.callListItem.findMany({ where: { listId: list.id }, orderBy: { position: "asc" } });
    expect(items.map((i) => i.contactId)).toEqual([created.id, old.id]);
    expect(await t.db.auditLog.count({ where: { action: "CONTACT_IMPORT", userId: adminId } })).toBeGreaterThan(0);
  });

  it("rejects more than 20000 rows", async () => {
    const csv = Array.from({ length: 20_001 }, (_, i) => `98${String(i).padStart(8, "0")}`).join("\n");
    const res = await inject("POST", "/api/contacts/import/preview", admin, { csv });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Too many rows (max 20000)");
  });
});

describe("manual leads (POST /api/contacts)", () => {
  it("agents assign themselves; managers can pick auto; hidden existing contacts are 409 EXISTS", async () => {
    const agentEmail = uniqueEmail("crep");
    const agent = await t.loginDevice(agentEmail);
    const phone = randomMobile();
    const res = await inject("POST", "/api/contacts", agent.headers, { phone, name: "Neha Gupta", city: "Delhi", note: "Wants GST help", assignTo: "auto" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ contact: { name: "Neha Gupta", city: "Delhi", source: "manual", owner: { id: agent.user.id } }, assignedTo: { id: agent.user.id } });
    expect(res.json().leadId).toBeTruthy();
    const task = await t.db.followUpTask.findFirstOrThrow({ where: { leadEventId: res.json().leadId } });
    expect(task).toMatchObject({ kind: "NEW_LEAD", userId: agent.user.id, state: "OPEN" });

    const other = await t.loginDevice(uniqueEmail("crep"));
    const dup = await inject("POST", "/api/contacts", other.headers, { phone });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ code: "EXISTS", contactId: res.json().contact.id });
    // The owner sees it: updated and returned.
    const again = await inject("POST", "/api/contacts", agent.headers, { phone, company: "Acme" });
    expect(again.statusCode).toBe(200);
    expect(again.json().contact.company).toBe("Acme");

    const auto = await inject("POST", "/api/contacts", admin, { phone: randomMobile(), assignTo: "auto" });
    expect(auto.statusCode).toBe(201);
    expect(auto.json().assignedTo).not.toBeNull();
    expect(await t.db.followUpTask.count({ where: { leadEventId: auto.json().leadId, kind: "NEW_LEAD" } })).toBe(1);
  });
});

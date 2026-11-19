import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderTemplate } from "../src/activity/outcomes.js";
import { setupTestApp, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
let admin: Record<string, string>;
beforeAll(async () => {
  t = await setupTestApp();
  const email = uniqueEmail("tadmin");
  await t.db.user.create({ data: { email, role: "ADMIN" } });
  admin = await t.sessionFor(email);
});
afterAll(async () => {
  await t.app.close();
  await t.db.$disconnect();
});

type H = Record<string, string>;
const inject = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, headers: H, payload?: object) =>
  t.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

describe("renderTemplate (shared vectors with the dashboard and the app)", () => {
  it("fills {name} and {rep}", () => {
    expect(renderTemplate("Hi {name}, {rep} here", "Priya Shah", "Kirti Arora")).toBe("Hi Priya, Kirti here");
    expect(renderTemplate("Hi {name}", null, "Kirti")).toBe("Hi there");
    expect(renderTemplate("{x} {name}", "A", "B")).toBe("{x} A");
  });
  it("is case-sensitive and uses the email local part without a name", () => {
    expect(renderTemplate("{Name} {rep}", "A", "kirti@usaindiacfo.com")).toBe("{Name} kirti");
  });
});

describe("message templates", () => {
  it("CRUD, validation, active-only for the phone, audits", async () => {
    const name = `Intro ${randomUUID().slice(0, 4)}`;
    const created = await inject("POST", "/api/templates", admin, { name, body: "Hi {name}", whatsapp: true, sms: false });
    expect(created.statusCode).toBe(201);
    const tpl = created.json();
    expect(tpl).toMatchObject({ name, body: "Hi {name}", whatsapp: true, sms: false, active: true });
    expect((await inject("POST", "/api/templates", admin, { name: "x", body: "y", whatsapp: false, sms: false })).statusCode).toBe(400);
    expect((await inject("PATCH", `/api/templates/${tpl.id}`, admin, { whatsapp: false })).statusCode).toBe(400);

    const rep = await t.loginDevice(uniqueEmail("trep"));
    const phoneList = async () => (await inject("GET", "/v1/templates", rep.headers)).json().items.map((x: { id: string }) => x.id);
    expect(await phoneList()).toContain(tpl.id);
    expect((await inject("PATCH", `/api/templates/${tpl.id}`, admin, { active: false })).json().active).toBe(false);
    expect(await phoneList()).not.toContain(tpl.id);
    expect((await inject("GET", "/api/templates?all=1", admin)).json().items.map((x: { id: string }) => x.id)).toContain(tpl.id);
    // Non-admins never see inactive ones, even with all=1.
    expect((await inject("GET", "/api/templates?all=1", rep.headers)).json().items.map((x: { id: string }) => x.id)).not.toContain(tpl.id);
    expect((await inject("POST", "/api/templates", rep.headers, { name: "x", body: "y", whatsapp: true, sms: true })).statusCode).toBe(403);

    expect((await inject("DELETE", `/api/templates/${tpl.id}`, admin)).statusCode).toBe(204);
    expect((await inject("DELETE", `/api/templates/${tpl.id}`, admin)).statusCode).toBe(404);
    expect(await t.db.auditLog.count({ where: { action: "TEMPLATE_CHANGE", detail: { path: ["deleted"], equals: tpl.id } } })).toBe(1);
  });
});

describe("call scripts", () => {
  it("CRUD with sections; managers can list with listCount", async () => {
    const res = await inject("POST", "/api/scripts", admin, {
      name: "GST pitch",
      sections: [
        { heading: "Open", text: "Hi, this is {rep}" },
        { heading: "Ask", text: "When is your GST due?" },
      ],
    });
    expect(res.statusCode).toBe(201);
    const s = res.json();
    expect(s).toMatchObject({ name: "GST pitch", active: true, sections: [{ heading: "Open" }, { heading: "Ask" }] });
    expect((await inject("POST", "/api/scripts", admin, { name: "x", sections: [] })).statusCode).toBe(400);
    const patched = await inject("PATCH", `/api/scripts/${s.id}`, admin, { sections: [{ heading: "If busy", text: "Call later" }] });
    expect(patched.json().sections).toEqual([{ heading: "If busy", text: "Call later" }]);
    const mgrEmail = uniqueEmail("tmgr");
    await t.db.user.create({ data: { email: mgrEmail, role: "MANAGER" } });
    const list = await inject("GET", "/api/scripts", await t.sessionFor(mgrEmail));
    expect(list.json().items.find((x: { id: string }) => x.id === s.id)).toMatchObject({ listCount: 0 });
    expect((await inject("POST", "/api/scripts", await t.sessionFor(mgrEmail), { name: "x", sections: [{ heading: "a", text: "b" }] })).statusCode).toBe(403);
  });
});

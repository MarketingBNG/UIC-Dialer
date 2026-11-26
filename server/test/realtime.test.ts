import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Realtime, topicFor } from "../src/realtime.js";
import { setupTestApp, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
let base: string;
beforeAll(async () => {
  t = await setupTestApp();
  await t.app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await t.app.close();
  await t.db.$disconnect();
});

const randomMobile = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

/** Opens /api/events and collects "change" events. */
function listen(headers: Record<string, string>) {
  const events: { topic: string; userId: string | null }[] = [];
  const rings: { state: string; phone: string | null }[] = [];
  let status = 0;
  let req!: http.ClientRequest;
  const ready = new Promise<void>((resolve, reject) => {
    req = http.get(`${base}/api/events`, { headers }, (res) => {
      status = res.statusCode ?? 0;
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.includes("event: ready")) resolve();
          const data = /^event: change\ndata: (.*)$/m.exec(block);
          if (data) events.push(JSON.parse(data[1]!));
          const ring = /^event: ringing\ndata: (.*)$/m.exec(block);
          if (ring) rings.push(JSON.parse(ring[1]!));
        }
      });
      if (status !== 200) resolve();
    });
    req.on("error", reject);
  });
  return { events, rings, ready, status: () => status, close: () => req.destroy() };
}

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("topicFor", () => {
  it("maps writes to topics and ignores reads and noise", () => {
    expect(topicFor("POST", "/v1/activities/batch")).toBe("activity");
    expect(topicFor("PATCH", "/api/contacts/:id")).toBe("contacts");
    expect(topicFor("POST", "/v1/calls")).toBe("calls");
    expect(topicFor("POST", "/v1/calls/log")).toBe("calls");
    expect(topicFor("POST", "/internal/jobs/:jobId/result")).toBe("calls");
    expect(topicFor("POST", "/internal/jobs/claim")).toBeNull();
    expect(topicFor("POST", "/internal/jobs/:jobId/heartbeat")).toBeNull();
    expect(topicFor("POST", "/v1/device/heartbeat")).toBeNull();
    expect(topicFor("GET", "/api/contacts")).toBeNull();
  });
});

describe("GET /api/events", () => {
  it("needs sign-in", async () => {
    const s = listen({});
    await s.ready;
    expect(s.status()).toBe(401);
    s.close();
  });

  it("tells the rep's desktop when their phone logs an outcome, but not other reps", async () => {
    const repEmail = uniqueEmail("rep");
    const rep = await t.loginDevice(repEmail);
    const other = await t.loginDevice(uniqueEmail("rep"));
    const admin = await t.loginDevice(uniqueEmail("admin"), "ADMIN");

    const desk = listen(await t.sessionFor(repEmail)); // the rep's Windows app (cookie)
    const otherPhone = listen(other.headers); // another rep's phone (bearer)
    const boss = listen(admin.headers);
    await Promise.all([desk.ready, otherPhone.ready, boss.ready]);

    const res = await t.app.inject({
      method: "POST",
      url: "/v1/activities",
      headers: rep.headers,
      payload: { clientId: randomUUID(), type: "CALL", occurredAt: new Date().toISOString(), phone: randomMobile(), outcome: "INTERESTED" },
    });
    expect(res.statusCode).toBe(200);

    await waitFor(() => desk.events.some((e) => e.topic === "activity"));
    await waitFor(() => boss.events.some((e) => e.topic === "activity"));
    expect(desk.events.find((e) => e.topic === "activity")!.userId).toBe(rep.user.id);
    // Contact changes go to everyone; the rep-scoped activity does not reach the other rep.
    await new Promise((r) => setTimeout(r, 200));
    expect(otherPhone.events.some((e) => e.topic === "activity")).toBe(false);

    for (const s of [desk, otherPhone, boss]) s.close();
  });

  it("shows an incoming call on the rep's own desktop only (not other reps or managers)", async () => {
    const repEmail = uniqueEmail("rep");
    const rep = await t.loginDevice(repEmail);
    const other = await t.loginDevice(uniqueEmail("rep"));
    const admin = await t.loginDevice(uniqueEmail("admin"), "ADMIN");
    const desk = listen(await t.sessionFor(repEmail));
    const otherDesk = listen(other.headers);
    const boss = listen(admin.headers);
    await Promise.all([desk.ready, otherDesk.ready, boss.ready]);

    const res = await t.app.inject({ method: "POST", url: "/v1/ringing", headers: rep.headers, payload: { state: "ringing", phone: "98765 43210" } });
    expect(res.statusCode).toBe(200);
    await waitFor(() => desk.rings.length > 0);
    expect(desk.rings[0]).toEqual({ state: "ringing", phone: "+919876543210" });
    await t.app.inject({ method: "POST", url: "/v1/ringing", headers: rep.headers, payload: { state: "ended" } });
    await waitFor(() => desk.rings.length > 1);
    expect(desk.rings[1]).toEqual({ state: "ended", phone: null });
    await new Promise((r) => setTimeout(r, 200));
    expect(otherDesk.rings).toEqual([]);
    expect(boss.rings).toEqual([]);
    for (const s of [desk, otherDesk, boss]) s.close();
  });

  it("rejects ringing reports without a phone sign-in or with a bad state", async () => {
    expect((await t.app.inject({ method: "POST", url: "/v1/ringing", payload: { state: "ringing" } })).statusCode).toBe(401);
    const rep = await t.loginDevice(uniqueEmail("rep"));
    expect((await t.app.inject({ method: "POST", url: "/v1/ringing", headers: rep.headers, payload: { state: "boom" } })).statusCode).toBe(400);
  });

  it("does not notify on failed writes", async () => {
    const rep = await t.loginDevice(uniqueEmail("rep"));
    const s = listen(rep.headers);
    await s.ready;
    const res = await t.app.inject({ method: "POST", url: "/v1/activities", headers: rep.headers, payload: { bad: true } });
    expect(res.statusCode).toBe(400);
    await new Promise((r) => setTimeout(r, 200));
    expect(s.events).toEqual([]);
    s.close();
  });
});

describe("Realtime across instances", () => {
  it("delivers a change published on one instance to streams on another (LISTEN/NOTIFY)", async () => {
    const a = new Realtime(t, t.app.log);
    const b = new Realtime(t, t.app.log);
    const got: string[] = [];
    b.subscribe({ userId: "u1", seesAll: false, send: (e) => got.push(e.topic), end: () => {} });
    // Wait for b's LISTEN connection.
    await new Promise((r) => setTimeout(r, 500));
    await a.publish({ topic: "contacts", userId: null });
    await waitFor(() => got.includes("contacts"));
    await a.close();
    await b.close();
  });
});

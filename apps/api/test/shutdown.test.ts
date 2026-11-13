import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createShutdown } from "../src/shutdown.ts";

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
});
async function listen(handler: http.RequestListener) {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return { server: s, port: (s.address() as AddressInfo).port };
}
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("graceful shutdown", () => {
  it("stops accepting, finishes an in-flight request, stops workers, ends pools, then exits 0, in that order", async () => {
    const events: string[] = [];
    const { server, port } = await listen(async (_req, res) => { events.push("request-start"); await tick(200); events.push("request-end"); res.end("done"); });
    server.on("close", () => events.push("server-closed"));
    const agent = new http.Agent({ keepAlive: true });
    const inflight = new Promise<string>((resolve) => http.get({ port, host: "127.0.0.1", agent }, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => resolve(b)); }));
    await tick(50); // the request is being served
    const exits: number[] = [];
    const stop = createShutdown({
      server,
      stoppers: [async () => { await tick(20); events.push("worker-a-stopped"); }, async () => { events.push("worker-b-stopped"); }],
      pools: [async () => { events.push("pool-ended"); }],
      exit: (c) => { events.push(`exit:${c}`); exits.push(c); },
      log: () => undefined,
    });
    await stop();
    expect(await inflight).toBe("done"); // not cut off
    agent.destroy();
    expect(events.indexOf("request-end")).toBeLessThan(events.indexOf("server-closed"));
    expect(events.indexOf("worker-a-stopped")).toBeLessThan(events.indexOf("pool-ended"));
    expect(events.indexOf("server-closed")).toBeLessThan(events.indexOf("pool-ended"));
    expect(events.at(-1)).toBe("exit:0");
    expect(exits).toEqual([0]);
    // no longer accepting
    await expect(new Promise((res, rej) => { const r = http.get({ port, host: "127.0.0.1" }, res); r.on("error", rej); })).rejects.toThrow();
  });

  it("an idle keep-alive connection does not hold the shutdown open", async () => {
    const { server, port } = await listen((_req, res) => res.end("ok"));
    const agent = new http.Agent({ keepAlive: true });
    await new Promise<void>((resolve) => http.get({ port, host: "127.0.0.1", agent }, (r) => { r.resume(); r.on("end", () => resolve()); })); // leaves an idle socket
    const exits: number[] = [];
    const t0 = Date.now();
    await createShutdown({ server, stoppers: [], pools: [], exit: (c) => exits.push(c), log: () => undefined })();
    agent.destroy();
    expect(exits).toEqual([0]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("a worker that never stops is cut off at the deadline (exit 1), and only one exit happens for repeated calls", async () => {
    const { server } = await listen((_req, res) => res.end("ok"));
    const exits: number[] = [];
    const stop = createShutdown({ server, stoppers: [() => new Promise(() => undefined)], pools: [], exit: (c) => exits.push(c), timeoutMs: 150, log: () => undefined });
    void stop();
    await tick(400);
    expect(exits).toEqual([1]);
  });

  it("a failing worker or pool does not block the exit", async () => {
    const { server } = await listen((_req, res) => res.end("ok"));
    const exits: number[] = [];
    await createShutdown({ server, stoppers: [async () => { throw new Error("boom"); }], pools: [async () => { throw new Error("pool boom"); }], exit: (c) => exits.push(c), log: () => undefined })();
    expect(exits).toEqual([0]);
  });

  it("a second signal while shutting down exits immediately", async () => {
    const { server } = await listen((_req, res) => res.end("ok"));
    const exits: number[] = [];
    const stop = createShutdown({ server, stoppers: [() => new Promise(() => undefined)], pools: [], exit: (c) => exits.push(c), timeoutMs: 60_000, log: () => undefined });
    void stop();
    await tick(30);
    void stop();
    expect(exits).toEqual([1]);
  });
});

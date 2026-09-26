import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BrydgeClient, BrydgeError, DEFAULT_BASE_URL, VERSION } from "../../src/index.js";
import { fakeBrydge } from "./fake-brydge.js";

const KEY = "brydge_sk_unit_test_key";

describe("the BRYDGE client", () => {
  it("needs a BRYDGE key, and sends it only over https or to this machine", () => {
    expect(() => new BrydgeClient({ apiKey: "" })).toThrow(/BRYDGE_API_KEY/);
    expect(() => new BrydgeClient({ apiKey: "sk_live_1" })).toThrow(/start with brydge_sk_/);
    expect(() => new BrydgeClient({ apiKey: KEY, baseUrl: "http://brydge.example.com" })).toThrow(/https/);
    expect(new BrydgeClient({ apiKey: KEY, baseUrl: "http://127.0.0.1:3000/" }).baseUrl).toBe("http://127.0.0.1:3000");
    expect(new BrydgeClient({ apiKey: KEY }).baseUrl).toBe(DEFAULT_BASE_URL);
    expect(new BrydgeClient({ apiKey: KEY, baseUrl: "" }).baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it("keeps the key off the object", () => {
    const client = new BrydgeClient({ apiKey: KEY, baseUrl: "https://brydge.test" });
    expect(JSON.stringify(client)).not.toContain(KEY);
    expect(Object.values(client)).not.toContain(KEY);
  });

  it("puts an authorization into the path as one segment", async () => {
    const brydge = fakeBrydge();
    const client = new BrydgeClient({ apiKey: KEY, baseUrl: "https://brydge.test", fetch: brydge.fetcher });
    await client.finding("../../api/keys?x=1").catch(() => undefined);
    expect(brydge.sent[0]!.path).toBe(`/api/supervise/${encodeURIComponent("../../api/keys?x=1")}/verify`);
  });

  it("carries BRYDGE's reason and retry advice on a refusal", async () => {
    const brydge = fakeBrydge({
      refuse: { "POST /api/supervise": () => Response.json({ error: "too many", retryAfterSeconds: 9 }, { status: 429 }) },
    });
    const client = new BrydgeClient({ apiKey: KEY, baseUrl: "https://brydge.test", fetch: brydge.fetcher });
    await expect(client.supervise({ actor: "a", action: "refund", target: "t", idempotencyKey: "k" })).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 9,
    });
  });

  it("gives up after the timeout, saying a retry is safe", async () => {
    const client = new BrydgeClient({
      apiKey: KEY,
      baseUrl: "https://brydge.test",
      timeoutMs: 50,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
    });
    const error = await client.verify("sup_1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BrydgeError);
    expect((error as Error).message).toMatch(/did not answer within 50 ms.*safe/);
  });

  it("announces the version it is published as", () => {
    const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(version);
  });
});

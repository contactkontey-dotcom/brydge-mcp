import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { createBrydgeServer, INSTRUCTIONS, VERSION, type BrydgeServerConfig } from "../../src/index.js";
import { fakeBrydge } from "./fake-brydge.js";

/*
 * The server, driven by the SDK's own MCP client, in both protocol eras:
 *
 *   modern  2026-07-28, stateless, found by a server/discover probe
 *   legacy  2025-11-25 and earlier, opened with an initialize handshake
 *
 * Clients in the field speak both, so every behaviour here is checked in each.
 */

const ACTOR = "agent:refund-ops";
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

type Era = "modern" | "legacy";

async function connect(era: Era, config: BrydgeServerConfig): Promise<Client> {
  if (era === "modern") {
    const handler = createMcpHandler(() => createBrydgeServer(config));
    const client = new Client({ name: "test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://brydge-mcp.test/mcp"), {
        fetch: (url, init) => handler.fetch(new Request(url, init)),
      }),
    );
    closers.push(async () => {
      await client.close();
      await handler.close();
    });
    return client;
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createBrydgeServer(config);
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

const configured = (brydge: ReturnType<typeof fakeBrydge>): BrydgeServerConfig => ({
  apiKey: "brydge_sk_unit_test_key",
  actor: ACTOR,
  baseUrl: "https://brydge.test",
  fetch: brydge.fetcher,
});

const text = (result: { content: unknown }) =>
  (result.content as Array<{ type: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text);

describe.each<Era>(["modern", "legacy"])("over the %s protocol", (era) => {
  it("lands in that era, and names itself", async () => {
    const client = await connect(era, configured(fakeBrydge()));
    expect(client.getProtocolEra()).toBe(era);
    expect(client.getServerVersion()).toMatchObject({ name: "brydge", title: "BRYDGE", version: VERSION });
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
  });

  it("lists five tools, always in the same order, and none of them lets the model choose the agent", async () => {
    const client = await connect(era, configured(fakeBrydge()));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "brydge_supervise",
      "brydge_report_outcome",
      "brydge_verify",
      "brydge_get_finding",
      "brydge_get_headroom",
    ]);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
      expect(tool.title).toBeTruthy();
      expect(tool.description!.length).toBeGreaterThan(60);
      expect(Object.keys((tool.inputSchema as { properties?: object }).properties ?? {})).not.toContain("actor");
      expect(tool.outputSchema).toBeDefined();
    }
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(hints.brydge_get_finding).toMatchObject({ readOnlyHint: true });
    expect(hints.brydge_get_headroom).toMatchObject({ readOnlyHint: true });
    expect(hints.brydge_verify).toMatchObject({ readOnlyHint: false, idempotentHint: true, openWorldHint: true });
    expect(hints.brydge_supervise).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
  });

  it("asks before acting as the configured agent, and hands back the authorization to cite", async () => {
    const brydge = fakeBrydge();
    const client = await connect(era, configured(brydge));
    const result = await client.callTool({
      name: "brydge_supervise",
      /* An `actor` from the model is not part of the schema and does not reach BRYDGE. */
      arguments: { action: "refund", target: "ch_1", facts: { amount: 4200 }, idempotency_key: "refund:ch_1", actor: "agent:admin" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      authorization: "sup_1",
      decision: "ALLOWED",
      because: "Within mandate mdt_1.",
      unobserved: [],
      replayed: false,
    });
    expect(text(result)[0]).toMatch(/^ALLOWED\. Authorization: sup_1\. Carry the action out and write this id/);
    expect(JSON.parse(text(result)[1]!)).toEqual(result.structuredContent);

    const [sent] = brydge.asked();
    expect(sent!.headers.authorization).toBe("Bearer brydge_sk_unit_test_key");
    expect(sent!.headers["user-agent"]).toBe(`brydge-mcp/${VERSION}`);
    expect(sent!.body).toMatchObject({ actor: ACTOR, action: "refund", target: "ch_1", facts: { amount: 4200 } });
    expect(sent!.body!.idempotencyKey).toMatch(/^mcp:[0-9a-f]{48}$/);
  });

  it("tells the model not to act when a person has to decide", async () => {
    const client = await connect(era, configured(fakeBrydge({ decide: () => "ESCALATED" })));
    const result = await client.callTool({
      name: "brydge_supervise",
      arguments: { action: "refund", target: "ch_1", idempotency_key: "refund:ch_1" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ decision: "ESCALATED", authorization: "sup_1", unobserved: ["amount"] });
    expect(text(result)[0]).toBe(
      "ESCALATED. Do not carry this out: a person decides. No mandate covers refund for this agent. " +
        "BRYDGE was not told: amount. Authorization: sup_1.",
    );
  });

  it("gives a retried action the same key, and a different action a different one, whatever the model named them", async () => {
    const brydge = fakeBrydge();
    const client = await connect(era, configured(brydge));
    const ask = (target: string, amount: number, key: string) =>
      client.callTool({ name: "brydge_supervise", arguments: { action: "refund", target, facts: { amount }, idempotency_key: key } });
    const first = await ask("ch_1", 100, "refund:ch_1");
    const retried = await ask("ch_1", 100, "refund:ch_1");
    await ask("ch_1", 999, "refund:ch_1");
    await ask("ch_2", 100, "refund:ch_1");
    const keys = brydge.asked().map((s) => s.body!.idempotencyKey);
    expect(keys[1]).toBe(keys[0]);
    expect(new Set(keys).size).toBe(3);
    expect(retried.structuredContent).toMatchObject({ authorization: (first.structuredContent as { authorization: string }).authorization, replayed: true });
  });

  it("checks the work against the records, and says plainly when that is not confirmation", async () => {
    const brydge = fakeBrydge({
      finding: (id) =>
        id === "sup_2"
          ? { state: "UNKNOWN", reason: "NO_MATCH", because: "The destination has no record of this action." }
          : { state: "VERIFIED", reason: null, because: "The destination's books match what BRYDGE authorised.", externalRef: "re_1" },
    });
    const client = await connect(era, configured(brydge));
    const verified = await client.callTool({ name: "brydge_verify", arguments: { authorization: "sup_1" } });
    expect(verified.structuredContent).toMatchObject({ authorization: "sup_1", state: "VERIFIED", externalRef: "re_1", checkedAt: "2026-09-26T12:00:00.000Z" });
    expect(text(verified)[0]).toBe("VERIFIED. The destination's books match what BRYDGE authorised. It happened as permitted.");

    const unknown = await client.callTool({ name: "brydge_verify", arguments: { authorization: "sup_2" } });
    expect(unknown.structuredContent).toMatchObject({ state: "UNKNOWN", reason: "NO_MATCH" });
    expect(text(unknown)[0]).toBe(
      "UNKNOWN (NO_MATCH). The destination has no record of this action. This does not confirm that the work happened.",
    );
    expect(brydge.sent.filter((s) => s.method === "POST" && s.path.endsWith("/verify")).map((s) => s.body)).toEqual([null, null]);
  });

  it("reads what BRYDGE has found so far without checking again", async () => {
    const brydge = fakeBrydge();
    const client = await connect(era, configured(brydge));
    const result = await client.callTool({ name: "brydge_get_finding", arguments: { authorization: "sup_9" } });
    expect(result.structuredContent).toEqual({
      authorization: "sup_9",
      state: "PENDING",
      reason: null,
      because: "BRYDGE has not checked this action yet.",
      externalRef: null,
      claimed: null,
      agentAgreed: null,
      checkedAt: null,
      replayed: false,
    });
    expect(brydge.sent.map((s) => s.method)).toEqual(["GET"]);
  });

  it("reports the outcome as the configured agent", async () => {
    const brydge = fakeBrydge();
    const client = await connect(era, configured(brydge));
    const result = await client.callTool({
      name: "brydge_report_outcome",
      arguments: { authorization: "sup_3", outcome: "SUCCEEDED", said: "re_123 succeeded" },
    });
    expect(result.structuredContent).toEqual({ authorization: "sup_3", recorded: "SUCCEEDED" });
    expect(brydge.sent[0]).toMatchObject({
      method: "POST",
      path: "/api/supervise/sup_3/outcome",
      body: { verdict: "SUCCEEDED", by: ACTOR, said: "re_123 succeeded" },
    });
  });

  it("reads headroom for the configured agent", async () => {
    const brydge = fakeBrydge();
    const client = await connect(era, configured(brydge));
    const result = await client.callTool({ name: "brydge_get_headroom", arguments: { action: "refund" } });
    expect(result.structuredContent).toMatchObject({ action: "refund", actions: 4, used: 1, remaining: 3 });
    expect(text(result)[0]).toMatch(/^3 of 4 refund actions left in any 24 hours\./);
    const asked = new URL(`https://brydge.test${brydge.sent[0]!.path}`);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ actor: ACTOR, action: "refund" });
  });

  it("turns BRYDGE declining to answer into an error the model can read, not a decision", async () => {
    const brydge = fakeBrydge({
      refuse: {
        "POST /api/supervise": () =>
          Response.json({ error: 'nothing has been declared for "refund"', reason: "nothing_declared" }, { status: 402 }),
      },
    });
    const client = await connect(era, configured(brydge));
    const result = await client.callTool({
      name: "brydge_supervise",
      arguments: { action: "refund", target: "ch_1", idempotency_key: "k" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toEqual(['Not done. BRYDGE answered 402: nothing has been declared for "refund"']);
  });

  it("rejects facts BRYDGE cannot judge before anything is sent", async () => {
    const brydge = fakeBrydge();
    const client = await connect(era, configured(brydge));
    const result = await client.callTool({
      name: "brydge_supervise",
      arguments: { action: "refund", target: "ch_1", facts: { lines: [1, 2] }, idempotency_key: "k" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)[0]).toMatch(/Input validation error/);
    expect(brydge.sent).toEqual([]);
  });

  it("still lists its tools when it is not configured, and every call says what is missing", async () => {
    const client = await connect(era, { actor: ACTOR });
    expect((await client.listTools()).tools).toHaveLength(5);
    const noKey = await client.callTool({ name: "brydge_verify", arguments: { authorization: "sup_1" } });
    expect(noKey.isError).toBe(true);
    expect(text(noKey)[0]).toMatch(/^Not done\. BRYDGE_API_KEY is not set\./);

    const noActor = await connect(era, { apiKey: "brydge_sk_unit_test_key" });
    const result = await noActor.callTool({ name: "brydge_get_headroom", arguments: { action: "refund" } });
    expect(text(result)[0]).toMatch(/^Not done\. BRYDGE_ACTOR is not set\./);

    const wrongKey = await connect(era, { apiKey: "sk_live_x", actor: ACTOR });
    const refused = await wrongKey.callTool({ name: "brydge_verify", arguments: { authorization: "sup_1" } });
    expect(text(refused)[0]).toMatch(/BRYDGE keys start with brydge_sk_/);
  });
});

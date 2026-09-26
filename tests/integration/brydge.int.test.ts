import { createServer, type Server } from "node:http";
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBrydgeServer } from "../../src/index.js";

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * AGAINST A RUNNING BRYDGE.
 *
 * A real MCP client, the BRYDGE MCP server, a real BRYDGE over HTTP, and a
 * destination whose books this file keeps. The "agent" is the test: it asks
 * through the MCP tools, writes the refund into the books citing the
 * authorization, and asks BRYDGE whether it happened.
 *
 * Needs a BRYDGE workspace with an API key, a declared value for `refund`, a
 * destination reading http://localhost:<port>/transactions with the books
 * token as its credential, and mandates for agent:mcp-honest and
 * agent:mcp-overpays covering amounts up to 10000. See README.md here.
 * Skipped when the environment below is not set.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const env = {
  url: process.env.BRYDGE_URL,
  key: process.env.BRYDGE_API_KEY,
  port: Number(process.env.BRYDGE_TEST_BOOKS_PORT),
  token: process.env.BRYDGE_TEST_BOOKS_TOKEN,
};
const ready = Boolean(env.url && env.key && env.port && env.token);
/* A development server compiles each route on its first request. */
const timeoutMs = Number(process.env.BRYDGE_TEST_TIMEOUT_MS ?? 120_000);

interface Entry {
  reference: string;
  authorization: string | null;
  actor: string | null;
  action: string | null;
  target: string;
  amount: number;
  status: string;
}

const books: Entry[] = [];
const stamp = Date.now().toString(36);
let server: Server;
const closers: Array<() => Promise<void>> = [];

function startBooks(): Promise<Server> {
  const s = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.headers.authorization !== `Bearer ${env.token}`) {
      res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');
      return;
    }
    const authorization = url.searchParams.get("authorization");
    const target = url.searchParams.get("target");
    const matches = books.filter(
      (e) => (!authorization && !target) || e.authorization === authorization || e.target === target,
    );
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ transactions: matches }));
  });
  return new Promise((resolve) => s.listen(env.port, "localhost", () => resolve(s)));
}

/** An MCP client connected to the BRYDGE server for this agent, in the given protocol era. */
async function connect(actor: string, era: "modern" | "legacy"): Promise<Client> {
  const config = { apiKey: env.key, actor, baseUrl: env.url, timeoutMs };
  if (era === "modern") {
    const handler = createMcpHandler(() => createBrydgeServer(config));
    const client = new Client({ name: "int", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
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
  const mcp = createBrydgeServer(config);
  await mcp.connect(serverSide);
  const client = new Client({ name: "int", version: "1.0.0" });
  await client.connect(clientSide);
  closers.push(async () => {
    await client.close();
    await mcp.close();
  });
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args }, { timeout: timeoutMs });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as Record<string, unknown>;
};

/** Ask, then act at the destination the way a real agent would: citing the authorization. */
async function refund(client: Client, actor: string, charge: string, amount: number, recorded = amount) {
  const decision = await call(client, "brydge_supervise", {
    action: "refund",
    target: charge,
    facts: { amount },
    idempotency_key: `refund:${charge}`,
  });
  if (decision.decision === "ALLOWED") {
    books.push({
      reference: `re_${books.length + 1}_${stamp}`,
      authorization: String(decision.authorization),
      actor,
      action: "refund",
      target: charge,
      amount: recorded,
      status: "succeeded",
    });
    await call(client, "brydge_report_outcome", { authorization: decision.authorization, outcome: "SUCCEEDED" });
  }
  return decision;
}

describe.skipIf(!ready)("against a running BRYDGE", { timeout: timeoutMs * 2 }, () => {
  beforeAll(async () => {
    server = await startBooks();
  });
  afterEach(async () => {
    while (closers.length > 0) await closers.pop()!();
  });
  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
  });

  it("an honest refund, asked for over the 2026-07-28 protocol, is VERIFIED and the report agrees", async () => {
    const client = await connect("agent:mcp-honest", "modern");
    expect(client.getProtocolEra()).toBe("modern");
    const charge = `ch_mcp_honest_${stamp}`;
    const decision = await refund(client, "agent:mcp-honest", charge, 4_200);
    expect(decision.decision).toBe("ALLOWED");

    const finding = await call(client, "brydge_verify", { authorization: decision.authorization });
    expect(finding).toMatchObject({ state: "VERIFIED", reason: null, claimed: "SUCCEEDED", agentAgreed: true });

    /* The free read sees the same finding. */
    expect(await call(client, "brydge_get_finding", { authorization: decision.authorization })).toMatchObject({
      state: "VERIFIED",
    });
    /* And the checked, agreeing report shows up in the agent's record. */
    const room = await call(client, "brydge_get_headroom", { action: "refund" });
    expect(room).toMatchObject({ action: "refund", used: 1 });
  });

  it("a refund for more than was permitted, asked for over the 2025 protocol, is a MISMATCH on the amount", async () => {
    const client = await connect("agent:mcp-overpays", "legacy");
    expect(client.getProtocolEra()).toBe("legacy");
    const decision = await refund(client, "agent:mcp-overpays", `ch_mcp_over_${stamp}`, 3_000, 6_000);
    const finding = await call(client, "brydge_verify", { authorization: decision.authorization });
    expect(finding).toMatchObject({ state: "MISMATCH", reason: "AMOUNT", claimed: "SUCCEEDED", agentAgreed: false });
  });

  it("an agent with no mandate is told to leave it to a person", async () => {
    const client = await connect("agent:mcp-unmandated", "modern");
    const before = books.length;
    const decision = await refund(client, "agent:mcp-unmandated", `ch_mcp_nomandate_${stamp}`, 1_000);
    expect(decision.decision).toBe("ESCALATED");
    expect(books.length).toBe(before);
  });
});

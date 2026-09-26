import { createHash } from "node:crypto";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { BrydgeClient, DEFAULT_BASE_URL } from "./client.js";
import { BrydgeError } from "./errors.js";
import type { Facts, Verification } from "./types.js";
import { VERSION } from "./version.js";

export interface BrydgeServerConfig {
  /** Your BRYDGE API key. When it is missing, every tool says how to set it. */
  apiKey?: string;
  /**
   * The agent, as BRYDGE knows it, such as `agent:refund-ops`. Mandates are
   * issued to this name. It comes from configuration and never from the
   * model, so an agent cannot borrow another agent's permissions.
   */
  actor?: string;
  /** Where BRYDGE runs. Defaults to BRYDGE's hosted service. */
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** What the server tells the model about using it. */
export const INSTRUCTIONS = [
  "BRYDGE checks whether your actions actually happened, against the destination system's own records.",
  "1. Before an action that changes something in another system (a refund, a payment, a ticket), call brydge_supervise.",
  "2. If it is ALLOWED, carry the action out and write the authorization id into the record the action creates, " +
    "where the destination keeps it (for a Stripe refund: metadata.brydge_authorization). BRYDGE finds the work by that id. " +
    "If it is ESCALATED, do not carry it out: a person decides.",
  "3. After acting, call brydge_report_outcome with what you believe happened.",
  "4. Before you tell anyone the work is done, call brydge_verify. Only VERIFIED means it happened as permitted.",
].join("\n");

const Authorization = z
  .string()
  .min(1)
  .max(200)
  .describe("The authorization id brydge_supervise returned for the action.");

const Finding = z.object({
  authorization: z.string(),
  state: z.enum(["PENDING", "VERIFIED", "FAILED", "MISMATCH", "UNKNOWN"]),
  reason: z.string().nullable(),
  because: z.string(),
  externalRef: z.string().nullable(),
  claimed: z.string().nullable(),
  agentAgreed: z.boolean().nullable(),
  checkedAt: z.string().nullable(),
  replayed: z.boolean(),
});

/**
 * BRYDGE as an MCP server: five tools over BRYDGE's API.
 *
 * Build one per connection; `serveStdio` and `createMcpHandler` both take
 * this as their factory.
 */
export function createBrydgeServer(config: BrydgeServerConfig): McpServer {
  const server = new McpServer(
    { name: "brydge", title: "BRYDGE", version: VERSION, websiteUrl: DEFAULT_BASE_URL },
    {
      instructions: INSTRUCTIONS,
      /* The tool list is fixed for a given version, so clients may keep it. */
      cacheHints: { "tools/list": { ttlMs: 3_600_000, cacheScope: "public" } },
    },
  );

  const ready = setUp(config);

  /** Runs a tool against BRYDGE; anything that stops BRYDGE answering becomes an error the model can read. */
  const run = async (work: (brydge: Ready) => Promise<CallToolResult>): Promise<CallToolResult> => {
    if ("problem" in ready) return failure(`Not done. ${ready.problem}`);
    try {
      return await work(ready);
    } catch (error) {
      if (error instanceof BrydgeError) return failure(`Not done. ${error.message}`);
      throw error;
    }
  };

  server.registerTool(
    "brydge_supervise",
    {
      title: "Ask BRYDGE before acting",
      description:
        "Ask BRYDGE whether you may take an action, before you take it. ALLOWED returns an authorization id: " +
        "carry the action out and write that id into the record it creates, where the destination keeps it " +
        "(for a Stripe refund: metadata.brydge_authorization). ESCALATED means a person decides: do not carry it out.",
      inputSchema: z.object({
        action: z.string().min(1).max(120).describe("The kind of work, as it is set up in BRYDGE, such as refund."),
        target: z.string().min(1).max(400).describe("What the work acts on: the charge, order or ticket id."),
        facts: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .optional()
          .describe(
            'What BRYDGE\'s rules judge the action by, such as {"amount": 4200}. BRYDGE compares a fact named ' +
              "amount with the amount in the destination's record, so give it in the same units.",
          ),
        idempotency_key: z
          .string()
          .min(1)
          .max(200)
          .describe(
            "A name for this one intended action, such as refund:ch_123. Send the same value if you retry " +
              "the same action; never reuse it for a different one.",
          ),
      }),
      outputSchema: z.object({
        authorization: z.string(),
        decision: z.enum(["ALLOWED", "ESCALATED"]),
        because: z.string(),
        unobserved: z.array(z.string()),
        replayed: z.boolean(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ action, target, facts, idempotency_key }, ctx) =>
      run(async ({ client, actor }) => {
        const asked = facts ?? {};
        const supervision = await client.supervise(
          { actor, action, target, facts: asked, idempotencyKey: keyFor(actor, action, target, asked, idempotency_key) },
          { signal: ctx.mcpReq.signal },
        );
        const output = {
          authorization: supervision.id,
          decision: supervision.decision,
          because: supervision.because,
          unobserved: supervision.unobserved,
          replayed: supervision.replayed,
        };
        const summary =
          supervision.decision === "ALLOWED"
            ? `ALLOWED. Authorization: ${supervision.id}. Carry the action out and write this id into the record ` +
              `it creates, where the destination keeps it. ${supervision.because}`
            : `ESCALATED. Do not carry this out: a person decides. ${supervision.because}` +
              (supervision.unobserved.length > 0 ? ` BRYDGE was not told: ${supervision.unobserved.join(", ")}.` : "") +
              ` Authorization: ${supervision.id}.`;
        return result(summary, output);
      }),
  );

  server.registerTool(
    "brydge_report_outcome",
    {
      title: "Report what happened",
      description:
        "Tell BRYDGE what you believe happened after you carried out an allowed action. BRYDGE keeps your report " +
        "beside what it finds in the destination's records; the report never changes the finding.",
      inputSchema: z.object({
        authorization: Authorization,
        outcome: z
          .enum(["SUCCEEDED", "FAILED", "REVERSED", "CORRECTED"])
          .describe(
            "SUCCEEDED: it was carried out and did what it was meant to. FAILED: the destination refused it or " +
              "errored. REVERSED: it happened and was undone. CORRECTED: it happened and had to be fixed afterwards.",
          ),
        said: z.string().max(2000).optional().describe("What the destination said, in its own words."),
      }),
      outputSchema: z.object({ authorization: z.string(), recorded: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ authorization, outcome, said }, ctx) =>
      run(async ({ client, actor }) => {
        await client.report(authorization, outcome, {
          by: actor,
          signal: ctx.mcpReq.signal,
          ...(said === undefined ? {} : { said }),
        });
        return result(
          `Recorded ${outcome} for ${authorization}. Call brydge_verify to check it against the records.`,
          { authorization, recorded: outcome },
        );
      }),
  );

  server.registerTool(
    "brydge_verify",
    {
      title: "Check the work actually happened",
      description:
        "Check whether an action actually happened. BRYDGE reads the destination system's own records now, with " +
        "its own credential, and compares them with what it permitted. Only VERIFIED means it happened as permitted; " +
        "FAILED, MISMATCH, UNKNOWN (BRYDGE could not tell) and PENDING (still in progress) are not. Use it before " +
        "you tell anyone the work is done. A check that finds something new is billed; asking again when nothing " +
        "has changed is free.",
      inputSchema: z.object({ authorization: Authorization }),
      outputSchema: Finding,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ authorization }, ctx) =>
      run(async ({ client }) => found(await client.verify(authorization, { signal: ctx.mcpReq.signal }))),
  );

  server.registerTool(
    "brydge_get_finding",
    {
      title: "What BRYDGE has found so far",
      description:
        "What BRYDGE has already found about an action, without reading the records again. Free. BRYDGE checks " +
        "each action by itself once the destination's reporting window has passed; until then this says PENDING.",
      inputSchema: z.object({ authorization: Authorization }),
      outputSchema: Finding,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ authorization }, ctx) =>
      run(async ({ client }) => found(await client.finding(authorization, { signal: ctx.mcpReq.signal }))),
  );

  server.registerTool(
    "brydge_get_headroom",
    {
      title: "How much you may do without a person",
      description:
        "How many actions of this kind you may take in any 24 hours before a person is asked, how many are left, " +
        "and what raises or lowers that. Every report BRYDGE checks and finds true raises it.",
      inputSchema: z.object({
        action: z.string().min(1).max(120).describe("The kind of work, as it is set up in BRYDGE, such as refund."),
      }),
      outputSchema: z.object({
        action: z.string(),
        actions: z.number(),
        earned: z.number(),
        used: z.number(),
        remaining: z.number(),
        says: z.string(),
        raises: z.string(),
        lowers: z.string(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ action }, ctx) =>
      run(async ({ client, actor }) => {
        const room = await client.headroom(actor, action, { signal: ctx.mcpReq.signal });
        const output = {
          action,
          actions: room.actions,
          earned: room.earned,
          used: room.used.actions,
          remaining: room.remaining.actions,
          says: room.says,
          raises: room.raises,
          lowers: room.lowers,
        };
        return result(`${output.remaining} of ${output.actions} ${action} actions left in any 24 hours. ${room.says}`, output);
      }),
  );

  return server;
}

type Ready = { client: BrydgeClient; actor: string };

function setUp(config: BrydgeServerConfig): Ready | { problem: string } {
  const actor = config.actor?.trim();
  if (!config.apiKey?.trim()) {
    return { problem: "BRYDGE_API_KEY is not set. Add it to this server's configuration; issue a key in BRYDGE on the Connect page." };
  }
  if (!actor) {
    return {
      problem:
        "BRYDGE_ACTOR is not set. Add it to this server's configuration: the name BRYDGE knows this agent by, such as agent:refund-ops.",
    };
  }
  try {
    return {
      client: new BrydgeClient({
        apiKey: config.apiKey,
        ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
        ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
      }),
      actor,
    };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * One intended action, one key. The model names the action; the key also
 * covers what is being asked, so a name reused for a different action can
 * never be handed another action's answer.
 */
function keyFor(actor: string, action: string, target: string, facts: Facts, named: string): string {
  const asked = JSON.stringify([
    actor,
    action,
    target,
    Object.keys(facts)
      .sort()
      .map((name) => [name, facts[name]]),
    named,
  ]);
  return `mcp:${createHash("sha256").update(asked).digest("hex").slice(0, 48)}`;
}

function found(verification: Verification): CallToolResult {
  const headline = `${verification.state}${verification.reason ? ` (${verification.reason})` : ""}. ${verification.because}`;
  const summary =
    verification.state === "VERIFIED" && verification.reason !== "NOT_EXECUTED"
      ? `${headline} It happened as permitted.`
      : `${headline} This does not confirm that the work happened.`;
  return result(summary, { ...verification });
}

/** A sentence for the model, and the same result as JSON for clients that read structured output. */
function result(summary: string, output: Record<string, unknown>): CallToolResult {
  return {
    content: [
      { type: "text", text: summary },
      { type: "text", text: JSON.stringify(output) },
    ],
    structuredContent: output,
  };
}

function failure(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

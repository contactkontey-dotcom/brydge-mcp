import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VERSION } from "../../src/index.js";
import { fakeBrydge, serveOverHttp } from "./fake-brydge.js";

/*
 * The built command, spawned the way an MCP host launches it: a child process
 * speaking over stdin and stdout, configured by environment variables, with
 * BRYDGE answering over real HTTP.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));
const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const brydge = fakeBrydge();
let http: Awaited<ReturnType<typeof serveOverHttp>>;

beforeAll(async () => {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "ignore" });
  http = await serveOverHttp(brydge.fetcher);
});
afterAll(async () => {
  await http?.close();
});

const spawnWith = (mode: "legacy" | "auto") => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli],
    env: { BRYDGE_API_KEY: "brydge_sk_stdio_test", BRYDGE_ACTOR: "agent:stdio", BRYDGE_URL: http.url, PATH: process.env.PATH ?? "" },
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-test", version: "1.0.0" }, mode === "auto" ? { versionNegotiation: { mode: "auto" } } : {});
  return { client, transport };
};

describe("the brydge-mcp command", () => {
  it("prints its version", () => {
    expect(execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" }).trim()).toBe(VERSION);
  });

  it.each([
    ["legacy", "legacy"],
    ["auto", "modern"],
  ] as const)("serves a %s client over stdio, in the %s era", async (mode, era) => {
    const { client, transport } = spawnWith(mode);
    await client.connect(transport);
    expect(client.getProtocolEra()).toBe(era);
    expect((await client.listTools()).tools).toHaveLength(5);

    const asked = await client.callTool({
      name: "brydge_supervise",
      arguments: { action: "refund", target: `ch_${mode}`, facts: { amount: 100 }, idempotency_key: `refund:ch_${mode}` },
    });
    expect(asked.structuredContent).toMatchObject({ decision: "ALLOWED" });
    const { authorization } = asked.structuredContent as { authorization: string };
    const checked = await client.callTool({ name: "brydge_verify", arguments: { authorization } });
    expect(checked.structuredContent).toMatchObject({ authorization, state: "VERIFIED" });

    const sent = brydge.sent.filter((s) => s.body?.target === `ch_${mode}`);
    expect(sent[0]!.body).toMatchObject({ actor: "agent:stdio" });
    expect(sent[0]!.headers.authorization).toBe("Bearer brydge_sk_stdio_test");
    await client.close();
  });

  it("starts without configuration, says so on stderr, and never writes anything else to stdout", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli],
      env: { PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const client = new Client({ name: "stdio-test", version: "1.0.0" });
    await client.connect(transport);
    const result = await client.callTool({ name: "brydge_verify", arguments: { authorization: "sup_1" } });
    expect(result.isError).toBe(true);
    await client.close();
    expect(stderr).toMatch(/Not configured: set BRYDGE_API_KEY and BRYDGE_ACTOR/);
  });
});

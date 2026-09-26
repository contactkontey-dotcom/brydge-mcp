#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createBrydgeServer } from "./server.js";
import { VERSION } from "./version.js";

/*
 * `npx brydge-mcp`: BRYDGE over stdio, configured from the environment.
 * stdout carries the protocol, so everything said to a person goes to stderr.
 */

const argument = process.argv[2];
if (argument === "--version" || argument === "-v") {
  console.log(VERSION);
  process.exit(0);
}
if (argument === "--help" || argument === "-h") {
  console.log(
    [
      `brydge-mcp ${VERSION}: BRYDGE as an MCP server, over stdio.`,
      "",
      "Environment:",
      "  BRYDGE_API_KEY  your BRYDGE API key (required)",
      "  BRYDGE_ACTOR    the name BRYDGE knows this agent by, such as agent:refund-ops (required)",
      "  BRYDGE_URL      where BRYDGE runs (default: BRYDGE's hosted service)",
    ].join("\n"),
  );
  process.exit(0);
}

const config = {
  apiKey: process.env.BRYDGE_API_KEY,
  actor: process.env.BRYDGE_ACTOR,
  baseUrl: process.env.BRYDGE_URL || undefined,
};

const handle = serveStdio(() => createBrydgeServer(config));

const missing = [!config.apiKey?.trim() && "BRYDGE_API_KEY", !config.actor?.trim() && "BRYDGE_ACTOR"].filter(Boolean);
console.error(
  `brydge-mcp ${VERSION} on stdio` +
    (missing.length > 0 ? `. Not configured: set ${missing.join(" and ")}; until then every tool says so.` : ""),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void handle.close().finally(() => process.exit(0));
  });
}

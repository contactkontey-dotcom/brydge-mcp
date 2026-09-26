#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createBrydgeServer } from "./server.js";
import { VERSION } from "./version.js";

/*
 * `npx brydge-mcp`: BRYDGE over stdio, configured from the environment.
 * stdout carries the protocol, so everything said to a person goes to stderr.
 */

const HELP = [
  `brydge-mcp ${VERSION}: BRYDGE as an MCP server, over stdio.`,
  "",
  "Environment:",
  "  BRYDGE_API_KEY  your BRYDGE API key (required)",
  "  BRYDGE_ACTOR    the name BRYDGE knows this agent by, such as agent:refund-ops (required)",
  "  BRYDGE_URL      where BRYDGE runs (default: BRYDGE's hosted service)",
].join("\n");

function serve(): void {
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

  /* The portable shutdown is the client closing stdin, which serveStdio handles.
   * Signals are for a person at a terminal; Windows never sends SIGTERM. */
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void handle.close().finally(() => process.exit(0));
    });
  }
}

/* Printing and then calling process.exit() can lose the output: writes to a
 * pipe or a terminal are asynchronous on some platforms. Returning lets Node
 * flush and exit by itself. */
const argument = process.argv[2];
if (argument === "--version" || argument === "-v") {
  console.log(VERSION);
} else if (argument === "--help" || argument === "-h") {
  console.log(HELP);
} else {
  serve();
}

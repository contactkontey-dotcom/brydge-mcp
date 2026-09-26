# Changelog

## 0.1.1

- `--version` and `--help` always print. They exited straight after printing, which could lose the output where writes to a pipe or terminal are asynchronous; now Node finishes writing before it exits.
- The README shows how to start the server through `cmd /c` on Windows, for clients that cannot start `npx` by name.
- The test suite runs on Windows, and CI tests Windows and Linux on Node 20, 22 and 24.

## 0.1.0

First release.

- Five tools over BRYDGE's API: `brydge_supervise`, `brydge_report_outcome`, `brydge_verify`, `brydge_get_finding` and `brydge_get_headroom`.
- Serves MCP 2026-07-28 and the 2025 revisions over stdio, from one process.
- The agent's name comes from `BRYDGE_ACTOR`, never from the model.
- Listed in the MCP Registry as `com.brydge-ai/brydge`.

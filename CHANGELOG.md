# Changelog

## 0.2.0

A person's answer now reaches the agent. Needs BRYDGE as it runs from 2 October 2026, which the hosted service does.

- **Asking again returns a person's answer.** `brydge_supervise` with the same `idempotency_key` and the same details returns `ALLOWED` once a person has allowed the action, under the same authorization, and a refusal once they have refused it. The server's instructions and the tool's description tell the model to ask again once a person has answered.
- **A refusal reads as one.** The model is told `REFUSED. A person refused this: do not carry it out.`, not that a person is still deciding.
- **The structured result carries `settled`**: `"ALLOWED"` or `"REFUSED"` once a person has answered, otherwise `null`.
- **A replayed `ALLOWED` warns the model** not to carry out again an action it has already carried out.
- An unanswered escalation ends with what to do next, after what BRYDGE was not told.
- BRYDGE's reason starts with a capital letter.

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

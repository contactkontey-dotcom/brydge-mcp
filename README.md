# brydge-mcp

Check whether your agent's work actually happened.

This is [BRYDGE](https://www.brydge-ai.com) as an MCP server. Before an agent acts, BRYDGE decides whether it may. Afterwards, BRYDGE reads the destination system's own records, such as your payment processor or ticket system, using its own credential. It then reports whether the work happened as permitted. What the agent says happened is kept beside that finding and never decides it.

## Tools

| Tool | What it does |
| --- | --- |
| `brydge_supervise` | Asks before acting. `ALLOWED` returns an authorization id for the agent to write into the record the action creates. `ESCALATED` means a person decides, and the agent must not act. |
| `brydge_report_outcome` | Reports what the agent believes happened. |
| `brydge_verify` | Reads the destination's records now and says whether the work happened. |
| `brydge_get_finding` | Returns what BRYDGE has found so far, without reading the records again. Free. |
| `brydge_get_headroom` | Says how many actions the agent may take in any 24 hours before a person is asked. |

The server also gives the model its instructions: ask first, cite the authorization, report, then verify before saying the work is done.

## Set up BRYDGE first

Do these once, in BRYDGE:

1. **Issue an API key** on the Connect page.
2. **Declare what the action is worth.** BRYDGE charges a share of that value, and it will not check an action nobody has priced.
3. **Register a destination** for the action: where BRYDGE reads the records, and the read-only credential it uses. BRYDGE has a preset for Stripe refunds.
4. **Issue a mandate** to the agent for the action. Without one, every call goes to a person.

A mandate says what the agent may do; headroom says how much of it, in any 24 hours. A new agent starts with room for one action a day, and every report BRYDGE checks and finds true raises that.

## Add it to your MCP client

Most clients take this configuration (Claude Desktop, Cursor, Windsurf and others):

```json
{
  "mcpServers": {
    "brydge": {
      "command": "npx",
      "args": ["-y", "brydge-mcp"],
      "env": {
        "BRYDGE_API_KEY": "brydge_sk_...",
        "BRYDGE_ACTOR": "agent:refund-ops"
      }
    }
  }
}
```

In Claude Code:

```bash
claude mcp add brydge -e BRYDGE_API_KEY=brydge_sk_... -e BRYDGE_ACTOR=agent:refund-ops -- npx -y brydge-mcp
```

| Setting | |
| --- | --- |
| `BRYDGE_API_KEY` | Your BRYDGE API key. Required. |
| `BRYDGE_ACTOR` | The name BRYDGE knows this agent by, such as `agent:refund-ops`. Mandates are issued to this name. Required. |
| `BRYDGE_URL` | Where BRYDGE runs. Leave it unset for BRYDGE's hosted service. |

The agent's name comes from this configuration, never from the model, so an agent cannot borrow another agent's permissions. Run one server per agent.

## How an agent uses it

1. **Ask first.** Before a refund, payment or other change, the agent calls `brydge_supervise` with the action, the target and the facts, such as `{"amount": 4200}`.
2. **Cite the authorization.** If the answer is `ALLOWED`, the agent carries the action out and writes the authorization id where the destination keeps it. For a Stripe refund, that is `metadata.brydge_authorization`. BRYDGE finds the work by this id, and by nothing else.
3. **Report.** The agent calls `brydge_report_outcome` with what it believes happened.
4. **Verify.** Before saying the work is done, the agent calls `brydge_verify`.

`brydge_supervise` takes an `idempotency_key`, a name for one intended action such as `refund:ch_123`. Retrying with the same key gets the same answer. A key reused for a different action never gets another action's answer, because the server also hashes in what is being asked.

## What a check can find

| `state` | Meaning |
| --- | --- |
| `VERIFIED` | The records show the work, as it was permitted. |
| `FAILED` | The records show it was attempted and did not succeed. |
| `MISMATCH` | The records show something other than what was permitted. `reason` says what: `AMOUNT`, `TARGET`, `ACTOR`, `ACTION`, `DUPLICATE_EXECUTION`, `UNAUTHORISED_EXECUTION` or `CORRELATION`. |
| `UNKNOWN` | BRYDGE could not tell. `NO_MATCH` means the records hold nothing for this authorization; the other reasons mean BRYDGE could not read the records. Unknown is not the same as failed. |
| `PENDING` | The destination says the work is still in progress. |

`brydge_verify` reads the records when it is called. A check that finds something new is billed; asking again when nothing has changed is free. BRYDGE also checks every action by itself once the destination's reporting window has passed (60 minutes unless you set another), and `brydge_get_finding` reads that for free.

## Protocol

The server speaks MCP over stdio. It serves clients on the 2026-07-28 revision and on the 2025 revisions from the same process, built on the official TypeScript SDK. When BRYDGE cannot be asked (a bad key, an action with no declared value, a rate limit, or BRYDGE being unreachable), the tool returns an error the model can read, and nothing is carried out.

## Limits

- BRYDGE treats a target as one piece of work. A second record for the same target that carries a different authorization, such as a second partial refund of one charge, is reported as a `MISMATCH`.
- The server does not wait for a person. An escalated action ends with the model being told a person decides, and a later request is decided afresh.

## Development

```bash
npm install
npm test          # a real MCP client against the server in both protocol eras, and the built command over stdio
npm run test:int  # against a running BRYDGE; see tests/integration
npm run build
```

## License

MIT

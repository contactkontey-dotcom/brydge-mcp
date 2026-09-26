# Integration tests

These run a real MCP client against this server and a running BRYDGE over
HTTP. The test file starts a small books server on `localhost`, which acts as
the destination: the test writes refunds into it the way an agent would, citing
BRYDGE's authorization, and BRYDGE reads them back with its own credential.

The BRYDGE under test needs a workspace with an API key, a declared value for
`refund`, a destination for `refund` that reads
`http://localhost:<port>/transactions` with the books token as its credential,
and mandates for `agent:mcp-honest` and `agent:mcp-overpays` covering amounts
up to 10000. Because the books run on `localhost`, BRYDGE must run with
`BRYDGE_ALLOW_PRIVATE_DESTINATIONS=1`.

In the BRYDGE repository, `scripts/langchain-fixture.ts` creates that
workspace in a local database and prints the environment these tests read.
The commands are bash; on Windows, run them in Git Bash:

```bash
# in the BRYDGE repository
BRYDGE_ALLOW_PRIVATE_DESTINATIONS=1 npm run dev
BRYDGE_ALLOW_PRIVATE_DESTINATIONS=1 npx tsx --env-file=.env scripts/langchain-fixture.ts 4599 > /tmp/brydge-int.env

# in this package
set -a; . /tmp/brydge-int.env; set +a
npm run test:int
```

Without `BRYDGE_URL`, `BRYDGE_API_KEY`, `BRYDGE_TEST_BOOKS_PORT` and
`BRYDGE_TEST_BOOKS_TOKEN`, the tests are skipped.

# Backend contract fixtures

`fixtures/` is a copy of `contract/fixtures` of Aiworkpay-v2: JSON produced by the backend's own code, and checked there
(`test/contract.cjs`) so that it cannot drift from what the backend sends. `backend.contract.test.ts` parses it with this
server's schemas. To refresh: regenerate in the backend (`UPDATE_CONTRACT=1 node --test test/contract.cjs`), copy the files
here, and run the tests. `MANIFEST.json` carries a SHA-256 per file; the test below recomputes it, so a hand-edited copy is
detected.

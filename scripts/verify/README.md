# Verification tools

Run commands from the repository root unless a script explicitly says otherwise.

- `build/` — desktop packaging and version-configuration checks.
- `database/` — PostgreSQL guards, migration checks, and database acceptance tools.
- `fixtures/` — synthetic HTML/React surfaces used only by local render harnesses.
- `render/` — isolated local rendering and visual acceptance harnesses.
- `release/` — read-only release integrity checks.
- `security/` — secret scanning and protected-file/signer checks.

These tools are not production entrypoints; deployment commands remain under
`ops/deploy/`.

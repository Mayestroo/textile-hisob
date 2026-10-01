# Initial `comp_novda` SQLite import

The initial server baseline is the owner-approved, corrected SQLite database.
Import only the canonical company business tables. Do not import SQLite sync
state: in particular, do not copy `local_outbox`, `local_meta`, leases, or local
quarantine/workspace tables. `DEAD_LETTER` rows stay in the source SQLite file.
The local ticket-form table contains only transient per-model entry-form values
and is not imported. Any unsupported nonempty source field or local-only
quarantine/lease record causes preflight to fail rather than being silently
dropped.

The importer is transactional and fails closed unless PostgreSQL 16 migrations
16 and 17 are installed and every company-scoped PostgreSQL table is empty for
`comp_novda`. Dry-run is the default. `--apply` requires the source SHA-256
provided independently with `--expected-sha256`; it also verifies row counts
before commit. A second import is rejected because the destination is no longer
empty.

## Stage the source on the VPS

Create a private import directory as root and stage the SQLite file there using
the operator's approved file-transfer method. The file is mounted read-only into
the one-shot import container. Grant the container's `node` user read access:

```sh
install -d -o deploy -g deploy -m 0750 /srv/novda/import
chown 1000:1000 /srv/novda/import/comp_novda.sqlite
chmod 0400 /srv/novda/import/comp_novda.sqlite
sha256sum /srv/novda/import/comp_novda.sqlite
```

Compare that SHA-256 with the independently verified local source hash before
continuing. Never put the SQLite file in the Git checkout, a public web folder,
or a command argument.

## Dry-run, review, and import

As the `deploy` user, from `/srv/novda/repository`, after the API/PostgreSQL
images and ordered migrations are installed:

```sh
docker compose --project-name novda-prod \
  --env-file /srv/novda/secrets/compose.env \
  -f ops/deploy/compose.yaml --profile import run --rm novda-import
```

Review the `SQLITE_BASELINE_IMPORT_DRY_RUN` JSON. It must report company
`comp_novda`, SQLite schema 15, the expected source hash, and the expected row
counts. The import command is deliberately separate from normal deployment.
Only after reviewing the dry-run and verifying the target is the intended empty
Novda database, run:

```sh
docker compose --project-name novda-prod \
  --env-file /srv/novda/secrets/compose.env \
  -f ops/deploy/compose.yaml --profile import run --rm novda-import \
  --source /run/novda-import/hisob.sqlite --company-id comp_novda \
  --apply --expected-sha256 EXPECTED_SOURCE_SHA256
```

The importer opens SQLite read-only, never reads or writes `local_outbox`, and
inserts inside one PostgreSQL transaction. It aborts if any company-scoped table
already contains `comp_novda` records or if a foreign key, required column,
source hash, schema, or count check fails. Keep the original SQLite and a
PostgreSQL backup after success. Verify bootstrap counts and visibility from an
authorized `comp_novda` device before considering the deployment complete.

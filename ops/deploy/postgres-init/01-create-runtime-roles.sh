#!/usr/bin/env bash
set -Eeuo pipefail

psql --username "$POSTGRES_USER" --dbname postgres --set ON_ERROR_STOP=1 <<'PSQL'
\getenv migrator_password NOVDA_MIGRATOR_PASSWORD
\getenv app_password NOVDA_APP_PASSWORD

SELECT format(
  'CREATE ROLE novda_migrator WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION PASSWORD %L',
  :'migrator_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'novda_migrator')
\gexec
SELECT format(
  'ALTER ROLE novda_migrator WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION PASSWORD %L',
  :'migrator_password'
)
\gexec

SELECT format(
  'CREATE ROLE novda_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION PASSWORD %L',
  :'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'novda_app')
\gexec
SELECT format(
  'ALTER ROLE novda_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION PASSWORD %L',
  :'app_password'
)
\gexec

ALTER DATABASE novda_prod OWNER TO novda_migrator;
GRANT CONNECT ON DATABASE novda_prod TO novda_migrator, novda_app;
GRANT USAGE, CREATE ON SCHEMA public TO novda_migrator;
PSQL

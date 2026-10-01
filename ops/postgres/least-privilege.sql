-- Run as a DBA against the deployed database. This is read-only evidence.
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication
FROM pg_roles
WHERE rolname = 'novda_app';

SELECT table_schema, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'novda_app'
ORDER BY table_schema, table_name, privilege_type;

SELECT sequence_schema, sequence_name, privilege_type
FROM information_schema.role_usage_grants
WHERE grantee = 'novda_app'
ORDER BY sequence_schema, sequence_name, privilege_type;

-- Expected: one novda_app row with all four role flags false. Public schema
-- privileges must be absent and only application tables/sequences are granted.

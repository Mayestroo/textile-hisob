ALTER TABLE parties
  ADD COLUMN IF NOT EXISTS size_order_json JSONB;

INSERT INTO schema_migrations (version, name)
VALUES (27, 'deploy_party_size_order_migration.sql')
ON CONFLICT (version) DO NOTHING;

ALTER TABLE patta_batch_settings
  ADD COLUMN IF NOT EXISTS size_names_json JSONB;

INSERT INTO schema_migrations (version, name)
VALUES (26, 'deploy_model_batch_size_names_migration.sql')
ON CONFLICT (version) DO NOTHING;

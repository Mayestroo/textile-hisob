ALTER TABLE patta_batch_settings
  ADD COLUMN IF NOT EXISTS size_names_json JSONB;

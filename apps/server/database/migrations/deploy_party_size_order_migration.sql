ALTER TABLE parties
  ADD COLUMN IF NOT EXISTS size_order_json JSONB;

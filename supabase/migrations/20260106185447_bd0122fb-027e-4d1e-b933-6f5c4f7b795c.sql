-- Add batch_size column to campaigns table
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS batch_size INTEGER DEFAULT 50;

-- Insert default warmup batch size setting if not exists
INSERT INTO app_settings (key, value, description)
VALUES ('warmup_batch_size', '{"batchSize": 100}', 'Warmup runner batch size for parallel pair processing')
ON CONFLICT (key) DO NOTHING;
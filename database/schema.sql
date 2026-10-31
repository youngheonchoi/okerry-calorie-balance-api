-- These are the two tables agreed for the first food-registration release.
-- Existing shared_foods data is not modified or deleted by this script.
CREATE TABLE IF NOT EXISTS foods (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id TEXT NOT NULL,
  food_name TEXT COLLATE "C" NOT NULL,
  calories_kcal NUMERIC(10, 2) NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT foods_name_not_empty CHECK (length(btrim(food_name)) > 0),
  CONSTRAINT foods_calories_valid CHECK (calories_kcal BETWEEN 0 AND 10000),
  CONSTRAINT foods_quantity_valid CHECK (quantity BETWEEN 1 AND 999),
  CONSTRAINT foods_name_unique UNIQUE (food_name)
);

CREATE TABLE IF NOT EXISTS api_error_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id UUID NOT NULL,
  user_id TEXT,
  endpoint TEXT NOT NULL,
  stage TEXT NOT NULL,
  error_code TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS api_error_logs_created_at_idx ON api_error_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS api_error_logs_request_id_idx ON api_error_logs (request_id);

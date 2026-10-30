CREATE TABLE IF NOT EXISTS shared_foods (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  normalized_name VARCHAR(160) NOT NULL,
  calories INTEGER NOT NULL CHECK (calories BETWEEN 0 AND 5000),
  serving VARCHAR(40) NOT NULL DEFAULT '1회 제공량',
  contribution_count INTEGER NOT NULL DEFAULT 1 CHECK (contribution_count > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (normalized_name, serving)
);

CREATE INDEX IF NOT EXISTS shared_foods_name_idx ON shared_foods (normalized_name);

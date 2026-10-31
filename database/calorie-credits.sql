-- Already created in the user's DB; no changes to existing rows.
CREATE TABLE IF NOT EXISTS user_calorie_credits (
 user_id TEXT PRIMARY KEY,
 remaining_count INTEGER NOT NULL DEFAULT 0 CHECK (remaining_count BETWEEN 0 AND 5),
 reserved_count INTEGER NOT NULL DEFAULT 0 CHECK (reserved_count >= 0 AND reserved_count <= remaining_count),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS calorie_credit_history (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id TEXT NOT NULL REFERENCES user_calorie_credits(user_id),
 event_type TEXT NOT NULL CHECK (event_type IN ('reward','calculation')),
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
 credit_change INTEGER NOT NULL CHECK ((event_type='reward' AND credit_change=5) OR (event_type='calculation' AND credit_change=-1)),
 food_name TEXT COLLATE "C",
 result_source TEXT CHECK (result_source IN ('storage','db','ai')),
 calories_kcal NUMERIC(10,2) CHECK (calories_kcal BETWEEN 0 AND 10000),
 reserved_until TIMESTAMPTZ NOT NULL DEFAULT now() + interval '5 minutes',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 finished_at TIMESTAMPTZ,
 CHECK ((event_type='reward' AND food_name IS NULL AND result_source IS NULL AND calories_kcal IS NULL) OR (event_type='calculation' AND food_name IS NOT NULL AND length(btrim(food_name))>0)),
 CHECK (event_type<>'calculation' OR status<>'succeeded' OR (result_source IS NOT NULL AND calories_kcal IS NOT NULL)),
 CHECK ((status='pending' AND finished_at IS NULL) OR (status IN ('succeeded','failed') AND finished_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS calorie_credit_history_user_created_idx ON calorie_credit_history(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS calorie_credit_history_pending_idx ON calorie_credit_history(reserved_until) WHERE status='pending';
CREATE UNIQUE INDEX IF NOT EXISTS calorie_credit_history_pending_reward_idx ON calorie_credit_history(user_id) WHERE event_type='reward' AND status='pending';

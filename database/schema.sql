-- Baby Sleep Tracker Database Schema

CREATE TABLE IF NOT EXISTS sleep_sessions (
    id SERIAL PRIMARY KEY,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ,
    duration_minutes INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for efficient time-based queries
CREATE INDEX IF NOT EXISTS idx_sleep_sessions_start_time ON sleep_sessions (start_time);
CREATE INDEX IF NOT EXISTS idx_sleep_sessions_end_time ON sleep_sessions (end_time);

-- Trigger function to auto-calculate duration_minutes when end_time is set
CREATE OR REPLACE FUNCTION calculate_duration()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.end_time IS NOT NULL AND NEW.start_time IS NOT NULL THEN
        NEW.duration_minutes := EXTRACT(EPOCH FROM (NEW.end_time - NEW.start_time)) / 60;
    END IF;
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if it exists, then create
DROP TRIGGER IF EXISTS trg_calculate_duration ON sleep_sessions;
CREATE TRIGGER trg_calculate_duration
    BEFORE INSERT OR UPDATE ON sleep_sessions
    FOR EACH ROW
    EXECUTE FUNCTION calculate_duration();

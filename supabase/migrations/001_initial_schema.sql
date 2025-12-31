-- DotGP Backend Schema
-- Migration: 001_initial_schema
-- Description: Create core tables for replays and leaderboards

-- ============================================================================
-- DEVICES TABLE
-- Stores anonymous device identities
-- ============================================================================

CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  platform TEXT,
  user_agent TEXT
);

-- Index for cleanup queries (find stale devices)
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen_at);

-- ============================================================================
-- REPLAYS TABLE
-- Stores replay metadata (frame data stored in Supabase Storage)
-- ============================================================================

CREATE TABLE IF NOT EXISTS replays (
  id UUID PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,

  -- Track identification
  composite_seed BIGINT NOT NULL,
  track_config JSONB NOT NULL,

  -- Lap metadata
  lap_time FLOAT NOT NULL,
  sector_times FLOAT[] NOT NULL,
  player_initials VARCHAR(3) NOT NULL DEFAULT 'AAA',
  recorded_at TIMESTAMPTZ NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Driver info
  is_ai BOOLEAN NOT NULL DEFAULT false,
  agent_name TEXT,

  -- Quality metrics
  quality_score INTEGER,
  star_rating FLOAT,
  incidents JSONB DEFAULT '[]'::jsonb,
  cleanliness JSONB,
  training_weight FLOAT DEFAULT 1.0,

  -- Leaderboard eligibility
  is_leaderboard_eligible BOOLEAN NOT NULL DEFAULT false,

  -- Frame data reference (stored in Supabase Storage)
  frame_data_path TEXT,
  frame_count INTEGER NOT NULL,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Constraints
  CONSTRAINT valid_lap_time CHECK (lap_time > 0),
  CONSTRAINT valid_star_rating CHECK (star_rating IS NULL OR (star_rating >= 0 AND star_rating <= 5)),
  CONSTRAINT valid_initials CHECK (char_length(player_initials) = 3)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_replays_composite_seed ON replays(composite_seed);
CREATE INDEX IF NOT EXISTS idx_replays_device_id ON replays(device_id);
CREATE INDEX IF NOT EXISTS idx_replays_recorded_at ON replays(recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_replays_is_ai ON replays(is_ai, agent_name);

-- Partial index for leaderboard-eligible replays (most common query)
CREATE INDEX IF NOT EXISTS idx_replays_leaderboard
  ON replays(composite_seed, lap_time)
  WHERE is_leaderboard_eligible = true;

-- ============================================================================
-- LEADERBOARD_ENTRIES TABLE
-- Pre-computed leaderboard entries for fast queries
-- Auto-populated by trigger when eligible replays are created
-- ============================================================================

CREATE TABLE IF NOT EXISTS leaderboard_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  replay_id UUID NOT NULL REFERENCES replays(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,

  -- Track identification
  composite_seed BIGINT NOT NULL,

  -- Entry data (denormalized for fast queries)
  lap_time FLOAT NOT NULL,
  sector_times FLOAT[] NOT NULL,
  player_initials VARCHAR(3) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,

  -- Driver categorization
  is_ai BOOLEAN NOT NULL DEFAULT false,
  agent_name TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Ensure one entry per replay
  CONSTRAINT unique_replay_entry UNIQUE (replay_id)
);

-- Fast leaderboard queries - all entries for a track
CREATE INDEX IF NOT EXISTS idx_leaderboard_track_time
  ON leaderboard_entries(composite_seed, lap_time);

-- Human-only leaderboard
CREATE INDEX IF NOT EXISTS idx_leaderboard_track_human
  ON leaderboard_entries(composite_seed, lap_time)
  WHERE is_ai = false;

-- AI-only leaderboard
CREATE INDEX IF NOT EXISTS idx_leaderboard_track_ai
  ON leaderboard_entries(composite_seed, lap_time)
  WHERE is_ai = true;

-- Device personal bests
CREATE INDEX IF NOT EXISTS idx_leaderboard_device
  ON leaderboard_entries(device_id, composite_seed, lap_time);

-- DotGP Backend Functions
-- Migration: 003_functions
-- Description: Database functions and triggers

-- ============================================================================
-- LEADERBOARD ENTRY TRIGGER
-- Auto-populates leaderboard_entries when eligible replays are created/updated
-- ============================================================================

CREATE OR REPLACE FUNCTION update_leaderboard_entry()
RETURNS TRIGGER AS $$
BEGIN
  -- Only add to leaderboard if eligible
  IF NEW.is_leaderboard_eligible THEN
    INSERT INTO leaderboard_entries (
      replay_id,
      device_id,
      composite_seed,
      lap_time,
      sector_times,
      player_initials,
      recorded_at,
      is_ai,
      agent_name
    ) VALUES (
      NEW.id,
      NEW.device_id,
      NEW.composite_seed,
      NEW.lap_time,
      NEW.sector_times,
      NEW.player_initials,
      NEW.recorded_at,
      NEW.is_ai,
      NEW.agent_name
    )
    ON CONFLICT (replay_id) DO UPDATE SET
      lap_time = EXCLUDED.lap_time,
      sector_times = EXCLUDED.sector_times,
      player_initials = EXCLUDED.player_initials,
      recorded_at = EXCLUDED.recorded_at,
      is_ai = EXCLUDED.is_ai,
      agent_name = EXCLUDED.agent_name;
  ELSE
    -- Remove from leaderboard if no longer eligible
    DELETE FROM leaderboard_entries WHERE replay_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create the trigger
DROP TRIGGER IF EXISTS trigger_update_leaderboard ON replays;
CREATE TRIGGER trigger_update_leaderboard
  AFTER INSERT OR UPDATE ON replays
  FOR EACH ROW
  EXECUTE FUNCTION update_leaderboard_entry();

-- ============================================================================
-- GET TRACK LEADERBOARD
-- Returns ranked leaderboard entries for a track with optional filtering
-- ============================================================================

CREATE OR REPLACE FUNCTION get_track_leaderboard(
  p_composite_seed BIGINT,
  p_filter TEXT DEFAULT 'all',
  p_limit INTEGER DEFAULT 100,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  rank INTEGER,
  replay_id UUID,
  device_id UUID,
  lap_time FLOAT,
  sector_times FLOAT[],
  player_initials VARCHAR(3),
  is_ai BOOLEAN,
  agent_name TEXT,
  recorded_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    ROW_NUMBER() OVER (ORDER BY le.lap_time ASC)::INTEGER as rank,
    le.replay_id,
    le.device_id,
    le.lap_time,
    le.sector_times,
    le.player_initials,
    le.is_ai,
    le.agent_name,
    le.recorded_at
  FROM leaderboard_entries le
  WHERE le.composite_seed = p_composite_seed
    AND (
      p_filter = 'all'
      OR (p_filter = 'human' AND le.is_ai = false)
      OR (p_filter = 'ai' AND le.is_ai = true)
    )
  ORDER BY le.lap_time ASC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- GET DEVICE RANK
-- Returns the rank and total players for a device on a track
-- ============================================================================

CREATE OR REPLACE FUNCTION get_device_rank(
  p_composite_seed BIGINT,
  p_device_id UUID,
  p_filter TEXT DEFAULT 'all'
)
RETURNS TABLE (
  rank INTEGER,
  total_entries INTEGER,
  best_lap_time FLOAT
) AS $$
DECLARE
  v_best_time FLOAT;
  v_rank INTEGER;
  v_total INTEGER;
BEGIN
  -- Get best time for this device
  SELECT MIN(le.lap_time) INTO v_best_time
  FROM leaderboard_entries le
  WHERE le.composite_seed = p_composite_seed
    AND le.device_id = p_device_id
    AND (
      p_filter = 'all'
      OR (p_filter = 'human' AND le.is_ai = false)
      OR (p_filter = 'ai' AND le.is_ai = true)
    );

  IF v_best_time IS NULL THEN
    RETURN;
  END IF;

  -- Count entries with better times (for rank)
  SELECT COUNT(DISTINCT le.device_id)::INTEGER INTO v_rank
  FROM leaderboard_entries le
  WHERE le.composite_seed = p_composite_seed
    AND le.lap_time < v_best_time
    AND (
      p_filter = 'all'
      OR (p_filter = 'human' AND le.is_ai = false)
      OR (p_filter = 'ai' AND le.is_ai = true)
    );

  -- Count total unique devices
  SELECT COUNT(DISTINCT le.device_id)::INTEGER INTO v_total
  FROM leaderboard_entries le
  WHERE le.composite_seed = p_composite_seed
    AND (
      p_filter = 'all'
      OR (p_filter = 'human' AND le.is_ai = false)
      OR (p_filter = 'ai' AND le.is_ai = true)
    );

  RETURN QUERY SELECT v_rank + 1, v_total, v_best_time;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- GET TRACK STATS
-- Returns statistics for a track (total laps, unique drivers, etc.)
-- ============================================================================

CREATE OR REPLACE FUNCTION get_track_stats(p_composite_seed BIGINT)
RETURNS TABLE (
  total_replays INTEGER,
  unique_devices INTEGER,
  best_lap_time FLOAT,
  average_lap_time FLOAT,
  total_human_laps INTEGER,
  total_ai_laps INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::INTEGER as total_replays,
    COUNT(DISTINCT r.device_id)::INTEGER as unique_devices,
    MIN(r.lap_time)::FLOAT as best_lap_time,
    AVG(r.lap_time)::FLOAT as average_lap_time,
    COUNT(*) FILTER (WHERE r.is_ai = false)::INTEGER as total_human_laps,
    COUNT(*) FILTER (WHERE r.is_ai = true)::INTEGER as total_ai_laps
  FROM replays r
  WHERE r.composite_seed = p_composite_seed;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- UPDATE DEVICE LAST SEEN
-- Updates the last_seen_at timestamp for a device
-- ============================================================================

CREATE OR REPLACE FUNCTION update_device_last_seen(p_device_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE devices
  SET last_seen_at = now()
  WHERE id = p_device_id;
END;
$$ LANGUAGE plpgsql;

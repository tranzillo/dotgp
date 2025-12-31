-- DotGP Backend RLS Policies
-- Migration: 002_rls_policies
-- Description: Row Level Security policies for all tables

-- ============================================================================
-- ENABLE RLS
-- ============================================================================

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE leaderboard_entries ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- DEVICES POLICIES
-- ============================================================================

-- Anyone can register a new device (INSERT)
CREATE POLICY "Anyone can register device"
  ON devices
  FOR INSERT
  WITH CHECK (true);

-- Devices can read their own record using x-device-id header
CREATE POLICY "Device can read own record"
  ON devices
  FOR SELECT
  USING (
    id::text = coalesce(
      current_setting('request.headers', true)::json->>'x-device-id',
      ''
    )
  );

-- Devices can update their own last_seen_at
CREATE POLICY "Device can update own record"
  ON devices
  FOR UPDATE
  USING (
    id::text = coalesce(
      current_setting('request.headers', true)::json->>'x-device-id',
      ''
    )
  );

-- ============================================================================
-- REPLAYS POLICIES
-- ============================================================================

-- Devices can insert their own replays
CREATE POLICY "Device can insert own replays"
  ON replays
  FOR INSERT
  WITH CHECK (
    device_id::text = coalesce(
      current_setting('request.headers', true)::json->>'x-device-id',
      ''
    )
  );

-- Devices can update their own replays
CREATE POLICY "Device can update own replays"
  ON replays
  FOR UPDATE
  USING (
    device_id::text = coalesce(
      current_setting('request.headers', true)::json->>'x-device-id',
      ''
    )
  );

-- Devices can delete their own replays
CREATE POLICY "Device can delete own replays"
  ON replays
  FOR DELETE
  USING (
    device_id::text = coalesce(
      current_setting('request.headers', true)::json->>'x-device-id',
      ''
    )
  );

-- Anyone can read all replays (for ghost racing, leaderboards)
CREATE POLICY "Anyone can read replays"
  ON replays
  FOR SELECT
  USING (true);

-- ============================================================================
-- LEADERBOARD_ENTRIES POLICIES
-- ============================================================================

-- Leaderboard entries are read-only for clients
-- They are populated automatically by the trigger

-- Anyone can read leaderboard entries
CREATE POLICY "Anyone can read leaderboards"
  ON leaderboard_entries
  FOR SELECT
  USING (true);

-- Note: INSERT/UPDATE/DELETE are handled by the trigger function
-- which runs with SECURITY DEFINER privileges

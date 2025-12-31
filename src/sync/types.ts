/**
 * Sync Module Types
 *
 * TypeScript types for the Supabase backend sync system.
 */

import type { LapReplay } from '../replay/types';

// ============================================================================
// Database Row Types (match Supabase schema)
// ============================================================================

/**
 * Device row from the devices table.
 */
export interface DeviceRow {
  id: string;
  created_at: string;
  last_seen_at: string;
  platform: string | null;
  user_agent: string | null;
}

/**
 * Replay row from the replays table (without frame data).
 */
export interface ReplayRow {
  id: string;
  device_id: string;
  composite_seed: number;
  track_config: Record<string, unknown>;
  lap_time: number;
  sector_times: number[];
  player_initials: string;
  recorded_at: string;
  uploaded_at: string;
  is_ai: boolean;
  agent_name: string | null;
  quality_score: number | null;
  star_rating: number | null;
  incidents: unknown[];
  cleanliness: Record<string, unknown> | null;
  training_weight: number;
  is_leaderboard_eligible: boolean;
  frame_data_path: string | null;
  frame_count: number;
  created_at: string;
}

/**
 * Leaderboard entry row from the leaderboard_entries table.
 */
export interface LeaderboardEntryRow {
  id: string;
  replay_id: string;
  device_id: string;
  composite_seed: number;
  lap_time: number;
  sector_times: number[];
  player_initials: string;
  recorded_at: string;
  is_ai: boolean;
  agent_name: string | null;
  created_at: string;
}

// ============================================================================
// API Response Types
// ============================================================================

/**
 * Result from get_track_leaderboard RPC function.
 */
export interface LeaderboardRpcResult {
  rank: number;
  replay_id: string;
  device_id: string;
  lap_time: number;
  sector_times: number[];
  player_initials: string;
  is_ai: boolean;
  agent_name: string | null;
  recorded_at: string;
}

/**
 * Result from get_device_rank RPC function.
 */
export interface DeviceRankResult {
  rank: number;
  total_entries: number;
  best_lap_time: number;
}

/**
 * Result from get_track_stats RPC function.
 */
export interface TrackStatsResult {
  total_replays: number;
  unique_devices: number;
  best_lap_time: number;
  average_lap_time: number;
  total_human_laps: number;
  total_ai_laps: number;
}

// ============================================================================
// Client-Side Types
// ============================================================================

/**
 * Leaderboard entry for display in the UI.
 */
export interface LeaderboardEntry {
  rank: number;
  replayId: string;
  deviceId: string;
  lapTime: number;
  sectorTimes: number[];
  playerInitials: string;
  isAI: boolean;
  agentName?: string;
  recordedAt: Date;
  /** True if this entry belongs to the current device */
  isCurrentDevice: boolean;
}

/**
 * Filter options for leaderboard queries.
 */
export type LeaderboardFilter = 'all' | 'human' | 'ai';

/**
 * Remote replay summary (metadata only, no frames).
 */
export interface RemoteReplaySummary {
  id: string;
  deviceId: string;
  compositeSeed: number;
  lapTime: number;
  sectorTimes: number[];
  playerInitials: string;
  recordedAt: Date;
  isAI: boolean;
  agentName?: string;
  frameCount: number;
  qualityScore?: number;
  starRating?: number;
}

/**
 * Sync status for a replay.
 * Matches the syncStatus field in LapReplay.
 */
export type SyncStatus = 'local' | 'pending' | 'synced';

// ============================================================================
// Sync Queue Types
// ============================================================================

/**
 * Item in the sync queue.
 */
export interface SyncQueueItem {
  /** Unique queue item ID */
  id: string;
  /** ID of the replay to sync */
  replayId: string;
  /** Operation to perform */
  operation: 'upload' | 'delete';
  /** Number of retry attempts */
  retryCount: number;
  /** Timestamp of last attempt */
  lastAttempt: number;
  /** Error message from last failed attempt */
  error?: string;
}

/**
 * Persisted sync queue state.
 */
export interface SyncQueueState {
  version: number;
  items: SyncQueueItem[];
}

// ============================================================================
// Storage Types
// ============================================================================

/**
 * Frame data stored in Supabase Storage.
 * Compressed with gzip before upload.
 */
export interface StoredFrameData {
  /** Schema version for migrations */
  version: number;
  /** Car state at lap start */
  initialState: LapReplay['initialState'];
  /** RNG state for deterministic replay */
  rngState?: LapReplay['rngState'];
  /** Recorded action frames */
  frames: LapReplay['frames'];
}

// ============================================================================
// Event Types
// ============================================================================

/**
 * Sync status change event.
 */
export interface SyncStatusEvent {
  type: 'status_change';
  replayId: string;
  oldStatus: SyncStatus;
  newStatus: SyncStatus;
}

/**
 * Sync error event.
 */
export interface SyncErrorEvent {
  type: 'error';
  replayId: string;
  error: string;
  retryCount: number;
}

/**
 * Sync progress event.
 */
export interface SyncProgressEvent {
  type: 'progress';
  pending: number;
  synced: number;
  failed: number;
}

export type SyncEvent = SyncStatusEvent | SyncErrorEvent | SyncProgressEvent;

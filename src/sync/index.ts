/**
 * Sync Module
 *
 * Cloud synchronization for DotGP replays and leaderboards.
 * Uses Supabase for storage and PostgreSQL for metadata.
 *
 * Usage:
 *   import { backgroundSync, leaderboardService } from './sync';
 *
 *   // Start background sync on app init
 *   backgroundSync.start();
 *
 *   // Get global leaderboard
 *   const entries = await leaderboardService.getLeaderboard(compositeSeed);
 */

// Core modules
export { getSupabase, isSupabaseConfigured, getSupabaseUrl } from './SupabaseClient';
export { deviceIdentity } from './DeviceIdentity';
export { syncQueue } from './SyncQueue';
export { backgroundSync } from './BackgroundSync';

// Compression utilities
export { compressFrameData, decompressFrameData, isCompressionAvailable } from './compression';

// Services
export { replayService } from './services/ReplayService';
export { leaderboardService } from './services/LeaderboardService';

// Types
export type {
  // Database row types
  DeviceRow,
  ReplayRow,
  LeaderboardEntryRow,
  // API response types
  LeaderboardRpcResult,
  DeviceRankResult,
  TrackStatsResult,
  PopularTrackRpcResult,
  // Client-side types
  LeaderboardEntry,
  LeaderboardFilter,
  RemoteReplaySummary,
  SyncStatus,
  PopularTrack,
  // Sync queue types
  SyncQueueItem,
  SyncQueueState,
  // Storage types
  StoredFrameData,
  // Event types
  SyncEvent,
  SyncStatusEvent,
  SyncErrorEvent,
  SyncProgressEvent,
} from './types';

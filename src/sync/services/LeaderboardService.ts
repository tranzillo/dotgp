/**
 * Leaderboard Service
 *
 * Handles global leaderboard queries from Supabase.
 */

import { getSupabase, isSupabaseConfigured } from '../SupabaseClient';
import { deviceIdentity } from '../DeviceIdentity';
import type {
  LeaderboardEntry,
  LeaderboardFilter,
  LeaderboardRpcResult,
  DeviceRankResult,
  TrackStatsResult,
  PopularTrackRpcResult,
  PopularTrack,
} from '../types';

class LeaderboardServiceImpl {
  /**
   * Get global leaderboard for a track.
   *
   * @param compositeSeed - Track identifier
   * @param filter - Filter by driver type
   * @param options - Pagination options
   */
  async getLeaderboard(
    compositeSeed: number,
    filter: LeaderboardFilter = 'all',
    options: { limit?: number; offset?: number } = {}
  ): Promise<LeaderboardEntry[]> {
    if (!isSupabaseConfigured()) {
      return [];
    }

    const supabase = getSupabase();
    const deviceId = await deviceIdentity.getDeviceId();
    const { limit = 100, offset = 0 } = options;

    const { data, error } = await supabase.rpc('get_track_leaderboard', {
      p_composite_seed: compositeSeed,
      p_filter: filter,
      p_limit: limit,
      p_offset: offset,
    });

    if (error) {
      console.error('Failed to fetch leaderboard:', error);
      return [];
    }

    const results = data as LeaderboardRpcResult[];

    return results.map((entry) => ({
      rank: entry.rank,
      replayId: entry.replay_id,
      deviceId: entry.device_id,
      lapTime: entry.lap_time,
      sectorTimes: entry.sector_times,
      playerInitials: entry.player_initials,
      isAI: entry.is_ai,
      agentName: entry.agent_name ?? undefined,
      recordedAt: new Date(entry.recorded_at),
      isCurrentDevice: entry.device_id === deviceId,
    }));
  }

  /**
   * Get personal bests for current device on a track.
   *
   * @param compositeSeed - Track identifier
   * @param filter - Filter by driver type
   */
  async getPersonalBests(
    compositeSeed: number,
    filter: LeaderboardFilter = 'all'
  ): Promise<LeaderboardEntry[]> {
    if (!isSupabaseConfigured()) {
      return [];
    }

    const supabase = getSupabase();
    const deviceId = await deviceIdentity.getDeviceId();

    let query = supabase
      .from('leaderboard_entries')
      .select('*')
      .eq('composite_seed', compositeSeed)
      .eq('device_id', deviceId)
      .order('lap_time', { ascending: true });

    // Apply filter
    if (filter === 'human') {
      query = query.eq('is_ai', false);
    } else if (filter === 'ai') {
      query = query.eq('is_ai', true);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Failed to fetch personal bests:', error);
      return [];
    }

    return data.map((entry, index) => ({
      rank: index + 1, // Personal rank (not global)
      replayId: entry.replay_id,
      deviceId: entry.device_id,
      lapTime: entry.lap_time,
      sectorTimes: entry.sector_times,
      playerInitials: entry.player_initials,
      isAI: entry.is_ai,
      agentName: entry.agent_name ?? undefined,
      recordedAt: new Date(entry.recorded_at),
      isCurrentDevice: true,
    }));
  }

  /**
   * Get player's global rank on a track.
   *
   * @param compositeSeed - Track identifier
   * @param filter - Filter by driver type
   */
  async getPlayerRank(
    compositeSeed: number,
    filter: LeaderboardFilter = 'all'
  ): Promise<{ rank: number; total: number; bestTime: number } | null> {
    if (!isSupabaseConfigured()) {
      return null;
    }

    const supabase = getSupabase();
    const deviceId = await deviceIdentity.getDeviceId();

    const { data, error } = await supabase.rpc('get_device_rank', {
      p_composite_seed: compositeSeed,
      p_device_id: deviceId,
      p_filter: filter,
    });

    if (error) {
      console.error('Failed to fetch player rank:', error);
      return null;
    }

    const results = data as DeviceRankResult[];
    if (!results || results.length === 0) {
      return null;
    }

    const result = results[0];
    return {
      rank: result.rank,
      total: result.total_entries,
      bestTime: result.best_lap_time,
    };
  }

  /**
   * Get track statistics.
   *
   * @param compositeSeed - Track identifier
   */
  async getTrackStats(compositeSeed: number): Promise<TrackStatsResult | null> {
    if (!isSupabaseConfigured()) {
      return null;
    }

    const supabase = getSupabase();

    const { data, error } = await supabase.rpc('get_track_stats', {
      p_composite_seed: compositeSeed,
    });

    if (error) {
      console.error('Failed to fetch track stats:', error);
      return null;
    }

    const results = data as TrackStatsResult[];
    if (!results || results.length === 0) {
      return null;
    }

    return results[0];
  }

  /**
   * Get top N times for a track (quick query).
   *
   * @param compositeSeed - Track identifier
   * @param n - Number of times to get
   */
  async getTopTimes(compositeSeed: number, n: number = 10): Promise<LeaderboardEntry[]> {
    return this.getLeaderboard(compositeSeed, 'all', { limit: n, offset: 0 });
  }

  /**
   * Check if current device has any times on a track.
   *
   * @param compositeSeed - Track identifier
   */
  async hasTimesOnTrack(compositeSeed: number): Promise<boolean> {
    if (!isSupabaseConfigured()) {
      return false;
    }

    const supabase = getSupabase();
    const deviceId = await deviceIdentity.getDeviceId();

    const { count, error } = await supabase
      .from('leaderboard_entries')
      .select('id', { count: 'exact', head: true })
      .eq('composite_seed', compositeSeed)
      .eq('device_id', deviceId);

    if (error) {
      console.error('Failed to check device times:', error);
      return false;
    }

    return (count ?? 0) > 0;
  }

  /**
   * Get popular tracks globally (most played).
   *
   * @param limit - Maximum number of tracks to return
   */
  async getPopularTracks(limit: number = 5): Promise<PopularTrack[]> {
    if (!isSupabaseConfigured()) {
      return [];
    }

    const supabase = getSupabase();

    const { data, error } = await supabase.rpc('get_popular_tracks', {
      p_limit: limit,
    });

    if (error) {
      console.error('Failed to fetch popular tracks:', error);
      return [];
    }

    const results = data as PopularTrackRpcResult[];

    return results.map((track) => {
      const config = track.track_config as {
        baseSeed?: number;
        trackType?: string;
        sizeClass?: string;
        surfaceType?: string;
        ovalShape?: string;
      };

      return {
        compositeSeed: track.composite_seed,
        trackConfig: {
          baseSeed: config.baseSeed ?? 0,
          trackType: config.trackType ?? 'circuit',
          sizeClass: config.sizeClass ?? 'medium',
          surfaceType: config.surfaceType ?? 'asphalt',
          ovalShape: config.ovalShape,
        },
        lapCount: track.lap_count,
        uniquePlayers: track.unique_players,
        bestLapTime: track.best_lap_time,
        bestPlayerInitials: track.best_player_initials,
        bestIsAI: track.best_is_ai,
      };
    });
  }
}

// Export singleton instance
export const leaderboardService = new LeaderboardServiceImpl();

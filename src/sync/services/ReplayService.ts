/**
 * Replay Service
 *
 * Handles upload and download of replays to/from Supabase.
 * Manages both metadata (PostgreSQL) and frame data (Storage).
 */

import { getSupabase, isSupabaseConfigured } from '../SupabaseClient';
import { deviceIdentity } from '../DeviceIdentity';
import { compressFrameData, decompressFrameData } from '../compression';
import { lapReplayStorage } from '../../replay/LapReplayStorage';
import type { LapReplay } from '../../replay/types';
import type { StoredFrameData, RemoteReplaySummary, ReplayRow } from '../types';

class ReplayServiceImpl {
  /**
   * Upload a replay to Supabase.
   * Uploads frame data to Storage and metadata to the replays table.
   *
   * @param replayId - ID of the replay to upload
   * @throws Error if upload fails
   */
  async uploadReplay(replayId: string): Promise<void> {
    if (!isSupabaseConfigured()) {
      throw new Error('Supabase not configured');
    }

    // Get replay from local storage
    const replay = await lapReplayStorage.getReplay(replayId);
    if (!replay) {
      throw new Error(`Replay not found: ${replayId}`);
    }

    const supabase = getSupabase();
    const deviceId = await deviceIdentity.getDeviceId();

    // 1. Upload frame data to Storage
    const frameData: StoredFrameData = {
      version: 1,
      initialState: replay.initialState,
      rngState: replay.rngState,
      frames: replay.frames,
    };

    const compressedBlob = await compressFrameData(frameData);
    const storagePath = `${deviceId}/${replayId}.json.gz`;

    const { error: storageError } = await supabase.storage
      .from('replays')
      .upload(storagePath, compressedBlob, {
        contentType: 'application/gzip',
        upsert: true,
      });

    if (storageError) {
      throw new Error(`Failed to upload frame data: ${storageError.message}`);
    }

    // 2. Insert/update replay metadata
    const { error: dbError } = await supabase.from('replays').upsert({
      id: replayId,
      device_id: deviceId,
      composite_seed: replay.compositeSeed,
      track_config: replay.trackConfig,
      lap_time: replay.lapTime,
      sector_times: replay.sectorTimes,
      player_initials: replay.playerInitials,
      recorded_at: new Date(replay.timestamp).toISOString(),
      is_ai: replay.isAI,
      agent_name: replay.agentName || null,
      quality_score: replay.qualityScore ?? null,
      star_rating: replay.starRating,
      incidents: replay.incidents,
      cleanliness: replay.cleanliness,
      training_weight: replay.trainingWeight,
      is_leaderboard_eligible: replay.cleanliness?.isLeaderboardEligible ?? false,
      frame_data_path: storagePath,
      frame_count: replay.frames.length,
    });

    if (dbError) {
      // Try to clean up storage on metadata failure
      await supabase.storage.from('replays').remove([storagePath]);
      throw new Error(`Failed to save replay metadata: ${dbError.message}`);
    }
  }

  /**
   * Delete a remote replay.
   *
   * @param replayId - ID of the replay to delete
   */
  async deleteRemoteReplay(replayId: string): Promise<void> {
    if (!isSupabaseConfigured()) {
      throw new Error('Supabase not configured');
    }

    const supabase = getSupabase();
    const deviceId = await deviceIdentity.getDeviceId();

    // Get the replay to find storage path
    const { data: replay } = await supabase
      .from('replays')
      .select('frame_data_path')
      .eq('id', replayId)
      .single();

    // Delete from database (cascade will handle leaderboard_entries)
    const { error: dbError } = await supabase.from('replays').delete().eq('id', replayId);

    if (dbError) {
      throw new Error(`Failed to delete replay: ${dbError.message}`);
    }

    // Delete frame data from storage
    if (replay?.frame_data_path) {
      await supabase.storage.from('replays').remove([replay.frame_data_path]);
    } else {
      // Try default path
      const storagePath = `${deviceId}/${replayId}.json.gz`;
      await supabase.storage.from('replays').remove([storagePath]);
    }
  }

  /**
   * Download a replay from Supabase (including frame data).
   *
   * @param replayId - ID of the replay to download
   * @returns Full LapReplay or null if not found
   */
  async downloadReplay(replayId: string): Promise<LapReplay | null> {
    if (!isSupabaseConfigured()) {
      throw new Error('Supabase not configured');
    }

    const supabase = getSupabase();

    // Get metadata
    const { data: metadata, error: metaError } = await supabase
      .from('replays')
      .select('*')
      .eq('id', replayId)
      .single();

    if (metaError || !metadata) {
      if (metaError?.code === 'PGRST116') {
        // Not found
        return null;
      }
      throw new Error(`Failed to fetch replay metadata: ${metaError?.message}`);
    }

    const row = metadata as ReplayRow;

    // Download and decompress frame data
    if (!row.frame_data_path) {
      throw new Error('Replay has no frame data');
    }

    const { data: blob, error: storageError } = await supabase.storage
      .from('replays')
      .download(row.frame_data_path);

    if (storageError || !blob) {
      throw new Error(`Failed to download frame data: ${storageError?.message}`);
    }

    const frameData = await decompressFrameData(blob);

    // Reconstruct LapReplay
    return {
      id: row.id,
      compositeSeed: row.composite_seed,
      trackConfig: row.track_config as unknown as LapReplay['trackConfig'],
      initialState: frameData.initialState,
      rngState: frameData.rngState,
      frames: frameData.frames,
      lapTime: row.lap_time,
      sectorTimes: row.sector_times,
      playerInitials: row.player_initials,
      timestamp: new Date(row.recorded_at).getTime(),
      isAI: row.is_ai,
      agentName: row.agent_name ?? undefined,
      isTrainingData: false, // Remote replays are not marked as training data
      qualityScore: row.quality_score ?? undefined,
      sectorPerformance: undefined, // Not stored remotely
      deltaToReference: undefined,
      incidents: (row.incidents as unknown as LapReplay['incidents']) || [],
      cleanliness: row.cleanliness as unknown as LapReplay['cleanliness'],
      starRating: row.star_rating ?? 0,
      trainingWeight: row.training_weight,
      syncStatus: 'synced',
    };
  }

  /**
   * Get replay summaries for a track (without frame data).
   *
   * @param compositeSeed - Track identifier
   * @param options - Pagination options
   */
  async getReplaySummariesForTrack(
    compositeSeed: number,
    options: { limit?: number; offset?: number } = {}
  ): Promise<RemoteReplaySummary[]> {
    if (!isSupabaseConfigured()) {
      return [];
    }

    const supabase = getSupabase();
    const { limit = 100, offset = 0 } = options;

    const { data, error } = await supabase
      .from('replays')
      .select(
        `
        id, device_id, composite_seed, lap_time, sector_times, player_initials,
        recorded_at, is_ai, agent_name, frame_count, quality_score, star_rating
      `
      )
      .eq('composite_seed', compositeSeed)
      .order('lap_time', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('Failed to fetch replay summaries:', error);
      return [];
    }

    return data.map((r) => ({
      id: r.id,
      deviceId: r.device_id,
      compositeSeed: r.composite_seed,
      lapTime: r.lap_time,
      sectorTimes: r.sector_times,
      playerInitials: r.player_initials,
      recordedAt: new Date(r.recorded_at),
      isAI: r.is_ai,
      agentName: r.agent_name ?? undefined,
      frameCount: r.frame_count,
      qualityScore: r.quality_score ?? undefined,
      starRating: r.star_rating ?? undefined,
    }));
  }

  /**
   * Check if a replay exists remotely.
   *
   * @param replayId - ID to check
   */
  async replayExists(replayId: string): Promise<boolean> {
    if (!isSupabaseConfigured()) {
      return false;
    }

    const supabase = getSupabase();

    const { count, error } = await supabase
      .from('replays')
      .select('id', { count: 'exact', head: true })
      .eq('id', replayId);

    if (error) {
      console.error('Failed to check replay existence:', error);
      return false;
    }

    return (count ?? 0) > 0;
  }
}

// Export singleton instance
export const replayService = new ReplayServiceImpl();

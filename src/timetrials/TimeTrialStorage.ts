/**
 * TimeTrialStorage - localStorage abstraction for time trial records.
 *
 * Handles persistence, querying, and schema migrations for time trial data.
 */

import {
  TimeTrialData,
  TimeTrialRecord,
  TrackLeaderboard,
  TimeTrialTrackType,
  SizeClass,
  SurfaceType,
  OvalShape,
  TrackMeta,
  LeaderboardFilter,
  getTrackKey,
  parseTrackKey,
} from './types';

const STORAGE_KEY = 'dotgp_timetrials';
const CURRENT_VERSION = 1;
const DEFAULT_INITIALS = 'AAA';
const MAX_RECORDS_PER_TRACK = 100; // Limit to prevent storage bloat

export class TimeTrialStorage {
  private data: TimeTrialData;

  constructor() {
    this.data = this.load();
  }

  /**
   * Load data from localStorage, migrating if necessary.
   */
  private load(): TimeTrialData {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return this.createEmpty();
      }

      const parsed = JSON.parse(raw) as TimeTrialData;

      // Future: handle migrations based on version
      if (parsed.version < CURRENT_VERSION) {
        return this.migrate(parsed);
      }

      return parsed;
    } catch {
      console.warn('Failed to load time trial data, starting fresh');
      return this.createEmpty();
    }
  }

  /**
   * Create empty data structure.
   */
  private createEmpty(): TimeTrialData {
    return {
      version: CURRENT_VERSION,
      userInitials: DEFAULT_INITIALS,
      leaderboards: {},
    };
  }

  /**
   * Migrate old data to current version.
   */
  private migrate(data: TimeTrialData): TimeTrialData {
    // For now, just update version - add migration logic as needed
    data.version = CURRENT_VERSION;
    return data;
  }

  /**
   * Save data to localStorage.
   */
  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (e) {
      console.error('Failed to save time trial data:', e);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // User Preferences
  // ─────────────────────────────────────────────────────────────

  /**
   * Get the user's saved initials.
   */
  getUserInitials(): string {
    return this.data.userInitials;
  }

  /**
   * Set the user's initials (3 characters, uppercase).
   */
  setUserInitials(initials: string): void {
    // Sanitize: uppercase, max 3 chars, pad with A if needed
    let sanitized = initials.toUpperCase().replace(/[^A-Z]/g, '');
    if (sanitized.length > 3) {
      sanitized = sanitized.slice(0, 3);
    }
    while (sanitized.length < 3) {
      sanitized += 'A';
    }

    this.data.userInitials = sanitized;
    this.save();
  }

  // ─────────────────────────────────────────────────────────────
  // Records
  // ─────────────────────────────────────────────────────────────

  /**
   * Add a new record to a track's leaderboard.
   * Records are sorted by lap time (fastest first).
   */
  addRecord(
    seed: number,
    trackMeta: TrackMeta,
    record: TimeTrialRecord
  ): void {
    const key = getTrackKey(
      seed,
      trackMeta.type,
      trackMeta.sizeClass,
      trackMeta.surfaceType,
      trackMeta.ovalShape
    );

    // Get or create leaderboard
    let leaderboard = this.data.leaderboards[key];
    if (!leaderboard) {
      leaderboard = {
        seed,
        trackType: trackMeta.type,
        sizeClass: trackMeta.sizeClass,
        surfaceType: trackMeta.surfaceType,
        ovalShape: trackMeta.ovalShape,
        records: [],
        lapCount: 0,
      };
      this.data.leaderboards[key] = leaderboard;
    }

    // Add record
    leaderboard.records.push(record);
    leaderboard.lapCount++;

    // Sort by lap time (fastest first)
    leaderboard.records.sort((a, b) => a.lapTime - b.lapTime);

    // Trim to max records
    if (leaderboard.records.length > MAX_RECORDS_PER_TRACK) {
      leaderboard.records = leaderboard.records.slice(0, MAX_RECORDS_PER_TRACK);
    }

    this.save();
  }

  /**
   * Get the leaderboard for a specific track configuration.
   */
  getLeaderboard(
    seed: number,
    trackType: TimeTrialTrackType,
    sizeClass: SizeClass,
    surfaceType: SurfaceType,
    ovalShape: OvalShape
  ): TrackLeaderboard | null {
    const key = getTrackKey(seed, trackType, sizeClass, surfaceType, ovalShape);
    return this.data.leaderboards[key] || null;
  }

  /**
   * Get filtered leaderboard records.
   * Returns a copy of the leaderboard with records filtered by AI/human.
   */
  getLeaderboardFiltered(
    seed: number,
    trackType: TimeTrialTrackType,
    sizeClass: SizeClass,
    surfaceType: SurfaceType,
    ovalShape: OvalShape,
    filter: LeaderboardFilter
  ): TrackLeaderboard | null {
    const leaderboard = this.getLeaderboard(seed, trackType, sizeClass, surfaceType, ovalShape);

    if (!leaderboard) {
      return null;
    }

    // No filtering needed for 'all'
    if (filter === 'all') {
      return leaderboard;
    }

    // Filter records based on AI status
    const filteredRecords = leaderboard.records.filter((record) => {
      const isAI = record.isAI ?? false;
      if (filter === 'human') {
        return !isAI;
      } else {
        // filter === 'ai'
        return isAI;
      }
    });

    // Return a copy with filtered records
    return {
      ...leaderboard,
      records: filteredRecords,
    };
  }

  /**
   * Get the top (fastest) time for a track.
   */
  getTopTime(
    seed: number,
    trackType: TimeTrialTrackType,
    sizeClass: SizeClass,
    surfaceType: SurfaceType,
    ovalShape: OvalShape
  ): TimeTrialRecord | null {
    const leaderboard = this.getLeaderboard(seed, trackType, sizeClass, surfaceType, ovalShape);
    if (!leaderboard || leaderboard.records.length === 0) {
      return null;
    }
    return leaderboard.records[0];
  }

  // ─────────────────────────────────────────────────────────────
  // Popular Tracks
  // ─────────────────────────────────────────────────────────────

  /**
   * Get the most popular tracks (most laps recorded).
   */
  getPopularTracks(limit: number = 10): TrackLeaderboard[] {
    const leaderboards = Object.values(this.data.leaderboards);

    // Sort by lap count descending
    leaderboards.sort((a, b) => b.lapCount - a.lapCount);

    return leaderboards.slice(0, limit);
  }

  // ─────────────────────────────────────────────────────────────
  // Track Type Lookup
  // ─────────────────────────────────────────────────────────────

  /**
   * Find track type info for a seed that has existing records.
   * Returns the first match found (most popular if multiple types use same seed).
   */
  findTrackTypeBySeed(seed: number): { type: TimeTrialTrackType; sizeClass: SizeClass } | null {
    // Find all leaderboards with this seed
    const matches: TrackLeaderboard[] = [];

    for (const key of Object.keys(this.data.leaderboards)) {
      const parsed = parseTrackKey(key);
      if (parsed && parsed.seed === seed) {
        matches.push(this.data.leaderboards[key]);
      }
    }

    if (matches.length === 0) {
      return null;
    }

    // Return the most popular (most laps) match
    matches.sort((a, b) => b.lapCount - a.lapCount);
    const best = matches[0];

    return {
      type: best.trackType,
      sizeClass: best.sizeClass,
    };
  }

  /**
   * Get all leaderboards for a specific seed (may have multiple types).
   */
  getLeaderboardsForSeed(seed: number): TrackLeaderboard[] {
    const results: TrackLeaderboard[] = [];

    for (const key of Object.keys(this.data.leaderboards)) {
      const parsed = parseTrackKey(key);
      if (parsed && parsed.seed === seed) {
        results.push(this.data.leaderboards[key]);
      }
    }

    return results;
  }

  // ─────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────

  /**
   * Clear all time trial data (for debugging/testing).
   */
  clearAll(): void {
    this.data = this.createEmpty();
    this.save();
  }

  /**
   * Get total number of laps recorded across all tracks.
   */
  getTotalLapCount(): number {
    return Object.values(this.data.leaderboards).reduce(
      (sum, lb) => sum + lb.lapCount,
      0
    );
  }
}

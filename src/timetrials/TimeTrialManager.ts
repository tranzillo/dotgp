/**
 * TimeTrialManager - Orchestrates the time trial system.
 *
 * Connects the game, storage, and UI panel to enable:
 * - Loading tracks by seed (including composite seeds that encode all config)
 * - Recording lap times
 * - Displaying leaderboards
 * - Showing popular tracks
 */

import type { Game } from '../game/Game';
import type { Car } from '../entities/Car';
import type { LapData } from '../types';
import { TimeTrialStorage } from './TimeTrialStorage';
import { HTMLTimeTrialPanel, LeaderboardSource } from '../ui/HTMLTimeTrialPanel';
import {
  TimeTrialRecord,
  TrackMeta,
  LeaderboardFilter,
  decodeCompositeSeed,
  encodeCompositeSeed,
  FullTrackConfig,
} from './types';
import { leaderboardService, isSupabaseConfigured } from '../sync';

export class TimeTrialManager {
  private game: Game;
  private storage: TimeTrialStorage;
  private panel: HTMLTimeTrialPanel;
  private currentFilter: LeaderboardFilter = 'all';
  private currentSource: LeaderboardSource = 'local';
  private currentAgentName: string | null = null;
  private currentAgentTrainer: string | null = null;
  private onInitialsChangeExternal: ((initials: string) => void) | null = null;

  constructor(game: Game, panelContainerId: string) {
    this.game = game;
    this.storage = new TimeTrialStorage();

    // Create UI panel with callbacks
    this.panel = new HTMLTimeTrialPanel(panelContainerId, {
      onInitialsChange: (initials) => {
        this.storage.setUserInitials(initials);
        // Also update the game's lap recorder
        this.game.setPlayerInitials(initials);
        // Notify external listeners (e.g., training panel for PB recomputation)
        this.onInitialsChangeExternal?.(initials);
      },
      onPopularTrackClick: (compositeSeed: number) => {
        const config = decodeCompositeSeed(compositeSeed);
        this.loadTrack(config);
      },
      onFilterChange: (filter) => {
        this.currentFilter = filter;
        this.updateLeaderboard();
      },
      onSourceChange: (source) => {
        this.currentSource = source;
        this.updateLeaderboard();
      },
    });

    // Initialize panel and game with stored initials
    const storedInitials = this.storage.getUserInitials();
    this.panel.setInitials(storedInitials);
    this.game.setPlayerInitials(storedInitials);

    // Update popular tracks list
    this.updatePopularTracks();

    // Hook into lap completion
    this.game.setLapCompleteCallback((car, lapData) => {
      this.onLapComplete(car, lapData);
    });

    // Note: Lap recording now starts when player first moves (triggered in Game.ts)
  }

  /**
   * Load a track with full configuration.
   */
  loadTrack(config: FullTrackConfig): void {
    // Load the track with full config
    this.game.loadTrackFromSeed(
      config.baseSeed,
      config.trackType,
      config.sizeClass,
      config.surfaceType,
      config.ovalShape
    );

    // Note: Lap recording starts when player first moves (triggered in Game.ts)

    // Update leaderboard for the new track
    this.updateLeaderboard();
  }

  /**
   * Handle lap completion - record to storage.
   * All completed laps are saved for training (with quality scoring).
   * Only valid (clean) laps are eligible for leaderboard.
   */
  private async onLapComplete(_car: Car, lapData: LapData): Promise<void> {
    console.log('[DEBUG] TimeTrialManager.onLapComplete called:', { isValid: lapData.isValid, totalTime: lapData.totalTime });

    // Skip if in replay mode
    if (this.game.isReplayMode()) {
      console.log('[DEBUG] Skipping - in replay mode');
      return;
    }

    const sectorTimes = lapData.sectorTimes
      .sort((a, b) => a.sectorIndex - b.sectorIndex)
      .map((s) => s.time);

    // Always save replay for ALL completed laps (training data)
    // The replay includes incident tracking and quality scoring
    // Invalid laps have lower training weight but are still useful for recovery learning
    const isAI = this.game.isAIMode();
    const agentName = isAI ? this.game.getAgentName() : undefined;
    const replay = await this.game.completeLapRecording(lapData.totalTime, sectorTimes, isAI, agentName);

    if (replay) {
      const validityStr = lapData.isValid ? 'valid' : 'invalid';
      const starStr = replay.starRating !== undefined ? ` ⭐${replay.starRating}` : '';
      console.log(`Lap saved for training (${validityStr}${starStr}): ${lapData.totalTime.toFixed(2)}s`);
    }

    // Start recording next lap
    this.game.startLapRecording();

    // Skip time trial record for invalid laps (leaderboard only shows clean laps)
    if (!lapData.isValid) {
      console.log('Lap invalid (off-track), not added to leaderboard');
      return;
    }

    // Create record with full track config
    const config = this.game.getFullTrackConfig();
    const trackMeta: TrackMeta = {
      type: config.trackType,
      sizeClass: config.sizeClass,
      surfaceType: config.surfaceType,
      ovalShape: config.ovalShape,
    };

    // isAI was already determined above for replay recording

    const record: TimeTrialRecord = {
      id: crypto.randomUUID(),
      initials: this.storage.getUserInitials(),
      lapTime: lapData.totalTime,
      sectorTimes: lapData.sectorTimes
        .sort((a, b) => a.sectorIndex - b.sectorIndex)
        .map((s) => s.time),
      timestamp: Date.now(),
      trackMeta,
      // AI-specific fields
      isAI,
      agentName: isAI ? this.currentAgentName ?? undefined : undefined,
      trainedBy: isAI ? this.currentAgentTrainer ?? this.storage.getUserInitials() : undefined,
    };

    // Add to storage
    const seed = this.game.getTrackSeed();
    this.storage.addRecord(seed, trackMeta, record);

    const prefix = isAI ? '[AI] ' : '';
    console.log(
      `${prefix}Recorded lap: ${this.formatTime(lapData.totalTime)} by ${record.initials}`
    );

    // Update agent profile stats for AI laps
    if (isAI) {
      const trainingManager = this.game.getTrainingManager();
      if (trainingManager) {
        await trainingManager.recordAILapCompletion(lapData.totalTime);
      }
    }

    // Update UI
    this.updateLeaderboard();
    this.updatePopularTracks();

    // Highlight new record in panel
    this.panel.highlightNewRecord(record);
  }

  /**
   * Called when the track changes externally (keyboard shortcut, tracks panel).
   * Updates the leaderboard for the new track.
   */
  onTrackChange(): void {
    this.updateLeaderboard();
  }

  /**
   * Update the leaderboard display for the current track.
   */
  private updateLeaderboard(): void {
    if (this.currentSource === 'global') {
      this.updateGlobalLeaderboard();
    } else {
      this.updateLocalLeaderboard();
    }
  }

  /**
   * Update leaderboard with local records.
   */
  private updateLocalLeaderboard(): void {
    const config = this.game.getFullTrackConfig();
    const leaderboard = this.storage.getLeaderboardFiltered(
      config.baseSeed,
      config.trackType,
      config.sizeClass,
      config.surfaceType,
      config.ovalShape,
      this.currentFilter
    );
    this.panel.setLeaderboard(leaderboard);
    this.panel.setPlayerRank(null); // Hide rank for local view
  }

  /**
   * Update leaderboard with global records from cloud.
   */
  private async updateGlobalLeaderboard(): Promise<void> {
    if (!isSupabaseConfigured()) {
      this.panel.setGlobalLeaderboard([]);
      return;
    }

    const config = this.game.getFullTrackConfig();
    const compositeSeed = encodeCompositeSeed(config);

    // Show loading state
    this.panel.setGlobalLeaderboardLoading(true);

    try {
      // Fetch global leaderboard and player rank in parallel
      const [entries, playerRank] = await Promise.all([
        leaderboardService.getLeaderboard(compositeSeed, this.currentFilter, { limit: 10 }),
        leaderboardService.getPlayerRank(compositeSeed, this.currentFilter),
      ]);

      this.panel.setGlobalLeaderboard(entries);
      this.panel.setPlayerRank(playerRank);
    } catch (error) {
      console.error('Failed to fetch global leaderboard:', error);
      this.panel.setGlobalLeaderboard([]);
      this.panel.setPlayerRank(null);
    }
  }

  /**
   * Update the popular tracks list.
   */
  private updatePopularTracks(): void {
    const popular = this.storage.getPopularTracks(5);
    this.panel.setPopularTracks(popular);
  }

  /**
   * Format time as MM:SS.mmm
   */
  private formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toFixed(3).padStart(6, '0')}`;
  }

  /**
   * Get the storage instance (for debugging).
   */
  getStorage(): TimeTrialStorage {
    return this.storage;
  }

  /**
   * Get the panel instance (for debugging).
   */
  getPanel(): HTMLTimeTrialPanel {
    return this.panel;
  }

  // ─────────────────────────────────────────────────────────────
  // AI / Filter Management
  // ─────────────────────────────────────────────────────────────

  /**
   * Set the current leaderboard filter.
   */
  setFilter(filter: LeaderboardFilter): void {
    this.currentFilter = filter;
    this.updateLeaderboard();
  }

  /**
   * Get the current filter.
   */
  getFilter(): LeaderboardFilter {
    return this.currentFilter;
  }

  /**
   * Set info for the currently active AI agent.
   * Call this when activating an AI agent for time trials.
   */
  setCurrentAgentInfo(agentName: string | null, trainedBy?: string): void {
    this.currentAgentName = agentName;
    this.currentAgentTrainer = trainedBy ?? this.storage.getUserInitials();
  }

  /**
   * Clear current agent info.
   */
  clearCurrentAgentInfo(): void {
    this.currentAgentName = null;
    this.currentAgentTrainer = null;
  }

  /**
   * Set external callback for initials changes.
   * Used by training panel to recompute personal bests.
   */
  setOnInitialsChange(callback: (initials: string) => void): void {
    this.onInitialsChangeExternal = callback;
  }

  /**
   * Refresh the leaderboard (public method for external use).
   */
  refreshLeaderboard(): void {
    this.updateLeaderboard();
  }

  /**
   * Get the current leaderboard source.
   */
  getSource(): LeaderboardSource {
    return this.currentSource;
  }
}

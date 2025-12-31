/**
 * LapReplayRecorder - Always-on recorder for lap replays.
 *
 * Records player/AI inputs during every lap.
 * When a valid lap is completed, saves the replay to storage.
 * Lightweight: only records actions, not observations.
 * Auto-computes quality score on save for SIL lap evaluation.
 */

import type { Action } from '../ai/types';
import type { FullTrackConfig } from '../timetrials/types';
import { encodeCompositeSeed } from '../timetrials/types';
import type { CarInitialState, LapReplay, ReplayFrame, RngState, SectorPerformance, LapIncident, LapCleanlinessFlags } from './types';
import { lapReplayStorage } from './LapReplayStorage';
import { getDefaultLapEvaluator } from '../ai/LapEvaluator';
import { getGlobalRngState } from '../utils/SeededRandom';
import { CONFIG } from '../utils/Constants';
import { syncQueue } from '../sync/SyncQueue';
import { isSupabaseConfigured } from '../sync/SupabaseClient';

export class LapReplayRecorder {
  private currentFrames: ReplayFrame[] = [];
  private currentTrackConfig: FullTrackConfig | null = null;
  private currentInitialState: CarInitialState | null = null;
  private currentRngState: RngState | null = null;
  private stepCounter: number = 0;
  private playerInitials: string = 'AAA';
  private referenceBestLapTime: number = Infinity;
  private referenceBestSectorTimes: number[] = [Infinity, Infinity, Infinity];

  // Incident tracking
  private incidents: LapIncident[] = [];
  private isCurrentlyOffTrack: boolean = false;
  private offTrackStartFrame: number = 0;
  private offTrackStartPosition: { x: number; y: number } | null = null;

  /**
   * Start recording a new lap.
   * Called when car crosses start line or resets.
   * @param trackConfig Full track configuration
   * @param initialState Car state at lap start (position, velocity, resources)
   * @param agentRngState Optional agent RNG state for AI laps
   */
  startLap(trackConfig: FullTrackConfig, initialState: CarInitialState, agentRngState?: number): void {
    this.currentFrames = [];
    this.currentTrackConfig = trackConfig;
    this.currentInitialState = initialState;
    // Capture RNG state at lap start for deterministic replay
    this.currentRngState = {
      globalRngState: getGlobalRngState(),
      agentRngState,
    };
    this.stepCounter = 0;

    // Reset incident tracking
    this.incidents = [];
    this.isCurrentlyOffTrack = false;
    this.offTrackStartFrame = 0;
    this.offTrackStartPosition = null;
  }

  /**
   * Record a single frame of input with optional observation.
   * Called every game update.
   */
  recordFrame(action: Action, observation?: number[]): void {
    this.currentFrames.push({
      step: this.stepCounter++,
      action: { x: action.x, y: action.y },
      observation,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Incident Tracking
  // ─────────────────────────────────────────────────────────────

  /**
   * Record the start of an off-track event.
   * Called when car transitions from on-track to off-track.
   */
  startOffTrack(position: { x: number; y: number }): void {
    if (!this.isCurrentlyOffTrack && this.isRecording()) {
      this.isCurrentlyOffTrack = true;
      this.offTrackStartFrame = this.currentFrames.length;
      this.offTrackStartPosition = { ...position };
    }
  }

  /**
   * Record the end of an off-track event and calculate severity.
   * Severity is based on duration (frames off track / 120 frames = 2 seconds max).
   * Called when car returns to track.
   */
  endOffTrack(): void {
    if (this.isCurrentlyOffTrack && this.offTrackStartPosition) {
      const duration = this.currentFrames.length - this.offTrackStartFrame;
      // Severity: 2 seconds (120 frames at 60fps) = max severity 1.0
      const severity = Math.min(1, duration / 120);

      this.incidents.push({
        frame: this.offTrackStartFrame,
        type: 'off_track',
        severity,
        position: this.offTrackStartPosition,
      });

      this.isCurrentlyOffTrack = false;
      this.offTrackStartPosition = null;
    }
  }

  /**
   * Record a wall collision incident.
   * Severity is based on impact speed relative to max collision speed.
   */
  recordCollision(position: { x: number; y: number }, impactSpeed: number): void {
    if (this.isRecording()) {
      const severity = Math.min(1, impactSpeed / CONFIG.MAX_COLLISION_SPEED);

      this.incidents.push({
        frame: this.currentFrames.length,
        type: 'wall_collision',
        severity,
        position: { ...position },
      });
    }
  }

  /**
   * Build cleanliness flags from recorded incidents.
   */
  private buildCleanlinessFlags(): LapCleanlinessFlags {
    const hasOffTrack = this.incidents.some(i => i.type === 'off_track');
    const hasCollisions = this.incidents.some(i => i.type === 'wall_collision');

    return {
      isComplete: true,
      isClean: !hasOffTrack,
      noCollisions: !hasCollisions,
      // Only clean laps (no off-track) are leaderboard eligible
      isLeaderboardEligible: !hasOffTrack,
    };
  }

  /**
   * Calculate star rating based on incidents.
   * 5 stars = perfect, deductions for incidents.
   * - Off-track: -0.5 × severity per incident
   * - Collision: -1.0 × severity per incident
   */
  private calculateStarRating(): number {
    let stars = 5.0;

    for (const incident of this.incidents) {
      if (incident.type === 'off_track') {
        stars -= 0.5 * incident.severity;
      } else if (incident.type === 'wall_collision') {
        stars -= 1.0 * incident.severity;
      }
    }

    // Round to nearest 0.5, clamp to 0-5
    return Math.max(0, Math.round(stars * 2) / 2);
  }

  /**
   * Calculate training weight based on star rating.
   * 5 stars = 1.0 (full weight), 0 stars = 0.3 (still useful for recovery learning).
   */
  private calculateTrainingWeight(): number {
    const stars = this.calculateStarRating();
    // Linear mapping: 5 stars = 1.0, 0 stars = 0.3
    return 0.3 + (stars / 5) * 0.7;
  }

  /**
   * Complete the current lap and save to storage.
   * Returns the saved replay, or null if save failed.
   */
  async completeLap(
    lapTime: number,
    sectorTimes: number[],
    isAI: boolean,
    agentName?: string
  ): Promise<LapReplay | null> {
    if (!this.currentTrackConfig || this.currentFrames.length === 0) {
      return null;
    }

    // Build sector performance data
    const sectorPerformance: SectorPerformance[] = sectorTimes.map((time, i) => {
      const delta = time - this.referenceBestSectorTimes[i];
      const isPersonalBest = time < this.referenceBestSectorTimes[i];

      // Update reference if this is a new best
      if (isPersonalBest) {
        this.referenceBestSectorTimes[i] = time;
      }

      return {
        time,
        deltaToReference: this.referenceBestSectorTimes[i] === Infinity ? 0 : delta,
        isPersonalBest,
      };
    });

    // Calculate delta to reference lap time
    const deltaToReference =
      this.referenceBestLapTime === Infinity ? 0 : lapTime - this.referenceBestLapTime;

    // Update reference best lap time
    if (lapTime < this.referenceBestLapTime) {
      this.referenceBestLapTime = lapTime;
    }

    // If still off-track at lap end, close the incident
    if (this.isCurrentlyOffTrack) {
      this.endOffTrack();
    }

    // Build cleanliness and quality metrics
    const cleanliness = this.buildCleanlinessFlags();
    const starRating = this.calculateStarRating();
    const trainingWeight = this.calculateTrainingWeight();

    const replay: LapReplay = {
      id: crypto.randomUUID(),
      compositeSeed: encodeCompositeSeed(this.currentTrackConfig),
      trackConfig: { ...this.currentTrackConfig },
      initialState: this.currentInitialState ?? undefined,
      rngState: this.currentRngState ?? undefined,
      frames: [...this.currentFrames],
      lapTime,
      sectorTimes,
      playerInitials: this.playerInitials,
      timestamp: Date.now(),
      isAI,
      agentName: isAI ? agentName : undefined,
      isTrainingData: false,
      syncStatus: 'local',
      sectorPerformance,
      deltaToReference,
      // Incident tracking fields
      incidents: [...this.incidents],
      cleanliness,
      starRating,
      trainingWeight,
    };

    // Compute quality score using LapEvaluator
    const evaluator = getDefaultLapEvaluator();
    evaluator.setBestLapTime(this.referenceBestLapTime);
    evaluator.setBestSectorTimes(this.referenceBestSectorTimes);
    replay.qualityScore = evaluator.computeAndGetScore(replay);

    try {
      await lapReplayStorage.saveReplay(replay);
      console.log(
        `Replay saved: ${lapTime.toFixed(2)}s, ${replay.frames.length} frames, quality: ${replay.qualityScore}`
      );

      // Queue for cloud sync if Supabase is configured
      if (isSupabaseConfigured() && navigator.onLine) {
        // Set status to pending and queue for upload
        replay.syncStatus = 'pending';
        await lapReplayStorage.updateSyncStatus(replay.id, 'pending');
        syncQueue.enqueue(replay.id, 'upload').catch((err) => {
          console.warn('Failed to queue replay for sync:', err);
        });
      }

      return replay;
    } catch (error) {
      console.error('Failed to save replay:', error);
      return null;
    }
  }

  /**
   * Discard the current lap recording.
   * Called when car resets mid-lap (NOT for completed invalid laps).
   */
  discardLap(): void {
    this.currentFrames = [];
    this.currentTrackConfig = null;
    this.currentInitialState = null;
    this.currentRngState = null;
    this.stepCounter = 0;

    // Reset incident tracking
    this.incidents = [];
    this.isCurrentlyOffTrack = false;
    this.offTrackStartFrame = 0;
    this.offTrackStartPosition = null;
  }

  /**
   * Set the player initials for recordings.
   */
  setPlayerInitials(initials: string): void {
    this.playerInitials = initials.toUpperCase().slice(0, 3);
  }

  /**
   * Get current frame count (for display).
   */
  getCurrentFrameCount(): number {
    return this.currentFrames.length;
  }

  /**
   * Check if currently recording.
   */
  isRecording(): boolean {
    return this.currentTrackConfig !== null;
  }

  /**
   * Set reference best times for quality scoring.
   * Should be called when loading existing replays for a track.
   */
  setReferenceTimes(bestLapTime: number, bestSectorTimes: number[]): void {
    this.referenceBestLapTime = bestLapTime;
    this.referenceBestSectorTimes = [...bestSectorTimes];

    // Also update the LapEvaluator
    const evaluator = getDefaultLapEvaluator();
    evaluator.setBestLapTime(bestLapTime);
    evaluator.setBestSectorTimes(bestSectorTimes);
  }

  /**
   * Reset reference times (called when track changes).
   */
  resetReferenceTimes(): void {
    this.referenceBestLapTime = Infinity;
    this.referenceBestSectorTimes = [Infinity, Infinity, Infinity];
  }

  /**
   * Get current reference best lap time.
   */
  getReferenceBestLapTime(): number {
    return this.referenceBestLapTime;
  }

  /**
   * Get current reference best sector times.
   */
  getReferenceBestSectorTimes(): number[] {
    return [...this.referenceBestSectorTimes];
  }
}

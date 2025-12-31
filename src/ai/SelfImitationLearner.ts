/**
 * SelfImitationLearner - Instant autonomous agent improvement through self-play.
 *
 * Instant SIL flow:
 * 1. Agent drives laps autonomously
 * 2. Each good lap is immediately added to buffer and trained on
 * 3. Agent improves continuously in real-time
 *
 * Key feature: Trains immediately after each good lap (~50-100ms).
 * No batching, no cycles - seamless "idle game" experience.
 */

import type { ActorCriticAgent } from './ActorCriticAgent';
import type { SILConfig, SILSession } from './AgentProfile';
import { DEFAULT_SIL_CONFIG } from './AgentProfile';
import { LapEvaluator, type LapQualityScore } from './LapEvaluator';
import type { LapReplay } from '../replay/types';
import { lapReplayStorage } from '../replay/LapReplayStorage';
import { PlayerDemoTrainer } from './PlayerDemoTrainer';

/**
 * Callbacks for SIL events.
 */
export interface SILCallbacks {
  /** Called when a good lap is collected and added to buffer */
  onLapCollected?: (lap: LapReplay, score: LapQualityScore) => void;
  /** Called when agent improves (new session best lap time) */
  onImprovement?: (oldBest: number, newBest: number) => void;
  /** Called when SIL session ends */
  onSessionEnd?: (session: SILSession) => void;
}

export class SelfImitationLearner {
  private config: SILConfig;
  private agent: ActorCriticAgent;
  private lapEvaluator: LapEvaluator;
  private callbacks: SILCallbacks;

  // State
  private isRunning: boolean = false;
  private session: SILSession | null = null;
  private collectedLaps: LapReplay[] = [];
  private isTrainingInProgress: boolean = false;

  // Track context
  private compositeSeed: number = 0;

  constructor(
    agent: ActorCriticAgent,
    config: Partial<SILConfig> = {},
    callbacks: SILCallbacks = {}
  ) {
    this.agent = agent;
    this.config = { ...DEFAULT_SIL_CONFIG, ...config };
    this.callbacks = callbacks;
    this.lapEvaluator = new LapEvaluator();
  }

  /**
   * Start a SIL session for a specific track.
   * Call this once to begin, then use onLapComplete to feed laps.
   */
  start(compositeSeed: number, agentBestLapTime?: number): void {
    if (this.isRunning) {
      console.warn('SIL session already running');
      return;
    }

    this.compositeSeed = compositeSeed;
    this.isRunning = true;
    this.collectedLaps = [];

    // Set up evaluator with agent's best time if available
    if (agentBestLapTime) {
      this.lapEvaluator.setAgentBestLapTime(agentBestLapTime);
    }

    // Create session with clear session vs all-time separation
    this.session = {
      id: `sil-${Date.now()}`,
      startTime: Date.now(),

      // Session-specific (starts at 0)
      sessionLapsCompleted: 0,
      sessionGoodLaps: 0,
      sessionBestLapTime: null,
      sessionTrainingUpdates: 0,

      // Training data stats (will be set after loadSelectedLaps)
      selectedLapCount: 0,
      sessionAutoAdded: 0,

      // All-time
      allTimeBestLapTime: agentBestLapTime ?? null,

      isActive: true,
    };

    console.log(`SIL: Instant learning started for track ${compositeSeed}`);
    console.log(`SIL: Quality threshold ${this.config.qualityThreshold}, ${this.config.epochsPerLap} epochs/lap`);
  }

  /**
   * Stop the SIL session.
   */
  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.session) {
      this.session.isActive = false;
      this.callbacks.onSessionEnd?.(this.session);
    }

    console.log(`SIL: Session stopped. ${this.session?.sessionTrainingUpdates ?? 0} training updates performed.`);
  }

  /**
   * Check if SIL session is active.
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Check if currently training.
   */
  isTraining(): boolean {
    return this.isTrainingInProgress;
  }

  /**
   * Get current session info.
   */
  getSession(): SILSession | null {
    return this.session;
  }

  /**
   * Called when agent completes a lap.
   * If lap is good enough, auto-marks as training data and trains immediately.
   */
  async onLapComplete(lap: LapReplay): Promise<void> {
    if (!this.isRunning || !this.session) return;

    // Only accept laps for our track
    if (lap.compositeSeed !== this.compositeSeed) return;

    // Track session lap count
    this.session.sessionLapsCompleted++;

    // Score the lap
    const score = this.lapEvaluator.evaluate(lap);

    // Check for session best improvement
    if (this.session.sessionBestLapTime === null || lap.lapTime < this.session.sessionBestLapTime) {
      const oldBest = this.session.sessionBestLapTime;
      this.session.sessionBestLapTime = lap.lapTime;

      if (oldBest !== null) {
        this.callbacks.onImprovement?.(oldBest, lap.lapTime);
      }
    }

    // Update all-time best if this beats it
    if (this.session.allTimeBestLapTime === null || lap.lapTime < this.session.allTimeBestLapTime) {
      this.session.allTimeBestLapTime = lap.lapTime;
      this.lapEvaluator.setBestLapTime(lap.lapTime);
    }

    // Only train on good laps
    if (score.overall < this.config.qualityThreshold) {
      return;
    }

    // Auto-mark lap as training data (adds checkbox in UI)
    await lapReplayStorage.setTrainingData(lap.id, true);

    // Track session stats
    this.session.sessionGoodLaps++;
    this.session.sessionAutoAdded++;
    this.session.selectedLapCount++;

    // Notify UI (will refresh to show new checkbox)
    this.callbacks.onLapCollected?.(lap, score);

    // Train on JUST this new lap (not entire buffer)
    await this.trainOnSingleLap(lap);

    // Check stop conditions
    if (this.shouldStop()) {
      this.stop();
    }
  }

  /**
   * Train on a single new lap.
   * Fast training (~10-50ms) - no frame drops.
   */
  private async trainOnSingleLap(lap: LapReplay): Promise<void> {
    if (this.isTrainingInProgress) {
      // Skip if already training - lap is already marked as training data
      console.log('SIL: Training in progress, skipping this lap');
      return;
    }

    this.isTrainingInProgress = true;

    try {
      // Quick BC update on just this lap
      const trainer = new PlayerDemoTrainer({
        epochs: this.config.epochsPerLap,
        batchSize: 32,
        shuffle: true,
        logEvery: 0, // Silent - no logging per epoch
      });

      await trainer.trainWithLapIds([lap.id], this.agent);

      if (this.session) {
        this.session.sessionTrainingUpdates++;
      }
    } catch (error) {
      console.error('SIL: Training failed:', error);
    } finally {
      this.isTrainingInProgress = false;
    }
  }

  /**
   * Check if SIL should stop based on config.
   */
  private shouldStop(): boolean {
    // Target lap time achieved
    if (
      this.config.targetLapTime !== null &&
      this.session !== null &&
      this.session.sessionBestLapTime !== null &&
      this.session.sessionBestLapTime <= this.config.targetLapTime
    ) {
      console.log(`SIL: Target lap time ${this.config.targetLapTime}s achieved, stopping`);
      return true;
    }

    return false;
  }

  /**
   * Load user-selected laps (isTrainingData=true) for this track.
   * Call this after start() to initialize with user's curated selection.
   */
  async loadSelectedLaps(): Promise<number> {
    // Get all laps for this track that are marked as training data
    const allLaps = await lapReplayStorage.getReplaysForTrack(this.compositeSeed);
    const selectedLaps = allLaps.filter((lap) => lap.isTrainingData);

    // Sort by quality and take top N
    selectedLaps.sort((a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0));
    this.collectedLaps = selectedLaps.slice(0, this.config.maxLapsToKeep);

    // Update best lap time reference from loaded laps
    if (this.collectedLaps.length > 0) {
      const bestTime = Math.min(...this.collectedLaps.map((l) => l.lapTime));
      this.lapEvaluator.setBestLapTime(bestTime);

      // Update all-time best if loaded laps have a better time
      if (this.session && (this.session.allTimeBestLapTime === null || bestTime < this.session.allTimeBestLapTime)) {
        this.session.allTimeBestLapTime = bestTime;
      }
    }

    // Update selected lap count
    if (this.session) {
      this.session.selectedLapCount = this.collectedLaps.length;
    }

    console.log(`SIL: Loaded ${this.collectedLaps.length} user-selected laps`);
    return this.collectedLaps.length;
  }

  /**
   * Get collected lap count (buffer size).
   */
  getCollectedLapCount(): number {
    return this.collectedLaps.length;
  }
}

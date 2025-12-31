/**
 * Player Demonstration Types
 *
 * Data structures for recording player demonstrations used in behavior cloning.
 * Demonstrations capture observation-action pairs that teach AI agents to drive.
 */

import type { Action } from './types';
import type { FullTrackConfig } from '../timetrials/types';

/**
 * A single frame of player demonstration.
 * Contains both the observation (what the agent sees) and action (what the player did).
 */
export interface DemonstrationFrame {
  /** Frame number within the lap */
  step: number;
  /** 20-feature observation vector from ObservationBuilder */
  observation: number[];
  /** Player input at this frame: x (-1 to 1), y (-1 to 1) */
  action: Action;
}

/**
 * A complete player demonstration representing one lap.
 * Only valid (clean) laps should be saved for training.
 */
export interface PlayerDemonstration {
  /** Unique identifier (crypto.randomUUID()) */
  id: string;
  /** Player's 3-letter initials */
  playerInitials: string;
  /** Full track configuration including composite seed */
  trackConfig: FullTrackConfig;
  /** Composite seed for quick indexing (derived from trackConfig) */
  compositeSeed: number;
  /** Recorded frames for this lap */
  frames: DemonstrationFrame[];
  /** Total lap time in seconds */
  lapTime: number;
  /** Sector times [S1, S2, S3] in seconds */
  sectorTimes: number[];
  /** Unix timestamp when recorded */
  timestamp: number;
  /** Whether the lap was valid (no off-track incidents) */
  isValid: boolean;
}

/**
 * Summary info for displaying demos in UI (without full frame data).
 */
export interface DemonstrationSummary {
  id: string;
  playerInitials: string;
  compositeSeed: number;
  lapTime: number;
  sectorTimes: number[];
  timestamp: number;
  frameCount: number;
}

/**
 * Configuration for training from player demonstrations.
 */
export interface PlayerDemoTrainingConfig {
  /** Batch size for supervised learning. Default: 64 */
  batchSize: number;
  /** Number of training epochs. Default: 100 */
  epochs: number;
  /** Shuffle data between epochs. Default: true */
  shuffle: boolean;
  /** Log progress every N epochs. Default: 10 */
  logEvery: number;
}

export const DEFAULT_DEMO_TRAINING_CONFIG: PlayerDemoTrainingConfig = {
  batchSize: 64,
  epochs: 100,
  shuffle: true,
  logEvery: 10,
};

/**
 * Callbacks for training progress.
 */
export interface DemoTrainingCallbacks {
  onEpoch?: (epoch: number, loss: number) => void;
  onComplete?: (finalLoss: number, avgLoss: number) => void;
}

/**
 * Stats returned after training completes.
 */
export interface DemoTrainingStats {
  finalLoss: number;
  avgLoss: number;
  epochLosses: number[];
  totalSamples: number;
  demonstrationsUsed: number;
}

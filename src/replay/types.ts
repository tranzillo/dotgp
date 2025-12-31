/**
 * Lap Replay Types
 *
 * Data structures for recording and playing back lap replays.
 * Replays are lightweight (actions only) and can be converted to training data on-demand.
 */

import type { Action } from '../ai/types';
import type { FullTrackConfig } from '../timetrials/types';

/**
 * Serializable car state at the start of a lap.
 * Used to restore exact physics state for replay playback.
 */
export interface CarInitialState {
  /** Car position at lap start */
  position: { x: number; y: number };
  /** Car velocity at lap start */
  velocity: { x: number; y: number };
  /** Car heading angle (radians) at lap start */
  angle: number;
  /** Fuel level (0-100) */
  fuel: number;
  /** Grip level (0-1) */
  grip: number;
  /** Heat level (0-1) */
  heat: number;
}

/**
 * Serializable RNG state for a single SeededRandom instance.
 */
export interface SeededRngState {
  /** Initial seed */
  seed: number;
  /** Current internal state */
  state: number;
}

/**
 * RNG state for deterministic replay.
 * Captures the state of all seeded RNGs at lap start.
 */
export interface RngState {
  /** Global RNG state */
  globalRngState: SeededRngState | null;
  /** Agent RNG state (if AI lap) */
  agentRngState?: number;
}

/**
 * Performance data for a single sector.
 */
export interface SectorPerformance {
  /** Sector time in seconds */
  time: number;
  /** Delta to reference (e.g., session best). Negative = faster */
  deltaToReference: number;
  /** Whether this was a personal best for this sector */
  isPersonalBest: boolean;
}

/**
 * A single incident during a lap (collision or off-track).
 * Used for quality scoring and recovery behavior training.
 */
export interface LapIncident {
  /** Frame number when incident occurred */
  frame: number;
  /** Type of incident */
  type: 'wall_collision' | 'off_track';
  /** Severity 0-1 (impact force for collision, duration for off-track) */
  severity: number;
  /** Position where incident occurred */
  position: { x: number; y: number };
}

/**
 * Lap validity and cleanliness flags.
 * Used to determine leaderboard eligibility and training value.
 */
export interface LapCleanlinessFlags {
  /** Lap crossed finish line (completed) */
  isComplete: boolean;
  /** No off-track excursions */
  isClean: boolean;
  /** No wall collisions */
  noCollisions: boolean;
  /** Official track limits respected (eligible for leaderboard) */
  isLeaderboardEligible: boolean;
}

/**
 * A single frame of replay data.
 * Contains action and optionally observation for training.
 */
export interface ReplayFrame {
  /** Frame number within the lap */
  step: number;
  /** Player/AI input at this frame: x (-1 to 1), y (-1 to 1) */
  action: Action;
  /** 20-feature observation vector for training (optional for backward compat) */
  observation?: number[];
}

/**
 * A complete lap replay.
 * Stored in IndexedDB, auto-recorded for all valid laps.
 */
export interface LapReplay {
  /** Unique identifier (crypto.randomUUID()) */
  id: string;

  // Track identification
  /** Composite seed encoding full track config */
  compositeSeed: number;
  /** Full track configuration for loading */
  trackConfig: FullTrackConfig;

  // Initial car state (for accurate replay playback)
  /** Car state when lap recording started (optional for backward compat) */
  initialState?: CarInitialState;

  // RNG state for deterministic replay (optional for backward compat)
  /** RNG state at lap start for deterministic playback */
  rngState?: RngState;

  // Replay data (lightweight - just actions)
  /** Recorded frames for this lap */
  frames: ReplayFrame[];

  // Lap metadata
  /** Total lap time in seconds */
  lapTime: number;
  /** Sector times [S1, S2, S3] in seconds */
  sectorTimes: number[];
  /** Player's 3-letter initials */
  playerInitials: string;
  /** Unix timestamp when recorded */
  timestamp: number;

  // Driver info
  /** Whether this lap was driven by AI */
  isAI: boolean;
  /** Name of AI agent (if AI lap) */
  agentName?: string;

  // Training flags
  /** User has marked this replay for use as training data */
  isTrainingData: boolean;

  // Quality scoring (for SIL)
  /** Quality score for training value (0-100, computed on save) */
  qualityScore?: number;
  /** Enhanced sector performance data */
  sectorPerformance?: SectorPerformance[];
  /** Delta to reference lap time (session best). Negative = faster */
  deltaToReference?: number;

  // Incident tracking (for recovery behavior training)
  /** List of incidents (collisions, off-track) during this lap */
  incidents: LapIncident[];
  /** Cleanliness flags for leaderboard eligibility */
  cleanliness: LapCleanlinessFlags;
  /** Star rating 0-5 (5 = perfect, deductions for incidents) */
  starRating: number;
  /** Training priority weight (1.0 = clean, 0.3-0.85 = recovery examples) */
  trainingWeight: number;

  // Future sync support
  /** Sync status for future cloud upload */
  syncStatus: 'local' | 'pending' | 'synced';
}

/**
 * Summary info for displaying replays in UI (without frame data).
 */
export interface LapReplaySummary {
  id: string;
  compositeSeed: number;
  lapTime: number;
  sectorTimes: number[];
  playerInitials: string;
  timestamp: number;
  isAI: boolean;
  agentName?: string;
  isTrainingData: boolean;
  frameCount: number;
  qualityScore?: number;
  /** Incident list for quality display */
  incidents: LapIncident[];
  /** Cleanliness flags */
  cleanliness: LapCleanlinessFlags;
  /** Star rating 0-5 */
  starRating: number;
}

/**
 * Convert a full LapReplay to a summary (for UI display).
 */
export function toReplaySummary(replay: LapReplay): LapReplaySummary {
  return {
    id: replay.id,
    compositeSeed: replay.compositeSeed,
    lapTime: replay.lapTime,
    sectorTimes: replay.sectorTimes,
    playerInitials: replay.playerInitials,
    timestamp: replay.timestamp,
    isAI: replay.isAI,
    agentName: replay.agentName,
    isTrainingData: replay.isTrainingData,
    frameCount: replay.frames.length,
    qualityScore: replay.qualityScore,
    incidents: replay.incidents,
    cleanliness: replay.cleanliness,
    starRating: replay.starRating,
  };
}

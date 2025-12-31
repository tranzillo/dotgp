import type { AgentConfig, SerializedModel } from './types';
import type { FullTrackConfig } from '../timetrials/types';

/**
 * Configurable reward weights for RL fine-tuning.
 * Each weight scales its reward component (0 = disabled, 1 = normal, 2 = emphasized).
 */
export interface RewardWeights {
  /** Forward track progress (0-2, default: 1.0) */
  progress: number;
  /** Speed reward (0-1, default: 0.3) */
  speed: number;
  /** Heading alignment with track direction (0-1, default: 0.5) */
  heading: number;
  /** Reward for staying near centerline (0-1, default: 0.3) */
  centerline: number;
  /** Penalty for being off-track (0-1, default: 0.5) */
  offTrackPenalty: number;
  /** Bonus for completing a lap (0-2, default: 1.0) */
  lapBonus: number;
  /** Extra bonus for clean (valid) lap without cutting (0-1, default: 0.5) */
  validLapBonus: number;
  /** Penalty for gaining progress while off-track (0-2, default: 0.8) */
  cuttingPenalty: number;
  /** Small per-step penalty to encourage speed (0-0.5, default: 0.1) */
  timePenalty: number;
  /** Reward for conserving tire grip (0-0.5, default: 0.1) */
  gripConservation: number;
}

/**
 * Default reward weights - balanced profile.
 */
export const DEFAULT_REWARD_WEIGHTS: RewardWeights = {
  progress: 1.0,
  speed: 0.3,
  heading: 0.5,
  centerline: 0.3,
  offTrackPenalty: 0.5,
  lapBonus: 1.0,
  validLapBonus: 0.5,
  cuttingPenalty: 0.8,
  timePenalty: 0.1,
  gripConservation: 0.1,
};

/**
 * A single training session record.
 * Tracks what happened during one training run.
 */
export interface TrainingSession {
  /** Unique session ID */
  id: string;
  /** Unix timestamp when training started */
  timestamp: number;
  /** Training mode used */
  mode: 'bc' | 'rl' | 'bc+rl';
  /** Number of epochs (BC) or episodes (RL) */
  epochs: number;
  /** IDs of laps used for training */
  lapIds: string[];
  /** Reward weights used for this session */
  rewardWeights: RewardWeights;
  /** Final BC loss (for BC mode) */
  finalLoss?: number;
  /** Average reward achieved (for RL mode) */
  avgReward?: number;
  /** Best lap time achieved during this session */
  bestLapTime?: number;
}

/**
 * Complete agent profile with metadata, weights, and training history.
 * This is the persistent, serializable representation of a trained agent.
 */
export interface AgentProfile {
  // Identity
  /** Unique agent ID */
  id: string;
  /** User-assigned name (e.g., "Monaco Specialist v2") */
  name: string;
  /** Unix timestamp when agent was created */
  createdAt: number;
  /** Unix timestamp of last modification */
  updatedAt: number;

  // Track binding (single-track specialist)
  /** Composite seed of the track this agent is trained on */
  compositeSeed: number;
  /** Full track configuration */
  trackConfig: FullTrackConfig;

  // Neural network state
  /** Serialized model weights and config from ActorCriticAgent.save() */
  model: SerializedModel;

  // Training configuration
  /** Current reward weights (used for next training) */
  rewardWeights: RewardWeights;
  /** Agent network configuration */
  agentConfig: AgentConfig;

  // Training history
  /** History of all training sessions */
  trainingSessions: TrainingSession[];
  /** Total epochs/episodes trained across all sessions */
  totalEpochs: number;
  /** Total training samples used */
  totalSamples: number;

  // Performance metrics
  /** Best achieved lap time (null if no laps completed) */
  bestLapTime: number | null;
  /** Average of recent lap times */
  avgLapTime: number | null;
  /** Total valid laps completed */
  lapsCompleted: number;

  // User metadata
  /** User notes about this agent */
  notes: string;
  /** User-defined tags for organization */
  tags: string[];
}

/**
 * Lightweight summary for UI display (without model weights).
 */
export interface AgentProfileSummary {
  id: string;
  name: string;
  compositeSeed: number;
  createdAt: number;
  updatedAt: number;
  totalEpochs: number;
  bestLapTime: number | null;
  lapsCompleted: number;
}

/**
 * RL fine-tuning configuration.
 */
export interface RLFineTuningConfig {
  /** Training mode: 'quick' (headless) or 'watch' (visual) */
  mode: 'watch' | 'quick';
  /** Number of RL episodes to train (default: 100) */
  episodes: number;
  /** Max steps per episode before reset (default: 2000) */
  maxStepsPerEpisode: number;
  /** Adam learning rate (default: 0.0001) */
  learningRate: number;
  /** Discount factor gamma (default: 0.99) */
  discountFactor: number;
  /** GAE lambda (default: 0.95) */
  gaeLambda: number;
  /** Reward weights to use */
  rewardWeights: RewardWeights;
  /** BC warm-up epochs before RL (default: 0) */
  bcWarmUpEpochs: number;
  /** Whether to include demos in RL experience buffer */
  useDemoReplay: boolean;
  /** Ratio of demo samples to RL samples (0-1, default: 0.2) */
  demoReplayRatio: number;

  // Conservative fine-tuning parameters
  /** Learning rate for RL fine-tuning (default: 0.00001, 10x lower than scratch) */
  fineTuneLearningRate: number;
  /** Entropy coefficient for fine-tuning (default: 0.001, 10x lower than scratch) */
  fineTuneEntropyCoef: number;
  /** Critic pre-training epochs on demo data before RL (default: 20) */
  criticPreTrainEpochs: number;
}

/**
 * Default RL fine-tuning configuration.
 */
export const DEFAULT_RL_CONFIG: RLFineTuningConfig = {
  mode: 'quick',
  episodes: 100,
  maxStepsPerEpisode: 2000,
  learningRate: 0.0001,
  discountFactor: 0.99,
  gaeLambda: 0.95,
  rewardWeights: DEFAULT_REWARD_WEIGHTS,
  bcWarmUpEpochs: 0,
  useDemoReplay: false,
  demoReplayRatio: 0.2,

  // Conservative fine-tuning defaults (prevents catastrophic forgetting)
  fineTuneLearningRate: 0.00001,  // 10x lower than scratch training
  fineTuneEntropyCoef: 0.001,     // 10x lower - less random exploration
  criticPreTrainEpochs: 20,       // Pre-train value function on demo returns
};

/**
 * Self-Imitation Learning (SIL) configuration.
 * Settings for instant autonomous agent improvement.
 *
 * Instant SIL trains immediately after each good lap (no batching/cycles).
 */
export interface SILConfig {
  // Lap selection
  /** Minimum quality score to use lap (0-100, default: 50) */
  qualityThreshold: number;
  /** Maximum laps to keep in rolling buffer (default: 30) */
  maxLapsToKeep: number;

  // Training intensity
  /** BC epochs to run after each good lap (default: 5) */
  epochsPerLap: number;

  // Stop conditions (optional)
  /** Target lap time to achieve (null = no target) */
  targetLapTime: number | null;
}

/**
 * Default SIL configuration.
 */
export const DEFAULT_SIL_CONFIG: SILConfig = {
  qualityThreshold: 50,
  maxLapsToKeep: 30,
  epochsPerLap: 5,
  targetLapTime: null,
};

/**
 * SIL session state.
 * Tracks progress during instant self-imitation learning.
 */
export interface SILSession {
  /** Session ID */
  id: string;
  /** Unix timestamp when session started */
  startTime: number;

  // Session-specific stats (this run only)
  /** Number of laps completed this session */
  sessionLapsCompleted: number;
  /** Number of good laps collected this session */
  sessionGoodLaps: number;
  /** Best lap time this session */
  sessionBestLapTime: number | null;
  /** Total training updates this session */
  sessionTrainingUpdates: number;

  // Training data stats (selected laps)
  /** Total selected laps for training (user-chosen + auto-added) */
  selectedLapCount: number;
  /** How many laps were auto-added this session */
  sessionAutoAdded: number;

  // All-time stats
  /** All-time best lap time (agent profile) */
  allTimeBestLapTime: number | null;

  /** Whether session is active */
  isActive: boolean;
}

/**
 * Training progress callback data.
 */
export interface TrainingProgress {
  /** Current episode number */
  episode: number;
  /** Total episodes to train */
  totalEpisodes: number;
  /** Current step within episode */
  stepInEpisode: number;
  /** Reward for current episode */
  reward: number;
  /** Rolling average reward */
  avgReward: number;
  /** Lap time if completed (null otherwise) */
  lapTime: number | null;
  /** Best lap time so far */
  bestLapTime: number | null;
  /** Current loss value */
  loss: number | null;
  /** Current training phase */
  phase: 'bc' | 'rl';
}

/**
 * Training result returned on completion.
 */
export interface TrainingResult {
  /** Whether training completed successfully */
  success: boolean;
  /** Number of episodes actually trained */
  episodesTrained: number;
  /** Final average reward */
  finalAvgReward: number;
  /** Best lap time achieved */
  bestLapTime: number | null;
  /** ID of the training session */
  sessionId: string;
}

/**
 * Convert full AgentProfile to lightweight summary.
 */
export function toAgentSummary(agent: AgentProfile): AgentProfileSummary {
  return {
    id: agent.id,
    name: agent.name,
    compositeSeed: agent.compositeSeed,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    totalEpochs: agent.totalEpochs,
    bestLapTime: agent.bestLapTime,
    lapsCompleted: agent.lapsCompleted,
  };
}

/**
 * Create a new blank agent profile for a track.
 */
export function createAgentProfile(
  name: string,
  trackConfig: FullTrackConfig,
  compositeSeed: number,
  model: SerializedModel,
  agentConfig: AgentConfig
): AgentProfile {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name,
    createdAt: now,
    updatedAt: now,
    compositeSeed,
    trackConfig,
    model,
    rewardWeights: { ...DEFAULT_REWARD_WEIGHTS },
    agentConfig,
    trainingSessions: [],
    totalEpochs: 0,
    totalSamples: 0,
    bestLapTime: null,
    avgLapTime: null,
    lapsCompleted: 0,
    notes: '',
    tags: [],
  };
}

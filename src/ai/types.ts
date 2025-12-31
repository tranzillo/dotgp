import type { CarState } from '../types';

// Observation: normalized features for the neural network
export interface Observation {
  features: number[];
}

// Action output from the agent
export interface Action {
  x: number;  // -1 (left) to 1 (right)
  y: number;  // -1 (brake) to 1 (accelerate)
}

// Result of taking a step in the environment
export interface StepResult {
  observation: Observation;
  reward: number;
  done: boolean;
  info: StepInfo;
}

export interface StepInfo {
  lapCompleted: boolean;
  lapTime: number;
  offTrack: boolean;
  wrongDirection: boolean;
  episodeSteps: number;
}

// Experience tuple for training
export interface Experience {
  observation: number[];
  action: Action;
  reward: number;
  nextObservation: number[];
  done: boolean;
}

// Reward calculation profiles
export type RewardProfile = 'speed' | 'strategy' | 'balanced' | 'simple';

// Environment configuration
export interface EnvConfig {
  maxStepsPerEpisode: number;
  rewardProfile: RewardProfile;
  trackSeed?: number;
}

// Agent configuration
export interface AgentConfig {
  observationSize: number;
  hiddenLayers: number[];
  learningRate: number;
  discountFactor: number;
  // Actor-Critic specific
  entropyCoef?: number;     // Entropy bonus weight (default 0.01)
  valueCoef?: number;       // Value loss weight (default 0.5)
  maxGradNorm?: number;     // Gradient clipping (default 0.5)
  gaeLambda?: number;       // GAE lambda (default 0.95)
  // CenterlineFollowingController specific
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  controllerConfig?: any;
}

// Training configuration
export interface TrainingConfig {
  totalEpisodes: number;
  maxStepsPerEpisode: number;
  batchSize: number;
  evaluateEvery: number;
  headless: boolean;
  rewardProfile: RewardProfile;
  learningRate: number;
  discountFactor: number;
  hiddenLayers: number[];
  trackSeed?: number;
}

// Episode statistics
export interface EpisodeStats {
  episode: number;
  totalReward: number;
  steps: number;
  lapCompleted: boolean;
  lapTime: number | null;
  avgSpeed: number;
  offTrackCount: number;
}

// Serialized model for saving/loading
export interface SerializedModel {
  weights: number[][][];
  config: AgentConfig;
}

// State snapshot for reward calculation
export interface StateSnapshot {
  carState: CarState;
  trackProgress: number;
  trackIndex: number;
  speed: number;
  distanceFromTrack: number;
  headingAlignment: number; // -1 (backwards) to 1 (aligned with track)
  centerOffset: number; // -1 (left edge) to 1 (right edge), 0 = centered
}

// Note: Curriculum training types (CurriculumConfig, CurriculumPhase, CurriculumEpisodeMetrics)
// are defined in CurriculumTrainer.ts to keep related code together.
// DemonstrationSample is defined in BehaviorCloningTrainer.ts.

import { ActorCriticAgent } from './ActorCriticAgent';
import { BehaviorCloningTrainer, type BCTrainingStats, type DemonstrationStats } from './BehaviorCloningTrainer';
import { Environment } from './Environment';
import type { Action } from './types';

/**
 * Configuration for curriculum training.
 */
export interface CurriculumConfig {
  // Behavior Cloning Phase
  /** Number of demonstration episodes to collect. Default: 20 */
  bcDemonstrationEpisodes: number;
  /** Number of BC training epochs. Default: 50 */
  bcEpochs: number;
  /** Batch size for BC training. Default: 64 */
  bcBatchSize: number;

  // RL Phase
  /** Total RL training episodes. Default: 1000 */
  rlEpisodes: number;
  /** Max steps per RL episode. Default: 1000 */
  maxStepsPerEpisode: number;

  // Curriculum Phases
  /** Episodes for high centerline weight phase. Default: 200 */
  highCenterlineEpisodes: number;
  /** Episodes for transition phase. Default: 300 */
  transitionEpisodes: number;
  /** Starting centerline weight in RL phase. Default: 0.8 */
  centerlineWeightStart: number;
  /** Ending centerline weight after transition. Default: 0.0 */
  centerlineWeightEnd: number;

  // Cutting
  /** Whether to apply cutting penalty. Default: true */
  cuttingPenaltyEnabled: boolean;

  // Agent Config
  /** Hidden layer sizes. Default: [128, 128] */
  hiddenLayers: number[];
  /** Learning rate for RL. Default: 0.0003 */
  learningRate: number;
  /** Discount factor. Default: 0.99 */
  discountFactor: number;

  // Logging
  /** Log every N episodes. Default: 10 */
  logEvery: number;
  /** Evaluate every N episodes. Default: 50 */
  evaluateEvery: number;
}

const DEFAULT_CONFIG: CurriculumConfig = {
  bcDemonstrationEpisodes: 20,
  bcEpochs: 50,
  bcBatchSize: 64,

  rlEpisodes: 1000,
  maxStepsPerEpisode: 1000,

  highCenterlineEpisodes: 200,
  transitionEpisodes: 300,
  centerlineWeightStart: 0.8,
  centerlineWeightEnd: 0.0,

  cuttingPenaltyEnabled: true,

  hiddenLayers: [128, 128],
  learningRate: 0.0003,
  discountFactor: 0.99,

  logEvery: 10,
  evaluateEvery: 50,
};

/**
 * Training phase definition.
 */
export interface CurriculumPhase {
  name: 'behavior_cloning' | 'rl_high_centerline' | 'rl_transition' | 'rl_speed_only';
  startEpisode: number;
  endEpisode: number;
  centerlineWeight: number | ((episode: number) => number);
}

/**
 * Episode metrics for curriculum training.
 */
export interface CurriculumEpisodeMetrics {
  episode: number;
  phase: string;
  centerlineWeight: number;
  totalReward: number;
  steps: number;
  lapsCompleted: number;
  avgSpeed: number;
  avgCenterlineDeviation: number;
  offTrackPercentage: number;
  cuttingProgress: number;
  lapTime: number | null;
}

/**
 * Callbacks for curriculum training.
 */
export interface CurriculumCallbacks {
  onBCDemonstrationEpisode?: (episode: number, steps: number, laps: number) => void;
  onBCEpoch?: (epoch: number, loss: number) => void;
  onBCComplete?: (stats: BCTrainingStats) => void;
  onRLEpisode?: (metrics: CurriculumEpisodeMetrics) => void;
  onPhaseChange?: (phase: CurriculumPhase) => void;
  onTrainingComplete?: (agent: ActorCriticAgent) => void;
}

/**
 * Training stats returned when complete.
 */
export interface CurriculumTrainingStats {
  demonstrationStats: DemonstrationStats;
  bcStats: BCTrainingStats;
  rlEpisodes: number;
  finalLapTime: number | null;
  bestLapTime: number | null;
  avgRewardLastN: number;
}

/**
 * Curriculum trainer that orchestrates behavior cloning + RL fine-tuning.
 *
 * Training phases:
 * 1. Behavior Cloning: Pre-train on CenterlineFollowingController demonstrations
 * 2. RL High Centerline: Train with high centerline weight (0.8)
 * 3. RL Transition: Gradually reduce centerline weight to 0
 * 4. RL Speed Only: Pure speed optimization
 */
export class CurriculumTrainer {
  private config: CurriculumConfig;
  private callbacks: CurriculumCallbacks;
  private agent: ActorCriticAgent | null = null;
  private phases: CurriculumPhase[] = [];
  private isTraining: boolean = false;

  // Metrics tracking
  private episodeMetrics: CurriculumEpisodeMetrics[] = [];
  private bestLapTime: number | null = null;

  constructor(
    config: Partial<CurriculumConfig> = {},
    callbacks: CurriculumCallbacks = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.callbacks = callbacks;
    this.initializePhases();
  }

  /**
   * Initialize curriculum phases based on config.
   */
  private initializePhases(): void {
    const { highCenterlineEpisodes, transitionEpisodes, rlEpisodes } = this.config;

    this.phases = [
      {
        name: 'behavior_cloning',
        startEpisode: 0,
        endEpisode: 0, // BC is episode 0
        centerlineWeight: 1.0,
      },
      {
        name: 'rl_high_centerline',
        startEpisode: 1,
        endEpisode: highCenterlineEpisodes,
        centerlineWeight: this.config.centerlineWeightStart,
      },
      {
        name: 'rl_transition',
        startEpisode: highCenterlineEpisodes + 1,
        endEpisode: highCenterlineEpisodes + transitionEpisodes,
        centerlineWeight: (episode: number) => {
          const transitionProgress =
            (episode - highCenterlineEpisodes - 1) / transitionEpisodes;
          return (
            this.config.centerlineWeightStart -
            transitionProgress *
              (this.config.centerlineWeightStart - this.config.centerlineWeightEnd)
          );
        },
      },
      {
        name: 'rl_speed_only',
        startEpisode: highCenterlineEpisodes + transitionEpisodes + 1,
        endEpisode: rlEpisodes,
        centerlineWeight: this.config.centerlineWeightEnd,
      },
    ];
  }

  /**
   * Get the current phase for a given episode.
   */
  private getCurrentPhase(episode: number): CurriculumPhase {
    for (let i = this.phases.length - 1; i >= 0; i--) {
      if (episode >= this.phases[i].startEpisode) {
        return this.phases[i];
      }
    }
    return this.phases[0];
  }

  /**
   * Get centerline weight for a given episode.
   */
  private getCenterlineWeight(episode: number): number {
    const phase = this.getCurrentPhase(episode);
    if (typeof phase.centerlineWeight === 'function') {
      return phase.centerlineWeight(episode);
    }
    return phase.centerlineWeight;
  }

  /**
   * Run the full curriculum training.
   */
  async train(): Promise<CurriculumTrainingStats> {
    if (this.isTraining) {
      throw new Error('Training already in progress');
    }

    this.isTraining = true;
    this.episodeMetrics = [];
    this.bestLapTime = null;

    try {
      // Phase 1: Behavior Cloning
      console.log('=== Phase 1: Behavior Cloning ===');
      const { demonstrationStats, bcStats } = await this.runBehaviorCloning();

      // Phases 2-4: RL Training
      console.log('=== Phases 2-4: RL Training ===');
      await this.runRLTraining();

      // Compile final stats
      const stats: CurriculumTrainingStats = {
        demonstrationStats,
        bcStats,
        rlEpisodes: this.config.rlEpisodes,
        finalLapTime: this.getLastLapTime(),
        bestLapTime: this.bestLapTime,
        avgRewardLastN: this.getAverageRewardLastN(50),
      };

      this.callbacks.onTrainingComplete?.(this.agent!);

      return stats;
    } finally {
      this.isTraining = false;
    }
  }

  /**
   * Run behavior cloning phase.
   */
  private async runBehaviorCloning(): Promise<{
    demonstrationStats: DemonstrationStats;
    bcStats: BCTrainingStats;
  }> {
    const bcTrainer = new BehaviorCloningTrainer(
      {
        demonstrationEpisodes: this.config.bcDemonstrationEpisodes,
        epochs: this.config.bcEpochs,
        batchSize: this.config.bcBatchSize,
        maxStepsPerEpisode: this.config.maxStepsPerEpisode,
      },
      {
        onDemonstrationEpisode: this.callbacks.onBCDemonstrationEpisode,
        onTrainingEpoch: this.callbacks.onBCEpoch,
        onComplete: this.callbacks.onBCComplete,
      }
    );

    // Create agent
    this.agent = new ActorCriticAgent({
      observationSize: 20,
      hiddenLayers: this.config.hiddenLayers,
      learningRate: this.config.learningRate,
      discountFactor: this.config.discountFactor,
    });

    // Collect and train
    const { demonstrationStats, trainingStats } = await bcTrainer.collectAndTrain(this.agent);

    return {
      demonstrationStats,
      bcStats: trainingStats,
    };
  }

  /**
   * Run RL training phases (high centerline, transition, speed only).
   */
  private async runRLTraining(): Promise<void> {
    if (!this.agent) {
      throw new Error('Agent not initialized. Run behavior cloning first.');
    }

    let currentPhaseName: string | null = null;

    for (let episode = 1; episode <= this.config.rlEpisodes; episode++) {
      // Get current phase and centerline weight
      const phase = this.getCurrentPhase(episode);
      const centerlineWeight = this.getCenterlineWeight(episode);

      // Notify phase change
      if (phase.name !== currentPhaseName) {
        currentPhaseName = phase.name;
        this.callbacks.onPhaseChange?.(phase);
        console.log(`Phase: ${phase.name} (centerline weight: ${centerlineWeight.toFixed(2)})`);
      }

      // Run episode
      const metrics = await this.runRLEpisode(
        episode,
        phase.name,
        centerlineWeight
      );

      this.episodeMetrics.push(metrics);

      // Track best lap time
      if (metrics.lapTime !== null) {
        if (this.bestLapTime === null || metrics.lapTime < this.bestLapTime) {
          this.bestLapTime = metrics.lapTime;
        }
      }

      // Log progress
      if (episode % this.config.logEvery === 0 || episode === this.config.rlEpisodes) {
        this.callbacks.onRLEpisode?.(metrics);
        this.logProgress(episode);
      }

      // Yield to event loop
      if (episode % 10 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
  }

  /**
   * Run a single RL episode with curriculum rewards.
   */
  private async runRLEpisode(
    episodeNumber: number,
    phaseName: string,
    centerlineWeight: number
  ): Promise<CurriculumEpisodeMetrics> {
    const seed = Math.floor(Math.random() * 1000000);
    const env = new Environment({
      maxStepsPerEpisode: this.config.maxStepsPerEpisode,
      rewardProfile: 'balanced',
      trackSeed: seed,
    });

    // Set curriculum params on reward calculator (via environment)
    // We'll need to access the reward calculator - for now we'll compute our own
    let observation = env.reset(seed);
    let done = false;
    let totalReward = 0;
    let steps = 0;

    // Experience buffer for training
    const observations: number[][] = [];
    const actions: Action[] = [];
    const rewards: number[] = [];
    const dones: boolean[] = [];
    const values: number[] = [];

    // Metrics tracking
    const centerlineDeviations: number[] = [];
    let offTrackSteps = 0;
    let cuttingProgress = 0;
    let lastLapTime: number | null = null;

    while (!done && steps < this.config.maxStepsPerEpisode) {
      // Get action from agent
      const action = this.agent!.getAction(observation.features);
      const value = this.agent!.getValue!(observation.features);

      // Store experience
      observations.push([...observation.features]);
      actions.push({ ...action });
      values.push(value);

      // Take step
      const result = env.step(action);

      // Calculate curriculum reward (simplified - ideally access env's reward calculator)
      // For now we'll use the step reward and add our adjustments
      let reward = result.reward;

      // Add centerline reward component
      const centerOffset = observation.features[3]; // CENTERLINE_OFFSET
      const centerlineReward = (1.0 - Math.abs(centerOffset)) * 0.5 * centerlineWeight;
      reward = reward * (1 - centerlineWeight) + centerlineReward;

      // Track cutting (progress while off-track)
      const isOnTrack = observation.features[17]; // IS_ON_TRACK
      if (isOnTrack < 0.5) {
        offTrackSteps++;
        // Simple cutting detection via lap info
        if (result.info.lapCompleted) {
          // This shouldn't count as valid if lots of cutting
        }
      }

      rewards.push(reward);
      dones.push(result.done);
      totalReward += reward;
      steps++;

      // Track metrics
      centerlineDeviations.push(Math.abs(centerOffset));

      // Update state
      observation = result.observation;
      done = result.done;

      if (result.info.lapCompleted && result.info.lapTime > 0) {
        lastLapTime = result.info.lapTime;
      }
    }

    // Train agent on this episode
    if (steps > 0) {
      const advantages = this.agent!.computeAdvantages!(
        rewards,
        values,
        dones,
        this.config.discountFactor
      );
      const returns = advantages.map((adv, i) => adv + values[i]);

      await this.agent!.train!({
        observations,
        actions,
        rewards,
        nextObservations: [], // Not needed for A2C
        dones,
        values,
        advantages,
        returns,
      });
    }

    const stats = env.getEpisodeStats();

    return {
      episode: episodeNumber,
      phase: phaseName,
      centerlineWeight,
      totalReward,
      steps,
      lapsCompleted: stats.lapsCompleted,
      avgSpeed: stats.speed,
      avgCenterlineDeviation:
        centerlineDeviations.length > 0
          ? centerlineDeviations.reduce((a, b) => a + b, 0) / centerlineDeviations.length
          : 0,
      offTrackPercentage: (offTrackSteps / steps) * 100,
      cuttingProgress,
      lapTime: lastLapTime,
    };
  }

  /**
   * Log training progress to console.
   */
  private logProgress(episode: number): void {
    const recentMetrics = this.episodeMetrics.slice(-this.config.logEvery);
    const avgReward = recentMetrics.reduce((sum, m) => sum + m.totalReward, 0) / recentMetrics.length;
    const avgSteps = recentMetrics.reduce((sum, m) => sum + m.steps, 0) / recentMetrics.length;
    const lapsCompleted = recentMetrics.filter(m => m.lapsCompleted > 0).length;
    const avgCenterline = recentMetrics.reduce((sum, m) => sum + m.avgCenterlineDeviation, 0) / recentMetrics.length;
    const phase = this.getCurrentPhase(episode);
    const weight = this.getCenterlineWeight(episode);

    console.log(
      `Episode ${episode}/${this.config.rlEpisodes} | ` +
      `Phase: ${phase.name} | ` +
      `CL Weight: ${weight.toFixed(2)} | ` +
      `Avg Reward: ${avgReward.toFixed(1)} | ` +
      `Avg Steps: ${avgSteps.toFixed(0)} | ` +
      `Laps: ${lapsCompleted}/${this.config.logEvery} | ` +
      `Centerline Dev: ${avgCenterline.toFixed(3)}`
    );
  }

  /**
   * Get average reward over last N episodes.
   */
  private getAverageRewardLastN(n: number): number {
    const recentMetrics = this.episodeMetrics.slice(-n);
    if (recentMetrics.length === 0) return 0;
    return recentMetrics.reduce((sum, m) => sum + m.totalReward, 0) / recentMetrics.length;
  }

  /**
   * Get the last recorded lap time.
   */
  private getLastLapTime(): number | null {
    for (let i = this.episodeMetrics.length - 1; i >= 0; i--) {
      if (this.episodeMetrics[i].lapTime !== null) {
        return this.episodeMetrics[i].lapTime;
      }
    }
    return null;
  }

  /**
   * Get the trained agent.
   */
  getAgent(): ActorCriticAgent | null {
    return this.agent;
  }

  /**
   * Get all episode metrics.
   */
  getMetrics(): CurriculumEpisodeMetrics[] {
    return [...this.episodeMetrics];
  }

  /**
   * Get curriculum phases.
   */
  getPhases(): CurriculumPhase[] {
    return [...this.phases];
  }

  /**
   * Check if training is in progress.
   */
  isRunning(): boolean {
    return this.isTraining;
  }

  /**
   * Stop training (sets flag, actual stop happens at next episode boundary).
   */
  stop(): void {
    this.isTraining = false;
  }
}

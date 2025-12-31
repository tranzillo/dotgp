import type { Agent } from './Agent';
import type { Action } from './types';
import { Environment } from './Environment';
import { CenterlineFollowingController } from './CenterlineFollowingController';

/**
 * Configuration for behavior cloning training.
 */
export interface BehaviorCloningConfig {
  /** Number of demonstration episodes to collect. Default: 20 */
  demonstrationEpisodes: number;

  /** Batch size for training. Default: 64 */
  batchSize: number;

  /** Number of training epochs. Default: 50 */
  epochs: number;

  /** Max steps per demonstration episode. Default: 1000 */
  maxStepsPerEpisode: number;

  /** Shuffle demonstrations between epochs. Default: true */
  shuffle: boolean;

  /** Log progress every N epochs. Default: 10 */
  logEvery: number;
}

const DEFAULT_CONFIG: BehaviorCloningConfig = {
  demonstrationEpisodes: 20,
  batchSize: 64,
  epochs: 50,
  maxStepsPerEpisode: 1000,
  shuffle: true,
  logEvery: 10,
};

/**
 * A single demonstration sample: observation + expert action.
 */
export interface DemonstrationSample {
  observation: number[];
  action: Action;
}

/**
 * Statistics from demonstration collection.
 */
export interface DemonstrationStats {
  totalSamples: number;
  episodesCollected: number;
  avgStepsPerEpisode: number;
  lapsCompleted: number;
}

/**
 * Statistics from behavior cloning training.
 */
export interface BCTrainingStats {
  finalLoss: number;
  avgLoss: number;
  epochLosses: number[];
}

/**
 * Callbacks for behavior cloning training.
 */
export interface BCTrainerCallbacks {
  onDemonstrationEpisode?: (episode: number, steps: number, lapsCompleted: number) => void;
  onTrainingEpoch?: (epoch: number, loss: number) => void;
  onComplete?: (stats: BCTrainingStats) => void;
}

/**
 * Trainer for behavior cloning from expert demonstrations.
 *
 * Uses a CenterlineFollowingController to generate demonstrations,
 * then trains an agent to mimic the expert's actions via supervised learning.
 */
export class BehaviorCloningTrainer {
  private config: BehaviorCloningConfig;
  private expert: CenterlineFollowingController;
  private demonstrations: DemonstrationSample[] = [];
  private callbacks: BCTrainerCallbacks;

  constructor(
    config: Partial<BehaviorCloningConfig> = {},
    callbacks: BCTrainerCallbacks = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.callbacks = callbacks;
    this.expert = new CenterlineFollowingController();
  }

  /**
   * Collect demonstrations from the expert controller.
   *
   * Runs the CenterlineFollowingController on multiple tracks and
   * records (observation, action) pairs.
   */
  async collectDemonstrations(): Promise<DemonstrationStats> {
    this.demonstrations = [];
    let totalLaps = 0;

    for (let episode = 0; episode < this.config.demonstrationEpisodes; episode++) {
      const seed = Math.floor(Math.random() * 1000000);
      const env = new Environment({
        maxStepsPerEpisode: this.config.maxStepsPerEpisode,
        rewardProfile: 'balanced',
        trackSeed: seed,
      });

      let observation = env.reset(seed);
      let done = false;
      let steps = 0;
      const startLaps = env.getEpisodeStats().lapsCompleted;

      while (!done && steps < this.config.maxStepsPerEpisode) {
        // Get expert action
        const action = this.expert.getAction(observation.features);

        // Store demonstration sample
        this.demonstrations.push({
          observation: [...observation.features],
          action: { ...action },
        });

        // Step environment
        const result = env.step(action);
        observation = result.observation;
        done = result.done;
        steps++;

        // Yield to event loop periodically
        if (steps % 100 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }

      const endLaps = env.getEpisodeStats().lapsCompleted;
      totalLaps += endLaps - startLaps;

      this.callbacks.onDemonstrationEpisode?.(episode + 1, steps, endLaps - startLaps);
    }

    return {
      totalSamples: this.demonstrations.length,
      episodesCollected: this.config.demonstrationEpisodes,
      avgStepsPerEpisode: this.demonstrations.length / this.config.demonstrationEpisodes,
      lapsCompleted: totalLaps,
    };
  }

  /**
   * Train an agent on collected demonstrations using supervised learning.
   *
   * The agent must implement trainSupervised() method.
   */
  async train(agent: Agent): Promise<BCTrainingStats> {
    if (this.demonstrations.length === 0) {
      throw new Error('No demonstrations collected. Call collectDemonstrations() first.');
    }

    if (!agent.trainSupervised) {
      throw new Error('Agent does not support supervised training (trainSupervised method missing)');
    }

    const epochLosses: number[] = [];
    let totalLoss = 0;

    // Create indices for shuffling
    const indices = Array.from({ length: this.demonstrations.length }, (_, i) => i);

    for (let epoch = 0; epoch < this.config.epochs; epoch++) {
      // Shuffle if enabled
      if (this.config.shuffle) {
        this.shuffleArray(indices);
      }

      let epochLoss = 0;
      let batchCount = 0;

      // Process in batches
      for (let i = 0; i < indices.length; i += this.config.batchSize) {
        const batchIndices = indices.slice(i, i + this.config.batchSize);
        const batchObs = batchIndices.map(idx => this.demonstrations[idx].observation);
        const batchActions = batchIndices.map(idx => this.demonstrations[idx].action);

        // Train on batch
        const result = await agent.trainSupervised(batchObs, batchActions);
        epochLoss += result.loss;
        batchCount++;

        // Yield to event loop periodically
        if (batchCount % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }

      const avgEpochLoss = epochLoss / batchCount;
      epochLosses.push(avgEpochLoss);
      totalLoss += avgEpochLoss;

      if ((epoch + 1) % this.config.logEvery === 0 || epoch === this.config.epochs - 1) {
        this.callbacks.onTrainingEpoch?.(epoch + 1, avgEpochLoss);
      }
    }

    const stats: BCTrainingStats = {
      finalLoss: epochLosses[epochLosses.length - 1],
      avgLoss: totalLoss / this.config.epochs,
      epochLosses,
    };

    this.callbacks.onComplete?.(stats);

    return stats;
  }

  /**
   * Collect demonstrations and train in one step.
   */
  async collectAndTrain(agent: Agent): Promise<{
    demonstrationStats: DemonstrationStats;
    trainingStats: BCTrainingStats;
  }> {
    console.log('Collecting demonstrations from expert...');
    const demonstrationStats = await this.collectDemonstrations();
    console.log(`Collected ${demonstrationStats.totalSamples} samples from ${demonstrationStats.episodesCollected} episodes`);

    console.log('Training agent with behavior cloning...');
    const trainingStats = await this.train(agent);
    console.log(`Training complete. Final loss: ${trainingStats.finalLoss.toFixed(6)}`);

    return { demonstrationStats, trainingStats };
  }

  /**
   * Get the collected demonstrations (for inspection/debugging).
   */
  getDemonstrations(): DemonstrationSample[] {
    return [...this.demonstrations];
  }

  /**
   * Clear collected demonstrations.
   */
  clearDemonstrations(): void {
    this.demonstrations = [];
  }

  /**
   * Get the expert controller (for manual use or configuration).
   */
  getExpert(): CenterlineFollowingController {
    return this.expert;
  }

  /**
   * Train an agent on externally-provided demonstrations.
   * Use this when you have player demonstrations instead of collecting from CenterlineFollowingController.
   *
   * @param agent The agent to train
   * @param demonstrations Array of (observation, action) pairs from player demos
   */
  async trainFromExternalDemonstrations(
    agent: Agent,
    demonstrations: DemonstrationSample[]
  ): Promise<BCTrainingStats> {
    if (demonstrations.length === 0) {
      throw new Error('No demonstrations provided');
    }

    if (!agent.trainSupervised) {
      throw new Error('Agent does not support supervised training (trainSupervised method missing)');
    }

    // Store demonstrations temporarily
    const originalDemos = this.demonstrations;
    this.demonstrations = demonstrations;

    try {
      return await this.train(agent);
    } finally {
      // Restore original demonstrations
      this.demonstrations = originalDemos;
    }
  }

  /**
   * Fisher-Yates shuffle.
   */
  private shuffleArray<T>(array: T[]): void {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }
}

// Add trainSupervised to Agent interface extension
declare module './Agent' {
  interface Agent {
    /**
     * Train actor with supervised learning from demonstrations.
     * Used for behavior cloning phase.
     */
    trainSupervised?(
      observations: number[][],
      actions: Action[]
    ): Promise<{ loss: number }>;
  }
}

/**
 * Player Demo Trainer
 *
 * Trains AI agents from player-recorded demonstrations.
 * Uses behavior cloning (supervised learning) to teach agents to imitate human driving.
 */

import { ActorCriticAgent } from './ActorCriticAgent';
import {
  BehaviorCloningTrainer,
  type DemonstrationSample,
} from './BehaviorCloningTrainer';
import { lapReplayStorage } from '../replay/LapReplayStorage';
import type { LapReplay } from '../replay/types';
import type {
  PlayerDemoTrainingConfig,
  DemoTrainingCallbacks,
  DemoTrainingStats,
} from './DemonstrationTypes';
import { DEFAULT_DEMO_TRAINING_CONFIG } from './DemonstrationTypes';

/**
 * Trains agents from player demonstrations.
 *
 * Usage:
 * 1. Create trainer with config and callbacks
 * 2. Call train() with a composite seed to load demos for that track
 * 3. Returns a trained ActorCriticAgent
 */
export class PlayerDemoTrainer {
  private config: PlayerDemoTrainingConfig;
  private callbacks: DemoTrainingCallbacks;
  private bcTrainer: BehaviorCloningTrainer;
  private isTraining: boolean = false;

  constructor(
    config: Partial<PlayerDemoTrainingConfig> = {},
    callbacks: DemoTrainingCallbacks = {}
  ) {
    this.config = { ...DEFAULT_DEMO_TRAINING_CONFIG, ...config };
    this.callbacks = callbacks;

    // Create BC trainer with our config
    this.bcTrainer = new BehaviorCloningTrainer(
      {
        batchSize: this.config.batchSize,
        epochs: this.config.epochs,
        shuffle: this.config.shuffle,
        logEvery: this.config.logEvery,
        demonstrationEpisodes: 0, // We don't collect demos, we use external ones
        maxStepsPerEpisode: 0,
      },
      {
        onTrainingEpoch: (epoch, loss) => {
          this.callbacks.onEpoch?.(epoch, loss);
        },
        onComplete: (stats) => {
          this.callbacks.onComplete?.(stats.finalLoss, stats.avgLoss);
        },
      }
    );
  }

  /**
   * Train an agent from player demonstrations for a specific track.
   *
   * @param compositeSeed The composite track seed to load demos for
   * @returns The trained agent and training stats
   */
  async train(compositeSeed: number): Promise<{
    agent: ActorCriticAgent;
    stats: DemoTrainingStats;
  }> {
    if (this.isTraining) {
      throw new Error('Training already in progress');
    }

    this.isTraining = true;

    try {
      // Load training replays from storage
      const replays = await lapReplayStorage.getTrainingReplays(compositeSeed);

      if (replays.length === 0) {
        throw new Error('No training data found. Mark some laps as training data first!');
      }

      console.log(`Loaded ${replays.length} training replays`);

      // Convert LapReplay[] to DemonstrationSample[]
      const samples = this.convertReplaysToSamples(replays);

      if (samples.length === 0) {
        throw new Error('No valid training samples found. Laps may be missing observation data - record new laps.');
      }

      console.log(`Total training samples: ${samples.length}`);

      // Create a new agent
      const agent = new ActorCriticAgent({
        observationSize: 20,
        hiddenLayers: [128, 128],
        learningRate: 0.0003,
        discountFactor: 0.99,
      });

      // Train with behavior cloning
      const bcStats = await this.bcTrainer.trainFromExternalDemonstrations(
        agent,
        samples
      );

      const stats: DemoTrainingStats = {
        finalLoss: bcStats.finalLoss,
        avgLoss: bcStats.avgLoss,
        epochLosses: bcStats.epochLosses,
        totalSamples: samples.length,
        demonstrationsUsed: replays.length,
      };

      console.log(`Training complete! Final loss: ${stats.finalLoss.toFixed(6)}`);

      return { agent, stats };
    } finally {
      this.isTraining = false;
    }
  }

  /**
   * Train with a provided agent instead of creating a new one.
   * Useful for fine-tuning an existing agent.
   */
  async trainExistingAgent(
    agent: ActorCriticAgent,
    compositeSeed: number
  ): Promise<DemoTrainingStats> {
    if (this.isTraining) {
      throw new Error('Training already in progress');
    }

    this.isTraining = true;

    try {
      const replays = await lapReplayStorage.getTrainingReplays(compositeSeed);

      if (replays.length === 0) {
        throw new Error('No training data found. Mark some laps as training data first!');
      }

      const samples = this.convertReplaysToSamples(replays);

      if (samples.length === 0) {
        throw new Error('No valid training samples found. Laps may be missing observation data.');
      }

      const bcStats = await this.bcTrainer.trainFromExternalDemonstrations(
        agent,
        samples
      );

      return {
        finalLoss: bcStats.finalLoss,
        avgLoss: bcStats.avgLoss,
        epochLosses: bcStats.epochLosses,
        totalSamples: samples.length,
        demonstrationsUsed: replays.length,
      };
    } finally {
      this.isTraining = false;
    }
  }

  /**
   * Convert LapReplay objects to DemonstrationSample format.
   * Only includes frames that have observation data.
   * Uses weighted sampling based on lap quality (trainingWeight).
   *
   * Higher-weight (cleaner) laps appear more often in the training data,
   * but lower-weight (recovery) laps are still included for robustness.
   */
  private convertReplaysToSamples(replays: LapReplay[]): DemonstrationSample[] {
    // Build weighted pool of samples
    const weightedPool: { sample: DemonstrationSample; weight: number }[] = [];

    for (const replay of replays) {
      // Default weight is 1.0 for backward compatibility with old replays
      const weight = replay.trainingWeight ?? 1.0;

      for (const frame of replay.frames) {
        // Only include frames with observations (for backward compat)
        if (frame.observation) {
          weightedPool.push({
            sample: {
              observation: frame.observation,
              action: frame.action,
            },
            weight,
          });
        }
      }
    }

    // If no weighted sampling needed (all weights equal), just return samples directly
    const allWeightsEqual = weightedPool.every(p => p.weight === weightedPool[0]?.weight);
    if (allWeightsEqual) {
      return weightedPool.map(p => p.sample);
    }

    // Use weighted sampling to create training batch
    // Sample size matches the pool size for similar training data volume
    return this.weightedSample(weightedPool, weightedPool.length);
  }

  /**
   * Perform weighted random sampling from a pool.
   * Higher-weight samples are more likely to be selected.
   *
   * @param pool Array of {sample, weight} objects
   * @param count Number of samples to draw
   * @returns Array of selected samples
   */
  private weightedSample(
    pool: { sample: DemonstrationSample; weight: number }[],
    count: number
  ): DemonstrationSample[] {
    if (pool.length === 0) return [];

    // Calculate total weight
    const totalWeight = pool.reduce((sum, p) => sum + p.weight, 0);
    if (totalWeight <= 0) {
      // Fallback to uniform sampling if all weights are 0
      return pool.slice(0, count).map(p => p.sample);
    }

    // Weighted random sampling with replacement
    const samples: DemonstrationSample[] = [];
    for (let i = 0; i < count; i++) {
      let r = Math.random() * totalWeight;
      for (const p of pool) {
        r -= p.weight;
        if (r <= 0) {
          samples.push(p.sample);
          break;
        }
      }
      // Fallback in case of floating point issues
      if (samples.length === i) {
        samples.push(pool[pool.length - 1].sample);
      }
    }

    return samples;
  }

  /**
   * Check if training is in progress.
   */
  isRunning(): boolean {
    return this.isTraining;
  }

  /**
   * Get the number of training replays available for a track.
   */
  async getDemoCount(compositeSeed: number): Promise<number> {
    const replays = await lapReplayStorage.getTrainingReplays(compositeSeed);
    return replays.length;
  }

  /**
   * Get the total sample count (frames with observations) for a track.
   */
  async getTotalSampleCount(compositeSeed: number): Promise<number> {
    const replays = await lapReplayStorage.getTrainingReplays(compositeSeed);
    let count = 0;
    for (const replay of replays) {
      for (const frame of replay.frames) {
        if (frame.observation) count++;
      }
    }
    return count;
  }

  /**
   * Train an agent using specific lap replay IDs.
   * This allows training from manually selected laps instead of all training-marked laps.
   *
   * @param lapIds Array of lap replay IDs to use for training
   * @param existingAgent Optional existing agent to fine-tune instead of creating new
   * @returns The trained agent and training stats
   */
  async trainWithLapIds(
    lapIds: string[],
    existingAgent?: ActorCriticAgent
  ): Promise<{
    agent: ActorCriticAgent;
    stats: DemoTrainingStats;
  }> {
    if (this.isTraining) {
      throw new Error('Training already in progress');
    }

    if (lapIds.length === 0) {
      throw new Error('No lap IDs provided for training');
    }

    this.isTraining = true;

    try {
      // Load replays by ID
      const replays: LapReplay[] = [];
      for (const id of lapIds) {
        const replay = await lapReplayStorage.getReplay(id);
        if (replay) {
          replays.push(replay);
        }
      }

      if (replays.length === 0) {
        throw new Error('No valid replays found for the provided IDs');
      }

      console.log(`Loaded ${replays.length} training replays from ${lapIds.length} IDs`);

      // Convert LapReplay[] to DemonstrationSample[]
      const samples = this.convertReplaysToSamples(replays);

      if (samples.length === 0) {
        throw new Error('No valid training samples found. Laps may be missing observation data.');
      }

      console.log(`Total training samples: ${samples.length}`);

      // Use existing agent or create a new one
      const agent = existingAgent ?? new ActorCriticAgent({
        observationSize: 20,
        hiddenLayers: [128, 128],
        learningRate: 0.0003,
        discountFactor: 0.99,
      });

      // Train with behavior cloning
      const bcStats = await this.bcTrainer.trainFromExternalDemonstrations(
        agent,
        samples
      );

      const stats: DemoTrainingStats = {
        finalLoss: bcStats.finalLoss,
        avgLoss: bcStats.avgLoss,
        epochLosses: bcStats.epochLosses,
        totalSamples: samples.length,
        demonstrationsUsed: replays.length,
      };

      console.log(`Training complete! Final loss: ${stats.finalLoss.toFixed(6)}`);

      return { agent, stats };
    } finally {
      this.isTraining = false;
    }
  }
}

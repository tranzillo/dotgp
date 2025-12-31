import type { Action, SerializedModel } from './types';

/**
 * Interface for AI agents that can drive a car.
 */
export interface Agent {
  /**
   * Get action from current observation.
   * @param observation - Normalized feature array from ObservationBuilder
   * @returns Action with x (-1 to 1) and y (-1 to 1) components
   */
  getAction(observation: number[]): Action;

  /**
   * Train actor with supervised learning from demonstrations.
   * Used for behavior cloning phase in curriculum training.
   * Optional - only implemented by agents that support behavior cloning.
   *
   * @param observations - Batch of observations from expert demonstrations
   * @param actions - Corresponding expert actions
   * @returns Training loss (MSE between predicted and expert actions)
   */
  trainSupervised?(
    observations: number[][],
    actions: Action[]
  ): Promise<{ loss: number }>;

  /**
   * Get action without exploration (for evaluation).
   */
  getActionDeterministic?(observation: number[]): Action;

  /**
   * Get state value estimate (for Actor-Critic agents).
   */
  getValue?(observation: number[]): number;

  /**
   * Get batch of value estimates (more efficient for training).
   */
  getValues?(observations: number[][]): number[];

  /**
   * Update the agent with a batch of experiences (for training).
   * @param experiences - Array of (obs, action, reward, nextObs, done) tuples
   */
  train?(experiences: TrainingBatch): Promise<TrainingResult>;

  /**
   * Compute discounted returns from rewards.
   */
  computeReturns?(rewards: number[], gamma?: number): number[];

  /**
   * Compute GAE advantages (for Actor-Critic agents).
   */
  computeAdvantages?(
    rewards: number[],
    values: number[],
    dones: boolean[],
    gamma?: number,
    lambda?: number
  ): number[];

  /**
   * Serialize the agent for saving.
   */
  save(): SerializedModel;

  /**
   * Load agent from serialized data.
   */
  load(data: SerializedModel): void;

  /**
   * Get agent name/type.
   */
  getName(): string;

  /**
   * Clean up resources.
   */
  dispose?(): void;
}

/**
 * Training batch for policy gradient methods.
 */
export interface TrainingBatch {
  observations: number[][];
  actions: Action[];
  rewards: number[];
  nextObservations: number[][];
  dones: boolean[];
  values?: number[];      // Value estimates for Actor-Critic
  advantages?: number[];  // GAE advantages for Actor-Critic
  returns?: number[];     // Discounted returns
}

/**
 * Result from a training step.
 */
export interface TrainingResult {
  loss: number;
  policyLoss?: number;
  valueLoss?: number;
  entropy?: number;
}

/**
 * Simple random agent for testing.
 */
export class RandomAgent implements Agent {
  private name = 'RandomAgent';

  getAction(_observation: number[]): Action {
    return {
      x: Math.random() * 2 - 1,
      y: Math.random() * 2 - 1,
    };
  }

  save(): SerializedModel {
    return {
      weights: [],
      config: {
        observationSize: 0,
        hiddenLayers: [],
        learningRate: 0,
        discountFactor: 0,
      },
    };
  }

  load(_data: SerializedModel): void {
    // Nothing to load
  }

  getName(): string {
    return this.name;
  }
}

/**
 * Simple agent that always drives forward (baseline).
 */
export class ForwardAgent implements Agent {
  private name = 'ForwardAgent';

  getAction(observation: number[]): Action {
    // observation[1] is heading angle relative to track (-1 to 1)
    // Steer towards track direction
    const headingError = observation[1] || 0;

    // observation[3] is distance to centerline (-1 to 1)
    const centerOffset = observation[3] || 0;

    // Simple proportional steering
    const steer = -centerOffset * 0.5 - (1 - Math.abs(headingError)) * centerOffset * 0.3;

    return {
      x: Math.max(-1, Math.min(1, steer)),
      y: 0.8,  // Constant throttle
    };
  }

  save(): SerializedModel {
    return {
      weights: [],
      config: {
        observationSize: 0,
        hiddenLayers: [],
        learningRate: 0,
        discountFactor: 0,
      },
    };
  }

  load(_data: SerializedModel): void {
    // Nothing to load
  }

  getName(): string {
    return this.name;
  }
}

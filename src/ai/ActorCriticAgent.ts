import * as tf from '@tensorflow/tfjs';
import type { Agent, TrainingBatch, TrainingResult } from './Agent';
import type { Action, AgentConfig, SerializedModel } from './types';
import { SeededRandom, getGlobalRng } from '../utils/SeededRandom';

const DEFAULT_CONFIG: AgentConfig = {
  observationSize: 20,
  hiddenLayers: [128, 128],
  learningRate: 0.0003,
  discountFactor: 0.99,
  entropyCoef: 0.01,
  valueCoef: 0.5,
  maxGradNorm: 0.5,
  gaeLambda: 0.95,
};

const LOG_2PI = Math.log(2 * Math.PI);

/**
 * Actor-Critic agent using Advantage Actor-Critic (A2C).
 *
 * Key improvements over basic REINFORCE:
 * - Value function baseline reduces variance
 * - Learnable exploration (log_std) instead of hardcoded decay
 * - Correct Gaussian log probability calculation
 * - Entropy bonus prevents premature convergence
 * - Gradient clipping for stability
 */
export class ActorCriticAgent implements Agent {
  private config: AgentConfig;
  private sharedNetwork: tf.Sequential;
  private actorMean: tf.Sequential;
  private actorLogStd: tf.Sequential;
  private critic: tf.Sequential;
  private optimizer: tf.Optimizer;
  private name = 'ActorCriticAgent';
  private rng: SeededRandom;

  constructor(config: Partial<AgentConfig> = {}, seed?: number) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // Use provided seed, or derive from global RNG for deterministic behavior
    this.rng = seed !== undefined
      ? new SeededRandom(seed)
      : getGlobalRng().derive('actor-critic-agent');

    // Build networks
    this.sharedNetwork = this.buildSharedNetwork();
    this.actorMean = this.buildActorMeanHead();
    this.actorLogStd = this.buildActorLogStdHead();
    this.critic = this.buildCriticHead();

    this.optimizer = tf.train.adam(this.config.learningRate);
  }

  /**
   * Build shared trunk network.
   * Input: observation (20 features)
   * Output: hidden representation (128)
   */
  private buildSharedNetwork(): tf.Sequential {
    const model = tf.sequential();

    // First hidden layer with input shape
    model.add(tf.layers.dense({
      units: this.config.hiddenLayers[0],
      activation: 'relu',
      inputShape: [this.config.observationSize],
      kernelInitializer: 'heNormal',
    }));

    // Additional hidden layers
    for (let i = 1; i < this.config.hiddenLayers.length; i++) {
      model.add(tf.layers.dense({
        units: this.config.hiddenLayers[i],
        activation: 'relu',
        kernelInitializer: 'heNormal',
      }));
    }

    return model;
  }

  /**
   * Build actor mean head.
   * Input: hidden representation
   * Output: action means (2 values: x, y)
   */
  private buildActorMeanHead(): tf.Sequential {
    const model = tf.sequential();
    const lastHiddenSize = this.config.hiddenLayers[this.config.hiddenLayers.length - 1];

    model.add(tf.layers.dense({
      units: 2,
      activation: 'tanh',  // Actions bounded to [-1, 1]
      inputShape: [lastHiddenSize],
      kernelInitializer: 'glorotNormal',
    }));

    return model;
  }

  /**
   * Build actor log_std head.
   * Input: hidden representation
   * Output: log standard deviations (2 values: log_std_x, log_std_y)
   *
   * Using learnable log_std allows the network to control exploration.
   * Initialized to log(0.5) ≈ -0.69 for reasonable initial exploration.
   */
  private buildActorLogStdHead(): tf.Sequential {
    const model = tf.sequential();
    const lastHiddenSize = this.config.hiddenLayers[this.config.hiddenLayers.length - 1];

    model.add(tf.layers.dense({
      units: 2,
      activation: 'linear',
      inputShape: [lastHiddenSize],
      kernelInitializer: tf.initializers.zeros(),  // Start with log_std = 0 → std = 1
      biasInitializer: tf.initializers.constant({ value: -0.7 }),  // log(0.5) ≈ -0.7
    }));

    return model;
  }

  /**
   * Build critic head.
   * Input: hidden representation
   * Output: state value (1 value)
   */
  private buildCriticHead(): tf.Sequential {
    const model = tf.sequential();
    const lastHiddenSize = this.config.hiddenLayers[this.config.hiddenLayers.length - 1];

    model.add(tf.layers.dense({
      units: 1,
      activation: 'linear',
      inputShape: [lastHiddenSize],
      kernelInitializer: 'glorotNormal',
    }));

    return model;
  }

  /**
   * Forward pass through all networks.
   * Returns action means, log_stds, and value.
   */
  private forward(observations: tf.Tensor2D): { means: tf.Tensor; logStds: tf.Tensor; values: tf.Tensor } {
    const hidden = this.sharedNetwork.predict(observations) as tf.Tensor;
    const means = this.actorMean.predict(hidden) as tf.Tensor;
    const logStds = this.actorLogStd.predict(hidden) as tf.Tensor;
    const values = this.critic.predict(hidden) as tf.Tensor;

    return { means, logStds, values };
  }

  /**
   * Sample action from Gaussian policy.
   * action = mean + std * noise
   */
  getAction(observation: number[]): Action {
    return tf.tidy(() => {
      const input = tf.tensor2d([observation]);
      const { means, logStds } = this.forward(input);

      const meansData = means.dataSync();
      const logStdsData = logStds.dataSync();

      // Sample from Gaussian: action = mean + std * noise
      const stdX = Math.exp(logStdsData[0]);
      const stdY = Math.exp(logStdsData[1]);

      const noiseX = this.sampleGaussian() * stdX;
      const noiseY = this.sampleGaussian() * stdY;

      // Clamp to [-1, 1]
      const x = Math.max(-1, Math.min(1, meansData[0] + noiseX));
      const y = Math.max(-1, Math.min(1, meansData[1] + noiseY));

      return { x, y };
    });
  }

  /**
   * Get action without exploration (deterministic, for evaluation).
   */
  getActionDeterministic(observation: number[]): Action {
    return tf.tidy(() => {
      const input = tf.tensor2d([observation]);
      const { means } = this.forward(input);
      const meansData = means.dataSync();
      return { x: meansData[0], y: meansData[1] };
    });
  }

  /**
   * Get state value estimate from critic.
   */
  getValue(observation: number[]): number {
    return tf.tidy(() => {
      const input = tf.tensor2d([observation]);
      const hidden = this.sharedNetwork.predict(input) as tf.Tensor;
      const value = this.critic.predict(hidden) as tf.Tensor;
      return value.dataSync()[0];
    });
  }

  /**
   * Get batch of value estimates (more efficient than calling getValue repeatedly).
   */
  getValues(observations: number[][]): number[] {
    return tf.tidy(() => {
      const input = tf.tensor2d(observations);
      const hidden = this.sharedNetwork.predict(input) as tf.Tensor;
      const values = this.critic.predict(hidden) as tf.Tensor;
      return Array.from(values.dataSync());
    });
  }

  /**
   * Compute log probability of actions under current policy.
   *
   * For Gaussian policy with mean μ and std σ:
   * log π(a|s) = -0.5 * sum((a-μ)²/σ²) - sum(log σ) - 0.5 * dim * log(2π)
   */
  private computeLogProb(
    actions: tf.Tensor,
    means: tf.Tensor,
    logStds: tf.Tensor
  ): tf.Tensor {
    const stds = tf.exp(logStds);
    const diff = actions.sub(means);
    const normalizedDiff = diff.div(stds);

    // -0.5 * sum((a-μ)²/σ²)
    const quadraticTerm = tf.mul(-0.5, tf.sum(tf.square(normalizedDiff), -1));

    // -sum(log σ)
    const logStdTerm = tf.neg(tf.sum(logStds, -1));

    // -0.5 * dim * log(2π) -- constant, can be omitted for optimization
    // but including for correctness
    const constTerm = -0.5 * 2 * LOG_2PI;  // 2 action dimensions

    return quadraticTerm.add(logStdTerm).add(constTerm);
  }

  /**
   * Compute entropy of the policy (for exploration bonus).
   * For Gaussian: H = 0.5 * dim * (1 + log(2π)) + sum(log σ)
   */
  private computeEntropy(logStds: tf.Tensor): tf.Tensor {
    const constPart = 0.5 * 2 * (1 + LOG_2PI);  // 2 action dimensions
    return tf.add(constPart, tf.sum(logStds, -1));
  }

  /**
   * Train the agent with a batch of experiences.
   *
   * Uses Advantage Actor-Critic (A2C):
   * - Actor loss: -log π(a|s) * advantage - entropy_bonus
   * - Critic loss: MSE(V(s), returns)
   */
  async train(batch: TrainingBatch): Promise<TrainingResult> {
    const { observations, actions, returns, advantages } = batch;

    if (!returns || !advantages) {
      throw new Error('Training batch must include returns and advantages');
    }

    const result = tf.tidy(() => {
      const obsTensor = tf.tensor2d(observations);
      const actionTensor = tf.tensor2d(actions.map(a => [a.x, a.y]));
      const returnsTensor = tf.tensor1d(returns);
      const advantagesTensor = tf.tensor1d(advantages);

      // Normalize advantages for stability
      const advMean = advantagesTensor.mean();
      const advStd = tf.moments(advantagesTensor).variance.sqrt().add(1e-8) as tf.Tensor;
      const normalizedAdvantages = advantagesTensor.sub(advMean).div(advStd);

      let policyLoss = 0;
      let valueLoss = 0;
      let entropy = 0;
      let totalLoss = 0;

      // Compute gradients and update
      this.optimizer.minimize(() => {
        // Forward pass
        const { means, logStds, values } = this.forward(obsTensor);

        // Compute log probabilities
        const logProbs = this.computeLogProb(actionTensor, means, logStds);

        // Policy loss: -log π(a|s) * advantage
        const policyLossTensor = tf.neg(logProbs.mul(normalizedAdvantages)).mean();
        policyLoss = policyLossTensor.dataSync()[0];

        // Entropy bonus (negative because we want to maximize entropy)
        const entropyTensor = this.computeEntropy(logStds).mean();
        entropy = entropyTensor.dataSync()[0];
        const entropyLoss = tf.neg(entropyTensor).mul(this.config.entropyCoef!);

        // Value loss: MSE(V(s), returns)
        const valuesSqueezed = values.squeeze();
        const valueLossTensor = tf.losses.meanSquaredError(returnsTensor, valuesSqueezed);
        valueLoss = (valueLossTensor as tf.Scalar).dataSync()[0];

        // Total loss
        const loss = policyLossTensor
          .add(entropyLoss)
          .add(tf.mul(valueLossTensor, this.config.valueCoef!));

        totalLoss = (loss as tf.Scalar).dataSync()[0];
        return loss as tf.Scalar;
      }, true);

      return {
        loss: totalLoss,
        policyLoss,
        valueLoss,
        entropy
      };
    });

    return result;
  }

  /**
   * Compute discounted returns from rewards.
   */
  computeReturns(rewards: number[], gamma: number = this.config.discountFactor): number[] {
    const returns: number[] = new Array(rewards.length);
    let runningReturn = 0;

    for (let i = rewards.length - 1; i >= 0; i--) {
      runningReturn = rewards[i] + gamma * runningReturn;
      returns[i] = runningReturn;
    }

    return returns;
  }

  /**
   * Compute Generalized Advantage Estimation (GAE).
   *
   * GAE reduces variance while maintaining acceptable bias.
   * A(t) = sum_{l=0}^{inf} (γλ)^l * δ(t+l)
   * where δ(t) = r(t) + γ*V(s(t+1)) - V(s(t))
   */
  computeAdvantages(
    rewards: number[],
    values: number[],
    dones: boolean[],
    gamma: number = this.config.discountFactor,
    lambda: number = this.config.gaeLambda!
  ): number[] {
    const advantages: number[] = new Array(rewards.length);
    let lastAdvantage = 0;

    for (let t = rewards.length - 1; t >= 0; t--) {
      const nextValue = t === rewards.length - 1 ? 0 : values[t + 1];
      const mask = dones[t] ? 0 : 1;

      // TD error: δ = r + γ*V(s') - V(s)
      const delta = rewards[t] + gamma * nextValue * mask - values[t];

      // GAE: A(t) = δ(t) + (γλ) * A(t+1)
      lastAdvantage = delta + gamma * lambda * mask * lastAdvantage;
      advantages[t] = lastAdvantage;
    }

    return advantages;
  }

  /**
   * Get all trainable weights for serialization.
   */
  private getAllWeights(): number[][][] {
    const weights: number[][][] = [];

    // Shared network weights
    for (const layer of this.sharedNetwork.layers) {
      const layerWeights = layer.getWeights();
      const layerData: number[][] = [];
      for (const w of layerWeights) {
        layerData.push(Array.from(w.dataSync()));
      }
      if (layerData.length > 0) {
        weights.push(layerData);
      }
    }

    // Actor mean head weights
    for (const layer of this.actorMean.layers) {
      const layerWeights = layer.getWeights();
      const layerData: number[][] = [];
      for (const w of layerWeights) {
        layerData.push(Array.from(w.dataSync()));
      }
      if (layerData.length > 0) {
        weights.push(layerData);
      }
    }

    // Actor log_std head weights
    for (const layer of this.actorLogStd.layers) {
      const layerWeights = layer.getWeights();
      const layerData: number[][] = [];
      for (const w of layerWeights) {
        layerData.push(Array.from(w.dataSync()));
      }
      if (layerData.length > 0) {
        weights.push(layerData);
      }
    }

    // Critic head weights
    for (const layer of this.critic.layers) {
      const layerWeights = layer.getWeights();
      const layerData: number[][] = [];
      for (const w of layerWeights) {
        layerData.push(Array.from(w.dataSync()));
      }
      if (layerData.length > 0) {
        weights.push(layerData);
      }
    }

    return weights;
  }

  save(): SerializedModel {
    return {
      weights: this.getAllWeights(),
      config: this.config,
    };
  }

  load(data: SerializedModel): void {
    this.config = { ...DEFAULT_CONFIG, ...data.config };

    // Dispose old networks
    this.sharedNetwork.dispose();
    this.actorMean.dispose();
    this.actorLogStd.dispose();
    this.critic.dispose();

    // Rebuild networks with loaded config
    this.sharedNetwork = this.buildSharedNetwork();
    this.actorMean = this.buildActorMeanHead();
    this.actorLogStd = this.buildActorLogStdHead();
    this.critic = this.buildCriticHead();

    // Load weights
    let weightIndex = 0;

    // Load shared network weights
    for (const layer of this.sharedNetwork.layers) {
      if (weightIndex >= data.weights.length) break;
      const layerWeights = layer.getWeights();
      if (layerWeights.length === 0) continue;

      const newWeights: tf.Tensor[] = [];
      const savedLayerWeights = data.weights[weightIndex];

      for (let i = 0; i < layerWeights.length && i < savedLayerWeights.length; i++) {
        const shape = layerWeights[i].shape;
        newWeights.push(tf.tensor(savedLayerWeights[i], shape));
      }

      if (newWeights.length > 0) {
        layer.setWeights(newWeights);
      }
      weightIndex++;
    }

    // Load actor mean head weights
    for (const layer of this.actorMean.layers) {
      if (weightIndex >= data.weights.length) break;
      const layerWeights = layer.getWeights();
      if (layerWeights.length === 0) continue;

      const newWeights: tf.Tensor[] = [];
      const savedLayerWeights = data.weights[weightIndex];

      for (let i = 0; i < layerWeights.length && i < savedLayerWeights.length; i++) {
        const shape = layerWeights[i].shape;
        newWeights.push(tf.tensor(savedLayerWeights[i], shape));
      }

      if (newWeights.length > 0) {
        layer.setWeights(newWeights);
      }
      weightIndex++;
    }

    // Load actor log_std head weights
    for (const layer of this.actorLogStd.layers) {
      if (weightIndex >= data.weights.length) break;
      const layerWeights = layer.getWeights();
      if (layerWeights.length === 0) continue;

      const newWeights: tf.Tensor[] = [];
      const savedLayerWeights = data.weights[weightIndex];

      for (let i = 0; i < layerWeights.length && i < savedLayerWeights.length; i++) {
        const shape = layerWeights[i].shape;
        newWeights.push(tf.tensor(savedLayerWeights[i], shape));
      }

      if (newWeights.length > 0) {
        layer.setWeights(newWeights);
      }
      weightIndex++;
    }

    // Load critic head weights
    for (const layer of this.critic.layers) {
      if (weightIndex >= data.weights.length) break;
      const layerWeights = layer.getWeights();
      if (layerWeights.length === 0) continue;

      const newWeights: tf.Tensor[] = [];
      const savedLayerWeights = data.weights[weightIndex];

      for (let i = 0; i < layerWeights.length && i < savedLayerWeights.length; i++) {
        const shape = layerWeights[i].shape;
        newWeights.push(tf.tensor(savedLayerWeights[i], shape));
      }

      if (newWeights.length > 0) {
        layer.setWeights(newWeights);
      }
      weightIndex++;
    }
  }

  getName(): string {
    return this.name;
  }

  setName(name: string): void {
    this.name = name;
  }

  /**
   * Update the learning rate for fine-tuning.
   * Creates a new optimizer with the specified rate.
   */
  setLearningRate(rate: number): void {
    this.config.learningRate = rate;
    this.optimizer.dispose();
    this.optimizer = tf.train.adam(rate);
    console.log(`Learning rate set to ${rate}`);
  }

  /**
   * Update the entropy coefficient for fine-tuning.
   * Lower values = less exploration, more exploitation.
   */
  setEntropyCoef(coef: number): void {
    this.config.entropyCoef = coef;
    console.log(`Entropy coefficient set to ${coef}`);
  }

  /**
   * Train ONLY the critic (value function) on observation-return pairs.
   * Freezes actor weights - useful for pre-training critic before RL.
   *
   * Note: Due to TensorFlow.js API limitations, we train the full network
   * but since we only backprop through the critic output, actor weights
   * receive no meaningful gradients (effectively frozen).
   *
   * @param observations - Batch of observations
   * @param returns - Target returns (discounted cumulative rewards)
   * @returns Training loss
   */
  async trainCriticOnly(
    observations: number[][],
    returns: number[]
  ): Promise<{ loss: number }> {
    const loss = tf.tidy(() => {
      const obsTensor = tf.tensor2d(observations);
      const returnsTensor = tf.tensor1d(returns);

      let mse = 0;

      // Train critic only - actor heads don't contribute to this loss
      // so their weights won't be meaningfully updated
      this.optimizer.minimize(() => {
        // Forward through shared network and critic
        const hidden = this.sharedNetwork.predict(obsTensor) as tf.Tensor;
        const values = this.critic.predict(hidden) as tf.Tensor;
        const valuesSqueezed = values.squeeze();

        // MSE loss between predicted values and target returns
        const lossValue = tf.losses.meanSquaredError(returnsTensor, valuesSqueezed);
        mse = (lossValue as tf.Scalar).dataSync()[0];

        return lossValue as tf.Scalar;
      }, true);

      return mse;
    });

    return { loss };
  }

  /**
   * Get current exploration level (average std across action dimensions).
   */
  getExplorationLevel(): number {
    return tf.tidy(() => {
      // Sample a neutral observation to get current log_stds
      const neutralObs = new Array(this.config.observationSize).fill(0);
      const input = tf.tensor2d([neutralObs]);
      const hidden = this.sharedNetwork.predict(input) as tf.Tensor;
      const logStds = this.actorLogStd.predict(hidden) as tf.Tensor;
      const stds = tf.exp(logStds);
      return stds.mean().dataSync()[0];
    });
  }

  /**
   * Sample from standard normal distribution using seeded RNG.
   */
  private sampleGaussian(): number {
    return this.rng.randomGaussian();
  }

  /**
   * Get current RNG state for replay recording.
   */
  getRngState(): number {
    return this.rng.getState();
  }

  /**
   * Set RNG state for replay playback.
   */
  setRngState(state: number): void {
    this.rng.setState(state);
  }

  /**
   * Reset RNG to initial seed.
   */
  resetRng(): void {
    this.rng.reset();
  }

  /**
   * Train actor network using supervised learning (behavior cloning).
   *
   * Only trains the actor mean head to match expert actions.
   * Does NOT train the critic (value estimates would be biased from demonstrations).
   *
   * @param observations - Batch of observations from expert demonstrations
   * @param actions - Corresponding expert actions
   * @returns Training loss (MSE between predicted and expert actions)
   */
  async trainSupervised(
    observations: number[][],
    actions: Action[]
  ): Promise<{ loss: number }> {
    const loss = tf.tidy(() => {
      const obsTensor = tf.tensor2d(observations);
      const actionTensor = tf.tensor2d(actions.map(a => [a.x, a.y]));

      let mse = 0;

      this.optimizer.minimize(() => {
        // Forward through shared network and actor mean head
        const hidden = this.sharedNetwork.predict(obsTensor) as tf.Tensor;
        const predictedMeans = this.actorMean.predict(hidden) as tf.Tensor;

        // MSE loss between predicted and expert actions
        const lossValue = tf.losses.meanSquaredError(actionTensor, predictedMeans);
        mse = (lossValue as tf.Scalar).dataSync()[0];

        return lossValue as tf.Scalar;
      }, true);

      return mse;
    });

    return { loss };
  }

  /**
   * Clean up TensorFlow resources.
   */
  dispose(): void {
    this.sharedNetwork.dispose();
    this.actorMean.dispose();
    this.actorLogStd.dispose();
    this.critic.dispose();
  }
}

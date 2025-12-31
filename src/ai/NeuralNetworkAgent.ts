import * as tf from '@tensorflow/tfjs';
import type { Agent, TrainingBatch, TrainingResult } from './Agent';
import type { Action, AgentConfig, SerializedModel } from './types';
import { SeededRandom, getGlobalRng } from '../utils/SeededRandom';

const DEFAULT_CONFIG: AgentConfig = {
  observationSize: 16,
  hiddenLayers: [64, 64],
  learningRate: 0.001,
  discountFactor: 0.99,
};

/**
 * Neural network agent using policy gradient (REINFORCE).
 * Outputs continuous actions for steering and throttle.
 */
export class NeuralNetworkAgent implements Agent {
  private config: AgentConfig;
  private policyNetwork: tf.Sequential;
  private optimizer: tf.Optimizer;
  private name = 'NeuralNetworkAgent';
  private rng: SeededRandom;

  // For exploration - start with high exploration to encourage movement
  private explorationStd: number = 0.5;
  private minExplorationStd: number = 0.1;
  private explorationDecay: number = 0.999;

  constructor(config: Partial<AgentConfig> = {}, seed?: number) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // Use provided seed, or derive from global RNG for deterministic behavior
    this.rng = seed !== undefined
      ? new SeededRandom(seed)
      : getGlobalRng().derive('neural-network-agent');
    this.policyNetwork = this.buildNetwork();
    this.optimizer = tf.train.adam(this.config.learningRate);
  }

  private buildNetwork(): tf.Sequential {
    const model = tf.sequential();

    // Input layer + first hidden layer
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

    // Output layer: 2 outputs (x, y) with tanh activation for -1 to 1 range
    model.add(tf.layers.dense({
      units: 2,
      activation: 'tanh',
      kernelInitializer: 'glorotNormal',
    }));

    return model;
  }

  private actionCounter: number = 0;

  getAction(observation: number[]): Action {
    const action = tf.tidy(() => {
      const input = tf.tensor2d([observation]);
      const output = this.policyNetwork.predict(input) as tf.Tensor;
      const values = output.dataSync();

      // Add exploration noise
      const noiseX = this.sampleGaussian() * this.explorationStd;
      const noiseY = this.sampleGaussian() * this.explorationStd;

      const x = Math.max(-1, Math.min(1, values[0] + noiseX));
      const y = Math.max(-1, Math.min(1, values[1] + noiseY));

      // Debug: log action values
      if (this.actionCounter++ % 500 === 0) {
        const obsSum = observation.reduce((a, b) => a + b, 0);
        console.log(`Agent: net=(${values[0].toFixed(3)}, ${values[1].toFixed(3)}) noise=(${noiseX.toFixed(3)}, ${noiseY.toFixed(3)}) final=(${x.toFixed(3)}, ${y.toFixed(3)}) obsSum=${obsSum.toFixed(2)}`);
      }

      return { x, y };
    });

    return action;
  }

  /**
   * Get action without exploration (for evaluation).
   */
  getActionDeterministic(observation: number[]): Action {
    return tf.tidy(() => {
      const input = tf.tensor2d([observation]);
      const output = this.policyNetwork.predict(input) as tf.Tensor;
      const values = output.dataSync();
      return { x: values[0], y: values[1] };
    });
  }

  async train(batch: TrainingBatch): Promise<TrainingResult> {
    const { observations, actions, returns } = batch;

    if (!returns || returns.length === 0) {
      throw new Error('Training batch must include computed returns');
    }

    const loss = await tf.tidy(() => {
      const obsTensor = tf.tensor2d(observations);
      const returnsTensor = tf.tensor1d(returns);

      // Normalize returns for stability
      const returnsMean = returnsTensor.mean();
      const returnsStd = tf.moments(returnsTensor).variance.sqrt().add(1e-8);
      const normalizedReturns = returnsTensor.sub(returnsMean).div(returnsStd as tf.Tensor);

      const lossValue = this.optimizer.minimize(() => {
        const predictions = this.policyNetwork.predict(obsTensor) as tf.Tensor;

        // Policy gradient loss
        // For each action, compute log probability under Gaussian policy
        const actionTensor = tf.tensor2d(actions.map(a => [a.x, a.y]));

        // Compute squared difference (for Gaussian log prob)
        const diff = actionTensor.sub(predictions);
        const squaredDiff = diff.square();

        // Negative log probability (ignoring constant terms)
        const negLogProb = squaredDiff.sum(1).div(2 * this.explorationStd * this.explorationStd);

        // Policy gradient: -log(pi(a|s)) * R
        const policyLoss = negLogProb.mul(normalizedReturns).mean();

        return policyLoss as tf.Scalar;
      }, true);

      return lossValue?.dataSync()[0] ?? 0;
    });

    // Decay exploration
    this.explorationStd = Math.max(
      this.minExplorationStd,
      this.explorationStd * this.explorationDecay
    );

    return { loss };
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

  save(): SerializedModel {
    // Extract weights from TensorFlow.js model
    const weights: number[][][] = [];

    for (const layer of this.policyNetwork.layers) {
      const layerWeights = layer.getWeights();
      const layerData: number[][] = [];

      for (const w of layerWeights) {
        layerData.push(Array.from(w.dataSync()));
      }

      if (layerData.length > 0) {
        weights.push(layerData);
      }
    }

    return {
      weights,
      config: this.config,
    };
  }

  load(data: SerializedModel): void {
    this.config = data.config;

    // Rebuild network with loaded config
    this.policyNetwork.dispose();
    this.policyNetwork = this.buildNetwork();

    // Load weights
    let layerIndex = 0;
    for (const layer of this.policyNetwork.layers) {
      if (layerIndex >= data.weights.length) break;

      const layerWeights = layer.getWeights();
      if (layerWeights.length === 0) continue;

      const newWeights: tf.Tensor[] = [];
      const savedLayerWeights = data.weights[layerIndex];

      for (let i = 0; i < layerWeights.length && i < savedLayerWeights.length; i++) {
        const shape = layerWeights[i].shape;
        newWeights.push(tf.tensor(savedLayerWeights[i], shape));
      }

      if (newWeights.length > 0) {
        layer.setWeights(newWeights);
      }

      layerIndex++;
    }
  }

  getName(): string {
    return this.name;
  }

  /**
   * Get current exploration standard deviation.
   */
  getExplorationStd(): number {
    return this.explorationStd;
  }

  /**
   * Set exploration standard deviation.
   */
  setExplorationStd(std: number): void {
    this.explorationStd = std;
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
   * Clean up TensorFlow resources.
   */
  dispose(): void {
    this.policyNetwork.dispose();
  }
}

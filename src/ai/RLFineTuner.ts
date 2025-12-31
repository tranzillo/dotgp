import { ActorCriticAgent } from './ActorCriticAgent';
import { ConfigurableRewardCalculator } from './ConfigurableRewardCalculator';
import { Environment } from './Environment';
import { lapReplayStorage } from '../replay/LapReplayStorage';
import type { Action, StateSnapshot } from './types';
import type {
  RLFineTuningConfig,
  TrainingProgress,
  TrainingResult,
  RewardWeights,
} from './AgentProfile';
import { DEFAULT_RL_CONFIG } from './AgentProfile';

/**
 * RL Fine-Tuning Pipeline
 *
 * Supports:
 * - Starting from BC-trained agent checkpoint
 * - Using selected laps as demonstrations
 * - User-configured reward weights
 * - Both "quick" (headless) and "watch" (visual) training modes
 */
export class RLFineTuner {
  private config: RLFineTuningConfig;
  private agent: ActorCriticAgent;
  private rewardCalculator: ConfigurableRewardCalculator;
  private isTraining: boolean = false;
  private shouldStop: boolean = false;

  // Training state
  private currentEpisode: number = 0;
  private bestLapTime: number | null = null;
  private rewardHistory: number[] = [];

  // Demonstration buffer for optional BC warm-up or demo replay
  private demoSamples: { observation: number[]; action: Action }[] = [];

  // Callbacks
  private onProgress: ((progress: TrainingProgress) => void) | null = null;
  private onComplete: ((result: TrainingResult) => void) | null = null;

  constructor(
    agent: ActorCriticAgent,
    config: Partial<RLFineTuningConfig> = {}
  ) {
    this.config = { ...DEFAULT_RL_CONFIG, ...config };
    this.agent = agent;
    this.rewardCalculator = new ConfigurableRewardCalculator(this.config.rewardWeights);
  }

  /**
   * Set callbacks for training progress and completion.
   */
  setCallbacks(
    onProgress: (progress: TrainingProgress) => void,
    onComplete: (result: TrainingResult) => void
  ): void {
    this.onProgress = onProgress;
    this.onComplete = onComplete;
  }

  /**
   * Update reward weights (for UI changes).
   */
  setRewardWeights(weights: Partial<RewardWeights>): void {
    this.config.rewardWeights = { ...this.config.rewardWeights, ...weights };
    this.rewardCalculator.setWeights(this.config.rewardWeights);
  }

  /**
   * Load demonstration data from selected lap IDs.
   * Returns the number of samples loaded.
   */
  async loadDemonstrations(lapIds: string[]): Promise<number> {
    this.demoSamples = [];

    for (const id of lapIds) {
      const replay = await lapReplayStorage.getReplay(id);
      if (replay) {
        for (const frame of replay.frames) {
          if (frame.observation) {
            this.demoSamples.push({
              observation: frame.observation,
              action: frame.action,
            });
          }
        }
      }
    }

    console.log(`Loaded ${this.demoSamples.length} demo samples from ${lapIds.length} laps`);
    return this.demoSamples.length;
  }

  /**
   * Run the full training pipeline.
   *
   * @param trackSeed - Base track seed to train on
   * @returns Training result with success status and metrics
   */
  async train(trackSeed: number): Promise<TrainingResult> {
    if (this.isTraining) {
      throw new Error('Training already in progress');
    }

    this.isTraining = true;
    this.shouldStop = false;
    this.currentEpisode = 0;
    this.bestLapTime = null;
    this.rewardHistory = [];

    const sessionId = crypto.randomUUID();

    try {
      // Phase 1: BC warm-up (if configured)
      if (this.config.bcWarmUpEpochs > 0 && this.demoSamples.length > 0) {
        await this.runBCWarmUp();
      }

      // Phase 2: Critic pre-training on demo returns (NEW - prevents random critic)
      if (this.config.criticPreTrainEpochs > 0 && this.demoSamples.length > 0) {
        await this.runCriticPreTraining();
      }

      // Phase 3: Switch to conservative hyperparameters (NEW - prevents policy destruction)
      console.log('Switching to conservative fine-tuning hyperparameters...');
      this.agent.setLearningRate(this.config.fineTuneLearningRate);
      this.agent.setEntropyCoef(this.config.fineTuneEntropyCoef);

      // Phase 4: RL training
      await this.runRLTraining(trackSeed);

      const result: TrainingResult = {
        success: !this.shouldStop,
        episodesTrained: this.currentEpisode,
        finalAvgReward: this.getAverageReward(50),
        bestLapTime: this.bestLapTime,
        sessionId,
      };

      this.onComplete?.(result);
      return result;
    } finally {
      this.isTraining = false;
    }
  }

  /**
   * BC warm-up phase - supervised learning from demonstrations.
   */
  private async runBCWarmUp(): Promise<void> {
    console.log(`Running BC warm-up for ${this.config.bcWarmUpEpochs} epochs on ${this.demoSamples.length} samples`);

    const batchSize = 64;
    const indices = Array.from({ length: this.demoSamples.length }, (_, i) => i);

    for (let epoch = 0; epoch < this.config.bcWarmUpEpochs; epoch++) {
      if (this.shouldStop) break;

      // Shuffle indices
      this.shuffleArray(indices);

      let epochLoss = 0;
      let batchCount = 0;

      for (let i = 0; i < indices.length; i += batchSize) {
        const batchIndices = indices.slice(i, i + batchSize);
        if (batchIndices.length === 0) continue;

        const batchObs = batchIndices.map((idx) => this.demoSamples[idx].observation);
        const batchActions = batchIndices.map((idx) => this.demoSamples[idx].action);

        const result = await this.agent.trainSupervised(batchObs, batchActions);
        epochLoss += result.loss;
        batchCount++;
      }

      const avgLoss = batchCount > 0 ? epochLoss / batchCount : 0;

      this.onProgress?.({
        episode: 0,
        totalEpisodes: this.config.episodes,
        stepInEpisode: epoch,
        reward: 0,
        avgReward: 0,
        lapTime: null,
        bestLapTime: null,
        loss: avgLoss,
        phase: 'bc',
      });

      // Yield to event loop
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    console.log('BC warm-up complete');
  }

  /**
   * Critic pre-training phase - train value function on demo returns.
   *
   * This bootstraps the critic with reasonable value estimates BEFORE
   * RL training begins, preventing the random-critic problem where
   * incorrect value estimates cause destructive policy updates.
   */
  private async runCriticPreTraining(): Promise<void> {
    console.log(`Running critic pre-training for ${this.config.criticPreTrainEpochs} epochs on ${this.demoSamples.length} samples`);

    // Estimate returns for demo samples using a simple heuristic:
    // Later timesteps in a successful lap should have higher returns
    // We assign returns that decay backwards from a terminal bonus
    const estimatedReturns = this.estimateDemoReturns();

    if (estimatedReturns.length === 0) {
      console.log('No valid returns estimated, skipping critic pre-training');
      return;
    }

    const batchSize = 64;
    const observations = this.demoSamples.map(s => s.observation);

    for (let epoch = 0; epoch < this.config.criticPreTrainEpochs; epoch++) {
      if (this.shouldStop) break;

      // Shuffle indices for this epoch
      const indices = Array.from({ length: observations.length }, (_, i) => i);
      this.shuffleArray(indices);

      let epochLoss = 0;
      let batchCount = 0;

      for (let i = 0; i < indices.length; i += batchSize) {
        const batchIndices = indices.slice(i, i + batchSize);
        if (batchIndices.length === 0) continue;

        const batchObs = batchIndices.map(idx => observations[idx]);
        const batchReturns = batchIndices.map(idx => estimatedReturns[idx]);

        const result = await this.agent.trainCriticOnly(batchObs, batchReturns);
        epochLoss += result.loss;
        batchCount++;
      }

      const avgLoss = batchCount > 0 ? epochLoss / batchCount : 0;

      // Report progress
      this.onProgress?.({
        episode: 0,
        totalEpisodes: this.config.episodes,
        stepInEpisode: epoch,
        reward: 0,
        avgReward: 0,
        lapTime: null,
        bestLapTime: null,
        loss: avgLoss,
        phase: 'bc', // Use 'bc' phase indicator for UI
      });

      if ((epoch + 1) % 5 === 0) {
        console.log(`Critic pre-training epoch ${epoch + 1}/${this.config.criticPreTrainEpochs}: loss=${avgLoss.toFixed(6)}`);
      }

      // Yield to event loop
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    console.log('Critic pre-training complete');
  }

  /**
   * Estimate returns for demo samples.
   *
   * Uses a simple heuristic: assume demos are successful laps,
   * so later timesteps should have higher returns (closer to completion).
   * Returns decay backwards from a terminal reward.
   */
  private estimateDemoReturns(): number[] {
    const returns: number[] = new Array(this.demoSamples.length);
    const gamma = this.config.discountFactor;

    // Assign returns that increase towards the end of the demo
    // This is a rough approximation - real returns would need actual rewards
    const terminalReward = 10.0;  // Bonus for completing a lap
    const stepReward = 0.1;       // Small positive reward per step (making progress)

    // We don't have trajectory boundaries in demoSamples, so treat as one long trajectory
    // Work backwards from the end
    let runningReturn = terminalReward;

    for (let i = this.demoSamples.length - 1; i >= 0; i--) {
      returns[i] = runningReturn;
      runningReturn = stepReward + gamma * runningReturn;
    }

    return returns;
  }

  /**
   * Main RL training loop.
   */
  private async runRLTraining(trackSeed: number): Promise<void> {
    console.log(`Starting RL training for ${this.config.episodes} episodes on track ${trackSeed}`);

    const env = new Environment({
      maxStepsPerEpisode: this.config.maxStepsPerEpisode,
      rewardProfile: 'balanced', // We use our own reward calculator
      trackSeed,
    });

    for (let episode = 0; episode < this.config.episodes; episode++) {
      if (this.shouldStop) break;

      this.currentEpisode = episode + 1;

      // Run episode
      const episodeResult = await this.runRLEpisode(env, trackSeed);

      this.rewardHistory.push(episodeResult.totalReward);

      if (episodeResult.lapTime !== null) {
        if (this.bestLapTime === null || episodeResult.lapTime < this.bestLapTime) {
          this.bestLapTime = episodeResult.lapTime;
          console.log(`New best lap: ${this.bestLapTime.toFixed(2)}s`);
        }
      }

      // Report progress
      this.onProgress?.({
        episode: this.currentEpisode,
        totalEpisodes: this.config.episodes,
        stepInEpisode: episodeResult.steps,
        reward: episodeResult.totalReward,
        avgReward: this.getAverageReward(10),
        lapTime: episodeResult.lapTime,
        bestLapTime: this.bestLapTime,
        loss: episodeResult.loss,
        phase: 'rl',
      });

      // Log progress periodically
      if ((episode + 1) % 10 === 0) {
        console.log(
          `Episode ${episode + 1}/${this.config.episodes}: ` +
            `reward=${episodeResult.totalReward.toFixed(1)}, ` +
            `avgReward=${this.getAverageReward(10).toFixed(1)}, ` +
            `steps=${episodeResult.steps}`
        );
      }

      // Yield to event loop periodically
      if (episode % 5 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    console.log('RL training complete');
  }

  /**
   * Run a single RL episode.
   */
  private async runRLEpisode(
    env: Environment,
    _trackSeed: number
  ): Promise<{
    totalReward: number;
    steps: number;
    lapTime: number | null;
    loss: number;
  }> {
    // Reset environment
    let observation = env.reset();
    this.rewardCalculator.reset();

    let done = false;
    let steps = 0;
    let totalReward = 0;
    let lastLapTime: number | null = null;

    // Experience buffer for this episode
    const observations: number[][] = [];
    const actions: Action[] = [];
    const rewards: number[] = [];
    const dones: boolean[] = [];
    const values: number[] = [];

    // State tracking for custom reward
    let prevState = this.captureStateFromEnv(env);

    while (!done && steps < this.config.maxStepsPerEpisode) {
      // Get action from agent (stochastic for exploration)
      const action = this.agent.getAction(observation.features);
      const value = this.agent.getValue(observation.features);

      // Store experience
      observations.push([...observation.features]);
      actions.push({ ...action });
      values.push(value);

      // Take step in environment
      const result = env.step(action);
      steps++;

      // Capture current state for custom reward calculation
      const currState = this.captureStateFromEnv(env);

      // Calculate reward using our configurable reward calculator
      const customReward = this.rewardCalculator.calculate(
        prevState,
        currState,
        result.info.lapCompleted,
        env.getCar().state.raceState.currentLapValid
      );

      rewards.push(customReward);
      dones.push(result.done);
      totalReward += customReward;

      observation = result.observation;
      done = result.done;
      prevState = currState;

      if (result.info.lapCompleted && result.info.lapTime > 0) {
        lastLapTime = result.info.lapTime;
      }

      // Optionally mix in demonstration samples
      if (this.config.useDemoReplay && this.demoSamples.length > 0) {
        if (Math.random() < this.config.demoReplayRatio) {
          const demoIdx = Math.floor(Math.random() * this.demoSamples.length);
          const demo = this.demoSamples[demoIdx];
          observations.push(demo.observation);
          actions.push(demo.action);
          // For demos, use a fixed positive reward to encourage imitation
          rewards.push(1.0);
          dones.push(false);
          values.push(this.agent.getValue(demo.observation));
        }
      }
    }

    // Train agent on collected experience
    let loss = 0;
    if (steps > 0 && observations.length > 0) {
      const advantages = this.agent.computeAdvantages(
        rewards,
        values,
        dones,
        this.config.discountFactor,
        this.config.gaeLambda
      );
      const returns = advantages.map((adv, i) => adv + values[i]);

      const trainResult = await this.agent.train({
        observations,
        actions,
        rewards,
        nextObservations: [],
        dones,
        values,
        advantages,
        returns,
      });

      loss = trainResult.loss;
    }

    return { totalReward, steps, lapTime: lastLapTime, loss };
  }

  /**
   * Capture state snapshot from environment for reward calculation.
   */
  private captureStateFromEnv(env: Environment): StateSnapshot {
    const car = env.getCar();
    const track = env.getTrack();

    const closestPoint = track.getClosestTrackPoint(car.getPosition());
    const trackProgress = track.getTrackProgress(car.getPosition());
    const distanceFromTrack = closestPoint?.distance ?? 0;

    // Calculate heading alignment
    const vel = car.getVelocity();
    const speed = car.getSpeed();
    let headingAlignment = 0;
    if (closestPoint && speed > 0.1) {
      const tangent = closestPoint.trackPoint.tangent;
      headingAlignment = -(vel.x * tangent.x + vel.y * tangent.y) / speed;
    }

    // Calculate center offset
    let centerOffset = 0;
    if (closestPoint) {
      const pos = car.getPosition();
      const trackPoint = closestPoint.trackPoint;
      const dx = pos.x - trackPoint.position.x;
      const dy = pos.y - trackPoint.position.y;
      const offset = dx * trackPoint.normal.x + dy * trackPoint.normal.y;
      const halfWidth = trackPoint.width / 2;
      centerOffset = Math.max(-1, Math.min(1, offset / halfWidth));
    }

    return {
      carState: { ...car.state },
      trackProgress,
      trackIndex: closestPoint?.index ?? 0,
      speed: car.getSpeed(),
      distanceFromTrack,
      headingAlignment,
      centerOffset,
    };
  }

  /**
   * Stop training gracefully.
   */
  stop(): void {
    this.shouldStop = true;
  }

  /**
   * Check if training is in progress.
   */
  isRunning(): boolean {
    return this.isTraining;
  }

  /**
   * Get the trained agent.
   */
  getAgent(): ActorCriticAgent {
    return this.agent;
  }

  /**
   * Get current configuration.
   */
  getConfig(): RLFineTuningConfig {
    return { ...this.config };
  }

  /**
   * Get training statistics.
   */
  getStats(): {
    currentEpisode: number;
    bestLapTime: number | null;
    avgReward: number;
    totalRewardHistory: number[];
  } {
    return {
      currentEpisode: this.currentEpisode,
      bestLapTime: this.bestLapTime,
      avgReward: this.getAverageReward(10),
      totalRewardHistory: [...this.rewardHistory],
    };
  }

  private getAverageReward(n: number): number {
    if (this.rewardHistory.length === 0) return 0;
    const recent = this.rewardHistory.slice(-n);
    return recent.reduce((a, b) => a + b, 0) / recent.length;
  }

  private shuffleArray<T>(array: T[]): void {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }
}

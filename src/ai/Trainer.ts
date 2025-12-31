import { Environment } from './Environment';
import { NeuralNetworkAgent } from './NeuralNetworkAgent';
import { ActorCriticAgent } from './ActorCriticAgent';
import { CenterlineFollowingController } from './CenterlineFollowingController';
import { EpisodeRecorder } from './EpisodeRecorder';
import type { Agent, TrainingBatch } from './Agent';
import type { TrainingConfig, EpisodeStats, Experience, Action } from './types';

const DEFAULT_TRAINING_CONFIG: TrainingConfig = {
  totalEpisodes: 1000,
  maxStepsPerEpisode: 1000,  // Reduced from 5000 for better credit assignment
  batchSize: 32,
  evaluateEvery: 10,
  headless: true,
  rewardProfile: 'balanced',
  learningRate: 0.0003,  // Lower for stability
  discountFactor: 0.99,
  hiddenLayers: [128, 128],  // Larger network for Actor-Critic
};

export interface TrainerCallbacks {
  onEpisodeStart?: (episode: number, trackSeed: number) => void;
  onEpisodeEnd?: (stats: EpisodeStats) => void;
  onStep?: (step: number, reward: number, action: Action) => void;
  onTrainingComplete?: (stats: EpisodeStats[]) => void;
}

export class Trainer {
  private config: TrainingConfig;
  private env: Environment;
  private agent: Agent;
  private callbacks: TrainerCallbacks;
  private episodeHistory: EpisodeStats[] = [];
  private isTraining: boolean = false;
  private shouldStop: boolean = false;
  private recorder: EpisodeRecorder | null = null;
  private currentTrackSeed: number = 0;
  private useActorCritic: boolean = true;

  constructor(
    config: Partial<TrainingConfig> = {},
    callbacks: TrainerCallbacks = {},
    useActorCritic: boolean = true
  ) {
    this.config = { ...DEFAULT_TRAINING_CONFIG, ...config };
    this.callbacks = callbacks;
    this.useActorCritic = useActorCritic;

    // Create environment
    this.env = new Environment({
      maxStepsPerEpisode: this.config.maxStepsPerEpisode,
      rewardProfile: this.config.rewardProfile,
    });

    // Create agent - use Actor-Critic by default for proper learning
    if (useActorCritic) {
      this.agent = new ActorCriticAgent({
        observationSize: this.env.getObservationSize(),
        hiddenLayers: this.config.hiddenLayers,
        learningRate: this.config.learningRate,
        discountFactor: this.config.discountFactor,
      });
    } else {
      // Legacy REINFORCE agent (kept for backward compatibility)
      this.agent = new NeuralNetworkAgent({
        observationSize: this.env.getObservationSize(),
        hiddenLayers: this.config.hiddenLayers,
        learningRate: this.config.learningRate,
        discountFactor: this.config.discountFactor,
      });
    }
  }

  /**
   * Set an external recorder for episode recording.
   */
  setRecorder(recorder: EpisodeRecorder): void {
    this.recorder = recorder;
  }

  /**
   * Run the full training loop.
   */
  async train(): Promise<EpisodeStats[]> {
    this.isTraining = true;
    this.shouldStop = false;
    this.episodeHistory = [];

    // Behavior cloning warm-up: pre-train agent to follow centerline
    // This gives the agent a baseline understanding of how to drive
    if (this.useActorCritic && this.agent instanceof ActorCriticAgent) {
      console.log('Running behavior cloning warm-up (10 episodes)...');
      await this.runBehaviorCloningWarmup(10);
      console.log('Behavior cloning complete. Starting RL training...');
    }

    for (let episode = 0; episode < this.config.totalEpisodes; episode++) {
      if (this.shouldStop) break;

      // Generate track seed for this episode
      this.currentTrackSeed = this.config.trackSeed ?? Math.floor(Math.random() * 1000000);

      // Start recording if recorder is set
      if (this.recorder) {
        this.recorder.startRecording(this.currentTrackSeed);
      }

      this.callbacks.onEpisodeStart?.(episode, this.currentTrackSeed);

      const stats = await this.runEpisode(episode);
      this.episodeHistory.push(stats);

      // Finish recording
      if (this.recorder) {
        this.recorder.finishRecording(episode, stats);
      }

      this.callbacks.onEpisodeEnd?.(stats);

      // Evaluate periodically
      if ((episode + 1) % this.config.evaluateEvery === 0) {
        this.logProgress(episode);
      }

      // Yield to event loop between episodes for UI responsiveness
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    this.isTraining = false;
    this.callbacks.onTrainingComplete?.(this.episodeHistory);

    return this.episodeHistory;
  }

  /**
   * Run a single training episode.
   */
  async runEpisode(episodeNumber: number): Promise<EpisodeStats> {
    const experiences: Experience[] = [];
    const values: number[] = [];  // For Actor-Critic
    let observation = this.env.reset(this.currentTrackSeed);
    let totalReward = 0;
    let steps = 0;
    let speedSum = 0;
    let offTrackCount = 0;
    let lapCompleted = false;
    let lapTime: number | null = null;

    while (true) {
      // Get action from agent
      const action = this.agent.getAction(observation.features);

      // Get value estimate for Actor-Critic
      if (this.useActorCritic && this.agent.getValue) {
        values.push(this.agent.getValue(observation.features));
      }

      // Record the action
      if (this.recorder) {
        this.recorder.recordFrame(steps, action);
      }

      // Take step in environment
      const result = this.env.step(action);

      // Store experience
      experiences.push({
        observation: observation.features,
        action,
        reward: result.reward,
        nextObservation: result.observation.features,
        done: result.done,
      });

      totalReward += result.reward;
      steps++;
      speedSum += this.env.getCar().getSpeed();

      if (result.info.offTrack) offTrackCount++;
      if (result.info.lapCompleted) {
        lapCompleted = true;
        lapTime = result.info.lapTime;
      }

      this.callbacks.onStep?.(steps, result.reward, action);

      observation = result.observation;

      if (result.done) break;

      // Yield to event loop every 100 steps for UI responsiveness
      if (steps % 100 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    // Train on collected experiences
    await this.trainOnExperiences(experiences, values);

    return {
      episode: episodeNumber,
      totalReward,
      steps,
      lapCompleted,
      lapTime,
      avgSpeed: speedSum / steps,
      offTrackCount,
    };
  }

  /**
   * Train agent on collected experiences.
   * Uses GAE for Actor-Critic, raw returns for REINFORCE.
   */
  private async trainOnExperiences(
    experiences: Experience[],
    values: number[] = []
  ): Promise<void> {
    if (experiences.length === 0) return;

    // Extract arrays
    const observations = experiences.map(e => e.observation);
    const actions = experiences.map(e => e.action);
    const rewards = experiences.map(e => e.reward);
    const nextObservations = experiences.map(e => e.nextObservation);
    const dones = experiences.map(e => e.done);

    let returns: number[];
    let advantages: number[] | undefined;

    if (this.useActorCritic && this.agent.computeAdvantages && values.length > 0) {
      // Actor-Critic: Use GAE for advantage estimation
      advantages = this.agent.computeAdvantages(
        rewards,
        values,
        dones,
        this.config.discountFactor
      );

      // Compute returns from advantages + values
      // returns = advantages + values
      returns = advantages.map((adv, i) => adv + values[i]);
    } else {
      // Legacy REINFORCE: Use raw discounted returns
      returns = this.agent.computeReturns
        ? this.agent.computeReturns(rewards, this.config.discountFactor)
        : this.computeReturnsManually(rewards, this.config.discountFactor);
    }

    const batch: TrainingBatch = {
      observations,
      actions,
      rewards,
      nextObservations,
      dones,
      values: values.length > 0 ? values : undefined,
      advantages,
      returns,
    };

    if (this.agent.train) {
      await this.agent.train(batch);
    }
  }

  /**
   * Fallback returns computation if agent doesn't have the method.
   */
  private computeReturnsManually(rewards: number[], gamma: number): number[] {
    const returns: number[] = new Array(rewards.length);
    let runningReturn = 0;

    for (let i = rewards.length - 1; i >= 0; i--) {
      runningReturn = rewards[i] + gamma * runningReturn;
      returns[i] = runningReturn;
    }

    return returns;
  }

  /**
   * Run evaluation episode without training.
   */
  async evaluate(trackSeed?: number): Promise<EpisodeStats> {
    let observation = this.env.reset(trackSeed);
    let totalReward = 0;
    let steps = 0;
    let speedSum = 0;
    let offTrackCount = 0;
    let lapCompleted = false;
    let lapTime: number | null = null;

    while (true) {
      // Get deterministic action (no exploration)
      const action = this.agent.getActionDeterministic
        ? this.agent.getActionDeterministic(observation.features)
        : this.agent.getAction(observation.features);

      const result = this.env.step(action);

      totalReward += result.reward;
      steps++;
      speedSum += this.env.getCar().getSpeed();

      if (result.info.offTrack) offTrackCount++;
      if (result.info.lapCompleted) {
        lapCompleted = true;
        lapTime = result.info.lapTime;
      }

      observation = result.observation;

      if (result.done) break;
    }

    return {
      episode: -1,
      totalReward,
      steps,
      lapCompleted,
      lapTime,
      avgSpeed: speedSum / steps,
      offTrackCount,
    };
  }

  /**
   * Stop training loop.
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
   * Get training history.
   */
  getHistory(): EpisodeStats[] {
    return this.episodeHistory;
  }

  /**
   * Get the trained agent.
   */
  getAgent(): Agent {
    return this.agent;
  }

  /**
   * Get the environment.
   */
  getEnvironment(): Environment {
    return this.env;
  }

  /**
   * Get current track seed.
   */
  getCurrentTrackSeed(): number {
    return this.currentTrackSeed;
  }

  /**
   * Save agent to JSON.
   */
  saveAgent(): string {
    return JSON.stringify(this.agent.save());
  }

  /**
   * Load agent from JSON.
   */
  loadAgent(json: string): void {
    const data = JSON.parse(json);
    this.agent.load(data);
  }

  /**
   * Set a different agent.
   */
  setAgent(agent: Agent): void {
    this.agent = agent;
  }

  /**
   * Run behavior cloning warm-up to give agent a baseline understanding.
   * Uses CenterlineFollowingController as the expert.
   */
  private async runBehaviorCloningWarmup(numEpisodes: number): Promise<void> {
    const expert = new CenterlineFollowingController();
    const observations: number[][] = [];
    const actions: Action[] = [];

    // Track action statistics for debugging
    let totalActionX = 0;
    let totalActionY = 0;
    let totalOffset = 0;
    let actionCount = 0;

    // Collect demonstrations
    for (let ep = 0; ep < numEpisodes; ep++) {
      const trackSeed = Math.floor(Math.random() * 1000000);
      let observation = this.env.reset(trackSeed);
      let totalProgress = 0;

      for (let step = 0; step < this.config.maxStepsPerEpisode; step++) {
        // Get expert action
        const action = expert.getAction(observation.features);

        // Track action and offset statistics
        totalActionX += action.x;
        totalActionY += action.y;
        totalOffset += observation.features[3];  // centerline offset
        actionCount++;

        // Debug: log first few steps of first episode
        if (ep === 0 && step < 10) {
          const centerOffset = observation.features[3];
          const tangentX = observation.features[6];
          const tangentY = observation.features[7];
          const normalX = -tangentY;  // perpendicular CCW
          const normalY = tangentX;
          console.log(`  BC step ${step}: offset=${centerOffset.toFixed(3)} tangent=(${tangentX.toFixed(3)}, ${tangentY.toFixed(3)}) normal=(${normalX.toFixed(3)}, ${normalY.toFixed(3)}) action=(${action.x.toFixed(3)}, ${action.y.toFixed(3)})`);
        }

        // Store demonstration
        observations.push([...observation.features]);
        actions.push(action);

        // Take step
        const result = this.env.step(action);

        // Track progress
        const prevProgress = observation.features[2];
        const currProgress = result.observation.features[2];
        let delta = currProgress - prevProgress;
        if (delta < -0.5) delta += 1;
        if (delta > 0.5) delta -= 1;
        totalProgress += delta;

        observation = result.observation;

        if (result.done) break;
      }

      const samplesThisEp = observations.length;
      console.log(`  BC Episode ${ep + 1}: ${samplesThisEp} total samples, progress=${(totalProgress * 100).toFixed(1)}%`);
    }

    // Log action and offset statistics
    if (actionCount > 0) {
      const avgX = totalActionX / actionCount;
      const avgY = totalActionY / actionCount;
      const avgOffset = totalOffset / actionCount;
      console.log(`  BC Action Stats: avgX=${avgX.toFixed(4)}, avgY=${avgY.toFixed(4)}`);
      console.log(`  BC Offset Stats: avgOffset=${avgOffset.toFixed(4)} (positive=right, should be ~0)`);
    }

    console.log(`Collected ${observations.length} demonstration samples`);

    // Train agent on demonstrations (multiple passes for better learning)
    if (this.agent instanceof ActorCriticAgent) {
      const batchSize = 64;  // Smaller batches for better gradient signal
      const epochs = 20;     // More epochs to ensure good fit

      for (let epoch = 0; epoch < epochs; epoch++) {
        // Shuffle data
        const indices = Array.from({ length: observations.length }, (_, i) => i);
        for (let i = indices.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [indices[i], indices[j]] = [indices[j], indices[i]];
        }

        let totalLoss = 0;
        let numBatches = 0;

        // Train in batches
        for (let i = 0; i < indices.length; i += batchSize) {
          const batchIndices = indices.slice(i, i + batchSize);
          const batchObs = batchIndices.map(idx => observations[idx]);
          const batchActions = batchIndices.map(idx => actions[idx]);

          const result = await this.agent.trainSupervised(batchObs, batchActions);
          totalLoss += result.loss;
          numBatches++;
        }

        const avgLoss = totalLoss / numBatches;
        console.log(`  BC Epoch ${epoch + 1}/${epochs}: loss=${avgLoss.toFixed(4)}`);
      }

      // Test the trained agent with a quick evaluation
      console.log('  Testing BC-trained agent...');
      let testObs = this.env.reset();
      let testProgress = 0;
      let testSteps = 0;
      for (let step = 0; step < 200; step++) {
        const action = this.agent.getActionDeterministic(testObs.features);
        const result = this.env.step(action);

        // Log first few actions
        if (step < 5) {
          console.log(`    Test step ${step}: action=(${action.x.toFixed(3)}, ${action.y.toFixed(3)}) offset=${testObs.features[3].toFixed(3)}`);
        }

        const prevProg = testObs.features[2];
        const currProg = result.observation.features[2];
        let delta = currProg - prevProg;
        if (delta < -0.5) delta += 1;
        if (delta > 0.5) delta -= 1;
        testProgress += delta;
        testSteps++;

        if (result.done) break;
        testObs = result.observation;
      }
      console.log(`  BC Test: ${testSteps} steps, progress=${(testProgress * 100).toFixed(1)}%`);
    }
  }

  private logProgress(episode: number): void {
    const recentEpisodes = this.episodeHistory.slice(-this.config.evaluateEvery);
    const avgReward = recentEpisodes.reduce((sum, e) => sum + e.totalReward, 0) / recentEpisodes.length;
    const avgSteps = recentEpisodes.reduce((sum, e) => sum + e.steps, 0) / recentEpisodes.length;
    const lapsCompleted = recentEpisodes.filter(e => e.lapCompleted).length;

    // Get exploration level if available
    let explorationStr = '';
    if (this.useActorCritic && this.agent instanceof ActorCriticAgent) {
      explorationStr = ` | Exploration: ${this.agent.getExplorationLevel().toFixed(3)}`;
    } else if (!this.useActorCritic && this.agent instanceof NeuralNetworkAgent) {
      explorationStr = ` | Exploration: ${this.agent.getExplorationStd().toFixed(3)}`;
    }

    console.log(
      `Episode ${episode + 1}/${this.config.totalEpisodes} | ` +
      `Avg Reward: ${avgReward.toFixed(1)} | ` +
      `Avg Steps: ${avgSteps.toFixed(0)} | ` +
      `Laps: ${lapsCompleted}/${this.config.evaluateEvery}` +
      explorationStr
    );
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    if (this.agent.dispose) {
      this.agent.dispose();
    }
  }
}

/**
 * Utility function to train an agent with default settings.
 */
export async function trainAgent(
  config: Partial<TrainingConfig> = {},
  callbacks: TrainerCallbacks = {},
  useActorCritic: boolean = true
): Promise<{ agent: Agent; history: EpisodeStats[] }> {
  const trainer = new Trainer(config, callbacks, useActorCritic);
  const history = await trainer.train();
  return { agent: trainer.getAgent(), history };
}

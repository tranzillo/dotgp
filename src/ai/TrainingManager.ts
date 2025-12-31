import { Trainer } from './Trainer';
import { EpisodeRecorder } from './EpisodeRecorder';
import { ReplayController } from '../replay/ReplayController';
import { PlayerDemoTrainer } from './PlayerDemoTrainer';
import { ActorCriticAgent } from './ActorCriticAgent';
import { RLFineTuner } from './RLFineTuner';
import { SelfImitationLearner, type SILCallbacks } from './SelfImitationLearner';
import { agentStorage } from './AgentStorage';
import { encodeCompositeSeed } from '../timetrials/types';
import type { TrainingConfig } from './types';
import type { Game } from '../game/Game';
import type { DemoTrainingStats } from './DemonstrationTypes';
import type {
  AgentProfile,
  RLFineTuningConfig,
  TrainingProgress,
  TrainingResult,
  TrainingSession,
  RewardWeights,
  SILConfig,
  SILSession,
} from './AgentProfile';
import { createAgentProfile, DEFAULT_REWARD_WEIGHTS, DEFAULT_SIL_CONFIG } from './AgentProfile';
import type { LapReplay } from '../replay/types';

const DEFAULT_TRAINING_CONFIG: Partial<TrainingConfig> = {
  totalEpisodes: 100,
  maxStepsPerEpisode: 5000,
  rewardProfile: 'balanced',
  learningRate: 0.001,
  discountFactor: 0.99,
  hiddenLayers: [64, 64],
};

/**
 * Orchestrates training and episode replay.
 * UI is handled externally by HTMLReplayPanel.
 */
export class TrainingManager {
  private game: Game;
  private trainer: Trainer | null = null;
  private recorder: EpisodeRecorder;
  private replayController: ReplayController;
  private config: Partial<TrainingConfig>;

  private isTraining: boolean = false;
  private isReplaying: boolean = false;
  private demoTrainer: PlayerDemoTrainer | null = null;
  private demoTrainedAgent: ActorCriticAgent | null = null;

  // Agent profile management
  private currentAgentProfile: AgentProfile | null = null;
  private rlFineTuner: RLFineTuner | null = null;
  private currentRewardWeights: RewardWeights = { ...DEFAULT_REWARD_WEIGHTS };

  // Self-Imitation Learning
  private silLearner: SelfImitationLearner | null = null;
  private silCallbacks: SILCallbacks | null = null;

  constructor(game: Game) {
    this.game = game;
    this.recorder = new EpisodeRecorder(20);
    this.replayController = new ReplayController();
    this.config = { ...DEFAULT_TRAINING_CONFIG };
  }

  /**
   * Set training configuration.
   */
  setConfig(config: Partial<TrainingConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Start training (RL-based, mostly unused now - demo training preferred).
   */
  async startTraining(): Promise<void> {
    if (this.isTraining) return;

    this.isTraining = true;

    const totalEpisodes = this.config.totalEpisodes ?? 100;
    console.log(`Starting RL training for ${totalEpisodes} episodes`);

    // Create trainer with recorder integration
    this.trainer = new Trainer(
      {
        ...this.config,
        totalEpisodes,
      },
      {
        onEpisodeStart: (_episode, _trackSeed) => {
          // Episode tracking can be added if needed
        },
        onEpisodeEnd: (_stats) => {
          // Stats can be logged if needed
        },
        onStep: (_step, _reward, _action) => {
          // Frame recording handled by Trainer with its recorder
        },
        onTrainingComplete: () => {
          this.isTraining = false;

          // Inject trained agent into game
          if (this.trainer) {
            this.game.setAgent(this.trainer.getAgent());
          }
        },
      }
    );

    // Pass recorder to trainer for frame recording
    this.trainer.setRecorder(this.recorder);

    try {
      await this.trainer.train();
    } catch (error) {
      console.error('Training error:', error);
      this.isTraining = false;
    }
  }

  /**
   * Stop training.
   */
  stopTraining(): void {
    if (this.trainer) {
      this.trainer.stop();
    }
    this.isTraining = false;
  }

  /**
   * Start replaying a specific episode.
   */
  startReplay(episodeNumber: number): void {
    if (this.isTraining) return;

    const episode = this.recorder.getEpisode(episodeNumber);
    if (!episode) {
      console.warn(`Episode ${episodeNumber} not found`);
      return;
    }

    this.isReplaying = true;

    // Load episode into game's replay mode
    this.game.setReplayMode(episode);
    this.replayController.loadEpisode(episode);
    this.replayController.play();
  }

  /**
   * Stop replay.
   */
  stopReplay(): void {
    this.isReplaying = false;
    this.replayController.stop();
    this.game.exitReplayMode();
  }

  /**
   * Update replay state (called each frame).
   */
  updateReplay(): void {
    if (!this.isReplaying) return;

    if (this.replayController.isDone()) {
      this.stopReplay();
    }
  }

  /**
   * Get the replay controller for Game to use.
   */
  getReplayController(): ReplayController {
    return this.replayController;
  }

  /**
   * Get the episode recorder.
   */
  getRecorder(): EpisodeRecorder {
    return this.recorder;
  }

  /**
   * Check if currently training.
   */
  isCurrentlyTraining(): boolean {
    return this.isTraining;
  }

  /**
   * Check if currently replaying.
   */
  isCurrentlyReplaying(): boolean {
    return this.isReplaying;
  }

  /**
   * Get the trained agent (if available).
   */
  getTrainedAgent() {
    return this.trainer?.getAgent() ?? null;
  }

  /**
   * Save the trained agent to JSON.
   */
  saveAgent(): string | null {
    return this.trainer?.saveAgent() ?? null;
  }

  /**
   * Load an agent from JSON.
   */
  loadAgent(json: string): void {
    if (this.trainer) {
      this.trainer.loadAgent(json);
    }
  }

  /**
   * Reset the training manager.
   */
  reset(): void {
    this.stopTraining();
    this.stopReplay();
    this.recorder.clear();
    this.trainer = null;
    this.demoTrainer = null;
    this.demoTrainedAgent = null;
  }

  // ─────────────────────────────────────────────────────────────
  // Player Demo Training
  // ─────────────────────────────────────────────────────────────

  /**
   * Train an agent from player demonstrations for the current track.
   *
   * @param onProgress Optional callback for training progress
   * @returns The trained agent and stats, or null if training fails
   */
  async trainFromPlayerDemos(
    onProgress?: (epoch: number, loss: number) => void
  ): Promise<{ agent: ActorCriticAgent; stats: DemoTrainingStats } | null> {
    if (this.isTraining) {
      console.warn('Cannot start demo training - already training');
      return null;
    }

    // Get current track's composite seed
    const trackConfig = this.game.getFullTrackConfig();
    const compositeSeed = encodeCompositeSeed(trackConfig);

    console.log(`Starting demo training for track seed: ${compositeSeed}`);

    this.isTraining = true;

    try {
      // Create demo trainer with callbacks
      this.demoTrainer = new PlayerDemoTrainer(
        {
          epochs: 100,
          batchSize: 64,
          shuffle: true,
          logEvery: 10,
        },
        {
          onEpoch: (epoch, loss) => {
            onProgress?.(epoch, loss);
          },
          onComplete: (finalLoss, _avgLoss) => {
            console.log(`Demo training complete! Final loss: ${finalLoss.toFixed(6)}`);
          },
        }
      );

      // Train the agent
      const result = await this.demoTrainer.train(compositeSeed);

      // Store the trained agent
      this.demoTrainedAgent = result.agent;

      // Set agent name from profile if available
      if (this.currentAgentProfile) {
        this.demoTrainedAgent.setName(this.currentAgentProfile.name);
      }

      console.log(
        `Agent trained on ${result.stats.demonstrationsUsed} demos ` +
          `(${result.stats.totalSamples} samples)`
      );

      // Auto-activate the agent with proper reset
      this.activateDemoAgent();

      return result;
    } catch (error) {
      console.error('Demo training failed:', error);
      return null;
    } finally {
      this.isTraining = false;
    }
  }

  /**
   * Get the demo-trained agent.
   */
  getDemoTrainedAgent(): ActorCriticAgent | null {
    return this.demoTrainedAgent;
  }

  /**
   * Check if a demo-trained agent is available.
   */
  hasDemoTrainedAgent(): boolean {
    return this.demoTrainedAgent !== null;
  }

  /**
   * Activate the demo-trained agent for driving.
   * Resets the car to start position for a fresh lap.
   */
  activateDemoAgent(): void {
    if (this.demoTrainedAgent) {
      this.game.setAgent(this.demoTrainedAgent);
      this.game.getCar().setControlMode('ai');

      // Reset car to start position for a clean AI lap
      this.game.resetForNewLap();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Persistent Agent Profile Management
  // ─────────────────────────────────────────────────────────────

  /**
   * Create a new agent profile for the current track.
   */
  async createNewAgent(name: string): Promise<AgentProfile> {
    const trackConfig = this.game.getFullTrackConfig();
    const compositeSeed = encodeCompositeSeed(trackConfig);

    // Create a new agent with default architecture
    const agentConfig = {
      observationSize: 20,
      hiddenLayers: [128, 128],
      learningRate: 0.0003,
      discountFactor: 0.99,
    };
    const agent = new ActorCriticAgent(agentConfig);
    agent.setName(name);

    // Create profile with serialized model
    const profile = createAgentProfile(
      name,
      trackConfig,
      compositeSeed,
      agent.save(),
      agentConfig
    );
    // Apply current reward weights
    profile.rewardWeights = { ...this.currentRewardWeights };

    // Save to storage
    await agentStorage.saveAgent(profile);

    // Set as current
    this.currentAgentProfile = profile;
    this.demoTrainedAgent = agent;

    console.log(`Created new agent: ${name} for track ${compositeSeed}`);

    return profile;
  }

  /**
   * Load an agent profile from storage.
   */
  async loadAgentProfile(agentId: string): Promise<AgentProfile | null> {
    const profile = await agentStorage.getAgent(agentId);
    if (!profile) {
      console.warn(`Agent ${agentId} not found`);
      return null;
    }

    // Create agent from saved model using stored config
    const agent = new ActorCriticAgent(profile.agentConfig);
    agent.load(profile.model);
    agent.setName(profile.name);

    // Set as current
    this.currentAgentProfile = profile;
    this.demoTrainedAgent = agent;
    this.currentRewardWeights = { ...profile.rewardWeights };

    console.log(`Loaded agent: ${profile.name}`);

    return profile;
  }

  /**
   * Save the current agent profile to storage.
   */
  async saveAgentProfile(): Promise<void> {
    if (!this.currentAgentProfile || !this.demoTrainedAgent) {
      console.warn('No current agent to save');
      return;
    }

    // Update model in profile
    this.currentAgentProfile.model = this.demoTrainedAgent.save();
    this.currentAgentProfile.updatedAt = Date.now();
    this.currentAgentProfile.rewardWeights = { ...this.currentRewardWeights };

    await agentStorage.saveAgent(this.currentAgentProfile);
    console.log(`Saved agent: ${this.currentAgentProfile.name}`);
  }

  /**
   * Delete an agent profile.
   */
  async deleteAgent(agentId: string): Promise<void> {
    await agentStorage.deleteAgent(agentId);

    // Clear current if deleted
    if (this.currentAgentProfile?.id === agentId) {
      this.currentAgentProfile = null;
      this.demoTrainedAgent = null;
    }
  }

  /**
   * Get the current agent profile.
   */
  getCurrentAgentProfile(): AgentProfile | null {
    return this.currentAgentProfile;
  }

  /**
   * Activate an agent by its profile ID.
   */
  async activateAgentById(agentId: string): Promise<boolean> {
    const profile = await this.loadAgentProfile(agentId);
    if (!profile) return false;

    this.activateDemoAgent();
    return true;
  }

  /**
   * Record an AI lap completion and update the agent profile stats.
   * Called when the active agent completes a valid lap during live play.
   */
  async recordAILapCompletion(lapTime: number): Promise<void> {
    if (!this.currentAgentProfile) {
      return;
    }

    // Update best lap time if this is faster
    if (
      this.currentAgentProfile.bestLapTime === null ||
      lapTime < this.currentAgentProfile.bestLapTime
    ) {
      this.currentAgentProfile.bestLapTime = lapTime;
    }

    // Increment laps completed
    this.currentAgentProfile.lapsCompleted++;

    // Update average lap time (simple running average)
    if (this.currentAgentProfile.avgLapTime === null) {
      this.currentAgentProfile.avgLapTime = lapTime;
    } else {
      // Exponential moving average with alpha = 0.3
      this.currentAgentProfile.avgLapTime =
        0.3 * lapTime + 0.7 * this.currentAgentProfile.avgLapTime;
    }

    this.currentAgentProfile.updatedAt = Date.now();

    // Save to storage
    await agentStorage.saveAgent(this.currentAgentProfile);
    console.log(
      `Agent ${this.currentAgentProfile.name} lap recorded: ${lapTime.toFixed(2)}s (best: ${this.currentAgentProfile.bestLapTime?.toFixed(2)}s)`
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Reward Weights Management
  // ─────────────────────────────────────────────────────────────

  /**
   * Set reward weights for training.
   */
  setRewardWeights(weights: RewardWeights): void {
    this.currentRewardWeights = { ...weights };
  }

  /**
   * Get current reward weights.
   */
  getRewardWeights(): RewardWeights {
    return { ...this.currentRewardWeights };
  }

  // ─────────────────────────────────────────────────────────────
  // RL Fine-Tuning
  // ─────────────────────────────────────────────────────────────

  /**
   * Start RL fine-tuning for the current agent.
   *
   * @param config RL fine-tuning configuration
   * @param lapIds IDs of laps to use as demonstrations
   * @param onProgress Progress callback
   * @returns Training result or null if failed
   */
  async startRLFineTuning(
    config: RLFineTuningConfig,
    lapIds: string[],
    onProgress?: (progress: TrainingProgress) => void
  ): Promise<TrainingResult | null> {
    if (this.isTraining) {
      console.warn('Cannot start RL fine-tuning - already training');
      return null;
    }

    if (!this.demoTrainedAgent) {
      console.warn('No agent to fine-tune - create or load one first');
      return null;
    }

    const trackConfig = this.game.getFullTrackConfig();
    const compositeSeed = encodeCompositeSeed(trackConfig);

    console.log(`Starting RL fine-tuning for track ${compositeSeed}`);
    console.log(`Using ${lapIds.length} laps as demonstrations`);

    this.isTraining = true;

    try {
      // Create RL fine-tuner with current agent and config
      this.rlFineTuner = new RLFineTuner(this.demoTrainedAgent, {
        ...config,
        rewardWeights: this.currentRewardWeights,
      });

      // Load demonstrations from selected laps
      await this.rlFineTuner.loadDemonstrations(lapIds);

      // Set up progress callback
      if (onProgress) {
        this.rlFineTuner.setCallbacks(onProgress, () => {});
      }

      // Run training
      const result = await this.rlFineTuner.train(compositeSeed);

      // Record training session in profile
      if (this.currentAgentProfile) {
        const session: TrainingSession = {
          id: `session-${Date.now()}`,
          timestamp: Date.now(),
          mode: config.bcWarmUpEpochs > 0 ? 'bc+rl' : 'rl',
          epochs: config.episodes,
          lapIds,
          rewardWeights: { ...this.currentRewardWeights },
          avgReward: result.finalAvgReward,
          bestLapTime: result.bestLapTime ?? undefined,
        };

        this.currentAgentProfile.trainingSessions.push(session);
        this.currentAgentProfile.totalEpochs += config.episodes;

        if (result.bestLapTime !== null) {
          if (
            this.currentAgentProfile.bestLapTime === null ||
            result.bestLapTime < this.currentAgentProfile.bestLapTime
          ) {
            this.currentAgentProfile.bestLapTime = result.bestLapTime;
          }
        }

        // Save updated profile
        await this.saveAgentProfile();
      }

      console.log(
        `RL fine-tuning complete! Avg reward: ${result.finalAvgReward.toFixed(2)}, ` +
          `Best lap: ${result.bestLapTime?.toFixed(2) ?? 'N/A'}s`
      );

      // Auto-activate the fine-tuned agent
      this.activateDemoAgent();

      return result;
    } catch (error) {
      console.error('RL fine-tuning failed:', error);
      return null;
    } finally {
      this.isTraining = false;
      this.rlFineTuner = null;
    }
  }

  /**
   * Stop RL fine-tuning in progress.
   */
  stopRLFineTuning(): void {
    if (this.rlFineTuner) {
      this.rlFineTuner.stop();
    }
  }

  /**
   * Train agent from demos and create/update agent profile.
   * Enhanced version that integrates with agent profiles.
   */
  async trainAgentFromDemos(
    lapIds: string[],
    agentId?: string,
    onProgress?: (epoch: number, loss: number) => void,
    epochs: number = 100
  ): Promise<{ agent: ActorCriticAgent; stats: DemoTrainingStats } | null> {
    if (this.isTraining) {
      console.warn('Cannot start demo training - already training');
      return null;
    }

    // Load or create agent profile
    if (agentId) {
      await this.loadAgentProfile(agentId);
    }

    const trackConfig = this.game.getFullTrackConfig();
    const compositeSeed = encodeCompositeSeed(trackConfig);

    console.log(`Starting demo training for track seed: ${compositeSeed}`);
    console.log(`Using ${lapIds.length} selected laps`);

    this.isTraining = true;

    try {
      // Create demo trainer
      this.demoTrainer = new PlayerDemoTrainer(
        {
          epochs,
          batchSize: 64,
          shuffle: true,
          logEvery: 10,
        },
        {
          onEpoch: (epoch, loss) => {
            onProgress?.(epoch, loss);
          },
          onComplete: (finalLoss, _avgLoss) => {
            console.log(`Demo training complete! Final loss: ${finalLoss.toFixed(6)}`);
          },
        }
      );

      // Train with specific lap IDs - pass existing agent for fine-tuning
      const result = await this.demoTrainer.trainWithLapIds(lapIds, this.demoTrainedAgent ?? undefined);

      // Store the trained agent
      this.demoTrainedAgent = result.agent;

      // Set agent name from profile
      if (this.currentAgentProfile) {
        this.demoTrainedAgent.setName(this.currentAgentProfile.name);
      }

      // Update agent profile if we have one
      if (this.currentAgentProfile) {
        const session: TrainingSession = {
          id: `session-${Date.now()}`,
          timestamp: Date.now(),
          mode: 'bc',
          epochs,
          lapIds,
          rewardWeights: { ...this.currentRewardWeights },
        };

        this.currentAgentProfile.trainingSessions.push(session);
        this.currentAgentProfile.totalEpochs += epochs;
        this.currentAgentProfile.totalSamples += result.stats.totalSamples;

        await this.saveAgentProfile();
      }

      console.log(
        `Agent trained on ${result.stats.demonstrationsUsed} demos ` +
          `(${result.stats.totalSamples} samples)`
      );

      // Auto-activate
      this.activateDemoAgent();

      return result;
    } catch (error) {
      console.error('Demo training failed:', error);
      return null;
    } finally {
      this.isTraining = false;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Self-Imitation Learning (SIL) - Instant Training
  // ─────────────────────────────────────────────────────────────

  /**
   * Start an Instant Self-Imitation Learning session.
   * Agent will drive laps and train immediately on each good lap.
   *
   * @param config SIL configuration (optional, uses defaults)
   * @param callbacks Callbacks for SIL events
   * @returns true if started successfully
   */
  async startSILSession(
    config: Partial<SILConfig> = {},
    callbacks: SILCallbacks = {}
  ): Promise<boolean> {
    if (!this.demoTrainedAgent) {
      console.warn('No agent to run SIL - create or load one first');
      return false;
    }

    if (this.silLearner?.isActive()) {
      console.warn('SIL session already running');
      return false;
    }

    const trackConfig = this.game.getFullTrackConfig();
    const compositeSeed = encodeCompositeSeed(trackConfig);

    // Merge config with defaults
    const silConfig: SILConfig = { ...DEFAULT_SIL_CONFIG, ...config };

    // Store callbacks for external use
    this.silCallbacks = callbacks;

    // Create SIL learner with simplified callbacks
    this.silLearner = new SelfImitationLearner(
      this.demoTrainedAgent,
      silConfig,
      {
        onLapCollected: (lap, score) => {
          callbacks.onLapCollected?.(lap, score);
        },
        onImprovement: async (oldBest, newBest) => {
          callbacks.onImprovement?.(oldBest, newBest);

          // Update agent profile best lap time
          if (this.currentAgentProfile) {
            this.currentAgentProfile.bestLapTime = newBest;
            await this.saveAgentProfile();
          }
        },
        onSessionEnd: (session) => {
          callbacks.onSessionEnd?.(session);
        },
      }
    );

    // Start SIL session
    const agentBest = this.currentAgentProfile?.bestLapTime ?? undefined;
    this.silLearner.start(compositeSeed, agentBest);

    // Load user-selected laps as training base
    await this.silLearner.loadSelectedLaps();

    // Activate agent and reset for driving
    this.activateDemoAgent();

    console.log(`SIL: Instant learning started for agent: ${this.currentAgentProfile?.name ?? 'Unknown'}`);

    return true;
  }

  /**
   * Stop the active SIL session.
   */
  stopSILSession(): void {
    if (this.silLearner) {
      this.silLearner.stop();
      this.silLearner = null;
    }
    this.silCallbacks = null;
  }

  /**
   * Check if SIL session is active.
   */
  isSILActive(): boolean {
    return this.silLearner?.isActive() ?? false;
  }

  /**
   * Get current SIL session info.
   */
  getSILSession(): SILSession | null {
    return this.silLearner?.getSession() ?? null;
  }

  /**
   * Notify SIL of a completed lap.
   * Called from Game when agent completes a lap.
   */
  async onSILLapComplete(lap: LapReplay): Promise<void> {
    if (this.silLearner?.isActive()) {
      await this.silLearner.onLapComplete(lap);
    }
  }

  /**
   * Get number of good laps collected by SIL.
   */
  getSILCollectedLapCount(): number {
    return this.silLearner?.getCollectedLapCount() ?? 0;
  }

  /**
   * Check if SIL is currently training.
   */
  isSILTraining(): boolean {
    return this.silLearner?.isTraining() ?? false;
  }

  /**
   * Get current SIL callbacks (for external notification integration).
   */
  getSILCallbacks(): SILCallbacks | null {
    return this.silCallbacks;
  }
}

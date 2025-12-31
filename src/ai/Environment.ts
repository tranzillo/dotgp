import { PhysicsEngine } from '../physics/PhysicsEngine';
import { Car } from '../entities/Car';
import { Track } from '../track/Track';
import { TrackGenerator } from '../track/TrackGenerator';
import { RaceTimer } from '../race/RaceTimer';
import { Vector2 } from '../utils/Vector2';
import { CONFIG } from '../utils/Constants';
import { ObservationBuilder } from './ObservationBuilder';
import { RewardCalculator } from './RewardCalculator';
import type { EnvConfig, StepResult, StateSnapshot, Action, Observation } from './types';

const DEFAULT_CONFIG: EnvConfig = {
  maxStepsPerEpisode: 5000,
  rewardProfile: 'balanced',
  trackSeed: undefined,
};

// Boundary constants for episode termination
const MAX_DISTANCE_FROM_TRACK = 150; // Max distance from track centerline before episode ends
const CANVAS_MARGIN = 50; // Margin outside canvas before episode ends

// Stuck detection constants
const STUCK_SPEED_THRESHOLD = 0.3; // Speed below this while off-track is considered stuck
const STUCK_STEPS_LIMIT = 100; // Steps stuck before terminating episode

/**
 * Extended metrics tracked during episodes for curriculum training.
 */
export interface EpisodeMetrics {
  centerlineDeviations: number[];
  offTrackSteps: number;
  cuttingViolations: number;
  cuttingProgressGained: number;
  prevTrackProgress: number;
}

export class Environment {
  private config: EnvConfig;
  private physicsEngine: PhysicsEngine;
  private car: Car;
  private track: Track;
  private raceTimer: RaceTimer;
  private observationBuilder: ObservationBuilder;
  private rewardCalculator: RewardCalculator;

  private episodeSteps: number = 0;
  private prevState: StateSnapshot | null = null;
  private totalReward: number = 0;
  private stuckCounter: number = 0; // Tracks consecutive steps where car is stuck off-track

  // Extended metrics for curriculum training
  private episodeMetrics: EpisodeMetrics = {
    centerlineDeviations: [],
    offTrackSteps: 0,
    cuttingViolations: 0,
    cuttingProgressGained: 0,
    prevTrackProgress: 0,
  };

  constructor(config: Partial<EnvConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Create physics engine
    this.physicsEngine = new PhysicsEngine();

    // Generate track
    const seed = this.config.trackSeed ?? Math.floor(Math.random() * 1000000);
    this.track = this.generateTrack(seed);

    // Create car at spawn
    const spawnPos = this.track.getSpawnPosition();
    this.car = new Car(this.physicsEngine, spawnPos.x, spawnPos.y);
    this.car.setControlMode('ai');

    // Create race timer
    this.raceTimer = new RaceTimer(this.track);
    this.raceTimer.startRace(this.car, { totalLaps: 0 });

    // Create observation and reward components
    this.observationBuilder = new ObservationBuilder();
    this.rewardCalculator = new RewardCalculator(this.config.rewardProfile);
  }

  private generateTrack(seed: number): Track {
    const generator = new TrackGenerator({
      seed,
      centerX: CONFIG.CANVAS_WIDTH / 2,
      centerY: CONFIG.CANVAS_HEIGHT / 2,
    });
    return generator.generate();
  }

  /**
   * Reset environment to initial state.
   * Returns the initial observation.
   */
  reset(trackSeed?: number): Observation {
    // Generate new track if seed provided
    if (trackSeed !== undefined) {
      this.track = this.generateTrack(trackSeed);
      this.raceTimer = new RaceTimer(this.track);
    }

    // Reset car to spawn position with correct initial heading
    const spawnPos = this.track.getSpawnPosition();
    const spawnAngle = this.track.getSpawnAngle();
    this.car.reset(spawnPos.x, spawnPos.y, spawnAngle);
    this.car.setControlMode('ai');

    // Reset race timer
    this.raceTimer.resetTimer();
    this.raceTimer.startRace(this.car, { totalLaps: 0 });

    // Reset episode state
    this.episodeSteps = 0;
    this.totalReward = 0;
    this.stuckCounter = 0;
    this.rewardCalculator.reset();

    // Reset extended metrics
    this.episodeMetrics = {
      centerlineDeviations: [],
      offTrackSteps: 0,
      cuttingViolations: 0,
      cuttingProgressGained: 0,
      prevTrackProgress: 0,
    };

    // Capture initial state
    this.prevState = this.captureState();

    return this.observationBuilder.build(this.car, this.track);
  }

  /**
   * Take a single step in the environment.
   * Returns observation, reward, done flag, and info.
   */
  step(action: Action): StepResult {
    if (!this.prevState) {
      throw new Error('Environment must be reset before stepping');
    }

    this.episodeSteps++;

    // Apply action as acceleration
    const accel = new Vector2(action.x, action.y);

    // Debug: log action and state every 500 steps
    if (this.episodeSteps % 500 === 1) {
      console.log(`Step ${this.episodeSteps}: action=(${action.x.toFixed(3)}, ${action.y.toFixed(3)}) mag=${accel.magnitude().toFixed(3)} speed=${this.car.getSpeed().toFixed(3)} fuel=${this.car.state.fuel.toFixed(1)}`);
    }

    this.car.applyAcceleration(accel);

    // Update physics (single timestep)
    const deltaTime = CONFIG.PHYSICS_TIMESTEP / 1000;
    this.physicsEngine.update(deltaTime);

    // Update car state
    this.car.state.isOnTrack = this.track.isPointOnTrack(this.car.getPosition());
    this.car.state.isInPit = this.track.isPointInPitZone(this.car.getPosition());
    this.car.update(deltaTime);

    // Update race timer
    this.raceTimer.update(this.car, deltaTime);

    // Capture current state
    const currState = this.captureState();

    // Update stuck detection
    this.updateStuckCounter(currState);

    // Update extended metrics for curriculum training
    this.updateEpisodeMetrics(currState);

    // Check if lap was completed this step
    const raceState = this.car.state.raceState;
    const lapCompleted = raceState.currentLap > (this.prevState.carState.raceState.currentLap);
    const lapTime = lapCompleted ? this.getLastLapTime() : null;

    // Calculate reward (pass episode steps for early direction boost)
    const reward = this.rewardCalculator.calculate(
      this.prevState,
      currState,
      lapCompleted,
      lapTime,
      this.episodeSteps
    );
    this.totalReward += reward;

    // Check if episode is done
    const done = this.checkDone();

    // Build observation
    const observation = this.observationBuilder.build(this.car, this.track);

    // Build info
    const info = {
      lapCompleted,
      lapTime: lapTime || 0,
      offTrack: !currState.carState.isOnTrack,
      wrongDirection: this.checkWrongDirection(currState),
      episodeSteps: this.episodeSteps,
    };

    // Store current state for next step
    this.prevState = currState;

    return { observation, reward, done, info };
  }

  /**
   * Take multiple physics steps for a single action (for faster training).
   */
  stepMultiple(action: Action, steps: number = 4): StepResult {
    let result: StepResult | null = null;
    let totalReward = 0;

    for (let i = 0; i < steps; i++) {
      result = this.step(action);
      totalReward += result.reward;

      if (result.done) break;
    }

    if (!result) {
      throw new Error('No steps taken');
    }

    // Return final observation with accumulated reward
    return {
      ...result,
      reward: totalReward,
    };
  }

  private captureState(): StateSnapshot {
    const closestPoint = this.track.getClosestTrackPoint(this.car.getPosition());
    const trackIndex = closestPoint?.index ?? 0;
    const trackProgress = this.track.getTrackProgress(this.car.getPosition());
    const distanceFromTrack = closestPoint?.distance ?? 0;

    // Calculate heading alignment (how well velocity aligns with track direction)
    const vel = this.car.getVelocity();
    const speed = this.car.getSpeed();
    let headingAlignment = 0;
    if (closestPoint && speed > 0.1) {
      const tangent = closestPoint.trackPoint.tangent;
      // Dot product of normalized velocity with NEGATED track tangent
      // (raw tangent points toward decreasing progress, we want increasing progress)
      headingAlignment = -(vel.x * tangent.x + vel.y * tangent.y) / speed;
    }

    // Calculate center offset (-1 left edge, 0 center, 1 right edge)
    let centerOffset = 0;
    if (closestPoint) {
      const pos = this.car.getPosition();
      const trackPoint = closestPoint.trackPoint;
      const dx = pos.x - trackPoint.position.x;
      const dy = pos.y - trackPoint.position.y;
      const offset = dx * trackPoint.normal.x + dy * trackPoint.normal.y;
      const halfWidth = trackPoint.width / 2;
      centerOffset = Math.max(-1, Math.min(1, offset / halfWidth));
    }

    return {
      carState: { ...this.car.state },
      trackProgress,
      trackIndex,
      speed: this.car.getSpeed(),
      distanceFromTrack,
      headingAlignment,
      centerOffset,
    };
  }

  private checkDone(): boolean {
    // Max steps reached
    if (this.episodeSteps >= this.config.maxStepsPerEpisode) {
      return true;
    }

    // Car is out of fuel
    if (this.car.state.fuel <= 0) {
      return true;
    }

    // Car health depleted (if using damage system)
    if (this.car.state.health <= 0) {
      return true;
    }

    // Car is too far from track
    const closestPoint = this.track.getClosestTrackPoint(this.car.getPosition());
    if (closestPoint && closestPoint.distance > MAX_DISTANCE_FROM_TRACK) {
      return true;
    }

    // Car is off canvas
    const pos = this.car.getPosition();
    if (pos.x < -CANVAS_MARGIN || pos.x > CONFIG.CANVAS_WIDTH + CANVAS_MARGIN ||
        pos.y < -CANVAS_MARGIN || pos.y > CONFIG.CANVAS_HEIGHT + CANVAS_MARGIN) {
      return true;
    }

    // Car is stuck off-track (slow speed while off-track for too long)
    if (this.stuckCounter >= STUCK_STEPS_LIMIT) {
      return true;
    }

    return false;
  }

  /**
   * Update stuck counter based on current state.
   * Called each step to track if car is trapped off-track.
   */
  private updateStuckCounter(state: StateSnapshot): void {
    const isOffTrack = !state.carState.isOnTrack;
    const isSlowSpeed = state.speed < STUCK_SPEED_THRESHOLD;

    if (isOffTrack && isSlowSpeed) {
      this.stuckCounter++;
    } else {
      // Reset counter if back on track or moving fast enough
      this.stuckCounter = 0;
    }
  }

  /**
   * Update extended metrics for curriculum training.
   * Tracks centerline deviation, off-track time, and cutting violations.
   */
  private updateEpisodeMetrics(state: StateSnapshot): void {
    // Track centerline deviation
    this.episodeMetrics.centerlineDeviations.push(Math.abs(state.centerOffset));

    // Track off-track steps
    if (!state.carState.isOnTrack) {
      this.episodeMetrics.offTrackSteps++;

      // Detect cutting: forward progress while off-track
      const progressDelta = this.calculateProgressDelta(
        this.episodeMetrics.prevTrackProgress,
        state.trackProgress
      );

      if (progressDelta > 0.001) {
        this.episodeMetrics.cuttingViolations++;
        this.episodeMetrics.cuttingProgressGained += progressDelta;
      }
    }

    // Update previous progress for next step
    this.episodeMetrics.prevTrackProgress = state.trackProgress;
  }

  /**
   * Calculate progress delta, handling wrap-around at lap boundary.
   */
  private calculateProgressDelta(prevProgress: number, currProgress: number): number {
    let delta = currProgress - prevProgress;

    // Handle wrap-around when crossing finish line
    if (delta < -0.5) {
      delta += 1;
    } else if (delta > 0.5) {
      delta -= 1;
    }

    return delta;
  }

  private checkWrongDirection(state: StateSnapshot): boolean {
    if (!this.prevState) return false;

    // Significant backward movement on track
    const progressDelta = state.trackProgress - this.prevState.trackProgress;

    // Handle wrap-around
    let delta = progressDelta;
    if (delta > 0.5) delta -= 1;
    if (delta < -0.5) delta += 1;

    return delta < -0.01;
  }

  private getLastLapTime(): number | null {
    const lastLap = this.raceTimer.getLastLap(this.car);
    return lastLap?.totalTime ?? null;
  }

  /**
   * Get the observation size for neural network input layer.
   */
  getObservationSize(): number {
    return this.observationBuilder.getObservationSize();
  }

  /**
   * Get current episode statistics.
   */
  getEpisodeStats() {
    const raceState = this.car.state.raceState;
    return {
      steps: this.episodeSteps,
      totalReward: this.totalReward,
      lapsCompleted: raceState.currentLap,
      bestLapTime: raceState.bestLapTime < Infinity ? raceState.bestLapTime : null,
      offTrackCount: raceState.offTrackCount,
      speed: this.car.getSpeed(),
      fuel: this.car.state.fuel,
      grip: this.car.state.grip,
    };
  }

  /**
   * Get direct access to game objects (for visualization).
   */
  getCar(): Car {
    return this.car;
  }

  getTrack(): Track {
    return this.track;
  }

  getRaceTimer(): RaceTimer {
    return this.raceTimer;
  }

  getPhysicsEngine(): PhysicsEngine {
    return this.physicsEngine;
  }

  /**
   * Set reward profile.
   */
  setRewardProfile(profile: 'speed' | 'strategy' | 'balanced'): void {
    this.rewardCalculator.setProfile(profile);
  }

  /**
   * Set curriculum training parameters on the reward calculator.
   */
  setCurriculumParams(centerlineWeight: number, cuttingPenaltyEnabled: boolean = true): void {
    this.rewardCalculator.setCurriculumParams(centerlineWeight, cuttingPenaltyEnabled);
  }

  /**
   * Get extended episode metrics for curriculum training.
   */
  getExtendedMetrics(): {
    avgCenterlineDeviation: number;
    maxCenterlineDeviation: number;
    offTrackPercentage: number;
    cuttingViolations: number;
    cuttingProgressGained: number;
  } {
    const deviations = this.episodeMetrics.centerlineDeviations;
    return {
      avgCenterlineDeviation:
        deviations.length > 0
          ? deviations.reduce((a, b) => a + b, 0) / deviations.length
          : 0,
      maxCenterlineDeviation:
        deviations.length > 0 ? Math.max(...deviations) : 0,
      offTrackPercentage:
        this.episodeSteps > 0
          ? (this.episodeMetrics.offTrackSteps / this.episodeSteps) * 100
          : 0,
      cuttingViolations: this.episodeMetrics.cuttingViolations,
      cuttingProgressGained: this.episodeMetrics.cuttingProgressGained,
    };
  }
}

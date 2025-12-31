import type { StateSnapshot, RewardProfile } from './types';

const MAX_SPEED = 15;
const TRACK_WIDTH = 40; // Approximate track width for distance normalization

// Cutting detection constants
const CUTTING_PROGRESS_THRESHOLD = 0.001; // Minimum progress to count as cutting
const CUTTING_PENALTY_MULTIPLIER = 50; // Penalty scale for cutting

// Centerline reward constants
const CENTERLINE_REWARD_SCALE = 0.5; // Max reward for perfect centering

export class RewardCalculator {
  private profile: RewardProfile;

  // Cutting detection state
  private cuttingProgressAccumulator: number = 0;

  // Curriculum training state
  private centerlineWeight: number = 0;
  private cuttingPenaltyEnabled: boolean = false;

  constructor(profile: RewardProfile = 'balanced') {
    this.profile = profile;
  }

  setProfile(profile: RewardProfile): void {
    this.profile = profile;
  }

  /**
   * Set curriculum training parameters.
   *
   * @param centerlineWeight - Blend weight for centerline reward (0-1).
   *   0 = pure speed optimization, 1 = pure centerline following
   * @param cuttingPenaltyEnabled - Whether to apply cutting penalty
   */
  setCurriculumParams(centerlineWeight: number, cuttingPenaltyEnabled: boolean = true): void {
    this.centerlineWeight = Math.max(0, Math.min(1, centerlineWeight));
    this.cuttingPenaltyEnabled = cuttingPenaltyEnabled;
  }

  reset(): void {
    // Reset cutting detection state
    this.cuttingProgressAccumulator = 0;
  }

  /**
   * Calculate reward based on state transition.
   */
  calculate(
    prevState: StateSnapshot,
    currState: StateSnapshot,
    lapCompleted: boolean,
    lapTime: number | null,
    episodeSteps: number = 0
  ): number {
    switch (this.profile) {
      case 'speed':
        return this.calculateSpeedReward(prevState, currState, lapCompleted, lapTime, episodeSteps);
      case 'strategy':
        return this.calculateStrategyReward(prevState, currState, lapCompleted, episodeSteps);
      case 'simple':
        return this.calculateSimpleReward(prevState, currState, lapCompleted);
      case 'balanced':
      default:
        return this.calculateBalancedReward(prevState, currState, lapCompleted, lapTime, episodeSteps);
    }
  }

  /**
   * Speed profile: Optimize for fastest lap time.
   */
  private calculateSpeedReward(
    prevState: StateSnapshot,
    currState: StateSnapshot,
    lapCompleted: boolean,
    lapTime: number | null,
    episodeSteps: number
  ): number {
    let reward = 0;

    // Progress reward (main driver of forward movement)
    const progressDelta = this.calculateProgressDelta(prevState.trackProgress, currState.trackProgress);
    reward += progressDelta * 200;

    // Pure speed bonus - ALWAYS positive, scales with speed
    const normalizedSpeed = currState.speed / MAX_SPEED;
    reward += normalizedSpeed * 8.0;

    // Acceleration reward - reward for GAINING speed
    const speedGain = currState.speed - prevState.speed;
    if (speedGain > 0) {
      reward += speedGain * 2.0;
    }

    // Heading alignment bonus - reward facing the right direction
    // This is crucial for learning which way to go
    // Early boost: 2x multiplier in first 500 steps to help learn direction faster
    const directionMultiplier = episodeSteps < 500 ? 2.0 : 1.0;
    reward += currState.headingAlignment * 3.0 * directionMultiplier;

    // Off-track penalty (small)
    if (!currState.carState.isOnTrack) {
      reward -= 0.5;
    }

    // Distance from track penalty (guides car back to track)
    reward -= this.calculateDistancePenalty(currState.distanceFromTrack);

    // Recovery reward - incentivize moving back toward track when off-track
    reward += this.calculateRecoveryReward(prevState.distanceFromTrack, currState.distanceFromTrack);

    // Edge proximity penalty - warn before going off-track
    reward -= this.calculateEdgeProximityPenalty(currState.centerOffset);

    // Centerline bonus - reward staying centered
    reward += this.calculateCenterlineBonus(currState.centerOffset);

    // Wrong direction penalty
    if (progressDelta < -0.01) {
      reward -= 2;
    }

    // Lap completion bonus
    if (lapCompleted) {
      reward += 200;
      if (lapTime && lapTime < 60) {
        reward += (60 - lapTime) * 5;
      }
    }

    return reward;
  }

  /**
   * Strategy profile: Balance speed with resource management.
   */
  private calculateStrategyReward(
    prevState: StateSnapshot,
    currState: StateSnapshot,
    lapCompleted: boolean,
    episodeSteps: number
  ): number {
    let reward = 0;

    // Progress reward
    const progressDelta = this.calculateProgressDelta(prevState.trackProgress, currState.trackProgress);
    reward += progressDelta * 100;

    // Pure speed bonus
    const normalizedSpeed = currState.speed / MAX_SPEED;
    reward += normalizedSpeed * 5.0;

    // Acceleration reward
    const speedGain = currState.speed - prevState.speed;
    if (speedGain > 0) {
      reward += speedGain * 1.0;
    }

    // Heading alignment bonus
    // Early boost: 2x multiplier in first 500 steps to help learn direction faster
    const directionMultiplier = episodeSteps < 500 ? 2.0 : 1.0;
    reward += currState.headingAlignment * 2.0 * directionMultiplier;

    // Resource preservation rewards (still meaningful)
    reward += currState.carState.grip * 0.2;

    // Off-track penalty (small)
    if (!currState.carState.isOnTrack) {
      reward -= 0.5;
    }

    // Distance from track penalty (guides car back to track)
    reward -= this.calculateDistancePenalty(currState.distanceFromTrack);

    // Recovery reward - incentivize moving back toward track when off-track
    reward += this.calculateRecoveryReward(prevState.distanceFromTrack, currState.distanceFromTrack);

    // Edge proximity penalty - warn before going off-track
    reward -= this.calculateEdgeProximityPenalty(currState.centerOffset);

    // Centerline bonus - reward staying centered
    reward += this.calculateCenterlineBonus(currState.centerOffset);

    // Valid lap bonus
    if (lapCompleted) {
      if (currState.carState.raceState.currentLapValid) {
        reward += 300;
      } else {
        reward -= 30;
      }
    }

    return reward;
  }

  /**
   * Balanced profile: Simplified and stable for Actor-Critic training.
   *
   * Key design principles:
   * - Consistent reward scale (0-2 per step typical)
   * - No mid-training reward changes (removed direction boost that expires)
   * - Small lap bonus to prevent value function instability
   * - Let the critic learn which states are good/bad through returns
   */
  private calculateBalancedReward(
    prevState: StateSnapshot,
    currState: StateSnapshot,
    lapCompleted: boolean,
    _lapTime: number | null,
    _episodeSteps: number
  ): number {
    let reward = 0;

    // === CORE REWARDS (consistent, stable) ===

    // 1. Progress reward - THE most important signal
    // progressDelta is typically -0.01 to +0.01 per step
    const progressDelta = this.calculateProgressDelta(prevState.trackProgress, currState.trackProgress);
    // Only positive progress gets reward (negative handled by lower future returns)
    reward += Math.max(0, progressDelta * 100);  // 0.01 progress = 1.0 reward

    // 2. Heading alignment - CRITICAL for direction
    // headingAlignment: -1 (backwards) to +1 (correct direction)
    // This is derived from dot product of velocity with track tangent
    const heading = currState.headingAlignment;

    // Reward for going the right way (positive alignment)
    if (heading > 0) {
      reward += heading * 0.3;
    }

    // STRONG PENALTY for going the wrong way (negative alignment)
    // This is crucial - agents must learn immediately that backwards = bad
    if (heading < -0.3) {
      // Significant penalty for clearly going the wrong direction
      reward -= Math.abs(heading) * 1.5;  // Up to -1.5 penalty
    }

    // 3. Speed reward - small bonus for moving (only if going right way)
    const normalizedSpeed = Math.min(1, currState.speed / MAX_SPEED);
    if (heading > 0) {
      reward += normalizedSpeed * 0.2;
    }

    // 4. On-track bonus - small consistent reward for being on track
    if (currState.carState.isOnTrack) {
      reward += 0.1;
    }

    // === LAP COMPLETION (scaled down to prevent value function instability) ===
    if (lapCompleted) {
      reward += 10;  // Reduced from 100
      if (currState.carState.raceState.currentLapValid) {
        reward += 5;  // Reduced from 50
      }
    }

    // Total typical reward per step: 0.3 to 1.6 (on track, making progress)
    // This consistent scale helps the value function learn effectively

    return reward;
  }

  /**
   * Simple profile: RADICALLY SIMPLIFIED for initial learning.
   *
   * ONLY TWO THINGS MATTER:
   * 1. Follow track direction (heading alignment)
   * 2. Go fast (speed)
   *
   * NO penalties for:
   * - Being off-track (just less reward)
   * - Edge proximity
   * - Resources (fuel, grip, health)
   * - Centerline deviation
   *
   * This helps agents learn the basics without getting overwhelmed
   * and quitting before completing a single turn.
   */
  private calculateSimpleReward(
    prevState: StateSnapshot,
    currState: StateSnapshot,
    lapCompleted: boolean
  ): number {
    // === SIMPLE REWARD: Progress is everything ===
    //
    // The ONLY thing that matters is making forward progress around the track.
    // Everything else is just a small bonus/penalty to break ties.
    //
    // This fixes the bug where sitting still got 0 reward but trying got penalties.

    let reward = 0;

    // 1. FORWARD PROGRESS - This is THE signal (scaled to be dominant)
    const progressDelta = this.calculateProgressDelta(prevState.trackProgress, currState.trackProgress);
    reward += progressDelta * 100;  // +1.0 per 1% progress, -1.0 per 1% backwards

    // 2. SMALL TIME PENALTY - Sitting still should be worse than trying
    // This ensures doing nothing doesn't beat making mistakes
    reward -= 0.01;

    // 3. LAP COMPLETION - Nice bonus
    if (lapCompleted) {
      reward += 50;
    }

    // That's it! Progress is king. Going backwards hurts. Sitting still slowly hurts.
    // Typical reward per step when making progress: +0.5 to +1.0
    // Typical reward per step when sitting still: -0.01
    // Typical reward per step when going backwards: -0.5 to -1.0

    return reward;
  }

  /**
   * Calculate progress delta, handling wrap-around at lap boundary.
   */
  private calculateProgressDelta(prevProgress: number, currProgress: number): number {
    let delta = currProgress - prevProgress;

    // Handle wrap-around when crossing finish line
    if (delta < -0.5) {
      // Crossed from ~1.0 to ~0.0 (completed lap)
      delta += 1;
    } else if (delta > 0.5) {
      // Crossed from ~0.0 to ~1.0 (went backwards past start)
      delta -= 1;
    }

    return delta;
  }

  /**
   * Calculate penalty for distance from track centerline.
   * Returns 0 when on track, increasing penalty as car gets further away.
   */
  private calculateDistancePenalty(distanceFromTrack: number): number {
    // No penalty if within track width
    if (distanceFromTrack <= TRACK_WIDTH / 2) {
      return 0;
    }

    // Penalty increases quadratically with distance beyond track edge
    const excessDistance = distanceFromTrack - TRACK_WIDTH / 2;
    const normalizedExcess = excessDistance / TRACK_WIDTH;
    return normalizedExcess * normalizedExcess * 5.0;
  }

  /**
   * Calculate reward for moving toward the track (recovery incentive).
   * Returns positive reward when getting closer to track, negative when moving away.
   * This helps agents learn to recover from off-track situations.
   */
  private calculateRecoveryReward(prevDistance: number, currDistance: number): number {
    // Only apply when off-track (beyond track edge)
    const trackEdge = TRACK_WIDTH / 2;
    if (currDistance <= trackEdge && prevDistance <= trackEdge) {
      return 0; // Both on track, no recovery needed
    }

    // Calculate improvement (positive = getting closer to track)
    const improvement = prevDistance - currDistance;

    // Scale reward by how far off-track we are (more reward for recovering from far away)
    const offTrackAmount = Math.max(0, currDistance - trackEdge) / TRACK_WIDTH;
    const urgencyMultiplier = 1 + offTrackAmount * 2; // More urgent = more reward

    // Strong positive reward for moving toward track, penalty for moving away
    return improvement * urgencyMultiplier * 10.0;
  }

  /**
   * Calculate penalty for approaching track edges.
   * Creates a gradient that warns the agent BEFORE going off-track.
   */
  private calculateEdgeProximityPenalty(centerOffset: number): number {
    const edgeProximity = Math.abs(centerOffset);

    // No penalty in the safe zone (center 50% of track)
    if (edgeProximity < 0.5) {
      return 0;
    }

    // Increasing penalty as approaching edge (50% to 100% from center)
    const danger = (edgeProximity - 0.5) * 2; // 0 to 1
    return danger * danger * 2.0; // Quadratic penalty, max 2.0
  }

  /**
   * Calculate bonus for staying near the centerline.
   * Provides positive reinforcement for good positioning.
   */
  private calculateCenterlineBonus(centerOffset: number): number {
    // Bonus inversely proportional to distance from center
    // Max 0.5 at center, 0 at edges
    const centerBonus = 1.0 - Math.abs(centerOffset);
    return centerBonus * 0.5;
  }

  // ============================================================
  // CURRICULUM TRAINING METHODS
  // ============================================================

  /**
   * Calculate penalty for cutting corners (gaining progress while off-track).
   *
   * Cutting is detected when:
   * 1. Car is off-track
   * 2. Track progress is increasing (forward movement)
   *
   * This penalizes shortcuts while allowing legitimate recovery maneuvers
   * (which typically involve backward progress to get back on track).
   */
  private calculateCuttingPenalty(
    prevState: StateSnapshot,
    currState: StateSnapshot
  ): number {
    const isOffTrack = !currState.carState.isOnTrack;

    if (!isOffTrack) {
      // On track - no cutting penalty
      return 0;
    }

    // Calculate progress delta
    const progressDelta = this.calculateProgressDelta(
      prevState.trackProgress,
      currState.trackProgress
    );

    // Check for cutting: forward progress while off-track
    if (progressDelta > CUTTING_PROGRESS_THRESHOLD) {
      this.cuttingProgressAccumulator += progressDelta;
      // Penalty proportional to progress gained
      return -progressDelta * CUTTING_PENALTY_MULTIPLIER;
    }

    return 0;
  }

  /**
   * Calculate centerline following reward for curriculum training.
   *
   * Returns high reward for staying centered, lower for edges.
   * This provides a strong baseline behavior signal.
   */
  private calculateCenterlineReward(currState: StateSnapshot): number {
    // centerOffset is in [-1, 1] range
    // Transform to reward: 1.0 at center, 0 at edges
    const centeringScore = 1.0 - Math.abs(currState.centerOffset);
    return centeringScore * CENTERLINE_REWARD_SCALE;
  }

  /**
   * Calculate curriculum-aware reward that blends speed and centerline rewards.
   *
   * Used during curriculum training to gradually transition from
   * centerline-following behavior to speed optimization.
   *
   * @param prevState - Previous state snapshot
   * @param currState - Current state snapshot
   * @param lapCompleted - Whether a lap was just completed
   * @param lapTime - Lap time if completed
   * @param episodeSteps - Number of steps in current episode
   */
  calculateCurriculumReward(
    prevState: StateSnapshot,
    currState: StateSnapshot,
    lapCompleted: boolean,
    lapTime: number | null,
    episodeSteps: number
  ): number {
    // Get base speed-focused reward
    const speedReward = this.calculateBalancedReward(
      prevState,
      currState,
      lapCompleted,
      lapTime,
      episodeSteps
    );

    // Get centerline following reward
    const centerlineReward = this.calculateCenterlineReward(currState);

    // Get cutting penalty (if enabled)
    let cuttingPenalty = 0;
    if (this.cuttingPenaltyEnabled) {
      cuttingPenalty = this.calculateCuttingPenalty(prevState, currState);
    }

    // Blend rewards based on curriculum weight
    // weight = 0: pure speed
    // weight = 1: pure centerline
    const blendedReward =
      speedReward * (1 - this.centerlineWeight) +
      centerlineReward * this.centerlineWeight +
      cuttingPenalty;

    return blendedReward;
  }

  /**
   * Get accumulated cutting progress for metrics.
   */
  getCuttingProgress(): number {
    return this.cuttingProgressAccumulator;
  }

  /**
   * Get current curriculum centerline weight.
   */
  getCenterlineWeight(): number {
    return this.centerlineWeight;
  }
}

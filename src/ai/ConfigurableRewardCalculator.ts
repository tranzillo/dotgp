import type { StateSnapshot } from './types';
import type { RewardWeights } from './AgentProfile';
import { DEFAULT_REWARD_WEIGHTS } from './AgentProfile';

const MAX_SPEED = 15;

/**
 * Reward calculator with user-configurable weights.
 *
 * Each reward component is calculated independently, then weighted
 * and summed according to the provided RewardWeights.
 *
 * This allows users to tune agent behavior through sliders in the UI.
 */
export class ConfigurableRewardCalculator {
  private weights: RewardWeights;
  private cuttingProgressAccumulator: number = 0;

  constructor(weights: Partial<RewardWeights> = {}) {
    this.weights = { ...DEFAULT_REWARD_WEIGHTS, ...weights };
  }

  /**
   * Update reward weights (called when UI sliders change).
   */
  setWeights(weights: Partial<RewardWeights>): void {
    this.weights = { ...this.weights, ...weights };
  }

  /**
   * Get current weights (for UI display).
   */
  getWeights(): RewardWeights {
    return { ...this.weights };
  }

  /**
   * Reset per-episode state.
   * Call at the start of each episode.
   */
  reset(): void {
    this.cuttingProgressAccumulator = 0;
  }

  /**
   * Calculate total reward from state transition.
   *
   * @param prevState - Previous state snapshot
   * @param currState - Current state snapshot
   * @param lapCompleted - Whether a lap was just completed
   * @param lapValid - Whether the lap was valid (no cutting)
   * @returns Weighted sum of all reward components
   */
  calculate(
    prevState: StateSnapshot,
    currState: StateSnapshot,
    lapCompleted: boolean,
    lapValid: boolean
  ): number {
    const components = this.calculateComponents(prevState, currState, lapCompleted, lapValid);
    return this.sumWeightedComponents(components);
  }

  /**
   * Calculate individual reward components (for debugging/visualization).
   *
   * Each component is an unweighted raw value.
   * The final reward is the weighted sum of these.
   */
  calculateComponents(
    prevState: StateSnapshot,
    currState: StateSnapshot,
    lapCompleted: boolean,
    lapValid: boolean
  ): Record<keyof RewardWeights, number> {
    const progressDelta = this.calculateProgressDelta(
      prevState.trackProgress,
      currState.trackProgress
    );

    // 1. Progress reward (0-1 per step for typical progress)
    // progressDelta is typically 0-0.01 per step, multiply by 100 for reasonable scale
    const progressReward = Math.max(0, progressDelta * 100);

    // 2. Speed reward (0-1 based on normalized speed)
    const speedReward = Math.min(1, currState.speed / MAX_SPEED);

    // 3. Heading alignment (-1 to 1)
    // Reward for facing correct direction, penalty for wrong direction
    const headingReward = currState.headingAlignment;

    // 4. Centerline reward (0-1, 1 at center)
    // centerOffset is -1 to 1, where 0 is center
    const centerlineReward = 1.0 - Math.abs(currState.centerOffset);

    // 5. Off-track penalty (0 on track, -1 off track)
    const offTrackPenalty = currState.carState.isOnTrack ? 0 : -1;

    // 6. Lap completion bonus (scaled to be significant)
    const lapBonus = lapCompleted ? 10 : 0;

    // 7. Valid lap bonus (extra for clean lap)
    const validLapBonus = lapCompleted && lapValid ? 5 : 0;

    // 8. Cutting penalty (progress gained while off-track)
    let cuttingPenalty = 0;
    if (!currState.carState.isOnTrack && progressDelta > 0.001) {
      cuttingPenalty = -progressDelta * 50;
      this.cuttingProgressAccumulator += progressDelta;
    }

    // 9. Time penalty (small per-step cost to encourage speed)
    const timePenalty = -0.01;

    // 10. Grip conservation (reward for not overheating tires)
    const gripReward = currState.carState.grip;

    return {
      progress: progressReward,
      speed: speedReward,
      heading: headingReward,
      centerline: centerlineReward,
      offTrackPenalty: offTrackPenalty,
      lapBonus: lapBonus,
      validLapBonus: validLapBonus,
      cuttingPenalty: cuttingPenalty,
      timePenalty: timePenalty,
      gripConservation: gripReward,
    };
  }

  /**
   * Sum components with their weights.
   */
  private sumWeightedComponents(components: Record<keyof RewardWeights, number>): number {
    let total = 0;
    total += components.progress * this.weights.progress;
    total += components.speed * this.weights.speed;
    total += components.heading * this.weights.heading;
    total += components.centerline * this.weights.centerline;
    total += components.offTrackPenalty * this.weights.offTrackPenalty;
    total += components.lapBonus * this.weights.lapBonus;
    total += components.validLapBonus * this.weights.validLapBonus;
    total += components.cuttingPenalty * this.weights.cuttingPenalty;
    total += components.timePenalty * this.weights.timePenalty;
    total += components.gripConservation * this.weights.gripConservation;
    return total;
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
   * Get accumulated cutting progress for metrics.
   */
  getCuttingProgress(): number {
    return this.cuttingProgressAccumulator;
  }

  /**
   * Format reward breakdown for debugging.
   */
  formatBreakdown(
    prevState: StateSnapshot,
    currState: StateSnapshot,
    lapCompleted: boolean,
    lapValid: boolean
  ): string {
    const components = this.calculateComponents(prevState, currState, lapCompleted, lapValid);
    const lines: string[] = [];

    const keys: (keyof RewardWeights)[] = [
      'progress',
      'speed',
      'heading',
      'centerline',
      'offTrackPenalty',
      'lapBonus',
      'validLapBonus',
      'cuttingPenalty',
      'timePenalty',
      'gripConservation',
    ];

    for (const key of keys) {
      const raw = components[key];
      const weight = this.weights[key];
      const weighted = raw * weight;
      if (Math.abs(weighted) > 0.001) {
        lines.push(`  ${key}: ${raw.toFixed(3)} x ${weight.toFixed(2)} = ${weighted.toFixed(3)}`);
      }
    }

    const total = this.sumWeightedComponents(components);
    lines.push(`  TOTAL: ${total.toFixed(3)}`);

    return lines.join('\n');
  }
}

/**
 * Preset reward weight configurations.
 */
export const REWARD_PRESETS: Record<string, Partial<RewardWeights>> = {
  balanced: DEFAULT_REWARD_WEIGHTS,

  speed: {
    progress: 1.5,
    speed: 0.5,
    heading: 0.3,
    centerline: 0.1,
    offTrackPenalty: 0.3,
    lapBonus: 1.5,
    validLapBonus: 0.2,
    cuttingPenalty: 0.4,
    timePenalty: 0.2,
    gripConservation: 0.0,
  },

  safe: {
    progress: 0.8,
    speed: 0.2,
    heading: 0.6,
    centerline: 0.6,
    offTrackPenalty: 0.8,
    lapBonus: 0.8,
    validLapBonus: 0.8,
    cuttingPenalty: 1.0,
    timePenalty: 0.05,
    gripConservation: 0.3,
  },

  aggressive: {
    progress: 2.0,
    speed: 0.8,
    heading: 0.2,
    centerline: 0.0,
    offTrackPenalty: 0.2,
    lapBonus: 2.0,
    validLapBonus: 0.0,
    cuttingPenalty: 0.2,
    timePenalty: 0.3,
    gripConservation: 0.0,
  },
};

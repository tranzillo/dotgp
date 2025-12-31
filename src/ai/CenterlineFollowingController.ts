import type { Agent, TrainingBatch, TrainingResult } from './Agent';
import type { Action, SerializedModel } from './types';

/**
 * Configuration for the CenterlineFollowingController.
 */
export interface CenterlineControllerConfig {
  /** How much upcoming curvature affects target speed (0-1). Default: 0.7 */
  curvatureSpeedFactor: number;

  /** P-gain for centerline correction. Default: 0.5 */
  centeringGain: number;

  /** Maximum throttle output (0-1). Default: 0.9 */
  maxThrottle: number;

  /** Minimum throttle in sharp corners (0-1). Default: 0.3 */
  minCornerThrottle: number;

  /** Normalized target speed (0-1 of MAX_SPEED). Default: 0.8 */
  targetSpeedNormalized: number;

  /** Minimum normalized speed in corners. Default: 0.3 */
  minCornerSpeedNormalized: number;
}

const DEFAULT_CONFIG: CenterlineControllerConfig = {
  curvatureSpeedFactor: 0.7,
  centeringGain: 1.0,  // Increased from 0.5 for stronger centerline correction
  maxThrottle: 0.9,
  minCornerThrottle: 0.3,
  targetSpeedNormalized: 0.8,
  minCornerSpeedNormalized: 0.3,
};

/**
 * Observation feature indices (from ObservationBuilder).
 * Total: 20 features.
 */
const OBS = {
  SPEED: 0,                    // Normalized speed (0-1)
  HEADING_ANGLE: 1,            // Alignment with track (-1 to 1)
  TRACK_PROGRESS: 2,           // Lap progress (0-1)
  CENTERLINE_OFFSET: 3,        // Distance from center (-1 left to 1 right)
  VELOCITY_X: 4,               // Normalized vx
  VELOCITY_Y: 5,               // Normalized vy
  TRACK_TANGENT_X: 6,          // Current track direction x
  TRACK_TANGENT_Y: 7,          // Current track direction y
  TARGET_DIR_X: 8,             // Weighted lookahead direction x
  TARGET_DIR_Y: 9,             // Weighted lookahead direction y
  CURVATURE_START: 10,         // Lookahead curvature (5 values: 10-14)
  CURVATURE_END: 14,
  GRIP: 15,                    // Tire grip (0-1)
  FUEL: 16,                    // Fuel (0-1)
  IS_ON_TRACK: 17,             // 1 if on track, 0 if off
  EDGE_DIST_LEFT: 18,          // Distance to left edge (0-1)
  EDGE_DIST_RIGHT: 19,         // Distance to right edge (0-1)
};

/**
 * A sophisticated rule-based agent that follows the track centerline.
 *
 * This controller provides human-like baseline behavior:
 * 1. Follows the track using the weighted lookahead target direction
 * 2. Corrects for centerline deviation (stays centered)
 * 3. Modulates speed based on upcoming curvature (slows for corners)
 *
 * Designed to be used:
 * - As a standalone AI driver for baseline comparison
 * - As an expert for behavior cloning during curriculum training
 */
export class CenterlineFollowingController implements Agent {
  private name = 'CenterlineFollowingController';
  private config: CenterlineControllerConfig;

  constructor(config: Partial<CenterlineControllerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get action from current observation.
   *
   * Algorithm:
   * 1. Use track tangent as PRIMARY direction (this IS the correct way to go!)
   * 2. Blend with target direction for curve anticipation
   * 3. Apply centerline correction to stay centered
   * 4. Calculate target speed based on max upcoming curvature
   * 5. Output steering (x) and throttle (y)
   *
   * KEY INSIGHT: Track tangent (indices 6-7) tells us THE direction of the track.
   * This is not ambiguous - tangent always points in the racing direction.
   * GP tracks: clockwise (tangent follows clockwise path)
   * Ovals: counter-clockwise / left turns (tangent follows CCW path)
   */
  getAction(observation: number[]): Action {
    // Extract features
    const speed = observation[OBS.SPEED];
    const centerOffset = observation[OBS.CENTERLINE_OFFSET];
    const isOnTrack = observation[OBS.IS_ON_TRACK];

    // Get track tangent - now correctly points toward increasing progress
    // (ObservationBuilder negates the raw spline tangent)
    const trackTangentX = observation[OBS.TRACK_TANGENT_X];
    const trackTangentY = observation[OBS.TRACK_TANGENT_Y];

    // Get target direction (weighted lookahead) for curve anticipation
    const targetDirX = observation[OBS.TARGET_DIR_X];
    const targetDirY = observation[OBS.TARGET_DIR_Y];

    // Get lookahead curvatures (5 values)
    const curvatures: number[] = [];
    for (let i = OBS.CURVATURE_START; i <= OBS.CURVATURE_END; i++) {
      curvatures.push(Math.abs(observation[i]));
    }

    // Find max absolute curvature in lookahead window
    const maxCurvature = Math.max(...curvatures);

    // === STEERING ===
    // PRIMARY: Use track tangent as the base direction
    // This is THE direction we should be going - no ambiguity!
    // Blend with target direction for smoother curve handling
    const tangentWeight = 0.6; // Favor current tangent
    const targetWeight = 0.4;  // Some lookahead for curves

    let steerX = trackTangentX * tangentWeight + targetDirX * targetWeight;
    let steerY = trackTangentY * tangentWeight + targetDirY * targetWeight;

    // Normalize the blended direction
    let blendMag = Math.sqrt(steerX * steerX + steerY * steerY);
    if (blendMag > 0.001) {
      steerX /= blendMag;
      steerY /= blendMag;
    } else {
      // Fallback to pure tangent if blend fails
      steerX = trackTangentX;
      steerY = trackTangentY;
    }

    // Apply centerline correction
    // Normal is perpendicular to tangent (90° CCW): normal = (-tangent.y, tangent.x)
    // CenterOffset > 0 means car is toward positive normal direction
    // To correct, steer AWAY from the deviation (toward negative normal when offset > 0)
    const centerCorrection = -centerOffset * this.config.centeringGain;

    // Perpendicular to track tangent for centerline correction
    const normalX = -trackTangentY;
    const normalY = trackTangentX;

    // Add correction in the normal direction
    steerX += normalX * centerCorrection;
    steerY += normalY * centerCorrection;

    // Normalize steering direction
    const steerMag = Math.sqrt(steerX * steerX + steerY * steerY);
    if (steerMag > 0.001) {
      steerX /= steerMag;
      steerY /= steerMag;
    }

    // === THROTTLE ===
    // Calculate target speed based on curvature
    // Sharp curves = lower speed
    const speedRange =
      this.config.targetSpeedNormalized - this.config.minCornerSpeedNormalized;
    const curvatureEffect = maxCurvature * this.config.curvatureSpeedFactor;
    const targetSpeed =
      this.config.targetSpeedNormalized - curvatureEffect * speedRange;

    // Throttle based on difference from target speed
    let throttle: number;
    if (speed < targetSpeed * 0.8) {
      // Well below target: full throttle
      throttle = this.config.maxThrottle;
    } else if (speed < targetSpeed) {
      // Approaching target: moderate throttle
      const speedRatio = speed / targetSpeed;
      throttle = this.config.maxThrottle * (1 - (speedRatio - 0.8) / 0.2 * 0.5);
    } else if (speed > targetSpeed * 1.1) {
      // Above target: coast (no throttle)
      throttle = 0;
    } else {
      // Near target: gentle throttle to maintain
      throttle = this.config.minCornerThrottle;
    }

    // If off-track, reduce throttle to help recovery
    if (isOnTrack < 0.5) {
      throttle *= 0.5;
    }

    // Combine steering direction with throttle magnitude
    // The action space is 2D: x controls left/right, y controls throttle
    // We want to accelerate in the steering direction
    const actionX = steerX * throttle;
    const actionY = steerY * throttle;

    // Clamp to valid range
    return {
      x: Math.max(-1, Math.min(1, actionX)),
      y: Math.max(-1, Math.min(1, actionY)),
    };
  }

  /**
   * Deterministic action (same as regular action for rule-based controller).
   */
  getActionDeterministic(observation: number[]): Action {
    return this.getAction(observation);
  }

  /**
   * Update configuration at runtime.
   */
  setConfig(config: Partial<CenterlineControllerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration.
   */
  getConfig(): CenterlineControllerConfig {
    return { ...this.config };
  }

  // === Agent interface methods (mostly no-ops for rule-based) ===

  train(_experiences: TrainingBatch): Promise<TrainingResult> {
    // Rule-based controller doesn't train
    return Promise.resolve({ loss: 0 });
  }

  save(): SerializedModel {
    return {
      weights: [],
      config: {
        observationSize: 20,
        hiddenLayers: [],
        learningRate: 0,
        discountFactor: 0,
        controllerConfig: this.config,
      },
    };
  }

  load(data: SerializedModel): void {
    if (data.config.controllerConfig) {
      this.config = {
        ...DEFAULT_CONFIG,
        ...data.config.controllerConfig,
      };
    }
  }

  getName(): string {
    return this.name;
  }
}

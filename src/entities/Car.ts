import Matter from 'matter-js';
import { Vector2 } from '../utils/Vector2';
import { CONFIG } from '../utils/Constants';
import type { CarConfig, CarState, ControlMode, RaceState } from '../types';
import type { PhysicsEngine } from '../physics/PhysicsEngine';
import type { Track } from '../track/Track';

export class Car {
  public readonly config: CarConfig;
  public state: CarState;
  public body: Matter.Body;

  private physicsEngine: PhysicsEngine;
  private track: Track | null = null;

  // Cached speed (computed once per update, reused throughout frame)
  private cachedSpeed: number = 0;

  // Scratch vectors for hot-path calculations (avoid allocations)
  private readonly scratchVec1: Vector2 = new Vector2();
  private readonly scratchVec2: Vector2 = new Vector2();

  constructor(physicsEngine: PhysicsEngine, x: number, y: number, config?: Partial<CarConfig>) {
    this.physicsEngine = physicsEngine;

    this.config = {
      mass: CONFIG.CAR_MASS,
      initialFuel: CONFIG.INITIAL_FUEL,
      fuelConsumptionRate: CONFIG.FUEL_CONSUMPTION_RATE,
      initialGrip: 1.0,
      maxHealth: CONFIG.MAX_HEALTH,
      teamColor: CONFIG.COLORS.CAR_DEFAULT,
      radius: CONFIG.CAR_RADIUS,
      ...config,
    };

    this.body = physicsEngine.createCircleBody(x, y, this.config.radius, {
      mass: this.config.mass,
      label: 'car',
    });

    this.state = {
      position: new Vector2(x, y),
      velocity: Vector2.zero(),
      previousVelocity: Vector2.zero(),
      fuel: this.config.initialFuel,
      grip: this.config.initialGrip,
      heat: 0,
      wheelspinHeat: 0,
      turningHeat: 0,
      health: this.config.maxHealth,
      isOnTrack: true,
      isInPit: false,
      isPitting: false,
      pitTimer: 0,
      controlMode: 'keyboard',
      raceState: this.createInitialRaceState(),
    };
  }

  private debugCounter: number = 0;

  applyAcceleration(direction: Vector2): void {
    const mag = direction.magnitude();
    if (mag < 0.01) {
      // Debug: log when action is too small
      if (this.debugCounter++ % 500 === 0) {
        console.log(`Car: action too small, mag=${mag.toFixed(4)}`);
      }
      return;
    }
    if (this.state.fuel <= 0) {
      console.log('Car: out of fuel!');
      return;
    }

    const inputDir = direction.normalize();
    const speed = this.state.velocity.magnitude();
    const inputMag = Math.min(1, mag); // 0-1 throttle

    // === POWER CURVE ===
    // Force = Power / velocity (diminishing at high speeds)
    // frictionAir handles resistance, so no traction cap needed
    const engineForce = (CONFIG.ENGINE_POWER * inputMag) / (speed + CONFIG.POWER_EPSILON);

    // Debug: log force being applied
    if (this.debugCounter++ % 500 === 0) {
      console.log(`Car: inputMag=${inputMag.toFixed(3)} speed=${speed.toFixed(3)} engineForce=${engineForce.toFixed(6)}`);
    }

    // === WHEELSPIN CHECK (for heat generation only) ===
    const tractionLimit = this.state.grip * CONFIG.TRACTION_COEFFICIENT;
    if (engineForce > tractionLimit * CONFIG.WHEELSPIN_THRESHOLD) {
      const excessRatio = engineForce / tractionLimit;
      this.state.wheelspinHeat = (excessRatio - 1) * CONFIG.WHEELSPIN_HEAT_MULTIPLIER;
    } else {
      this.state.wheelspinHeat = 0;
    }

    // === TURNING EFFORT HEAT ===
    // Track when input fights momentum (for heat/skid marks only - no force applied)
    // This makes the grip system visible without breaking momentum physics
    this.state.turningHeat = 0;
    if (speed > 0.5) {
      const velDir = this.state.velocity.normalize();
      const alignment = inputDir.dot(velDir); // -1 (opposite) to 1 (aligned)
      const misalignment = Math.max(0, 1 - alignment); // 0 (aligned) to 2 (opposite)

      if (misalignment > CONFIG.TURN_FRICTION_THRESHOLD) {
        // Heat from fighting momentum - purely visual feedback
        // No force applied here - momentum is preserved
        const effort = speed * misalignment * this.state.grip;
        this.state.turningHeat = effort * CONFIG.TURN_HEAT_SCALE;
      }
    }

    // === APPLY FORCE ===
    // Apply directly in input direction - physics handles the rest
    this.physicsEngine.applyForce(this.body, inputDir.scale(engineForce));

    // === FUEL CONSUMPTION ===
    this.state.fuel -= engineForce * speed * CONFIG.FUEL_POWER_RATE;
    this.state.fuel = Math.max(0, this.state.fuel);
  }

  update(deltaTime: number): void {
    // Store previous velocity for lateral speed calculation (reuse object to avoid allocation)
    this.state.previousVelocity.setFrom(this.state.velocity);

    // Note: Air resistance handled by Matter.js frictionAir property

    // Sync state with physics body
    this.state.position = this.physicsEngine.getPosition(this.body);
    this.state.velocity = this.physicsEngine.getVelocity(this.body);

    // Cache speed for use throughout this frame (avoid repeated magnitude() calls)
    this.cachedSpeed = this.state.velocity.magnitude();
    const speed = this.cachedSpeed;

    if (speed < 0.01) {
      this.state.heat = 0;
      return;
    }

    // === FRICTION SYSTEM ===
    // Note: Base velocity damping handled by Matter.js frictionAir
    // We only apply additional friction for off-track and sliding

    // 1. Off-track penalty (gravel trap effect)
    if (!this.state.isOnTrack) {
      const offTrackDrag = this.state.velocity.normalize()
        .scale(-CONFIG.OFF_TRACK_SURFACE_FRICTION * speed);
      this.physicsEngine.applyForce(this.body, offTrackDrag);
    }

    // 2. Calculate lateral speed (sliding)
    const lateralSpeed = this.calculateLateralSpeed();

    // 3. Get banking at current position
    const bankingAngle = this.track?.getBankingAtPosition(this.state.position) ?? 0;

    // 4. Sliding friction (when cornering/sliding) with banking modification
    // Friction limited by grip - worn tires = less friction = less control
    // Surface type also affects grip (dirt has lower grip than asphalt)
    let slideFrictionMag = 0;
    let forwardBoost = 0;

    // Get surface grip multiplier (1.0 for asphalt, lower for dirt)
    const surfaceGripMult = this.track?.getSurfaceGripMultiplier(this.state.position) ?? 1.0;
    const effectiveGrip = this.state.grip * surfaceGripMult;

    if (lateralSpeed > CONFIG.SLIDE_THRESHOLD) {
      const baseFriction = CONFIG.SLIDE_FRICTION_COEFF * lateralSpeed * effectiveGrip;

      if (bankingAngle > 0) {
        // Banking redirects lateral force into forward acceleration
        const bankingFactor = Math.sin(bankingAngle);
        const redirectFraction = bankingFactor * CONFIG.BANKING_FORCE_REDIRECT;

        // Reduced lateral friction (some force redirected forward)
        slideFrictionMag = baseFriction * (1 - redirectFraction);

        // Forward acceleration boost from redirected force
        forwardBoost = baseFriction * redirectFraction;

        // Apply forward boost in velocity direction
        if (speed > 0.1) {
          const forwardDir = this.state.velocity.normalize();
          this.physicsEngine.applyForce(this.body, forwardDir.scale(forwardBoost));
        }
      } else {
        slideFrictionMag = baseFriction;
      }

      // Apply remaining slide friction
      const slideForce = this.state.velocity.normalize().scale(-slideFrictionMag);
      this.physicsEngine.applyForce(this.body, slideForce);
    }

    // 5. Heat from friction power (correlates with skid mark intensity)
    // Heat = friction force × speed (power dissipation)
    // Reduced on banked sections
    const bankingHeatMult = bankingAngle > 0 ? CONFIG.BANKING_HEAT_REDUCTION : 1.0;
    const frictionPower = slideFrictionMag * speed * bankingHeatMult;

    // Normalize heat to 0-1 range
    // Scale so visible sliding produces noticeable heat
    const rawFrictionHeat = frictionPower * CONFIG.FRICTION_HEAT_SCALE;
    const frictionHeat = Math.pow(rawFrictionHeat, 0.8);

    // Combine all heat sources: sliding friction + turning friction + wheelspin
    const totalHeat = frictionHeat + this.state.turningHeat + this.state.wheelspinHeat;
    this.state.heat = Math.min(1, totalHeat);

    // 5. Grip degradation from heat
    if (this.state.heat > 0.01) {
      const degradation = this.state.heat * CONFIG.GRIP_DEGRADATION_RATE * deltaTime * 60;
      this.state.grip = Math.max(CONFIG.MIN_GRIP, this.state.grip - degradation);
    }
  }

  /**
   * Calculate lateral speed (how much the car is sliding sideways)
   * This is the velocity component perpendicular to the heading direction
   * Optimized to use scratch vectors and avoid allocations
   */
  private calculateLateralSpeed(): number {
    const velocity = this.state.velocity;
    const prevVelocity = this.state.previousVelocity;

    // Use cached speed instead of computing magnitude again
    if (this.cachedSpeed < 0.1) return 0;

    // Calculate velocity change (acceleration) using scratch vector
    // scratchVec1 = deltaV = velocity - prevVelocity
    this.scratchVec1.set(velocity.x - prevVelocity.x, velocity.y - prevVelocity.y);
    const deltaVMagSq = this.scratchVec1.x * this.scratchVec1.x + this.scratchVec1.y * this.scratchVec1.y;
    if (deltaVMagSq < 0.00000001) return 0; // 0.0001^2

    // Decompose into parallel and lateral to current velocity
    // scratchVec2 = velDir = velocity.normalize()
    const invSpeed = 1 / this.cachedSpeed;
    this.scratchVec2.set(velocity.x * invSpeed, velocity.y * invSpeed);

    // parallelMag = deltaV.dot(velDir)
    const parallelMag = this.scratchVec1.x * this.scratchVec2.x + this.scratchVec1.y * this.scratchVec2.y;

    // lateralDelta = deltaV - velDir * parallelMag
    const lateralX = this.scratchVec1.x - this.scratchVec2.x * parallelMag;
    const lateralY = this.scratchVec1.y - this.scratchVec2.y * parallelMag;

    return Math.sqrt(lateralX * lateralX + lateralY * lateralY);
  }

  /**
   * Get current heat level (for skid mark rendering)
   */
  getHeat(): number {
    return this.state.heat;
  }

  getPosition(): Vector2 {
    return this.state.position;
  }

  getVelocity(): Vector2 {
    return this.state.velocity;
  }

  getSpeed(): number {
    return this.cachedSpeed;
  }

  setControlMode(mode: ControlMode): void {
    this.state.controlMode = mode;
  }

  toggleControlMode(): void {
    this.state.controlMode = this.state.controlMode === 'keyboard' ? 'ai' : 'keyboard';
  }

  /**
   * Set track reference for banking calculations
   */
  setTrack(track: Track): void {
    this.track = track;
  }

  private createInitialRaceState(): RaceState {
    return {
      totalLaps: 0,
      currentLap: 0,
      currentSector: 0,
      sectorStartTime: 0,
      lapStartTime: 0,
      currentLapValid: true,
      laps: [],
      bestLapTime: Infinity,
      offTrackCount: 0,
      lastTrackIndex: -1,
      isRacing: false,
      isWaitingForStart: true,
      sectorsCompleted: [false, false, false],
    };
  }

  reset(x: number, y: number, _initialAngle?: number): void {
    const pos = new Vector2(x, y);
    this.physicsEngine.setPosition(this.body, pos);

    // IMPORTANT: Also update state.position so getPosition() returns correct value
    // before the next physics update
    this.state.position = pos;

    // Start stationary - agent learns to accelerate from rest
    // The observation includes track tangent which tells the agent which way to go
    this.physicsEngine.setVelocity(this.body, Vector2.zero());
    this.state.velocity = Vector2.zero();
    this.state.previousVelocity = Vector2.zero();

    this.state.fuel = this.config.initialFuel;
    this.state.grip = this.config.initialGrip;
    this.state.heat = 0;
    this.state.wheelspinHeat = 0;
    this.state.turningHeat = 0;
    this.state.health = this.config.maxHealth;
    this.state.isInPit = false;
    this.state.isPitting = false;
    this.state.pitTimer = 0;
    this.state.raceState = this.createInitialRaceState();
  }

  /**
   * Apply collision damage based on impact.
   * Normalized so head-on at MAX_COLLISION_SPEED = 100 HP damage (instant death).
   * @param impactFactor 0-1, where 1 = head-on, 0 = glancing
   * @param speed Speed at moment of impact
   */
  applyCollisionDamage(impactFactor: number, speed: number): void {
    // Speed ratio: what fraction of max collision speed?
    const speedRatio = Math.min(1, speed / CONFIG.MAX_COLLISION_SPEED);

    // Squared impact factor: scrapes are exponentially gentler
    const impactMultiplier = impactFactor * impactFactor;

    // Damage = maxHealth × speedRatio × impactMultiplier
    // At max speed head-on: 100 × 1.0 × 1.0 = 100 HP (dead)
    const damage = this.config.maxHealth * speedRatio * impactMultiplier;

    this.state.health = Math.max(0, this.state.health - damage);

    // Scraping generates heat (friction against wall)
    if (impactFactor < 0.5) {
      this.state.heat = Math.min(1, this.state.heat + 0.2);
    }
  }

  /**
   * Start a pit stop (refuel and restore grip)
   */
  startPitStop(duration: number): void {
    if (this.state.isPitting) return;
    this.state.isPitting = true;
    this.state.pitTimer = duration;
  }

  /**
   * Update pit stop progress
   * Returns true when pit stop is complete
   */
  updatePitStop(deltaTime: number): boolean {
    if (!this.state.isPitting) return false;

    this.state.pitTimer -= deltaTime;

    if (this.state.pitTimer <= 0) {
      // Pit stop complete - restore resources
      this.state.fuel = this.config.initialFuel;
      this.state.grip = this.config.initialGrip;
      this.state.isPitting = false;
      this.state.pitTimer = 0;
      return true;
    }

    return false;
  }

  /**
   * Capture current car state for replay recording.
   * Returns a plain object suitable for JSON serialization.
   */
  captureState(): {
    position: { x: number; y: number };
    velocity: { x: number; y: number };
    angle: number;
    fuel: number;
    grip: number;
    heat: number;
  } {
    return {
      position: { x: this.state.position.x, y: this.state.position.y },
      velocity: { x: this.state.velocity.x, y: this.state.velocity.y },
      angle: this.body.angle,
      fuel: this.state.fuel,
      grip: this.state.grip,
      heat: this.state.heat,
    };
  }

  /**
   * Restore car state from a captured state.
   * Used for replay playback.
   */
  restoreState(state: {
    position: { x: number; y: number };
    velocity: { x: number; y: number };
    angle: number;
    fuel: number;
    grip: number;
    heat: number;
  }): void {
    // Position
    const pos = new Vector2(state.position.x, state.position.y);
    this.physicsEngine.setPosition(this.body, pos);
    this.state.position = pos;

    // Velocity
    const vel = new Vector2(state.velocity.x, state.velocity.y);
    this.physicsEngine.setVelocity(this.body, vel);
    this.state.velocity = vel;
    this.state.previousVelocity = vel.clone();

    // Angle
    Matter.Body.setAngle(this.body, state.angle);

    // Resources
    this.state.fuel = state.fuel;
    this.state.grip = state.grip;
    this.state.heat = state.heat;

    // Reset transient heat values
    this.state.wheelspinHeat = 0;
    this.state.turningHeat = 0;
  }
}

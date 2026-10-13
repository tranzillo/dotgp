// All simulation units are SI: metres, seconds, kilograms, radians.

export const G = 9.81;

export const PHYSICS = {
  DT: 1 / 120,
  /** Drivers make a decision every N physics steps (120 / 4 = 30 Hz). */
  CONTROL_EVERY: 4,

  // Car body
  CAR_RADIUS: 1.5,
  DRY_MASS: 1450,

  // Powertrain
  ENGINE_POWER: 560_000, // W (~750 hp)
  /** Gearing/torque cap on forward acceleration at very low speed. */
  MAX_DRIVE_ACCEL: 12,

  // Resistance
  AIR_DENSITY: 1.2,
  CDA: 1.25, // drag area (m^2); sets top speed ~90 m/s

  // Tires: the friction circle
  TIRE_MU: 1.0,
  /** Input magnitude 1 demands this multiple of the current tire capacity. */
  OVERDRIVE_MAX: 1.25,
  /** Fraction of capacity lost when fully overdriven (sliding / wheelspin). */
  SLIDE_GRIP_LOSS: 0.2,
  MIN_GRIP: 0.6,

  // Tire wear: wear is driven by tire work, weighted by direction relative to travel.
  // Lateral load (perpendicular to motion) wears hardest; straight-line drive wears least.
  WEAR_RATE: 2e-6,
  WEAR_LATERAL: 1.0,
  WEAR_BRAKE: 0.35,
  WEAR_DRIVE: 0.2,
  WEAR_SLIP_FLOOR: 2, // m/s, so wheelspin at a standstill still wears
  SLIDE_WEAR: 3, // extra wear multiplier at full overdrive
  /** Tire power (load ratio x speed) that renders as a fully dark mark. */
  MARK_NORM: 120,

  // Fuel
  FUEL_CAPACITY: 60, // kg
  BSFC: 8.3e-8, // kg per joule of engine work (~0.3 kg/kWh)
  IDLE_FUEL: 0.002, // kg/s

  // Banking frame blend: below this speed the car's frame leans on the track tangent
  FRAME_BLEND_SPEED: 3,

  // Walls
  WALL_RESTITUTION: 0.3,
  /** Coulomb friction against the wall: tangential loss capped at mu x normal impulse. */
  WALL_FRICTION: 0.5,

  // Car-to-car
  CAR_RESTITUTION: 0.5,
  CAR_FRICTION: 0.15,

  // Damage
  DAMAGE_SPEED_THRESHOLD: 4, // m/s of normal impact speed before damage starts
  DAMAGE_PER_ENERGY: 0.0023, // health lost per (m/s)^2 above threshold
  SCRAPE_DAMAGE: 0.0002, // health lost per (m/s)^2 of wall friction work
  PUSH_DAMAGE_MULT: 0.25, // being hit from behind is mostly harmless
  ENGINE_DAMAGE_THRESHOLD: 0.15, // single-impact severity that starts hurting the engine
  AERO_DAMAGE_DRAG: 0.5, // drag multiplier at full aero damage
  HANDLING_DAMAGE_GRIP: 0.3, // grip lost at full handling damage
  ENGINE_DAMAGE_POWER: 0.4, // power lost at full engine damage

  // Drafting
  DRAFT_LENGTH: 40,
  DRAFT_WIDTH: 2.6,
  DRAFT_MAX: 0.35, // max drag reduction for the follower
  DRAFT_PUSH: 0.06, // drag reduction for the leader with a car tucked behind
} as const;

/**
 * Surface behaviour. Grass is the infield: little grip (you can't turn or
 * brake well), heavy rolling drag, and bumps that knock the car off line.
 */
export const SURFACES = {
  track: { grip: 1.0, rolling: 0.015, bump: 0 },
  apron: { grip: 0.9, rolling: 0.015, bump: 0 },
  pit: { grip: 0.9, rolling: 0.015, bump: 0 },
  garage: { grip: 0.9, rolling: 0.02, bump: 0 },
  road: { grip: 0.85, rolling: 0.02, bump: 0 },
  grass: { grip: 0.45, rolling: 0.2, bump: 0.06 },
} as const;
/** Pit road and pit service. */
export const PIT_SERVICE = {
  SPEED_LIMIT: 22, // m/s (~80 km/h); the pit limiter cuts drive above this on pit road
  TIRE_TIME: 11, // s for four tires
  FUEL_RATE: 4, // kg/s; fuelling runs alongside the tire change
  REPAIR_TIME: 8, // s added for repairs
  REPAIR_FRACTION: 0.6, // share of damage repaired
  STALL_SPACING: 12, // m between pit boxes
  /** Merging starts this far before the end of the blend line... */
  MERGE_ZONE: 140,
  /** ...and a car still on the apron this far past it merges regardless. */
  MERGE_GIVE_UP: 400,
} as const;

/** Size (m) of the bumps on rough surfaces. */
export const BUMP_SCALE = 6;

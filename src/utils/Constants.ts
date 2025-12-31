export const CONFIG = {
  // Canvas
  CANVAS_WIDTH: 1600,
  CANVAS_HEIGHT: 1000,

  // Physics
  PHYSICS_TIMESTEP: 1000 / 60,
  FRICTION_AIR: 0.0015,

  // Car
  CAR_RADIUS: 8,
  CAR_MASS: 1,

  // Grip & Friction
  GRIP_DEGRADATION_RATE: 0.0001,
  MIN_GRIP: 0.3,

  // Off-track penalty
  OFF_TRACK_SURFACE_FRICTION: 0.0001,

  // Rallycross surface grip (dirt has lower grip than asphalt)
  DIRT_GRIP_MULTIPLIER: 0.65,

  // Sliding friction (cornering)
  SLIDE_FRICTION_COEFF: 0.012,
  SLIDE_THRESHOLD: 0.05,

  // Turning effort heat (visual only)
  TURN_FRICTION_THRESHOLD: 0.15,
  TURN_HEAT_SCALE: 0.8,

  // Heat generation
  FRICTION_HEAT_SCALE: 5.0,

  // Banking physics
  BANKING_FORCE_REDIRECT: 0.8,
  BANKING_HEAT_REDUCTION: 0.5,

  // Powertrain
  ENGINE_POWER: 0.00009,
  POWER_EPSILON: 0.7,
  TRACTION_COEFFICIENT: 0.00005,
  WHEELSPIN_THRESHOLD: 1.2,
  WHEELSPIN_HEAT_MULTIPLIER: 2.0,
  FUEL_POWER_RATE: 0.0001,

  // Fuel
  INITIAL_FUEL: 100,
  FUEL_CONSUMPTION_RATE: 0.01,

  // Pit stops
  PIT_STOP_DURATION: 3.0,
  PIT_STOP_MAX_SPEED: 0.5,

  // Damage
  MAX_HEALTH: 100,

  // Mouse control
  MOUSE_THROTTLE_MIN: 0.15, // Minimum throttle when cursor is close
  MOUSE_THROTTLE_MAX_DISTANCE: 200, // Distance at which throttle reaches 100%

  // Collision damage
  MAX_COLLISION_SPEED: 7.5,
  COLLISION_SPEED_LOSS: 0.5,
  COLLISION_MIN_SPEED: 0.5,

  // Wall collisions
  WALL_BANKING_THRESHOLD: 0.087,
  WALL_THICKNESS: 4,
  WALL_RESTITUTION: 0, // Let Matter.js handle bounce
  WALL_FRICTION: 0.5,

  // Colors
  COLORS: {
    BACKGROUND: '#111111',
    TRACK_SURFACE: '#2a2a2a',
    TRACK_OUTLINE: '#ffffff',
    CAR_DEFAULT: '#ff3333',
    UI_TEXT: '#ffffff',
    // Rallycross colors
    RALLYCROSS_SURFACE: '#3d2817',
    RALLYCROSS_OUTLINE: '#8b6914',
    RALLYCROSS_INFO: '#d4a855',
  },
} as const;

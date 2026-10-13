import { BUMP_SCALE, G, PHYSICS as P, PIT_SERVICE, SURFACES } from './constants';
import { valueNoise } from './noise';
import type { Surface, Track } from './track';

export const SIGNATURE_BINS = 12;

/** What the crew chief asks for when calling the car in. */
export interface PitCall {
  tires: boolean;
  /** kg of fuel to add. */
  fuel: number;
  repair: boolean;
}

/**
 * Pit cycle: none -> in (heading for the box) -> service (stopped, crew
 * working) -> out (leaving through the blend lane) -> none.
 */
export interface PitState {
  phase: 'none' | 'in' | 'service' | 'out';
  call: PitCall | null;
  /** Signed s of this car's pit box. */
  boxS: number;
  timer: number;
  stops: number;
  /** Laps completed when tires were last changed. */
  tiresFittedLap: number;
}
const RETIRED_DECEL = 8;

/**
 * A car is a featureless dot. It has no heading: the driver requests an
 * acceleration vector in the car's travel frame (x = along velocity,
 * y = toward the left of travel) and the tires deliver what they can.
 */
export class Car {
  readonly id: number;
  color: string;

  // World state
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;

  // Track frame (refreshed every step)
  s = 0;
  d = 0;
  trackIdx = -1;
  /** Signed distance travelled along the track since the start line (negative before it). */
  dist = 0;

  // Driver input, travel frame, magnitude <= 1 (1 = demand OVERDRIVE_MAX x capacity)
  inputX = 0;
  inputY = 0;

  // Resources
  fuel: number = P.FUEL_CAPACITY;
  tireLife = 1;
  health = 1;
  damageAero = 0;
  damageHandling = 0;
  damageEngine = 0;
  retired = false;
  /** A stopped wreck the safety crew has removed: no longer on track for anyone. */
  cleared = false;
  /** Seconds a retired car has been stationary. */
  stoppedFor = 0;
  /** Being towed by a wrecker (drawn, but not part of the physics). */
  towed = false;
  /** Towed to the garage and parked there. */
  parked = false;
  /** Took the checkered flag. */
  finished = false;

  // Per-step telemetry
  frameX = 1;
  frameY = 0;
  capacity = 0;
  bankAcc = 0;
  tireLon = 0;
  tireLat = 0;
  sliding = 0;
  markIntensity = 0;
  draftFactor = 1;
  wallContact = false;
  surface: Surface = 'track';

  pit: PitState = { phase: 'none', call: null, boxS: 0, timer: 0, stops: 0, tiresFittedLap: 0 };

  // Timing
  nextLineDist = 0;
  lapStartTime = -1;
  lapTimes: number[] = [];

  // Stats
  wallHits = 0;
  readonly signature = new Float64Array(SIGNATURE_BINS);

  constructor(id: number, color = '#ffffff') {
    this.id = id;
    this.color = color;
  }

  get mass(): number {
    return P.DRY_MASS + this.fuel;
  }

  get grip(): number {
    return P.MIN_GRIP + (1 - P.MIN_GRIP) * this.tireLife;
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vy);
  }

  get lapsCompleted(): number {
    return this.lapTimes.length;
  }

  placeOnTrack(track: Track, s: number, d: number): void {
    const [x, y] = track.toWorld(s, d);
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    const p = track.project(x, y);
    this.s = p.s;
    this.d = p.d;
    this.trackIdx = p.idx;
    // Starting behind the line means dist is negative until the first crossing.
    this.dist = p.s > track.length / 2 ? p.s - track.length : p.s;
    this.nextLineDist = this.dist < 0 ? 0 : track.length;
  }
}

/**
 * Integrate one physics step for a single car (no collisions).
 * wearScale speeds up tire wear and fuel burn (race pace).
 */
export function stepCar(car: Car, track: Track, dt: number, wearScale = 1): void {
  if (car.retired) {
    // Wrecked: slide to a stop and stay on track as an obstacle.
    const sp = car.speed;
    const k = sp > 1e-9 ? Math.max(0, sp - RETIRED_DECEL * dt) / sp : 0;
    car.vx *= k;
    car.vy *= k;
    car.x += car.vx * dt;
    car.y += car.vy * dt;
    car.markIntensity = sp > 1 ? 0.6 : 0;
    return;
  }
  const i = car.trackIdx;
  const tx = track.tx[i], ty = track.ty[i];
  const nx = -ty, ny = tx; // toward the infield

  const vx = car.vx, vy = car.vy;
  const speed = Math.hypot(vx, vy);

  // Travel frame. At very low speed, lean on the track direction so the frame is defined.
  const blend = Math.max(0, P.FRAME_BLEND_SPEED - speed);
  let fx = vx + tx * blend, fy = vy + ty * blend;
  const fm = Math.hypot(fx, fy);
  if (fm > 1e-9) { fx /= fm; fy /= fm; } else { fx = tx; fy = ty; }
  const lx = -fy, ly = fx;
  car.frameX = fx;
  car.frameY = fy;

  // --- Banking ---
  // Normal load per unit mass on a banked surface rises with cornering speed.
  // Its horizontal component pushes toward the infield regardless of input,
  // so at the "neutral speed" v^2 = g tan(bank) / kappa the banking alone carries
  // the car around the turn without any tire work.
  const bank = track.bankAt(i, car.d);
  const cosB = Math.cos(bank), sinB = Math.sin(bank);
  const kappa = track.kappa[i];
  const kappaLane = kappa / Math.max(0.2, 1 - kappa * car.d);
  const vt = vx * tx + vy * ty;
  const normalAcc = Math.min(4 * G, Math.max(0.3 * G, G * cosB + vt * vt * kappaLane * sinB));
  const bankAcc = normalAcc * sinB;
  car.bankAcc = bankAcc;

  // --- Friction circle ---
  const surfaceKind = track.surfaceAt(car.s, car.d, car.x, car.y);
  car.surface = surfaceKind;
  const surface = SURFACES[surfaceKind];
  const capacity = P.TIRE_MU * car.grip * surface.grip
    * (1 - P.HANDLING_DAMAGE_GRIP * car.damageHandling) * normalAcc;
  car.capacity = capacity;

  let ix = car.inputX, iy = car.inputY;
  const im = Math.hypot(ix, iy);
  if (im > 1) { ix /= im; iy /= im; }
  const demandScale = P.OVERDRIVE_MAX * capacity;
  let aLon = ix * demandScale;
  let aLat = iy * demandScale;

  if (aLon > 0) {
    const power = car.fuel > 0
      ? P.ENGINE_POWER * (1 - P.ENGINE_DAMAGE_POWER * car.damageEngine)
      : 0;
    let engineMax = Math.min(P.MAX_DRIVE_ACCEL, power / (car.mass * Math.max(speed, 1)));
    // Pit limiter: no drive above the pit road speed limit.
    if (surfaceKind === 'pit' && speed > PIT_SERVICE.SPEED_LIMIT) engineMax = 0;
    if (aLon > engineMax) aLon = engineMax;
  }

  let over = 0;
  const req = Math.hypot(aLon, aLat);
  if (req > capacity && req > 1e-9) {
    over = Math.min(1, (req - capacity) / (capacity * (P.OVERDRIVE_MAX - 1)));
    const delivered = capacity * (1 - P.SLIDE_GRIP_LOSS * over);
    aLon *= delivered / req;
    aLat *= delivered / req;
  }
  car.sliding = over;
  car.tireLon = aLon;
  car.tireLat = aLat;

  // --- Resistance ---
  const cda = P.CDA * (1 + P.AERO_DAMAGE_DRAG * car.damageAero) * car.draftFactor;
  const dragAcc = (0.5 * P.AIR_DENSITY * cda * speed * speed) / car.mass;
  const rolling = surface.rolling * G;
  const resist = Math.min(speed / dt, dragAcc + rolling);

  // --- Integrate (semi-implicit Euler) ---
  let ax = aLon * fx + aLat * lx + bankAcc * nx;
  let ay = aLon * fy + aLat * ly + bankAcc * ny;
  if (speed > 1e-9) {
    ax -= (vx / speed) * resist;
    ay -= (vy / speed) * resist;
  }
  if (surface.bump > 0 && speed > 1) {
    // Rough ground kicks the car sideways (and a little fore/aft), harder the faster it goes.
    const kick = surface.bump * speed;
    const side = valueNoise(car.x / BUMP_SCALE, car.y / BUMP_SCALE);
    const fore = valueNoise(car.x / BUMP_SCALE + 71.3, car.y / BUMP_SCALE - 19.7);
    ax += (lx * side + fx * fore * 0.5) * kick;
    ay += (ly * side + fy * fore * 0.5) * kick;
  }
  car.vx += ax * dt;
  car.vy += ay * dt;
  car.x += car.vx * dt;
  car.y += car.vy * dt;

  // --- Tire wear & marks ---
  const muG = P.TIRE_MU * G;
  const lonWeight = aLon > 0 ? P.WEAR_DRIVE : P.WEAR_BRAKE;
  const load2 = (P.WEAR_LATERAL * aLat * aLat + lonWeight * aLon * aLon) / (muG * muG);
  const slideMult = 1 + P.SLIDE_WEAR * over;
  car.tireLife = Math.max(0, car.tireLife - P.WEAR_RATE * wearScale * (speed + P.WEAR_SLIP_FLOOR) * load2 * slideMult * dt);
  car.markIntensity = surfaceKind === 'grass'
    ? Math.min(1, speed / 40) // torn turf
    : Math.min(1, (Math.sqrt(load2) * (speed + P.WEAR_SLIP_FLOOR) * slideMult) / P.MARK_NORM);

  // --- Fuel ---
  const powerUsed = Math.max(0, aLon) * car.mass * speed;
  car.fuel = Math.max(0, car.fuel - (powerUsed * P.BSFC + P.IDLE_FUEL) * wearScale * dt);

  // --- Technique signature: where the tire force pointed relative to travel ---
  const tireMag = Math.hypot(aLon, aLat);
  if (tireMag > 0.1) {
    const ang = Math.atan2(aLat, aLon);
    const bin = Math.floor(((ang + Math.PI) / (2 * Math.PI)) * SIGNATURE_BINS) % SIGNATURE_BINS;
    car.signature[bin] += tireMag * dt;
  }
}

/**
 * Apply collision damage. Severity comes from impact speed; where it lands
 * depends on the direction of the velocity change relative to travel:
 *   opposes travel (nose-first deceleration) -> aero
 *   perpendicular (side impact / wall)      -> handling
 *   along travel (hit from behind)          -> mostly harmless
 * Big single hits also damage the engine.
 */
export function applyImpact(
  car: Car, dvx: number, dvy: number, impactSpeed: number, scrapeWork: number, damageScale = 1,
): void {
  const thr = P.DAMAGE_SPEED_THRESHOLD;
  let severity = Math.max(0, impactSpeed * impactSpeed - thr * thr) * P.DAMAGE_PER_ENERGY;
  severity += scrapeWork * P.SCRAPE_DAMAGE;
  severity *= damageScale;
  if (severity <= 0) return;

  const dvm = Math.hypot(dvx, dvy);
  const c = dvm > 1e-9 ? (dvx * car.frameX + dvy * car.frameY) / dvm : 0;
  // cos^2 / sin^2 split so the three shares always sum to 1.
  const decel = c < 0 ? c * c : 0;
  const push = c > 0 ? c * c : 0;
  const side = 1 - c * c;

  const effective = severity * (1 - (1 - P.PUSH_DAMAGE_MULT) * push);
  car.damageAero = Math.min(1, car.damageAero + effective * (0.2 + 0.8 * decel));
  car.damageHandling = Math.min(1, car.damageHandling + effective * side);
  if (effective > P.ENGINE_DAMAGE_THRESHOLD) {
    car.damageEngine = Math.min(1, car.damageEngine + (effective - P.ENGINE_DAMAGE_THRESHOLD) * 2);
  }
  car.health -= effective;
  if (car.health <= 0) {
    car.health = 0;
    car.retired = true;
  }
}

/** Seconds the crew needs for a pit call. Tires and fuel happen in parallel. */
export function serviceTime(car: Car, call: PitCall): number {
  const fuelTime = Math.min(call.fuel, P.FUEL_CAPACITY - car.fuel) / PIT_SERVICE.FUEL_RATE;
  return Math.max(call.tires ? PIT_SERVICE.TIRE_TIME : 0, fuelTime, 2) + (call.repair ? PIT_SERVICE.REPAIR_TIME : 0);
}

export function applyService(car: Car, call: PitCall): void {
  if (call.tires) {
    car.tireLife = 1;
    car.pit.tiresFittedLap = car.lapsCompleted;
  }
  car.fuel = Math.min(P.FUEL_CAPACITY, car.fuel + call.fuel);
  if (call.repair) {
    const keep = 1 - PIT_SERVICE.REPAIR_FRACTION;
    car.damageAero *= keep;
    car.damageHandling *= keep;
    car.damageEngine *= keep;
    car.health = 1 - (1 - car.health) * keep;
  }
}

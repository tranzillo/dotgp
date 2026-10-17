import { BUMP_SCALE, G, PHYSICS as P, PIT_SERVICE, PLOUGH_SPEED, SURFACES } from './constants';
import { valueNoise } from './noise';
import type { Surface, Track } from './track';

export const SIGNATURE_BINS = 12;

/** What the crew chief asks for when calling the car in. */
export interface PitCall {
  tires: boolean;
  /** kg of fuel to add. */
  fuel: number;
  repair: boolean;
  /** Serving a penalty instead: through pit road (a drive-through) or a stop in the box for some seconds. */
  penalty?: 'drive-through' | 'stop-go';
  penaltySeconds?: number;
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
 * Cornering grip of a tire at a given life: a gentle fade from new to the
 * cliff, then a fast fall to the cords.
 */
export function tireGrip(life: number): number {
  if (life >= P.TIRE_CLIFF) {
    return P.GRIP_AT_CLIFF + (1 - P.GRIP_AT_CLIFF) * (life - P.TIRE_CLIFF) / (1 - P.TIRE_CLIFF);
  }
  const x = 1 - Math.max(0, life) / P.TIRE_CLIFF; // 0 at the cliff, 1 corded
  return P.GRIP_AT_CLIFF - (P.GRIP_AT_CLIFF - P.GRIP_CORDED) * x * x;
}

/**
 * A car is a featureless dot. It has no heading: the driver requests an
 * acceleration vector in the car's travel frame (x = along velocity,
 * y = toward the left of travel) and the tires deliver what they can.
 */
export class Car {
  readonly id: number;
  /** The number on the car, which announcements call it by (the id unless a session gives it a team's number). */
  number: number;
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

  // Driver input, travel frame, magnitude <= 1 (1 = demand OVERDRIVE_MAX x capacity on each axis)
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
  /**
   * The last thing that hurt the car: a wall or another car (by id), how
   * hard (health lost), the impact speed, and (car contact) this car's share
   * of the fault. For incident analysis now, stewards' blame later.
   */
  lastImpact: { kind: 'wall' | 'car'; other: number | null; severity: number; speed: number; fault?: number } | null = null;
  /** Damage this car has done to others: health they lost in contact, times its share of the fault. */
  harmDone = 0;
  /** Damage it did to itself: walls, and its own share of the fault in contact. */
  selfInflicted = 0;
  /** The same impacts weighed as the driver feels them (trauma: big hits far worse than their size). */
  selfTrauma = 0;
  /** A penalty to serve on pit road (stewards), and the green-flag laps left to serve it before the black flag. */
  pendingPenalty: { kind: 'drive-through' | 'stop-go'; seconds: number; greenLapsLeft: number } | null = null;
  /** Seconds the stewards added to its race time; shown the black flag. */
  timePenalty = 0;
  disqualified = false;
  /** The hardest single hit the car took (health lost, impact speed): what injures a driver. */
  worstHit: { severity: number; speed: number; kind: 'wall' | 'car' } | null = null;

  // Per-step telemetry
  frameX = 1;
  frameY = 0;
  /** Tire capacity (m/s^2) across the direction of travel, and along it (braking/drive). */
  capacity = 0;
  capacityLon = 0;
  /** Banking under the car (rad), the normal load (m/s^2), and the push toward the infield it gives. */
  bank = 0;
  normalAcc = 0;
  bankAcc = 0;
  /** Horizontal tire force across the track (toward the infield) last step: how hard the car is really cornering. */
  tireNormal = 0;
  /** How hard the tires are worked relative to their grip (0..1+), as wear sees it. */
  tireUse = 0;
  tireLon = 0;
  tireLat = 0;
  sliding = 0;
  /** Rubber laid down by tire work this step (0..1): builds the groove slowly. */
  groove = 0;
  /** Skid mark strength this step (0..1): sliding, spinning, tearing up turf. */
  skid = 0;
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
    this.number = id;
    this.color = color;
  }

  get mass(): number {
    return P.DRY_MASS + this.fuel;
  }

  /** Cornering grip of the current tires (1 = new). */
  get grip(): number {
    return tireGrip(this.tireLife);
  }

  /** Braking and drive grip: worn tires lose less of it than cornering grip. */
  get gripLon(): number {
    return 1 - P.LON_WEAR_SHARE * (1 - this.grip);
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vy);
  }

  get lapsCompleted(): number {
    return this.lapTimes.length;
  }

  /**
   * Put the car at (s, d), stopped. Its race distance is where it sits relative
   * to the line, the shorter way round, unless the caller knows better: a grid
   * reaching back more than half a lap passes `dist` (negative, behind the line).
   */
  placeOnTrack(track: Track, s: number, d: number, dist?: number): void {
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
    this.dist = dist ?? (p.s > track.length / 2 ? p.s - track.length : p.s);
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
    car.groove = 0;
    car.skid = sp > 1 ? 0.8 : 0;
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
  // The sim is the top-down projection of a car on a banked surface. The
  // surface pushes back along its normal, and the horizontal part of that push,
  // N sin(bank), points toward the infield regardless of input. The load N
  // comes from how hard the car is actually cornering: with a_h its horizontal
  // acceleration across the track, N = g cos(bank) + a_h sin(bank), and
  // a_h = N sin(bank) + (tire force across the track), so
  //   N = (g cos(bank) + tires sin(bank)) / cos^2(bank)
  // using last step's tire force (1/120 s ago). Holding a lane round the turn
  // that is g cos(bank) + v^2 kappa sin(bank); a car diving down the banking
  // loads its tires more, one drifting up the track less. At the "neutral
  // speed" v^2 = g tan(bank) / kappa the banking alone carries the car round the
  // turn; faster, the tires make up the rest; slower, they hold it up the slope.
  const bank = track.bankAt(i, car.d);
  const cosB = Math.cos(bank), sinB = Math.sin(bank);
  const normalAcc = Math.min(4 * G, Math.max(0.3 * G, (G * cosB + car.tireNormal * sinB) / (cosB * cosB)));
  const bankAcc = normalAcc * sinB;
  car.bank = bank;
  car.normalAcc = normalAcc;
  car.bankAcc = bankAcc;

  // --- Friction circle ---
  const surfaceKind = track.surfaceAt(car.s, car.d, car.x, car.y);
  car.surface = surfaceKind;
  const surface = SURFACES[surfaceKind];
  // Tires grip in the plane of the surface: up to mu N there. Braking and drive
  // run along the track, which is level, so all of it counts; cornering force
  // lies across the slope, and only cos(bank) of it is horizontal. An ellipse,
  // then, narrower across the track the steeper the banking (and narrower still
  // as the tires wear: cornering grip goes first).
  const base = P.TIRE_MU * surface.grip * (1 - P.HANDLING_DAMAGE_GRIP * car.damageHandling) * normalAcc;
  const capacity = base * car.grip * cosB;
  const capacityLon = base * car.gripLon;
  car.capacity = capacity;
  car.capacityLon = capacityLon;

  let ix = car.inputX, iy = car.inputY;
  const im = Math.hypot(ix, iy);
  if (im > 1) { ix /= im; iy /= im; }
  let aLon = ix * P.OVERDRIVE_MAX * capacityLon;
  let aLat = iy * P.OVERDRIVE_MAX * capacity;

  if (aLon > 0) {
    const power = car.fuel > 0
      ? P.ENGINE_POWER * (1 - P.ENGINE_DAMAGE_POWER * car.damageEngine)
      : 0;
    let engineMax = Math.min(P.MAX_DRIVE_ACCEL, power / (car.mass * Math.max(speed, 1)));
    // Pit limiter: no drive above the pit road speed limit.
    if (surfaceKind === 'pit' && speed > PIT_SERVICE.SPEED_LIMIT) engineMax = 0;
    if (aLon > engineMax) aLon = engineMax;
  }

  // Demand as a fraction of the ellipse: above 1 the tires slide.
  let over = 0;
  const req = Math.hypot(aLon / Math.max(capacityLon, 1e-9), aLat / Math.max(capacity, 1e-9));
  if (req > 1) {
    over = Math.min(1, (req - 1) / (P.OVERDRIVE_MAX - 1));
    const delivered = (1 - P.SLIDE_GRIP_LOSS * over) / req;
    aLon *= delivered;
    aLat *= delivered;
  }
  car.sliding = over;
  car.tireLon = aLon;
  car.tireLat = aLat;
  car.tireNormal = (aLon * fx + aLat * lx) * nx + (aLon * fy + aLat * ly) * ny;

  // --- Resistance ---
  const cda = P.CDA * (1 + P.AERO_DAMAGE_DRAG * car.damageAero) * car.draftFactor;
  const dragAcc = (0.5 * P.AIR_DENSITY * cda * speed * speed) / car.mass;
  // Rolling resistance, plus ploughing on loose ground (it grows with speed: a car can still crawl out).
  const rolling = (surface.rolling + surface.plough * Math.min(1, speed / PLOUGH_SPEED)) * G;
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

  // --- Tire wear & rubber ---
  // Wear is the energy lost to tire slip: force x slip, where the slip needed
  // for a force shrinks as the load on the tire grows. Per unit of load,
  // that is utilisation^2 x load, utilisation = force / (mu N), with the
  // cornering force taken in the banked plane. On a flat track at normal load
  // this is just (force / mu g)^2; banking that loads the tires up lets them
  // make the same force with less slip, so the right line saves tires.
  const lonWeight = aLon > 0 ? P.WEAR_DRIVE : P.WEAR_BRAKE;
  const latPlane = aLat / cosB;
  const muN = P.TIRE_MU * normalAcc;
  const use2 = (P.WEAR_LATERAL * latPlane * latPlane + lonWeight * aLon * aLon) / (muN * muN);
  car.tireUse = Math.sqrt(use2);
  const load2 = use2 * (normalAcc / G);
  const slideMult = 1 + P.SLIDE_WEAR * over;
  car.tireLife = Math.max(0, car.tireLife - P.WEAR_RATE * wearScale * (speed + P.WEAR_SLIP_FLOOR) * load2 * slideMult * dt);
  // Every car working its tires adds a little to the groove; only a real slide leaves a skid.
  const loose = surfaceKind === 'grass' || surfaceKind === 'gravel';
  car.groove = loose ? 0 : Math.min(1, (Math.sqrt(load2) * (speed + P.WEAR_SLIP_FLOOR) * slideMult) / P.MARK_NORM);
  car.skid = loose
    ? Math.min(1, speed / 40) // torn turf, scattered stones
    : speed > 3 && over > P.SKID_THRESHOLD ? (over - P.SKID_THRESHOLD) / (1 - P.SKID_THRESHOLD) : 0;

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
  source: { kind: 'wall' | 'car'; other: number | null } = { kind: 'wall', other: null },
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
  car.lastImpact = { kind: source.kind, other: source.other, severity: effective, speed: impactSpeed };
  if (!car.worstHit || effective > car.worstHit.severity) car.worstHit = { severity: effective, speed: impactSpeed, kind: source.kind };
  if (source.kind === 'wall') {
    car.selfInflicted += effective;
    car.selfTrauma += trauma(effective);
  }
  if (car.health <= 0) {
    car.health = 0;
    car.retired = true;
  }
}

/**
 * Trauma: how bad one impact was for the person in the car, not just the car.
 * Small knocks are nothing; big hits are far worse than their size, as a
 * real driver feels them (a hard enough one ends a career, or a life).
 */
export const TRAUMA_CURVE = 6;
export function trauma(damage: number): number {
  return damage + TRAUMA_CURVE * damage * damage;
}

/** Seconds the crew needs for a pit call. Tires and fuel happen in parallel. */
export function serviceTime(car: Car, call: PitCall): number {
  // A penalty is served, not a stop: no service, only the time in the box (a drive-through barely stops).
  if (call.penalty) return call.penalty === 'stop-go' ? call.penaltySeconds ?? 10 : 0.5;
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

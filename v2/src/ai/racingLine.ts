import { carSpec } from '../sim/carSpec';
import { G, PHYSICS as P, SURFACES } from '../sim/constants';
import type { Car } from '../sim/car';
import type { Track } from '../sim/track';
import type { World } from '../sim/world';

/**
 * The fastest line round a road circuit, and the speed it can be driven at:
 * a yardstick for drivers' lines, and a teacher that drives like a racer
 * (wide entry, apex, wide exit) rather than holding a lane.
 *
 * The line may use the whole width the track limits allow (the car's centre
 * up to its half width past the white line, less a margin). It starts as
 * the smoothest path in that corridor (least curvature: the classic racing
 * line) and is then refined for lap time, which settles what geometry alone
 * can't: late apexes (straightening the exit onto a long straight), and
 * whether a kerb or the run-off is worth its lost grip.
 *
 * Lap time comes from the line's speed profile: at each point the fastest
 * the tyres allow round the line's own curvature (on the surface there),
 * reached by full braking before it and the engine after it, sharing the
 * friction ellipse with cornering, drag and rolling resistance included.
 */
export interface RacingLine {
  /** Spacing of the line's points along the centreline (m). */
  readonly step: number;
  /** Lateral offset (track d) at each point, s = k * step. */
  readonly d: Float32Array;
  /** The line's own curvature at each point (signed as the track's: + turning toward +d). */
  readonly kappa: Float32Array;
  /** Speed (m/s) the line can be driven at, at each point. */
  readonly speed: Float32Array;
  /** Lap time (s) of the speed profile. */
  readonly lapTime: number;
  /** The corridor the line was laid in, at each point: the least and greatest d (inside the track limits, off rough ground, clear of walls). */
  readonly lo: Float32Array;
  readonly hi: Float32Array;
  /** The profile using only a share of the tyres' grip (a driver's margin): speed at each point, and its lap time. */
  readonly at: (gripShare: number) => { speed: Float32Array; lapTime: number };
}

export interface LineOptions {
  /** Kept inside the track limits (m): room for a driver's small errors. */
  margin: number;
  /** Point spacing (m). */
  step: number;
  /** Car mass (kg) the profile is worked out for (default: half a tank). */
  mass: number;
  /** Refinement for lap time: tries per point. */
  refine: number;
  seed: number;
}

const DEFAULTS: LineOptions = { margin: 0.6, step: 2.5, mass: P.DRY_MASS + P.FUEL_CAPACITY / 2, refine: 30, seed: 1 };
const TOP_SPEED = 105;

/** Geometry of the corridor: centreline points, normals (+d), and the bounds of d. */
interface Corridor {
  n: number;
  step: number;
  cx: Float64Array; cy: Float64Array; nx: Float64Array; ny: Float64Array;
  lo: Float64Array; hi: Float64Array;
  s: Float64Array;
}

/** Ground a racing line keeps off, though the track limits may not: rough (the car slides on it), or not the circuit (pit lane, apron, garage). */
const offLimits = (surface: string) => surface === 'grass' || surface === 'gravel' || surface === 'pit' || surface === 'apron' || surface === 'garage';

function corridor(track: Track, step: number, margin: number): Corridor {
  const n = Math.max(16, Math.round(track.length / step));
  const st = track.length / n;
  const c: Corridor = {
    n, step: st, cx: new Float64Array(n), cy: new Float64Array(n), nx: new Float64Array(n), ny: new Float64Array(n),
    lo: new Float64Array(n), hi: new Float64Array(n), s: new Float64Array(n),
  };
  for (let k = 0; k < n; k++) {
    const s = k * st;
    const i = track.indexAt(s);
    const [x, y] = track.toWorld(s, 0);
    c.s[k] = s; c.cx[k] = x; c.cy[k] = y;
    c.nx[k] = -track.ty[i]; c.ny[k] = track.tx[i];
    c.lo[k] = track.outerEdge(i) - P.CAR_RADIUS + margin;
    c.hi[k] = track.innerEdge(i) + P.CAR_RADIUS - margin;
    // Not onto grass or gravel, though the limits allow it (rough: the car slides on it), nor off the circuit:
    // where the ground under the car's centre is like that, back onto good ground, and the margin more.
    const lo0 = c.lo[k], hi0 = c.hi[k];
    while (c.lo[k] < 0 && offLimits(track.surfaceAt(s, c.lo[k]))) c.lo[k] += 0.25;
    if (c.lo[k] !== lo0) c.lo[k] += margin;
    while (c.hi[k] > 0 && offLimits(track.surfaceAt(s, c.hi[k]))) c.hi[k] -= 0.25;
    if (c.hi[k] !== hi0) c.hi[k] -= margin;
    // Clear of walls (a pit wall beside the road): the car's half width and the margin off its face.
    for (const wall of track.walls) {
      if (wall.faces === 'both' || !track.inRange(s, wall.range)) continue;
      const mid = typeof wall.d === 'number' ? wall.d : track.edgeAt(wall.d, s);
      const half = wall.thickness / 2;
      if (wall.faces === 'in' && mid + half > c.lo[k] - P.CAR_RADIUS - 2) c.lo[k] = Math.max(c.lo[k], mid + half + P.CAR_RADIUS + margin);
      if (wall.faces === 'out' && mid - half < c.hi[k] + P.CAR_RADIUS + 2) c.hi[k] = Math.min(c.hi[k], mid - half - P.CAR_RADIUS - margin);
    }
    // Clear of the pit wall's nose and the wall along pit road (it isn't among the track's walls).
    c.hi[k] = Math.min(c.hi[k], track.pitWallClear(s, margin));
    if (c.lo[k] > c.hi[k]) c.lo[k] = c.hi[k] = (c.lo[k] + c.hi[k]) / 2;
  }
  return c;
}

/** Signed curvature of the path through each point (Menger: + turning toward +d, as the track's). */
function pathCurvature(c: Corridor, d: Float64Array, out: Float64Array, ds: Float64Array): void {
  for (let k = 0; k < c.n; k++) curvatureAt(c, d, k, out, ds);
}

/** The path's curvature through point k, and the distance to the next point. */
function curvatureAt(c: Corridor, d: Float64Array, k: number, out: Float64Array, ds: Float64Array): void {
  const n = c.n;
  const a = (k - 1 + n) % n, b = (k + 1) % n;
  const ax = c.cx[a] + d[a] * c.nx[a], ay = c.cy[a] + d[a] * c.ny[a];
  const px = c.cx[k] + d[k] * c.nx[k], py = c.cy[k] + d[k] * c.ny[k];
  const bx = c.cx[b] + d[b] * c.nx[b], by = c.cy[b] + d[b] * c.ny[b];
  const ux = px - ax, uy = py - ay, vx = bx - px, vy = by - py;
  const la = Math.hypot(ux, uy), lb = Math.hypot(vx, vy), lc = Math.hypot(bx - ax, by - ay);
  out[k] = (2 * (ux * vy - uy * vx)) / Math.max(1e-9, la * lb * lc);
  ds[k] = lb; // to the next point
}

/** Per-point grip (mu) and rolling resistance of the ground under the line, and the banking leaning into its turn. */
function ground(track: Track, c: Corridor, d: Float64Array, kappa: Float64Array, mu: Float64Array, roll: Float64Array, bank: Float64Array): void {
  for (let k = 0; k < c.n; k++) groundAt(track, c, d, kappa, k, mu, roll, bank);
}

function groundAt(
  track: Track, c: Corridor, d: Float64Array, kappa: Float64Array, k: number, mu: Float64Array, roll: Float64Array, bank: Float64Array,
): void {
  const surf = SURFACES[track.surfaceAt(c.s[k], d[k])];
  mu[k] = P.TIRE_MU * carSpec(track).grip * surf.grip;
  roll[k] = surf.rolling * G;
  bank[k] = Math.sign(kappa[k]) * track.bankAt(track.indexAt(c.s[k]), d[k]);
}

interface Profile { speed: Float64Array; lapTime: number }

/**
 * The car the line is for, at this track: engine power (W), drag area (m^2), downforce per unit mass and speed^2
 * (1/m), its tyres' load sensitivity (grip falls as (load / g)^-k), and the share of their grip that drives it.
 */
interface LineCar { power: number; cda: number; q: number; k: number; drive: number }

/** The speed profile round a closed line, and its lap time (at a share of the tyres' grip: a driver's margin). */
function profile(
  n: number, kappa: Float64Array, ds: Float64Array, muFull: Float64Array, roll: Float64Array, bank: Float64Array, mass: number, car: LineCar, gripShare = 1,
  /** Buffers to work in (refinement evaluates thousands of profiles); fresh ones otherwise. */
  work?: { vmax: Float64Array; latCap: Float64Array; v: Float64Array },
): Profile {
  const mu = gripShare === 1 ? muFull : muFull.map((m) => m * gripShare);
  /**
   * Load-sensitive tyres: the horizontal cornering at point k at speed v, at the limit. The load the tyres carry
   * there (downforce and banking: the constant-grip formula's), the grip that load leaves them, and the cornering it
   * gives: (g + q v^2 cos)(sin + mu cos) / (cos - mu sin) - q v^2 sin.
   */
  const latAt = (k: number, v: number) => {
    const c = Math.cos(bank[k]), sn = Math.sin(bank[k]), down = car.q * v * v;
    const load = (G + down * c) / Math.max(0.05, c - mu[k] * sn);
    const m = mu[k] * Math.pow(Math.max(0.3, load / G), -car.k);
    return ((G + down * c) * (sn + m * c)) / Math.max(0.05, c - m * sn) - down * sn;
  };
  const vmax = work?.vmax ?? new Float64Array(n);
  const latCap = work?.latCap ?? new Float64Array(n);
  let slowest = 0;
  for (let k = 0; k < n; k++) {
    const c = Math.cos(bank[k]), sn = Math.sin(bank[k]);
    // Horizontal cornering the tyres and banking give at the limit (per unit of speed^2 * curvature).
    const cap = (G * (sn + mu[k] * c)) / Math.max(0.05, c - mu[k] * sn);
    latCap[k] = cap;
    const ak = Math.abs(kappa[k]);
    if (car.k > 0) {
      // (Tyres that grip less as the load grows: no closed form; the fastest speed the cornering allows, by bisection.)
      let lo = 0, hi = TOP_SPEED;
      if (ak * hi * hi <= latAt(k, hi)) lo = hi;
      else for (let it = 0; it < 18; it++) { const m = (lo + hi) / 2; if (ak * m * m <= latAt(k, m)) lo = m; else hi = m; }
      vmax[k] = lo;
    } else {
      // (With downforce q v^2 pressing the tyres down the limit grows with speed: v^2 = cap / (kappa - q mu / (cos - mu sin)).)
      const aero = (car.q * mu[k]) / Math.max(0.05, c - mu[k] * sn);
      vmax[k] = ak > 1e-6 && ak > aero ? Math.min(TOP_SPEED, Math.sqrt(cap / (ak - aero))) : TOP_SPEED;
    }
    if (vmax[k] < vmax[slowest]) slowest = k;
  }
  const drag = (v: number) => (0.5 * P.AIR_DENSITY * car.cda * v * v) / mass;
  // What's left of the ellipse for braking or drive at a speed, with the cornering it needs there (downforce adds
  // load: the ellipse grows with q v^2).
  const lonRoom = (k: number, v: number) => {
    const load = 1 + (car.q * v * v) / G;
    if (car.k > 0) {
      const use = (v * v * Math.abs(kappa[k])) / Math.max(1e-6, latAt(k, v));
      return mu[k] * Math.pow(load, -car.k) * G * load * Math.sqrt(Math.max(0, 1 - use * use));
    }
    const use = (v * v * Math.abs(kappa[k])) / (latCap[k] * load);
    return mu[k] * G * load * Math.sqrt(Math.max(0, 1 - use * use));
  };
  const v = work?.v ?? new Float64Array(n);
  // Forward from the slowest point: as fast as the engine (and grip) can take it.
  v[slowest] = vmax[slowest];
  for (let j = 1; j <= n; j++) {
    const k = (slowest + j - 1) % n, nxt = (slowest + j) % n;
    const engine = Math.min(P.MAX_DRIVE_ACCEL, car.power / (mass * Math.max(v[k], 1)));
    const a = Math.min(engine, car.drive * lonRoom(k, v[k])) - drag(v[k]) - roll[k];
    const reach = Math.sqrt(Math.max(0, v[k] * v[k] + 2 * a * ds[k]));
    if (j < n) v[nxt] = Math.min(vmax[nxt], reach);
  }
  // Backward from it: no faster than full braking can bring down to what comes next.
  for (let j = 1; j < n; j++) {
    const k = (slowest - j + n) % n, nxt = (k + 1) % n;
    const b = lonRoom(nxt, v[nxt]) + drag(v[nxt]) + roll[nxt];
    v[k] = Math.min(v[k], Math.sqrt(v[nxt] * v[nxt] + 2 * b * ds[k]));
  }
  let t = 0;
  for (let k = 0; k < n; k++) t += (2 * ds[k]) / Math.max(0.5, v[k] + v[(k + 1) % n]);
  return { speed: v, lapTime: t };
}

/**
 * The smoothest path in the corridor: least squared curvature (second
 * differences of the points), by gradient steps projected back into it,
 * coarse to fine (curvature smoothing is slow over long distances).
 */
function smoothest(c: Corridor, d: Float64Array, iterations: number): void {
  const n = c.n;
  const px = new Float64Array(n), py = new Float64Array(n);
  const sx = new Float64Array(n), sy = new Float64Array(n);
  for (let it = 0; it < iterations; it++) {
    for (let k = 0; k < n; k++) { px[k] = c.cx[k] + d[k] * c.nx[k]; py[k] = c.cy[k] + d[k] * c.ny[k]; }
    // Second differences, then their second differences (the gradient of the summed squares).
    for (let k = 0; k < n; k++) {
      const a = (k - 1 + n) % n, b = (k + 1) % n;
      sx[k] = px[a] - 2 * px[k] + px[b]; sy[k] = py[a] - 2 * py[k] + py[b];
    }
    for (let k = 0; k < n; k++) {
      const a = (k - 1 + n) % n, b = (k + 1) % n;
      const gx = sx[a] - 2 * sx[k] + sx[b], gy = sy[a] - 2 * sy[k] + sy[b];
      const step = -(gx * c.nx[k] + gy * c.ny[k]) / 16;
      d[k] = Math.max(c.lo[k], Math.min(c.hi[k], d[k] + step));
    }
  }
}

/** Resample offsets onto a corridor with m points (linear, closed). */
function resample(d: Float64Array, m: number): Float64Array {
  const n = d.length, out = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const f = (k * n) / m, i = Math.floor(f) % n, t = f - Math.floor(f);
    out[k] = d[i] + (d[(i + 1) % n] - d[i]) * t;
  }
  return out;
}

export function racingLine(track: Track, options: Partial<LineOptions> = {}): RacingLine {
  const spec = carSpec(track);
  const o = { ...DEFAULTS, mass: spec.dryMass + P.FUEL_CAPACITY / 2, ...options };
  const car: LineCar = { power: spec.power(track), cda: spec.cda(track), q: (0.5 * P.AIR_DENSITY * spec.cla(track)) / o.mass, k: spec.loadSensitivity, drive: spec.driveShare };
  const fine = corridor(track, o.step, o.margin);
  // Smoothest path, coarse to fine: 20 m, 10 m, 5 m, then the line's own spacing.
  let d: Float64Array | null = null;
  for (const spacing of [20, 10, 5]) {
    if (spacing <= o.step) break;
    const c = corridor(track, spacing, o.margin);
    d = d ? resample(d, c.n) : new Float64Array(c.n).map((_, k) => (c.lo[k] + c.hi[k]) / 2);
    for (let k = 0; k < c.n; k++) d[k] = Math.max(c.lo[k], Math.min(c.hi[k], d[k]));
    smoothest(c, d, 3000);
  }
  const line = d ? resample(d, fine.n) : new Float64Array(fine.n).map((_, k) => (fine.lo[k] + fine.hi[k]) / 2);
  for (let k = 0; k < fine.n; k++) line[k] = Math.max(fine.lo[k], Math.min(fine.hi[k], line[k]));
  smoothest(fine, line, 2000);

  const n = fine.n;
  const kappa = new Float64Array(n), ds = new Float64Array(n);
  const mu = new Float64Array(n), roll = new Float64Array(n), bank = new Float64Array(n);
  const evaluate = (dd: Float64Array): Profile => {
    pathCurvature(fine, dd, kappa, ds);
    ground(track, fine, dd, kappa, mu, roll, bank);
    return profile(n, kappa, ds, mu, roll, bank, o.mass, car);
  };
  let best = evaluate(line);

  // Refinement for lap time: smooth bumps of the line (about a corner's length), kept if the lap gets faster.
  // A bump only moves its stretch, so only that stretch's curvature and ground are worked out again (and put
  // back if the lap isn't faster).
  let state = o.seed >>> 0 || 1;
  const rand = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  const tries = o.refine * n / 8;
  const work = { vmax: new Float64Array(n), latCap: new Float64Array(n), v: new Float64Array(n) };
  const keep = { d: new Float64Array(n), kappa: new Float64Array(n), ds: new Float64Array(n), mu: new Float64Array(n), roll: new Float64Array(n), bank: new Float64Array(n) };
  for (let t = 0; t < tries; t++) {
    const centre = Math.floor(rand() * n);
    const width = 4 + Math.floor(rand() * 16); // 10-50 m at 2.5 m
    const room = fine.hi[centre] - fine.lo[centre];
    const amp = (rand() * 2 - 1) * room * (0.3 * (1 - t / tries) + 0.03);
    // The stretch a bump moves, and the points either side whose curvature (and distance on) it changes.
    const from = -2 * width - 1, to = 2 * width + 1;
    for (let j = from; j <= to; j++) {
      const k = (centre + j + n) % n;
      keep.d[k] = line[k]; keep.kappa[k] = kappa[k]; keep.ds[k] = ds[k]; keep.mu[k] = mu[k]; keep.roll[k] = roll[k]; keep.bank[k] = bank[k];
    }
    for (let j = -2 * width; j <= 2 * width; j++) {
      const k = (centre + j + n) % n;
      line[k] = Math.max(fine.lo[k], Math.min(fine.hi[k], line[k] + amp * Math.exp(-(j * j) / (2 * width * width / 4))));
    }
    for (let j = from; j <= to; j++) curvatureAt(fine, line, (centre + j + n) % n, kappa, ds);
    for (let j = from; j <= to; j++) groundAt(track, fine, line, kappa, (centre + j + n) % n, mu, roll, bank);
    const lapTime = profile(n, kappa, ds, mu, roll, bank, o.mass, car, 1, work).lapTime;
    if (lapTime < best.lapTime) { best = { speed: best.speed, lapTime }; continue; }
    for (let j = from; j <= to; j++) {
      const k = (centre + j + n) % n;
      line[k] = keep.d[k]; kappa[k] = keep.kappa[k]; ds[k] = keep.ds[k]; mu[k] = keep.mu[k]; roll[k] = keep.roll[k]; bank[k] = keep.bank[k];
    }
  }
  best = profile(n, kappa, ds, mu, roll, bank, o.mass, car);
  pathCurvature(fine, line, kappa, ds);
  ground(track, fine, line, kappa, mu, roll, bank);
  const shares = new Map<number, { speed: Float32Array; lapTime: number }>();
  const at = (gripShare: number) => {
    let p = shares.get(gripShare);
    if (!p) {
      const q = profile(n, kappa, ds, mu, roll, bank, o.mass, car, gripShare);
      p = { speed: Float32Array.from(q.speed), lapTime: q.lapTime };
      shares.set(gripShare, p);
    }
    return p;
  };
  return {
    step: fine.step, d: Float32Array.from(line), kappa: Float32Array.from(kappa), speed: Float32Array.from(best.speed), lapTime: best.lapTime, at,
    lo: Float32Array.from(fine.lo), hi: Float32Array.from(fine.hi),
  };
}

/** The line's offset, curvature, speed and corridor at a distance round the track (linear between points). */
export function lineAt(line: RacingLine, s: number): { d: number; kappa: number; speed: number; slope: number; lo: number; hi: number } {
  const n = line.d.length;
  const f = (((s / line.step) % n) + n) % n;
  const i = Math.floor(f), j = (i + 1) % n, t = f - i;
  return {
    d: line.d[i] + (line.d[j] - line.d[i]) * t,
    kappa: line.kappa[i] + (line.kappa[j] - line.kappa[i]) * t,
    speed: line.speed[i] + (line.speed[j] - line.speed[i]) * t,
    slope: (line.d[j] - line.d[i]) / line.step,
    lo: line.lo[i] + (line.lo[j] - line.lo[i]) * t,
    hi: line.hi[i] + (line.hi[j] - line.hi[i]) * t,
  };
}

const lines = new WeakMap<Track, Map<number, RacingLine>>();

/** A track's fastest line, kept `margin` inside the track limits (default the usual), worked out once per track and margin. */
export function fastestLine(track: Track, margin = DEFAULTS.margin): RacingLine {
  let byMargin = lines.get(track);
  if (!byMargin) { byMargin = new Map(); lines.set(track, byMargin); }
  let line = byMargin.get(margin);
  if (!line) { line = racingLine(track, { margin }); byMargin.set(margin, line); }
  return line;
}

/** The share of the friction ellipse a scripted racer leaves spare for its own corrections. */
const CONTROL_SPARE = 0.05;

/**
 * Drive a racing line: hold its offset across the track (steering for the
 * line's own curvature, its sideways slope, and feedback), at the speed
 * profile for `grip` of the tyres' grip (as worn as they are), braking as the profile does (its
 * slowing ahead, planned, plus feedback). Lateral has priority in the
 * friction circle.
 */
/** Metres a second below the line's speed over which a limit ahead takes over the throttle (followRacingLine's capGain). */
const CAP_BLEND = 3;

export function followRacingLine(
  car: Car, world: World, line: RacingLine, grip: number,
  /** Drive this far across from the line (+d), e.g. alongside another car. */
  offset = 0,
  /** A lower speed limit at a distance ahead (e.g. the car in front, a tighter arc), if any. */
  capAt?: (ahead: number) => number,
  /**
   * Below the profile's speed: close on it in proportion to how far below it is (1/s), as above it, rather than
   * flat out. A teacher's throttle has to be one a student can copy. Unset: flat out.
   */
  driveGain?: number,
  /**
   * Where the speed limit ahead (capAt: a car ahead) is below the line's own: close on it in proportion (1/s), both
   * ways, rather than flat out below it and braking above. Following a car, flat out until the limit then braking
   * flicks between the two on the smallest change in the car ahead, which no student can copy. Unset: as the line.
   */
  capGain?: number,
): void {
  const track = world.track;
  const i = car.trackIdx;
  const tx = track.tx[i], ty = track.ty[i];
  const nx = -ty, ny = tx;
  const vLon = car.vx * tx + car.vy * ty;
  const vLat = car.vx * nx + car.vy * ny;
  const capacity = Math.max(1, car.capacity);
  const capacityLon = Math.max(1, car.capacityLon);
  // Its share of the grip the tyres have now: worn tyres, slower (in steps of 2%, so profiles are shared).
  const speeds = line.at(Math.round(grip * car.grip * 50) / 50).speed;
  const n = speeds.length;
  const speedAt = (ahead: number) => {
    const f = ((((car.s + ahead) / line.step) % n) + n) % n, a = Math.floor(f), t = f - a;
    const v = speeds[a] + (speeds[(a + 1) % n] - speeds[a]) * t;
    return capAt ? Math.min(v, capAt(ahead)) : v;
  };

  // Along: the profile's speed change over the next stretch (planned), and the error now (feedback).
  const here = lineAt(line, car.s);
  const reach = Math.max(3, vLon * 0.25);
  const vNow = speedAt(0), vNext = speedAt(reach);
  const planned = (vNext * vNext - vNow * vNow) / (2 * reach);
  let lonWanted = vLon < vNow && planned >= 0 && driveGain === undefined ? 99 : planned + (driveGain ?? 4) * (vNow - vLon);
  if (capGain !== undefined && capAt) {
    // How far the limit ahead is below the line's own speed here: proportional once it's a few m/s below, blending in.
    const own = speeds[((Math.round(car.s / line.step) % n) + n) % n];
    const w = Math.max(0, Math.min(1, (own - vNow) / CAP_BLEND));
    if (w > 0) lonWanted = (1 - w) * lonWanted + w * (planned + capGain * (vNow - vLon));
  }

  // Across: following d = D(s) along a curved road. With s' = vLon / (1 - k d), the acceleration across the
  // track it takes is vLon^2 (D'' / (1 - k d)^2 + k / (1 - k d)) (the road's curve, and the line's bend
  // across it); its sideways speed is D' s'. Plus feedback on the error where the car is.
  const k = track.kappa[i];
  const stretch = Math.max(0.2, 1 - k * car.d);
  const back = lineAt(line, car.s - 2), fwd = lineAt(line, car.s + 2);
  const bend = (fwd.d - 2 * here.d + back.d) / 4;
  const vLatWanted = (vLon * (fwd.d - back.d) / 4) / stretch;
  const feedforward = vLon * vLon * (bend / (stretch * stretch) + k / stretch);
  const latWanted = feedforward + 2 * (here.d + offset - car.d) - 3 * (vLat - vLatWanted) - car.bankAcc;

  const latMax = capacity * (1 - CONTROL_SPARE);
  const lat = Math.max(-latMax, Math.min(latMax, latWanted));
  const lonRoom = capacityLon * Math.sqrt(Math.max(0, 1 - (lat / capacity) ** 2));
  const lon = Math.max(-lonRoom, Math.min(lonRoom, lonWanted));
  const wx = lon * tx + lat * nx, wy = lon * ty + lat * ny;
  const fx = car.frameX, fy = car.frameY;
  car.inputX = (wx * fx + wy * fy) / (P.OVERDRIVE_MAX * capacityLon);
  car.inputY = (wx * -fy + wy * fx) / (P.OVERDRIVE_MAX * capacity);
}

/** A scripted racer: the track's fastest line, driven at a share of the tyres' grip. */
export class RacingLineDriver {
  constructor(private readonly grip = 0.95, private readonly lineFor: (track: Track) => RacingLine = fastestLine) {}

  decide(car: Car, world: World): void {
    followRacingLine(car, world, this.lineFor(world.track), this.grip);
  }
}

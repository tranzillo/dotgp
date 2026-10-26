import { Car } from './car';
import { CLASSIC_CAR, type CarSpec } from './carSpec';
import { PIT_SERVICE } from './constants';
import type { Surface, Track } from './track';

/**
 * The wrecker: a heavy tow truck, a round dot like everything else, a size
 * up. Not the car physics (no tire model, banking or draft): a vehicle with a
 * heading that steers within its turning circle, gets going slowly and brakes
 * early, its speed planned along the path it follows from how sharply the
 * path bends and what it runs over. With a car on the hook, the car trails it
 * on the tow line, cutting inside the corners the truck drives round.
 */
export const TRUCK = {
  RADIUS: 2.1,
  /** A medium-duty wrecker (kg), and the car it tows. */
  MASS: 9000,
  TOW_MASS: 1450,
  POWER: 220e3,
  /** Most it accelerates (m/s^2), and brakes (towing: gentler, the car behind has no brakes of its own). */
  ACCEL: 1.6,
  BRAKE: 2.5,
  TOW_BRAKE: 1.8,
  /** Most it corners (m/s^2): 0.3 g, a truck's, not a race car's. */
  LAT: 3,
  MIN_RADIUS: 9,
  /** How fast it can wind the steering on (1/m per s): straight to full lock in under a second. */
  STEER_RATE: 0.15,
  /** Top speeds (m/s): out to a wreck, towing one, going back to its post (no hurry), on grass. */
  SPEED: 22,
  TOW_SPEED: 12,
  RETURN_SPEED: 12,
  GRASS_SPEED: 6,
  LOT_SPEED: 7,
  /** The tow line, centre to centre (m). */
  HITCH: 5,
  /** How far past a wreck it pulls up, in its lane, to back up to it (m), and how fast it backs (m/s). */
  BACK_UP: 10,
  BACK_SPEED: 1.5,
} as const;

/**
 * Whether the wreckers are solid, and seen as traffic by the drivers (spotter, formation driving), or pass through
 * cars. Off until drivers are trained with trucks coming out onto the track: untrained, they drove into them.
 */
export const TRUCKS_SOLID = false;

export const WRECKER_SPEC: CarSpec = { ...CLASSIC_CAR, name: 'wrecker', dryMass: TRUCK.MASS };

/** A wrecker's body in the world (solid, other cars see it), parked where it's put. */
export function truckBody(id: number, track: Track, at: [number, number]): Car {
  const body = new Car(id, '#ff7a1a');
  body.radius = TRUCK.RADIUS;
  body.spec = WRECKER_SPEC;
  body.fuel = 0;
  body.x = at[0];
  body.y = at[1];
  const p = track.project(at[0], at[1]);
  body.s = p.s; body.d = p.d; body.trackIdx = p.idx;
  return body;
}

const STEP = 2;
/** The last of its path (m) a truck parks along, straight in at most this fast (m/s). */
const PARK = 12;
const PARK_SPEED = 2;

/**
 * A path to drive: points every STEP metres and the most the truck should be
 * doing at each, from the bends ahead, the ground and stopping at the end.
 */
export class TruckPath {
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** Distance along the path at each point. */
  readonly at: Float64Array;
  readonly v: Float64Array;
  /** Out on the racing surface at each point. */
  readonly racing: Uint8Array;
  readonly length: number;

  constructor(points: Array<[number, number]>, track: Track, top: number, brake: number) {
    const xs: number[] = [], ys: number[] = [];
    const pts = rounded(simplified(points.filter((p, k) => k === 0 || Math.hypot(p[0] - points[k - 1][0], p[1] - points[k - 1][1]) > 1e-6)));
    xs.push(pts[0][0]); ys.push(pts[0][1]);
    let carry = 0;
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
      const seg = Math.hypot(bx - ax, by - ay);
      let u = STEP - carry;
      for (; u < seg; u += STEP) { xs.push(ax + ((bx - ax) * u) / seg); ys.push(ay + ((by - ay) * u) / seg); }
      carry = seg - (u - STEP);
    }
    const last = pts[pts.length - 1];
    if (Math.hypot(last[0] - xs[xs.length - 1], last[1] - ys[ys.length - 1]) > 0.2) { xs.push(last[0]); ys.push(last[1]); }
    const n = xs.length;
    this.x = Float64Array.from(xs);
    this.y = Float64Array.from(ys);
    this.at = new Float64Array(n);
    for (let i = 1; i < n; i++) this.at[i] = this.at[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    this.length = this.at[n - 1];
    // How fast at each point: the bend there (over 12 m), the ground, then braking back from what's ahead.
    this.v = new Float64Array(n);
    this.racing = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 3), b = Math.min(n - 1, i + 3);
      const k = a < i && i < b ? menger(xs[a], ys[a], xs[i], ys[i], xs[b], ys[b]) : 0;
      // (Found afresh, not from the last point's: in the infield, following on from it wanders to the far side.)
      const p = track.project(xs[i], ys[i]);
      const surface = track.surfaceAt(p.s, p.d, xs[i], ys[i]);
      this.racing[i] = surface === 'track' || surface === 'kerb' ? 1 : 0;
      const ground = groundSpeed(surface, top);
      this.v[i] = Math.min(ground, Math.sqrt(TRUCK.LAT / Math.max(k, 1e-6)));
    }
    this.v[n - 1] = 0;
    for (let i = n - 2; i >= 0; i--) {
      this.v[i] = Math.min(this.v[i], Math.sqrt(this.v[i + 1] ** 2 + 2 * brake * (this.at[i + 1] - this.at[i])));
    }
  }

  get end(): [number, number] {
    return [this.x[this.x.length - 1], this.y[this.y.length - 1]];
  }
}

/**
 * A route's corners rounded the way it's driven: each turned through on a
 * curve of up to CORNER_RADIUS (less where the legs either side are short).
 * (Taken as drawn, a road network's corners had the truck crawling round
 * them at full lock.)
 */
function rounded(pts: Array<[number, number]>): Array<[number, number]> {
  if (pts.length < 3) return pts;
  const out: Array<[number, number]> = [pts[0]];
  for (let k = 1; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k - 1], [bx, by] = pts[k], [cx, cy] = pts[k + 1];
    const l1 = Math.hypot(bx - ax, by - ay), l2 = Math.hypot(cx - bx, cy - by);
    const ux = (bx - ax) / l1, uy = (by - ay) / l1, vx = (cx - bx) / l2, vy = (cy - by) / l2;
    const turn = Math.acos(Math.max(-1, Math.min(1, ux * vx + uy * vy)));
    if (turn < 0.05) { out.push(pts[k]); continue; }
    const cut = Math.min(CORNER_RADIUS * Math.tan(turn / 2), MAX_CUT, l1 / 2, l2 / 2);
    const p: [number, number] = [bx - ux * cut, by - uy * cut], q: [number, number] = [bx + vx * cut, by + vy * cut];
    // (A quadratic through the corner: close enough to the arc.)
    const steps = Math.max(2, Math.ceil((cut * 2) / STEP));
    for (let i = 0; i <= steps; i++) {
      const f = i / steps, g = 1 - f;
      out.push([g * g * p[0] + 2 * g * f * bx + f * f * q[0], g * g * p[1] + 2 * g * f * by + f * f * q[1]]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
const CORNER_RADIUS = 15;
/** The most a corner is cut back along each leg (m): a hairpin's curve stays near the corner. */
const MAX_CUT = 20;

/**
 * A route with its points along a straight-enough line dropped (to within
 * SIMPLIFY m of the original): corners with real legs to round on. (A road
 * network's polylines are dense; rounded at each point, a corner's curve
 * came out far tighter than the truck can turn.)
 */
function simplified(pts: Array<[number, number]>): Array<[number, number]> {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const vx = bx - ax, vy = by - ay, len = Math.hypot(vx, vy) || 1;
    let far = -1, farD = SIMPLIFY;
    for (let k = a + 1; k < b; k++) {
      const off = Math.abs((pts[k][0] - ax) * vy - (pts[k][1] - ay) * vx) / len;
      if (off > farD) { farD = off; far = k; }
    }
    if (far < 0) continue;
    keep[far] = 1;
    stack.push([a, far], [far, b]);
  }
  return pts.filter((_, k) => keep[k]);
}
const SIMPLIFY = 0.5;

function groundSpeed(surface: Surface, top: number): number {
  switch (surface) {
    case 'grass': case 'gravel': return Math.min(top, TRUCK.GRASS_SPEED);
    case 'garage': return Math.min(top, TRUCK.LOT_SPEED);
    case 'pit': return Math.min(top, PIT_SERVICE.SPEED_LIMIT);
    default: return top;
  }
}

/** Curvature of the circle through three points. */
function menger(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const area2 = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
  const abc = Math.hypot(bx - ax, by - ay) * Math.hypot(cx - bx, cy - by) * Math.hypot(cx - ax, cy - ay);
  return abc > 1e-9 ? (2 * area2) / abc : 0;
}

/** A truck under way: its body, heading, speed and steering, and the path it's on. */
export interface TruckDrive {
  body: Car;
  heading: number;
  speed: number;
  /** Curvature it's steering (1/m, + to the left). */
  kappa: number;
  path: TruckPath | null;
  /** The path point it has got to. */
  idx: number;
}

/** Set off along a path from rest: pointed along it (parked facing out). */
export function setOff(t: TruckDrive, path: TruckPath): void {
  t.path = path;
  t.idx = 0;
  if (t.speed < 0.5) {
    const j = Math.min(path.x.length - 1, 4);
    const dx = path.x[j] - t.body.x, dy = path.y[j] - t.body.y;
    if (Math.hypot(dx, dy) > 0.5) t.heading = Math.atan2(dy, dx);
    t.kappa = 0;
  }
}

/**
 * One step along its path (pure pursuit: steer for a point a little way
 * ahead, within the turning circle and the steering's rate). True once it has
 * stopped at the end. hold: waiting (for a gap in traffic), it brakes to a stop.
 */
export function driveTruck(t: TruckDrive, dt: number, towing: boolean, hold = false): boolean {
  const path = t.path;
  const body = t.body;
  if (!path) { t.speed = 0; body.vx = 0; body.vy = 0; return true; }
  const n = path.x.length;
  // Where it has got to: the nearest point a little way on from the last.
  let best = t.idx, bestD = Infinity;
  for (let j = t.idx; j < Math.min(n, t.idx + 30); j++) {
    const dd = (path.x[j] - body.x) ** 2 + (path.y[j] - body.y) ** 2;
    if (dd < bestD) { bestD = dd; best = j; }
  }
  t.idx = best;
  const c = Math.cos(t.heading), s = Math.sin(t.heading);
  const aim = (look: number) => {
    let j = t.idx;
    while (j < n - 1 && path.at[j] - path.at[t.idx] < look) j++;
    const dx = path.x[j] - body.x, dy = path.y[j] - body.y;
    return { dx, dy, ahead: c * dx + s * dy, left: -s * dx + c * dy };
  };
  let { dx, dy, ahead, left } = aim(Math.max(5, Math.min(12, 4 + 0.5 * t.speed)));
  // Inside its turning circle (the way it's turning): it can't get there, it would circle it for good. A point
  // further on, out of the circle, instead.
  const R = TRUCK.MIN_RADIUS, cy = left >= 0 ? R : -R;
  if (Math.hypot(ahead, left - cy) < R) ({ dx, dy, ahead, left } = aim(2 * R + 6));
  const dist2 = dx * dx + dy * dy;
  const lock = 1 / TRUCK.MIN_RADIUS;
  // Where it's going is behind it: round toward it on full lock. (Pure pursuit asks for next to no steering for a
  // point far off behind: trucks drove straight away from their paths until they were moved back onto them.)
  const want = ahead < 0 ? (left >= 0 ? lock : -lock)
    : dist2 > 1e-6 ? Math.max(-lock, Math.min(lock, (2 * left) / dist2)) : 0;
  t.kappa += Math.max(-TRUCK.STEER_RATE * dt, Math.min(TRUCK.STEER_RATE * dt, want - t.kappa));

  const [ex, ey] = path.end;
  const toEnd = Math.hypot(ex - body.x, ey - body.y);
  const brake = towing ? TRUCK.TOW_BRAKE : TRUCK.BRAKE;
  if (!hold && toEnd < PARK && path.length - path.at[t.idx] < PARK + 4) {
    // Parking: the last few metres straight in at walking pace, as a truck shuffles into a spot on its steering.
    // (On its turning circle it circled a bay or a post it couldn't quite stop on.)
    let v = Math.min(PARK_SPEED, Math.sqrt(2 * brake * toEnd) + 0.2);
    if (t.speed > v) v = Math.max(v, t.speed - brake * dt);
    const step = Math.min(toEnd, v * dt);
    if (toEnd < 0.05) { t.speed = 0; body.vx = 0; body.vy = 0; return true; }
    const ux = (ex - body.x) / toEnd, uy = (ey - body.y) / toEnd;
    t.heading = Math.atan2(uy, ux);
    t.kappa = 0;
    t.speed = v;
    body.vx = ux * v; body.vy = uy * v;
    body.x += ux * step; body.y += uy * step;
    if (toEnd - step > 0.05) return false;
    t.speed = 0; body.vx = 0; body.vy = 0;
    return true;
  }
  // (On the last point the plan's 0 is where the path ends, not where the truck is: short of it, it stopped dead.)
  const planned = t.idx + 1 < n - 1 ? path.v[t.idx + 1] : Infinity;
  let target = Math.min(planned, Math.sqrt(2 * brake * Math.max(0, toEnd - 0.3)));
  // Turned well away from where it's going (pulling out of a bay, a hairpin): round at a crawl.
  if (ahead < 0 || Math.abs(left) > ahead) target = Math.min(target, 3);
  if (hold) target = 0;
  const mass = TRUCK.MASS + (towing ? TRUCK.TOW_MASS : 0);
  const accel = Math.min(TRUCK.ACCEL, TRUCK.POWER / (mass * Math.max(1, t.speed)));
  t.speed += Math.max(-brake * dt, Math.min(accel * dt, target - t.speed));
  t.heading += t.speed * t.kappa * dt;
  body.vx = t.speed * Math.cos(t.heading);
  body.vy = t.speed * Math.sin(t.heading);
  body.x += body.vx * dt;
  body.y += body.vy * dt;
  if (!hold && toEnd < 1 && t.speed < 0.2) {
    t.speed = 0; body.vx = 0; body.vy = 0;
    return true;
  }
  return false;
}

/** A towed car on the line: where the line is taut, pulled along behind the truck; slack, it stays put. */
export function trail(wreck: Car, truck: Car): void {
  const dx = wreck.x - truck.x, dy = wreck.y - truck.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= TRUCK.HITCH || dist < 1e-9) return;
  wreck.x = truck.x + (dx / dist) * TRUCK.HITCH;
  wreck.y = truck.y + (dy / dist) * TRUCK.HITCH;
}

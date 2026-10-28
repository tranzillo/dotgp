import { PHYSICS as P, SURFACES } from '../sim/constants';
import type { Car } from '../sim/car';
import { brakingAt, carSpec, cornerSpeed } from '../sim/carSpec';
import type { World } from '../sim/world';

/**
 * Hand-written control law: follow a lateral path d = laneAt(s) under a speed
 * cap capAt(s), braking early enough for corners and caps ahead. Used by the
 * scripted baseline driver and the pit maneuver, never by learned drivers.
 * sweep: the path moves across the track a long way (a pit lane swinging over
 * to a pit road set back across grass): match its sideways slope as well as
 * close on it, or the car falls further and further behind it.
 */
/** Over its target speed, how hard followLine brakes back to it (1/s), up to its braking limit. */
export const BRAKE_GAIN = 6;

/**
 * The speed to ask followLine for to slow from the car's speed at about `decel` (m/s^2), down to `floor`: easing off
 * rather than braking as hard as it can to a lower target at once.
 */
export function easingTo(car: Car, floor: number, decel: number): number {
  return Math.max(floor, car.speed - decel / BRAKE_GAIN);
}

export function followLine(
  car: Car,
  world: World,
  laneAt: (s: number) => number,
  capAt: (s: number) => number,
  margin = 0.95,
  sweep = false,
  /**
   * Below the target speed: drive toward it in proportion to how far below it is (1/s), as braking above it does,
   * instead of flat out. Smooth: what a driver learning by copying it can learn (it can't copy on-off flicking
   * between full throttle and the brakes). Unset: flat out.
   */
  driveGain?: number,
): void {
  const track = world.track;
  const i = car.trackIdx;
  const tx = track.tx[i], ty = track.ty[i];
  const nx = -ty, ny = tx;
  const vLon = car.vx * tx + car.vy * ty;
  const vLat = car.vx * nx + car.vy * ny;
  const capacity = Math.max(1, car.capacity);
  const capacityLon = Math.max(1, car.capacityLon);
  // (The car's own grip, downforce and load sensitivity: carSpec.ts. The classic car's: mu g.)
  const spec = car.spec ?? carSpec(track);
  const brake = 0.7 * brakingAt(spec, track, P.TIRE_MU * car.gripLon * SURFACES[car.surface].grip, car.speed, car.mass);

  // Target speed: the slowest corner speed or cap ahead, reachable by braking.
  let target = Math.min(105, capAt(car.s));
  // Every 5 m: a road circuit's tight corners can be shorter than 20 m of arc.
  for (let ahead = 0; ahead <= 400; ahead += 5) {
    const s = car.s + ahead;
    const lane = laneAt(s);
    const k = track.curvatureAt(s);
    const kappa = k / Math.max(0.2, 1 - k * lane);
    let limit = capAt(s);
    if (Math.abs(kappa) > 1e-6) {
      // The surface only matters in a corner (and it's the costly lookup here).
      const mu = P.TIRE_MU * car.grip * SURFACES[track.surfaceAt(s, lane)].grip;
      // Banking that leans into the turn (whichever way it goes) helps; leaning away costs.
      const bank = Math.sign(kappa) * track.bankAt(track.indexAt(s), lane);
      limit = Math.min(limit, cornerSpeed(spec, track, mu, kappa, bank, car.mass, Infinity) * margin);
    }
    // (Swinging across the track takes grip too: plan to brake more gently on a lane that does.)
    target = Math.min(target, Math.sqrt(limit * limit + 2 * (sweep ? 0.6 * brake : brake) * ahead));
  }

  // Lateral: hold the track curvature, steer toward the lane (with a little preview), cancel drift.
  const laneTarget = laneAt(car.s + Math.max(5, vLon * 0.3));
  const kappaHere = track.kappa[i] / Math.max(0.2, 1 - track.kappa[i] * car.d);
  const vLatWanted = sweep ? vLon * (laneAt(car.s + 3) - laneAt(car.s - 3)) / 6 : 0;
  // (...and its bend: d'' times the rate along the lap squared, faster than vLon inside a corner.)
  const along = vLon / Math.max(0.2, 1 - track.kappa[i] * car.d);
  const bendWanted = sweep ? along * along * (laneAt(car.s + 5) - 2 * laneAt(car.s) + laneAt(car.s - 5)) / 25 : 0;
  const latWanted = vLon * vLon * kappaHere + bendWanted + 0.8 * (laneTarget - car.d) - 1.6 * (vLat - vLatWanted) - car.bankAcc;
  // Over target: brake hard enough to be back on the braking curve within a fraction of a second.
  const lonWanted = vLon < target ? (driveGain === undefined ? 99 : (target - vLon) * driveGain) : -Math.min(brake * 1.3, (vLon - target) * BRAKE_GAIN);

  // Lateral has priority inside the friction circle.
  const lat = Math.max(-capacity, Math.min(capacity, latWanted));
  const lonRoom = capacityLon * Math.sqrt(Math.max(0, 1 - (lat / capacity) ** 2));
  const lon = Math.max(-lonRoom, Math.min(lonRoom, lonWanted));

  // World vector -> travel frame, each axis scaled so 1/OVERDRIVE_MAX = at that axis's limit.
  const wx = lon * tx + lat * nx, wy = lon * ty + lat * ny;
  const fx = car.frameX, fy = car.frameY;
  car.inputX = (wx * fx + wy * fy) / (P.OVERDRIVE_MAX * capacityLon);
  car.inputY = (wx * -fy + wy * fx) / (P.OVERDRIVE_MAX * capacity);
}

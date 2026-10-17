import { G, PHYSICS as P, SURFACES } from '../sim/constants';
import type { Car } from '../sim/car';
import type { World } from '../sim/world';

/**
 * Hand-written control law: follow a lateral path d = laneAt(s) under a speed
 * cap capAt(s), braking early enough for corners and caps ahead. Used by the
 * scripted baseline driver and the pit maneuver, never by learned drivers.
 */
export function followLine(
  car: Car,
  world: World,
  laneAt: (s: number) => number,
  capAt: (s: number) => number,
  margin = 0.95,
): void {
  const track = world.track;
  const i = car.trackIdx;
  const tx = track.tx[i], ty = track.ty[i];
  const nx = -ty, ny = tx;
  const vLon = car.vx * tx + car.vy * ty;
  const vLat = car.vx * nx + car.vy * ny;
  const capacity = Math.max(1, car.capacity);
  const capacityLon = Math.max(1, car.capacityLon);
  const brake = 0.7 * P.TIRE_MU * car.gripLon * SURFACES[car.surface].grip * G;

  // Target speed: the slowest corner speed or cap ahead, reachable by braking.
  let target = Math.min(95, capAt(car.s));
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
      const c = Math.cos(bank), sn = Math.sin(bank);
      limit = Math.min(limit, Math.sqrt((G * (sn + mu * c)) / Math.max(0.05, c - mu * sn) / Math.abs(kappa)) * margin);
    }
    target = Math.min(target, Math.sqrt(limit * limit + 2 * brake * ahead));
  }

  // Lateral: hold the track curvature, steer toward the lane (with a little preview), cancel drift.
  const laneTarget = laneAt(car.s + Math.max(5, vLon * 0.3));
  const kappaHere = track.kappa[i] / Math.max(0.2, 1 - track.kappa[i] * car.d);
  const latWanted = vLon * vLon * kappaHere + 0.8 * (laneTarget - car.d) - 1.6 * vLat - car.bankAcc;
  // Over target: brake hard enough to be back on the braking curve within a fraction of a second.
  const lonWanted = vLon < target ? 99 : -Math.min(brake * 1.3, (vLon - target) * 6);

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

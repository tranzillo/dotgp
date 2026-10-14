import { PHYSICS as P } from './constants';
import { applyImpact, type Car } from './car';
import type { Track } from './track';

/**
 * Walls are analytic lines in track space (constant d over an s range), so
 * there are no segment seams. The response keeps tangential speed apart from
 * Coulomb friction proportional to the normal impulse: a shallow hit becomes
 * a scrape along the wall, a steep one bounces off and hurts.
 *
 * The track's layout says where the walls are (on ovals: the outer wall all
 * the way round, and the pit wall along the front straight, two-sided with
 * solid ends that can be hit nose-first).
 */
export function resolveWalls(car: Car, track: Track, damageScale = 1): void {
  const r = P.CAR_RADIUS;
  const i = car.trackIdx;
  const nx = -track.ty[i], ny = track.tx[i];
  const wasInContact = car.wallContact;
  car.wallContact = false;

  for (const wall of track.walls) {
    if (!track.inRange(car.s, wall.range)) continue;
    const mid = typeof wall.d === 'number' ? wall.d : track.edgeAt(wall.d, car.s);
    const half = wall.thickness / 2;
    if (wall.faces === 'in') {
      // Keeps cars on its +d side.
      const pen = mid + half - (car.d - r);
      if (pen > 0) wallImpact(car, nx, ny, pen, 1, wasInContact, damageScale);
    } else if (wall.faces === 'out') {
      const pen = car.d + r - (mid - half);
      if (pen > 0) wallImpact(car, -nx, -ny, pen, -1, wasInContact, damageScale);
    } else {
      const gap = car.d - mid;
      const pen = r + half - Math.abs(gap);
      if (pen > 0) {
        const side = gap >= 0 ? 1 : -1; // push back to whichever side the car is on
        wallImpact(car, nx * side, ny * side, pen, side, wasInContact, damageScale);
      }
    }
  }
  // Wall ends: a car arriving head-on hits the end, not the face.
  for (const cap of track.wallCaps) {
    const dx = car.x - cap.x, dy = car.y - cap.y;
    const dist = Math.hypot(dx, dy);
    const pen = r + cap.radius - dist;
    if (pen > 0 && dist > 1e-9) {
      const Nx = dx / dist, Ny = dy / dist;
      wallImpact(car, Nx, Ny, pen, Nx * nx + Ny * ny, wasInContact, damageScale);
    }
  }
}

/** dShift: how much of the push-out lands on the track's lateral axis. */
function wallImpact(
  car: Car, Nx: number, Ny: number, pen: number, dShift: number, wasInContact: boolean, damageScale: number,
): void {
  car.x += Nx * pen;
  car.y += Ny * pen;
  car.d += dShift * pen;
  car.wallContact = true;

  const vn = car.vx * Nx + car.vy * Ny;
  if (vn >= 0) return;
  const tX = car.vx - vn * Nx, tY = car.vy - vn * Ny;
  const vtMag = Math.hypot(tX, tY);
  const dvn = -(1 + P.WALL_RESTITUTION) * vn;
  const friction = Math.min(vtMag, P.WALL_FRICTION * dvn);
  const dvx = Nx * dvn - (vtMag > 1e-9 ? (tX / vtMag) * friction : 0);
  const dvy = Ny * dvn - (vtMag > 1e-9 ? (tY / vtMag) * friction : 0);
  car.vx += dvx;
  car.vy += dvy;

  if (!wasInContact && -vn > P.DAMAGE_SPEED_THRESHOLD) car.wallHits++;
  // Friction work is charged on every touch, so riding the wall on repeated
  // micro-bounces costs as much as a sustained scrape.
  if (!car.retired) applyImpact(car, dvx, dvy, -vn, friction * vtMag, damageScale);
}

/**
 * Each car's share of the fault for contact between A and B (A's share; B's
 * is the rest), in the track frame: closing along the track is the car
 * behind's fault, moving across into the other car is the mover's. Neither
 * (touching at the same speed, side by side): shared.
 */
export function faultShare(A: Car, B: Car, track: Track): number {
  const i = A.trackIdx;
  const tx = track.tx[i], ty = track.ty[i];
  const lx = -ty, ly = tx;
  const dx = B.x - A.x, dy = B.y - A.y;
  const dist = Math.hypot(dx, dy) || 1;
  const along = (dx * tx + dy * ty) / dist; // > 0: B is ahead of A
  const across = (dx * lx + dy * ly) / dist;
  const closing = Math.max(0, ((A.vx - B.vx) * tx + (A.vy - B.vy) * ty) * Math.sign(along)) * Math.abs(along);
  const side = Math.sign(across);
  const latA = Math.max(0, (A.vx * lx + A.vy * ly) * side) * Math.abs(across);
  const latB = Math.max(0, -(B.vx * lx + B.vy * ly) * side) * Math.abs(across);
  const wA = (along > 0 ? closing : 0) + latA;
  const wB = (along < 0 ? closing : 0) + latB;
  return wA + wB < 0.05 ? 0.5 : wA / (wA + wB);
}

/** Circle-circle impulses between every overlapping pair; damage done is charged by fault (with a track). */
export function resolveCarCollisions(cars: Car[], track?: Track): void {
  const r2 = 2 * P.CAR_RADIUS;
  for (let a = 0; a < cars.length; a++) {
    const A = cars[a];
    if (A.cleared) continue;
    for (let b = a + 1; b < cars.length; b++) {
      const B = cars[b];
      if (B.cleared) continue;
      const dx = B.x - A.x, dy = B.y - A.y;
      if (Math.abs(dx) > r2 || Math.abs(dy) > r2) continue;
      const dist2 = dx * dx + dy * dy;
      if (dist2 >= r2 * r2 || dist2 < 1e-12) continue;
      const dist = Math.sqrt(dist2);
      const nx = dx / dist, ny = dy / dist;
      const invA = 1 / A.mass, invB = 1 / B.mass;
      const invSum = invA + invB;

      // Separate, weighted by mass.
      const pen = r2 - dist;
      A.x -= nx * pen * (invA / invSum);
      A.y -= ny * pen * (invA / invSum);
      B.x += nx * pen * (invB / invSum);
      B.y += ny * pen * (invB / invSum);

      const rvx = B.vx - A.vx, rvy = B.vy - A.vy;
      const vrel = rvx * nx + rvy * ny;
      if (vrel >= 0) continue;
      // Who caused it, judged on the velocities going in.
      const fault = track ? faultShare(A, B, track) : 0.5;
      const j = (-(1 + P.CAR_RESTITUTION) * vrel) / invSum;

      // Tangential friction (rubbing), capped by Coulomb.
      const tvx = rvx - vrel * nx, tvy = rvy - vrel * ny;
      const tvm = Math.hypot(tvx, tvy);
      const jt = tvm > 1e-9 ? Math.min(tvm / invSum, P.CAR_FRICTION * j) : 0;
      const tx = tvm > 1e-9 ? tvx / tvm : 0, ty = tvm > 1e-9 ? tvy / tvm : 0;

      const ix = j * nx + jt * tx, iy = j * ny + jt * ty;
      A.vx -= ix * invA; A.vy -= iy * invA;
      B.vx += ix * invB; B.vy += iy * invB;

      const closing = -vrel;
      const hA = A.health, hB = B.health;
      if (!A.retired) applyImpact(A, -ix * invA, -iy * invA, closing, jt * invA * tvm, 1, { kind: 'car', other: B.id });
      if (!B.retired) applyImpact(B, ix * invB, iy * invB, closing, jt * invB * tvm, 1, { kind: 'car', other: A.id });
      A.harmDone += (hB - B.health) * fault;
      B.harmDone += (hA - A.health) * (1 - fault);
      A.selfInflicted += (hA - A.health) * fault;
      B.selfInflicted += (hB - B.health) * (1 - fault);
      if (A.lastImpact?.other === B.id && hA !== A.health) A.lastImpact.fault = fault;
      if (B.lastImpact?.other === A.id && hB !== B.health) B.lastImpact.fault = 1 - fault;
    }
  }
}

/** Slipstream: a car tucked behind another in the same lane sees less drag. */
export function computeDraft(cars: Car[], track: Track): void {
  for (const c of cars) c.draftFactor = 1;
  const L = track.length;
  for (const A of cars) {
    if (A.retired) continue;
    let best = 0;
    for (const B of cars) {
      if (B === A || B.retired) continue;
      const gap = (((B.s - A.s) % L) + L) % L;
      if (gap <= 0 || gap > P.DRAFT_LENGTH) continue;
      const lateral = Math.abs(B.d - A.d);
      if (lateral > P.DRAFT_WIDTH) continue;
      const strength = (1 - gap / P.DRAFT_LENGTH) * (1 - lateral / P.DRAFT_WIDTH);
      if (strength > best) best = strength;
      // The leader gets a small push from the car behind.
      B.draftFactor = Math.min(B.draftFactor, 1 - P.DRAFT_PUSH * strength);
    }
    A.draftFactor = Math.min(A.draftFactor, 1 - P.DRAFT_MAX * best);
  }
}

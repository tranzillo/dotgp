import { PHYSICS as P } from '../sim/constants';
import type { Car } from '../sim/car';
import type { World } from '../sim/world';

/**
 * Fear: what makes a driver back off before anything has happened. Real
 * drivers rarely learn not to crash by crashing; they feel the gap closing
 * too fast, the car alongside drifting in, the wall coming at them with the
 * car sliding, and lift. Crashes are rare (so learning from them alone is
 * noise); these moments are constant, so fear is a steady signal.
 *
 * danger() is 0 when nothing is threatening and rises to 1 as a collision
 * gets imminent (time to contact running out). Only threats the driver makes
 * count: closing on the car ahead, moving across into a car alongside or
 * toward a wall. Being closed on from behind is the other driver's fear.
 */

/** Seconds to contact at which fear starts: closing on the car ahead, and sideways (cars, walls). */
const TTC_AHEAD = 1.2;
const TTC_SIDE = 0.6;
/** Only cars this close along the track are considered (m). */
const RANGE = 40;

export function danger(car: Car, world: World): number {
  if (car.retired || car.cleared) return 0;
  const track = world.track;
  const i = car.trackIdx;
  const tx = track.tx[i], ty = track.ty[i];
  const lx = -ty, ly = tx; // +d
  const along = car.vx * tx + car.vy * ty;
  const across = car.vx * lx + car.vy * ly;
  const r2 = 2 * P.CAR_RADIUS;
  let fear = 0;

  for (const other of world.cars) {
    if (other === car || other.cleared) continue;
    let ds = track.distanceFrom(car.s, other.s);
    if (ds > track.length / 2) ds -= track.length;
    if (ds < -RANGE || ds > RANGE) continue;
    const dd = other.d - car.d;
    const oAlong = other.vx * tx + other.vy * ty;
    const oAcross = other.vx * lx + other.vy * ly;
    if (ds > 0 && Math.abs(dd) < r2 + 0.5) {
      // In our path ahead: time until we're on its bumper.
      const gap = ds - r2;
      const closing = along - oAlong;
      if (gap <= 0.3) fear = Math.max(fear, 1);
      else if (closing > 0) fear = Math.max(fear, 1 - gap / closing / TTC_AHEAD);
    } else if (Math.abs(ds) < r2 + 1) {
      // Alongside: time until we're door to door.
      const gap = Math.abs(dd) - r2;
      const closing = (across - oAcross) * Math.sign(dd);
      if (gap <= 0.2) fear = Math.max(fear, 1);
      else if (closing > 0) fear = Math.max(fear, 1 - gap / closing / TTC_SIDE);
    }
  }

  // Walls: time until we hit one we're moving toward.
  for (const wall of track.walls) {
    if (wall.faces === 'both' || !track.inRange(car.s, wall.range)) continue;
    const mid = typeof wall.d === 'number' ? wall.d : track.edgeAt(wall.d, car.s);
    const half = wall.thickness / 2;
    const gap = wall.faces === 'in' ? car.d - P.CAR_RADIUS - (mid + half) : mid - half - (car.d + P.CAR_RADIUS);
    if (gap < -1) continue; // the other side of it
    const toward = wall.faces === 'in' ? -across : across;
    if (gap <= 0.1 && toward > 0) fear = Math.max(fear, 1);
    else if (toward > 0) fear = Math.max(fear, 1 - gap / toward / TTC_SIDE);
  }
  return Math.max(0, fear);
}

export { trauma } from '../sim/car';

/**
 * Nerve: a driver's appetite for risk, its personality's main dial. 0 is
 * timid, 1 fearless; 0.5 the middle. It doesn't change what a driver can
 * do, only what it is trained to care about: fear and trauma cost a timid
 * driver more, a fearless one less, so drivers grow into different racers.
 */
export const DEFAULT_NERVE = 0.5;
export function fearScale(nerve = DEFAULT_NERVE): number {
  return 2 * (1 - Math.max(0, Math.min(1, nerve)));
}

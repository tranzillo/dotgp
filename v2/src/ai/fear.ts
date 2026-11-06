import { PHYSICS as P } from '../sim/constants';
import type { Car } from '../sim/car';
import type { World } from '../sim/world';
import { SAFE_HIT } from '../events/injury';
import { trauma } from '../sim/car';

/**
 * Fear: a driver's anticipation of getting hurt. Real drivers rarely learn
 * not to crash by crashing; they feel a hit coming (the gap closing too fast,
 * the car alongside drifting in, the barrier coming at them) and lift. Crashes
 * are rare, so learning from them alone is noise; these moments are constant.
 *
 * danger() is how soon a hit is coming times how badly it would hurt, for the
 * worst threat in sight, 0..1. How soon: time to contact running out (1.2 s
 * on the car ahead, 0.6 s sideways). How badly: the trauma of an impact at
 * that closing speed, by the sim's own damage model, against the hit at which
 * drivers start getting injured (SAFE_HIT); worse than that is all the same
 * terror. So rubbing at a walking pace is nothing, and a 14 m/s closing is
 * the most there is to fear. Any cause counts, since self-preservation
 * doesn't ask whose fault it is: closing on the car ahead, being closed on
 * from behind (a hit there barely hurts: push damage), cars alongside,
 * barriers. Fault is elsewhere (damage done to others, the stewards).
 */

/** Seconds to contact at which fear starts: along the track (ahead, behind), and sideways (cars, walls). */
const TTC_ALONG = 1.2;
const TTC_SIDE = 0.6;
/** Only cars this close along the track are considered (m). */
const RANGE = 40;

/** How badly an impact at this closing speed would hurt (0 nothing .. 1 a hit that could injure); push: hit from behind. */
export function hurt(closing: number, push = false): number {
  const thr = P.DAMAGE_SPEED_THRESHOLD;
  const damage = Math.max(0, closing * closing - thr * thr) * P.DAMAGE_PER_ENERGY * (push ? P.PUSH_DAMAGE_MULT : 1);
  return Math.min(1, trauma(damage) / INJURING);
}
const INJURING = trauma(SAFE_HIT);

/** Imminence of contact: 0 at the window's edge, 1 at contact. */
function imminence(gap: number, closing: number, window: number, touching: number): number {
  if (gap <= touching) return 1;
  return closing > 0 ? Math.max(0, 1 - gap / closing / window) : 0;
}

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
    if (Math.abs(dd) < r2 + 0.5) {
      // In line, ahead or behind: time until nose meets tail.
      const closing = ds > 0 ? along - oAlong : oAlong - along;
      fear = Math.max(fear, imminence(Math.abs(ds) - r2, closing, TTC_ALONG, 0.3) * hurt(closing, ds < 0));
    } else if (Math.abs(ds) < r2 + 1) {
      // Alongside: time until we're door to door.
      const closing = (across - oAcross) * Math.sign(dd);
      fear = Math.max(fear, imminence(Math.abs(dd) - r2, closing, TTC_SIDE, 0.2) * hurt(closing));
    }
  }

  // Walls: time until we hit one we're moving toward, and how hard.
  for (const wall of track.walls) {
    if (wall.faces === 'both' || !track.inRange(car.s, wall.range)) continue;
    const mid = typeof wall.d === 'number' ? wall.d : track.edgeAt(wall.d, car.s);
    const half = wall.thickness / 2;
    const gap = wall.faces === 'in' ? car.d - P.CAR_RADIUS - (mid + half) : mid - half - (car.d + P.CAR_RADIUS);
    if (gap < -1) continue; // the other side of it
    const toward = wall.faces === 'in' ? -across : across;
    if (toward > 0) fear = Math.max(fear, imminence(gap, toward, TTC_SIDE, 0.1) * hurt(toward));
  }
  return fear;
}

export { trauma };

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

import type { Rng } from '../ai/rng';
import type { Car } from '../sim/car';
import type { World } from '../sim/world';

/** Room kept from every car on track where the wrecks are put (m): the field comes on them while pacing, not now. */
const CLEAR_OF_CARS = 150;
/** Two wrecks together: at least this far apart across the track (m), within this far along it. */
const APART = 4;
const ALONG = 8;

/**
 * Wrecks under caution, for caution practice. Debris cautions leave nothing on track, and a caution skill that only
 * ever practised them drove its place's lane into the wrecks of a real caution (2026-10-31: on the speedway nearly
 * every retirement under caution was a pacing car into a wreck). Once the pace car has the field: one or two cars of
 * the pack (never one `pack` turns down) are wrecked together somewhere round the lap clear of traffic, stopped at
 * random across the track (an oval's apron included). Race control sends the wreckers as for any wreck; the field
 * meets them every lap until they're towed. Returns the wrecks.
 */
export function wreckInLine(world: World, rng: Rng, pack: (car: Car) => boolean): Car[] {
  const t = world.track;
  const cars = world.cars.filter((c) => pack(c) && !c.retired && c.pit.phase === 'none');
  if (!cars.length) return [];
  let s = rng.next() * t.length;
  for (let tries = 0; tries < 50; tries++) {
    if (world.cars.every((c) => c.retired || c.cleared || Math.min(t.distanceFrom(c.s, s), t.distanceFrom(s, c.s)) > CLEAR_OF_CARS)) break;
    s = rng.next() * t.length;
  }
  const lo = t.outerEdgeAt(s) + 2, hi = t.innerEdgeAt(s) + t.apronWidth / 2 - 2;
  const n = Math.min(cars.length, rng.next() < 0.6 ? 1 : 2);
  const wrecks: Car[] = [];
  let d = lo + rng.next() * (hi - lo);
  for (let k = 0; k < n; k++) {
    const car = cars.splice(rng.int(cars.length), 1)[0];
    if (k > 0) {
      // The second beside the first, on whichever side there's room.
      const other = d + (rng.next() < 0.5 ? -1 : 1) * (APART + 2 * rng.next());
      d = other < lo || other > hi ? d - Math.sign(other - d) * (APART + 2 * rng.next()) : other;
    }
    car.placeOnTrack(t, t.wrapS(s + ALONG * (rng.next() - 0.5) * k), Math.max(lo, Math.min(hi, d)));
    car.vx = 0;
    car.vy = 0;
    car.health = 0;
    car.retired = true;
    wrecks.push(car);
  }
  return wrecks;
}

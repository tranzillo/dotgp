// Preload for incidents.ts: which wrecks the field runs into. Every car that stops wrecked on the racing surface or
// an oval's apron is followed until it's towed: where it sits across the track (m from the outside wall's edge and
// from the inside edge), the room it leaves to get by (as raceControl.ts blockedPlaces reckons it), whether it's in a
// corner, and the flag; and whether another car went out within HIT m of it while it sat there (and how long after).
// Prints WRECKHIT lines at exit: wrecks and wrecks hit by each feature, so a narrow red-flag margin can be read off.
//   DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx --import ./scripts/wreckHits.ts scripts/incidents.ts \
//     public/drivers/stable-candidate-v8s-lines.json --tracks speedway --seeds 4 --field 40 --rules 1
import { World } from '../src/sim/world';
import { PHYSICS as P } from '../src/sim/constants';
import type { Car } from '../src/sim/car';

/** A car going out this near a wreck already there went into it (m along the track). */
const HIT = 50;
/** A car out into a wreck this long after it stopped (s) wasn't in the same tangle: a red flag could have stopped it. */
const LATE = 5;
/** Curvature over this (1/m) is a corner. */
const CORNER = 1e-3;

interface Wreck {
  car: Car; world: World; s: number; at: number; flag: string; track: string;
  fromOutside: number; fromInside: number; room: number; corner: boolean;
  hits: number; firstHit: number;
  /** When each car out into it went out (s after it stopped). */
  delays: number[];
}
const wrecks: Wreck[] = [];
const stoppedSeen = new WeakSet<Car>();
const retiredSeen = new WeakSet<Car>();

const step = World.prototype.step;
World.prototype.step = function (this: World) {
  step.call(this);
  const t = this.track;
  const flag = this.control?.flag ?? 'none';
  const name = `${t.length.toFixed(0)} m`;
  // New cars out: did they go into a wreck already there?
  for (const c of this.cars) {
    if (!c.retired || retiredSeen.has(c)) continue;
    retiredSeen.add(c);
    for (const w of wrecks) {
      if (w.world !== this || w.car === c || w.car.cleared) continue;
      const ds = t.distanceFrom(w.s, c.s);
      if (Math.min(ds, t.length - ds) > HIT) continue;
      w.hits++;
      w.delays.push(this.time - w.at);
      if (w.hits === 1) w.firstHit = this.time - w.at;
    }
  }
  // New wrecks: stopped on the racing surface or the apron.
  for (const c of this.cars) {
    if (!c.retired || c.cleared || c.speed > 1 || stoppedSeen.has(c)) continue;
    stoppedSeen.add(c);
    const i = c.trackIdx;
    if (c.d >= t.innerEdge(i) + t.apronWidth) continue;
    const others = this.cars.filter((o) => o.retired && !o.cleared && o.speed < 1 && Math.min(t.distanceFrom(o.s, c.s), t.length - t.distanceFrom(o.s, c.s)) <= 30);
    const ds = others.map((o) => o.d).sort((a, b) => a - b);
    const lo = t.outerEdge(i), hi = t.innerEdge(i) + t.apronWidth;
    let room = Math.max(ds[0] - P.CAR_RADIUS - lo, hi - ds[ds.length - 1] - P.CAR_RADIUS);
    for (let k = 1; k < ds.length; k++) room = Math.max(room, ds[k] - ds[k - 1] - 2 * P.CAR_RADIUS);
    const w: Wreck = {
      car: c, world: this, s: c.s, at: this.time, flag, track: name,
      fromOutside: c.d - t.outerEdge(i), fromInside: t.innerEdge(i) - c.d, room,
      corner: Math.abs(t.curvatureAt(c.s)) > CORNER, hits: 0, firstHit: NaN, delays: [],
    };
    wrecks.push(w);
  }
};

process.on('exit', () => {
  const row = (label: string, ws: Wreck[]) => {
    if (!ws.length) return;
    const hit = ws.filter((w) => w.hits > 0);
    const after = hit.map((w) => w.firstHit).sort((a, b) => a - b);
    console.log(`WRECKHIT ${label.padEnd(44)} ${String(ws.length).padStart(4)} wrecks, ${String(hit.length).padStart(3)} hit (${(100 * hit.length / ws.length).toFixed(0).padStart(3)}%), `
      + `${String(ws.reduce((a, w) => a + w.hits, 0)).padStart(3)} cars out into them (${ws.reduce((a, w) => a + w.delays.filter((d) => d >= LATE).length, 0)} ${LATE} s or more after it stopped)${after.length ? `, first hit after ${after[after.length >> 1].toFixed(0)} s (med), ${after[0].toFixed(0)} s (soonest)` : ''}`);
  };
  row('all', wrecks);
  for (const f of ['green', 'caution', 'restart', 'red']) row(`stopped under ${f}`, wrecks.filter((w) => w.flag === f));
  row('against the outside (within 3 m)', wrecks.filter((w) => w.fromOutside < 3));
  row('mid-track', wrecks.filter((w) => w.fromOutside >= 3 && w.fromInside >= 3));
  row('low (within 3 m of the inside edge, or on the apron)', wrecks.filter((w) => w.fromInside < 3));
  row('in a corner', wrecks.filter((w) => w.corner));
  row('on a straight', wrecks.filter((w) => !w.corner));
  for (const [lo, hi] of [[0, 3], [3, 6], [6, 10], [10, Infinity]]) row(`room to get by ${lo}-${hi === Infinity ? '' : hi} m`, wrecks.filter((w) => w.room >= lo && w.room < hi));
  for (const tr of [...new Set(wrecks.map((w) => w.track))]) row(`track ${tr}`, wrecks.filter((w) => w.track === tr));
  // Crossed: where across the track and corner or straight.
  for (const corner of [true, false]) {
    for (const [label, f] of [['outside', (w: Wreck) => w.fromOutside < 3], ['mid', (w: Wreck) => w.fromOutside >= 3 && w.fromInside >= 3], ['low', (w: Wreck) => w.fromInside < 3]] as const) {
      row(`${corner ? 'corner' : 'straight'}, ${label}`, wrecks.filter((w) => w.corner === corner && f(w)));
    }
  }
});

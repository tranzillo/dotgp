// Preload for incidents.ts / bench.ts: the red flag for a pile-up, not for every wreck. Besides race control's own
// rule (wrecks leaving less than a car's width and a metre to get by: raceControl.ts RED_FREE), a red when N stopped
// wrecks lie within R m of each other along the track (on the racing surface or an oval's apron), and with APART > 0
// only once one of them stopped APART s or more after another (a car coming into a wreck that was already there, not
// one tangle). The field stops short of the first of them until the trucks have every wreck within R m of the pile-up
// cleared (not just fewer than N: rolling again with one still there is the caution it started in); then it rolls
// again under caution. A single wreck stays a yellow, unless RED_MID=M: then a wreck stopped M m or more from both the
// outside wall's edge and the inside edge (mid-track, where the field runs into them: scripts/wreckHits.ts) is a red
// too, until it's towed or moved off the line. Set by RED_PILE=N:R[:APART] (default 2:150).
//   RED_PILE=2:150:5 DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx --import ./scripts/redForPileups.ts scripts/incidents.ts \
//     public/drivers/stable-candidate-v8sp-lines.json --tracks oval:774865359:superspeedway --seeds 4 --field 40 --rules 1
// Prints REDPILE lines at exit: reds a race (and how many race control's own rule would have thrown), minutes stopped,
// and every car out by the flag it went out under and how near the nearest wreck already there was.
import { RaceControl } from '../src/sim/raceControl';
import { World } from '../src/sim/world';
import { PHYSICS as P } from '../src/sim/constants';
import type { Car } from '../src/sim/car';

const MID = Number(process.env.RED_MID ?? NaN);
const [N, R, APART] = (process.env.RED_PILE ?? '2:150').split(':').map(Number).concat([0, 0, 0]).slice(0, 3) as [number, number, number];
/** When each car was first seen retired (s of world time). */
const retiredAt = new WeakMap<Car, number>();
let piles = 0, own = 0, redSeconds = 0, races = 0;
/** Cars out, by the flag and how near the nearest wreck already there was. */
const outs = new Map<string, number>();
const seenWorlds = new WeakSet<World>();
/** Each world's flag at the end of its last step (race control moves it between them). */
const flags = new WeakMap<World, string | undefined>();

const blocked = RaceControl.prototype.blockedPlaces;
/** Where a pile-up is (every wreck in it), N wrecks within R m of each other. */
function pileUps(rc: RaceControl): number[] {
  const t = rc.track;
  const wrecks = rc.world.cars.filter((c) => c.retired && !c.cleared && c.speed < 1 && c.d < t.innerEdge(c.trackIdx) + t.apronWidth);
  const near = (a: number, b: number) => { const ds = t.distanceFrom(a, b); return Math.min(ds, t.length - ds) <= R; };
  const places = new Set<number>();
  for (const w of wrecks) {
    const pile = wrecks.filter((o) => near(w.s, o.s));
    if (pile.length < N) continue;
    const times = pile.map((o) => retiredAt.get(o) ?? 0);
    if (APART > 0 && Math.max(...times) - Math.min(...times) < APART) continue;
    for (const o of pile) places.add(o.s);
  }
  return [...places];
}
/** Each race control's pile-ups (s), kept until no wreck is left within R of them. */
const kept = new WeakMap<RaceControl, number[]>();
let lastOwn = false, lastPile = false;
RaceControl.prototype.blockedPlaces = function (this: RaceControl): number[] {
  const t = this.track;
  const mine = blocked.call(this);
  const zones = [...(kept.get(this) ?? []), ...pileUps(this)];
  const wrecks = this.world.cars.filter((c) => c.retired && !c.cleared && c.speed < 1 && c.d < t.innerEdge(c.trackIdx) + t.apronWidth);
  const near = (a: number, b: number) => { const ds = t.distanceFrom(a, b); return Math.min(ds, t.length - ds) <= R; };
  const still = zones.filter((z) => wrecks.some((w) => near(z, w.s)));
  kept.set(this, still);
  const pile = wrecks.filter((w) => still.some((z) => near(z, w.s))
    || (w.d - t.outerEdge(w.trackIdx) >= MID && t.innerEdge(w.trackIdx) - w.d >= MID)).map((w) => w.s);
  lastOwn = mine.length > 0;
  lastPile = pile.length > 0;
  return [...mine, ...pile];
};

const step = World.prototype.step;
World.prototype.step = function (this: World) {
  if (!seenWorlds.has(this)) { seenWorlds.add(this); races++; }
  const was = flags.get(this);
  step.call(this);
  const flag = this.control?.flag;
  const t = this.track;
  for (const c of this.cars) {
    if (!c.retired || retiredAt.has(c)) continue;
    retiredAt.set(c, this.time);
    // The nearest wreck already there (stopped, not yet towed), along the track either way.
    let gap = Infinity;
    for (const o of this.cars) {
      if (o === c || !o.retired || o.cleared || !retiredAt.has(o) || retiredAt.get(o)! >= this.time) continue;
      const ds = t.distanceFrom(o.s, c.s);
      gap = Math.min(gap, Math.min(ds, t.length - ds));
    }
    const key = `${flag ?? 'none'}, ${gap <= 50 ? 'within 50 m of' : gap <= 150 ? '50-150 m from' : gap <= 400 ? '150-400 m from' : 'no'} a wreck already there`;
    outs.set(key, (outs.get(key) ?? 0) + 1);
  }
  if (flag === 'red') redSeconds += P.DT;
  if (flag === 'red' && was !== 'red') { if (lastOwn) own++; else if (lastPile) piles++; }
  flags.set(this, flag);
};

process.on('exit', () => {
  console.log(`REDPILE rule ${N} wrecks within ${R} m${APART ? `, one ${APART} s or more after another` : ''}${Number.isFinite(MID) ? `, or one ${MID} m or more from both edges` : ''}: ${races} races, `
    + `${((own + piles) / Math.max(1, races)).toFixed(2)} reds a race (${(own / Math.max(1, races)).toFixed(2)} race control's own rule, `
    + `${(piles / Math.max(1, races)).toFixed(2)} pile-ups), ${(redSeconds / 60 / Math.max(1, races)).toFixed(1)} min stopped a race`);
  for (const [k, n] of [...outs].sort((a, b) => b[1] - a[1])) console.log(`REDPILE out: ${k}: ${n}`);
});

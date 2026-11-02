// Preload for incidents.ts: how green passes happen. For every pair of sound cars racing under green (neither in a pit
// cycle), a pass is the one behind getting LEAD m ahead of the other after being LEAD m behind it within PASS_WINDOW.
// Each is sorted by what happened from the last moment the passer was in line behind (within FOLLOW m, under IN_LINE m
// across) to the moment it drew level: it pulled out (it moved across MOVED m or more, the other car less than STILL),
// a gap left (the other car moved off the line, the passer held), both moved, neither (through on the same line: the
// other car slowing, or a bump), or the two were never in line (already a lane apart: passing in the other groove).
// Also pull-outs (in line behind, closing, then a lane over while still behind) and how many became a pass, and passes
// where the passer blended back in front of the other car (in its lane within BLEND_TIME). And each pull-out followed
// to its end (passed; back in line behind; dropped back out of reach; still trying at PASS_WINDOW): the closing along
// at the pull-out and 1, 2 and 3 s on, how near level it got, whether a car was ahead in the lane it pulled into, and
// whether the car it went for moved across after it (a block). Prints PASS lines at exit.
//   DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx --import ./scripts/passKinds.ts scripts/incidents.ts \
//     public/drivers/stable-candidate-v8sp-lines.json --tracks speedway --seeds 2 --field 40 --rules 1
import { compromise } from '../src/sim/damage';
import { World } from '../src/sim/world';
import type { Car } from '../src/sim/car';

const LEAD = 5; // m ahead or behind (centres) that counts as past or behind
const PASS_WINDOW = 10; // s from behind to past
const FOLLOW = 30; // m behind, in line
const IN_LINE = 2.5; // m across, in line
const OUT = 3.5; // m across, a lane over
const MOVED = 2, STILL = 1.5; // m moved across
const BLEND_TIME = 5; // s after a pass
const EVERY = 4; // steps between looks

type PullOut = { t: number; dB: number; closing: number[]; nearest: number; blocked: boolean; end: string | null };
type Pair = {
  behindAt: number;
  inLine: { t: number; dA: number; dB: number } | null;
  level: { dA: number; dB: number } | null;
  pullOut: PullOut | null;
};
const outs: PullOut[] = [];
const alongOf = (world: World, c: Car) => c.vx * world.track.tx[c.trackIdx] + c.vy * world.track.ty[c.trackIdx];
/** End a pull-out (once). */
const endOut = (o: PullOut | null, why: string) => { if (o && !o.end) o.end = why; };
const pairs = new Map<string, Pair>();
const blends: Array<{ a: Car; b: Car; until: number; done: boolean }> = [];
const kinds = new Map<string, number>();
let passes = 0, blended = 0, pullOuts = 0, pullOutPasses = 0, steps = 0;

const eligible = (c: Car) => !c.retired && !c.cleared && c.pit.phase === 'none' && compromise(c) === 0;

const step = World.prototype.step;
World.prototype.step = function (this: World) {
  step.call(this);
  if ((this.control?.flag ?? 'green') !== 'green') { pairs.clear(); blends.length = 0; return; }
  if (++steps % EVERY) return;
  const L = this.track.length, t = this.time;
  const cars = this.cars.filter(eligible);
  for (const a of cars) for (const b of cars) {
    if (a === b) continue;
    let ds = b.s - a.s; // + : b ahead of a
    if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L;
    const key = `${a.id}-${b.id}`;
    let p = pairs.get(key);
    const po = p?.pullOut ?? null;
    if (po && !po.end) {
      const k = Math.floor((t - po.t) + 1e-6);
      if (k >= 1 && k <= 3 && po.closing.length === k) po.closing.push(alongOf(this, a) - alongOf(this, b));
      po.nearest = Math.min(po.nearest, ds);
    }
    if (ds >= LEAD && ds <= FOLLOW + 10) {
      if (!p) { p = { behindAt: t, inLine: null, level: null, pullOut: null }; pairs.set(key, p); }
      p.behindAt = t;
      p.level = null;
      const dd = Math.abs(a.d - b.d);
      if (dd < IN_LINE && ds <= FOLLOW) {
        // Back in line behind after pulling out: given up (or blocked, if the car it went for moved across into it).
        if (p.pullOut && !p.pullOut.end) endOut(p.pullOut, Math.abs(b.d - p.pullOut.dB) >= MOVED ? 'blocked' : 'back in line');
        p.inLine = { t, dA: a.d, dB: b.d };
        p.pullOut = null;
      }
      if (p.inLine && !p.pullOut && dd > OUT && t - p.inLine.t < 2 && Math.abs(a.d - p.inLine.dA) >= MOVED) {
        // A car ahead in the lane it pulled into (within FOLLOW ahead of it, under IN_LINE across).
        const blocked = cars.some((x) => {
          if (x === a || x === b) return false;
          let dx = x.s - a.s;
          if (dx > L / 2) dx -= L; else if (dx < -L / 2) dx += L;
          return dx > 0 && dx < FOLLOW && Math.abs(x.d - a.d) < IN_LINE;
        });
        p.pullOut = { t, dB: b.d, closing: [alongOf(this, a) - alongOf(this, b)], nearest: ds, blocked, end: null };
        outs.push(p.pullOut);
        pullOuts++;
      }
      if (p.pullOut && t - p.pullOut.t > PASS_WINDOW) endOut(p.pullOut, 'still trying');
      continue;
    }
    if (!p) continue;
    if (Math.abs(ds) > FOLLOW + 10 || t - p.behindAt > PASS_WINDOW) { endOut(p.pullOut, ds > 0 ? 'dropped back' : 'still trying'); pairs.delete(key); continue; }
    if (!p.level && ds < LEAD && ds > -LEAD && ds <= 0) p.level = { dA: a.d, dB: b.d };
    if (ds <= -LEAD) {
      passes++;
      const lv = p.level ?? { dA: a.d, dB: b.d };
      let kind = 'other lane';
      if (p.inLine && t - p.inLine.t <= PASS_WINDOW) {
        const ma = Math.abs(lv.dA - p.inLine.dA), mb = Math.abs(lv.dB - p.inLine.dB);
        kind = ma >= MOVED && mb < STILL ? 'pulled out' : mb >= MOVED && ma < STILL ? 'gap left' : ma >= MOVED && mb >= MOVED ? 'both moved' : 'neither';
      }
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      if (p.pullOut && t - p.pullOut.t <= PASS_WINDOW) pullOutPasses++;
      endOut(p.pullOut, 'passed');
      blends.push({ a, b, until: t + BLEND_TIME, done: false });
      pairs.delete(key);
    }
  }
  for (let i = blends.length - 1; i >= 0; i--) {
    const w = blends[i];
    if (!w.done && eligible(w.a) && eligible(w.b) && Math.abs(w.a.d - w.b.d) < IN_LINE) { w.done = true; blended++; }
    if (w.done || t > w.until) blends.splice(i, 1);
  }
};

process.on('exit', () => {
  const pct = (x: number, n: number) => `${(100 * x / Math.max(1, n)).toFixed(0)}%`;
  console.log(`PASS green passes ${passes}: ${['pulled out', 'gap left', 'both moved', 'neither', 'other lane'].map((k) => `${k} ${kinds.get(k) ?? 0} (${pct(kinds.get(k) ?? 0, passes)})`).join(', ')}`);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  for (const end of ['passed', 'back in line', 'blocked', 'dropped back', 'still trying']) {
    const os = outs.filter((o) => (o.end ?? 'still trying') === end);
    if (!os.length) continue;
    console.log(`PASS   pull-outs ending ${end.padEnd(12)} ${String(os.length).padStart(5)} (${pct(os.length, outs.length)}): closing along at the pull-out / 1 / 2 / 3 s on `
      + [0, 1, 2, 3].map((k) => mean(os.filter((o) => o.closing.length > k).map((o) => o.closing[k])).toFixed(2)).join(' / ')
      + ` m/s; nearest ${mean(os.map((o) => o.nearest)).toFixed(1)} m behind; a car ahead in the lane it pulled into ${pct(os.filter((o) => o.blocked).length, os.length)}`);
  }
  console.log(`PASS pull-outs (in line behind, then a lane over still behind) ${pullOuts}, of them a pass within ${PASS_WINDOW} s ${pullOutPasses} (${pct(pullOutPasses, pullOuts)}); passers in the other car's lane in front of it within ${BLEND_TIME} s ${blended} (${pct(blended, passes)})`);
});

// Preload for incidents.ts: every car on its way out of pit road that goes onto the racing surface before the blend
// line ends (rules/detect.ts: more than 0.5 m inside the inside edge, short of blendEnd - MERGE_ZONE), where it did
// (m early, m past pit road's exit), how fast, at what angle to the track, whether the stop was a penalty's, and who
// drove (the pit skill or the maneuver). Prints BLEND lines at exit: a histogram of how early, then the first crossings.
//   DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx --import ./scripts/blendCrossings.ts scripts/incidents.ts \
//     public/drivers/stable-candidate-v8s-lines.json --tracks oval:3850048323:intermediate --seeds 2 --field 40 --rules 1
import { World } from '../src/sim/world';
import { PIT_SERVICE } from '../src/sim/constants';
import type { Car } from '../src/sim/car';

interface Crossing { early: number; pastExit: number; speed: number; angle: number; penalty: boolean; by: string; stop: number }
const crossings: Crossing[] = [];
const seen = new WeakSet<Car>();
/** Stops each car has made, and those that crossed. */
let outs = 0;
const wasOut = new WeakMap<Car, boolean>();

const step = World.prototype.step;
World.prototype.step = function (this: World) {
  step.call(this);
  const t = this.track;
  const line = t.wrapS(t.pit.blendEnd - PIT_SERVICE.MERGE_ZONE);
  this.cars.forEach((c, k) => {
    const out = c.pit.phase === 'out';
    if (out && !wasOut.get(c)) outs++;
    wasOut.set(c, out);
    if (!out) { seen.delete(c); return; }
    if (seen.has(c) || c.retired || c.d >= t.innerEdge(c.trackIdx) - 0.5) return;
    const early = t.distanceFrom(t.wrapS(c.s), line);
    if (!(early > 0 && early < t.length / 2)) return;
    seen.add(c);
    const i = c.trackIdx;
    const angle = (Math.atan2(c.vx * -t.ty[i] + c.vy * t.tx[i], c.vx * t.tx[i] + c.vy * t.ty[i]) * 180) / Math.PI;
    const mode = (this.controllers[k] as any)?.mode as string | undefined;
    crossings.push({
      early, pastExit: t.distanceFrom(t.wrapS(t.pit.exitEnd), t.wrapS(c.s)), speed: c.speed, angle,
      penalty: !!c.pit.call?.penalty, by: mode === 'pit' ? 'pit script' : 'pit skill', stop: outs,
    });
  });
};

process.on('exit', () => {
  const t = (n: number) => n.toFixed(0);
  console.log(`BLEND ${crossings.length} crossings of ${outs} ways out (${crossings.filter((c) => c.penalty).length} on a penalty's stop, ${crossings.filter((c) => c.by === 'pit script').length} with the maneuver driving)`);
  for (const [lo, hi] of [[0, 30], [30, 60], [60, 100], [100, 200], [200, Infinity]]) {
    const b = crossings.filter((c) => c.early >= lo && c.early < hi);
    if (b.length) console.log(`BLEND ${lo}-${hi === Infinity ? '' : hi} m early: ${b.length}, speed med ${t(b.map((c) => c.speed).sort((x, y) => x - y)[b.length >> 1])} m/s, angle med ${t(b.map((c) => c.angle).sort((x, y) => x - y)[b.length >> 1])} deg`);
  }
  for (const c of crossings.slice(0, 12)) {
    console.log(`BLEND ${t(c.early)} m early, ${t(c.pastExit)} m past pit road's exit, ${c.speed.toFixed(1)} m/s at ${t(c.angle)} deg, ${c.by}${c.penalty ? ', a penalty stop' : ''}`);
  }
});

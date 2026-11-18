// Preload for incidents.ts (with a red rule: scripts/redForPileups.ts): what goes wrong while the field stops for a red.
// At each red: every car's speed, how far it is from the wreck it must stop short of, and the braking that takes
// (raceControl.ts stops the field RED_SHORT short at RED_DECEL). Under red: every hit that costs health, by who drove,
// what was hit (a car: moving or stopped, wrecked or in the line; a wall), how fast, how long after the red, and how
// far from the wreck. Prints REDSTOP lines at exit.
//   RED_PILE=2:150 RED_MID=3 DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx --import ./scripts/redForPileups.ts \
//     --import ./scripts/redStopHits.ts scripts/incidents.ts public/drivers/stable-candidate-v8s-lines.json \
//     --tracks oval:3148308672:speedway --seeds 4 --field 40 --rules 1
import { World } from '../src/sim/world';

/** raceControl.ts RED_SHORT, RED_DECEL. */
const RED_SHORT = 40, RED_DECEL = 2.5;

interface Hit { by: string; what: string; speed: number; impact: number; otherSpeed: number; after: number; toWreck: number; health: number; out: boolean; overCap: boolean }
const hits: Hit[] = [];
/** At each red, each car's braking needed to stop short of the wreck ahead (m/s^2). */
const needs: number[] = [];
let reds = 0;
const redFrom = new WeakMap<World, number>();
const flags = new WeakMap<World, string | undefined>();

/** The nearest stopped wreck ahead of s, along the track (m). */
function toWreck(world: World, s: number): number {
  const t = world.track;
  let best = Infinity;
  for (const w of world.cars) {
    if (!w.retired || w.cleared || w.speed > 1 || w.d >= t.innerEdge(w.trackIdx) + t.apronWidth) continue;
    const ds = t.distanceFrom(s, w.s);
    if (ds > 0) best = Math.min(best, ds);
  }
  return best;
}

const step = World.prototype.step;
World.prototype.step = function (this: World) {
  const before = this.cars.map((c, k) => ({ health: c.health, speed: c.speed, retired: c.retired, mode: (this.controllers[k] as any)?.mode as string | undefined, phase: c.pit.phase }));
  const capOver = this.cars.map((c) => this.control?.flag === 'red' && c.speed > (this.control.redSpeedAt(c.s) + 2));
  step.call(this);
  const flag = this.control?.flag;
  const was = flags.get(this);
  flags.set(this, flag);
  if (flag === 'red' && was !== 'red') {
    reds++;
    redFrom.set(this, this.time);
    for (const c of this.cars) {
      if (c.retired || c.finished || c.pit.phase !== 'none') continue;
      const room = toWreck(this, c.s) - RED_SHORT;
      if (room < 1000) needs.push(room > 0 ? (c.speed * c.speed) / (2 * room) : Infinity);
    }
  }
  if (flag !== 'red') return;
  this.cars.forEach((c, k) => {
    const lost = before[k].health - c.health;
    if (lost <= 1e-4 || before[k].retired || !c.lastImpact) return;
    const imp = c.lastImpact;
    const o = imp.kind === 'car' && imp.other !== null ? this.cars.find((x) => x.id === imp.other) : undefined;
    const pace = this.control && imp.other === this.control.paceCar.id;
    const what = imp.kind === 'wall' ? 'a wall' : pace ? 'the pace car' : !o ? 'an official' : o.retired ? (o.speed < 1 ? 'a stopped wreck' : 'a car wrecking')
      : o.speed < 1 ? 'a stopped car in the line' : `a ${o.speed < before[k].speed ? 'slower' : 'faster'} moving car`;
    const mode = before[k].mode;
    hits.push({
      by: mode === 'formation' ? 'formation script' : mode === 'pit' ? 'pit maneuver' : before[k].phase !== 'none' ? `pit skill (${before[k].phase})` : 'its own skill', what,
      speed: before[k].speed, impact: imp.speed, otherSpeed: o?.speed ?? 0, after: this.time - (redFrom.get(this) ?? this.time),
      toWreck: toWreck(this, c.s), health: lost, out: c.retired, overCap: capOver[k],
    });
  });
};

process.on('exit', () => {
  const pct = (a: number[], q: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN; };
  console.log(`REDSTOP ${reds} reds; braking needed at the red to stop ${RED_SHORT} m short (m/s^2): median ${pct(needs, 0.5).toFixed(1)}, 90th ${pct(needs, 0.9).toFixed(1)}, `
    + `${needs.filter((n) => n > RED_DECEL * 2).length} of ${needs.length} cars over ${RED_DECEL * 2}, ${needs.filter((n) => n > 8).length} over 8`);
  const groups = new Map<string, Hit[]>();
  for (const h of hits) { const k = `${h.by}, into ${h.what}`; groups.set(k, [...(groups.get(k) ?? []), h]); }
  for (const [k, g] of [...groups].sort((a, b) => b[1].reduce((x, h) => x + h.health, 0) - a[1].reduce((x, h) => x + h.health, 0))) {
    console.log(`REDSTOP ${k.padEnd(52)} hits ${String(g.length).padStart(4)}, health ${g.reduce((x, h) => x + h.health, 0).toFixed(2).padStart(6)}, out ${g.filter((h) => h.out).length}, `
      + `speed med ${pct(g.map((h) => h.speed), 0.5).toFixed(1)}, impact med ${pct(g.map((h) => h.impact), 0.5).toFixed(1)}, ${pct(g.map((h) => h.after), 0.5).toFixed(0)} s after the red (med), ${pct(g.map((h) => h.toWreck), 0.5).toFixed(0)} m to the wreck (med), over the red's cap ${g.filter((h) => h.overCap).length}`);
  }
  for (const h of [...hits].sort((a, b) => b.health - a.health).slice(0, 12)) {
    console.log(`REDSTOP hit ${h.by} into ${h.what} at ${h.speed.toFixed(1)} m/s (it ${h.otherSpeed.toFixed(1)}, impact ${h.impact.toFixed(1)}), ${h.after.toFixed(1)} s after the red, ${h.toWreck.toFixed(0)} m short of the wreck, health ${h.health.toFixed(2)}${h.out ? ', out' : ''}${h.overCap ? ', over the cap' : ''}`);
  }
});

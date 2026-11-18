// Preload: under caution (flag not green), damaging contacts by what was hit: a wreck (retired, or stopped on the racing
// surface), a slower moving car, or anything else; who was driving the car that hit; how long wrecks were on the racing
// surface, how long it was down to under 3 car widths, and red flags. Prints WRECK lines at exit.
//   npx tsx --import ./scripts/cautionWrecks.ts scripts/incidents.ts public/drivers/stable-candidate-v5p.json \
//     --tracks speedway --seeds 2 --field 40 --rules 1
import { PHYSICS as P } from '../src/sim/constants';
import { World } from '../src/sim/world';
const rows: Array<{ kind: string; mode: string; speed: number; health: number; lane: number; out: number }> = [];
let cautionSec = 0, wreckSec = 0, blockedSec = 0, redSec = 0, reds = 0;
const lastFlag = new WeakMap<World, string>();
const step = World.prototype.step;
World.prototype.step = function (this: World) {
  const ctl = this.control;
  // (Any time the field is pacing: the start's pace laps and grid too, as the numbers in RESULTS were taken.)
  const caution = !!ctl && ctl.pacing;
  const before = this.cars.map((c) => ({ health: c.health, retired: c.retired, speed: c.speed, impact: c.lastImpact }));
  step.call(this);
  if (ctl && ctl.flag === 'red') { redSec += P.DT; if (lastFlag.get(this) !== 'red') reds++; }
  if (ctl) lastFlag.set(this, ctl.flag);
  if (!caution) return;
  cautionSec += P.DT;
  const t = this.track;
  const onTrack = this.cars.filter((c) => !c.cleared && (c.retired || (c.speed < 1 && c.pit.phase === 'none')) && c.d <= t.innerEdge(c.trackIdx) + 1);
  if (onTrack.length) wreckSec += P.DT;
  // Blocked: some 10 m stretch with wrecks leaving no gap of 3 car widths across the racing surface.
  for (const w of onTrack) {
    const near = onTrack.filter((o) => Math.abs(t.wrapS(o.s - w.s + t.length / 2) - t.length / 2) < 10).map((o) => o.d).sort((a, b) => a - b);
    const lo = t.outerEdge(w.trackIdx), hi = t.innerEdge(w.trackIdx);
    let gap = near[0] - P.CAR_RADIUS - lo;
    for (let i = 1; i < near.length; i++) gap = Math.max(gap, near[i] - near[i - 1] - 2 * P.CAR_RADIUS);
    gap = Math.max(gap, hi - near[near.length - 1] - P.CAR_RADIUS);
    if (gap < 6 * P.CAR_RADIUS) { blockedSec += P.DT; break; }
  }
  this.cars.forEach((c, k) => {
    const imp = c.lastImpact;
    if (before[k].retired || !imp || imp === before[k].impact || c.health >= before[k].health - 1e-6) return;
    const j = imp.kind === 'car' && imp.other !== null ? this.cars.findIndex((o) => o.id === imp.other) : -1;
    const o = j >= 0 ? this.cars[j] : null;
    const kind = imp.kind !== 'car' ? `wall/${imp.kind}` : !o ? 'official/truck'
      : before[j].retired ? 'wreck (retired)' : before[j].speed < 1 && o.pit.phase === 'none' ? 'wreck (stopped)'
      : before[j].speed < before[k].speed - 5 ? 'slower car (5+ m/s)' : 'other car';
    const ctrl = this.controllers[k] as any;
    const mode = c.pit.phase !== 'none' ? `pit` : ctrl?.mode === 'driver' ? (ctrl.driverCautions ? 'cautionNet' : 'driverNet') : ctrl?.mode ?? '?';
    rows.push({ kind, mode, speed: before[k].speed, health: before[k].health - c.health, lane: o ? Math.abs(o.d - c.d) : 0, out: +(c.retired && !before[k].retired) });
  });
};
process.on('exit', () => {
  const by = new Map<string, { n: number; h: number; out: number; v: number[] }>();
  for (const r of rows) {
    const key = `${r.kind.padEnd(20)} ${r.mode}`;
    const e = by.get(key) ?? { n: 0, h: 0, out: 0, v: [] };
    e.n++; e.h += r.health; e.out += r.out; e.v.push(r.speed);
    by.set(key, e);
  }
  console.error(`WRECK caution ${cautionSec.toFixed(0)} s, a wreck on the racing surface ${wreckSec.toFixed(0)} s, blocked (<3 car widths) ${blockedSec.toFixed(0)} s, red flags ${reds} (${redSec.toFixed(0)} s)`);
  for (const [k, e] of [...by].sort((a, b) => b[1].h - a[1].h)) {
    e.v.sort((a, b) => a - b);
    console.error(`WRECK ${k.padEnd(34)} hits ${String(e.n).padStart(4)}  health ${e.h.toFixed(2).padStart(6)}  out ${e.out}  speed med ${e.v[e.v.length >> 1].toFixed(1)}`);
  }
});

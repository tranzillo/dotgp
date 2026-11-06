// Preload: car-to-car contact under caution (flag not green, the field pacing or about to), who hit whom and how. Each
// contact that cost health: the car behind and the car ahead, their speeds, whether each was smoking (compromised) or on
// its way in, what was driving each (the formation script, the pit maneuver, the driver's networks), and where across
// the track each was. And every retirement under caution, whether it was smoking before. By phase: the caution forming
// (before the pace car has picked up the leader), pacing in line, one to go, the restart, and the first 30 s of green
// after the start and after a restart (when the field races out of the pacing formation). Prints CAUTION lines at exit.
//   DOTGP_EXPERIMENT='?spec=cup' npx tsx --import ./scripts/cautionHits.ts scripts/incidents.ts \
//     public/drivers/stable-candidate-v5.json --tracks oval:894715320:short --seeds 2 --field 40 --rules 1
import { PHYSICS as P } from '../src/sim/constants';
import { compromise } from '../src/sim/damage';
import { World } from '../src/sim/world';
import type { Car } from '../src/sim/car';

const hits: Array<Record<string, string | number>> = [];
const outs: string[] = [];
/** Car-seconds in each phase, and hits and health lost there. */
const phaseTime = new Map<string, number>(), phaseHarm = new Map<string, number>();
/** When the green last flew, and whether it was the start (from the pace laps) or a restart. */
const greenFrom = new WeakMap<World, { at: number; start: boolean; last: string }>();
const START_WINDOW = 30;
function phaseOf(w: World): string | null {
  const ctl = w.control;
  if (!ctl) return null;
  const g = greenFrom.get(w) ?? { at: -Infinity, start: false, last: ctl.flag };
  if (ctl.flag === 'green' && g.last !== 'green') { g.at = w.time; g.start = ctl.cautions === 0; } // (a rolling start's green comes from the restart flag too)
  g.last = ctl.flag;
  greenFrom.set(w, g);
  if (ctl.flag === 'caution') return !ctl.pickedUp ? 'caution forming' : ctl.oneToGo ? 'caution one to go' : 'caution pacing';
  if (ctl.flag === 'restart') return 'restart';
  if (ctl.flag !== 'green') return 'before the start';
  const since = w.time - g.at;
  if (since > START_WINDOW) return null;
  return `${g.start ? 'start' : 'restart'} green ${since < 10 ? '0-10' : '10-30'} s`;
}
const step = World.prototype.step;
World.prototype.step = function (this: World) {
  const phase = phaseOf(this);
  const flag = phase ?? 'green';
  const before = this.cars.map((c) => ({ health: c.health, smoking: !c.retired && compromise(c) > 0, retired: c.retired, speed: c.speed, impact: c.lastImpact }));
  step.call(this);
  if (!phase) return;
  phaseTime.set(phase, (phaseTime.get(phase) ?? 0) + this.cars.filter((c) => !c.retired && c.pit.phase === 'none').length * P.DT);
  const L = this.track.length, seen = new Set<string>();
  const who = (k: number) => {
    const c = this.cars[k], t = this.controllers[k] as any;
    const mode = c.pit.phase !== 'none' ? `pit-${c.pit.phase}` : t?.mode === 'driver' ? (t.driverCautions ? 'cautionNet' : 'driver') : t?.mode ?? '?';
    const lane = c.d > this.track.innerEdgeAt(c.s) ? 'apron' : 'track';
    return { mode, lane, smoking: before[k].smoking, speed: before[k].speed };
  };
  this.cars.forEach((c, k) => {
    if (!before[k].retired && c.retired) outs.push(`${phase}: ${before[k].smoking ? 'smoking' : 'sound'}${c.lastImpact?.kind === 'car' ? ' (car)' : ''}`);
    const imp = c.lastImpact;
    if (!imp || imp === before[k].impact || imp.kind !== 'car' || c.health >= before[k].health - 1e-6 || imp.other === null) return;
    phaseHarm.set(phase, (phaseHarm.get(phase) ?? 0) + before[k].health - c.health);
    const j = this.cars.findIndex((o: Car) => o.id === imp.other);
    if (j < 0) return;
    const key = k < j ? `${k}-${j}` : `${j}-${k}`;
    if (seen.has(key)) return;
    seen.add(key);
    let ds = this.cars[j].s - c.s;
    if (ds > L / 2) ds -= L;
    else if (ds < -L / 2) ds += L;
    const [behind, ahead] = ds > 0 ? [k, j] : [j, k];
    const b = who(behind), a = who(ahead);
    hits.push({ flag, impact: imp.speed, bMode: b.mode, bSmoke: +b.smoking, bSpeed: b.speed, bLane: b.lane, aMode: a.mode, aSmoke: +a.smoking, aSpeed: a.speed, aLane: a.lane,
      lateral: Math.abs(this.cars[j].d - c.d) > 1.5 ? 1 : 0 });
  });
};
process.on('exit', () => {
  const count = (f: (h: Record<string, string | number>) => string) => {
    const m = new Map<string, number>();
    for (const h of hits) m.set(f(h), (m.get(f(h)) ?? 0) + 1);
    return [...m].sort((x, y) => y[1] - x[1]).map(([w, n]) => `${w} ${n}`).join(', ');
  };
  console.error(`CAUTION hits ${hits.length}; ahead under 15 m/s ${hits.filter((h) => +h.aSpeed < 15).length}; ahead smoking ${hits.filter((h) => h.aSmoke).length}, behind smoking ${hits.filter((h) => h.bSmoke).length}; side by side ${hits.filter((h) => h.lateral).length}`);
  console.error(`CAUTION by phase (hits; per car-minute; health lost):`);
  for (const [ph, t] of [...phaseTime].sort()) {
    const n = hits.filter((h) => h.flag === ph).length;
    const these = hits.filter((h) => h.flag === ph), med = (k: string) => { const r = these.map((h) => +h[k]).sort((x, y) => x - y); return (r[Math.floor((r.length - 1) / 2)] ?? 0).toFixed(1); };
    console.error(`CAUTION   ${ph.padEnd(22)} ${String(n).padStart(4)}  ${(n / (t / 60)).toFixed(2).padStart(6)}  ${(phaseHarm.get(ph) ?? 0).toFixed(2).padStart(6)}`
      + `  impact ${med('impact')}, behind ${med('bSpeed')} -> ahead ${med('aSpeed')} m/s, side by side ${these.filter((h) => h.lateral).length}`);
  }
  console.error(`CAUTION behind -> ahead (driving): ${count((h) => `${h.bMode}${h.bSmoke ? '*' : ''} -> ${h.aMode}${h.aSmoke ? '*' : ''}`)}`);
  console.error(`CAUTION lanes behind/ahead: ${count((h) => `${h.bLane}/${h.aLane}`)}`);
  const sp = (k: string) => hits.map((h) => +h[k]).sort((a, b) => a - b), q = (r: number[], p: number) => (r[Math.floor(p * (r.length - 1))] ?? 0).toFixed(1);
  for (const k of ['impact', 'bSpeed', 'aSpeed']) console.error(`CAUTION ${k} median ${q(sp(k), 0.5)} p90 ${q(sp(k), 0.9)} m/s`);
  const o = new Map<string, number>();
  for (const w of outs) o.set(w, (o.get(w) ?? 0) + 1);
  console.error(`CAUTION retirements ${outs.length}: ${[...o].map(([w, n]) => `${w} ${n}`).join(', ')}`);
});

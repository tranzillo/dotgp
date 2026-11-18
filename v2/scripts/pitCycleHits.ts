// Preload for incidents.ts: damage to cars in a pit cycle (what incidents.ts counts as pit-cycle damage: in a stop, or
// just out of one), by where on pit road (the section), the flag, what it hit and who was driving the other car.
// Prints PITHITS lines at exit, most damage first.
//   DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx --import ./scripts/pitCycleHits.ts scripts/incidents.ts \
//     public/drivers/stable-candidate-v8-lines.json --tracks oval:3148308672:speedway --seeds 2 --field 40 --rules 1
import { World } from '../src/sim/world';
import type { Car } from '../src/sim/car';
import type { Track } from '../src/sim/track';

function section(car: Car, track: Track, wasOut: boolean): string {
  if (car.pit.phase === 'none') return wasOut ? 'out, rejoined' : 'none';
  const p = track.pit;
  const r = track.signedS(car.s);
  const where = r < p.entryStart ? 'before entry' : r < p.wallStart ? 'entry' : r < p.wallEnd ? 'along the wall'
    : r < p.exitEnd ? 'exit' : r < p.blendEnd ? 'blend' : 'past the blend';
  return `${car.pit.phase} ${where}`;
}

const rows = new Map<string, { n: number; health: number }>();
const prevPhase = new WeakMap<Car, string>();
const step = World.prototype.step;
World.prototype.step = function (this: World) {
  const before = this.cars.map((c) => ({ health: c.health, phase: c.pit.phase, impact: c.lastImpact }));
  step.call(this);
  const flag = this.control?.flag ?? 'none';
  this.cars.forEach((c, k) => {
    const wasOut = prevPhase.get(c) === 'out';
    prevPhase.set(c, c.pit.phase);
    if (c.pit.phase === 'none' && !wasOut) return;
    const lost = before[k].health - c.health;
    if (lost <= 1e-4) return;
    const imp = c.lastImpact;
    const j = imp?.kind === 'car' && imp.other !== null ? this.cars.findIndex((o) => o.id === imp.other) : -1;
    const o = j >= 0 ? this.cars[j] : null;
    const ctrl = j >= 0 ? (this.controllers[j] as any) : null;
    const by = !imp ? '?' : imp.kind !== 'car' ? `wall/${imp.kind}` : !o ? 'official/truck'
      : o.retired ? 'wreck' : o.pit.phase !== 'none' ? 'a car in its pit cycle'
      : ctrl?.mode === 'driver' ? (this.control?.pacing && ctrl.driverCautions ? 'a car its caution skill drove' : 'a car its racing skill drove') : `a car (${ctrl?.mode ?? '?'})`;
    const key = `${(flag === 'green' ? 'green' : 'under caution').padEnd(13)} ${section(c, this.track, wasOut).padEnd(22)} ${by}`;
    const e = rows.get(key) ?? { n: 0, health: 0 };
    e.n++; e.health += lost;
    rows.set(key, e);
  });
};
process.on('exit', () => {
  const all = [...rows].sort((a, b) => b[1].health - a[1].health);
  const total = all.reduce((a, [, e]) => a + e.health, 0);
  console.log(`PITHITS pit-cycle damage ${total.toFixed(2)} in all`);
  for (const [k, e] of all.slice(0, 14)) console.log(`PITHITS ${k.padEnd(72)} ${String(e.n).padStart(5)} steps  health ${e.health.toFixed(2)}`);
});

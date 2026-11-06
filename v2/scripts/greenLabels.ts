// Preload for incidents.ts: what each car's own teacher (as in training: its personality's traffic racer, reacting at
// once) would have done in the seconds before a damaging car-to-car contact under green, beside what the racing
// network did. Each step, for every sound car its racing network drives, the teacher decides from where the car really
// is (as DAgger labels it) and is put back. Commands are compared as the car's push across the track (+ toward the
// other car at the contact) and along it (+ throttle). Prints GLABELS lines at exit: over all green racing, and per
// window before a contact (beside / nose to tail): mean push toward the other car student / teacher, the share of
// moments the student pushed toward it (> 0.15) while the teacher didn't (< 0.05), pedal, and the teacher braking
// while the student not; and each car's own speed toward the other.
//   DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx --import ./scripts/greenLabels.ts scripts/incidents.ts \
//     public/drivers/stable-candidate-v8ra-lines.json --tracks short --seeds 2 --field 40 --rules 1
import { readFileSync } from 'node:fs';
import { adaptWeights } from '../src/ai/drivers';
import { TrafficRacer } from '../src/ai/trafficRacer';
import { teacherOf } from '../src/school/ovalApprentice';
import { compromise } from '../src/sim/damage';
import { World } from '../src/sim/world';
import type { Car } from '../src/sim/car';

/** A moment: time, the push across (+d) and along for student and teacher, the car's own speed across (+d). */
type Moment = { t: number; sLat: number; tLat: number; sLon: number; tLon: number; vLat: number };
const KEEP = 3; // s of moments kept per car
const bundle = process.argv.find((a) => a.endsWith('.json') && !a.startsWith('teacher:'));
const roster: Array<{ lineage: number; nerve: number; talent: number; weights: number[] }> =
  bundle ? JSON.parse(readFileSync(bundle, 'utf8')).drivers : [];
const keys = roster.map((d) => Array.from(adaptWeights(Float32Array.from(d.weights)).subarray(0, 8)).join());
const teachers = new WeakMap<Car, TrafficRacer | null>();
const history = new WeakMap<Car, Moment[]>();
const hits: Array<{ side: boolean; sgn: number; moments: Moment[]; at: number }> = [];
let all = 0, latGap = 0, lonGap = 0, missBrake = 0;

function teacherFor(car: Car, ctrl: any): TrafficRacer | null {
  if (teachers.has(car)) return teachers.get(car)!;
  const w = ctrl?.driver?.net?.weights as Float32Array | undefined;
  const i = w ? keys.indexOf(Array.from(w.subarray(0, 8)).join()) : -1;
  let teacher: TrafficRacer | null = null;
  if (i >= 0) {
    const { style, traits } = teacherOf(roster[i] as any);
    teacher = new TrafficRacer(style, undefined, { ...traits, reaction: 0 });
  }
  teachers.set(car, teacher);
  return teacher;
}

/** A command (car frame) as a push along and across the track (+d). */
function push(world: World, car: Car, x: number, y: number): [number, number] {
  const i = car.trackIdx, tx = world.track.tx[i], ty = world.track.ty[i];
  const fx = car.frameX, fy = car.frameY;
  const wx = x * fx - y * fy, wy = x * fy + y * fx;
  return [wx * tx + wy * ty, wx * -ty + wy * tx];
}

const step = World.prototype.step;
World.prototype.step = function (this: World) {
  const green = (this.control?.flag ?? 'green') === 'green';
  const labels = new Map<Car, [number, number]>();
  if (green) {
    this.cars.forEach((c, k) => {
      const ctrl = this.controllers[k] as any;
      if (c.retired || c.cleared || c.pit.phase !== 'none' || ctrl?.mode !== 'driver' || compromise(c) > 0) return;
      const teacher = teacherFor(c, ctrl);
      if (!teacher) return;
      const px = c.inputX, py = c.inputY;
      teacher.takeOver(c, this);
      teacher.decide(c, this);
      labels.set(c, [c.inputX, c.inputY]);
      c.inputX = px; c.inputY = py;
    });
  }
  const before = this.cars.map((c) => ({ health: c.health, retired: c.retired, impact: c.lastImpact }));
  step.call(this);
  for (const [c, [x, y]] of labels) {
    const [sLon, sLat] = push(this, c, c.inputX, c.inputY), [tLon, tLat] = push(this, c, x, y);
    const i = c.trackIdx, vLat = c.vx * -this.track.ty[i] + c.vy * this.track.tx[i];
    const h = history.get(c) ?? [];
    h.push({ t: this.time, sLat, tLat, sLon, tLon, vLat });
    while (h.length && h[0].t < this.time - KEEP) h.shift();
    history.set(c, h);
    all++; latGap += Math.abs(sLat - tLat); lonGap += Math.abs(sLon - tLon);
    if (tLon < -0.3 && sLon > -0.1) missBrake++;
  }
  if (!green) return;
  const L = this.track.length;
  this.cars.forEach((c, k) => {
    const imp = c.lastImpact;
    if (!labels.has(c) || before[k].retired || !imp || imp === before[k].impact || imp.kind !== 'car' || c.health >= before[k].health - 1e-6) return;
    const o = this.cars.find((o) => o.id === imp.other);
    if (!o) return;
    let ds = o.s - c.s;
    if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L;
    const dd = o.d - c.d;
    hits.push({ side: Math.abs(dd) > Math.abs(ds), sgn: Math.sign(dd) || 1, moments: (history.get(c) ?? []).slice(), at: this.time });
  });
};

process.on('exit', () => {
  const f = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2);
  console.log(`GLABELS all green: ${all} moments, mean |push across gap| ${(latGap / Math.max(1, all)).toFixed(3)}, |pedal gap| ${(lonGap / Math.max(1, all)).toFixed(3)}, teacher braking while student not ${(100 * missBrake / Math.max(1, all)).toFixed(1)}%`);
  for (const side of [true, false]) {
    const hs = hits.filter((h) => h.side === side);
    if (!hs.length) continue;
    const parts = [[3, 2], [2, 1], [1, 0.5], [0.5, 0]].map(([a, b]) => {
      const ms = hs.flatMap((h) => h.moments.filter((m) => h.at - m.t <= a && h.at - m.t > b).map((m) => ({ ...m, sgn: h.sgn })));
      const n = Math.max(1, ms.length);
      const sT = ms.reduce((s, m) => s + m.sLat * m.sgn, 0) / n, tT = ms.reduce((s, m) => s + m.tLat * m.sgn, 0) / n;
      const toward = ms.filter((m) => m.sLat * m.sgn > 0.15 && m.tLat * m.sgn < 0.05).length / n;
      const sx = ms.reduce((s, m) => s + m.sLon, 0) / n, tx = ms.reduce((s, m) => s + m.tLon, 0) / n;
      const miss = ms.filter((m) => m.tLon < -0.3 && m.sLon > -0.1).length / n;
      const v = ms.reduce((s, m) => s + m.vLat * m.sgn, 0) / n;
      return `${a}-${b}s toward ${f(sT)}/${f(tT)} (student only ${(100 * toward).toFixed(0)}%) pedal ${f(sx)}/${f(tx)} miss ${(100 * miss).toFixed(0)}% moving toward ${f(v)} m/s`;
    });
    console.log(`GLABELS ${side ? 'beside' : 'nose to tail'}: ${hs.length} contacts`);
    for (const p of parts) console.log(`GLABELS   ${p}`);
  }
});

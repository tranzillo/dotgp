// Preload for incidents.ts: what each car's own teacher (as in training: its personality's traffic racer, reacting at
// once) would have done in the seconds before a damaging hit while the field is pacing, beside what the caution skill
// did. Each step, for every car its caution skill drives, the teacher decides from where the car really is (as DAgger
// labels it) and is put back. Prints LABELS lines at exit: per window before the hit, mean pedal (+1 throttle, -1
// brake) student / teacher, the share of moments the teacher braked (< -0.3) while the student didn't (> -0.1), and
// the steering gap; how soon before the hit each first braked; and the same disagreement over all pacing time.
//   DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx --import ./scripts/cautionLabels.ts scripts/incidents.ts \
//     public/drivers/stable-candidate-v8-lines.json --tracks flat --seeds 2 --field 40 --rules 1
// LABELS_DUMP=<file>: also writes a share of the pacing moments (LABELS_SAMPLE, default 0.04) as what the caution skill
// saw and what its teacher would have done, by driver (for scripts/cautionFit.ts): per moment its roster index, the
// inputs, the label (pedal, steering as the student sees it: mirrored with its view), all float32. LABELS_EXTRA=1: two
// more after the inputs (what the teacher's speed rests on that the student doesn't see): the fastest it may go to stop
// behind everything in its path (its follow cap) against its speed, and that with its place's and the wreck's speed,
// each (cap - speed) / 20 within +-2.
import { readFileSync, writeFileSync } from 'node:fs';
import { adaptWeights, CAUTION_FROM, NeuralDriver, PIT_FROM } from '../src/ai/drivers';
import { TrafficRacer } from '../src/ai/trafficRacer';
import { teacherOf } from '../src/school/ovalApprentice';
import { PHYSICS as P } from '../src/sim/constants';
import { World } from '../src/sim/world';
import type { Car } from '../src/sim/car';

type Moment = { t: number; sx: number; rx: number; tx: number; sy: number; ty: number; speed: number; gap: number; closing: number };
const KEEP = 4; // s of moments kept per car
const bundle = process.argv.find((a) => a.endsWith('.json'));
const roster: Array<{ lineage: number; nerve: number; talent: number; caution?: { weights: number[] } }> =
  bundle ? JSON.parse(readFileSync(bundle, 'utf8')).drivers : [];
const keys = roster.map((d) => d.caution ? Array.from(adaptWeights(Float32Array.from(d.caution.weights)).subarray(0, 8)).join() : '');
// The network's own command (before its hands: latency and noise), its car's last.
const raw = new WeakMap<Car, number>();
const dumpTo = process.env.LABELS_DUMP, sample = Number(process.env.LABELS_SAMPLE ?? 0.04), extra = process.env.LABELS_EXTRA === '1';
const extras = new Map<Car, [number, number]>();
const dumped: Float32Array[] = [];
let current = new Map<Car, [number, number]>();
const apply = NeuralDriver.prototype.apply;
NeuralDriver.prototype.apply = function (this: NeuralDriver, car: Car, x: number, y: number) {
  raw.set(car, x);
  const label = current.get(car), who = index.get(car);
  const input = (this as any).input as Float32Array;
  if (dumpTo && label && who !== undefined && input[CAUTION_FROM] !== 0 && input[PIT_FROM] === 0 && input[PIT_FROM + 1] === 0 && Math.random() < sample) {
    const more = extra ? extras.get(car) ?? [0, 0] : [];
    const row = new Float32Array(3 + input.length + more.length);
    row[0] = who; row.set(input, 1); row.set(more, 1 + input.length);
    row[row.length - 2] = label[0]; row[row.length - 1] = this.mirrored ? -label[1] : label[1];
    dumped.push(row);
  }
  apply.call(this, car, x, y);
};
const teachers = new WeakMap<Car, TrafficRacer | null>();
const index = new WeakMap<Car, number>();
const history = new WeakMap<Car, Moment[]>();
const hits: Array<{ kind: string; moments: Moment[]; at: number }> = [];
let all = 0, allDx = 0, allDy = 0, allMiss = 0, allRx = 0, allRmiss = 0;
// By speed (m/s): moments, pedal student and teacher summed, teacher braking while the student not.
const BANDS = [0, 15, 25, 35, 45];
const bands = BANDS.map(() => ({ n: 0, sx: 0, tx: 0, miss: 0 }));

function teacherFor(car: Car, ctrl: any): TrafficRacer | null {
  if (teachers.has(car)) return teachers.get(car)!;
  const w = ctrl?.driver?.cautionNet?.weights as Float32Array | undefined;
  const i = w ? keys.indexOf(Array.from(w.subarray(0, 8)).join()) : -1;
  let teacher: TrafficRacer | null = null;
  if (i >= 0) {
    const { style, traits } = teacherOf(roster[i]);
    teacher = new TrafficRacer(style, undefined, { ...traits, reaction: 0 });
    index.set(car, i);
  }
  teachers.set(car, teacher);
  return teacher;
}

const step = World.prototype.step;
World.prototype.step = function (this: World) {
  const ctl = this.control;
  const pacing = !!ctl && ctl.pacing;
  const labels = new Map<Car, [number, number]>();
  if (pacing) {
    this.cars.forEach((c, k) => {
      const ctrl = this.controllers[k] as any;
      if (c.retired || c.cleared || c.pit.phase !== 'none' || ctrl?.mode !== 'driver' || !ctrl.driverCautions) return;
      const teacher = teacherFor(c, ctrl);
      if (!teacher) return;
      const px = c.inputX, py = c.inputY;
      teacher.takeOver(c, this);
      teacher.decide(c, this);
      labels.set(c, [c.inputX, c.inputY]);
      c.inputX = px; c.inputY = py;
      if (extra) {
        const t = teacher as any, slot = ctl!.slotFor(c);
        const lane = ctl!.aroundWreck(c, slot ? slot.d : c.d);
        const cap = t.smooth ? t.smooth.followCap(c, this, lane, t.formation.traitsFor(c)) : Infinity;
        const all = Math.min(cap, ctl!.wreckSpeed(c, lane), slot ? slot.speed : Infinity);
        const scale = (v: number) => Math.max(-2, Math.min(2, (v - c.speed) / 20));
        extras.set(c, [scale(cap), scale(all)]);
      }
    });
  }
  current = labels;
  const before = this.cars.map((c) => ({ health: c.health, retired: c.retired, speed: c.speed, impact: c.lastImpact }));
  step.call(this);
  for (const [c, [tx, ty]] of labels) {
    const ahead = ctl!.carAheadInFile(c);
    const m: Moment = { t: this.time, sx: c.inputX, rx: raw.get(c) ?? c.inputX, tx, sy: c.inputY, ty, speed: c.speed,
      gap: ahead ? this.track.distanceFrom(c.s, ahead.s) - 2 * P.CAR_RADIUS : Infinity, closing: ahead ? c.speed - ahead.speed : 0 };
    const h = history.get(c) ?? [];
    h.push(m);
    while (h.length && h[0].t < this.time - KEEP) h.shift();
    history.set(c, h);
    all++; allDx += Math.abs(m.sx - m.tx); allDy += Math.abs(m.sy - m.ty);
    if (m.tx < -0.3 && m.sx > -0.1) allMiss++;
    allRx += Math.abs(m.rx - m.tx); if (m.tx < -0.3 && m.rx > -0.1) allRmiss++;
    const b = bands[BANDS.filter((v) => m.speed >= v).length - 1] ?? bands[0];
    b.n++; b.sx += m.sx; b.tx += m.tx; if (m.tx < -0.3 && m.sx > -0.1) b.miss++;
  }
  this.cars.forEach((c, k) => {
    const imp = c.lastImpact;
    if (!labels.has(c) || before[k].retired || !imp || imp === before[k].impact || c.health >= before[k].health - 1e-6 || imp.kind !== 'car') return;
    const j = imp.other !== null ? this.cars.findIndex((o) => o.id === imp.other) : -1;
    if (j < 0) return;
    const o = this.cars[j];
    const kind = before[j].retired ? 'wreck' : before[j].speed < 1 && o.pit.phase === 'none' ? 'stopped car'
      : before[j].speed < before[k].speed - 5 ? 'slower car' : 'other car';
    hits.push({ kind, moments: (history.get(c) ?? []).slice(), at: this.time });
  });
};

process.on('exit', () => {
  if (dumpTo && dumped.length) {
    const out = new Float32Array(dumped.length * dumped[0].length);
    dumped.forEach((r, i) => out.set(r, i * r.length));
    writeFileSync(dumpTo, Buffer.from(out.buffer));
    console.log(`LABELS dumped ${dumped.length} moments of ${dumped[0].length} floats to ${dumpTo}`);
  }
  const f = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2);
  console.log(`LABELS all pacing: ${all} moments, mean |pedal gap| ${(allDx / Math.max(1, all)).toFixed(3)}, |steer gap| ${(allDy / Math.max(1, all)).toFixed(3)}, teacher braking while student not ${(100 * allMiss / Math.max(1, all)).toFixed(1)}%; the network's own command (before its hands): |pedal gap| ${(allRx / Math.max(1, all)).toFixed(3)}, teacher braking while it not ${(100 * allRmiss / Math.max(1, all)).toFixed(1)}%`);
  console.log(`LABELS by speed: ${bands.map((b, i) => `${BANDS[i]}+ m/s ${(100 * b.n / Math.max(1, all)).toFixed(0)}% pedal ${f(b.sx / Math.max(1, b.n))}/${f(b.tx / Math.max(1, b.n))} miss ${(100 * b.miss / Math.max(1, b.n)).toFixed(0)}%`).join(' | ')}`);
  for (const kind of ['wreck', 'stopped car', 'slower car', 'other car']) {
    const hs = hits.filter((h) => h.kind === kind);
    if (!hs.length) continue;
    const firstBrake = (h: (typeof hits)[number], key: 'sx' | 'tx') => { const m = h.moments.find((m) => m[key] < -0.3); return m ? h.at - m.t : 0; };
    const med = (a: number[]) => a.slice().sort((x, y) => x - y)[a.length >> 1];
    const parts = [[3, 2], [2, 1], [1, 0.5], [0.5, 0]].map(([a, b]) => {
      const ms = hs.flatMap((h) => h.moments.filter((m) => h.at - m.t <= a && h.at - m.t > b));
      const n = Math.max(1, ms.length);
      const sx = ms.reduce((s, m) => s + m.sx, 0) / n, tx = ms.reduce((s, m) => s + m.tx, 0) / n;
      const miss = ms.filter((m) => m.tx < -0.3 && m.sx > -0.1).length / n;
      const rmiss = ms.filter((m) => m.tx < -0.3 && m.rx > -0.1).length / n;
      const dy = ms.reduce((s, m) => s + Math.abs(m.sy - m.ty), 0) / n;
      return `${a}-${b}s pedal ${f(sx)}/${f(tx)} miss ${(100 * miss).toFixed(0)}% (net ${(100 * rmiss).toFixed(0)}%) steer gap ${dy.toFixed(2)}`;
    });
    const at2 = hs.map((h) => h.moments.find((m) => h.at - m.t <= 2)).filter((m): m is Moment => !!m);
    console.log(`LABELS into ${kind.padEnd(11)} ${String(hs.length).padStart(4)} hits; first braked (s before) student ${med(hs.map((h) => firstBrake(h, 'sx'))).toFixed(2)} teacher ${med(hs.map((h) => firstBrake(h, 'tx'))).toFixed(2)}; 2 s out speed ${med(at2.map((m) => m.speed)).toFixed(1)} gap ${med(at2.map((m) => m.gap)).toFixed(0)} m closing ${med(at2.map((m) => m.closing)).toFixed(1)}`);
    console.log(`LABELS   ${parts.join(' | ')}`);
  }
});

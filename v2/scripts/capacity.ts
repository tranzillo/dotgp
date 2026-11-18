/**
 * Is the driver network big enough to copy its teacher? A road apprenticeship
 * records what its student saw and what the teacher would have done there
 * (on training circuits, and separately on held-out ones); networks of
 * several sizes learn the training moments, and each one's error is
 * measured on both. If bigger networks fit the held-out moments much more
 * closely, the driver's size is what limits how well it can copy.
 *
 *   npx tsx scripts/capacity.ts [--rounds 6] [--train 60000] [--epochs 10] [--sizes 32x24,64x48,128x96] [--extra edges,line,both]
 *
 * --extra: also record (and fit with) more to see: 'edges', where the road's edges are ahead (0-120 m,
 * relative to the car); 'line', where the fastest line is ahead (the answer, nearly: a reference); 'both';
 * 'speed', the speed the line takes ahead against the car's; 'line+speed'.
 * Each is fitted at the first size; 'none' is the driver's own inputs.
 */
import { adaptWeights, DRIVER_LAYERS } from '../src/ai/drivers';
import { randomWeights } from '../src/ai/mlp';
import { Network, trainSupervised, type Example } from '../src/ai/network';
import { Rng } from '../src/ai/rng';
import { apprenticeRoadCourses } from '../src/school/roadLesson';
import { hashSeed } from '../src/trackgen';
import { readFileSync } from 'node:fs';
import { fastestLine, lineAt } from '../src/ai/racingLine';
import type { Car } from '../src/sim/car';
import type { World } from '../src/sim/world';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[++i]);
const num = (k: string, d: number) => (args.has(k) ? Number(args.get(k)) : d);
const log = console.log;
console.log = () => {};
const rounds = num('rounds', 6), trainN = num('train', 60000), epochs = num('epochs', 10);
const sizes = (args.get('sizes') ?? '32x24,64x48,128x96').split(',').map((s) => s.split('x').map(Number));
const AHEAD = [0, 15, 30, 50, 80, 120];
/** Lateral things ahead, relative to the car (+ toward +d; mirrored as the student saw them, inner and outer swapping). */
const extras = {
  edges: (car: Car, world: World, mirrored: boolean) => {
    const t = world.track, out = new Float32Array(2 * AHEAD.length);
    AHEAD.forEach((a, j) => {
      const i = t.indexAt(car.s + a);
      const inner = (t.innerEdge(i) - car.d) / 10, outer = (t.outerEdge(i) - car.d) / 10;
      out[2 * j] = mirrored ? -outer : inner;
      out[2 * j + 1] = mirrored ? -inner : outer;
    });
    return out;
  },
  line: (car: Car, world: World, mirrored: boolean) => {
    const line = fastestLine(world.track), out = new Float32Array(AHEAD.length);
    AHEAD.forEach((a, j) => { const v = (lineAt(line, car.s + a).d - car.d) / 10; out[j] = mirrored ? -v : v; });
    return out;
  },
  /** The speed the line takes ahead (at the teacher's share of these tyres' grip), against the car's own. */
  speed: (car: Car, world: World) => {
    const line = fastestLine(world.track), sp = line.at(Math.round(0.85 * car.grip * 50) / 50).speed, n = sp.length;
    const out = new Float32Array(AHEAD.length);
    AHEAD.forEach((a, j) => { const k = ((Math.round((car.s + a) / line.step) % n) + n) % n; out[j] = (sp[k] - car.speed) / 20; });
    return out;
  },
};
const extraKinds = (args.get('extra') ?? '').split(',').filter(Boolean);
const recordExtra = (car: Car, world: World, mirrored: boolean) => {
  const e = extras.edges(car, world, mirrored), l = extras.line(car, world, mirrored), v = extras.speed(car, world);
  const out = new Float32Array(e.length + l.length + v.length);
  out.set(e); out.set(l, e.length); out.set(v, e.length + l.length);
  return out;
};
const opts = {
  teacher: { kind: 'traffic' as const, grip: 0.85 }, knocks: 2, packs: 2, wear: true, rounds, epochs: 8,
  ...(extraKinds.length ? { extra: recordExtra } : {}),
};

/** The moments an apprenticeship records (its student a fresh copy of the house driver's oval driving). */
function record(seed: number): Example[] {
  const house = JSON.parse(readFileSync('public/drivers/default.json', 'utf8')).drivers[0];
  const w = adaptWeights(Float32Array.from(house.weights));
  let out: Example[] = [];
  apprenticeRoadCourses(w, seed, { ...opts, onExamples: (ex) => { out = ex; } });
  return out;
}
const pick = (ex: Example[], n: number, rng: Rng) => {
  const a = ex.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = rng.int(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
};
function mse(layers: number[], w: Float32Array, data: Example[]): number {
  const net = new Network(layers, w);
  let s = 0;
  for (const e of data) { const o = net.forward(e.x); for (let k = 0; k < 2; k++) s += ((o[k] - e.y[k]) * e.mask[k]) ** 2; }
  return s / data.length;
}

const t0 = Date.now();
const rng = new Rng(7);
const train = pick(record(hashSeed(1, 'capacity-train')), trainN, rng);
const held = pick(record(hashSeed(2, 'capacity-held')), Math.round(trainN / 3), rng);
log(`recorded ${train.length} training moments, ${held.length} held out (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
// What always answering the average gets: the scale errors are judged on.
const mean = [0, 1].map((k) => train.reduce((a, e) => a + e.y[k], 0) / train.length);
const base = held.reduce((a, e) => a + (e.y[0] - mean[0]) ** 2 + (e.y[1] - mean[1]) ** 2, 0) / held.length;
log(`  always the average answer: held-out error ${base.toFixed(4)}`);
const nIn = DRIVER_LAYERS[0], nEdges = 2 * AHEAD.length, nLine = AHEAD.length;
/** The inputs a fit sees: the driver's own, plus the chosen extras. */
const view = (kind: string) => (e: Example): Example => {
  if (!extraKinds.length) return e;
  const parts = [e.x.subarray(0, nIn)];
  if (kind === 'edges' || kind === 'both') parts.push(e.x.subarray(nIn, nIn + nEdges));
  if (kind === 'line' || kind === 'both' || kind === 'line+speed') parts.push(e.x.subarray(nIn + nEdges, nIn + nEdges + nLine));
  if (kind === 'speed' || kind === 'line+speed') parts.push(e.x.subarray(nIn + nEdges + nLine, nIn + nEdges + 2 * nLine));
  const x = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { x.set(p, o); o += p.length; }
  return { ...e, x };
};
const fits: Array<[string, number[]]> = extraKinds.length
  ? ['none', ...extraKinds].map((k) => [k, sizes[0]]) : sizes.map((s) => ['none', s]);
for (const [kind, [h1, h2]] of fits) {
  const tr = train.map(view(kind)), ho = held.map(view(kind));
  const layers = [tr[0].x.length, h1, h2, 2];
  const r = new Rng(hashSeed(3, `${h1}x${h2}`));
  const w = randomWeights(layers, () => r.gaussian());
  const t = Date.now();
  const curve: string[] = [];
  for (let e = 0; e < epochs; e++) {
    trainSupervised(layers, w, tr, 1, 0.01, () => r.next());
    if (e % 3 === 2 || e === epochs - 1) curve.push(`${e + 1}: ${mse(layers, w, ho).toFixed(4)}`);
  }
  log(`  ${kind === 'none' ? 'own inputs' : `+ ${kind}`}, ${h1}x${h2} (${w.length} weights): training error ${mse(layers, w, tr).toFixed(4)}, held-out ${mse(layers, w, ho).toFixed(4)}`
    + ` (${(100 * (1 - mse(layers, w, ho) / base)).toFixed(0)}% explained); by epoch ${curve.join(', ')} (${((Date.now() - t) / 1000).toFixed(0)} s)`);
}

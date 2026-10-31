/**
 * Can the caution skill learn what its teacher does under caution, from what it sees? Moments dumped by
 * scripts/cautionLabels.ts (LABELS_DUMP: the caution skill's inputs while it drove, its own teacher's label from
 * there), per driver: the bundle's caution network on held-out moments (another race), then a copy trained on the
 * training races' moments, and the same with variants. Reported over all drivers: pedal error (mean |net - teacher|),
 * the share of moments the teacher brakes (< -0.3) and the network doesn't (> -0.1), and steering error.
 *   npx tsx scripts/cautionFit.ts public/drivers/stable-candidate-v8-lines.json --train a.bin,b.bin --test c.bin \
 *     [--epochs 8] [--lr 0.01] [--brake-weight 1] [--wide 0] [--extra 0] [--skip 0] [--pooled 1] [--out bundle.json]
 * --brake-weight k: moments the teacher brakes in (< -0.3) count k times. --wide 1: also a network of [in, 64, 48, 2]
 * trained from small random weights (is a 32-24 network too small for it?). --extra n: the dump has n more inputs
 * (LABELS_EXTRA): one network for the whole field trained from small random weights without them and one with them, on
 * the training races, scored on the held-out one (does the teacher's speed rest on what they say?). --pooled 1: each
 * driver's copy trains on every driver's moments, not its own alone. --out: the bundle with each driver's caution
 * network the trained copy.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { adaptWeights, DRIVER_LAYERS } from '../src/ai/drivers';
import { genomeSize, Network, trainSupervised, type Example } from '../src/ai/network';
import { Rng } from '../src/ai/rng';

const args = new Map<string, string>();
for (let i = 3; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[++i]);
const file = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const bundle: Array<{ caution?: { weights: number[] } }> = file.drivers;
const epochs = Number(args.get('epochs') ?? 8), lr = Number(args.get('lr') ?? 0.01), brakeWeight = Number(args.get('brake-weight') ?? 1);
const IN = DRIVER_LAYERS[0], EXTRA = Number(args.get('extra') ?? 0);
/** --skip n: the dump has n extra inputs, left out (training the drivers' own networks on a dump made with them). */
const SKIP = Number(args.get('skip') ?? 0);

function load(files: string): Map<number, Example[]> {
  const by = new Map<number, Example[]>();
  for (const f of files.split(',')) {
    const b = readFileSync(f);
    const all = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
    // Row: who, the inputs, any extra ones, pedal, steering.
    const row = IN + EXTRA + SKIP + 3;
    if (all.length % row) throw new Error(`${f}: not rows of ${row}`);
    for (let o = 0; o + row <= all.length; o += row) {
      const who = all[o];
      const ex: Example = { x: all.slice(o + 1, o + 1 + IN + EXTRA), y: all.slice(o + row - 2, o + row), mask: Float32Array.of(1, 1) };
      (by.get(who) ?? by.set(who, []).get(who)!).push(ex);
    }
  }
  return by;
}
type Score = { n: number; pedal: number; braking: number; miss: number; steer: number };
const zero = (): Score => ({ n: 0, pedal: 0, braking: 0, miss: 0, steer: 0 });
function score(net: Network, data: Example[], into: Score): void {
  for (const e of data) {
    const out = net.forward(e.x);
    into.n++;
    into.pedal += Math.abs(out[0] - e.y[0]);
    into.steer += Math.abs(out[1] - e.y[1]);
    if (e.y[0] < -0.3) { into.braking++; if (out[0] > -0.1) into.miss++; }
  }
}
const show = (s: Score) => `pedal err ${(s.pedal / s.n).toFixed(3)}, teacher braking ${(100 * s.braking / s.n).toFixed(1)}% of which net not ${(100 * s.miss / Math.max(1, s.braking)).toFixed(0)}%, steer err ${(s.steer / s.n).toFixed(3)}`;

function freshWeights(layers: readonly number[], rng: Rng): Float32Array {
  const w = new Float32Array(genomeSize(layers));
  let i = 0;
  for (let l = 1; l < layers.length; l++) {
    const scale = 1 / Math.sqrt(layers[l - 1]);
    for (let o = 0; o < layers[l]; o++) { w[i++] = 0; for (let k = 0; k < layers[l - 1]; k++) w[i++] = scale * rng.gaussian(); }
  }
  return w;
}

const train = load(args.get('train')!), test = load(args.get('test')!);
if (EXTRA) {
  // Pooled, from scratch, without and with the extra inputs (zeroed for "without": the same network shape).
  const rng = new Rng(3);
  const pool = (m: Map<number, Example[]>, keep: boolean) => [...m.values()].flat().map((e) => {
    const x = e.x.slice(); if (!keep) x.fill(0, IN); return { ...e, x };
  });
  const layers = [IN + EXTRA, 32, 24, 2] as const;
  for (const keep of [false, true]) {
    const w = freshWeights(layers, rng);
    trainSupervised(layers, w, pool(train, keep), Number(args.get('epochs') ?? 8), lr, () => rng.next());
    const s = zero(), f = zero();
    score(new Network(layers, w), pool(test, keep), s);
    score(new Network(layers, w), pool(train, keep), f);
    console.log(`FIT field network ${keep ? 'with   ' : 'without'} the extra inputs: held out ${show(s)} | training ${show(f)}`);
  }
  process.exit(0);
}
const rng = new Rng(7);
const WIDE = [IN, 64, 48, 2] as const;
const s = { before: zero(), fitTrain: zero(), after: zero(), wide: zero() };
const t0 = Date.now();
const pooled = args.get('pooled') === '1' ? [...train.values()].flat() : null;
for (const [who, own] of train) {
  const data = pooled ?? own;
  const held = test.get(who);
  const w0 = bundle[who].caution?.weights;
  if (!held?.length || !w0) continue;
  const base = adaptWeights(Float32Array.from(w0));
  score(new Network(DRIVER_LAYERS, base), held, s.before);
  const weighted = brakeWeight > 1 ? data.flatMap((e) => (e.y[0] < -0.3 ? Array(brakeWeight).fill(e) : [e])) : data;
  const w = base.slice();
  trainSupervised(DRIVER_LAYERS, w, weighted, epochs, lr, () => rng.next());
  score(new Network(DRIVER_LAYERS, w), own, s.fitTrain);
  bundle[who].caution!.weights = Array.from(w);
  score(new Network(DRIVER_LAYERS, w), held, s.after);
  if (args.get('wide') === '1') {
    const ww = freshWeights(WIDE, rng);
    trainSupervised(WIDE, ww, weighted, 3 * epochs, lr, () => rng.next());
    score(new Network(WIDE, ww), held, s.wide);
  }
}
console.log(`drivers ${train.size}, train moments ${[...train.values()].reduce((a, d) => a + d.length, 0)}, held out ${[...test.values()].reduce((a, d) => a + d.length, 0)} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
console.log(`FIT bundle's network, held out:     ${show(s.before)}`);
console.log(`FIT trained copy, its training data: ${show(s.fitTrain)}`);
console.log(`FIT trained copy, held out:          ${show(s.after)}`);
if (args.has('out')) { writeFileSync(args.get('out')!, JSON.stringify(file)); console.log(`-> ${args.get('out')}`); }
if (s.wide.n) console.log(`FIT wide network, held out:          ${show(s.wide)}`);

/**
 * Can the oval racing skill learn what its teacher does racing among students, from what it sees? Moments from
 * scripts/raceLabels.ts --race-only (the stable racing itself, each car's own teacher labelling from where it is),
 * per driver: the bundle's racing network on held-out races (other ovals), then copies trained on the training races'
 * racing moments (green, sound car): each on its own moments; each on the whole field's; each on its own and as many
 * of the field's. Reported over all drivers: pedal error (mean |net - teacher|), the share of moments the teacher
 * brakes (< -0.3) and the network doesn't (> -0.1), and steering error. Labels come from each driver's own teacher, so
 * the field's moments carry other personalities' driving: scored on its own teacher's held-out labels, a pooled copy
 * shows what that costs.
 *   npx tsx scripts/racingFit.ts public/drivers/stable-candidate-v8ra-lines.json --train a.bin,b.bin --test c.bin \
 *     [--epochs 4] [--lr 0.01] [--moments 60000] [--out own|pooled|mixed --bundle out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { adaptWeights, CAUTION_FROM, DAMAGE_FROM, DRIVER_LAYERS } from '../src/ai/drivers';
import { Network, trainSupervised, type Example } from '../src/ai/network';
import { Rng } from '../src/ai/rng';
import { rowsToExamples } from '../src/school/raceLabels';

const args = new Map<string, string>();
for (let i = 3; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[++i]);
const file = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const bundle: Array<{ weights: number[] }> = file.drivers;
const epochs = Number(args.get('epochs') ?? 4), lr = Number(args.get('lr') ?? 0.01), moments = Number(args.get('moments') ?? 60_000);

function load(files: string): Map<number, Example[]> {
  const by = new Map<number, Example[]>();
  for (const f of files.split(',')) {
    const b = readFileSync(f);
    for (const { who, example: e } of rowsToExamples(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4))) {
      if (e.x[CAUTION_FROM] !== 0 || e.x[DAMAGE_FROM] !== 0) continue;
      (by.get(who) ?? by.set(who, []).get(who)!).push(e);
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

const rng = new Rng(7);
function pick(all: Example[], n: number): Example[] {
  if (all.length <= n) return all;
  const pool = all.slice();
  for (let i = 0; i < n; i++) { const j = i + rng.int(pool.length - i); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, n);
}

const train = load(args.get('train')!), test = load(args.get('test')!);
const field = [...train.values()].flat();
console.log(`racing moments: train ${field.length} (${train.size} drivers), held out ${[...test.values()].reduce((a, d) => a + d.length, 0)}`);
const variants = { own: zero(), pooled: zero(), mixed: zero() } as Record<string, Score>;
const before = zero();
const outKind = args.get('out');
const t0 = Date.now();
for (const [who, own] of train) {
  const held = test.get(who) ?? [];
  const base = adaptWeights(Float32Array.from(bundle[who].weights));
  score(new Network(DRIVER_LAYERS, base), held, before);
  const sets: Record<string, Example[]> = {
    own: pick(own, moments),
    pooled: pick(field, moments),
    mixed: [...pick(own, moments / 2), ...pick(field, Math.min(moments / 2, Math.max(own.length, moments / 4)))],
  };
  for (const [kind, data] of Object.entries(sets)) {
    // (A driver not in the held-out races trains only for the bundle written out.)
    if (!held.length && kind !== outKind) continue;
    const w = base.slice();
    trainSupervised(DRIVER_LAYERS, w, data, epochs, lr, () => rng.next());
    if (![...w].every(Number.isFinite)) continue;
    score(new Network(DRIVER_LAYERS, w), held, variants[kind]);
    if (kind === outKind) bundle[who].weights = Array.from(w);
  }
}
console.log(`(${((Date.now() - t0) / 1000).toFixed(0)} s)`);
console.log(`FIT bundle's racing network, held out: ${show(before)}`);
for (const [kind, s] of Object.entries(variants)) console.log(`FIT trained on ${kind.padEnd(6)} moments, held out: ${show(s)}`);
if (outKind && args.has('bundle')) { writeFileSync(args.get('bundle')!, JSON.stringify(file)); console.log(`-> ${args.get('bundle')} (${outKind})`); }

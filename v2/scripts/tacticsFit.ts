// Can the tactics learn their teachers' plans from what they see? Records v7 students' plan moments (DAgger) on a
// track, then: v7's own tactics against the labels; a fresh tactics net trained as the apprenticeship does (going + 2x
// holding) at 4/20/60 epochs, tested on held-out students (by student, so consecutive moments don't leak).
//
//   DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx scripts/tacticsFit.ts [track speedway] [students 10] [laps 20] [bundle]
import { readFileSync } from 'node:fs';
import { Network, trainSupervised } from '../src/ai/network';
import { Rng } from '../src/ai/rng';
import { adaptWeights, TACTIC, TACTICS_LAYERS } from '../src/ai/drivers';
import { classroomRace } from '../src/school/classroomRace';
import { presetTrack } from '../src/trackgen/index';
import { tacticsWeights } from '../src/school/ovalApprentice';

const trackName = process.argv[2] ?? 'speedway';
const n = Number(process.argv[3] ?? 10);
const bundle = JSON.parse(readFileSync(process.argv[5] ?? 'public/drivers/stable-candidate-v7-lines.json', 'utf8')).drivers;
const students = bundle.slice(0, n).map((d: any) => ({
  lineage: d.lineage, nerve: d.nerve, talent: d.talent, limits: d.limits,
  weights: adaptWeights(Float32Array.from(d.weights)), caution: d.caution ? adaptWeights(Float32Array.from(d.caution.weights)) : null,
  tactics: d.tactics ? Float32Array.from(d.tactics.weights) : null,
}));
const examples = students.map(() => [] as any[]), plans = students.map(() => [] as any[]);
const rng = new Rng(7);
const t0 = Date.now();
const res = classroomRace(presetTrack(trackName), students, { kind: 'student' }, examples, rng, { field: 40, laps: Number(process.argv[4] ?? 20), debris: 0.05, tactics: plans }, 1, 11);
console.log(`${trackName}: ${res.out} out, ${(Date.now() - t0) / 1000}s`);

const cls = (y: Float32Array) => (y[TACTIC.HOLD] > 0 ? 0 : y[TACTIC.LOW] > 0 ? 1 : 2);
const all = plans.flat();
const counts = [0, 0, 0];
for (const e of all) counts[cls(e.y)]++;
console.log(`moments ${all.length}: hold ${counts[0]} low ${counts[1]} high ${counts[2]}`);

function confusion(net: any, set: any[]) {
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const e of set) {
    const s = net.forward(e.x);
    let best = 0;
    for (let k = 1; k < 3; k++) if (s[k] > s[best]) best = k;
    m[cls(e.y)][best]++;
  }
  return m;
}
function show(label: string, m: number[][]) {
  const recall = m.map((row, i) => (row.reduce((a, b) => a + b, 0) ? row[i] / row.reduce((a, b) => a + b, 0) : NaN));
  console.log(`${label}: recall hold ${(100 * recall[0]).toFixed(0)}% low ${(100 * recall[1]).toFixed(0)}% high ${(100 * recall[2]).toFixed(0)}%  rows(true)->cols(pred) ${JSON.stringify(m)}`);
}

// v7's own tactics on their own moments.
const m7 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
students.forEach((d: any, s: number) => {
  if (!d.tactics) return;
  const c = confusion(new Network(TACTICS_LAYERS, d.tactics), plans[s]);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m7[i][j] += c[i][j];
});
show('v7 tactics (own moments)', m7);

// Held-out by student.
const testN = Math.max(2, Math.floor(n / 4));
const train = plans.slice(testN).flat(), test = plans.slice(0, testN).flat();
const pick = (a: any[], k: number) => { const c = a.slice(); for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; } return c.slice(0, k); };
const going = train.filter((e: any) => cls(e.y) !== 0), holding = train.filter((e: any) => cls(e.y) === 0);
const data = [...going, ...pick(holding, 2 * going.length)];
// The constant predictor's loss on that mix: the targets' variance per output.
let base = 0;
for (let k = 0; k < 3; k++) {
  const mean = data.reduce((a, e) => a + e.y[k], 0) / data.length;
  base += data.reduce((a, e) => a + (e.y[k] - mean) ** 2, 0) / data.length;
}
console.log(`train mix ${data.length} (going ${going.length}); constant-predictor loss ${(base / 3).toFixed(3)} (per output mean), ${base.toFixed(3)} (sum)`);
for (const lr of [0.01, 0.003]) {
  const w = tacticsWeights(new Rng(3));
  let done = 0;
  for (const epochs of [4, 16, 40]) {
    const loss = trainSupervised(TACTICS_LAYERS, w, data, epochs - done, lr, () => rng.next());
    done = epochs;
    const net = new Network(TACTICS_LAYERS, w);
    console.log(`lr ${lr} epochs ${epochs}: loss ${loss.toFixed(3)}`);
    show('  train', confusion(net, data));
    show('  test ', confusion(net, test));
  }
}

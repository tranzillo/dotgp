/**
 * The stable's caution practice (src/school/stableCautions.ts): each driver's
 * caution skill improved by evolution strategies in caution drills among the
 * rest of the stable. Groups train in parallel processes, then go back into
 * one bundle.
 *
 *   npx tsx scripts/stableCautions.ts --in stable.json --out practised.json [--rounds 40] [--pairs 4] [--sigma 0.02] [--lr 0.01] [--group 8] [--jobs N]
 *     [--ppo 1 [--worlds 2] [--warmup 5]]   PPO instead of ES (src/school/cautionPpo.ts): --rounds is its iterations
 *   npx tsx scripts/stableCautions.ts --in stable.json --group-only <first> --count <n> --out part.json ...   (one group)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { adaptWeights } from '../src/ai/drivers';
import type { StableDriver } from '../src/school/ovalApprentice';
import { practiseCautions } from '../src/school/stableCautions';
import { practiseCautionsPpo } from '../src/school/cautionPpo';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[++i]);
const input = args.get('in')!;
const out = args.get('out') ?? 'practised.json';
const seed = Number(args.get('seed') ?? 1);
const pass = ['rounds', 'pairs', 'sigma', 'lr', 'seed', 'ppo', 'worlds', 'warmup'].flatMap((k) => (args.has(k) ? [`--${k}`, args.get(k)!] : []));

type Json = { lineage: number; nerve: number; talent: number; limits: { latency: number; noise: number }; weights: number[]; caution?: { weights: number[] } };
const file: Json[] = JSON.parse(readFileSync(input, 'utf8')).drivers;

if (args.has('group-only')) {
  const first = Number(args.get('group-only')), count = Number(args.get('count'));
  const stable: StableDriver[] = file.map((d) => ({
    ...d, weights: adaptWeights(Float32Array.from(d.weights)), caution: d.caution ? adaptWeights(Float32Array.from(d.caution.weights)) : null,
  }));
  const students = stable.slice(first, first + count);
  if (args.has('ppo')) practiseCautionsPpo(students, seed + first, {
    ...(args.has('rounds') ? { iterations: Number(args.get('rounds')) } : {}),
    ...(args.has('worlds') ? { worlds: Number(args.get('worlds')) } : {}),
    ...(args.has('warmup') ? { warmup: Number(args.get('warmup')) } : {}),
    onIteration: (it, r) => console.log(`group ${first} iteration ${it}: clean ${(100 * r.clean).toFixed(0)}%, damage ${r.damage.toFixed(3)}, `
      + `harm ${r.harm.toFixed(3)}, place error ${r.placeError.toFixed(1)} m, ${r.samples} samples, kl ${r.kl.toFixed(4)} (${r.seconds.toFixed(0)} s)`),
  });
  else practiseCautions(students, stable, seed + first, {
    ...(args.has('rounds') ? { rounds: Number(args.get('rounds')) } : {}),
    ...(args.has('pairs') ? { pairs: Number(args.get('pairs')) } : {}),
    ...(args.has('sigma') ? { sigma: Number(args.get('sigma')) } : {}),
    ...(args.has('lr') ? { learningRate: Number(args.get('lr')) } : {}),
    onRound: (round, r) => console.log(`group ${first} round ${round}: score ${r.mean.toFixed(1)}, clean ${(100 * r.clean).toFixed(0)}%, `
      + `harm ${r.harm.toFixed(3)} (${r.seconds.toFixed(0)} s)`),
  });
  writeFileSync(out, JSON.stringify({ drivers: students.map((d, i) => ({ ...file[first + i], caution: { weights: Array.from(d.caution!) } })) }));
} else {
  const group = Number(args.get('group') ?? 8);
  const jobs = Number(args.get('jobs') ?? Math.max(1, cpus().length - 1));
  const dir = mkdtempSync(join(tmpdir(), 'cautions-'));
  const groups = Array.from({ length: Math.ceil(file.length / group) }, (_, g) => ({ first: g * group, count: Math.min(group, file.length - g * group), file: join(dir, `g${g}.json`) }));
  const queue = groups.slice();
  const t0 = Date.now();
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let g = queue.shift(); g; g = queue.shift()) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('npx', ['tsx', 'scripts/stableCautions.ts', '--in', input, '--group-only', String(g.first), '--count', String(g.count), '--out', g.file, ...pass],
          { shell: true, stdio: ['ignore', 'inherit', 'inherit'] });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`group ${g.first} exited ${code}`))));
      });
    }
  }));
  const all = groups.flatMap((g) => JSON.parse(readFileSync(g.file, 'utf8')).drivers);
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(out, JSON.stringify({ drivers: all }));
  console.log(`${all.length} drivers -> ${out} (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
}

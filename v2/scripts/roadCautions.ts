/**
 * Road circuits' cautions for a bundle of stable drivers (each with a road
 * skill): their road caution networks learn formation laps and safety cars
 * in classroom races on circuits (src/school/roadCautions.ts). Groups train
 * in parallel processes; the bundle comes back with each driver's
 * roadCourse.caution.
 *
 *   npx tsx scripts/roadCautions.ts --in bundle.json --out out.json [--group 8] [--rounds 8] [--field 20] [--laps 6] [--seed 1] [--jobs N]
 *   npx tsx scripts/roadCautions.ts --in bundle.json --group-only <first> --count <n> --out part.json ...   (one group)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { adaptWeights } from '../src/ai/drivers';
import { apprenticeRoadCautions, type RoadCautionStudent } from '../src/school/roadCautions';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[++i]);
const inFile = args.get('in'), out = args.get('out');
if (!inFile || !out) throw new Error('--in bundle.json --out out.json');
const seed = Number(args.get('seed') ?? 1);
const pass = ['rounds', 'field', 'laps', 'seed', 'debris', 'starts'].flatMap((k) => (args.has(k) ? [`--${k}`, args.get(k)!] : []));

interface Entry {
  lineage: number; nerve: number; talent: number; limits: { latency: number; noise: number }; weights: number[];
  roadCourse: { weights: number[]; caution?: { weights: number[] } };
}
const bundle = JSON.parse(readFileSync(inFile, 'utf8')) as { drivers: Entry[] };

if (args.has('group-only')) {
  const first = Number(args.get('group-only')), count = Number(args.get('count'));
  const entries = bundle.drivers.slice(first, first + count);
  const students: RoadCautionStudent[] = entries.map((e) => ({
    lineage: e.lineage, nerve: e.nerve, talent: e.talent, limits: e.limits,
    weights: adaptWeights(Float32Array.from(e.weights)), road: adaptWeights(Float32Array.from(e.roadCourse.weights)),
    roadCaution: e.roadCourse.caution ? adaptWeights(Float32Array.from(e.roadCourse.caution.weights)) : null,
  }));
  apprenticeRoadCautions(students, seed + first, {
    ...(args.has('rounds') ? { rounds: Number(args.get('rounds')) } : {}),
    ...(args.has('field') ? { field: Number(args.get('field')) } : {}),
    ...(args.has('laps') ? { laps: Number(args.get('laps')) } : {}),
    ...(args.has('debris') ? { debris: Number(args.get('debris')) } : {}),
    ...(args.has('starts') ? { starts: Number(args.get('starts')) } : {}),
    onRound: (round, r) => console.log(`group ${first} round ${round} ${r.track}: ${r.out} out, ${r.safetyCars} safety cars, `
      + `${r.pacing} pacing moments, loss ${r.loss.toFixed(4)} (${r.seconds.toFixed(0)} s)`),
  });
  writeFileSync(out, JSON.stringify({
    drivers: entries.map((e, i) => ({ ...e, roadCourse: { ...e.roadCourse, caution: { weights: Array.from(students[i].roadCaution!) } } })),
  }));
} else {
  const group = Number(args.get('group') ?? 8);
  const jobs = Number(args.get('jobs') ?? Math.max(1, cpus().length - 1));
  const dir = mkdtempSync(join(tmpdir(), 'road-cautions-'));
  const n = bundle.drivers.length;
  const groups = Array.from({ length: Math.ceil(n / group) }, (_, g) => ({ first: g * group, count: Math.min(group, n - g * group), file: join(dir, `g${g}.json`) }));
  const queue = groups.slice();
  const t0 = Date.now();
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let g = queue.shift(); g; g = queue.shift()) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('npx', ['tsx', 'scripts/roadCautions.ts', '--in', inFile, '--group-only', String(g.first), '--count', String(g.count), '--out', g.file, ...pass],
          { shell: true, stdio: ['ignore', 'inherit', 'inherit'] });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`group ${g.first} exited ${code}`))));
      });
    }
  }));
  const all = groups.flatMap((g) => JSON.parse(readFileSync(g.file, 'utf8')).drivers);
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(out, JSON.stringify({ ...bundle, drivers: all }));
  console.log(`${all.length} drivers -> ${out} (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
}

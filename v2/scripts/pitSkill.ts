/**
 * Pit stops for a bundle of drivers: each driver's pit network learns its
 * own stops on ovals and circuits from the pit maneuver
 * (src/school/pitSkill.ts). Groups train in parallel processes; the bundle
 * comes back with each driver's pit skill (and licensed to drive its own
 * stops).
 *
 *   npx tsx scripts/pitSkill.ts --in bundle.json --out out.json [--group 8] [--rounds 6] [--ovals 2] [--circuits 2] [--overshoots 0] [--seed 1] [--jobs N]
 *   npx tsx scripts/pitSkill.ts --in bundle.json --group-only <first> --count <n> --out part.json ...   (one group)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { adaptWeights } from '../src/ai/drivers';
import { apprenticePitSkill, type PitStudent } from '../src/school/pitSkill';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[++i]);
const inFile = args.get('in'), out = args.get('out');
if (!inFile || !out) throw new Error('--in bundle.json --out out.json');
const seed = Number(args.get('seed') ?? 1);
const pass = ['rounds', 'seed', 'ovals', 'circuits', 'overshoots'].flatMap((k) => (args.has(k) ? [`--${k}`, args.get(k)!] : []));

interface Entry {
  lineage?: number; limits?: { latency: number; noise: number }; weights: number[];
  roadCourse?: { weights: number[]; style?: { grip: number; margin: number } }; pit?: { weights: number[] };
}
const bundle = JSON.parse(readFileSync(inFile, 'utf8')) as { drivers: Entry[] };

if (args.has('group-only')) {
  const first = Number(args.get('group-only')), count = Number(args.get('count'));
  const entries = bundle.drivers.slice(first, first + count);
  const students: PitStudent[] = entries.map((e, i) => ({
    lineage: e.lineage ?? first + i, limits: e.limits,
    knowledge: e.roadCourse?.style && { grip: e.roadCourse.style.grip, margin: e.roadCourse.style.margin },
    weights: adaptWeights(Float32Array.from(e.weights)), road: e.roadCourse ? adaptWeights(Float32Array.from(e.roadCourse.weights)) : undefined,
    pit: e.pit ? adaptWeights(Float32Array.from(e.pit.weights)) : null,
  }));
  apprenticePitSkill(students, seed + first, {
    ...(args.has('rounds') ? { rounds: Number(args.get('rounds')) } : {}),
    ...(args.has('ovals') ? { ovals: Number(args.get('ovals')) } : {}),
    ...(args.has('circuits') ? { circuits: Number(args.get('circuits')) } : {}),
    ...(args.has('overshoots') ? { overshoots: Number(args.get('overshoots')) } : {}),
    onRound: (round, r) => console.log(`group ${first} round ${round}: ${r.completed}/${r.stops} stops done, ${r.recovered}/${r.overshoots} backed up into the box, loss ${r.loss.toFixed(4)} (${r.seconds.toFixed(0)} s)`),
  });
  writeFileSync(out, JSON.stringify({
    drivers: entries.map((e, i) => ({ ...e, pit: { weights: Array.from(students[i].pit!) }, pitLicensed: true, pitTrafficLicensed: true })),
  }));
} else {
  const group = Number(args.get('group') ?? 8);
  const jobs = Number(args.get('jobs') ?? Math.max(1, cpus().length - 1));
  const dir = mkdtempSync(join(tmpdir(), 'pit-skill-'));
  const n = bundle.drivers.length;
  const groups = Array.from({ length: Math.ceil(n / group) }, (_, g) => ({ first: g * group, count: Math.min(group, n - g * group), file: join(dir, `g${g}.json`) }));
  const queue = groups.slice();
  const t0 = Date.now();
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let g = queue.shift(); g; g = queue.shift()) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('npx', ['tsx', 'scripts/pitSkill.ts', '--in', inFile, '--group-only', String(g.first), '--count', String(g.count), '--out', g.file, ...pass],
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

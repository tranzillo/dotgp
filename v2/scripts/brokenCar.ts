/**
 * The broken-car skill for a bundle of drivers (src/school/brokenCar.ts): each driver's broken-car network learns
 * from its teacher to get a broken car off the line and along the apron, in packs on ovals. Groups train in parallel
 * processes; the bundle comes back with each driver's skill, and its licence if it passed the test (brokenCarTest,
 * after training: not stamped).
 *
 *   npx tsx scripts/brokenCar.ts --in bundle.json --out out.json [--group 8] [--rounds 6] [--tracks 2] [--drills 4] [--racing 0] [--epochs 6] [--examples 40000] [--ahead 0 (drills a car ahead breaks: trains the racing network too)] [--seed 1] [--jobs N]
 *   npx tsx scripts/brokenCar.ts --in bundle.json --group-only <first> --count <n> --out part.json ...   (one group)
 *   npx tsx scripts/brokenCar.ts --in bundle.json --test-only 1   (each driver's licence test as it stands: teacher and student)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { adaptWeights } from '../src/ai/drivers';
import { apprenticeBrokenCar, brokenCarTest, type BrokenReport, type BrokenStudent } from '../src/school/brokenCar';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[++i]);
const inFile = args.get('in'), out = args.get('out');
if (!inFile || (!out && !args.has('test-only'))) throw new Error('--in bundle.json --out out.json');
const seed = Number(args.get('seed') ?? 1);
const pass = ['rounds', 'seed', 'tracks', 'drills', 'racing', 'epochs', 'examples', 'ahead'].flatMap((k) => (args.has(k) ? [`--${k}`, args.get(k)!] : []));

interface Entry {
  lineage?: number; nerve?: number; talent?: number; limits?: { latency: number; noise: number }; weights: number[];
  knowledge?: { grip: number; margin: number }; caution?: { weights: number[] }; pit?: { weights: number[] }; broken?: { weights: number[] }; tactics?: { weights: number[] };
}
const bundle = JSON.parse(readFileSync(inFile, 'utf8')) as { drivers: Entry[] };
const student = (e: Entry, lineage: number): BrokenStudent => ({
  lineage: e.lineage ?? lineage, nerve: e.nerve ?? 0.5, talent: e.talent ?? 0.5, limits: e.limits, knowledge: e.knowledge,
  weights: adaptWeights(Float32Array.from(e.weights)),
  caution: e.caution && adaptWeights(Float32Array.from(e.caution.weights)),
  pit: e.pit && adaptWeights(Float32Array.from(e.pit.weights)),
  broken: e.broken ? adaptWeights(Float32Array.from(e.broken.weights)) : null,
  tactics: e.tactics && Float32Array.from(e.tactics.weights),
});
const describe = (r: BrokenReport) =>
  `${r.apron}/${r.drills} to the apron (median ${r.toApron.toFixed(1)} s), ${r.hits} hits, ${r.stalls} stalls, harm ${r.harm.toFixed(2)}`;

if (args.has('test-only')) {
  bundle.drivers.forEach((e, i) => {
    const d = student(e, i);
    const teacher = brokenCarTest(d, seed, true);
    const racing = brokenCarTest({ ...d, broken: null }, seed); // (without the skill: its racing network drives the broken car)
    const skill = d.broken && brokenCarTest(d, seed);
    console.log(`driver ${i}: teacher ${teacher.passed ? 'PASS' : 'fail'} (${describe(teacher.report)}); racing net ${racing.passed ? 'PASS' : 'fail'} (${describe(racing.report)})`
      + (skill ? `; skill ${skill.passed ? 'PASS' : 'fail'} (${describe(skill.report)})` : ''));
  });
} else if (args.has('group-only')) {
  const first = Number(args.get('group-only')), count = Number(args.get('count'));
  const entries = bundle.drivers.slice(first, first + count);
  const students = entries.map((e, i) => student(e, first + i));
  apprenticeBrokenCar(students, seed + first, {
    ...(args.has('rounds') ? { rounds: Number(args.get('rounds')) } : {}),
    ...(args.has('tracks') ? { tracks: Number(args.get('tracks')) } : {}),
    ...(args.has('drills') ? { drills: Number(args.get('drills')) } : {}),
    ...(args.has('racing') ? { racingShare: Number(args.get('racing')) } : {}),
    ...(args.has('epochs') ? { epochs: Number(args.get('epochs')) } : {}),
    ...(args.has('examples') ? { maxExamples: Number(args.get('examples')) } : {}),
    ...(args.has('ahead') ? { ahead: Number(args.get('ahead')) } : {}),
    onRound: (round, r) => console.log(`group ${first} round ${round}: ${describe(r)}, loss ${r.loss.toFixed(4)}`
      + (r.ahead.drills ? `; a car ahead breaking: ${r.ahead.hits} hits in ${r.ahead.drills} drills, racing loss ${r.racingLoss.toFixed(4)}` : '') + ` (${r.seconds.toFixed(0)} s)`),
  });
  const tests = students.map((d) => brokenCarTest(d, seed));
  tests.forEach((t, i) => console.log(`group ${first} driver ${first + i} licence ${t.passed ? 'PASSED' : 'failed'}: ${describe(t.report)}`));
  writeFileSync(out!, JSON.stringify({
    drivers: entries.map((e, i) => ({
      ...e, ...(args.has('ahead') ? { weights: Array.from(students[i].weights) } : {}), broken: { weights: Array.from(students[i].broken!) }, brokenLicensed: tests[i].passed,
    })),
  }));
} else {
  const group = Number(args.get('group') ?? 8);
  const jobs = Number(args.get('jobs') ?? Math.max(1, cpus().length - 1));
  const dir = mkdtempSync(join(tmpdir(), 'broken-car-'));
  const n = bundle.drivers.length;
  const groups = Array.from({ length: Math.ceil(n / group) }, (_, g) => ({ first: g * group, count: Math.min(group, n - g * group), file: join(dir, `g${g}.json`) }));
  const queue = groups.slice();
  const t0 = Date.now();
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let g = queue.shift(); g; g = queue.shift()) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('npx', ['tsx', 'scripts/brokenCar.ts', '--in', inFile, '--group-only', String(g.first), '--count', String(g.count), '--out', g.file, ...pass],
          { shell: true, stdio: ['ignore', 'inherit', 'inherit'] });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`group ${g.first} exited ${code}`))));
      });
    }
  }));
  const all = groups.flatMap((g) => JSON.parse(readFileSync(g.file, 'utf8')).drivers);
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(out!, JSON.stringify({ ...bundle, drivers: all }));
  console.log(`${all.length} drivers -> ${out} (${all.filter((d: { brokenLicensed?: boolean }) => d.brokenLicensed).length} licensed, ${((Date.now() - t0) / 60000).toFixed(1)} min)`);
}

/**
 * A driving school class, headless: the drivers in a file go through a lesson
 * and come out (weights and licenses) in another file. Used by the lab.
 *
 *   npx tsx scripts/class.ts --lesson cautions --in drivers.json --out trained.json [--rounds 100] [--seed 7] [--summary out.json] [--jobs N]
 *
 * --jobs: worker threads (default: all cores but one; 1 = everything on this
 * thread). Road-course apprenticeships run one per thread, and rounds of
 * ghost laps (road courses, rookie school, track variety) are split across
 * them; the results are the same as on one thread.
 * --apprentice-epochs: passes over the recorded moments per apprenticeship round (road courses; default ROAD_APPRENTICE_EPOCHS).
 *
 * Drivers keep their licenses (caution, pit) from the input file; the output
 * records the ones they earned. Lessons that end (licenses) stop when everyone
 * has passed; others run the given rounds.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { adaptWeights } from '../src/ai/drivers';
import { Classroom, LESSONS, type LessonId } from '../src/school/classroom';
import { hashSeed, PRESETS, presetLayout } from '../src/trackgen';
import { SchoolPool } from './pool';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[++i]);
}
const lesson = args.get('lesson') as LessonId;
if (!lesson || !LESSONS[lesson]) throw new Error(`--lesson one of ${Object.keys(LESSONS).join(', ')}`);
const inFile = args.get('in') ?? 'public/drivers/default.json';
const outFile = args.get('out');
if (!outFile) throw new Error('--out file.json');
const maxRounds = Number(args.get('rounds') ?? 100);
const summaryFile = args.get('summary');
const seed = Number(args.get('seed') ?? 7);
const jobs = Math.max(1, Number(args.get('jobs') ?? cpus().length - 1));
const apprenticeship = args.has('apprentice-epochs') ? { epochs: Number(args.get('apprentice-epochs')) } : undefined;

interface DriverEntry {
  weights: number[];
  licensed?: boolean;
  pitLicensed?: boolean;
  pitTrafficLicensed?: boolean;
  cautionLicensed?: boolean;
  nerve?: number;
  /** The road-course skill (Road courses trains this, not `weights`). */
  roadCourse?: { weights: number[]; rounds?: number; licensed?: boolean; radius?: number };
}
const road = lesson === 'circuits';
const file = JSON.parse(readFileSync(inFile, 'utf8')) as { drivers: DriverEntry[] };
const t0 = Date.now();
const pool = jobs > 1 ? new SchoolPool(jobs) : null;
const students = file.drivers.map((d, k) => ({
  key: k, id: `D${k}`, name: `Driver ${k}`,
  // Road courses starts the skill as a copy of the driver's own driving.
  weights: adaptWeights(Float32Array.from(road ? d.roadCourse?.weights ?? d.weights : d.weights)), rounds: road ? d.roadCourse?.rounds ?? 0 : 0,
  licensed: d.licensed ?? true, pitLicensed: d.pitLicensed, pitTrafficLicensed: d.pitTrafficLicensed,
  cautionLicensed: d.cautionLicensed, roadLicensed: d.roadCourse?.licensed, roadRadius: d.roadCourse?.radius, nerve: d.nerve,
}));
// New road-course skills study the line follower one per thread (the classroom would do them one after another).
const apprenticed = pool && road
  ? await Promise.all(students.map((s) => (s.rounds > 0 ? undefined : pool.apprenticeRoad(s.weights.slice(), hashSeed(seed, s.id), apprenticeship))))
  : undefined;
const c = new Classroom({ lesson, presets: Object.keys(PRESETS).map(presetLayout), seed, students, apprenticed, apprenticeship });
console.log(`${lesson}: ${file.drivers.length} students, apprenticeship ${((Date.now() - t0) / 1000).toFixed(0)} s, ${jobs} thread${jobs > 1 ? 's' : ''}`);
c.takeRadio();
while (c.round < maxRounds && !c.finished) {
  if (pool && c.ghostRounds) await c.runRound((layout, genomes, opts) => pool.ghostRound(layout, genomes, opts));
  else c.step();
  c.takeReports();
  for (const l of c.takeRadio()) if (/now|went back|license|tighten|cleanly/.test(l.text)) console.log(`round ${c.round}: ${l.text}`);
}
await pool?.close();
const seconds = (Date.now() - t0) / 1000;
console.log(`${c.round} rounds, ${seconds.toFixed(0)} s, finished ${c.finished}`);

writeFileSync(outFile, JSON.stringify({
  ...file,
  drivers: file.drivers.map((d, k) => {
    const s = c.students[k];
    if (road) return { ...d, roadCourse: { weights: Array.from(s.weights), rounds: s.rounds, licensed: s.roadLicensed, radius: c.roadRadius } };
    return {
      ...d, weights: Array.from(s.weights), licensed: s.licensed, pitLicensed: s.pitLicensed,
      pitTrafficLicensed: s.pitTrafficLicensed, cautionLicensed: s.cautionLicensed,
    };
  }),
}));
if (summaryFile) {
  writeFileSync(summaryFile, JSON.stringify({
    lesson, rounds: c.round, seconds, finished: c.finished,
    students: c.students.map((s) => ({
      id: s.id, licensed: s.licensed, pitLicensed: s.pitLicensed, pitTrafficLicensed: s.pitTrafficLicensed, cautionLicensed: s.cautionLicensed,
      roadLicensed: s.roadLicensed,
    })),
    roadRadius: road ? c.roadRadius : undefined,
  }, null, 2));
}

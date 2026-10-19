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
 * --practise-on: licensed students keep practising; the class runs all --rounds.
 * --checkpoint-every N: also write the drivers every N rounds (out file with -r<round> before .json).
 * --situations X: circuit racecraft's share of situation drills (braking packs, chicanes).
 * --focus chicane|braking: circuit racecraft drills only that situation, every round, on circuits that have one.
 * --lr X, --pairs N, --valid-laps: practice settings other than the lesson's (experiments; --valid-laps scores
 * progress on valid laps only).
 * --road-init random: road lessons start the skill from a brand-new driver's random wiring (not the driver's oval driving).
 * --apprentice-rounds N: road courses' apprenticeship rounds (0: none; the skill learns from practice alone).
 * --teacher line:G[:M] | traffic:G[:M] | follower: road courses' apprenticeship teacher: a racer on each circuit's
 *   fastest line at share G of the tyres' grip (kept M m inside the track limits); the same with racecraft (following,
 *   leaving room); or the line follower (default).
 * --wear: road apprenticeship drives start on tyres anywhere from worn to new, and any fuel load.
 * --packs N: pack drills per circuit per apprenticeship round (the student among cars the teacher drives).
 * --knocks N: knocks a minute in road apprenticeships while the student drives (its speed cut to a random share).
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
import { Rng } from '../src/ai/rng';
import { initialRoadWeights } from '../src/school/roadLesson';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  // A flag followed by another flag (--practise-on) has no value.
  if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[i + 1]?.startsWith('--') ? '' : process.argv[++i]);
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
// Unset unless asked for, so the lesson's own default (road courses practise on) holds.
const practiseOn = args.has('practise-on') ? true : undefined;
const practice = {
  ...(args.has('lr') ? { learningRate: Number(args.get('lr')) } : {}),
  ...(args.has('pairs') ? { pairs: Number(args.get('pairs')) } : {}),
  ...(args.has('valid-laps') ? { validLaps: true } : {}),
  ...(args.has('situations') ? { situations: Number(args.get('situations')) } : {}),
  ...(args.has('focus') ? { focus: args.get('focus') as 'braking' | 'chicane' } : {}),
};
const checkpointEvery = Number(args.get('checkpoint-every') ?? 0);
const apprenticeship = ['apprentice-epochs', 'apprentice-rounds', 'teacher', 'knocks', 'packs', 'wear'].some((k) => args.has(k)) ? {
  ...(args.has('apprentice-epochs') ? { epochs: Number(args.get('apprentice-epochs')) } : {}),
  ...(args.has('apprentice-rounds') ? { rounds: Number(args.get('apprentice-rounds')) } : {}),
  ...(args.has('knocks') ? { knocks: Number(args.get('knocks')) } : {}),
  // --teacher line:0.9 (the fastest line at that share of grip) or follower.
  ...(args.has('teacher') ? { teacher: /^(line|traffic)/.test(args.get('teacher')!)
    ? { kind: args.get('teacher')!.split(':')[0] as 'line' | 'traffic', grip: Number(args.get('teacher')!.split(':')[1] ?? 0.9),
      ...(args.get('teacher')!.split(':')[2] ? { margin: Number(args.get('teacher')!.split(':')[2]) } : {}) }
    : { kind: 'follower' as const } } : {}),
  ...(args.has('packs') ? { packs: Number(args.get('packs')) } : {}),
  ...(args.has('wear') ? { wear: true } : {}),
} : undefined;

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
// Road-course lessons train the road-course skill, not the oval network.
const road = lesson === 'circuits' || lesson === 'roadcraft';
const file = JSON.parse(readFileSync(inFile, 'utf8')) as { drivers: DriverEntry[] };
const t0 = Date.now();
const pool = jobs > 1 ? new SchoolPool(jobs) : null;
const students = file.drivers.map((d, k) => ({
  key: k, id: `D${k}`, name: `Driver ${k}`,
  // Road courses starts the skill as a copy of the driver's own driving.
  weights: road && args.get('road-init') === 'random' && !d.roadCourse ? initialRoadWeights(new Rng(hashSeed(seed, `init-D${k}`)))
    : adaptWeights(Float32Array.from(road ? d.roadCourse?.weights ?? d.weights : d.weights)),
  rounds: road ? d.roadCourse?.rounds ?? 0 : 0,
  licensed: d.licensed ?? true, pitLicensed: d.pitLicensed, pitTrafficLicensed: d.pitTrafficLicensed,
  cautionLicensed: d.cautionLicensed, roadLicensed: d.roadCourse?.licensed, roadRadius: d.roadCourse?.radius, nerve: d.nerve,
}));
// New road-course skills study the line follower one per thread (the classroom would do them one after another).
const apprenticed = pool && lesson === 'circuits' && apprenticeship?.rounds !== 0
  ? await Promise.all(students.map((s) => (s.rounds > 0 ? undefined : pool.apprenticeRoad(s.weights.slice(), hashSeed(seed, s.id), apprenticeship))))
  : undefined;
const c = new Classroom({ lesson, presets: Object.keys(PRESETS).map(presetLayout), seed, students, apprenticed, apprenticeship, practiseOn, practice });
console.log(`${lesson}: ${file.drivers.length} students, apprenticeship ${((Date.now() - t0) / 1000).toFixed(0)} s, ${jobs} thread${jobs > 1 ? 's' : ''}`);
c.takeRadio();
while (c.round < maxRounds && !c.finished) {
  if (pool && c.runnerRounds) {
    await c.runRound({ ghost: (layout, genomes, opts) => pool.ghostRound(layout, genomes, opts), roadcraft: (round) => pool.roadcraftRound(round) });
  } else c.step();
  c.takeReports();
  for (const l of c.takeRadio()) if (/now|went back|license|tighten|cleanly/.test(l.text)) console.log(`round ${c.round}: ${l.text}`);
  if (checkpointEvery && c.round % checkpointEvery === 0) save(outFile.replace(/\.json$/, `-r${c.round}.json`));
}
await pool?.close();
const seconds = (Date.now() - t0) / 1000;
console.log(`${c.round} rounds, ${seconds.toFixed(0)} s, finished ${c.finished}`);

save(outFile);
function save(path: string): void {
  writeFileSync(path, JSON.stringify({
    ...file,
    drivers: file.drivers.map((d, k) => {
      const s = c.students[k];
      if (road) return { ...d, roadCourse: { weights: Array.from(s.weights), rounds: s.rounds, licensed: s.roadLicensed, radius: lesson === 'circuits' ? c.roadRadius : d.roadCourse?.radius } };
      return {
        ...d, weights: Array.from(s.weights), licensed: s.licensed, pitLicensed: s.pitLicensed,
        pitTrafficLicensed: s.pitTrafficLicensed, cautionLicensed: s.cautionLicensed,
      };
    }),
  }));
}
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

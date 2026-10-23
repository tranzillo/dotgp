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
 * --styles: each road student apprentices under its own style of the racing-line teacher (grip, margin, room), drawn for it.
 * --limits: drivers without human limits get them (drawn for each), and every driver learns through its own.
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
import { adaptWeights, drawLimits } from '../src/ai/drivers';
import { KNOWLEDGE_MARGINS } from '../src/ai/observe';
import { Classroom, LESSONS, type LessonId } from '../src/school/classroom';
import { hashSeed, PRESETS, presetLayout } from '../src/trackgen';
import { SchoolPool } from './pool';
import { Rng } from '../src/ai/rng';
import { apprenticeRoadCourses, initialRoadWeights } from '../src/school/roadLesson';
import { teacherOf } from '../src/school/ovalApprentice';

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

/** A road teacher's style (grip share, margin inside the track limits, room alongside). */
interface RoadStyle { grip: number; margin: number; room: number }
/**
 * A student's road style. A driver with a personality (nerve and talent, as the oval stable's individuals have) has
 * the one its personality makes, as its oval teacher is made (the same line: one driver in both disciplines).
 * Otherwise, with --styles, one drawn for it (grip 80-90%, line 0.6-1.5 m inside the limits, 0.5-1.5 m left
 * alongside), so a class grows into a field of different racers.
 */
const styleFor = (k: number): RoadStyle | undefined => {
  const d = file.drivers[k];
  if (d.nerve !== undefined && d.talent !== undefined && d.lineage !== undefined) {
    const { style } = teacherOf({ lineage: d.lineage, nerve: d.nerve, talent: d.talent });
    return { grip: style.grip, margin: style.margin, room: style.room };
  }
  if (!args.has('styles')) return undefined;
  const rng = new Rng(hashSeed(seed, `style-D${k}`));
  // Margins in steps (each a line to work out per circuit; a field shares a few).
  return { grip: 0.8 + 0.1 * rng.next(), margin: KNOWLEDGE_MARGINS[rng.int(KNOWLEDGE_MARGINS.length)], room: 0.5 + rng.next() };
};
const knowledgeFor = (style: RoadStyle | undefined) => (style ? { grip: style.grip, margin: style.margin } : undefined);
const apprenticeshipFor = (k: number) => {
  const style = styleFor(k);
  const t = apprenticeship?.teacher;
  if (!style || !t || t.kind === 'follower') return apprenticeship;
  return { ...apprenticeship, teacher: { ...t, ...style } };
};

interface DriverEntry {
  weights: number[];
  licensed?: boolean;
  pitLicensed?: boolean;
  pitTrafficLicensed?: boolean;
  cautionLicensed?: boolean;
  nerve?: number;
  /** An oval stable individual: its talent and lineage (with nerve, its personality). */
  talent?: number;
  lineage?: number;
  /** Its line on ovals (track knowledge), as the oval stable keeps it. */
  knowledge?: { grip: number; margin: number };
  /** The road-course skill (Road courses trains this, not `weights`). */
  roadCourse?: { weights: number[]; rounds?: number; licensed?: boolean; radius?: number; style?: RoadStyle };
  /** Human limits: seconds from seeing to the car answering, and motor noise (as the roster keeps them). */
  limits?: { latency: number; noise: number };
}
// Road-course lessons train the road-course skill, not the oval network.
const road = lesson === 'circuits' || lesson === 'roadcraft';
const file = JSON.parse(readFileSync(inFile, 'utf8')) as { drivers: DriverEntry[] };
const t0 = Date.now();
/**
 * --limits: drivers without human limits get them, drawn for each (0.1-0.2 s latency, 2-8% motor noise, as the stable
 * draws them), and learn through them; drivers with limits always learn through their own.
 */
const limitsOf = file.drivers.map((d, k) => {
  if (d.limits || !args.has('limits')) return d.limits;
  const rng = new Rng(hashSeed(seed, `limits-D${k}`));
  return drawLimits(() => rng.next());
});
const pool = jobs > 1 ? new SchoolPool(jobs) : null;
const students = file.drivers.map((d, k) => ({
  key: k, id: `D${k}`, name: `Driver ${k}`,
  // Road courses starts the skill as a copy of the driver's own driving.
  weights: road && args.get('road-init') === 'random' && !d.roadCourse ? initialRoadWeights(new Rng(hashSeed(seed, `init-D${k}`)))
    : adaptWeights(Float32Array.from(road ? d.roadCourse?.weights ?? d.weights : d.weights)),
  rounds: road ? d.roadCourse?.rounds ?? 0 : 0,
  licensed: d.licensed ?? true, pitLicensed: d.pitLicensed, pitTrafficLicensed: d.pitTrafficLicensed,
  cautionLicensed: d.cautionLicensed, roadLicensed: d.roadCourse?.licensed, roadRadius: d.roadCourse?.radius, nerve: d.nerve,
  // What it knows of road circuits: its style's line (its saved style, or the one drawn for it now), else the usual.
  limits: limitsOf[k],
  // On ovals: its own line as the bundle has it (an oval stable individual's), else the usual.
  knowledge: road ? knowledgeFor(d.roadCourse?.style ?? (lesson === 'circuits' && !d.roadCourse ? styleFor(k) : undefined)) : d.knowledge,
}));
// New road-course skills study the line follower one per thread (the classroom would do them one after another).
// (Each with its own style, if drawn: the classroom would give them all the class's.)
const apprenticed = (pool || args.has('styles')) && lesson === 'circuits' && apprenticeship?.rounds !== 0
  ? await Promise.all(students.map((s) => {
    if (s.rounds > 0) return undefined;
    const opts = { ...apprenticeshipFor(s.key), ...(limitsOf[s.key] ? { limits: limitsOf[s.key] } : {}) };
    if (pool) return pool.apprenticeRoad(s.weights.slice(), hashSeed(seed, s.id), opts);
    const weights = s.weights.slice();
    return { weights, examples: apprenticeRoadCourses(weights, hashSeed(seed, s.id), opts).examples };
  }))
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
      if (limitsOf[k]) d = { ...d, limits: limitsOf[k] };
      if (road) {
        const style = (lesson === 'circuits' && d.roadCourse?.rounds === undefined ? styleFor(k) : undefined) ?? d.roadCourse?.style;
        return {
          ...d, roadCourse: {
            weights: Array.from(s.weights), rounds: s.rounds, licensed: s.roadLicensed, radius: lesson === 'circuits' ? c.roadRadius : d.roadCourse?.radius,
            ...(style ? { style } : {}),
          },
        };
      }
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

/**
 * A driving school class, headless: the drivers in a file go through a lesson
 * and come out (weights and licenses) in another file. Used by the lab.
 *
 *   npx tsx scripts/class.ts --lesson cautions --in drivers.json --out trained.json [--rounds 100] [--seed 7] [--summary out.json]
 *
 * Drivers keep their licenses (caution, pit) from the input file; the output
 * records the ones they earned. Lessons that end (licenses) stop when everyone
 * has passed; others run the given rounds.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { adaptWeights } from '../src/ai/drivers';
import { Classroom, LESSONS, type LessonId } from '../src/school/classroom';
import { PRESETS, presetLayout } from '../src/trackgen';

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

interface DriverEntry {
  weights: number[];
  licensed?: boolean;
  pitLicensed?: boolean;
  pitTrafficLicensed?: boolean;
  cautionLicensed?: boolean;
  nerve?: number;
  /** The road-course skill (Road courses trains this, not `weights`). */
  roadCourse?: { weights: number[]; rounds?: number; licensed?: boolean };
}
const road = lesson === 'circuits';
const file = JSON.parse(readFileSync(inFile, 'utf8')) as { drivers: DriverEntry[] };
const t0 = Date.now();
const c = new Classroom({
  lesson, presets: Object.keys(PRESETS).map(presetLayout), seed: Number(args.get('seed') ?? 7),
  students: file.drivers.map((d, k) => ({
    key: k, id: `D${k}`, name: `Driver ${k}`,
    // Road courses starts the skill as a copy of the driver's own driving.
    weights: adaptWeights(Float32Array.from(road ? d.roadCourse?.weights ?? d.weights : d.weights)), rounds: road ? d.roadCourse?.rounds ?? 0 : 0,
    licensed: d.licensed ?? true, pitLicensed: d.pitLicensed, pitTrafficLicensed: d.pitTrafficLicensed,
    cautionLicensed: d.cautionLicensed, roadLicensed: d.roadCourse?.licensed, nerve: d.nerve,
  })),
});
console.log(`${lesson}: ${file.drivers.length} students, apprenticeship ${((Date.now() - t0) / 1000).toFixed(0)} s`);
c.takeRadio();
while (c.round < maxRounds && !c.finished) {
  c.step();
  c.takeReports();
  for (const l of c.takeRadio()) if (/now|went back|license|tighten|cleanly/.test(l.text)) console.log(`round ${c.round}: ${l.text}`);
}
const seconds = (Date.now() - t0) / 1000;
console.log(`${c.round} rounds, ${seconds.toFixed(0)} s, finished ${c.finished}`);

writeFileSync(outFile, JSON.stringify({
  ...file,
  drivers: file.drivers.map((d, k) => {
    const s = c.students[k];
    if (road) return { ...d, roadCourse: { weights: Array.from(s.weights), rounds: s.rounds, licensed: s.roadLicensed } };
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

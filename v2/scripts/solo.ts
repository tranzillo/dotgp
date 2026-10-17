/**
 * Solo driving across kinds of track: how far drivers get and how often they
 * crash, alone, on road circuits, ovals run the other way round (all
 * right-handers) and ordinary ovals. Answers "can they turn right yet?"
 * without racing (the benchmark covers racing).
 *
 *   npx tsx scripts/solo.ts [A.json] [B.json] [--tracks 6] [--seconds 120] [--json out.json]
 *
 * Every driver drives every track from the start line, once, as a ghost.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { adaptWeights } from '../src/ai/drivers';
import { Trial } from '../src/ai/evaluate';
import { Track } from '../src/sim/track';
import { generateLayout, hashSeed, mirrorLayout } from '../src/trackgen';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[++i]);
}
const files = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'));
if (!files.length) files.push('public/drivers/default.json');
const perKind = Number(args.get('tracks') ?? 6);
const seconds = Number(args.get('seconds') ?? 120);

/** Track kinds and how to make the k-th of each (fixed seeds: every run sees the same tracks). */
const KINDS: Record<string, (k: number) => Track> = {
  club: (k) => new Track(generateLayout({ type: 'circuit', seed: hashSeed(9001, `club${k}`), variant: 'club' })),
  gp: (k) => new Track(generateLayout({ type: 'circuit', seed: hashSeed(9001, `gp${k}`), variant: 'gp' })),
  // Club circuits with no corner tighter than 40 m: progress partway up the road-course curriculum.
  club40: (k) => new Track(generateLayout({ type: 'circuit', seed: hashSeed(9001, `club40-${k}`), variant: 'club', params: { minRadius: 40 } })),
  mirrored: (k) => new Track(mirrorLayout(generateLayout({ type: 'oval', seed: hashSeed(9001, `mirror${k}`) }))),
  oval: (k) => new Track(generateLayout({ type: 'oval', seed: hashSeed(9001, `oval${k}`) })),
};

export interface SoloReport {
  files: string[];
  seconds: number;
  /** Per file, per kind: mean distance (m), share of drives that crashed out, mean laps, valid laps (within the track limits), excursions. */
  results: Array<Record<string, { distance: number; crashed: number; laps: number; validLaps: number; trackLimits: number }>>;
}

const report: SoloReport = { files, seconds, results: [] };
const tracks = Object.fromEntries(Object.entries(KINDS).map(([kind, make]) => [kind, Array.from({ length: perKind }, (_, k) => make(k))]));
for (const file of files) {
  const drivers = JSON.parse(readFileSync(file, 'utf8')).drivers as Array<{ weights: number[]; roadCourse?: { weights: number[] } }>;
  const out: SoloReport['results'][number] = {};
  for (const [kind, list] of Object.entries(tracks)) {
    // Road circuits are driven by the road-course skill where a driver has one, as in races.
    const road = kind === 'club' || kind === 'gp' || kind === 'club40';
    const genomes = drivers.map((d) => adaptWeights(Float32Array.from(road ? d.roadCourse?.weights ?? d.weights : d.weights)));
    let distance = 0, crashed = 0, laps = 0, validLaps = 0, trackLimits = 0, n = 0;
    for (const track of list) {
      const trial = new Trial(track, genomes, { seconds });
      while (!trial.done) trial.step();
      const results = trial.results();
      trial.world.cars.forEach((car, k) => {
        distance += Math.max(0, car.dist + 20);
        crashed += car.retired ? 1 : 0;
        laps += car.lapTimes.length;
        validLaps += car.lapValid.filter(Boolean).length;
        trackLimits += results[k].trackLimits;
        n++;
      });
    }
    out[kind] = { distance: distance / n, crashed: crashed / n, laps: laps / n, validLaps: validLaps / n, trackLimits: trackLimits / n };
  }
  report.results.push(out);
}

console.log(`solo, ${seconds} s from the line, ${perKind} tracks of each kind; ${files.map((f, i) => `${'AB'[i] ?? i}: ${f.split(/[\\/]/).pop()}`).join(', ')}`);
for (const kind of Object.keys(KINDS)) {
  const cells = report.results.map((r) => `${(r[kind].distance / 1000).toFixed(2)} km, ${(100 * r[kind].crashed).toFixed(0)}% crashed, ${r[kind].validLaps.toFixed(2)}/${r[kind].laps.toFixed(2)} laps valid`);
  console.log(`  ${kind.padEnd(9)} ${cells.join('   |   ')}`);
}
const json = args.get('json');
if (json) writeFileSync(json, JSON.stringify(report, null, 1));

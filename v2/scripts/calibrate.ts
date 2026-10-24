/**
 * The Cup car (?spec=cup, src/sim/carSpec.ts) against real pole laps: the
 * racing line's best lap on each real oval, with the car's drag and downforce
 * fitted (one body's downforce, each package's drag, the tires' grip) to the
 * poles' average speeds (2024, Michigan 2023; official lengths, so a
 * surveyed lap a little shorter or longer than the official one compares
 * fairly).
 *
 *   npx tsx scripts/calibrate.ts [--fit]   (without --fit: CUP_FIT as it stands)
 */
import { readFileSync } from 'node:fs';
import { racingLine } from '../src/ai/racingLine';
import { CUP_FIT } from '../src/sim/carSpec';
import { applyExperiment } from '../src/sim/experiment';
import { Track } from '../src/sim/track';
import { REAL_TRACKS, realLayout } from '../src/trackgen/realtrack';

applyExperiment('?spec=cup');

const MILE = 1609.344;
/** Pole laps (s) and official lengths (miles). */
const POLES: Array<{ id: string; time: number; miles: number; superspeedway: boolean }> = [
  { id: 'daytona', time: 49.465, miles: 2.5, superspeedway: true },
  { id: 'talladega', time: 52.609, miles: 2.66, superspeedway: true },
  { id: 'indianapolis', time: 49.469, miles: 2.5, superspeedway: false },
  { id: 'michigan', time: 37.232, miles: 2.0, superspeedway: false },
  { id: 'charlotte', time: 29.355, miles: 1.5, superspeedway: false },
  { id: 'bristol', time: 15.142, miles: 0.533, superspeedway: false },
  { id: 'martinsville', time: 19.686, miles: 0.526, superspeedway: false },
];

const tracks = POLES.map((pole) => {
  const real = REAL_TRACKS.find((t) => t.id === pole.id)!;
  return { pole, track: new Track(realLayout(real, readFileSync(`public/tracks/${real.file}`, 'utf8'))) };
});
/** Our best lap's average speed against the pole's (ratio: 1 = as fast). */
const ratio = ({ pole, track }: (typeof tracks)[number]) => (track.length / racingLine(track).lapTime) / ((pole.miles * MILE) / pole.time);

if (process.argv.includes('--fit')) {
  // One body: its downforce the same on both packages. The rest first: a grid of downforce and grip, and the drag that
  // suits each best (a golden-section search: the ridges between the three trap a search that moves one at a time);
  // then the superspeedway package's drag alone, on its two tracks (they're flat out: drag sets them). Squared log
  // speed ratios; the racing line less refined while searching.
  const err = (set: typeof tracks) => set.reduce((sum, t) => sum + Math.log((t.track.length / racingLine(t.track, { refine: 8 }).lapTime) / ((t.pole.miles * MILE) / t.pole.time)) ** 2, 0);
  const rest = tracks.filter((t) => !t.pole.superspeedway), sup = tracks.filter((t) => t.pole.superspeedway);
  /** The value of x in [lo, hi] minimising f (golden section, a dozen evaluations). */
  const golden = (f: (x: number) => number, lo: number, hi: number): { x: number; e: number } => {
    const r = (Math.sqrt(5) - 1) / 2;
    let a = lo, b = hi, c = b - r * (b - a), d = a + r * (b - a), fc = f(c), fd = f(d);
    for (let k = 0; k < 10; k++) {
      if (fc < fd) { b = d; d = c; fd = fc; c = b - r * (b - a); fc = f(c); } else { a = c; c = d; fc = fd; d = a + r * (b - a); fd = f(d); }
    }
    return fc < fd ? { x: c, e: fc } : { x: d, e: fd };
  };
  let best = { e: Infinity, cda: 0, cla: 0, grip: 0 };
  for (const cla of [0, 1, 2, 3, 4, 5]) {
    for (const grip of [0.9, 1, 1.1, 1.2, 1.3, 1.4]) {
      CUP_FIT.cla = cla; CUP_FIT.grip = grip;
      const g = golden((cda) => { CUP_FIT.cda = cda; return err(rest); }, 0.5, 2.5);
      if (g.e < best.e) best = { e: g.e, cda: g.x, cla, grip };
    }
  }
  Object.assign(CUP_FIT, { cda: best.cda, cla: best.cla, grip: best.grip, claSuper: best.cla });
  CUP_FIT.cdaSuper = golden((cda) => { CUP_FIT.cdaSuper = cda; return err(sup); }, 0.5, 2.5).x;
  console.log(`fit: ${JSON.stringify(Object.fromEntries(Object.entries(CUP_FIT).map(([k, v]) => [k, +v.toFixed(3)])))}`);
}
for (const t of tracks) {
  const lap = racingLine(t.track).lapTime;
  const target = t.track.length / ((t.pole.miles * MILE) / t.pole.time);
  console.log(`${t.pole.id.padEnd(13)} ours ${lap.toFixed(2)} s, pole ${target.toFixed(2)} s on our lap (${((ratio(t) - 1) * 100).toFixed(1)}% ${ratio(t) > 1 ? 'fast' : 'slow'})`);
}

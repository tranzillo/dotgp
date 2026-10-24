/**
 * The series' cars (src/sim/carSpec.ts) against real pole laps: the racing
 * line's best lap on each real track, the car's drag, downforce and tires
 * (grip, and how it falls with load) fitted to the poles' average speeds
 * (official lengths, so a surveyed lap a little shorter or longer than the
 * official one compares fairly); the F1 car's 0-300 km/h too (carperf.ts).
 *
 *   npx tsx scripts/calibrate.ts [--f1] [--fit]
 *     the Cup car on the ovals (2024 poles, Michigan 2023), or the F1 car on the circuits (--f1: 2024 poles);
 *     without --fit, the car as it stands (CUP_FIT, F1_FIT)
 */
import { readFileSync } from 'node:fs';
import { racingLine } from '../src/ai/racingLine';
import { CUP_FIT, F1_FIT } from '../src/sim/carSpec';
import { applyExperiment } from '../src/sim/experiment';
import { Track } from '../src/sim/track';
import { type MappedPits, REAL_TRACKS, realLayout } from '../src/trackgen/realtrack';
import { straightLine, testStraight } from './carperf';

const f1 = process.argv.includes('--f1');
applyExperiment(f1 ? '?spec=f1' : '?spec=cup');

const MILE = 1609.344;
/**
 * Pole laps (s) and official lengths (m). Fitted with the rest unless `aside` (reported only); `group` for the
 * Cup car's superspeedway package (its own drag).
 */
interface Pole { id: string; time: number; length: number; group?: 'super'; aside?: string }
const CUP_POLES: Pole[] = [
  { id: 'daytona', time: 49.465, length: 2.5 * MILE, group: 'super' },
  { id: 'talladega', time: 52.609, length: 2.66 * MILE, group: 'super' },
  { id: 'indianapolis', time: 49.469, length: 2.5 * MILE },
  { id: 'michigan', time: 37.232, length: 2.0 * MILE },
  { id: 'charlotte', time: 29.355, length: 1.5 * MILE },
  { id: 'bristol', time: 15.142, length: 0.533 * MILE },
  { id: 'martinsville', time: 19.686, length: 0.526 * MILE },
];
const F1_POLES: Pole[] = [
  { id: 'monza', time: 79.327, length: 5793 },
  { id: 'silverstone', time: 85.819, length: 5891 },
  { id: 'budapest', time: 75.227, length: 4381 },
  { id: 'spielberg', time: 64.314, length: 4318 },
  { id: 'sakhir', time: 89.179, length: 5412 },
  { id: 'zandvoort', time: 69.673, length: 4259 },
  { id: 'mexicocity', time: 75.946, length: 4304, aside: '2,200 m up: thin air (less drag and downforce) not modelled' },
];

// (With their mapped pit lanes, as the app lays them out: Zandvoort's own won't fit.)
const pits = JSON.parse(readFileSync('public/tracks/pits.json', 'utf8')) as MappedPits;
/** A 2024 F1 car's 0-300 km/h (s, published figures: about 10.6). */
const F1_0_300 = 10.6;

const tracks = (f1 ? F1_POLES : CUP_POLES).map((pole) => {
  const real = REAL_TRACKS.find((t) => t.id === pole.id)!;
  return { pole, track: new Track(realLayout(real, readFileSync(`public/tracks/${real.file}`, 'utf8'), pits[pole.id]?.points)) };
});
type Entry = (typeof tracks)[number];
/** Our best lap's average speed against the pole's (ratio: 1 = as fast; the racing line less refined while searching). */
const ratio = ({ pole, track }: Entry, refine?: number) =>
  (track.length / racingLine(track, refine ? { refine } : {}).lapTime) / (pole.length / pole.time);

if (process.argv.includes('--fit')) {
  // A grid of load sensitivity and grip (more of one wants more of the other), the drag that suits each best (a
  // golden-section search: the ridges between them trap a search that moves one at a time); then downforce, and drag
  // again. The Cup car: one body, its downforce the same on both packages, then the superspeedway package's drag alone
  // on its two tracks (they're flat out: drag sets them). Squared log speed ratios.
  const fit: Record<string, number> = f1 ? F1_FIT : CUP_FIT;
  // (The F1 car's 0-300 km/h, about 10.6 s, counts as a track: it pins its drag down, which lap times trade with
  // downforce.)
  const straight = testStraight('road');
  const err = (set: Entry[]) => set.reduce((sum, t) => sum + Math.log(ratio(t, 8)) ** 2, 0)
    + (f1 && set !== sup ? Math.log(Math.min(30, straightLine(straight).to300) / F1_0_300) ** 2 : 0);
  const rest = tracks.filter((t) => !t.pole.group && !t.pole.aside), sup = tracks.filter((t) => t.pole.group === 'super');
  /** The value of x in [lo, hi] minimising f (golden section, a dozen evaluations). */
  const golden = (f: (x: number) => number, lo: number, hi: number): { x: number; e: number } => {
    const r = (Math.sqrt(5) - 1) / 2;
    let a = lo, b = hi, c = b - r * (b - a), d = a + r * (b - a), fc = f(c), fd = f(d);
    for (let k = 0; k < 10; k++) {
      if (fc < fd) { b = d; d = c; fd = fc; c = b - r * (b - a); fc = f(c); } else { a = c; c = d; fc = fd; d = a + r * (b - a); fd = f(d); }
    }
    return fc < fd ? { x: c, e: fc } : { x: d, e: fd };
  };
  const [cdaLo, cdaHi] = f1 ? [0.5, 2] : [0.8, 2.4];
  const grips = f1 ? [1.3, 1.5, 1.7, 1.9, 2.1, 2.3] : [1, 1.1, 1.2, 1.3, 1.4, 1.5];
  let best = { e: Infinity, cda: 0, k: 0, grip: 0 };
  for (const k of [0, 0.1, 0.15, 0.2, 0.25, 0.3]) {
    for (const grip of grips) {
      fit.loadSensitivity = k; fit.grip = grip;
      const g = golden((cda) => { fit.cda = cda; return err(rest); }, cdaLo, cdaHi);
      if (g.e < best.e) best = { e: g.e, cda: g.x, k, grip };
    }
  }
  Object.assign(fit, { cda: best.cda, loadSensitivity: best.k, grip: best.grip });
  fit.cla = golden((cla) => { fit.cla = cla; return err(rest); }, 0, f1 ? 10 : 8).x;
  fit.cda = golden((cda) => { fit.cda = cda; return err(rest); }, cdaLo, cdaHi).x;
  if (!f1) {
    CUP_FIT.claSuper = CUP_FIT.cla;
    CUP_FIT.cdaSuper = golden((cda) => { CUP_FIT.cdaSuper = cda; return err(sup); }, 0.5, 2.5).x;
  }
  console.log(`fit: ${JSON.stringify(Object.fromEntries(Object.entries(fit).map(([k, v]) => [k, +v.toFixed(3)])))}`);
}
for (const t of tracks) {
  const lap = racingLine(t.track).lapTime;
  const target = t.track.length / (t.pole.length / t.pole.time);
  const r = ratio(t);
  console.log(`${t.pole.id.padEnd(13)} ours ${lap.toFixed(2)} s, pole ${target.toFixed(2)} s on our lap (${((r - 1) * 100).toFixed(1)}% ${r > 1 ? 'fast' : 'slow'})${t.pole.aside ? `  [not fitted: ${t.pole.aside}]` : ''}`);
}
if (f1) {
  const r = straightLine(testStraight('road'));
  console.log(`straight line: 0-100 ${r.to100.toFixed(2)} s, 0-200 ${r.to200.toFixed(2)} s, 0-300 ${r.to300.toFixed(2)} s (about ${F1_0_300}), top ${r.top.toFixed(0)} km/h, 200-0 ${r.brake200.d.toFixed(0)} m`);
}

/**
 * The real tracks (trackgen/realtrack.ts, public/tracks/): how closely each
 * fit follows its survey, whether it lays out, and the racing line's lap
 * (the car's best, for comparing against real lap times).
 *
 *   npx tsx scripts/realtracks.ts [id ...]
 */
import { readFileSync } from 'node:fs';
import { racingLine } from '../src/ai/racingLine';
import { Track } from '../src/sim/track';
import { circuitCenterline } from '../src/trackgen/circuit';
import { integrate } from '../src/trackgen/course';
import { circuitFromSurvey, fitError, fitSurvey, parseSurvey, REAL_TRACKS, realLayout } from '../src/trackgen/realtrack';

const only = process.argv.slice(2);
for (const real of REAL_TRACKS.filter((t) => !only.length || only.includes(t.id))) {
  const csv = readFileSync(`public/tracks/${real.file}`, 'utf8');
  // How far the fitted line strays from the survey's.
  let off = '';
  if (real.kind === 'oval') {
    const e = fitError(fitSurvey(parseSurvey(csv)));
    off = `off by ${e.mean.toFixed(1)} m (worst ${e.max.toFixed(1)})`;
  } else {
    const made = circuitFromSurvey(parseSurvey(csv), { name: real.name });
    if (made) {
      const lap = integrate(circuitCenterline(made.params).sections, made.origin.x, made.origin.y, made.origin.h, 4).points;
      let max = 0, sum = 0;
      for (const [x, y] of lap) {
        let best = Infinity;
        for (const [u, v] of made.resampled) best = Math.min(best, (x - u) ** 2 + (y - v) ** 2);
        max = Math.max(max, Math.sqrt(best));
        sum += Math.sqrt(best);
      }
      off = `off by ${(sum / lap.length).toFixed(1)} m (worst ${max.toFixed(1)})`;
    } else off = "doesn't fit";
  }
  let laid: string;
  try {
    const t = new Track(realLayout(real, csv));
    const line = racingLine(t);
    laid = `${t.length.toFixed(0)} m, ${t.layout.pit.stalls.length} boxes, best lap ${line.lapTime.toFixed(2)} s`;
  } catch (e) {
    laid = `not laid out: ${(e as Error).message.replace(/^invalid \w+ layout: /, '').slice(0, 120)}`;
  }
  console.log(`${real.name.padEnd(30)} ${off.padEnd(26)} ${laid}`);
}

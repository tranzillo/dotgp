/**
 * The real tracks (trackgen/realtrack.ts, public/tracks/): whether each lays
 * out, how closely its laid-out line follows its survey (the two aligned by
 * nearest points), its pit boxes, and the racing line's lap (the car's best,
 * for comparing against real lap times).
 *
 *   npx tsx scripts/realtracks.ts [id ...] [--placed]
 *
 * (Pit lanes where OpenStreetMap has them, public/tracks/pits.json, and ours fits
 * them; --placed: our own choice everywhere.)
 */
import { readFileSync } from 'node:fs';
import { racingLine } from '../src/ai/racingLine';
import { Track } from '../src/sim/track';
import { type MappedPits, parseSurvey, REAL_TRACKS, realLayout } from '../src/trackgen/realtrack';

type Pt = [number, number];

/** How far a line strays from a survey's (mean and worst, m): each point to the survey's line (its points can be far apart). */
function offBy(line: Pt[], points: Pt[]): { mean: number; max: number } {
  const survey: Pt[] = [];
  points.forEach((p, i) => {
    const q = points[(i + 1) % points.length], steps = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 2));
    for (let k = 0; k < steps; k++) survey.push([p[0] + ((q[0] - p[0]) * k) / steps, p[1] + ((q[1] - p[1]) * k) / steps]);
  });
  const d = line.map(([x, y]) => Math.sqrt(survey.reduce((best, [u, v]) => Math.min(best, (x - u) ** 2 + (y - v) ** 2), Infinity)));
  return { mean: d.reduce((a, b) => a + b, 0) / d.length, max: Math.max(...d) };
}

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const pits = (process.argv.includes('--placed') ? {} : JSON.parse(readFileSync('public/tracks/pits.json', 'utf8'))) as MappedPits;
for (const real of REAL_TRACKS.filter((t) => !only.length || only.includes(t.id))) {
  const csv = readFileSync(`public/tracks/${real.file}`, 'utf8');
  let report: string;
  try {
    const layout = realLayout(real, csv, pits[real.id]?.points);
    const t = new Track(layout);
    // (A clockwise track is raced as its mirror image: compared with the survey mirrored.)
    const survey = parseSurvey(csv).points.map(([x, y]) => (layout.params?.drawnMirrored ? [-x, y] : [x, y]) as Pt);
    // The laid-out line moved onto the survey: its start line where the survey's is, heading the same way.
    const o = layout.params?.surveyOrigin as { x: number; y: number; h: number };
    const [x0, y0] = t.toWorld(0, 0), [x1, y1] = t.toWorld(1, 0), rot = o.h - Math.atan2(y1 - y0, x1 - x0);
    const line: Pt[] = [];
    for (let s = 0; s < t.length; s += 8) {
      const [x, y] = t.toWorld(s, 0);
      line.push([o.x + Math.cos(rot) * (x - x0) - Math.sin(rot) * (y - y0), o.y + Math.sin(rot) * (x - x0) + Math.cos(rot) * (y - y0)]);
    }
    const off = offBy(line, survey);
    const lap = racingLine(t).lapTime;
    const p = t.layout.pit, mapped = layout.params?.pitMap ? 'mapped' : 'placed';
    report = `off by ${off.mean.toFixed(1)} m (worst ${off.max.toFixed(1)})`.padEnd(26)
      + ` ${t.length.toFixed(0)} m, pits ${mapped} (entry ${(p.wallStart - p.entryStart).toFixed(0)} m, ${p.stalls.length} boxes), best lap ${lap.toFixed(2)} s`;
  } catch (e) {
    report = `not laid out: ${(e as Error).message.replace(/^invalid \w+ layout: /, '').slice(0, 120)}`;
  }
  console.log(`${real.name.padEnd(30)} ${report}`);
}

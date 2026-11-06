/**
 * An oval's two lines: each track's banking progression (as balanced, trackgen/balance.ts), how long it took to build,
 * its low and high lines (refined, as drivers get them), the high line's closest approach to the wall, and the one
 * fastest line across the road beside them.
 *
 *   DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx scripts/twoLines.ts speedway short flat oval:894715320:short ...
 */
import { fastestLine, lineAt, ovalLines, type RacingLine } from '../src/ai/racingLine';
import { PHYSICS as P } from '../src/sim/constants';
import { Track } from '../src/sim/track';
import { generateLayout, presetTrack } from '../src/trackgen';

for (const name of process.argv.slice(2)) {
  const t0 = performance.now();
  const [, seed, variant] = name.split(':');
  const track = name.startsWith('oval:') ? new Track(generateLayout({ type: 'oval', seed: Number(seed), variant: variant || undefined })) : presetTrack(name);
  const built = performance.now() - t0;
  const { low, high } = ovalLines(track);
  const one = fastestLine(track);
  const outer = track.walls.find((w) => w.faces === 'in' && w.range === null)!;
  const closest = (line: RacingLine) => {
    let min = Infinity;
    for (let s = 0; s < track.length; s += 2) min = Math.min(min, lineAt(line, s).d - P.CAR_RADIUS - (track.edgeAt(outer.d as never, s) + outer.thickness / 2));
    return min;
  };
  console.log(`${name.padEnd(30)} progression ${JSON.stringify(track.layout.params.bankProgression ?? 'as designed')} (built ${(built / 1000).toFixed(1)} s): `
    + `low ${low.lapTime.toFixed(2)} s, high ${high.lapTime.toFixed(2)} s (${(100 * (high.lapTime / low.lapTime - 1)).toFixed(2)}%), high line's closest to the wall `
    + `${closest(high).toFixed(2)} m; one fastest line ${one.lapTime.toFixed(2)} s, its closest ${closest(one).toFixed(2)} m`);
}

/**
 * What would keep an oval's fastest line off the wall: the track's own levers, tried on the line optimizer. For each
 * track and variant, the one fastest line (the whole road) and the low and high halves (?lines=2): lap times, the
 * halves' cost against the whole-road line, and how close each comes to the outside wall. Variants change the road
 * near the wall, the way the optimizer sees it (surface grip and banking across the road):
 *   grip:W:g   the top W m of the road at g of the track's grip (marbles, dust up high)
 *   flat:W:f   the banking in the top W m falling to f of what it is there (a flatter top lane)
 *
 *   DOTGP_EXPERIMENT='?spec=cup&lines=2' npx tsx scripts/lineLevers.ts short,oval:894715320:short,speedway base grip:2:0.9 flat:3:0.5
 */
import { DRIVEN_GRIP, lineAt, racingLine, type RacingLine } from '../src/ai/racingLine';
import { PHYSICS as P, SURFACES } from '../src/sim/constants';
import { Track } from '../src/sim/track';
import { generateLayout, presetTrack } from '../src/trackgen';

const [trackList, ...variants] = process.argv.slice(2);
const surfaceAt = Track.prototype.surfaceAt, bankAt = Track.prototype.bankAt;
// The road's edges by sample (Track keeps them private).
const edges = (t: Track) => t as unknown as { edgeIn: Float64Array; edgeOut: Float64Array };
const fromWall = (t: Track, idx: number, d: number) => d - edges(t).edgeOut[idx];

for (const name of trackList.split(',')) {
  for (const v of variants.length ? variants : ['base']) {
    const [kind, w, f] = v.split(':');
    const W = Number(w), F = Number(f);
    Track.prototype.surfaceAt = surfaceAt;
    Track.prototype.bankAt = bankAt;
    if (kind === 'grip') {
      (SURFACES as Record<string, unknown>).marbles = { ...SURFACES.track, grip: F };
      Track.prototype.surfaceAt = function (this: Track, s, d, x, y) {
        const r = surfaceAt.call(this, s, d, x, y);
        return r === 'track' && fromWall(this, this.indexAt(s), d) < W ? ('marbles' as never) : r;
      };
    } else if (kind === 'flat') {
      Track.prototype.bankAt = function (this: Track, idx, d) {
        const b = bankAt.call(this, idx, d), u = fromWall(this, idx, d);
        return u >= W || d > edges(this).edgeIn[idx] ? b : b * (F + (1 - F) * Math.max(0, u) / W);
      };
    }
    const [, seed, variant] = name.split(':');
    const track = name.startsWith('oval:') ? new Track(generateLayout({ type: 'oval', seed: Number(seed), variant: variant || undefined })) : presetTrack(name);
    const outer = track.walls.find((x) => x.faces === 'in' && x.range === null)!;
    const closest = (line: RacingLine) => {
      let min = Infinity;
      for (let s = 0; s < track.length; s += 2) min = Math.min(min, lineAt(line, s).d - P.CAR_RADIUS - (track.edgeAt(outer.d as never, s) + outer.thickness / 2));
      return min;
    };
    const line = (half?: 'low' | 'high') => racingLine(track, { gripShare: DRIVEN_GRIP, ...(half ? { half } : {}) });
    const one = line(), low = line('low'), high = line('high');
    const pct = (l: RacingLine) => (100 * (l.lapTime / one.lapTime - 1)).toFixed(2);
    console.log(`${name.padEnd(22)} ${v.padEnd(12)} progression ${JSON.stringify(track.layout.params.bankProgression ?? '-')}: whole road ${one.lapTime.toFixed(2)} s, `
      + `${closest(one).toFixed(2)} m off the wall; low +${pct(low)}%, high +${pct(high)}% (${closest(high).toFixed(2)} m off)`);
  }
}

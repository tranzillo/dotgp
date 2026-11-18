import { DRIVEN_GRIP, racingLine } from '../ai/racingLine';
import { CUP_CAR } from '../sim/carSpec';
import { Track } from '../sim/track';
import type { TrackLayout } from '../sim/layout';
import type { OvalCorner, ShapedOvalParams } from './oval';

/**
 * Banking for two lines: how much steeper each corner banks at the top than at the bottom (its progression), chosen so
 * the fastest line in the inside half of the road (the low line) and in the outside half, off the wall (the high line)
 * lap alike, each corner's mean banking kept as designed. Progressive banking as the generator drew it (2-6 degrees,
 * the presets 2-4) put the one fastest line against the wall on the bigger ovals (the speedway's ran within 0.3 m of it
 * all the way round), and drivers couldn't hold it there (2026-10-28). Balanced, the speedway's two lines lap within
 * 0.3% with the high one 3 m off the wall. Where cars are flat out all the way round, banking can't move the lines:
 * the low one is quicker by its shorter distance, and the banking stays as designed.
 *
 * Laid for the Cup car (the ovals' car), so a track is the same whatever car races it; the lines are worked out
 * without their lap-time refinement (within about 0.1 s of the refined ones, 40-100 ms a pair).
 */
export function balanceBanking(p: ShapedOvalParams, build: (q: ShapedOvalParams) => TrackLayout): ShapedOvalParams {
  const mean = p.corners.map((c) => (c.bankInner + c.bankOuter) / 2);
  const withProgression = (deg: number): ShapedOvalParams => ({
    ...p,
    corners: p.corners.map((c, i): OvalCorner => {
      const half = ((deg * Math.PI) / 180 / 2) * (c.dogleg ? 0.5 : 1);
      return { ...c, bankInner: Math.max(0, mean[i] - half), bankOuter: Math.min(MAX_BANK, Math.max(0, mean[i] + half)) };
    }),
  });
  // The high line's lap against the low's (a share), at a progression.
  const gap = (deg: number): number => {
    // The road alone: the infield and its venue don't touch the lines, and lay out slowly (whole venues 2-15 s).
    const track = new Track(build({ ...withProgression(deg), infield: undefined }));
    const line = (half: 'low' | 'high') => racingLine(track, { half, refine: 0, gripShare: DRIVEN_GRIP, spec: CUP_CAR, radius: CUP_RADIUS }).lapTime;
    return line('high') / line('low') - 1;
  };
  // The high line gains on the low one steadily as the top banks steeper (the gap is close to a straight line in the
  // progression): a secant from two tries, then once more from the nearer of them.
  const a = { deg: 0, gap: gap(0) }, b = { deg: 4, gap: gap(4) };
  // Flat out all the way round (a superspeedway's restrictor-plate cars): banking doesn't move the gap, and the low
  // line wins on distance alone (the speedway class's 1.6%); the banking stays as designed.
  if (Math.abs(a.gap - b.gap) < 0.0005) return p;
  const root = (p: typeof a, q: typeof a) => clamp(p.gap === q.gap ? p.deg : p.deg - (p.gap * (q.deg - p.deg)) / (q.gap - p.gap));
  const first = { deg: root(a, b), gap: 0 };
  first.gap = gap(first.deg);
  const near = Math.abs(a.deg - first.deg) < Math.abs(b.deg - first.deg) ? a : b;
  const best = Math.abs(first.gap) < 0.001 ? first.deg : root(near, first);
  if (process.env.BALANCE_DEBUG) console.log(`radius ${p.corners[0].radius} corners ${p.corners.length} mean ${(mean[0] * 57.3).toFixed(1)}: 0:${(100 * a.gap).toFixed(2)}% 4:${(100 * b.gap).toFixed(2)}% ${first.deg.toFixed(2)}:${(100 * first.gap).toFixed(2)}% -> ${best.toFixed(2)}`);
  return withProgression(Math.round(best * 4) / 4);
}

/** The Cup car's half width (m; experiment.ts ?spec=cup). */
const CUP_RADIUS = 1;
/** The progressions it can choose (degrees steeper at the top), and the steepest banking anywhere. */
const clamp = (deg: number) => Math.max(-4, Math.min(12, deg));
const MAX_BANK = (39 * Math.PI) / 180;

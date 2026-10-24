import { describe, expect, it } from 'vitest';
import type { TrackLayout } from '../src/sim/layout';
import { Track } from '../src/sim/track';
import { presetLayout } from '../src/trackgen';
import { placeLayout } from '../src/trackgen/geometry';
import { hazardWalls } from '../src/trackgen/walls';

/** Two open tracks (no walls of their own), side by side with this much grass between their outer edges. */
function pair(gap: number): { all: TrackLayout[]; tracks: Track[] } {
  const open = (l: TrackLayout): TrackLayout => ({ ...l, walls: [], neighbours: undefined });
  const a = open(presetLayout('short'));
  const ta = new Track(a);
  const width = ta.extent.maxX - ta.extent.minX;
  const b = open(placeLayout({ ...presetLayout('short'), id: 'other' }, { x: width + gap, y: 0, angle: 0 }));
  const all = [a, b];
  return { all, tracks: all.map((l) => new Track(l)) };
}

describe('walls in the infield', () => {
  it('stand where a car running off one track would reach another, at that one\'s edge facing it', () => {
    const { all, tracks } = pair(25);
    const walls = hazardWalls(all, tracks);
    expect(walls[0].length).toBeGreaterThan(0);
    expect(walls[1].length).toBeGreaterThan(0);
    // Each on the side facing the other: the second's walls nearer the first, and off both tracks.
    const [first, second] = tracks;
    for (const w of walls[1]) {
      const [s0, s1] = w.range!;
      const [x, y] = second.toWorld((s0 + s1) / 2, second.edgeAt(w.d, (s0 + s1) / 2));
      expect(x).toBeLessThan((second.extent.minX + second.extent.maxX) / 2);
      const q = first.near(x, y, 200);
      expect(!q || q.d < first.outerEdgeAt(q.s)).toBe(true);
    }
  });

  it('leave open grass where nothing is in reach', () => {
    const { all, tracks } = pair(400);
    expect(hazardWalls(all, tracks).flat()).toEqual([]);
  });

  it('never stand where a track\'s own wall already stops the car', () => {
    const { all, tracks } = pair(25);
    // (The first with its outer wall back: its cars stop at it, so the second needs nothing against them.)
    const walled = [{ ...all[0], walls: presetLayout('short').walls }, all[1]];
    expect(hazardWalls(walled, [new Track({ ...walled[0], neighbours: undefined }), tracks[1]])[1]).toEqual([]);
  });
});

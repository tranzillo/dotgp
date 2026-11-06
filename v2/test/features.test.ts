import { describe, expect, it } from 'vitest';
import { brakingSpots, chicanes, corners } from '../src/sim/features';
import { Track } from '../src/sim/track';
import { generateLayout, hashSeed, presetTrack } from '../src/trackgen';

/** The generator's own chicanes: corner, short straight, corner, short straight, corner. */
function generatorChicanes(elements: Array<{ corner?: unknown; straight?: number }>): number {
  let n = 0;
  for (let i = 0; i + 4 < elements.length; i++) {
    if (elements[i].corner && elements[i + 2].corner && elements[i + 4].corner
      && (elements[i + 1].straight ?? Infinity) < 13 && (elements[i + 3].straight ?? Infinity) < 13) { n++; i += 4; }
  }
  return n;
}

describe('circuit features from geometry', () => {
  it('finds the chicanes the generator laid, and braking zones into tight corners', () => {
    let found = 0, laid = 0, spots = 0;
    for (let t = 0; t < 10; t++) {
      const variant = t % 2 ? 'gp' : 'club';
      const layout = generateLayout({ type: 'circuit', seed: hashSeed(77, `f${t}`), variant });
      const track = new Track(layout);
      found += chicanes(track).length;
      laid += generatorChicanes((layout.params as { elements: Array<{ corner?: unknown; straight?: number }> }).elements);
      for (const b of brakingSpots(track)) {
        expect(b.straight).toBeGreaterThanOrEqual(300);
        expect(b.corner.radius).toBeLessThanOrEqual(50);
        expect(Math.abs(b.corner.turn)).toBeGreaterThanOrEqual(Math.PI / 3);
        spots++;
      }
    }
    expect(found).toBe(laid);
    expect(laid).toBeGreaterThan(0);
    expect(spots).toBeGreaterThan(0);
  });

  it('reads an oval as two turns of 180 degrees, and no chicanes', () => {
    const track = presetTrack('speedway');
    const cs = corners(track);
    expect(cs).toHaveLength(2);
    for (const c of cs) expect(Math.abs(c.turn)).toBeCloseTo(Math.PI, 1);
    expect(chicanes(track)).toHaveLength(0);
  });
});

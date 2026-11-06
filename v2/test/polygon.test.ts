import { describe, expect, it } from 'vitest';
import { Rng } from '../src/ai/rng';
import type { RoadNetwork, TrackLayout } from '../src/sim/layout';
import { PolygonIndex } from '../src/sim/polygon';
import { RoadGraph } from '../src/sim/roads';
import { Track } from '../src/sim/track';
import { presetLayout } from '../src/trackgen';

const square = (x0: number, y0: number, size: number): Array<[number, number]> => [[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size]];

/** Even-odd over every edge of every ring: the slow, obviously right answer. */
function bruteForce(rings: Array<Array<[number, number]>>, x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length];
      if ((y0 > y) !== (y1 > y) && x < x0 + ((y - y0) * (x1 - x0)) / (y1 - y0)) inside = !inside;
    }
  }
  return inside;
}

describe('pavement areas', () => {
  it('tells inside from outside, holes included, as the brute force does', () => {
    const rng = new Rng(5);
    // A lumpy outline with two holes.
    const outer: Array<[number, number]> = Array.from({ length: 60 }, (_, k) => {
      const a = (k / 60) * 2 * Math.PI, r = 300 + 60 * Math.sin(5 * a) + 20 * rng.next();
      return [r * Math.cos(a), 0.6 * r * Math.sin(a)];
    });
    const rings = [outer, square(-100, -40, 60), square(80, 10, 50)];
    const index = new PolygonIndex(rings);
    for (let k = 0; k < 4000; k++) {
      const x = -420 + 840 * rng.next(), y = -260 + 520 * rng.next();
      expect(index.contains(x, y), `${x.toFixed(1)}, ${y.toFixed(1)}`).toBe(bruteForce(rings, x, y));
    }
    expect(index.contains(-70, -10)).toBe(false); // in a hole: grass
    expect(index.contains(0, 0)).toBe(true);
  });

  it('paves where a track has only grass, and leaves its holes grass', () => {
    const base = presetLayout('speedway');
    const t0 = new Track(base);
    const [cx, cy] = t0.toWorld(t0.length / 4, 150); // deep in the infield, behind turn 1-2
    const plate = { id: 'plate', surface: 'runoff' as const, shape: { kind: 'polygon' as const, rings: [square(cx - 50, cy - 50, 100), square(cx - 10, cy - 10, 20)] } };
    const layout: TrackLayout = { ...base, surfaces: [...base.surfaces.slice(0, 1), plate, ...base.surfaces.slice(1)] };
    const t = new Track(layout);
    const at = (x: number, y: number) => { const p = t.project(x, y); return t.surfaceAt(p.s, p.d, x, y); };
    expect(at(cx + 30, cy + 30)).toBe('runoff');
    expect(at(cx, cy)).toBe('grass'); // the island
    expect(at(cx + 80, cy + 80)).toBe('grass'); // off the plate
  });

  it('drives straight across a paved area between its nodes, but not across its grass', () => {
    const net = (holes: Array<Array<[number, number]>>): RoadNetwork => ({
      nodes: [
        { id: 'a', kind: 'apron', at: [10, 50] },
        { id: 'g', kind: 'garage', at: [190, 50] },
      ],
      roads: [],
      areas: [{ id: 'plate', rings: [square(0, 0, 200), ...holes] }],
    });
    expect(new RoadGraph(net([])).pathToGarage('a')).toEqual([[190, 50]]);
    // An island in the way: no straight line, and no road round it.
    expect(new RoadGraph(net([square(80, 20, 60)])).pathToGarage('a')).toBeNull();
  });
});

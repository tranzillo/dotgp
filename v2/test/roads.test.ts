import { describe, expect, it } from 'vitest';
import type { RoadNetwork, TrackLayout } from '../src/sim/layout';
import { RoadGraph } from '../src/sim/roads';
import { Track } from '../src/sim/track';
import { presetLayout, presetTrack } from '../src/trackgen';
import { validateLayout } from '../src/trackgen/validate';

describe('road networks', () => {
  it('describes the tracks that predate them the way wreckers always went', () => {
    for (const id of ['speedway', 'short', 'flat']) {
      const t = presetTrack(id);
      const lane = t.infield.escapeLanes[0];
      expect(t.roads.accesses.map((n) => n.id)).toEqual(['escape0', 'pit-entry']);
      // Escape lane: its own points after the first.
      expect(t.roads.pathToGarage('escape0')).toEqual(lane.points.slice(1));
      // Pit road: along its inner side into the garage.
      expect(t.roads.pathToGarage('pit-entry')).toEqual([
        t.toWorld(t.pit.wallStart - 10, t.pit.roadD - 2),
        t.toWorld(t.infield.garage.lot.s0 + 4, t.pit.roadD - 2),
      ]);
    }
  });

  it('finds the shortest way to a garage, keeping to one-way roads', () => {
    const net: RoadNetwork = {
      nodes: [
        { id: 'a', kind: 'apron', at: [0, 0] },
        { id: 'b', kind: 'junction', at: [100, 0] },
        { id: 'c', kind: 'junction', at: [0, 100] },
        { id: 'g', kind: 'garage', at: [100, 100] },
        { id: 'lost', kind: 'apron', at: [500, 500] },
      ],
      roads: [
        { id: 'ab', from: 'a', to: 'b', points: [[0, 0], [100, 0]], width: 8, grade: 'service' },
        { id: 'bg', from: 'b', to: 'g', points: [[100, 0], [100, 100]], width: 8, grade: 'service' },
        // Shorter, but only the other way.
        { id: 'ga', from: 'g', to: 'a', points: [[100, 100], [0, 0]], width: 8, grade: 'service', oneWay: true },
        { id: 'ac', from: 'a', to: 'c', points: [[0, 0], [0, 50], [0, 100]], width: 8, grade: 'service' },
        { id: 'cg', from: 'c', to: 'g', points: [[0, 100], [100, 100]], width: 8, grade: 'service' },
      ],
    };
    const g = new RoadGraph(net);
    // Both two-road ways are 200 m; the one-way diagonal can't be taken from a.
    const path = g.pathToGarage('a')!;
    expect(path[path.length - 1]).toEqual([100, 100]);
    expect(path.length === 2 || path.length === 3).toBe(true);
    // Reversed roads are driven end to start: from b, back over ab is longer than bg.
    expect(g.pathToGarage('b')).toEqual([[100, 100]]);
    expect(g.pathToGarage('lost')).toBeNull();
    // Make the c side shorter and it's taken.
    net.roads[3].points = [[0, 0], [0, 40]];
    net.nodes[2].at = [0, 40];
    net.roads[4].points = [[0, 40], [100, 100]];
    expect(new RoadGraph(net).pathToGarage('a')).toEqual([[0, 40], [100, 100]]);
  });

  it('rejects a network whose ways off the oval go nowhere', () => {
    const base = presetLayout('short');
    const t = presetTrack('short');
    const entry = t.toWorld(t.pit.entryStart, t.apronEdgeAt(t.pit.entryStart) - 2);
    const layout: TrackLayout = {
      ...base,
      infield: {
        ...base.infield,
        network: {
          nodes: [{ id: 'pit-entry', kind: 'apron', at: entry, s: t.pit.entryStart }, { id: 'yard', kind: 'junction', at: [0, 0] }],
          roads: [{ id: 'dead-end', from: 'pit-entry', to: 'yard', points: [entry, [0, 0]], width: 8, grade: 'service' }],
        },
      },
    };
    const errors = validateLayout(layout, new Track(layout)).filter((p) => p.severity === 'error').map((p) => p.message);
    expect(errors).toContain("access pit-entry doesn't lead to a garage");
  });
});

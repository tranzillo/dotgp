import type { Road, RoadNetwork, RoadNode } from './layout';
import { PolygonIndex } from './polygon';
import type { Track } from './track';

/**
 * The infield's road network at run time: who can get where, and by which
 * roads. Wreckers tow to the garage along it (and later the pace car stages
 * on it, and road layouts are routed through it).
 */
export class RoadGraph {
  readonly nodes: ReadonlyMap<string, RoadNode>;
  readonly roads: readonly Road[];
  /** Roads out of each node, each with the node it leads to and which way it's driven. */
  private readonly out = new Map<string, Array<{ road: Road; to: string; forward: boolean; length: number }>>();

  constructor(network: RoadNetwork) {
    this.nodes = new Map(network.nodes.map((n) => [n.id, n]));
    this.roads = network.roads;
    for (const n of network.nodes) this.out.set(n.id, []);
    for (const road of network.roads) {
      const length = polylineLength(road.points);
      this.out.get(road.from)?.push({ road, to: road.to, forward: true, length });
      if (!road.oneWay) this.out.get(road.to)?.push({ road, to: road.from, forward: false, length });
    }
    // Straight across a paved area between any two of its nodes, where the line stays on it.
    for (const area of network.areas ?? []) {
      const index = new PolygonIndex(area.rings);
      const on = network.nodes.filter((n) => index.contains(n.at[0], n.at[1]));
      for (let a = 0; a < on.length; a++) {
        for (let b = a + 1; b < on.length; b++) {
          const p = on[a].at, q = on[b].at;
          const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
          const steps = Math.ceil(length / 4);
          let clear = true;
          for (let k = 1; k < steps && clear; k++) clear = index.contains(p[0] + ((q[0] - p[0]) * k) / steps, p[1] + ((q[1] - p[1]) * k) / steps);
          if (!clear) continue;
          const road: Road = { id: `${area.id}:${on[a].id}-${on[b].id}`, from: on[a].id, to: on[b].id, points: [p, q], width: 8, grade: 'service' };
          this.out.get(on[a].id)!.push({ road, to: on[b].id, forward: true, length });
          this.out.get(on[b].id)!.push({ road, to: on[a].id, forward: false, length });
        }
      }
    }
  }

  /** Ways off the oval: where a road leaves the apron (not one that only joins it, like pit exit), in network order. */
  get accesses(): RoadNode[] {
    return [...this.nodes.values()].filter((n) => n.kind === 'apron' && (this.out.get(n.id)?.length ?? 0) > 0);
  }

  /**
   * The shortest way from a node to a garage: the world points to drive
   * through after the node itself, in order. Null if no garage can be reached.
   */
  pathToGarage(from: string): Array<[number, number]> | null {
    const legs = this.shortest(from, (n) => n.kind === 'garage');
    if (!legs) return null;
    const points: Array<[number, number]> = [];
    for (const { road, forward } of legs) {
      const pts = forward ? road.points : [...road.points].reverse();
      points.push(...pts.slice(1));
    }
    return points;
  }

  /** Dijkstra from a node to the nearest node that is a goal: the roads driven, in order. */
  private shortest(from: string, goal: (n: RoadNode) => boolean): Array<{ road: Road; forward: boolean }> | null {
    const dist = new Map<string, number>([[from, 0]]);
    const prev = new Map<string, { node: string; road: Road; forward: boolean }>();
    const done = new Set<string>();
    for (;;) {
      let here: string | null = null;
      for (const [id, d] of dist) if (!done.has(id) && (here === null || d < dist.get(here)!)) here = id;
      if (here === null) return null;
      const node = this.nodes.get(here);
      if (node && here !== from && goal(node)) {
        const legs: Array<{ road: Road; forward: boolean }> = [];
        for (let at = here; at !== from;) {
          const p = prev.get(at)!;
          legs.unshift({ road: p.road, forward: p.forward });
          at = p.node;
        }
        return legs;
      }
      done.add(here);
      for (const e of this.out.get(here) ?? []) {
        const d = dist.get(here)! + e.length;
        if (d < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, d);
          prev.set(e.to, { node: here, road: e.road, forward: e.forward });
        }
      }
    }
  }
}

function polylineLength(pts: Array<[number, number]>): number {
  let len = 0;
  for (let i = 0; i + 1 < pts.length; i++) len += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return len;
}

/**
 * The network of a layout that doesn't describe one (every track before
 * networks, and saved replays of them): each escape lane from the apron to
 * the garage, and pit road (in at its entry, along its inner side, into the
 * garage), exactly the way wreckers have always gone.
 */
export function legacyNetwork(t: Track): RoadNetwork {
  const nodes: RoadNode[] = [];
  const roads: Road[] = [];
  t.infield.escapeLanes.forEach((lane, k) => {
    const first = lane.points[0], last = lane.points[lane.points.length - 1];
    nodes.push({ id: `escape${k}`, kind: 'apron', at: first, s: t.signedS(t.project(first[0], first[1]).s) });
    nodes.push({ id: `garage-escape${k}`, kind: 'garage', at: last });
    roads.push({ id: `escape${k}`, from: `escape${k}`, to: `garage-escape${k}`, points: lane.points, width: lane.width, grade: 'escape' });
  });
  const pit = t.pit;
  const lane = pit.roadD - 2;
  const entry = t.toWorld(pit.entryStart, t.apronEdgeAt(pit.entryStart) - 2);
  const along = t.toWorld(pit.wallStart - 10, lane);
  const lot = t.toWorld(t.infield.garage.lot.s0 + 4, lane);
  nodes.push({ id: 'pit-entry', kind: 'apron', at: entry, s: t.signedS(pit.entryStart) }, { id: 'garage-pit', kind: 'garage', at: lot });
  roads.push({
    id: 'pit-tow', from: 'pit-entry', to: 'garage-pit', points: [entry, along, lot],
    width: pit.roadD - pit.wallD - pit.wallThickness / 2, grade: 'pit',
  });
  return { nodes, roads };
}

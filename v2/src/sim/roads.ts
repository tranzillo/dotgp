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
    const { prev, reached } = this.search(new Map([[from, 0]]), (id, n) => id !== from && goal(n));
    if (reached === null) return null;
    const legs: Array<{ road: Road; forward: boolean }> = [];
    for (let at = reached; at !== from;) {
      const p = prev.get(at)!;
      legs.unshift({ road: p.road, forward: p.forward });
      at = p.node;
    }
    return legs;
  }

  /** Dijkstra from seed nodes (each with the distance already run to it), until a goal node is settled, or every node. */
  private search(seeds: Map<string, number>, goal?: (id: string, n: RoadNode) => boolean) {
    const dist = new Map(seeds);
    const prev = new Map<string, { node: string; road: Road; forward: boolean }>();
    const done = new Set<string>();
    for (;;) {
      let here: string | null = null;
      for (const [id, d] of dist) if (!done.has(id) && (here === null || d < dist.get(here)!)) here = id;
      if (here === null) return { dist, prev, reached: null };
      const node = this.nodes.get(here);
      if (goal && node && goal(here, node)) return { dist, prev, reached: here };
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

  /** The nearest point on any road (the paved areas' straight ways across too) to a world point. */
  private nearestRoad(x: number, y: number): RoadPoint | null {
    let best: RoadPoint | null = null;
    const seen = new Set<Road>();
    for (const edges of this.out.values()) {
      for (const { road } of edges) {
        if (seen.has(road)) continue;
        seen.add(road);
        const pts = road.points;
        for (let k = 0; k + 1 < pts.length; k++) {
          const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
          const vx = bx - ax, vy = by - ay;
          const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy || 1)));
          const px = ax + vx * t, py = ay + vy * t;
          const off = Math.hypot(x - px, y - py);
          if (!best || off < best.off) best = { road, seg: k, t, at: [px, py], off };
        }
      }
    }
    return best;
  }

  /**
   * The ways by road from a world point (a vehicle wherever it is): onto the
   * nearest road, along it whichever way it may be driven, then the network.
   */
  from(x: number, y: number): RoadsFrom {
    const near = this.nearestRoad(x, y);
    const seeds = new Map<string, number>();
    const lead = new Map<string, Array<[number, number]>>();
    if (near) {
      const pts = near.road.points;
      const seed = (node: string, way: Array<[number, number]>) => {
        const d = near.off + polylineLength(way);
        if (d < (seeds.get(node) ?? Infinity)) { seeds.set(node, d); lead.set(node, [[x, y], ...merged(way)]); }
      };
      seed(near.road.to, [near.at, ...pts.slice(near.seg + 1)]);
      if (!near.road.oneWay) seed(near.road.from, [near.at, ...pts.slice(0, near.seg + 1).reverse()]);
    }
    return this.routes(seeds, lead, near, x, y);
  }

  /** The ways by road from a node (where a road leaves the apron, say). */
  fromNode(id: string): RoadsFrom {
    const at = this.nodes.get(id)!.at;
    return this.routes(new Map([[id, 0]]), new Map([[id, [at]]]), null, at[0], at[1]);
  }

  private routes(
    seeds: Map<string, number>, lead: Map<string, Array<[number, number]>>, near: RoadPoint | null, x: number, y: number,
  ): RoadsFrom {
    const { dist, prev } = this.search(seeds);
    const path = (node: string): Array<[number, number]> | null => {
      if (!dist.has(node)) return null;
      const legs: Array<{ road: Road; forward: boolean }> = [];
      let at = node;
      for (let p = prev.get(at); p; p = prev.get(at)) {
        legs.unshift({ road: p.road, forward: p.forward });
        at = p.node;
      }
      const points = [...lead.get(at)!];
      for (const { road, forward } of legs) points.push(...(forward ? road.points : [...road.points].reverse()).slice(1));
      return points;
    };
    const to = (tx: number, ty: number) => {
      const end = this.nearestRoad(tx, ty);
      // Nothing but grass between them: straight across (weighed as the detour it is: the road is much quicker).
      const options: Array<{ points: Array<[number, number]>; length: number }> = [
        { points: [[x, y], [tx, ty]], length: Math.hypot(tx - x, ty - y) * GRASS_DETOUR },
      ];
      if (end) {
        const pts = end.road.points;
        const via = (node: string, tail: Array<[number, number]>) => {
          const head = path(node);
          if (head) options.push({ points: [...head, ...merged([...tail].reverse()).reverse().slice(1), [tx, ty]], length: dist.get(node)! + polylineLength(tail) + end.off });
        };
        via(end.road.from, [...pts.slice(0, end.seg + 1), end.at]);
        if (!end.road.oneWay) via(end.road.to, [...pts.slice(end.seg + 1).reverse(), end.at]);
        // Along the one road both are on, where it can be driven that way.
        if (near && near.road === end.road) {
          const ahead = end.seg > near.seg || (end.seg === near.seg && end.t >= near.t);
          if (ahead || !end.road.oneWay) {
            const mid = ahead ? pts.slice(near.seg + 1, end.seg + 1) : pts.slice(end.seg + 1, near.seg + 1).reverse();
            const way: Array<[number, number]> = [[x, y], near.at, ...mid, end.at, [tx, ty]];
            options.push({ points: way, length: polylineLength(way) });
          }
        }
      }
      return options.reduce((a, b) => (b.length < a.length ? b : a));
    };
    return { dist, path, to };
  }
}

/**
 * A way along a road from a point beside it, joining it a little way along
 * (MERGE metres) instead of at the point nearest: off the road (a truck's
 * post, a bay) onto it on a slant, not a hop across and a square turn.
 */
function merged(way: Array<[number, number]>): Array<[number, number]> {
  let run = 0, k = 0;
  for (; k < way.length - 1 && run < MERGE; k++) run += Math.hypot(way[k + 1][0] - way[k][0], way[k + 1][1] - way[k][1]);
  return way.slice(k);
}
const MERGE = 10;

/** Straight across the grass counts this many times its length against going by road. */
const GRASS_DETOUR = 3;

interface RoadPoint { road: Road; seg: number; t: number; at: [number, number]; off: number }

/** Where a vehicle can get by road from a point (RoadGraph.from). */
export interface RoadsFrom {
  /** Metres by road to each node it can reach. */
  dist: ReadonlyMap<string, number>;
  /** The points to drive through to a node, the point itself first; null if it can't be reached. */
  path: (node: string) => Array<[number, number]> | null;
  /** The quickest way to any world point, and how long it is. */
  to: (x: number, y: number) => { points: Array<[number, number]>; length: number };
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

/** The length of a world polyline (m). */
export function pathLength(pts: Array<[number, number]>): number {
  return polylineLength(pts);
}

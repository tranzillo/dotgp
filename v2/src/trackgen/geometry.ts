import type { Placement, TrackLayout } from '../sim/layout';
import { Track } from '../sim/track';

/** Geometry shared by the venue builders (complex.ts) and infield generation (infield.ts). */

/** Grass a ring's features keep between them and another ring's (m). */
export const CLEARANCE = 20;

/** A layout moved into its venue's frame: the placement, and every world position it holds with it. */
export function placeLayout(layout: TrackLayout, placement: Placement): TrackLayout {
  const c = Math.cos(placement.angle), s = Math.sin(placement.angle);
  const at = ([x, y]: [number, number]): [number, number] => [placement.x + c * x - s * y, placement.y + s * x + c * y];
  return {
    ...layout,
    placement,
    surfaces: layout.surfaces.map((r) => (r.shape.kind === 'path' ? { ...r, shape: { ...r.shape, points: r.shape.points.map(at) } }
      : r.shape.kind === 'polygon' ? { ...r, shape: { ...r.shape, rings: r.shape.rings.map((ring) => ring.map(at)) } } : r)),
    ...(layout.barriers ? { barriers: layout.barriers.map((b) => ({ ...b, points: b.points.map(at) })) } : {}),
    infield: {
      garage: { ...layout.infield.garage, parking: layout.infield.garage.parking.map(at) },
      escapeLanes: layout.infield.escapeLanes.map((e) => ({ ...e, points: e.points.map(at) })),
      ...(layout.infield.network ? {
        network: {
          nodes: layout.infield.network.nodes.map((n) => ({ ...n, at: at(n.at) })),
          roads: layout.infield.network.roads.map((r) => ({ ...r, points: r.points.map(at) })),
          ...(layout.infield.network.areas ? { areas: layout.infield.network.areas.map((a) => ({ ...a, rings: a.rings.map((ring) => ring.map(at)) })) } : {}),
        },
      } : {}),
    },
  };
}

export function densify(points: Array<[number, number]>, step: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, ay] = points[i], [bx, by] = points[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  out.push(points[points.length - 1]);
  return out;
}

/** Is a world point on (or within margin of) a track's pavement, the wall round it, its garage or its roads? */
export function occupies(t: Track, x: number, y: number, margin: number): boolean {
  const near = (pts: Array<[number, number]>, half: number) => pts.some(([px, py], i) => {
    if (i + 1 >= pts.length) return false;
    const [qx, qy] = pts[i + 1];
    const vx = qx - px, vy = qy - py;
    const u = Math.max(0, Math.min(1, ((x - px) * vx + (y - py) * vy) / (vx * vx + vy * vy || 1)));
    return Math.hypot(x - (px + vx * u), y - (py + vy * u)) <= half;
  });
  if (t.infield.escapeLanes.some((e) => near(e.points, e.width / 2 + margin))) return true;
  const q = t.near(x, y, t.reach + margin);
  if (!q) return false;
  if (q.d >= t.outerEdgeAt(q.s) - 1 - margin && q.d <= t.pavedInnerD(q.s) + margin) return true;
  const lot = t.infield.garage.lot;
  return t.inRange(q.s, [lot.s0 - margin, lot.s1 + margin]) && q.d >= lot.d0 - margin && q.d <= lot.d1 + margin;
}


/**
 * Every ring's features (outer wall, inner pavement edge, garage lot, escape
 * lane) keep CLEARANCE of grass from every other ring's: its pavement, the
 * wall round it, its garage and roads.
 */
export function validateVenue(layouts: TrackLayout[]): string[] {
  const tracks = layouts.map((l) => new Track(l));
  const problems: string[] = [];
  tracks.forEach((a) => {
    const features: Array<[string, Array<[number, number]>]> = [
      ['outer wall', sampleLap(a, (s) => a.outerEdgeAt(s) - 1)],
      ['infield edge', sampleLap(a, (s) => a.pavedInnerD(s))],
      ['garage', lotOutline(a)],
      ...a.infield.escapeLanes.map((e, k): [string, Array<[number, number]>] => [`escape lane ${k}`, densify(e.points, 5)]),
    ];
    tracks.forEach((b) => {
      if (a === b) return;
      for (const [what, points] of features) {
        if (points.some(([x, y]) => occupies(b, x, y, CLEARANCE))) {
          problems.push(`${a.name}'s ${what} is within ${CLEARANCE} m of ${b.name}`);
        }
      }
    });
  });
  return problems;
}

function sampleLap(t: Track, d: (s: number) => number, step = 10): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let s = 0; s < t.length; s += step) out.push(t.toWorld(s, d(s)));
  return out;
}

function lotOutline(t: Track): Array<[number, number]> {
  const lot = t.infield.garage.lot;
  const out: Array<[number, number]> = [];
  for (let s = lot.s0; s <= lot.s1; s += 10) out.push(t.toWorld(s, lot.d1));
  out.push(t.toWorld(lot.s0, lot.d0), t.toWorld(lot.s1, lot.d0));
  return out;
}


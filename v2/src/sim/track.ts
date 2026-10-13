import { Centerline } from './centerline';
import {
  evalEdge, evalProfile, type Edge, type Infield, type PitLane, type Surface, type SurfaceRegion, type TrackLayout, type Wall,
} from './layout';

export type { Surface, TrackRect } from './layout';
export type { Projection } from './centerline';

/** Pit lane as the sim uses it: the layout's pit plus derived world positions. */
export interface PitGeometry extends PitLane {
  /** World positions of the two pit wall ends (start, end). */
  wallEnds: Array<[number, number]>;
}

/** A solid wall end, as a circle in world space. */
export interface WallCap {
  x: number;
  y: number;
  radius: number;
}

/**
 * The runtime track: a centerline plus the features of a TrackLayout,
 * prepared for fast queries every physics step (surface, banking, walls).
 * Built from any layout; it knows nothing about how the layout was made.
 *
 * Track frame: s = distance along the centerline from the start/finish line,
 * d = lateral offset, positive to the LEFT of travel (toward the infield).
 * The racing surface runs from outerEdge (the outer wall's face on ovals) to
 * innerEdge, both of which can vary along the lap.
 */
export class Track extends Centerline {
  readonly layout: TrackLayout;
  readonly name: string;
  /**
   * Nominal half width (at the start line): a fixed scale for normalising
   * lateral distances. For where the surface actually ends, use the edges.
   */
  readonly halfWidth: number;
  /** Width of the paved apron inside the racing surface. */
  readonly apronWidth: number;
  readonly pit: PitGeometry;
  readonly infield: Infield;
  readonly walls: Wall[];
  readonly wallCaps: WallCap[];
  /** Surface regions, top first (the order surfaceAt checks them in). */
  private readonly regionsTopFirst: SurfaceRegion[];
  /** Racing surface edges per sample. */
  private readonly edgeIn: Float64Array;
  private readonly edgeOut: Float64Array;
  /** Banking per sample: inside and outside edge of the racing surface, and inside it. */
  private readonly bankIn: Float64Array;
  private readonly bankOut: Float64Array;
  private readonly bankInfield: Float64Array;
  readonly bounds: { minX: number; minY: number; maxX: number; maxY: number };

  constructor(layout: TrackLayout) {
    super(layout.centerline);
    this.layout = layout;
    this.name = layout.name;
    const cs = layout.crossSection;
    this.apronWidth = cs.apronWidth;

    const n = this.n;
    this.edgeIn = new Float64Array(n);
    this.edgeOut = new Float64Array(n);
    let reach = 0;
    for (let i = 0; i < n; i++) {
      const r = this.signedS(i * this.ds);
      this.edgeIn[i] = evalEdge(cs.edgeIn, r, this.length);
      this.edgeOut[i] = evalEdge(cs.edgeOut, r, this.length);
      reach = Math.max(reach, Math.abs(this.edgeIn[i]), Math.abs(this.edgeOut[i]));
    }
    this.halfWidth = (this.edgeIn[0] - this.edgeOut[0]) / 2;

    this.bankIn = new Float64Array(n);
    this.bankOut = new Float64Array(n);
    this.bankInfield = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const r = this.signedS(i * this.ds);
      this.bankIn[i] = evalProfile(cs.bankInner, r, this.length);
      this.bankOut[i] = evalProfile(cs.bankOuter, r, this.length);
      this.bankInfield[i] = evalProfile(cs.bankInfield, r, this.length);
    }

    const pit = layout.pit;
    this.pit = { ...pit, wallEnds: [this.toWorld(pit.wallStart, pit.wallD), this.toWorld(pit.wallEnd, pit.wallD)] };
    this.infield = layout.infield;
    this.walls = layout.walls;
    this.wallCaps = [];
    for (const w of layout.walls) {
      if (!w.caps || !w.range) continue;
      for (const s of w.range) {
        const [x, y] = this.toWorld(s, this.edgeAt(w.d, s));
        this.wallCaps.push({ x, y, radius: w.thickness / 2 });
      }
    }
    this.regionsTopFirst = [...layout.surfaces].reverse();

    const pad = reach + 4;
    const e = this.extent;
    this.bounds = { minX: e.minX - pad, maxX: e.maxX + pad, minY: e.minY - pad, maxY: e.maxY + pad };
  }

  /** Inside edge of the racing surface at a sample index. */
  innerEdge(idx: number): number {
    return this.edgeIn[idx];
  }

  /** Outside edge of the racing surface at a sample index. */
  outerEdge(idx: number): number {
    return this.edgeOut[idx];
  }

  innerEdgeAt(s: number): number {
    return this.edgeIn[this.indexAt(s)];
  }

  outerEdgeAt(s: number): number {
    return this.edgeOut[this.indexAt(s)];
  }

  /** Inner edge of the apron where nothing wider (pit road) is laid. */
  apronEdgeAt(s: number): number {
    return this.innerEdgeAt(s) + this.apronWidth;
  }

  /** Lateral position across the racing surface: -1 at the outside edge, +1 at the inside edge, beyond on the apron. */
  lanePosition(idx: number, d: number): number {
    const a = this.edgeIn[idx], b = this.edgeOut[idx];
    return (2 * d - (a + b)) / (a - b);
  }

  /** Inner edge of the paved surface: the apron, widened into pit road where there is one. */
  pavedInnerD(s: number): number {
    return evalEdge(this.layout.crossSection.pavedInner, this.signedS(s), this.length);
  }

  /** Value of an edge (constant or profile) at track position s. */
  edgeAt(edge: Edge, s: number): number {
    return evalEdge(edge, this.signedS(s), this.length);
  }

  /** True where the pit wall stands. */
  inPitWallZone(s: number): boolean {
    return this.inRange(s, [this.pit.wallStart, this.pit.wallEnd]);
  }

  /**
   * Surface at a track position: the topmost region containing it, else the
   * ground. Roads need the world position too (x, y); without it they are
   * skipped.
   */
  surfaceAt(s: number, d: number, x?: number, y?: number): Surface {
    for (const region of this.regionsTopFirst) {
      if (this.regionContains(region, s, d, x, y)) return region.surface;
    }
    return this.layout.ground;
  }

  private regionContains(region: SurfaceRegion, s: number, d: number, x?: number, y?: number): boolean {
    const shape = region.shape;
    switch (shape.kind) {
      case 'band':
        return this.inRange(s, shape.range)
          && (shape.openOut || d > this.edgeAt(shape.d0, s))
          && (shape.openIn || d <= this.edgeAt(shape.d1, s));
      case 'rect': {
        const r = shape.rect;
        return this.inRange(s, [r.s0, r.s1]) && d > r.d0 && d <= r.d1;
      }
      case 'path':
        return x !== undefined && y !== undefined && onPath(shape.points, shape.width / 2, x, y);
    }
  }

  /** Banking angle at a sample index and lateral offset. */
  bankAt(idx: number, d: number): number {
    const inner = this.edgeIn[idx];
    if (d > inner) return this.bankInfield[idx];
    const u = Math.min(1, Math.max(0, (inner - d) / (inner - this.edgeOut[idx])));
    return this.bankIn[idx] + (this.bankOut[idx] - this.bankIn[idx]) * u;
  }
}

function onPath(pts: Array<[number, number]>, half: number, x: number, y: number): boolean {
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const vx = bx - ax, vy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy)));
    if (Math.hypot(x - (ax + vx * t), y - (ay + vy * t)) <= half) return true;
  }
  return false;
}

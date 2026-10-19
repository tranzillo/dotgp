import { Centerline } from './centerline';
import { PolygonIndex } from './polygon';
import { legacyNetwork, RoadGraph } from './roads';
import {
  evalEdge, evalProfile, layoutKind, type Edge, type Infield, type LayoutKind, type PitLane, type Surface, type SurfaceRegion, type TrackLayout, type Wall,
} from './layout';

export type { Surface, TrackRect } from './layout';
export type { Projection } from './centerline';

/**
 * How far past the outside edge the racing surface carries on for physics
 * (beyond the wall face, where a car can't be) at a venue with other tracks:
 * past it is what's there (grass, another track), not more racing surface.
 */
const OPEN_BEYOND = 3;

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
  /** What kind of racing it's for (road layouts get drivers' road-course skill). */
  readonly kind: LayoutKind;
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
  /** Point tests for polygon regions, built when first needed. */
  private readonly polygons = new Map<SurfaceRegion, PolygonIndex>();
  /** Racing surface edges per sample. */
  private readonly edgeIn: Float64Array;
  private readonly edgeOut: Float64Array;
  /** How much further in the pit complex stands per sample (pit road on a chord); zeros if it doesn't. */
  private readonly pitOff: Float64Array;
  /** Banking per sample: inside and outside edge of the racing surface, and inside it. */
  private readonly bankIn: Float64Array;
  private readonly bankOut: Float64Array;
  private readonly bankInfield: Float64Array;
  readonly bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** Furthest anything of this track's own (surfaces, walls, garage) lies from its centerline (m). */
  readonly reach: number;
  /** The venue's other tracks: scenery here (drivable, solid walls, not raced). */
  readonly neighbours: Track[];
  /** Barriers laid in the world (a road layout's closures). */
  readonly barriers: Array<{ id: string; points: Array<[number, number]>; thickness: number }>;
  /** The infield's roads (escape roads, pit road, the garage...), as a graph. */
  readonly roads: RoadGraph;
  /** At a venue with other tracks (or one of them): surfaces end where they say, nothing runs on open past the wall. */
  private readonly bounded: boolean;

  /** scenery: built as another track's neighbour. */
  constructor(layout: TrackLayout, scenery = false) {
    super(layout.centerline, layout.placement);
    this.layout = layout;
    this.name = layout.name;
    this.kind = layoutKind(layout);
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
    this.pitOff = new Float64Array(n);
    if (pit.offset) for (let i = 0; i < n; i++) this.pitOff[i] = evalProfile(pit.offset, this.signedS(i * this.ds), this.length);
    this.pit = {
      ...pit,
      wallEnds: [this.toWorld(pit.wallStart, pit.wallD + this.pitOffset(pit.wallStart)), this.toWorld(pit.wallEnd, pit.wallD + this.pitOffset(pit.wallEnd))],
    };
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
    // Frame everything a layout puts down, barriers and run-off included.
    for (const w of layout.walls) {
      const values = typeof w.d === 'number' ? [w.d] : w.d.keys.map(([, v]) => v);
      for (const v of values) reach = Math.max(reach, Math.abs(v) + w.thickness / 2);
    }

    const pad = reach + 4;
    const e = this.extent;
    this.bounds = { minX: e.minX - pad, maxX: e.maxX + pad, minY: e.minY - pad, maxY: e.maxY + pad };
    const lot = layout.infield.garage.lot;
    this.reach = Math.max(pad, Math.abs(lot.d0), Math.abs(lot.d1), Math.abs(this.pit.roadD) + Math.max(0, ...this.pitOff)) + 2;
    this.neighbours = scenery ? [] : (layout.neighbours ?? []).map((nb) => new Track(nb, true));
    this.bounded = scenery || this.neighbours.length > 0;
    this.roads = new RoadGraph(layout.infield.network ?? legacyNetwork(this));
    this.barriers = layout.barriers ?? [];
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

  /** How much further in than its wallD, roadD and laneD the pit complex stands at s (pit road on a chord; else 0). */
  pitOffset(s: number): number {
    const f = this.wrapS(s) / this.ds, i = Math.floor(f) % this.n, t = f - Math.floor(f);
    return this.pitOff[i] + (this.pitOff[(i + 1) % this.n] - this.pitOff[i]) * t;
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
    let own = this.layout.ground;
    for (const region of this.regionsTopFirst) {
      if (this.regionContains(region, s, d, x, y)) { own = region.surface; break; }
    }
    // Where this track has nothing but grass, a neighbour may have pavement.
    if (own === 'grass' && x !== undefined && y !== undefined && this.neighbours.length) return this.sceneryAt(x, y) ?? own;
    return own;
  }

  /** What the venue's other tracks have at a world point, where it's more than grass. */
  private sceneryAt(x: number, y: number): Surface | null {
    for (const nb of this.neighbours) {
      if (x < nb.bounds.minX - nb.reach || x > nb.bounds.maxX + nb.reach || y < nb.bounds.minY - nb.reach || y > nb.bounds.maxY + nb.reach) continue;
      const q = nb.near(x, y, nb.reach);
      const surface = q ? nb.surfaceAt(q.s, q.d, x, y) : nb.roadAt(x, y);
      if (surface && surface !== 'grass') return surface;
    }
    return null;
  }

  /** The topmost road (world-space path) at a world point, if any. */
  roadAt(x: number, y: number): Surface | null {
    for (const region of this.regionsTopFirst) {
      const kind = region.shape.kind;
      if ((kind === 'path' || kind === 'polygon') && this.regionContains(region, 0, 0, x, y)) return region.surface;
    }
    return null;
  }

  private regionContains(region: SurfaceRegion, s: number, d: number, x?: number, y?: number): boolean {
    const shape = region.shape;
    switch (shape.kind) {
      case 'band':
        return this.inRange(s, shape.range)
          && (shape.openOut ? !this.bounded || d > this.edgeAt(shape.d0, s) - OPEN_BEYOND : d > this.edgeAt(shape.d0, s))
          && (shape.openIn || d <= this.edgeAt(shape.d1, s));
      case 'rect': {
        const r = shape.rect;
        return this.inRange(s, [r.s0, r.s1]) && d > r.d0 && d <= r.d1;
      }
      case 'path':
        return x !== undefined && y !== undefined && onPath(shape.points, shape.width / 2, x, y);
      case 'polygon': {
        if (x === undefined || y === undefined) return false;
        let index = this.polygons.get(region);
        if (!index) this.polygons.set(region, (index = new PolygonIndex(shape.rings)));
        return index.contains(x, y);
      }
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

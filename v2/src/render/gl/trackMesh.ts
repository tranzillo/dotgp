import { layoutKind, type Edge, type LineStyle, type Marking, type SRange, type SurfaceRegion, type TrackRect } from '../../sim/layout';
import type { Track } from '../../sim/track';
import { BANK_RAMP, BANK_SCALE_MAX, COLORS, deg, LINE_STYLES, OTHER_LAYOUT_ALPHA, SURFACE_COLORS } from '../view';
import { rgba, withAlpha, type RGBA } from './glutil';

/**
 * A venue as GPU geometry, in world metres, built once per track: the camera
 * only moves it. Read from the layout, knowing nothing about what kind of
 * track it is.
 *
 *   fill   triangles: surfaces, banking sheen, kerb blocks, buildings
 *   line   strips the vertex shader widens to their width on screen (a
 *          minimum in px, else metres): outlines, paint, walls, roads
 *   poly   areas of any shape (rings even-odd: an infield and its islands),
 *          filled exactly with the stencil buffer rather than triangulated
 */

/** Fill vertices: position (m), colour (straight alpha), pattern. */
export const FILL_LAYOUT: Array<[string, number]> = [['a_pos', 2], ['a_color', 4], ['a_pattern', 1]];
/**
 * Line vertices: centre (m); the way to widen it (unit, times the side and the
 * miter); width as [minimum px, metres, extra px] (screen px are CSS px);
 * dash as [metres along, on px, off px]; colour.
 */
export const LINE_LAYOUT: Array<[string, number]> = [['a_pos', 2], ['a_norm', 2], ['a_width', 3], ['a_dash', 3], ['a_color', 4]];
const FILL_FLOATS = 7;
const LINE_FLOATS = 14;

/** Fill patterns, drawn by the fill shader in world space. */
export const PATTERN_MOWING = 1;
export const PATTERN_PAINTED = 2;

/** Sample edges this often along the lap (m). */
const STEP = 1;
/** Banking is shaded from samples this far apart (m). */
const BANK_STEP = 2;

export type MeshItem =
  /** Triangles in the fill buffer (vertex range). */
  | { kind: 'fill'; first: number; count: number }
  /** An even-odd area: a fan to the stencil, then a cover (both ranges of the fill buffer). */
  | { kind: 'poly'; first: number; count: number; coverFirst: number; coverCount: number }
  /** Widened strips in the line buffer (vertex range). */
  | { kind: 'line'; first: number; count: number }
  /** Round ends on barriers (attenuators): centre, radius (m, at least 3 px). */
  | { kind: 'discs'; discs: Array<{ x: number; y: number; r: number; color: RGBA }> };

/** One of the venue's tracks: what goes under the tire marks, and what over them. */
export interface TrackPart {
  base: MeshItem[];
  lines: MeshItem[];
  /** A road course at a venue with ovals: only drawn off the ovals' pavement. */
  baseOffPavement: boolean;
  linesOffPavement: boolean;
}

export interface VenueMesh {
  fill: Float32Array;
  line: Float32Array;
  /** Triangles covering the ovals' pavement (fill range), for the stencil; null when nothing is kept off it. */
  pavement: { first: number; count: number } | null;
  /** Bottom to top. */
  parts: TrackPart[];
}

/** Banking shade: a heatmap (debug) or a sheen rising with the slope. */
function bankShade(rad: number, heatmap: boolean): RGBA {
  const d = deg(rad);
  if (!heatmap) return [1, 1, 1, Math.min(0.3, (0.3 * d) / 30)];
  const x = Math.min(BANK_SCALE_MAX, Math.max(0, d));
  let k = 0;
  while (k + 2 < BANK_RAMP.length && x > BANK_RAMP[k + 1][0]) k++;
  const [x0, c0] = BANK_RAMP[k], [x1, c1] = BANK_RAMP[k + 1];
  const t = Math.min(1, Math.max(0, (x - x0) / (x1 - x0)));
  return [0, 1, 2].map((i) => (c0[i] + (c1[i] - c0[i]) * t) / 255).concat(0.62) as RGBA;
}

interface LineStyleSpec {
  color: RGBA;
  /** CSS px at least, else metres; plus extra px. */
  minPx: number;
  metres: number;
  addPx: number;
  dash?: [number, number];
}

const paint = (style: LineStyle, alpha: number): LineStyleSpec => {
  const s = LINE_STYLES[style];
  return { color: withAlpha(rgba(s.color), alpha), minPx: s.width, metres: 0, addPx: 0, dash: s.dash as [number, number] | undefined };
};

class Builder {
  readonly fill: number[] = [];
  readonly line: number[] = [];
  /** Where items go. */
  list: MeshItem[] = [];
  track!: Track;

  private get fillCount(): number {
    return this.fill.length / FILL_FLOATS;
  }

  private get lineCount(): number {
    return this.line.length / LINE_FLOATS;
  }

  /** Add to the last item if it's of this kind and runs on into this range; else a new item. */
  private extend(kind: 'fill' | 'line', first: number, count: number): void {
    if (!count) return;
    const last = this.list[this.list.length - 1];
    if (last?.kind === kind && last.first + last.count === first) last.count += count;
    else this.list.push({ kind, first, count });
  }

  private vertex(x: number, y: number, c: RGBA, pattern: number): void {
    this.fill.push(x, y, c[0], c[1], c[2], c[3], pattern);
  }

  /** Lateral positions along s (signed metres), for an edge. */
  edge(d: Edge): (s: number) => number {
    return typeof d === 'number' ? () => d : (s) => this.track.edgeAt(d, s);
  }

  /** Evenly spaced s from s0 to s1, both ends included. */
  samples(s0: number, s1: number, step = STEP): number[] {
    const n = Math.max(1, Math.ceil((s1 - s0) / step));
    return Array.from({ length: n + 1 }, (_, k) => s0 + ((s1 - s0) * k) / n);
  }

  trace(s0: number, s1: number, d: (s: number) => number): Array<[number, number]> {
    return this.samples(s0, s1).map((s) => this.track.toWorld(s, d(s)));
  }

  /** Points along an edge over a range, or round the lap (closed). */
  along(range: SRange, d: Edge): { pts: Array<[number, number]>; closed: boolean } {
    const at = this.edge(d);
    if (range) return { pts: this.trace(range[0], range[1], at), closed: false };
    const pts = this.trace(0, this.track.length, at);
    pts.pop(); // (the lap's end is its start)
    return { pts, closed: true };
  }

  /** A band between two lateral edges along s, as triangles. */
  band(s0: number, s1: number, d0: (s: number) => number, d1: (s: number) => number, color: RGBA, pattern = 0, step = STEP): void {
    const first = this.fillCount;
    const ss = this.samples(s0, s1, step);
    let pa = this.track.toWorld(ss[0], d0(ss[0])), pb = this.track.toWorld(ss[0], d1(ss[0]));
    for (let k = 1; k < ss.length; k++) {
      const qa = this.track.toWorld(ss[k], d0(ss[k])), qb = this.track.toWorld(ss[k], d1(ss[k]));
      this.vertex(pa[0], pa[1], color, pattern); this.vertex(pb[0], pb[1], color, pattern); this.vertex(qa[0], qa[1], color, pattern);
      this.vertex(qa[0], qa[1], color, pattern); this.vertex(pb[0], pb[1], color, pattern); this.vertex(qb[0], qb[1], color, pattern);
      pa = qa; pb = qb;
    }
    this.extend('fill', first, this.fillCount - first);
  }

  /** Quads between rows of points with a colour at each (banking): skipped where all four corners are clear. */
  shaded(rows: Array<Array<{ p: [number, number]; c: RGBA }>>): void {
    const first = this.fillCount;
    for (let k = 1; k < rows.length; k++) {
      const a = rows[k - 1], b = rows[k];
      for (let j = 1; j < a.length; j++) {
        const q = [a[j - 1], a[j], b[j - 1], b[j]];
        if (q.every((v) => v.c[3] <= 0)) continue;
        for (const v of [q[0], q[1], q[2], q[2], q[1], q[3]]) this.vertex(v.p[0], v.p[1], v.c, 0);
      }
    }
    this.extend('fill', first, this.fillCount - first);
  }

  /** Rings (closed, world m) filled even-odd: a fan to the stencil from one corner, and a box to cover it. */
  poly(rings: Array<Array<[number, number]>>, color: RGBA, pattern = 0): void {
    const pts = rings.filter((r) => r.length >= 3);
    if (!pts.length) return;
    const first = this.fillCount;
    const [ax, ay] = pts[0][0];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of pts) {
      for (let i = 0; i < ring.length; i++) {
        const [px, py] = ring[i], [qx, qy] = ring[(i + 1) % ring.length];
        this.vertex(ax, ay, color, pattern); this.vertex(px, py, color, pattern); this.vertex(qx, qy, color, pattern);
        minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      }
    }
    const coverFirst = this.fillCount;
    for (const [x, y] of [[minX, minY], [maxX, minY], [minX, maxY], [minX, maxY], [maxX, minY], [maxX, maxY]]) this.vertex(x, y, color, pattern);
    this.list.push({ kind: 'poly', first, count: coverFirst - first, coverFirst, coverCount: 6 });
  }

  /** A polyline widened on screen: miter joins (limited), butt ends. */
  polyline(points: Array<[number, number]>, closed: boolean, st: LineStyleSpec): void {
    // Drop repeated points: a zero-length segment has no direction.
    const pts: Array<[number, number]> = [];
    for (const p of points) {
      const q = pts[pts.length - 1];
      if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) pts.push(p);
    }
    if (closed && pts.length > 2) {
      const [f, l] = [pts[0], pts[pts.length - 1]];
      if (Math.hypot(f[0] - l[0], f[1] - l[1]) <= 1e-6) pts.pop();
    }
    const n = pts.length;
    if (n < 2) return;
    // Unit normal (left) of each segment.
    const segs = closed ? n : n - 1;
    const nx: number[] = [], ny: number[] = [];
    for (let i = 0; i < segs; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % n];
      const m = Math.hypot(bx - ax, by - ay);
      nx.push(-(by - ay) / m); ny.push((bx - ax) / m);
    }
    // Per point: the joint's direction, lengthened to keep the width across the bend (to 4×).
    const jx: number[] = [], jy: number[] = [];
    for (let i = 0; i < n; i++) {
      const prev = closed ? (i - 1 + segs) % segs : Math.max(0, i - 1);
      const next = closed ? i % segs : Math.min(segs - 1, i);
      let x = nx[prev] + nx[next], y = ny[prev] + ny[next];
      const m = Math.hypot(x, y);
      if (m < 1e-6) { x = nx[next]; y = ny[next]; } else { x /= m; y /= m; }
      const miter = 1 / Math.max(0.25, x * nx[next] + y * ny[next]);
      jx.push(x * miter); jy.push(y * miter);
    }
    const first = this.lineCount;
    const c = st.color, [on, off] = st.dash ?? [0, 0];
    let along = 0;
    const v = (i: number, side: number, at: number) => {
      this.line.push(pts[i][0], pts[i][1], jx[i] * side, jy[i] * side, st.minPx, st.metres, st.addPx, at, on, off, c[0], c[1], c[2], c[3]);
    };
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const len = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
      v(i, 1, along); v(i, -1, along); v(j, 1, along + len);
      v(j, 1, along + len); v(i, -1, along); v(j, -1, along + len);
      along += len;
    }
    this.extend('line', first, this.lineCount - first);
  }

  /** Points round a track rect (its long sides follow the track). */
  rectRing(r: TrackRect): Array<[number, number]> {
    return [...this.trace(r.s0, r.s1, () => r.d0), ...this.trace(r.s0, r.s1, () => r.d1).reverse()];
  }

  // ---------- the layout ----------

  surface(region: SurfaceRegion): void {
    const shape = region.shape;
    const color = rgba(SURFACE_COLORS[region.surface]);
    const pattern = region.pattern === 'mowing' ? PATTERN_MOWING : region.pattern === 'painted' ? PATTERN_PAINTED : 0;
    const track = this.track;
    if (shape.kind === 'band') {
      if (shape.openIn) {
        // Everything inside the band's outer edge (the infield).
        this.poly([this.along(null, shape.d0).pts], color, pattern);
      } else {
        const [s0, s1] = shape.range ?? [0, track.length];
        this.band(s0, s1, this.edge(shape.d0), this.edge(shape.d1), color, pattern);
      }
      if (region.surface === 'kerb' && region.pattern !== 'kerbEnd') this.kerbStripes(shape.range, shape.d0, shape.d1);
    } else if (shape.kind === 'rect') {
      const r = shape.rect;
      this.band(r.s0, r.s1, () => r.d0, () => r.d1, color, pattern);
    } else if (shape.kind === 'polygon') {
      this.poly(shape.rings, color, pattern);
    } else {
      // A road: a polyline its width wide (3 px at least).
      this.polyline(shape.points, false, { color, minPx: 3, metres: shape.width, addPx: 0 });
    }
  }

  /** Red blocks across a kerb every other stretch, each the same length along the kerb itself. */
  kerbStripes(range: SRange, d0: Edge, d1: Edge): void {
    const track = this.track;
    const [s0, s1] = range ?? [0, track.length];
    const block = 3; // m, along the kerb
    const at0 = this.edge(d0), at1 = this.edge(d1);
    const along = (s: number) => block / Math.max(0.2, 1 - track.curvatureAt(s) * (at0(s) + at1(s)) / 2);
    const color = rgba(COLORS.kerbStripe);
    for (let s = s0; s < s1;) {
      const e = Math.min(s1, s + along(s));
      this.band(s, e, at0, at1, color);
      s = e + along(e); // (then a white block)
    }
  }

  /** The racing surface shaded across in slices (banking changes across it), then the apron and pit road. */
  banking(heatmap: boolean): void {
    const track = this.track;
    const SLICES = 6;
    const rows = this.samples(0, track.length, BANK_STEP).map((s) => {
      const i = track.indexAt(s);
      const out = track.outerEdgeAt(s), inn = track.innerEdgeAt(s);
      return Array.from({ length: SLICES + 1 }, (_, k) => {
        const d = out + ((inn - out) * k) / SLICES;
        return { p: track.toWorld(s, d), c: bankShade(track.bankAt(i, d), heatmap) };
      });
    });
    this.shaded(rows);
    this.shaded(this.samples(0, track.length, BANK_STEP).map((s) => {
      const i = track.indexAt(s);
      const c = bankShade(track.bankAt(i, track.innerEdgeAt(s) + 0.5), heatmap);
      return [{ p: track.toWorld(s, track.innerEdgeAt(s)), c }, { p: track.toWorld(s, track.pavedInnerD(s)), c }];
    }));
  }

  decoration(): void {
    const track = this.track;
    for (const deco of track.layout.decor) {
      const r = deco.rect;
      if (deco.kind === 'building') {
        this.band(r.s0, r.s1, () => r.d0, () => r.d1, rgba(COLORS.building));
        const mid = (r.d0 + r.d1) / 2;
        this.polyline([track.toWorld(r.s0 + 1, mid), track.toWorld(r.s1 - 1, mid)], false,
          { color: rgba(COLORS.buildingRoof), minPx: 1, metres: 1.5, addPx: 0 });
      } else {
        // Two rows of bays, lines `spacing` metres apart along each row's middle.
        const depth = r.d1 - r.d0;
        const row = Math.min(6, depth * 0.35);
        const style = { color: rgba(COLORS.paint), minPx: 0.5, metres: 0.15, addPx: 0 };
        for (const [a, b] of [[r.d0 + 1, r.d0 + 1 + row], [r.d1 - 1 - row, r.d1 - 1]]) {
          const mid = (a + b) / 2, fine = 0.1;
          let since = deco.spacing;
          let p = track.toWorld(r.s0 + 2, mid);
          for (let s = r.s0 + 2; s <= r.s1 - 2; s += fine) {
            const q = track.toWorld(s, mid);
            since += Math.hypot(q[0] - p[0], q[1] - p[1]);
            p = q;
            if (since < deco.spacing) continue;
            since = 0;
            this.polyline([track.toWorld(s, a), track.toWorld(s, b)], false, style);
          }
        }
      }
    }
  }

  /** A track's quiet edge line round a racing surface region. */
  outline(region: SurfaceRegion, alpha: number): void {
    const shape = region.shape;
    const st = paint('edge', alpha);
    if (shape.kind === 'band') {
      const a = this.along(shape.range, shape.d0);
      this.polyline(a.pts, a.closed, st);
      if (!shape.openIn) {
        const b = this.along(shape.range, shape.d1);
        this.polyline(b.pts, b.closed, st);
      }
    } else if (shape.kind === 'rect') {
      this.polyline(this.rectRing(shape.rect), true, st);
    } else if (shape.kind === 'polygon') {
      for (const ring of shape.rings) this.polyline(ring, true, st);
    } else {
      // A course road is another layout's racing surface: its edges faint too.
      const faint = paint('edge', alpha * OTHER_LAYOUT_ALPHA);
      const pts = shape.points;
      for (const side of [-1, 1]) {
        this.polyline(pts.map(([x, y], i) => {
          const [px0, py0] = pts[Math.max(0, i - 1)], [px1, py1] = pts[Math.min(pts.length - 1, i + 1)];
          const len = Math.hypot(px1 - px0, py1 - py0) || 1;
          return [x - ((py1 - py0) / len) * (shape.width / 2) * side, y + ((px1 - px0) / len) * (shape.width / 2) * side] as [number, number];
        }), false, faint);
      }
    }
  }

  marking(m: Marking, alpha: number): void {
    const st = paint(m.style, alpha);
    if (m.kind === 'line') {
      const a = this.along(m.range, m.d);
      this.polyline(a.pts, a.closed, st);
    } else {
      for (const s of m.s) this.polyline([this.track.toWorld(s, m.d0), this.track.toWorld(s, m.d1)], false, st);
    }
  }

  /** Outlines, paint, walls (dark edge, then white), attenuators, barriers, and the start line over them. */
  lines(alpha: number): void {
    const layout = this.track.layout;
    for (const region of layout.surfaces) {
      if (region.outline && region.surface === 'track') this.outline(region, alpha);
    }
    for (const m of layout.markings) if (m.style !== 'start') this.marking(m, alpha);
    // Barriers are solid whichever layout is raced: full strength. All the dark edges first, so where one runs on
    // from another the second's edge doesn't cut across the first.
    const shadow = rgba(COLORS.barrierShadow), white = rgba(COLORS.barrier);
    for (const [color, addPx] of [[shadow, 2], [white, 0]] as const) {
      for (const wall of layout.walls) {
        const a = this.along(wall.range, wall.d);
        this.polyline(a.pts, a.closed, { color, minPx: 3, metres: wall.thickness, addPx });
      }
    }
    const discs: Array<{ x: number; y: number; r: number; color: RGBA }> = [];
    for (const wall of layout.walls) {
      if (!wall.attenuators || !wall.range) continue;
      for (const s of wall.range) {
        const [x, y] = this.track.toWorld(s, this.track.edgeAt(wall.d, s));
        discs.push({ x, y, r: wall.thickness, color: rgba(COLORS.attenuator) });
      }
    }
    if (discs.length) this.list.push({ kind: 'discs', discs });
    for (const [color, addPx] of [[shadow, 2], [white, 0]] as const) {
      for (const b of layout.barriers ?? []) this.polyline(b.points, false, { color, minPx: 3, metres: b.thickness, addPx });
    }
    for (const m of layout.markings) if (m.style === 'start') this.marking(m, alpha);
  }

  /** The ovals' pavement, outer edge in to the inner edge of apron and pit road (fill range, no item). */
  pavement(ovals: Track[]): { first: number; count: number } {
    const was = this.list;
    this.list = [];
    const first = this.fillCount;
    for (const o of ovals) {
      this.track = o;
      this.band(0, o.length, (s) => o.outerEdgeAt(s), (s) => o.pavedInnerD(s), [0, 0, 0, 0]);
    }
    this.list = was;
    return { first, count: this.fillCount - first };
  }
}

/**
 * The venue around `own` (its other tracks too), bottom to top: the outermost
 * first, so each one inside paints over the infield of the one round it.
 * heatmap: banking as the debug heatmap rather than a sheen.
 */
export function buildVenueMesh(own: Track, heatmap: boolean): VenueMesh {
  const area = (t: Track) => (t.extent.maxX - t.extent.minX) * (t.extent.maxY - t.extent.minY);
  const tracks = [own, ...own.neighbours].sort((a, b) => area(b) - area(a));
  const b = new Builder();
  // An oval's pavement is the oval's: a road course's surfaces (and, as scenery, its lines) never show on it.
  const ovals = tracks.filter((t) => layoutKind(t.layout) !== 'road');
  const parts = tracks.map((t): TrackPart => {
    const road = ovals.length > 0 && layoutKind(t.layout) === 'road';
    const part: TrackPart = { base: [], lines: [], baseOffPavement: road, linesOffPavement: road && t !== own };
    b.track = t;
    b.list = part.base;
    for (const region of t.layout.surfaces) b.surface(region);
    b.banking(heatmap);
    b.decoration();
    // Every layout's lines are painted, as at a real track; the one being raced bright, the rest faint.
    b.list = part.lines;
    b.lines(t === own ? 1 : OTHER_LAYOUT_ALPHA);
    return part;
  });
  const clipped = parts.some((p) => p.baseOffPavement || p.linesOffPavement);
  const pavement = clipped ? b.pavement(ovals) : null;
  return { fill: Float32Array.from(b.fill), line: Float32Array.from(b.line), pavement, parts };
}

/**
 * What the renderer needs from a car: a sim Car, or a snapshot of one
 * streamed from an event worker.
 */
export interface RenderCar {
  id: number;
  x: number;
  y: number;
  dist: number;
  color: string;
  retired: boolean;
  cleared: boolean;
  towed: boolean;
  parked: boolean;
  inputX: number;
  inputY: number;
  frameX: number;
  frameY: number;
  trackIdx: number;
  tireLon: number;
  tireLat: number;
  bankAcc: number;
}

/** Officials on track: the pace car, and wreckers (phase 'done' once parked). */
export interface RenderOfficials {
  paceCar: { x: number; y: number } | null;
  wreckers: Array<{ x: number; y: number; phase: string }>;
}
import { G, PHYSICS as P } from '../sim/constants';
import type { Decoration, Edge, LineStyle, Marking, SRange, Surface, SurfaceRegion, TrackRect } from '../sim/layout';
import type { Track } from '../sim/track';
import { numberColor, PACE_CAR_LIVERY, type Livery } from './livery';
import { GROOVE_DISPLAY_ALPHA, GROOVE_STROKE_ALPHA, GROOVE_WIDTH, grooveChance, skidStroke, STROKE_FIELDS } from './marks';

const COLORS = {
  background: '#0d0d0f',
  surface: '#4a4a50',
  apron: '#3a3a3f',
  pitRoad: '#35353a',
  grass: '#1d3322',
  garageLot: '#333338',
  building: '#5b5b63',
  buildingRoof: '#6c6c75',
  road: '#38383d',
  grassStripe: '#213a27',
  /** Barriers: solid and bright, so they never read as a painted edge. */
  barrier: '#e4e4e4',
  barrierShadow: '#050506',
  attenuator: '#f5c518',
  /** Surface edges: a quiet line where asphalt meets grass or apron. */
  edge: 'rgba(255,255,255,0.22)',
  blendLine: 'rgba(255,255,255,0.85)',
  paint: 'rgba(255,255,255,0.55)',
  startLine: 'rgba(255,255,255,0.92)',
  rubber: '8,8,10',
  turf: '78,58,32',
};

const SURFACE_COLORS: Record<Surface, string> = {
  track: COLORS.surface,
  apron: COLORS.apron,
  pit: COLORS.pitRoad,
  garage: COLORS.garageLot,
  road: COLORS.road,
  grass: COLORS.grass,
};

/** Painted lines: colour, width in CSS pixels, dash pattern in CSS pixels. */
const LINE_STYLES: Record<LineStyle, { color: string; width: number; dash?: number[] }> = {
  edge: { color: COLORS.edge, width: 1 },
  blend: { color: COLORS.blendLine, width: 1.5 },
  entry: { color: COLORS.blendLine, width: 1.5, dash: [8, 6] },
  lane: { color: COLORS.paint, width: 1, dash: [6, 6] },
  stall: { color: COLORS.paint, width: 1 },
  start: { color: COLORS.startLine, width: 2 },
};

/** What a decoration painter gets to draw with. */
interface DecorView {
  ctx: CanvasRenderingContext2D;
  /** Canvas pixels per metre. */
  scale: number;
  toScreen(s: number, d: number): [number, number];
  rectPath(r: TrackRect): void;
}

/** One painter per decoration kind: a new kind in the layout needs its painter here (the compiler insists). */
const DECOR_PAINTERS: { [K in Decoration['kind']]: (v: DecorView, deco: Extract<Decoration, { kind: K }>) => void } = {
  building(v, { rect }) {
    v.rectPath(rect);
    v.ctx.fillStyle = COLORS.building;
    v.ctx.fill();
    // Roof ridge along the building's length.
    const mid = (rect.d0 + rect.d1) / 2;
    const [ax, ay] = v.toScreen(rect.s0 + 1, mid);
    const [bx, by] = v.toScreen(rect.s1 - 1, mid);
    v.ctx.beginPath();
    v.ctx.moveTo(ax, ay);
    v.ctx.lineTo(bx, by);
    v.ctx.strokeStyle = COLORS.buildingRoof;
    v.ctx.lineWidth = Math.max(1, 1.5 * v.scale);
    v.ctx.stroke();
  },
};

function paintDecoration(v: DecorView, deco: Decoration): void {
  (DECOR_PAINTERS[deco.kind] as (v: DecorView, deco: Decoration) => void)(v, deco);
}

/** Debug overlays the viewer can switch on. */
export interface DebugLayers {
  /** Each driver's acceleration request. */
  inputs: boolean;
  /** Forces on each car: the banking's push toward the infield, and the tires' force. */
  forces: boolean;
  /** Banking heatmap, inside-to-outside angle labels, legend. */
  banking: boolean;
}

const deg = (rad: number) => (rad * 180) / Math.PI;
/** Top of the banking colour scale (deg). */
const BANK_SCALE_MAX = 32;
const BANK_RAMP: Array<[number, [number, number, number]]> = [
  [0, [43, 74, 107]], [8, [47, 143, 131]], [16, [201, 176, 58]], [24, [217, 130, 43]], [32, [192, 57, 43]],
];

/** Heatmap colour for a banking angle (deg). */
export function bankColor(degrees: number, alpha = 1): string {
  const x = Math.min(BANK_SCALE_MAX, Math.max(0, degrees));
  let k = 0;
  while (k + 2 < BANK_RAMP.length && x > BANK_RAMP[k + 1][0]) k++;
  const [x0, c0] = BANK_RAMP[k], [x1, c1] = BANK_RAMP[k + 1];
  const t = Math.min(1, Math.max(0, (x - x0) / (x1 - x0)));
  const c = c0.map((v, i) => Math.round(v + (c1[i] - v) * t));
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

/** Resolution of the tire-mark layer, in pixels per metre of track. */
const MARK_RES = 3;

/** 'real' draws cars at true size; 'legible' enforces a minimum size so numbers fit. */
export type DotMode = 'real' | 'legible';

/**
 * Three layers: track fill and track lines (screen resolution, redrawn when
 * the camera moves) with tire marks between them. Marks (groove and skids,
 * see marks.ts) live at a fixed world resolution, so they survive resizes and
 * zooms; they are stamped and never redrawn, so the track accumulates a live
 * record of the lines being raced.
 */
export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly base = document.createElement('canvas');
  private readonly lines = document.createElement('canvas');
  private readonly groove = document.createElement('canvas');
  private readonly grooveCtx: CanvasRenderingContext2D;
  private readonly marks = document.createElement('canvas');
  private readonly marksCtx: CanvasRenderingContext2D;
  private track: Track | null = null;
  private fitScale = 1;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private dpr = 1;
  private zoom = 1;
  private focusX = 0;
  private focusY = 0;
  private trackDirty = true;
  private debugLayers: DebugLayers = { inputs: true, forces: false, banking: false };
  dotMode: DotMode = 'legible';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.grooveCtx = this.groove.getContext('2d')!;
    this.marksCtx = this.marks.getContext('2d')!;
  }

  get debug(): Readonly<DebugLayers> {
    return this.debugLayers;
  }

  setDebug(layer: keyof DebugLayers, on: boolean): void {
    this.debugLayers[layer] = on;
    if (layer === 'banking') this.trackDirty = true;
  }

  setTrack(track: Track): void {
    this.track = track;
    const b = track.bounds;
    for (const c of [this.groove, this.marks]) {
      c.width = Math.ceil((b.maxX - b.minX) * MARK_RES);
      c.height = Math.ceil((b.maxY - b.minY) * MARK_RES);
    }
    this.clearMarks();
    this.resize();
  }

  resize(): void {
    const track = this.track;
    if (!track) return;
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * this.dpr));
    const h = Math.max(1, Math.round(rect.height * this.dpr));
    for (const c of [this.canvas, this.base, this.lines]) {
      c.width = w;
      c.height = h;
    }
    const b = track.bounds;
    const pad = 24 * this.dpr;
    this.fitScale = Math.min((w - 2 * pad) / (b.maxX - b.minX), (h - 2 * pad) / (b.maxY - b.minY));
    this.updateTransform();
  }

  /**
   * Camera. zoom 1 frames the whole track; above 1 the view centres on
   * (x, y) in world metres, typically a followed car.
   */
  setView(zoom: number, x: number, y: number): void {
    this.zoom = zoom;
    this.focusX = x;
    this.focusY = y;
    this.updateTransform();
  }

  private updateTransform(): void {
    const track = this.track;
    if (!track) return;
    const b = track.bounds;
    const cx = this.zoom > 1 ? this.focusX : (b.minX + b.maxX) / 2;
    const cy = this.zoom > 1 ? this.focusY : (b.minY + b.maxY) / 2;
    const scale = this.fitScale * this.zoom;
    const offsetX = this.canvas.width / 2 - cx * scale;
    const offsetY = this.canvas.height / 2 + cy * scale;
    if (scale !== this.scale || offsetX !== this.offsetX || offsetY !== this.offsetY) {
      this.scale = scale;
      this.offsetX = offsetX;
      this.offsetY = offsetY;
      this.trackDirty = true;
    }
  }

  /** World (y up) to canvas pixels (y down). */
  private toScreen(x: number, y: number): [number, number] {
    return [this.offsetX + x * this.scale, this.offsetY - y * this.scale];
  }

  /** World (y up) to mark-layer pixels. */
  private toMarks(x: number, y: number): [number, number] {
    const b = this.track!.bounds;
    return [(x - b.minX) * MARK_RES, (b.maxY - y) * MARK_RES];
  }

  /** Trace d = dAt(s) for s in [s0, s1] (signed metres from the line), backwards if reverse. */
  private trace(ctx: CanvasRenderingContext2D, s0: number, s1: number, dAt: (s: number) => number, move = true, reverse = false): void {
    const track = this.track!;
    const step = (this.zoom > 2 ? 1 : 2) * track.ds * 2;
    const n = Math.max(1, Math.ceil((s1 - s0) / step));
    for (let k = 0; k <= n; k++) {
      const sc = reverse ? Math.max(s0, s1 - k * step) : Math.min(s1, s0 + k * step);
      const [x, y] = this.toScreen(...track.toWorld(sc, dAt(sc)));
      if (move && k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  }

  private ring(ctx: CanvasRenderingContext2D, dAt: (s: number) => number): void {
    this.trace(ctx, 0, this.track!.length, dAt);
    ctx.closePath();
  }

  /** Trace an edge along a range (or round the whole lap). */
  private along(ctx: CanvasRenderingContext2D, range: SRange, d: Edge): void {
    const at = this.edgeFn(d);
    if (range) this.trace(ctx, range[0], range[1], at);
    else this.ring(ctx, at);
  }

  private edgeFn(d: Edge): (s: number) => number {
    const track = this.track!;
    return typeof d === 'number' ? () => d : (s) => track.edgeAt(d, s);
  }

  private rectPath(ctx: CanvasRenderingContext2D, r: TrackRect): void {
    const track = this.track!;
    ctx.beginPath();
    [[r.s0, r.d0], [r.s1, r.d0], [r.s1, r.d1], [r.s0, r.d1]].forEach(([sv, dv], i) => {
      const [x, y] = this.toScreen(...track.toWorld(sv, dv));
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
  }

  private polyline(ctx: CanvasRenderingContext2D, pts: Array<[number, number]>): void {
    ctx.beginPath();
    pts.forEach(([x, y], i) => {
      const [sx, sy] = this.toScreen(x, y);
      if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    });
  }

  /** Fill a surface region (and its pattern) on the base layer. */
  private paintRegion(ctx: CanvasRenderingContext2D, region: SurfaceRegion): void {
    const shape = region.shape;
    const color = SURFACE_COLORS[region.surface];
    let rule: CanvasFillRule = 'nonzero';
    ctx.beginPath();
    if (shape.kind === 'band') {
      if (shape.openIn) {
        // Everything inside the band's outer edge (the infield).
        this.along(ctx, null, shape.d0);
      } else if (!shape.range) {
        this.ring(ctx, this.edgeFn(shape.d0));
        this.ring(ctx, this.edgeFn(shape.d1));
        rule = 'evenodd';
      } else {
        this.trace(ctx, shape.range[0], shape.range[1], this.edgeFn(shape.d0));
        this.trace(ctx, shape.range[0], shape.range[1], this.edgeFn(shape.d1), false, true);
        ctx.closePath();
      }
    } else if (shape.kind === 'rect') {
      this.rectPath(ctx, shape.rect);
    } else {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      this.polyline(ctx, shape.points);
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(3 * this.dpr, shape.width * this.scale);
      ctx.stroke();
      return;
    }
    ctx.fillStyle = color;
    ctx.fill(rule);
    if (region.pattern === 'mowing') {
      ctx.save();
      ctx.clip(rule);
      ctx.fillStyle = COLORS.grassStripe;
      const stripe = 24 * this.scale;
      const [ox] = this.toScreen(0, 0);
      for (let x = ox % (2 * stripe) - 2 * stripe; x < this.base.width + stripe; x += 2 * stripe) {
        ctx.fillRect(x, 0, stripe, this.base.height);
      }
      ctx.restore();
    }
  }

  /** Quiet edge line round a region (lots, roads). */
  private outlineRegion(ctx: CanvasRenderingContext2D, region: SurfaceRegion): void {
    const shape = region.shape;
    if (shape.kind === 'rect') {
      this.rectPath(ctx, shape.rect);
    } else if (shape.kind === 'path') {
      ctx.beginPath();
      const pts = shape.points;
      for (const side of [-1, 1]) {
        pts.forEach(([x, y], i) => {
          // Offset each vertex sideways by half the width (along the local normal).
          const [px0, py0] = pts[Math.max(0, i - 1)];
          const [px1, py1] = pts[Math.min(pts.length - 1, i + 1)];
          const len = Math.hypot(px1 - px0, py1 - py0) || 1;
          const ox = (-(py1 - py0) / len) * (shape.width / 2) * side;
          const oy = ((px1 - px0) / len) * (shape.width / 2) * side;
          const [sx, sy] = this.toScreen(x + ox, y + oy);
          if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
        });
      }
    } else {
      ctx.beginPath();
      this.along(ctx, shape.range, shape.d0);
      if (!shape.openIn) this.along(ctx, shape.range, shape.d1);
    }
  }

  /**
   * Draw the track from its layout: surfaces bottom to top and decoration on
   * the base layer; outlines, paint, barriers and the start line on the lines
   * layer. Knows nothing about what kind of track it is.
   */
  private drawTrack(): void {
    const track = this.track!;
    const layout = track.layout;
    const px = this.dpr;

    const base = this.base.getContext('2d')!;
    base.fillStyle = COLORS.background;
    base.fillRect(0, 0, this.base.width, this.base.height);
    for (const region of layout.surfaces) this.paintRegion(base, region);
    // Banking: a heatmap in the debug view, otherwise a light sheen that rises with the slope.
    this.paintBanking(base, this.debugLayers.banking
      ? (b) => bankColor(deg(b), 0.62)
      : (b) => `rgba(255,255,255,${Math.min(0.3, 0.3 * deg(b) / 30).toFixed(3)})`);
    const view = this.decorView(base);
    for (const deco of layout.decor) paintDecoration(view, deco);

    const lines = this.lines.getContext('2d')!;
    lines.clearRect(0, 0, this.lines.width, this.lines.height);
    lines.lineJoin = 'round';
    lines.lineCap = 'butt';
    const stroke = (style: { color: string; width: number; dash?: number[] }) => {
      lines.strokeStyle = style.color;
      lines.lineWidth = style.width * px;
      lines.setLineDash((style.dash ?? []).map((v) => v * px));
      lines.stroke();
      lines.setLineDash([]);
    };

    for (const region of layout.surfaces) {
      if (!region.outline) continue;
      this.outlineRegion(lines, region);
      stroke(LINE_STYLES.edge);
    }

    const paint = (m: Marking) => {
      lines.beginPath();
      if (m.kind === 'line') {
        this.along(lines, m.range, m.d);
      } else {
        for (const sv of m.s) {
          const [ax, ay] = this.toScreen(...track.toWorld(sv, m.d0));
          const [bx, by] = this.toScreen(...track.toWorld(sv, m.d1));
          lines.moveTo(ax, ay);
          lines.lineTo(bx, by);
        }
      }
      stroke(LINE_STYLES[m.style]);
    };
    // The start/finish line goes over the barriers; everything else under them.
    for (const m of layout.markings) if (m.style !== 'start') paint(m);

    // Barriers: thick and bright with a dark outline, attenuators on padded ends.
    for (const wall of layout.walls) {
      const w = Math.max(3 * px, wall.thickness * this.scale);
      for (const [color, width] of [[COLORS.barrierShadow, w + 2 * px], [COLORS.barrier, w]] as const) {
        lines.beginPath();
        this.along(lines, wall.range, wall.d);
        lines.strokeStyle = color;
        lines.lineWidth = width;
        lines.stroke();
      }
      if (wall.attenuators && wall.range) {
        for (const sv of wall.range) {
          const [x, y] = this.toScreen(...track.toWorld(sv, track.edgeAt(wall.d, sv)));
          lines.beginPath();
          lines.arc(x, y, Math.max(3 * px, wall.thickness * this.scale), 0, Math.PI * 2);
          lines.fillStyle = COLORS.attenuator;
          lines.fill();
        }
      }
    }
    for (const m of layout.markings) if (m.style === 'start') paint(m);
    if (this.debugLayers.banking) this.drawBankLabels(lines);
    this.trackDirty = false;
  }

  /**
   * Shade the paved surface by its banking: the racing surface in lateral
   * slices (banking changes across it), the apron and pit road as one. Runs of
   * the same shade along the lap are drawn as one band, so straights and
   * constant-radius arcs cost a single polygon per slice.
   */
  private paintBanking(ctx: CanvasRenderingContext2D, colorFor: (bank: number) => string): void {
    const track = this.track!;
    const SLICES = 6;
    // Fractions across the racing surface, from the outside edge in (the edges can vary along the lap).
    const across = (s: number, f: number) => track.outerEdgeAt(s) + (track.innerEdgeAt(s) - track.outerEdgeAt(s)) * f;
    const slices: Array<{ d0: (s: number) => number; d1: (s: number) => number; at: (s: number) => number }> = [];
    for (let k = 0; k < SLICES; k++) {
      slices.push({ d0: (s) => across(s, k / SLICES), d1: (s) => across(s, (k + 1) / SLICES), at: (s) => across(s, (k + 0.5) / SLICES) });
    }
    slices.push({ d0: (s) => track.innerEdgeAt(s), d1: (s) => track.pavedInnerD(s), at: (s) => track.innerEdgeAt(s) + 0.5 });
    const step = Math.max(2, 3 * this.dpr / this.scale);
    for (const slice of slices) {
      let runStart = 0;
      let runColor = colorFor(track.bankAt(0, slice.at(0)));
      const flush = (end: number) => {
        ctx.beginPath();
        this.trace(ctx, runStart, end, slice.d0);
        this.trace(ctx, runStart, end, slice.d1, false, true);
        ctx.closePath();
        ctx.fillStyle = runColor;
        ctx.fill();
      };
      for (let s = step; s < track.length + step; s += step) {
        const sc = Math.min(s, track.length);
        const color = colorFor(track.bankAt(track.indexAt(sc), slice.at(sc)));
        if (color !== runColor || sc >= track.length) {
          flush(sc);
          runStart = sc;
          runColor = color;
        }
      }
    }
  }

  /**
   * Banking labels on the infield side: inside -> outside edge of the racing
   * surface, at the middle of each straight, transition and turn (found from
   * the curvature, so it works on any layout).
   */
  private drawBankLabels(ctx: CanvasRenderingContext2D): void {
    const track = this.track!;
    const n = track.n;
    const kind = (i: number) => (track.turn[i] < 0.02 ? 0 : track.turn[i] > 0.98 ? 2 : 1);
    // Runs of straight / transition / arc, starting at a boundary so none wraps.
    let start = 0;
    while (start < n && kind(start) === kind((start - 1 + n) % n)) start++;
    if (start === n) start = 0;
    const mids: number[] = [];
    let runFrom = start;
    for (let k = 1; k <= n; k++) {
      const i = (start + k) % n;
      if (k === n || kind(i) !== kind((i - 1 + n) % n)) {
        const len = (k - (runFrom - start + n) % n);
        if (len * track.ds > 20) mids.push(((runFrom + len / 2) % n) * track.ds);
        runFrom = i;
      }
    }
    const px = this.dpr;
    ctx.font = `${Math.round(10.5 * px)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const s of mids) {
      const i = track.indexAt(s);
      const inner = deg(track.bankAt(i, track.innerEdge(i)));
      const outer = deg(track.bankAt(i, track.outerEdge(i)));
      const apron = deg(track.bankAt(i, track.innerEdge(i) + 0.5));
      const width = track.innerEdge(i) - track.outerEdge(i);
      const text = `${inner.toFixed(1)}° → ${outer.toFixed(1)}°`;
      const sub = `${width.toFixed(0)} m wide · apron ${apron.toFixed(1)}°`;
      // Just inside the pavement's inner edge (always on screen when the track is), pushed in along the screen-space normal.
      const [wx, wy] = this.toScreen(...track.toWorld(s, track.pavedInnerD(s)));
      const [ix, iy] = this.toScreen(...track.toWorld(s, track.outerEdge(i)));
      const len = Math.hypot(wx - ix, wy - iy) || 1;
      const ox = (wx - ix) / len, oy = (wy - iy) / len;
      const w = Math.max(ctx.measureText(text).width, ctx.measureText(sub).width) + 8 * px;
      const off = 14 * px + Math.abs(ox) * w / 2 + Math.abs(oy) * 13 * px;
      const x = wx + ox * off, y = wy + oy * off;
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(x - w / 2, y - 13 * px, w, 26 * px);
      ctx.fillStyle = bankColor(outer);
      ctx.fillText(text, x, y - 5 * px);
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillText(sub, x, y + 7 * px);
    }
  }

  /** Colour scale for the banking heatmap, bottom-left of the view. */
  private drawBankLegend(): void {
    const ctx = this.ctx, px = this.dpr;
    const x = 16 * px, y = this.canvas.height - 40 * px, w = 180 * px, h = 8 * px;
    for (let k = 0; k < w; k++) {
      ctx.fillStyle = bankColor((k / w) * BANK_SCALE_MAX);
      ctx.fillRect(x + k, y, 1, h);
    }
    ctx.font = `${Math.round(10 * px)}px ui-monospace, monospace`;
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.textBaseline = 'top';
    for (const v of [0, 8, 16, 24, 32]) {
      ctx.textAlign = v === 0 ? 'left' : v === 32 ? 'right' : 'center';
      ctx.fillText(`${v}°`, x + (v / BANK_SCALE_MAX) * w, y + h + 3 * px);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('banking', x, y - 3 * px);
  }

  private decorView(ctx: CanvasRenderingContext2D): DecorView {
    return {
      ctx,
      scale: this.scale,
      toScreen: (s, d) => this.toScreen(...this.track!.toWorld(s, d)),
      rectPath: (r) => this.rectPath(ctx, r),
    };
  }

  /** Erase all accumulated tire marks. */
  clearMarks(): void {
    this.grooveCtx.clearRect(0, 0, this.groove.width, this.groove.height);
    this.marksCtx.clearRect(0, 0, this.marks.width, this.marks.height);
  }

  /** Stamp mark strokes (from a StrokeCollector) onto the permanent groove and skid layers. */
  stampStrokes(strokes: Float32Array): void {
    if (!this.track) return;
    const groove = this.grooveCtx, skids = this.marksCtx;
    groove.lineCap = 'round';
    skids.lineCap = 'round';
    groove.strokeStyle = `rgba(${COLORS.rubber},${GROOVE_STROKE_ALPHA})`;
    groove.lineWidth = GROOVE_WIDTH * MARK_RES;
    for (let k = 0; k + STROKE_FIELDS <= strokes.length; k += STROKE_FIELDS) {
      const [x0, y0] = this.toMarks(strokes[k], strokes[k + 1]);
      const [x1, y1] = this.toMarks(strokes[k + 2], strokes[k + 3]);
      if (Math.random() < grooveChance({ groove: strokes[k + 4] })) {
        groove.beginPath();
        groove.moveTo(x0, y0);
        groove.lineTo(x1, y1);
        groove.stroke();
      }
      const skid = skidStroke({ skid: strokes[k + 5], surface: strokes[k + 6] ? 'grass' : 'track' });
      if (skid) {
        skids.strokeStyle = `rgba(${skid.turf ? COLORS.turf : COLORS.rubber},${skid.alpha.toFixed(3)})`;
        skids.lineWidth = skid.width * MARK_RES;
        skids.beginPath();
        skids.moveTo(x0, y0);
        skids.lineTo(x1, y1);
        skids.stroke();
      }
    }
  }

  render(
    cars: RenderCar[], liveryOf: (car: RenderCar) => Livery | undefined, highlight: RenderCar | null = null,
    officials: RenderOfficials = { paceCar: null, wreckers: [] },
  ): void {
    const ctx = this.ctx;
    const track = this.track;
    if (!track) return;
    if (this.trackDirty) this.drawTrack();
    ctx.drawImage(this.base, 0, 0);
    const b = track.bounds;
    const [mx, my] = this.toScreen(b.minX, b.maxY);
    const mw = (b.maxX - b.minX) * this.scale, mh = (b.maxY - b.minY) * this.scale;
    ctx.globalAlpha = GROOVE_DISPLAY_ALPHA;
    ctx.drawImage(this.groove, mx, my, mw, mh);
    ctx.globalAlpha = 1;
    ctx.drawImage(this.marks, mx, my, mw, mh);
    ctx.drawImage(this.lines, 0, 0);

    const minR = (this.dotMode === 'legible' ? 8 : 2.5) * this.dpr;
    const r = Math.max(minR, P.CAR_RADIUS * this.scale);
    const showNumbers = r >= 6 * this.dpr;
    const w = this.canvas.width, h = this.canvas.height;

    // Draw back-to-front by track position so leaders sit on top in a pack.
    const order = [...cars].sort((a, c) => a.dist - c.dist);
    for (const car of order) {
      const [x, y] = this.toScreen(car.x, car.y);
      if (x < -50 || y < -50 || x > w + 50 || y > h + 50) continue;
      const livery = liveryOf(car);
      const fill = livery?.fill ?? car.color;
      const border = livery?.border ?? '#000';

      if (this.debugLayers.forces && !car.retired) {
        // Horizontal forces per unit mass, 1 g = FORCE_PX: the banking's push toward the
        // infield (amber) and what the tires are doing (cyan). Their sum turns the car.
        const FORCE_PX = 26 * this.dpr;
        const i = car.trackIdx;
        const nx = -track.ty[i], ny = track.tx[i];
        const tx = car.tireLon * car.frameX - car.tireLat * car.frameY;
        const ty = car.tireLon * car.frameY + car.tireLat * car.frameX;
        const arrow = (ax: number, ay: number, color: string) => {
          const m = Math.hypot(ax, ay);
          if (m < 0.05 * G) return;
          const ux = ax / m, uy = ay / m;
          const len = r + FORCE_PX * (m / G);
          const ex = x + ux * len, ey = y - uy * len;
          ctx.strokeStyle = color;
          ctx.fillStyle = color;
          ctx.lineWidth = 2 * this.dpr;
          ctx.beginPath();
          ctx.moveTo(x + ux * r, y - uy * r);
          ctx.lineTo(ex, ey);
          ctx.stroke();
          const hd = 5 * this.dpr;
          ctx.beginPath();
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex - ux * hd - uy * hd * 0.6, ey + uy * hd - ux * hd * 0.6);
          ctx.lineTo(ex - ux * hd + uy * hd * 0.6, ey + uy * hd + ux * hd * 0.6);
          ctx.closePath();
          ctx.fill();
        };
        arrow(nx * car.bankAcc, ny * car.bankAcc, '#f5c518');
        arrow(tx, ty, '#4fd1ff');
      }

      if (this.debugLayers.inputs && !car.retired) {
        // The driver's acceleration request in world space; length = input magnitude.
        const mag = Math.hypot(car.inputX, car.inputY);
        const m = Math.min(1, mag);
        const wx = (car.inputX * car.frameX - car.inputY * car.frameY) / Math.max(1e-6, mag);
        const wy = (car.inputX * car.frameY + car.inputY * car.frameX) / Math.max(1e-6, mag);
        const len = r + 22 * this.dpr * m;
        ctx.strokeStyle = fill;
        ctx.globalAlpha = 0.8;
        ctx.lineWidth = 1.5 * this.dpr;
        ctx.beginPath();
        ctx.moveTo(x + wx * r, y - wy * r);
        ctx.lineTo(x + wx * len, y - wy * len);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      if (car.cleared && !car.towed && !car.parked) continue;
      ctx.globalAlpha = car.retired ? 0.35 : 1;
      // Thick border ring, then the fill, then the number.
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = border;
      ctx.fill();
      const inner = r * (showNumbers ? 0.72 : 0.58);
      ctx.beginPath();
      ctx.arc(x, y, inner, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      if (showNumbers && livery) {
        const text = livery.label ?? String(livery.number);
        ctx.fillStyle = numberColor(fill);
        ctx.font = `700 ${Math.round(inner * (text.length > 1 ? 1.15 : 1.35))}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, x, y + inner * 0.06);
      }
      ctx.globalAlpha = 1;

      if (car === highlight) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5 * this.dpr;
        ctx.beginPath();
        ctx.arc(x, y, r + 3 * this.dpr, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    this.drawOfficials(officials, r);
    if (this.debugLayers.banking) this.drawBankLegend();
  }

  /** Pace car (white, amber light bar) and wreckers (orange trucks), lights flashing. */
  private drawOfficials(o: RenderOfficials, r: number): void {
    const ctx = this.ctx;
    const flash = Math.floor(performance.now() / 250) % 2 === 0;
    const light = (x: number, y: number, rr: number) => {
      if (!flash) return;
      ctx.beginPath();
      ctx.arc(x, y, rr * 1.9, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(245, 197, 24, 0.35)';
      ctx.fill();
    };
    if (o.paceCar) {
      const [x, y] = this.toScreen(o.paceCar.x, o.paceCar.y);
      light(x, y, r);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = PACE_CAR_LIVERY.border;
      ctx.fill();
      const inner = r * 0.72;
      ctx.beginPath();
      ctx.arc(x, y, inner, 0, Math.PI * 2);
      ctx.fillStyle = PACE_CAR_LIVERY.fill;
      ctx.fill();
      if (r >= 6 * this.dpr) {
        ctx.fillStyle = '#111';
        ctx.font = `700 ${Math.round(inner * 1.05)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('PC', x, y + inner * 0.06);
      }
    }
    for (const w of o.wreckers) {
      if (w.phase === 'done') continue;
      const [x, y] = this.toScreen(w.x, w.y);
      const half = r * 0.95;
      light(x, y, r);
      ctx.fillStyle = '#ff7a1a';
      ctx.strokeStyle = '#111';
      ctx.lineWidth = Math.max(1, this.dpr);
      ctx.beginPath();
      ctx.rect(x - half, y - half, half * 2, half * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}

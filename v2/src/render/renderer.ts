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
  speed: number;
  fuel: number;
  inputX: number;
  inputY: number;
  frameX: number;
  frameY: number;
  trackIdx: number;
  tireLon: number;
  tireLat: number;
  bankAcc: number;
  /** Driving school: one of a student's practice variations, drawn small and faint. */
  variant?: boolean;
}

/** Edges of the view (CSS px). */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Officials on track: the pace car, and wreckers (phase 'done' once parked). */
export interface RenderOfficials {
  paceCar: { x: number; y: number } | null;
  wreckers: Array<{ x: number; y: number; phase: string }>;
}
import { G, PHYSICS as P } from '../sim/constants';
import type { Decoration, Edge, LineStyle, Marking, SRange, Surface, SurfaceRegion, TrackRect } from '../sim/layout';
import type { Track } from '../sim/track';
import { Exhaust } from './exhaust';
import { numberColor, PACE_CAR_LIVERY, RACING_SURFACE, type Livery } from './livery';
import { GROOVE_DISPLAY_ALPHA, GROOVE_STROKE_ALPHA, GROOVE_WIDTH, grooveChance, skidStroke, STROKE_FIELDS } from './marks';

const COLORS = {
  background: '#0d0d0f',
  surface: RACING_SURFACE,
  apron: '#3a3a3f',
  pitRoad: '#35353a',
  grass: '#1d3322',
  garageLot: '#333338',
  building: '#5b5b63',
  buildingRoof: '#6c6c75',
  road: '#38383d',
  grassStripe: '#213a27',
  /** Painted run-off: the bands across it. */
  paintRed: 'rgba(150,48,48,0.5)',
  paintBlue: 'rgba(48,72,150,0.5)',
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
  /** Stones thrown up in a gravel trap: lighter than the gravel. */
  stones: '150,140,120',
  gravel: '#4d483f',
  runoff: '#2c2c31',
  kerb: '#cfcfcf',
  kerbStripe: '#b0413a',
};

const SURFACE_COLORS: Record<Surface, string> = {
  track: COLORS.surface,
  apron: COLORS.apron,
  pit: COLORS.pitRoad,
  garage: COLORS.garageLot,
  road: COLORS.road,
  grass: COLORS.grass,
  kerb: COLORS.kerb,
  runoff: COLORS.runoff,
  gravel: COLORS.gravel,
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

/** How bright the lines of a layout that isn't being raced are drawn. */
const OTHER_LAYOUT_ALPHA = 0.4;

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
  bays(v, { rect, spacing }) {
    const depth = rect.d1 - rect.d0;
    const row = Math.min(6, depth * 0.35);
    v.ctx.beginPath();
    for (let s = rect.s0 + 2; s <= rect.s1 - 2; s += spacing) {
      for (const [a, b] of [[rect.d0 + 1, rect.d0 + 1 + row], [rect.d1 - 1 - row, rect.d1 - 1]]) {
        const [ax, ay] = v.toScreen(s, a);
        const [bx, by] = v.toScreen(s, b);
        v.ctx.moveTo(ax, ay);
        v.ctx.lineTo(bx, by);
      }
    }
    v.ctx.strokeStyle = COLORS.paint;
    v.ctx.lineWidth = Math.max(0.5, 0.15 * v.scale);
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

/** Border for a car with no livery: light, so it reads on the asphalt. */
const FALLBACK_BORDER = '#f8f9fa';

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
  /** Edges of the view kept clear of the track (CSS px), for overlays such as the HUD. */
  private insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  private trackDirty = true;
  private debugLayers: DebugLayers = { inputs: true, forces: false, banking: false };
  dotMode: DotMode = 'legible';
  /** Speed trails and exhaust puffs behind the cars. */
  effects = true;
  /** Hold the trails and exhaust (replays running backwards or being scrubbed, where they'd trail the wrong way). */
  effectsPaused = false;
  private effectsWere = true;
  private readonly exhaust = new Exhaust();

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
    this.exhaust.reset();
    this.resize();
  }

  /**
   * Match the canvas to its size on screen (call when that changes), and
   * refit the track to it.
   */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * this.dpr));
    const h = Math.max(1, Math.round(rect.height * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      for (const c of [this.canvas, this.base, this.lines]) {
        c.width = w;
        c.height = h;
      }
      this.trackDirty = true; // resizing a canvas wipes it, even when the view doesn't change
    }
    const track = this.track;
    if (!track) return;
    const b = track.bounds;
    const pad = 24 * this.dpr;
    const ins = this.insets, px = this.dpr;
    const fitW = w - 2 * pad - (ins.left + ins.right) * px;
    const fitH = h - 2 * pad - (ins.top + ins.bottom) * px;
    this.fitScale = Math.max(1e-3, Math.min(fitW / (b.maxX - b.minX), fitH / (b.maxY - b.minY)));
    this.updateTransform();
  }

  /** Keep these edges of the view (CSS px) clear of the track: it fits, and the camera centres, in what's left. */
  setInsets(insets: Partial<Insets>): void {
    const next = { ...this.insets, ...insets };
    const old = this.insets;
    if (next.top === old.top && next.right === old.right && next.bottom === old.bottom && next.left === old.left) return;
    this.insets = next;
    this.resize();
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

  /** The zoom at which a box this size (world metres) takes up `share` of the view (clear of the insets). */
  zoomToFit(w: number, h: number, share = 0.6): number {
    const ins = this.insets, px = this.dpr;
    const viewW = this.canvas.width - (ins.left + ins.right) * px;
    const viewH = this.canvas.height - (ins.top + ins.bottom) * px;
    return Math.min((viewW * share) / Math.max(1, w), (viewH * share) / Math.max(1, h)) / this.fitScale;
  }

  private updateTransform(): void {
    const track = this.track;
    if (!track) return;
    const b = track.bounds;
    const cx = this.zoom > 1 ? this.focusX : (b.minX + b.maxX) / 2;
    const cy = this.zoom > 1 ? this.focusY : (b.minY + b.maxY) / 2;
    const scale = this.fitScale * this.zoom;
    const ins = this.insets, px = this.dpr;
    const offsetX = this.canvas.width / 2 + ((ins.left - ins.right) / 2) * px - cx * scale;
    const offsetY = this.canvas.height / 2 + ((ins.top - ins.bottom) / 2) * px + cy * scale;
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
    // Its long sides follow the track (a lot along a curved front stretch curves with it), sampled every few metres.
    const steps = Math.max(1, Math.ceil((r.s1 - r.s0) / 5));
    const along = Array.from({ length: steps + 1 }, (_, k) => r.s0 + ((r.s1 - r.s0) * k) / steps);
    ctx.beginPath();
    [...along.map((sv) => [sv, r.d0]), ...along.reverse().map((sv) => [sv, r.d1])].forEach(([sv, dv], i) => {
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

  /**
   * Red blocks across a kerb every other stretch (it is filled white first),
   * each the same length along the kerb itself: round the inside of a corner
   * that is less track (centerline) than round the outside.
   */
  private kerbStripes(ctx: CanvasRenderingContext2D, range: SRange, d0: Edge, d1: Edge): void {
    const track = this.track!;
    const [s0, s1] = range ?? [0, track.length];
    const block = 3; // m, along the kerb
    const at0 = this.edgeFn(d0), at1 = this.edgeFn(d1);
    const along = (s: number) => block / Math.max(0.2, 1 - track.curvatureAt(s) * (at0(s) + at1(s)) / 2);
    ctx.fillStyle = COLORS.kerbStripe;
    for (let s = s0; s < s1;) {
      const e = Math.min(s1, s + along(s));
      ctx.beginPath();
      this.trace(ctx, s, e, at0);
      this.trace(ctx, s, e, at1, false, true);
      ctx.closePath();
      ctx.fill();
      s = e + along(e); // (then a white block)
    }
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
    } else if (shape.kind === 'polygon') {
      this.ringsPath(ctx, shape.rings);
      rule = 'evenodd';
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
    // (A kerb's tapering ends are plain white.)
    if (region.surface === 'kerb' && shape.kind === 'band' && region.pattern !== 'kerbEnd') this.kerbStripes(ctx, shape.range, shape.d0, shape.d1);
    if (region.pattern === 'painted') {
      // Painted run-off: broad diagonal bands, red and blue, fixed to the ground.
      ctx.save();
      ctx.clip(rule);
      const band = 4 * this.scale;
      const [ox, oy] = this.toScreen(0, 0);
      const w = this.base.width, h = this.base.height;
      ctx.lineWidth = band;
      const phase = ((ox + oy) % (4 * band) + 4 * band) % (4 * band);
      for (let c = phase - h - 4 * band, i = 0; c < w + 4 * band; c += band, i++) {
        if (i % 2) continue;
        ctx.strokeStyle = i % 4 ? COLORS.paintBlue : COLORS.paintRed;
        ctx.beginPath();
        ctx.moveTo(c, 0);
        ctx.lineTo(c + h, h);
        ctx.stroke();
      }
      ctx.restore();
    }
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

  /** Closed world rings as one path (fill even-odd for holes). */
  private ringsPath(ctx: CanvasRenderingContext2D, rings: Array<Array<[number, number]>>): void {
    ctx.beginPath();
    for (const ring of rings) {
      ring.forEach(([x, y], i) => {
        const [sx, sy] = this.toScreen(x, y);
        if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
      });
      ctx.closePath();
    }
  }

  /** Quiet edge line round a region (lots, roads). */
  private outlineRegion(ctx: CanvasRenderingContext2D, region: SurfaceRegion): void {
    const shape = region.shape;
    if (shape.kind === 'rect') {
      this.rectPath(ctx, shape.rect);
    } else if (shape.kind === 'polygon') {
      this.ringsPath(ctx, shape.rings);
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
   * Draw the track from its layout, and the venue's other tracks round it:
   * surfaces bottom to top and decoration on the base layer; outlines, paint,
   * barriers and the start line on the lines layer. The outermost track
   * first, so each one inside paints over the infield of the one round it.
   * Knows nothing about what kind of track any of them is.
   */
  private drawTrack(): void {
    const own = this.track!;
    const area = (t: Track) => (t.extent.maxX - t.extent.minX) * (t.extent.maxY - t.extent.minY);
    const tracks = [own, ...own.neighbours].sort((a, b) => area(b) - area(a));
    const base = this.base.getContext('2d')!;
    base.fillStyle = COLORS.background;
    base.fillRect(0, 0, this.base.width, this.base.height);
    const lines = this.lines.getContext('2d')!;
    lines.clearRect(0, 0, this.lines.width, this.lines.height);
    try {
      for (const t of tracks) { this.track = t; this.drawBase(base); }
      // Every layout's lines are painted, as at a real track; the one being raced bright, the rest faint.
      for (const t of tracks) {
        this.track = t;
        lines.globalAlpha = t === own ? 1 : OTHER_LAYOUT_ALPHA;
        this.drawLines(lines);
      }
      lines.globalAlpha = 1;
    } finally {
      this.track = own;
    }
    if (this.debugLayers.banking) this.drawBankLabels(lines);
    this.trackDirty = false;
  }

  /** One track's surfaces, banking sheen and decoration. */
  private drawBase(base: CanvasRenderingContext2D): void {
    const layout = this.track!.layout;
    for (const region of layout.surfaces) this.paintRegion(base, region);
    // Banking: a heatmap in the debug view, otherwise a light sheen that rises with the slope.
    this.paintBanking(base, this.debugLayers.banking
      ? (b) => bankColor(deg(b), 0.62)
      : (b) => `rgba(255,255,255,${Math.min(0.3, 0.3 * deg(b) / 30).toFixed(3)})`);
    const view = this.decorView(base);
    for (const deco of layout.decor) paintDecoration(view, deco);
  }

  /** One track's outlines, paint, barriers and start line. */
  private drawLines(lines: CanvasRenderingContext2D): void {
    const track = this.track!;
    const layout = track.layout;
    const px = this.dpr;
    lines.lineJoin = 'round';
    lines.lineCap = 'butt';
    const stroke = (style: { color: string; width: number; dash?: number[] }) => {
      lines.strokeStyle = style.color;
      lines.lineWidth = style.width * px;
      lines.setLineDash((style.dash ?? []).map((v) => v * px));
      lines.stroke();
      lines.setLineDash([]);
    };

    const alpha = lines.globalAlpha;
    for (const region of layout.surfaces) {
      if (!region.outline) continue;
      // A course road is another layout's racing surface: its edges faint too.
      if (region.surface === 'track' && region.shape.kind === 'path') lines.globalAlpha = alpha * OTHER_LAYOUT_ALPHA;
      this.outlineRegion(lines, region);
      stroke(LINE_STYLES.edge);
      lines.globalAlpha = alpha;
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

    // Barriers are solid whichever layout is raced: drawn at full strength.
    lines.globalAlpha = 1;
    // Barriers: thick and bright with a dark outline (all the outlines first, so where one barrier
    // runs on from another the second's outline doesn't cut across the first), attenuators on padded ends.
    for (const [color, grow] of [[COLORS.barrierShadow, 2 * px], [COLORS.barrier, 0]] as const) {
      for (const wall of layout.walls) {
        lines.beginPath();
        this.along(lines, wall.range, wall.d);
        lines.strokeStyle = color;
        lines.lineWidth = Math.max(3 * px, wall.thickness * this.scale) + grow;
        lines.stroke();
      }
    }
    for (const wall of layout.walls) {
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
    // Barriers laid in the world (a road layout's closures): drawn like the walls.
    for (const [color, grow] of [[COLORS.barrierShadow, 2 * px], [COLORS.barrier, 0]] as const) {
      for (const b of layout.barriers ?? []) {
        this.polyline(lines, b.points);
        lines.strokeStyle = color;
        lines.lineWidth = Math.max(3 * px, b.thickness * this.scale) + grow;
        lines.stroke();
      }
    }
    lines.globalAlpha = alpha;
    for (const m of layout.markings) if (m.style === 'start') paint(m);
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
    const kind = (i: number) => { const t = Math.abs(track.turn[i]); return t < 0.02 ? 0 : t > 0.98 ? 2 : 1; };
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
      const ground = strokes[k + 6];
      const skid = skidStroke({ skid: strokes[k + 5], surface: ground === 1 ? 'grass' : ground === 2 ? 'gravel' : 'track' });
      if (skid) {
        skids.strokeStyle = `rgba(${skid.turf ? COLORS.turf : skid.gravel ? COLORS.stones : COLORS.rubber},${skid.alpha.toFixed(3)})`;
        skids.lineWidth = skid.width * MARK_RES;
        skids.beginPath();
        skids.moveTo(x0, y0);
        skids.lineTo(x1, y1);
        skids.stroke();
      }
    }
  }

  render(
    cars: RenderCar[], liveryOf: (car: RenderCar) => Livery | undefined, highlight: readonly RenderCar[] = [],
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

    const effects = this.effects && !this.effectsPaused;
    if (effects !== this.effectsWere) {
      this.exhaust.reset(); // trails start afresh rather than joining across the gap
      this.effectsWere = effects;
    }
    if (effects) {
      // Only cars under their own power smoke; the rest drop their trails.
      const running = cars
        .filter((c) => !c.variant && !c.retired && !c.cleared && !c.towed && !c.parked)
        .map((car) => ({ car, color: liveryOf(car)?.border ?? FALLBACK_BORDER }));
      this.exhaust.draw(ctx, running, (x, y) => this.toScreen(x, y), this.scale, r, this.dpr);
    }

    // Draw back-to-front by track position so leaders sit on top in a pack.
    const order = [...cars].sort((a, c) => Number(!!c.variant) - Number(!!a.variant) || a.dist - c.dist);
    for (const car of order) {
      const [x, y] = this.toScreen(car.x, car.y);
      if (x < -50 || y < -50 || x > w + 50 || y > h + 50) continue;
      const livery = liveryOf(car);
      const fill = livery?.fill ?? car.color;
      const border = livery?.border ?? FALLBACK_BORDER;
      if (car.variant) {
        // A practice variation: a faint dot in the student's colour, under the students.
        if (car.retired) continue;
        ctx.globalAlpha = 0.28;
        ctx.beginPath();
        ctx.arc(x, y, r * 0.5, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.globalAlpha = 1;
        continue;
      }

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

      if (highlight.includes(car)) {
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

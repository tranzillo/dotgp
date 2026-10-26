import type { LineStyle, Surface } from '../sim/layout';
import type { Track } from '../sim/track';
import { RACING_SURFACE, type Livery } from './livery';

/**
 * The track view's contract with the viewer, and its look: what it's given to
 * draw, the palette, and the debug text it puts over the picture.
 */

/**
 * What the renderer needs from a car: a sim Car, or a snapshot of one
 * streamed from an event worker.
 */
export interface RenderCar {
  id: number;
  x: number;
  y: number;
  /** Track frame: along the lap, and across it. */
  s: number;
  d: number;
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

/** Officials: the pace car (out on track, or parked), and the wreckers (parked: 'idle'; marshals finished: 'done'). */
export interface RenderOfficials {
  paceCar: { x: number; y: number; out?: boolean } | null;
  wreckers: Array<{ x: number; y: number; phase: string }>;
}

export const COLORS = {
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

export const SURFACE_COLORS: Record<Surface, string> = {
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
export const LINE_STYLES: Record<LineStyle, { color: string; width: number; dash?: number[] }> = {
  edge: { color: COLORS.edge, width: 1 },
  blend: { color: COLORS.blendLine, width: 1.5 },
  entry: { color: COLORS.blendLine, width: 1.5, dash: [8, 6] },
  lane: { color: COLORS.paint, width: 1, dash: [6, 6] },
  stall: { color: COLORS.paint, width: 1 },
  start: { color: COLORS.startLine, width: 2 },
};

/** How bright the lines of a layout that isn't being raced are drawn. */
export const OTHER_LAYOUT_ALPHA = 0.4;

/** Debug overlays the viewer can switch on. */
export interface DebugLayers {
  /** Each driver's acceleration request. */
  inputs: boolean;
  /** Forces on each car: the banking's push toward the infield, and the tires' force. */
  forces: boolean;
  /** Banking heatmap, inside-to-outside angle labels, legend. */
  banking: boolean;
  /** Who's in whose draft: a line to the car ahead, labelled with the drag it saves. */
  draft: boolean;
}

export const deg = (rad: number) => (rad * 180) / Math.PI;
/** Top of the banking colour scale (deg). */
export const BANK_SCALE_MAX = 32;
export const BANK_RAMP: Array<[number, [number, number, number]]> = [
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
export const FALLBACK_BORDER = '#f8f9fa';

/** Resolution of the tire-mark layer, in pixels per metre of track. */
export const MARK_RES = 3;

/** 'real' draws cars at true size; 'legible' enforces a minimum size so numbers fit. */
export type DotMode = 'real' | 'legible';

/** What the viewer needs from the track view (gl/glRenderer.ts). */
export interface TrackView {
  readonly canvas: HTMLCanvasElement;
  dotMode: DotMode;
  effects: boolean;
  effectsPaused: boolean;
  /** Whether the session on screen drafts at all (ghosts don't): its wind walls and draft debug. */
  drafting: boolean;
  readonly debug: Readonly<DebugLayers>;
  /** For the performance readout. gpuMs: the GPU's time per frame, where it can be measured. */
  readonly stats: { records: number; recordMs: number; ops: number; gpuMs?: number | null };
  /** What draws it: 'webgl2', or 'none' where this browser can't. */
  readonly kind: string;
  setDebug(layer: keyof DebugLayers, on: boolean): void;
  setTrack(track: Track): void;
  resize(): void;
  setInsets(insets: Partial<Insets>): void;
  setView(zoom: number, x: number, y: number): void;
  zoomToFit(w: number, h: number, share?: number): number;
  clearMarks(): void;
  stampStrokes(strokes: Float32Array): void;
  render(cars: RenderCar[], liveryOf: (car: RenderCar) => Livery | undefined, highlight?: readonly RenderCar[], officials?: RenderOfficials): void;
}

/** Stands in where nothing can be drawn (no WebGL2): the rest of the viewer carries on. */
export class BlankView implements TrackView {
  readonly kind = 'none';
  dotMode: DotMode = 'legible';
  effects = true;
  effectsPaused = false;
  drafting = true;
  readonly debug: DebugLayers = { inputs: false, forces: false, banking: false, draft: false };
  readonly stats = { records: 0, recordMs: 0, ops: 0 };

  constructor(readonly canvas: HTMLCanvasElement) {}

  setDebug(layer: keyof DebugLayers, on: boolean): void {
    this.debug[layer] = on;
  }

  setTrack(): void {}
  resize(): void {}
  setInsets(): void {}
  setView(): void {}
  zoomToFit(): number {
    return 1;
  }
  clearMarks(): void {}
  stampStrokes(): void {}
  render(): void {}
}

/**
 * Banking labels on the infield side: inside -> outside edge of the racing
 * surface, at the middle of each straight, transition and turn (found from
 * the curvature, so it works on any layout).
 */
export function paintBankLabels(ctx: CanvasRenderingContext2D, track: Track, toScreen: (x: number, y: number) => [number, number], px: number): void {
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
    const [wx, wy] = toScreen(...track.toWorld(s, track.pavedInnerD(s)));
    const [ix, iy] = toScreen(...track.toWorld(s, track.outerEdge(i)));
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

/** Colour scale for the banking heatmap, bottom-left of a view this tall (px). */
export function paintBankLegend(ctx: CanvasRenderingContext2D, height: number, px: number): void {
  const x = 16 * px, y = height - 40 * px, w = 180 * px, h = 8 * px;
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

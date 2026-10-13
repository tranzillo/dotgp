import type { Car } from '../sim/car';
import type { Wrecker } from '../sim/raceControl';
import { PHYSICS as P } from '../sim/constants';
import { PIT, type Track, type TrackRect } from '../sim/track';
import { numberColor, PACE_CAR_LIVERY, type Livery } from './livery';

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

/** Resolution of the tire-mark layer, in pixels per metre of track. */
const MARK_RES = 3;

/** 'real' draws cars at true size; 'legible' enforces a minimum size so numbers fit. */
export type DotMode = 'real' | 'legible';

/**
 * Three layers: track fill and track lines (screen resolution, redrawn when
 * the camera moves) with tire marks between them. Marks live at a fixed world
 * resolution, so they survive resizes and zooms; they are stamped and never
 * redrawn, so the track accumulates a live record of the lines being raced.
 */
export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly base = document.createElement('canvas');
  private readonly lines = document.createElement('canvas');
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
  private readonly lastPos = new Map<Car, [number, number]>();
  showInputs = true;
  dotMode: DotMode = 'legible';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.marksCtx = this.marks.getContext('2d')!;
  }

  setTrack(track: Track): void {
    this.track = track;
    const b = track.bounds;
    this.marks.width = Math.ceil((b.maxX - b.minX) * MARK_RES);
    this.marks.height = Math.ceil((b.maxY - b.minY) * MARK_RES);
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

  /** Trace d = dAt(s) for s in [s0, s1] (signed metres from the line). */
  private trace(ctx: CanvasRenderingContext2D, s0: number, s1: number, dAt: (s: number) => number, move = true): void {
    const track = this.track!;
    const step = (this.zoom > 2 ? 1 : 2) * track.ds * 2;
    for (let sv = s0; ; sv += step) {
      const sc = Math.min(sv, s1);
      const [x, y] = this.toScreen(...track.toWorld(sc, dAt(sc)));
      if (move && sv === s0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      if (sc >= s1) break;
    }
  }

  private ring(ctx: CanvasRenderingContext2D, dAt: (s: number) => number): void {
    this.trace(ctx, 0, this.track!.length, dAt);
    ctx.closePath();
  }

  private drawTrack(): void {
    const track = this.track!;
    const px = this.dpr;
    const L = track.length;
    const paved = (sv: number) => track.pavedInnerD(sv);
    const at = (d: number) => () => d;

    const base = this.base.getContext('2d')!;
    base.fillStyle = COLORS.background;
    base.fillRect(0, 0, this.base.width, this.base.height);

    // Infield grass with mowing stripes.
    base.save();
    base.beginPath();
    this.ring(base, paved);
    base.fillStyle = COLORS.grass;
    base.fill();
    base.clip();
    base.fillStyle = COLORS.grassStripe;
    const stripe = 24 * this.scale;
    const [ox] = this.toScreen(0, 0);
    for (let x = ox % (2 * stripe) - 2 * stripe; x < this.base.width + stripe; x += 2 * stripe) {
      base.fillRect(x, 0, stripe, this.base.height);
    }
    base.restore();

    // Paved surfaces: racing surface, then apron / pit road out to the grass.
    const band = (dOuter: (s: number) => number, dInner: (s: number) => number, color: string) => {
      base.beginPath();
      this.ring(base, dOuter);
      this.ring(base, dInner);
      base.fillStyle = color;
      base.fill('evenodd');
    };
    band(at(track.outerWallD), at(track.halfWidth), COLORS.surface);
    band(at(track.halfWidth), paved, COLORS.apron);
    // Infield: escape lane (under everything else infield), garage lot, buildings.
    const inf = track.infield;
    base.lineCap = 'round';
    base.lineJoin = 'round';
    base.beginPath();
    inf.escape.forEach(([x, y], i) => {
      const [sx, sy] = this.toScreen(x, y);
      if (i === 0) base.moveTo(sx, sy); else base.lineTo(sx, sy);
    });
    base.strokeStyle = COLORS.road;
    base.lineWidth = Math.max(3 * px, inf.escapeWidth * this.scale);
    base.stroke();
    const rect = (ctx: CanvasRenderingContext2D, r: TrackRect) => {
      ctx.beginPath();
      [[r.s0, r.d0], [r.s1, r.d0], [r.s1, r.d1], [r.s0, r.d1]].forEach(([sv, dv], i) => {
        const [x, y] = this.toScreen(...track.toWorld(sv, dv));
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.closePath();
    };
    rect(base, inf.garage);
    base.fillStyle = COLORS.garageLot;
    base.fill();
    for (const b of inf.buildings) {
      rect(base, b);
      base.fillStyle = COLORS.building;
      base.fill();
      // Roof ridge along the building's length.
      const mid = (b.d0 + b.d1) / 2;
      const [ax, ay] = this.toScreen(...track.toWorld(b.s0 + 1, mid));
      const [bx, by] = this.toScreen(...track.toWorld(b.s1 - 1, mid));
      base.beginPath();
      base.moveTo(ax, ay);
      base.lineTo(bx, by);
      base.strokeStyle = COLORS.buildingRoof;
      base.lineWidth = Math.max(1, 1.5 * this.scale);
      base.stroke();
    }

    // Pit road (behind the wall) a shade darker.
    base.beginPath();
    this.trace(base, track.pitWallStart, track.pitWallEnd, at(track.pitWallD));
    this.trace(base, track.pitWallStart, track.pitWallEnd, at(track.pitRoadD), false);
    base.closePath();
    base.fillStyle = COLORS.pitRoad;
    base.fill();

    const lines = this.lines.getContext('2d')!;
    lines.clearRect(0, 0, this.lines.width, this.lines.height);
    lines.lineJoin = 'round';
    lines.lineCap = 'butt';
    const stroke = (color: string, width: number, dash: number[] = []) => {
      lines.strokeStyle = color;
      lines.lineWidth = width;
      lines.setLineDash(dash);
      lines.stroke();
      lines.setLineDash([]);
    };

    // Surface edges: quiet lines.
    lines.beginPath();
    this.ring(lines, paved);
    stroke(COLORS.edge, px);
    lines.beginPath();
    this.trace(lines, track.blendEnd, L + track.pitWallEnd, at(track.halfWidth));
    stroke(COLORS.edge, px);
    // Infield edges: garage lot outline and escape-lane edges, quiet like other surface edges.
    rect(lines, inf.garage);
    stroke(COLORS.edge, px);
    for (const side of [-1, 1]) {
      lines.beginPath();
      inf.escape.forEach(([x, y], i) => {
        // Offset each vertex sideways by half the lane width (along the local normal).
        const [px0, py0] = inf.escape[Math.max(0, i - 1)];
        const [px1, py1] = inf.escape[Math.min(inf.escape.length - 1, i + 1)];
        const len = Math.hypot(px1 - px0, py1 - py0) || 1;
        const ox = (-(py1 - py0) / len) * (inf.escapeWidth / 2) * side;
        const oy = ((px1 - px0) / len) * (inf.escapeWidth / 2) * side;
        const [sx, sy] = this.toScreen(x + ox, y + oy);
        if (i === 0) lines.moveTo(sx, sy); else lines.lineTo(sx, sy);
      });
      stroke(COLORS.edge, px);
    }

    // Pit exit blend line: from the end of the pit wall through turns 1-2 onto the back straight.
    lines.beginPath();
    this.trace(lines, track.pitWallEnd, track.blendEnd, at(track.halfWidth));
    stroke(COLORS.blendLine, 1.5 * px);
    // Pit entry: dashed lane line where cars peel off the apron at turn 4 exit.
    lines.beginPath();
    this.trace(lines, track.pitWallStart - PIT.ENTRY_LENGTH, track.pitWallStart, at(track.halfWidth));
    stroke(COLORS.blendLine, 1.5 * px, [8 * px, 6 * px]);
    // Pit road: fast-lane line and stall boxes.
    const laneD = track.pitWallD + PIT.WALL_THICKNESS / 2 + 6;
    lines.beginPath();
    this.trace(lines, track.pitWallStart, track.pitWallEnd, at(laneD));
    stroke(COLORS.paint, px, [6 * px, 6 * px]);
    lines.beginPath();
    for (let sv = track.pitWallStart + 19; sv < track.pitWallEnd - 10; sv += 12) {
      const [ax, ay] = this.toScreen(...track.toWorld(sv, laneD));
      const [bx, by] = this.toScreen(...track.toWorld(sv, track.pitRoadD - 1));
      lines.moveTo(ax, ay);
      lines.lineTo(bx, by);
    }
    stroke(COLORS.paint, px);

    // Barriers: thick and bright with a dark outline.
    const barrier = (pathFn: () => void, thicknessM: number) => {
      const w = Math.max(3 * px, thicknessM * this.scale);
      lines.beginPath();
      pathFn();
      stroke(COLORS.barrierShadow, w + 2 * px);
      lines.beginPath();
      pathFn();
      stroke(COLORS.barrier, w);
    };
    barrier(() => { this.ring(lines, at(track.outerWallD - 0.4)); }, 0.8);
    barrier(() => { this.trace(lines, track.pitWallStart, track.pitWallEnd, at(track.pitWallD)); }, PIT.WALL_THICKNESS);
    // Attenuators on the pit wall ends.
    for (const [ex, ey] of track.pitWallEnds) {
      const [x, y] = this.toScreen(ex, ey);
      lines.beginPath();
      lines.arc(x, y, Math.max(3 * px, PIT.WALL_THICKNESS * this.scale), 0, Math.PI * 2);
      lines.fillStyle = COLORS.attenuator;
      lines.fill();
    }

    // Start/finish line across the racing surface.
    const [ax, ay] = this.toScreen(...track.toWorld(0, track.outerWallD));
    const [bx, by] = this.toScreen(...track.toWorld(0, track.halfWidth));
    lines.beginPath();
    lines.moveTo(ax, ay);
    lines.lineTo(bx, by);
    stroke(COLORS.startLine, 2 * px);
    this.trackDirty = false;
  }

  /** Erase all accumulated tire marks. */
  clearMarks(): void {
    this.lastPos.clear();
    this.marksCtx.clearRect(0, 0, this.marks.width, this.marks.height);
  }

  /** Stamp this step's tire marks onto the permanent mark layer. */
  stampMarks(cars: Car[]): void {
    if (!this.track) return;
    const ctx = this.marksCtx;
    ctx.lineCap = 'round';
    for (const car of cars) {
      const [x, y] = this.toMarks(car.x, car.y);
      const prev = this.lastPos.get(car);
      if (prev && Math.hypot(x - prev[0], y - prev[1]) < 1.5) continue; // batch tiny moves
      this.lastPos.set(car, [x, y]);
      if (!prev) continue;
      const jump = Math.hypot(x - prev[0], y - prev[1]);
      if (jump > 30 * MARK_RES || car.markIntensity < 0.03) continue; // respawn teleport or no mark
      const a = Math.pow(car.markIntensity, 0.8) * 0.3;
      ctx.strokeStyle = `rgba(${car.surface === 'grass' ? COLORS.turf : COLORS.rubber},${a.toFixed(3)})`;
      ctx.lineWidth = P.CAR_RADIUS * MARK_RES * (0.5 + 0.6 * car.markIntensity);
      ctx.beginPath();
      ctx.moveTo(prev[0], prev[1]);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
  }

  forget(car: Car): void {
    this.lastPos.delete(car);
  }

  render(
    cars: Car[], liveryOf: (car: Car) => Livery | undefined, highlight: Car | null = null,
    officials: { paceCar: Car | null; wreckers: Wrecker[] } = { paceCar: null, wreckers: [] },
  ): void {
    const ctx = this.ctx;
    const track = this.track;
    if (!track) return;
    if (this.trackDirty) this.drawTrack();
    ctx.drawImage(this.base, 0, 0);
    const b = track.bounds;
    const [mx, my] = this.toScreen(b.minX, b.maxY);
    ctx.drawImage(this.marks, mx, my, (b.maxX - b.minX) * this.scale, (b.maxY - b.minY) * this.scale);
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

      if (this.showInputs && !car.retired) {
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
  }

  /** Pace car (white, amber light bar) and wreckers (orange trucks), lights flashing. */
  private drawOfficials(o: { paceCar: Car | null; wreckers: Wrecker[] }, r: number): void {
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

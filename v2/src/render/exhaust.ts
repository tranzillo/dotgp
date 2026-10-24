import { PHYSICS as P } from '../sim/constants';

/**
 * Two effects behind each car, in its border colour, driven by two different
 * signals so they can disagree:
 *
 * - The speed trail is the air around the car: it wraps the dot's nose and
 *   streams back along its recent path. It only appears at racing speed and
 *   grows with every m/s above that, so a pacing field shows none.
 *   Lifting off keeps it (speed only bleeds away); a standing car has none.
 * - Exhaust puffs come from engine effort: how much of the available drive the
 *   car is using (puff rate) and how much power that is (puff size). A launch
 *   spits small, quick puffs; flat out on a straight they're big. Lifting or
 *   braking stops them, as does an empty tank. Puffs stay where they were
 *   dropped, so at speed they string out into a longer, gappier plume.
 *
 * Puffs live in wall-clock time, so they read the same at any sim speed.
 * Sizes scale with the drawn dot, so they keep up with the 'legible' minimum.
 */
export const EXHAUST = {
  /**
   * No trail below this speed (m/s, ~187 km/h): above anything a pacing or
   * cautioned field does (pace speed tops out at 44 m/s, caution at 1.15×),
   * so only racing speed shows.
   */
  TRAIL_START_SPEED: 52,
  /** Speed at which the trail is at full strength (m/s, ~288 km/h). */
  TRAIL_FULL_SPEED: 80,
  /** Trail length: this many metres per m/s above the start speed. */
  TRAIL_LENGTH_PER_MS: 1.3,
  /** At full speed the trail is at least this long on screen (CSS px), so it shows zoomed out. */
  TRAIL_MIN_PX: 40,
  /** Trail half-width around the car, × dot radius: a little wider than the dot, so it wraps it. */
  TRAIL_WIDTH: 1.3,
  /** The faint outer sheath, × the core's width. */
  TRAIL_SHEATH: 1.45,
  /** How far the envelope reaches ahead of the car, × its half-width. */
  TRAIL_BOW: 0.8,
  /** How the width eases to a point: below 1 stays full longer, like a comet. */
  TRAIL_TAPER: 0.6,
  TRAIL_ALPHA: 0.55,
  /** Puffs per second at full effort. */
  PUFF_RATE: 26,
  /** Puff lifetime (s, wall clock), randomised ±30%. */
  PUFF_LIFE: 0.45,
  /** Puff radius at birth × dot radius: at no power … full power. */
  PUFF_SIZE_MIN: 0.3,
  PUFF_SIZE_MAX: 0.75,
  /** A puff swells to this × its birth size as it fades. */
  PUFF_GROWTH: 2,
  PUFF_ALPHA: 0.75,
  /** Sideways scatter, × dot radius; drifts further out as the puff ages. */
  PUFF_SCATTER: 0.45,
  MAX_PUFFS: 4000,
};

/** What the effects need from a car. */
export interface ExhaustCar {
  id: number;
  x: number;
  y: number;
  speed: number;
  fuel: number;
  tireLon: number;
  frameX: number;
  frameY: number;
}

interface Puff {
  x: number;
  y: number;
  /** Sideways offset, in dot radii at birth. */
  ox: number;
  oy: number;
  born: number;
  life: number;
  size: number;
  alpha: number;
  color: string;
}

interface Tail {
  /** Recent positions, newest last, flattened [x0, y0, x1, y1, ...] (world m). */
  pts: number[];
  /** Puffs owed but not yet dropped. */
  owed: number;
  seen: number;
}

/** Keep this much path per car (m); longer than any trail. */
const HISTORY_M = 160;
/** A jump longer than this between frames is a teleport (reset, new event), not driving. */
const TELEPORT_M = 300;

/** How hard the engine is working: share of available drive (0..1) and share of full power (0..1). */
export function engineEffort(car: Pick<ExhaustCar, 'speed' | 'fuel' | 'tireLon'>): { effort: number; power: number } {
  if (car.fuel <= 0 || car.tireLon <= 0) return { effort: 0, power: 0 };
  const mass = P.DRY_MASS + car.fuel;
  const available = Math.min(P.MAX_DRIVE_ACCEL, P.ENGINE_POWER / (mass * Math.max(car.speed, 1)));
  return {
    effort: Math.min(1, car.tireLon / available),
    power: Math.min(1, (car.tireLon * mass * car.speed) / P.ENGINE_POWER),
  };
}

export class Exhaust {
  private readonly tails = new Map<number, Tail>();
  private puffs: Puff[] = [];
  private readonly sprites = new Map<string, HTMLCanvasElement>();
  private lastNow = 0;
  private frameNo = 0;

  reset(): void {
    this.tails.clear();
    this.puffs = [];
  }

  /**
   * Advance and draw. `cars` are the ones that should smoke (on track and
   * running); `toScreen` maps world to canvas px; `r` is the dot radius (px).
   */
  draw(
    ctx: CanvasRenderingContext2D, cars: Array<{ car: ExhaustCar; color: string }>,
    toScreen: (x: number, y: number) => [number, number], scale: number, r: number, dpr: number,
  ): void {
    const now = performance.now() / 1000;
    const dt = this.lastNow ? Math.min(0.1, now - this.lastNow) : 0;
    this.lastNow = now;
    const frame = ++this.frameNo;

    for (const { car, color } of cars) {
      let tail = this.tails.get(car.id);
      if (!tail) this.tails.set(car.id, (tail = { pts: [car.x, car.y], owed: 0, seen: frame }));
      tail.seen = frame;
      const n = tail.pts.length;
      const px = tail.pts[n - 2], py = tail.pts[n - 1];
      const moved = Math.hypot(car.x - px, car.y - py);
      if (moved > TELEPORT_M) {
        tail.pts = [car.x, car.y];
        tail.owed = 0;
        continue;
      }
      // Owe puffs in wall time; pay them only when a new snapshot has moved the car,
      // spread along the path it covered (so a paused sim stops smoking).
      const { effort, power } = engineEffort(car);
      tail.owed = Math.min(4, tail.owed + EXHAUST.PUFF_RATE * effort * dt);
      if (moved < 0.02) continue;
      const count = Math.floor(tail.owed);
      tail.owed -= count;
      for (let k = 0; k < count && this.puffs.length < EXHAUST.MAX_PUFFS; k++) {
        const t = (k + Math.random()) / count;
        const side = (Math.random() * 2 - 1) * EXHAUST.PUFF_SCATTER;
        this.puffs.push({
          x: px + (car.x - px) * t,
          y: py + (car.y - py) * t,
          ox: -car.frameY * side,
          oy: car.frameX * side,
          born: now - (1 - t) * dt,
          life: EXHAUST.PUFF_LIFE * (0.7 + 0.6 * Math.random()),
          size: EXHAUST.PUFF_SIZE_MIN + (EXHAUST.PUFF_SIZE_MAX - EXHAUST.PUFF_SIZE_MIN) * power * (0.75 + 0.5 * Math.random()),
          alpha: EXHAUST.PUFF_ALPHA * (0.6 + 0.4 * effort),
          color,
        });
      }
      tail.pts.push(car.x, car.y);
      this.trimHistory(tail);
    }
    for (const [id, tail] of this.tails) if (tail.seen !== frame) this.tails.delete(id);

    // Trails under the puffs.
    ctx.save();
    for (const { car, color } of cars) {
      const tail = this.tails.get(car.id);
      if (tail) this.drawTrail(ctx, tail, car, color, toScreen, scale, r, dpr);
    }

    const w = ctx.canvas.width, h = ctx.canvas.height;
    let keep = 0;
    for (const p of this.puffs) {
      const age = (now - p.born) / p.life;
      if (age >= 1) continue;
      this.puffs[keep++] = p;
      if (age < 0) continue;
      const spread = 1 + age;
      const [sx, sy] = toScreen(p.x, p.y);
      const cx = sx + p.ox * spread * r, cy = sy - p.oy * spread * r;
      const rad = r * p.size * (1 + (EXHAUST.PUFF_GROWTH - 1) * Math.sqrt(age));
      if (cx < -rad || cy < -rad || cx > w + rad || cy > h + rad) continue;
      ctx.globalAlpha = p.alpha * (1 - age) * (1 - age);
      ctx.drawImage(this.sprite(p.color), cx - rad, cy - rad, rad * 2, rad * 2);
    }
    this.puffs.length = keep;
    ctx.restore();
  }

  /** Drop points beyond HISTORY_M of path. */
  private trimHistory(tail: Tail): void {
    const pts = tail.pts;
    let len = 0;
    for (let i = pts.length - 2; i >= 2; i -= 2) {
      len += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
      if (len > HISTORY_M) {
        pts.splice(0, i - 2);
        return;
      }
    }
  }

  /**
   * The air the car pushes through: an envelope that wraps the front of the
   * dot like a bow wave, hugs its sides, then streams back along the recent
   * path, narrowing to a point and fading out. Two layers, a wide faint sheath
   * over a tighter core, so the edge reads soft.
   */
  private drawTrail(
    ctx: CanvasRenderingContext2D, tail: Tail, car: ExhaustCar, color: string,
    toScreen: (x: number, y: number) => [number, number], scale: number, r: number, dpr: number,
  ): void {
    const over = car.speed - EXHAUST.TRAIL_START_SPEED;
    if (over <= 0) return;
    // 0 at the start speed, 1 at full: length, width and opacity all grow with it.
    const pace = Math.min(1, over / (EXHAUST.TRAIL_FULL_SPEED - EXHAUST.TRAIL_START_SPEED));
    const lengthM = Math.max(over * EXHAUST.TRAIL_LENGTH_PER_MS, (pace * EXHAUST.TRAIL_MIN_PX * dpr) / scale);

    // The centreline in screen px, car first, each point with its fraction along the trail.
    const [hx, hy] = toScreen(car.x, car.y);
    const xs = [hx], ys = [hy], us = [0];
    const pts = tail.pts;
    let wx = car.x, wy = car.y, done = 0;
    for (let i = pts.length - 2; i >= 0 && done < lengthM; i -= 2) {
      let bx = pts[i], by = pts[i + 1];
      let seg = Math.hypot(bx - wx, by - wy);
      if (seg < 1e-3) continue;
      if (done + seg > lengthM) {
        // Cut the last segment at the trail's end.
        const f = (lengthM - done) / seg;
        bx = wx + (bx - wx) * f;
        by = wy + (by - wy) * f;
        seg = lengthM - done;
      }
      done += seg;
      wx = bx; wy = by;
      const [sx, sy] = toScreen(bx, by);
      // Thin out points closer than a pixel or two; keep the true end.
      if (Math.hypot(sx - xs[xs.length - 1], sy - ys[ys.length - 1]) < 1.5 * dpr && done < lengthM) continue;
      xs.push(sx); ys.push(sy); us.push(done / lengthM);
    }
    const n = xs.length;
    if (n < 2) return;
    // Scale the profile to the length actually drawn (history can be shorter than asked).
    const end = us[n - 1];
    for (let i = 1; i < n; i++) us[i] /= end;

    // Unit forward direction at each point (screen px, y down).
    const fx: number[] = [], fy: number[] = [];
    for (let i = 0; i < n; i++) {
      let dx: number, dy: number;
      if (i === 0) { dx = car.frameX; dy = -car.frameY; }
      else { dx = xs[i - 1] - xs[Math.min(n - 1, i + 1)]; dy = ys[i - 1] - ys[Math.min(n - 1, i + 1)]; }
      const m = Math.hypot(dx, dy) || 1;
      fx.push(dx / m); fy.push(dy / m);
    }

    const rgb = hexRgb(color);
    // Ease in from the threshold so the trail grows into view rather than popping on.
    const alpha = EXHAUST.TRAIL_ALPHA * Math.min(1, 0.25 + pace * 1.5) * Math.min(1, pace * 4);
    const grad = ctx.createLinearGradient(hx, hy, xs[n - 1], ys[n - 1]);
    grad.addColorStop(0, `rgba(${rgb},1)`);
    grad.addColorStop(0.3, `rgba(${rgb},0.55)`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = grad;
    for (const [widen, a] of [[EXHAUST.TRAIL_SHEATH, 0.45], [1, 1]]) {
      const R = r * EXHAUST.TRAIL_WIDTH * widen * (0.75 + 0.25 * pace);
      // Width along the trail: full around the car, easing to a point.
      const wAt = (u: number) => R * (1 - u) ** EXHAUST.TRAIL_TAPER;
      ctx.globalAlpha = alpha * a;
      ctx.beginPath();
      // Bow: half an ellipse around the front, from the left side over the nose to the
      // right, hugging the nose closer than the sides.
      ctx.ellipse(hx, hy, R * EXHAUST.TRAIL_BOW, R, Math.atan2(fy[0], fx[0]), Math.PI / 2, -Math.PI / 2, true);
      for (let i = 1; i < n; i++) { const w = wAt(us[i]); ctx.lineTo(xs[i] + fy[i] * w, ys[i] - fx[i] * w); }
      for (let i = n - 1; i >= 1; i--) { const w = wAt(us[i]); ctx.lineTo(xs[i] - fy[i] * w, ys[i] + fx[i] * w); }
      ctx.closePath();
      ctx.fill();
    }
  }

  /** A soft round glow in one colour, drawn once and stamped per puff. */
  private sprite(color: string): HTMLCanvasElement {
    let c = this.sprites.get(color);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    g.fillStyle = color;
    g.fillRect(0, 0, 64, 64);
    // Fade the colour's alpha, not toward black, so overlapping puffs stay in colour.
    g.globalCompositeOperation = 'destination-in';
    const mask = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    mask.addColorStop(0, 'rgba(0,0,0,1)');
    mask.addColorStop(0.35, 'rgba(0,0,0,0.6)');
    mask.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = mask;
    g.fillRect(0, 0, 64, 64);
    this.sprites.set(color, c);
    return c;
  }
}

/** '#rrggbb' to 'r,g,b' (anything else: white). */
function hexRgb(hex: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? `${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)}` : '255,255,255';
}

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

export interface Puff {
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

export interface Tail {
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
  private lastNow = 0;
  private frameNo = 0;

  reset(): void {
    this.tails.clear();
    this.puffs = [];
  }

  /** The recent path behind a car (while it's under its own power). */
  trail(id: number): Tail | undefined {
    return this.tails.get(id);
  }

  /** Puffs alive at `now` (s, wall clock), oldest first; the dead are dropped. Born-later ones (age < 0) are skipped. */
  livePuffs(now: number): Puff[] {
    let keep = 0;
    const shown: Puff[] = [];
    for (const p of this.puffs) {
      const age = (now - p.born) / p.life;
      if (age >= 1) continue;
      this.puffs[keep++] = p;
      if (age >= 0) shown.push(p);
    }
    this.puffs.length = keep;
    return shown;
  }

  /**
   * Move the trails and puffs on to this frame: extend each car's path, drop
   * the puffs it owes, forget cars no longer smoking. Returns the wall clock (s).
   */
  advance(cars: Array<{ car: ExhaustCar; color: string }>): number {
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
    return now;
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
}

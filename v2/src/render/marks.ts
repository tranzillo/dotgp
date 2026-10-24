import type { Surface } from '../sim/layout';
import { PHYSICS as P } from '../sim/constants';

/** What marking needs from a car (a sim Car, or a snapshot of one). */
export interface MarkSource {
  id: number;
  x: number;
  y: number;
  groove: number;
  skid: number;
  surface: Surface;
}

/**
 * How cars mark the track. Two kinds of rubber, on two layers:
 *
 *   groove  every car working its tires lays down a little rubber. Each stroke
 *           is faint and the layer is shown at a capped opacity, so the groove
 *           builds over a race into a record of where the field runs, and
 *           never paints the whole track black.
 *   skid    only real slides (overdriven tires, spins, wrecks) and torn turf:
 *           dark, and rare enough to read as events.
 *
 * Shared by the renderer, the event workers (which turn car motion into
 * strokes) and the headless incident benchmark, so measured coverage is what
 * the viewer draws.
 */

/** Opacity of one groove stroke on the groove layer. Above 3/255 so 8-bit canvases still accumulate. */
export const GROOVE_STROKE_ALPHA = 0.016;
/** The groove layer is drawn at this opacity: the darkest a fully rubbered line gets. */
export const GROOVE_DISPLAY_ALPHA = 0.4;

export interface Stroke {
  alpha: number;
  /** Width in metres. */
  width: number;
  /** Torn turf (grass) or scattered stones (gravel) rather than rubber. */
  turf: boolean;
  gravel: boolean;
}

/**
 * Chance that this stretch of travel lays a groove stroke. A fixed faint
 * stroke laid with probability proportional to tire work keeps the expected
 * deposit proportional while staying above canvas quantization.
 */
export function grooveChance(car: { groove: number }): number {
  return car.groove;
}

/** Width (m) of the rubber a car lays down. */
/** (Asked each time: the car's size can be an experiment's.) */
export const grooveWidth = () => P.CAR_RADIUS * 1.4;

/** The skid stroke for this stretch of travel, or null if the car isn't marking. */
export function skidStroke(car: { skid: number; surface: Surface }): Stroke | null {
  if (car.skid < 0.02) return null;
  const turf = car.surface === 'grass', gravel = car.surface === 'gravel';
  return {
    // A held slide is faint; a big one (a spin, a wreck) is dark.
    alpha: turf || gravel ? 0.25 * car.skid : 0.03 + 0.25 * car.skid * car.skid,
    width: P.CAR_RADIUS * (0.5 + 0.6 * car.skid),
    turf,
    gravel,
  };
}

/** Floats per stroke: x0, y0, x1, y1, groove, skid, ground (0 pavement, 1 grass, 2 gravel). */
export const STROKE_FIELDS = 7;
/** A car lays a stroke each time it has moved this far (m). */
const STROKE_LENGTH = 0.5;
/** Moves longer than this are teleports (respawns), not driving. */
const TELEPORT = 30;

/**
 * Turns car motion into mark strokes, one each time a car has moved half a
 * metre. Runs wherever the simulation does (an event worker); the renderer
 * only stamps what it is sent.
 */
export class StrokeCollector {
  private readonly lastPos = new Map<number, [number, number]>();
  private buf: number[] = [];

  collect(cars: Iterable<MarkSource>): void {
    for (const car of cars) {
      const prev = this.lastPos.get(car.id);
      if (prev && Math.hypot(car.x - prev[0], car.y - prev[1]) < STROKE_LENGTH) continue;
      this.lastPos.set(car.id, [car.x, car.y]);
      if (!prev || Math.hypot(car.x - prev[0], car.y - prev[1]) > TELEPORT) continue;
      if (car.groove <= 0 && car.skid < 0.02) continue;
      this.buf.push(prev[0], prev[1], car.x, car.y, car.groove, car.skid, car.surface === 'grass' ? 1 : car.surface === 'gravel' ? 2 : 0);
    }
  }

  /** The strokes since the last drain. */
  drain(): Float32Array {
    const out = Float32Array.from(this.buf);
    this.buf = [];
    return out;
  }

  /** Forget where cars were (after a jump in time, so no stroke spans it). */
  reset(): void {
    this.lastPos.clear();
    this.buf = [];
  }
}

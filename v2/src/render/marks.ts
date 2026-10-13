import type { Car } from '../sim/car';
import { PHYSICS as P } from '../sim/constants';

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
 * Shared by the renderer and the headless incident benchmark, so measured
 * coverage is what the viewer draws.
 */

/** Opacity of one groove stroke on the groove layer. Above 3/255 so 8-bit canvases still accumulate. */
export const GROOVE_STROKE_ALPHA = 0.016;
/** The groove layer is drawn at this opacity: the darkest a fully rubbered line gets. */
export const GROOVE_DISPLAY_ALPHA = 0.4;

export interface Stroke {
  alpha: number;
  /** Width in metres. */
  width: number;
  turf: boolean;
}

/**
 * Chance that this stretch of travel lays a groove stroke. A fixed faint
 * stroke laid with probability proportional to tire work keeps the expected
 * deposit proportional while staying above canvas quantization.
 */
export function grooveChance(car: Car): number {
  return car.groove;
}

/** Width (m) of the rubber a car lays down. */
export const GROOVE_WIDTH = P.CAR_RADIUS * 1.4;

/** The skid stroke for this stretch of travel, or null if the car isn't marking. */
export function skidStroke(car: Car): Stroke | null {
  if (car.skid < 0.02) return null;
  const turf = car.surface === 'grass';
  return {
    // A held slide is faint; a big one (a spin, a wreck) is dark.
    alpha: turf ? 0.25 * car.skid : 0.03 + 0.25 * car.skid * car.skid,
    width: P.CAR_RADIUS * (0.5 + 0.6 * car.skid),
    turf,
  };
}

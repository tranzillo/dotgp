import { DRIVER_LAYERS } from '../ai/drivers';
import { fearScale } from '../ai/fear';
import { inputWeightMask } from '../ai/network';
import { OBS_SIZE } from '../ai/observe';
import type { Rng } from '../ai/rng';
import { RADIO_SIZE } from '../ai/spotter';
import type { Track } from '../sim/track';
import { DrillTrial } from './drill';
import { PACK_SIZE, RacecraftDrill, type PackLayout, type PackSpot, type RacecraftResult } from './racecraftLesson';

/**
 * Circuit racecraft: racing in traffic on road circuits without wrecking
 * anyone. The oval racecraft lesson's drills and scoring (distance, less
 * damage taken, damage done by fault, and fear by nerve; solo driving held to
 * how the student drove when the class began), on circuits, with valid laps
 * (an excursion throws the lap's progress away), training the road-course
 * skill. Two kinds of drill: the launch (a standing start from a staggered
 * grid into the first corners, where first-lap wrecks happen) and a pack
 * strung out on a straight into the corners after it.
 */

/** Seconds a drill runs: a launch reaches the first few corners, a pack two or three. */
export const ROADCRAFT_SECONDS = 50;
/** Share of drills that are launches. */
const LAUNCH_SHARE = 0.35;
/** A circuit grid: a box every 8 m (the rulebook's pitch), the two columns staggered by half that. */
const GRID_PITCH = 8;
const GRID_LANE = 3;

/**
 * The weights circuit racecraft trains: all but the first layer's from the
 * pit and caution inputs (zero on track under green, so their gradient is
 * only noise). The radio's train now: traffic is the lesson.
 */
export const ROADCRAFT_WEIGHTS = inputWeightMask(DRIVER_LAYERS, OBS_SIZE + RADIO_SIZE, DRIVER_LAYERS[0]).map((v) => 1 - v);

/** The launch: the field in grid boxes behind the line, standing, lights out at once. */
export function launchLayout(track: Track): PackLayout {
  return {
    frontS: track.length - 10,
    spots: Array.from({ length: PACK_SIZE }, (_, k): PackSpot => ({
      back: k * GRID_PITCH / 2, lane: k % 2 === 0 ? -GRID_LANE : GRID_LANE, speed: 0, tire: 1,
    })),
  };
}

/**
 * A pack strung out on a straight: cars nose to tail or side by side, lanes
 * across the track, at straight-line speeds, tires part worn, with the next
 * corners ahead.
 */
export function straightPackLayout(track: Track, frontS: number, rng: Rng): PackLayout {
  const spots: PackSpot[] = [];
  const lanes = track.halfWidth - 2;
  let back = 0;
  for (let k = 0; k < PACK_SIZE; k++) {
    if (k > 0) back += rng.next() < 0.35 ? rng.next() * 3 : 6 + 14 * rng.next(); // alongside, or behind
    spots.push({ back, lane: -lanes + 2 * lanes * rng.next(), speed: 32 + 14 * rng.next(), tire: 0.4 + 0.6 * rng.next() });
  }
  return { frontS: frontS + back, spots }; // the back of the pack starts where the straight does
}

/** This round's drill: a launch, or a pack on a straight (starting at `straightS`). */
export function roadcraftLayout(track: Track, straightS: number, rng: Rng): PackLayout {
  return rng.next() < LAUNCH_SHARE ? launchLayout(track) : straightPackLayout(track, straightS, rng);
}

/** One student's drill in a circuit racecraft round: the same pack around every candidate. */
export function roadcraftDrill(
  track: Track, slot: number, candidate: Float32Array, own: number, classmates: Float32Array[], layout: PackLayout, nerve?: number, pace?: number,
): RacecraftDrill {
  return new RacecraftDrill(track, slot, candidate, (k) => classmates[(own + k) % classmates.length], layout, fearScale(nerve),
    { seconds: ROADCRAFT_SECONDS, validLaps: true, pace });
}

/**
 * One round: every candidate races its own drill from the same slot, in the
 * same pack (the class's current road-course skills, by slot); solo driving is
 * held to each student's skill as it was when the class began.
 */
export class RoadcraftTrial extends DrillTrial<RacecraftResult> {
  constructor(
    track: Track, candidates: Float32Array[], perStudent: number, slot: number, classmates: Float32Array[], show: number,
    layout: PackLayout, nerves: Array<number | undefined>, references: Float32Array[],
  ) {
    const pack = classmates.map((w) => w.slice());
    super(candidates.map((g, i) => roadcraftDrill(track, slot, g, Math.floor(i / perStudent), pack, layout, nerves[Math.floor(i / perStudent)])),
      perStudent, show, candidates, { track, references });
  }
}

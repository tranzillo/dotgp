import { DRIVER_LAYERS } from '../ai/drivers';
import { fearScale } from '../ai/fear';
import { inputWeightMask } from '../ai/network';
import { OBS_SIZE } from '../ai/observe';
import type { Rng } from '../ai/rng';
import { RADIO_SIZE } from '../ai/spotter';
import type { Track } from '../sim/track';
import { referenceLap } from '../ai/costs';
import { brakingSpots, chicanes } from '../sim/features';
import { DrillTrial } from './drill';
import { PACK_SIZE, RacecraftDrill, type PackLayout, type PackSpot, type RacecraftResult } from './racecraftLesson';

/**
 * Circuit racecraft: racing in traffic on road circuits without wrecking
 * anyone. Besides the launch and the open-straight pack, two situations
 * where circuit packs wreck (scripts/situations.ts measures them): a big pack
 * braking from a long straight into a tight corner, and a pack through a
 * chicane and out of it. The oval racecraft lesson's drills and scoring (distance, less
 * damage taken, damage done by fault, and fear by nerve; solo driving held to
 * how the student drove when the class began), on circuits, with valid laps
 * (an excursion throws the lap's progress away), training the road-course
 * skill. Two kinds of drill: the launch (a standing start from a staggered
 * grid into the first corners, where first-lap wrecks happen) and a pack
 * strung out on a straight into the corners after it.
 */

/** Seconds a drill runs: a launch reaches the first few corners, a pack two or three. */
export const ROADCRAFT_SECONDS = 50;
/** Share of drills that are situations (half braking packs, half chicanes; default) and, of the rest, launches. */
export const SITUATION_SHARE = 0.5;
const LAUNCH_SHARE = 0.5;
/** A situation's pack: twelve cars, run until they're through (it takes a big pack about 15 s). */
export const SITUATION_PACK = 12;
const SITUATION_SECONDS = 25;
/** The pack starts at the top of the approach (the reference lap's fastest point on it), no more than this far from the feature (m). */
const APPROACH = { braking: 400, chicane: 300 } as const;
const ROW_GAP = 9; // m
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

export type Situation = 'braking' | 'chicane';

/** Where each situation of a kind is on a track: the feature's start and end. */
export function situationsOn(track: Track, kind: Situation): Array<{ s0: number; s1: number }> {
  return kind === 'braking' ? brakingSpots(track).map((b) => b.corner) : chicanes(track);
}

/**
 * A situation's pack: rows two or three wide (files at least 4 m apart, 2 m
 * clear of the edges), the front at the top of the approach to the feature
 * (the reference lap's fastest point on it, before anyone brakes), everyone
 * at that speed.
 */
export function situationLayout(track: Track, feature: { s0: number }, kind: Situation, rng: Rng, size = SITUATION_PACK): PackLayout {
  const ref = referenceLap(track);
  let front = feature.s0 - 60, top = 0;
  for (let back = 60; back <= APPROACH[kind]; back += 2) {
    if (Math.abs(track.curvatureAt(feature.s0 - back)) > 1e-4) break; // the straight's start
    const v = ref.speed[track.indexAt(feature.s0 - back)];
    if (v > top) { top = v; front = feature.s0 - back; }
  }
  const at = track.indexAt(feature.s0 - 50);
  const abreast = Math.max(1, Math.min(3, Math.floor((track.innerEdge(at) - track.outerEdge(at) - 4) / 4)));
  const spots: PackSpot[] = [];
  for (let k = 0; k < size; k++) {
    const row = Math.floor(k / abreast), file = k % abreast;
    const back = row * ROW_GAP + (file % 2) * ROW_GAP / 2 - (rng.next() - 0.5) * 2;
    const i = track.indexAt(front - back);
    const lo = track.outerEdge(i) + 2, hi = track.innerEdge(i) - 2;
    spots.push({ back, lane: lo + ((file + 0.5) / abreast) * (hi - lo) + (rng.next() - 0.5), speed: top + (rng.next() - 0.5), tire: 1 });
  }
  return { frontS: track.wrapS(front), spots, seconds: SITUATION_SECONDS };
}

/**
 * This round's drill: a situation (a braking pack or a chicane, if the track
 * has one; `situations` is their share), else a launch or a pack on a
 * straight (starting at `straightS`).
 */
export function roadcraftLayout(track: Track, straightS: number, rng: Rng, situations = SITUATION_SHARE): PackLayout {
  if (rng.next() < situations) {
    const kind: Situation = rng.next() < 0.5 ? 'braking' : 'chicane';
    const options = situationsOn(track, kind);
    if (options.length) return situationLayout(track, options[rng.int(options.length)], kind, rng);
  }
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

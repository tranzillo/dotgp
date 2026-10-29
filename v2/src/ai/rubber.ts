import { Car } from '../sim/car';
import type { Track } from '../sim/track';
import { World } from '../sim/world';
import { STROKE_FIELDS } from '../render/marks';
import { fastestLine, followRacingLine, grooves, type RacingLine } from './racingLine';
import { Rng } from './rng';

/**
 * The rubber an oval's grooves carry before a race: practice laps, driven. A car laps each groove (the racing line
 * and every lane across the road) below the limit, and its tyres mark the road as in a race (the same strokes, the
 * same tyre work). Each path gets laps by how close it laps to the line: the field drives the quick ones, so a
 * lane as quick as the line is as dark as it, and a slow one stays clean. Where an oval has two grooves (a high and
 * a low), the viewer sees both from the first lap. Visual only: rubber doesn't change grip.
 *
 * Strokes in the StrokeCollector layout, ready to stamp; none on road layouts.
 */
export function trackRubber(track: Track, margin?: number): Float32Array {
  const lanes = grooves(track, margin);
  if (!lanes.length) return new Float32Array(0);
  const line = fastestLine(track, margin);
  const best = line.at(FIELD_GRIP).lapTime;
  const out: number[] = [];
  const rng = new Rng(0x5eed);
  for (const path of [line, ...lanes]) {
    const slower = Math.max(0, path.at(FIELD_GRIP).lapTime / best - 1);
    const laps = Math.round(LAPS * Math.exp(-slower / LANE_FALLOFF));
    if (!laps) continue;
    const lap = drive(track, path);
    for (let k = 0; k < laps; k++) {
      // Drivers aren't on rails: each lap a little across from the last.
      const shift = (rng.next() - 0.5) * 2 * WANDER;
      for (let i = 0; i + STROKE_FIELDS <= lap.length; i += STROKE_FIELDS) {
        const x0 = lap[i], y0 = lap[i + 1], x1 = lap[i + 2], y1 = lap[i + 3];
        const len = Math.hypot(x1 - x0, y1 - y0) || 1, nx = (-(y1 - y0) / len) * shift, ny = ((x1 - x0) / len) * shift;
        out.push(x0 + nx, y0 + ny, x1 + nx, y1 + ny, lap[i + 4], 0, 0);
      }
    }
  }
  return Float32Array.from(out);
}

/** One lap's strokes on a path, at FIELD_GRIP below the limit, from a flying start (a lap to get up to speed). */
function drive(track: Track, path: RacingLine): number[] {
  const world = new World(track, { collisions: false, drafting: false, wearScale: 0 });
  const car = new Car(0);
  car.placeOnTrack(track, 0, path.d[0]);
  world.addCar(car, { decide: (c, w) => followRacingLine(c, w, path, PRACTICE_GRIP) });
  while (car.dist < track.length) world.step();
  const strokes: number[] = [];
  let x = car.x, y = car.y, work = 0, steps = 0;
  while (car.dist < 2 * track.length) {
    world.step();
    work += car.groove;
    steps++;
    if (Math.hypot(car.x - x, car.y - y) < STROKE_LENGTH) continue;
    strokes.push(x, y, car.x, car.y, work / steps, 0, 0);
    x = car.x; y = car.y; work = 0; steps = 0;
  }
  return strokes;
}

/** The share of grip a path's pace is judged at: the field's, as the racing line is laid out for. */
const FIELD_GRIP = 0.86;
/** Practice laps run below the limit. */
const PRACTICE_GRIP = 0.8;
/** Laps on the racing line (fewer on slower lanes): light rubber, about half as dark as a long race leaves the line. */
const LAPS = 40;
/** A lane this much slower a lap (a fraction) gets about a third of the line's laps. (Sets the look, not the racing.) */
const LANE_FALLOFF = 0.005;
/** How far either way across a practice lap wanders from its path (m). */
const WANDER = 0.6;
/** Metres a stroke covers (longer than a race's: a few hundred laps' worth to stamp, not one car's). */
const STROKE_LENGTH = 2;

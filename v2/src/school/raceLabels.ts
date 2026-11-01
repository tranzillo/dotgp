/**
 * Race labelling for the oval caution skill: the whole stable races itself (every car a student, each with all its
 * skills, driving its own cautions), and each car's own teacher says from where the car really is what it would do
 * (the apprenticeship's Recorder, the student always driving).
 *
 * Why (2026-10-31, experiments/2026-10-31-caution-race-labels): the apprenticeship's classroom races put 4-8 students
 * in a field of teachers, so a student paces behind cars that pace cleanly; in races the field is students, with
 * wrecks across the track and the queue caught at 45 m/s. Raced among themselves, v8's caution networks missed 57% of
 * the moments their teachers braked in; a copy trained on the field's moments from two such races missed 25% and put
 * fewer cars out on every bigger oval.
 */
import { adaptWeights, CAUTION_FROM, DRIVER_LAYERS, neuralTeam, PIT_NET_LAYERS, type NeuralDriver } from '../ai/drivers';
import type { Example } from '../ai/network';
import { mirrorPitFine, randomTraits, StrategistCrewChief } from '../ai/pitting';
import { Rng } from '../ai/rng';
import { TrafficRacer } from '../ai/trafficRacer';
import { PaceCarDriver } from '../ai/formation';
import { Car } from '../sim/car';
import { PHYSICS as P } from '../sim/constants';
import { placeOnGrid } from '../sim/grid';
import { Race } from '../sim/race';
import type { Track } from '../sim/track';
import { World } from '../sim/world';
import { OVAL_RULES } from '../rules/rulebook';
import { hashSeed } from '../trackgen/generator';
import { teacherOf } from './ovalApprentice';
import { TEACHING_DRIVE_GAIN } from './pitSkill';
import { Recorder } from './recorder';
import { wreckInLine } from './wreckDrill';

/** A bundle's driver, as raced (the fields incidents.ts races with). */
export interface RaceDriver {
  lineage: number; nerve: number; talent: number; limits: { latency: number; noise: number };
  weights: number[]; knowledge?: { grip: number; margin: number };
  caution?: { weights: number[] }; pit?: { weights: number[] }; broken?: { weights: number[] }; tactics?: { weights: number[] };
  cautionLicensed?: boolean; pitLicensed?: boolean; pitTrafficLicensed?: boolean; brokenLicensed?: boolean;
}

export interface LabelledRaceOptions {
  /** Race length (km). */
  km?: number;
  /** Share of the moments recorded. */
  sample?: number;
  /** Debris cautions per lap, and the share of them that leave wrecks on track (wreckDrill.ts). */
  debris?: number;
  wrecks?: number;
  /**
   * What is labelled: 'cautions' (default), every car's own teacher driving off pit road (the caution skill's moments
   * and racing ones); 'stops', the pit maneuver during each car's stops, its pit skill driving them, with the pit
   * skill's own inputs (as the pit drills record them: src/school/pitSkill.ts).
   */
  skill?: 'cautions' | 'stops';
}

/** Floats a recorded moment takes: the driver (its index in the roster), what it saw, its teacher's label. */
export const ROW = 1 + DRIVER_LAYERS[0] + 2;
/** The same for a skill's moments (a stop's take the pit skill's own inputs too). */
export const rowSize = (skill: LabelledRaceOptions['skill'] = 'cautions') => 1 + (skill === 'stops' ? PIT_NET_LAYERS[0] : DRIVER_LAYERS[0]) + 2;

/**
 * One race of the stable among itself, `seed` choosing who starts where (cars rotate through the roster). Returns the
 * moments recorded (ROW floats each) and what happened.
 */
export function labelledRace(track: Track, roster: RaceDriver[], seed: number, opts: LabelledRaceOptions = {}): {
  rows: Float32Array; out: number; cautions: number; pacing: number; green: number;
} {
  const km = opts.km ?? 80, sample = opts.sample ?? 0.04, stops = opts.skill === 'stops';
  const rng = new Rng(hashSeed(seed, 'race labels'));
  const world = new World(track, { collisions: true, drafting: true, wearScale: 4 });
  const examples: Example[][] = [];
  const who: number[] = [];
  for (let k = 0; k < Math.min(40, track.maxField); k++) {
    const car = new Car(k);
    placeOnGrid(car, track, k, true);
    const i = (k + seed) % roster.length;
    const d = roster[i];
    const chief = new StrategistCrewChief(randomTraits(() => rng.next()));
    const team = neuralTeam(adaptWeights(Float32Array.from(d.weights)), chief, (d.pitLicensed && d.pitTrafficLicensed) ?? false,
      d.cautionLicensed ?? false, d.knowledge, {
        limits: { ...d.limits, seed: hashSeed(seed, `hands${k}`) },
        caution: d.caution && adaptWeights(Float32Array.from(d.caution.weights)),
        pit: d.pit && adaptWeights(Float32Array.from(d.pit.weights)),
        broken: d.brokenLicensed && d.broken ? adaptWeights(Float32Array.from(d.broken.weights)) : undefined,
        tactics: d.tactics && Float32Array.from(d.tactics.weights),
      });
    const { style, traits } = teacherOf(d);
    const mine: Example[] = [];
    examples.push(mine);
    who.push(i);
    if (stops) {
      // The maneuver labels each stop from where the car is (its throttle in proportion, as a teacher's has to be).
      team.autopilot.driveGain = TEACHING_DRIVE_GAIN;
      world.addCar(car, new Recorder(team, team.driver as NeuralDriver, null, { kind: 'student' }, mine, rng,
        { skill: 'stops', sample, extra: (_c, _w, mirrored) => { const x = team.pitFine.slice(); if (mirrored) mirrorPitFine(x); return x; } }));
    } else {
      world.addCar(car, new Recorder(team, team.driver as NeuralDriver, new TrafficRacer(style, undefined, { ...traits, reaction: 0 }),
        { kind: 'student' }, mine, rng, { latency: d.limits.latency, sample }));
    }
  }
  const laps = Math.max(5, Math.round((km * 1000) / track.length));
  const race = new Race(world, laps, new PaceCarDriver(), { rulebook: OVAL_RULES, seed });
  const debrisPerSecond = (opts.debris ?? 0) / 30;
  let wreckDue = false;
  while (race.state !== 'finished' && world.time < laps * 300) {
    race.step();
    const ctl = race.control!;
    if (debrisPerSecond && ctl.flag === 'green' && race.started && rng.next() < debrisPerSecond * P.DT) {
      ctl.debrisCaution();
      wreckDue = !!opts.wrecks && rng.next() < opts.wrecks;
    }
    if (wreckDue && ctl.flag === 'caution' && ctl.pickedUp) {
      wreckDue = false;
      wreckInLine(world, rng, () => true);
    }
  }
  const n = examples.reduce((a, e) => a + e.length, 0);
  const row = rowSize(opts.skill);
  const rows = new Float32Array(n * row);
  let o = 0, pacing = 0;
  examples.forEach((list, k) => {
    for (const e of list) {
      rows[o] = who[k];
      rows.set(e.x.subarray(0, row - 3), o + 1);
      rows[o + row - 2] = e.y[0];
      rows[o + row - 1] = e.y[1];
      if (e.x[CAUTION_FROM] !== 0) pacing++;
      o += row;
    }
  });
  return { rows, out: world.cars.filter((c) => c.retired && !race.isFinished(c)).length, cautions: race.control!.cautions, pacing, green: n - pacing };
}

/** Recorded moments as examples (views into the rows: nothing copied), by the driver each came from. */
export function rowsToExamples(rows: Float32Array, skill?: LabelledRaceOptions['skill']): Array<{ who: number; example: Example }> {
  const out: Array<{ who: number; example: Example }> = [];
  const mask = Float32Array.of(1, 1);
  const row = rowSize(skill);
  for (let o = 0; o + row <= rows.length; o += row) {
    out.push({ who: rows[o], example: { x: rows.subarray(o + 1, o + row - 2), y: rows.subarray(o + row - 2, o + row), mask } });
  }
  return out;
}

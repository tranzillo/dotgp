/**
 * The classroom race, one for both disciplines: a full field under the race's own rules, the students seated among
 * individual traffic racers (each a personality drawn for its seat), every student recorded (what it saw, what its own
 * teacher would do from there) whoever drives. Debris cautions (safety cars on circuits) are thrown now and then so
 * every race has a few. Ovals race to the oval rules with each driver's oval teacher; circuits to the circuit rules
 * (formation lap, standing start, safety car) with its road teacher. Before, the oval apprenticeship and road cautions
 * each had their own copy.
 */
import { NeuralDriver, Team, type DriverLimits } from '../ai/drivers';
import { PaceCarDriver, type FormationTraits } from '../ai/formation';
import type { Example } from '../ai/network';
import { randomTraits, StrategistCrewChief } from '../ai/pitting';
import { Rng } from '../ai/rng';
import { TowerSpotter } from '../ai/spotter';
import { racerStyle, TrafficRacer, type RacerStyle } from '../ai/trafficRacer';
import { CIRCUIT_RULES } from '../rules/rulebook';
import { Car } from '../sim/car';
import { PHYSICS as P } from '../sim/constants';
import { placeOnGrid } from '../sim/grid';
import { Race } from '../sim/race';
import type { Track } from '../sim/track';
import { World } from '../sim/world';
import { hashSeed } from '../trackgen';
import { lineOf, teacherOf } from './ovalApprentice';
import { Recorder, type Driving, type RecorderOptions } from './recorder';

/** A stable driver in a classroom race: who it is (its teacher), its human limits, and the skills it races with. */
export interface ClassroomStudent {
  lineage: number;
  nerve: number;
  talent: number;
  limits: { latency: number; noise: number };
  /** Its oval racing skill (the driver's main network), and its oval caution skill once it has one. */
  weights: Float32Array;
  caution?: Float32Array | null;
  /** Its road racing skill and road caution skill (circuits). */
  road?: Float32Array;
  roadCaution?: Float32Array | null;
}

export interface ClassroomOptions {
  /** Cars in the race (students and racers). */
  field: number;
  laps: number;
  /** Debris cautions (safety cars) per lap. */
  debris: number;
  /** Only the start: until this many seconds after the lights (circuits' start drills). */
  startOnly?: number;
  /** More to record with what the students saw (experiments). */
  extra?: RecorderOptions['extra'];
}

/**
 * A road teacher from an oval one: what's for ovals only (smooth racing throttle, draft insurance) goes, and passing
 * (on circuits a scripted pass cost more than it gained: practice finds passing).
 */
export function roadStyle(style: RacerStyle): RacerStyle {
  return {
    ...style, driveGain: undefined, insure: undefined, pass: Infinity, ...(ROAD_PEDAL_RATE ? { pedalRate: ROAD_PEDAL_RATE } : {}),
    ...(ROAD_FOLLOW_GAIN ? { followGain: ROAD_FOLLOW_GAIN } : {}), ...(ROAD_CAUTION_GAIN ? { cautionGain: ROAD_CAUTION_GAIN } : {}),
  };
}

/** Road teachers' foot (RacerStyle.pedalRate; 0: instant). (Experiments set it.) */
const env = (k: string) => Number((typeof process !== 'undefined' && process.env[k]) || 0);
export const ROAD_PEDAL_RATE = env('ROAD_PEDAL_RATE');
/** Road teachers' following gain and caution gain (RacerStyle.followGain, cautionGain; 0: unset). (Experiments set them.) */
export const ROAD_FOLLOW_GAIN = env('ROAD_FOLLOW_GAIN');
export const ROAD_CAUTION_GAIN = env('ROAD_CAUTION_GAIN');

/**
 * A driver's own road teacher: the traffic racer its personality makes, as on ovals (its grip, line, room, caution
 * manners), as a road racer.
 */
export function roadTeacherOf(d: { lineage: number; nerve: number; talent: number }): { style: RacerStyle; traits: FormationTraits } {
  const { style, traits } = teacherOf(d);
  return { style: roadStyle(style), traits };
}

/** Roughly a lap (s), for the debris rate; and the most a lap may take before the race is called off (s). */
const lapSeconds = (track: Track) => (track.kind === 'road' ? 90 : 30);
const lapLimit = (track: Track) => (track.kind === 'road' ? 600 : 300);

/**
 * One classroom race. The teacher that labels a student's moments is its own (for the track's discipline), reacting
 * to flags at once: the student's own latency is its delay, and a teacher that also waited its personal reaction time
 * would answer the same moment differently from one time to the next. Returns how many cars went out and how many
 * cautions there were.
 */
export function classroomRace(
  track: Track, students: ClassroomStudent[], driving: Driving, examples: Example[][], rng: Rng, opts: ClassroomOptions,
  round: number, seed: number,
): { out: number; cautions: number } {
  const road = track.kind === 'road';
  const world = new World(track, { collisions: true, drafting: true, wearScale: 4 });
  // Students spread through the field (a different spread each round), the rest individual racers.
  const slots = new Map<number, number>();
  const order = students.map((_, i) => i).sort(() => rng.next() - 0.5);
  order.forEach((s, i) => slots.set(Math.floor(((i + rng.next()) * opts.field) / students.length) % opts.field, s));
  for (let k = 0; k < opts.field; k++) {
    const car = new Car(k);
    placeOnGrid(car, track, k, true);
    const chief = new StrategistCrewChief(randomTraits(() => rng.next()));
    const s = slots.get(k);
    if (s === undefined) {
      const who = new Rng(hashSeed(seed, `racer${round}:${k}`));
      const nerve = 0.15 + 0.7 * who.next();
      const { style, traits } = racerStyle(nerve, who.next(), () => who.next());
      const racer = new Team(new TrafficRacer(road ? roadStyle(style) : style, undefined, traits), new TowerSpotter(), chief, false, true);
      racer.autopilot.nerve = nerve;
      world.addCar(car, racer);
      continue;
    }
    const d = students[s];
    const limits: DriverLimits = { ...d.limits, seed: hashSeed(seed, `hands${round}:${d.lineage}`) };
    const student = road
      ? new NeuralDriver(d.weights, d.road, lineOf(d), { limits, roadCaution: d.roadCaution ?? undefined })
      : new NeuralDriver(d.weights, undefined, lineOf(d), { limits, caution: d.caution ?? undefined });
    const team = new Team(student, new TowerSpotter(), chief, false, true);
    team.autopilot.nerve = d.nerve;
    const { style, traits } = road ? roadTeacherOf(d) : teacherOf(d);
    world.addCar(car, new Recorder(team, student, new TrafficRacer(style, undefined, { ...traits, reaction: 0 }), driving, examples[s], rng,
      { latency: d.limits.latency, extra: opts.extra }));
  }
  const race = new Race(world, opts.laps, new PaceCarDriver(), road ? { rulebook: CIRCUIT_RULES, seed: hashSeed(seed, `race${round}`) } : undefined);
  const debrisPerSecond = opts.debris / lapSeconds(track);
  let lightsAt = -1;
  while (race.state !== 'finished' && world.time < opts.laps * lapLimit(track)) {
    race.step();
    const ctl = race.control!;
    if (opts.startOnly !== undefined) {
      if (lightsAt < 0 && race.started && ctl.flag === 'green') lightsAt = world.time;
      if (lightsAt >= 0 && world.time - lightsAt > opts.startOnly) break;
      if (world.time > 300) break; // a start that never comes
      continue;
    }
    if (ctl.flag === 'green' && race.started && rng.next() < debrisPerSecond * P.DT) ctl.debrisCaution();
  }
  return { out: world.cars.filter((c) => c.retired && !race.isFinished(c)).length, cautions: race.control!.cautions };
}

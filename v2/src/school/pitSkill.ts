/**
 * Pit stops for the stable: each driver's own pit network learns the whole
 * stop (the in-lap from the call, pit road under the limit, the box, out
 * through the blend lane and merging), on ovals and road circuits alike,
 * from the scripted pit maneuver: the teacher for now, as the line follower
 * and the traffic racer are for racing. The maneuver drives the first round
 * (a student new to stops watches); then the student drives through its own human
 * limits (DAgger), the maneuver saying at every decision what it would do
 * from where the car is. Only the pit network learns, so stops can't cost a
 * driver its racing.
 */
import { adaptPitWeights, NeuralDriver, PIT_NET_LAYERS, Team, type DriverLimits } from '../ai/drivers';
import { type Example, trainSupervised } from '../ai/network';
import type { TrackKnowledge } from '../ai/observe';
import { mirrorPitFine } from '../ai/pitting';
import { fastestLine } from '../ai/racingLine';
import { Rng } from '../ai/rng';
import { TowerSpotter } from '../ai/spotter';
import { Car, type PitState } from '../sim/car';
import { PHYSICS as P, PIT_SERVICE } from '../sim/constants';
import type { Track } from '../sim/track';
import { World } from '../sim/world';
import { hashSeed } from '../trackgen';
import { apprenticeTrack } from './ovalApprentice';
import { Recorder } from './recorder';
import { inLapStart, startInLap, START_SPEED } from './pitLesson';
import { PITTERS, RACERS } from './pitTrafficLesson';
import { DEFAULT_STYLE, TrafficRacer } from '../ai/trafficRacer';
import { circuitTrack } from './roadLesson';
import { OVAL_RULES } from '../rules/rulebook';

/** A driver as far as pit stops go: its skills (the pit skill once it has one), its line and its human limits. */
export interface PitStudent {
  lineage: number;
  limits?: { latency: number; noise: number };
  knowledge?: TrackKnowledge;
  weights: Float32Array;
  road?: Float32Array;
  pit: Float32Array | null;
}

export interface PitSkillOptions {
  rounds?: number;
  /** Ovals and circuits per round (each driven from two lanes). */
  ovals?: number;
  circuits?: number;
  epochs?: number;
  maxExamples?: number;
  /**
   * Overshoot drills per track (alone), on top of the stop alone and the stop in traffic. None by default: the
   * teacher's own overshoots in the ordinary drills teach backing up as well (RESULTS 2026-10-25).
   */
  overshoots?: number;
  /** Crowded drills per track: the student coming in with a column of cars all stopping the same lap. */
  crowds?: number;
  onRound?: (round: number, report: { loss: number; stops: number; completed: number; overshoots: number; recovered: number; crowds: number; crowdsDone: number; caught: number; seconds: number }) => void;
}

/** The pit maneuver's throttle as a teacher (1/s): see PitAutopilot.driveGain. */
const TEACHING_DRIVE_GAIN = 4;

/**
 * Seconds a drill runs at most: the in-lap, the stop, and out until merged (on a superspeedway the blend lane can
 * end most of a lap after the box); then a few seconds racing on.
 */
const DRILL_SECONDS = 200;
const AFTER_MERGE = 5;
/**
 * An overshoot drill: as the car nears its box it finds itself this far past it (m), stopped, and backs up into it
 * (pit road has reverse: car.ts). Learned from the in-lap alone, a stop past the box was a state pit drivers had
 * never seen: they sat there, in neither their box nor past it, for the rest of a race.
 */
const OVERSHOOT = [4, 14] as const;
/**
 * A crowded drill: the whole field stopping the same lap (a caution's stops). CROWD cars on their in-laps with the
 * student, a column two wide, rows CROWD_GAP apart (m), the student's place in it drawn, at a share of the in-lap's speed
 * (CROWD_SPEED: caution pace to green); every car's box drawn along pit road, so cars stop and pull out in the
 * student's path. In CROWD_WRECK of them a car ahead breaks down on pit road and sits there CROWD_WRECK_HOLD (s). Pit
 * drivers that only ever stopped alone or with two others drove into stopped cars at the limit: a caution's stops
 * were most of a race's retirements (RESULTS 2026-10-25).
 */
const CROWD = 10;
const CROWD_GAP = 12;
const CROWD_SPEED = [0.6, 1] as const;
const CROWD_WRECK = 0.3;
const CROWD_WRECK_HOLD = 12;

/**
 * One drill: the car on its in-lap with a stop called, the student or the maneuver driving; in traffic, two cars
 * ahead stopping too (the maneuver driving them) and four racing past (traffic racers), as the pit-traffic lesson
 * places them. Returns whether the stop got done.
 */
function drill(track: Track, d: PitStudent, studentDrives: boolean, lane: number, examples: Example[], seed: number, traffic = false, overshoot = 0, crowd = false, tally?: { caught: number },
): boolean {
  const world = new World(track, { collisions: traffic || crowd, drafting: traffic || crowd, autoClearWrecks: !crowd });
  const limits: DriverLimits | undefined = d.limits && { ...d.limits, seed };
  const student = new NeuralDriver(d.weights, d.road, d.knowledge, { limits, pit: d.pit ?? undefined });
  const team = new Team(student, new TowerSpotter(), null, studentDrives);
  const car = new Car(0);
  // Every moment of the stop is recorded (a stop is short, and each part of it happens once).
  // (Each moment with the pit skill's own inputs as the recorder saw them: mirrored with the student's view.)
  const fine = (_c: Car, _w: World, mirrored: boolean) => { const x = team.pitFine.slice(); if (mirrored) mirrorPitFine(x); return x; };
  world.addCar(car, new Recorder(team, student, null, { kind: studentDrives ? 'student' : 'teacher' }, examples, new Rng(seed), { skill: 'stops', sample: 1, extra: fine }));
  const s = inLapStart(track);
  car.placeOnTrack(track, s, lane);
  // On ovals at the in-lap's usual speed; on circuits at what the line takes there.
  const crowdRng = new Rng(hashSeed(seed, 'crowd'));
  const fullSpeed = track.kind === 'road' ? Math.min(START_SPEED, speedAt(track, s)) : START_SPEED;
  const speed = crowd ? fullSpeed * (CROWD_SPEED[0] + (CROWD_SPEED[1] - CROWD_SPEED[0]) * crowdRng.next()) : fullSpeed;
  car.vx = track.tx[car.trackIdx] * speed;
  car.vy = track.ty[car.trackIdx] * speed;
  car.pit.phase = 'in';
  car.pit.call = { tires: true, fuel: 15, repair: false };
  // A teacher's throttle has to be one a student can copy: in proportion, not flat out below its speed.
  team.autopilot.driveGain = TEACHING_DRIVE_GAIN;
  team.autopilot.begin(car);
  if (traffic) {
    const racer = () => new TrafficRacer(track.kind === 'road' ? { ...DEFAULT_STYLE, pass: Infinity } : DEFAULT_STYLE);
    for (const [ahead, l] of PITTERS) {
      const other = new Car(world.cars.length);
      const t = new Team(racer(), new TowerSpotter(), null, false, true);
      world.addCar(other, t);
      startInLap(other, t, track, ahead, l);
      setSpeed(other, track, speed);
    }
    for (const [ahead, l] of RACERS) {
      const other = new Car(world.cars.length);
      world.addCar(other, new Team(racer(), new TowerSpotter(), null, false, true));
      other.placeOnTrack(track, s + ahead, l);
      setSpeed(other, track, track.kind === 'road' ? Math.min(START_SPEED, speedAt(track, s + ahead)) : START_SPEED);
    }
  }
  // Its box anywhere along pit road, as in a race. (Always the first box, 25-50 m past the limit line, the skill only
  // ever braked for it: in races, its box far down the lane and nothing ahead, it went through the line over the limit.)
  car.pit.boxS = track.pit.stalls[Math.floor(new Rng(hashSeed(seed, 'box')).next() * track.pit.stalls.length)];
  let wreck: Car | null = null, wreckAt = -1, over = 0;
  if (crowd) {
    const racer = () => new TrafficRacer(track.kind === 'road' ? { ...DEFAULT_STYLE, pass: Infinity } : DEFAULT_STYLE);
    const stalls = track.pit.stalls;
    const boxes = shuffled(stalls.length, crowdRng);
    car.pit.boxS = stalls[boxes[0]];
    // The column, two wide: the student's place in it drawn (cars ahead of it and behind), the rest around it.
    const mine = Math.floor(crowdRng.next() * (CROWD + 1));
    const side = (slot: number) => (slot % 2 ? 2.5 : -2.5);
    car.placeOnTrack(track, s, side(mine));
    setSpeed(car, track, speed);
    for (let k = 0, slot = 0; k < CROWD; k++, slot++) {
      if (slot === mine) slot++;
      const other = new Car(world.cars.length);
      const t = new Team(racer(), new TowerSpotter(), null, false, true);
      world.addCar(other, t);
      startInLap(other, t, track, (Math.floor(mine / 2) - Math.floor(slot / 2)) * CROWD_GAP, side(slot));
      setSpeed(other, track, speed);
      other.pit.boxS = stalls[boxes[(k + 1) % boxes.length]];
    }
    // The one that breaks down: a car ahead of the student, if there is one.
    const ahead = world.cars.filter((c) => c !== car && track.distanceFrom(car.s, c.s) < track.length / 2);
    if (ahead.length && crowdRng.next() < CROWD_WRECK) wreck = ahead[Math.floor(crowdRng.next() * ahead.length)];
  }
  let serviced = false;
  const phase = (): PitState['phase'] => car.pit.phase;
  let done = -1;
  let overshot = !overshoot;
  for (let k = 0; k < DRILL_SECONDS / P.DT && !car.retired && (done < 0 || k - done < AFTER_MERGE / P.DT); k++) {
    if (!overshot && phase() === 'in' && car.surface === 'pit' && track.pitInR(car) > car.pit.boxS - 30) {
      overshot = true;
      const move = car.pit.boxS + overshoot - track.pitInR(car);
      car.placeOnTrack(track, track.wrapS(car.s + move), car.d, car.dist + move);
      car.vx = 0;
      car.vy = 0;
    }
    // The car that breaks down: some way down pit road, short of its box.
    if (wreck && wreckAt < 0 && wreck.surface === 'pit' && wreck.pit.phase === 'in' && track.pitInR(wreck) > wreck.pit.boxS - 25) {
      wreck.retired = true;
      wreckAt = world.time;
    }
    if (wreck && wreckAt >= 0 && world.time - wreckAt > CROWD_WRECK_HOLD) wreck.cleared = true;
    world.step();
    // Over the limit on pit road as the stewards judge it (the rulebook's tolerance), for how long.
    if (car.surface === 'pit' && car.speed > PIT_SERVICE.SPEED_LIMIT + OVAL_RULES.pitSpeedTolerance) over += P.DT;
    if (phase() === 'service') serviced = true;
    if (done < 0 && serviced && phase() === 'none') done = k;
  }
  // A stop the stewards would have called for speeding.
  if (tally && over > OVAL_RULES.pitSpeedGrace) tally.caught++;
  return serviced && phase() === 'none' && !car.retired;
}

/** 0..n-1 in a random order. */
function shuffled(n: number, rng: Rng): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/** A car at a speed along the track. */
function setSpeed(car: Car, track: Track, speed: number): void {
  car.vx = track.tx[car.trackIdx] * speed;
  car.vy = track.ty[car.trackIdx] * speed;
}

/** The speed the fastest line takes at a point (85% of grip), for a start that isn't already off the road. */
function speedAt(track: Track, s: number): number {
  const line = fastestLine(track), speed = line.at(0.85).speed, n = speed.length;
  return speed[((Math.round(track.wrapS(s) / line.step) % n) + n) % n];
}

/** Teach a group their pit skill (pit networks trained in place; a new one starts as a copy of the oval skill). */
export function apprenticePitSkill(students: PitStudent[], seed: number, options: PitSkillOptions = {}): void {
  const opts = { rounds: 6, ovals: 2, circuits: 2, overshoots: 0, crowds: 1, epochs: 6, maxExamples: 40_000, ...options };
  const rng = new Rng(hashSeed(seed, 'pit-skill'));
  const examples: Example[][] = students.map(() => []);
  // A driver new to stops watches the maneuver's first round; one with a pit skill drives from the start (the first
  // round's teacher-only examples, trained on alone, made it forget how to get back from its own mistakes).
  const watches = students.map((d) => !d.pit);
  // (At the pit network's size: one learned before its own inputs widens into it, ignoring them until taught them.)
  for (const d of students) d.pit = adaptPitWeights(d.pit ?? d.weights.slice());
  for (let round = 0; round < opts.rounds; round++) {
    const t0 = Date.now();
    const tracks = [
      ...Array.from({ length: opts.ovals }, (_, k) => apprenticeTrack(round * opts.ovals + k, seed)),
      ...Array.from({ length: opts.circuits }, (_, k) => circuitTrack(hashSeed(seed, `pit${round}:${k}`), k % 2 ? 'gp' : 'club')),
    ];
    let stops = 0, completed = 0, overshoots = 0, recovered = 0, crowds = 0, crowdsDone = 0;
    const tally = { caught: 0 };
    students.forEach((d, i) => {
      for (const track of tracks) {
        // One stop alone, one in traffic (as stops are in races: others pitting, the field racing past).
        for (const [lane, traffic] of [[-2, false], [2, true]] as const) {
          stops++;
          if (drill(track, d, round > 0 || !watches[i], lane, examples[i], hashSeed(seed, `hands${round}:${d.lineage}:${track.length}:${lane}`), traffic, 0, false, tally)) completed++;
        }
        // And past its box, backing up into it.
        for (let k = 0; k < opts.overshoots; k++) {
          overshoots++;
          const past = OVERSHOOT[0] + (OVERSHOOT[1] - OVERSHOOT[0]) * rng.next();
          if (drill(track, d, round > 0 || !watches[i], 0, examples[i], hashSeed(seed, `past${round}:${d.lineage}:${track.length}:${k}`), false, past)) recovered++;
        }
        // And in a crowd: the whole field stopping the same lap.
        for (let k = 0; k < opts.crowds; k++) {
          crowds++;
          if (drill(track, d, round > 0 || !watches[i], 0, examples[i], hashSeed(seed, `crowd${round}:${d.lineage}:${track.length}:${k}`), false, 0, true, tally)) crowdsDone++;
        }
      }
    });
    let loss = 0;
    students.forEach((d, i) => {
      const set = examples[i].length <= opts.maxExamples ? examples[i] : sample(examples[i], opts.maxExamples, rng);
      loss += trainSupervised(PIT_NET_LAYERS, d.pit!, set, round === 0 && watches[i] ? 3 * opts.epochs : opts.epochs, 0.01, () => rng.next());
    });
    opts.onRound?.(round, { loss: loss / students.length, stops, completed, overshoots, recovered, crowds, crowdsDone, caught: tally.caught / (stops + crowds), seconds: (Date.now() - t0) / 1000 });
  }
}

/** n of the items, drawn at random without replacement. */
function sample<T>(items: T[], n: number, rng: Rng): T[] {
  const pool = items.slice();
  for (let i = 0; i < n; i++) {
    const j = i + rng.int(pool.length - i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

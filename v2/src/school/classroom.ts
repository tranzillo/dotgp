import { Tape, TAPE_STEPS, type TapeSegment } from '../events/tape';
import { adaptWeights } from '../ai/drivers';
import {
  adamStep, centeredRanks, DEFAULT_ES, LICENSE_HEALTH, ROOKIE_DAMAGE_SHARE, rookieDamageScale, rookieDamageSeconds,
} from '../ai/es';
import { Trial, type TrialOptions, type TrialResult } from '../ai/evaluate';
import { apprenticePitStops, cleanStop, PitTrial, REFRESHER_ROUNDS, type PitTrialResult } from './pitLesson';
import { anchored, DrillTrial, racingKept, SOLO_OPTIONS } from './drill';
import { ROADCRAFT_WEIGHTS, roadcraftLayout, RoadcraftTrial, situationLayout, situationsOn, type Situation } from './roadcraftLesson';
import { apprenticeRoadCourses, ROAD_WEIGHTS, roadLicenseTest, type ApprenticeOptions } from './roadLesson';
import { bestValidLap } from '../sim/limits';
import { PACK_SIZE, RacecraftTrial, randomLayout, type PackLayout, type RacecraftResult } from './racecraftLesson';
import { apprenticePitTraffic, cleanTrafficStop, PitTrafficTrial, TRAFFIC_BASELINE_MARGIN, trafficBaseline, type PitTrafficResult } from './pitTrafficLesson';
import { CAUTION_WEIGHTS, apprenticeCautions, BASELINE_MARGIN, CautionTrial, DRILL_FIELD, scriptBaseline, type CautionResult } from './cautionLesson';
import { COSTS, lapSeconds, trackPace } from '../ai/costs';
import { genomeSize } from '../ai/network';
import { Rng } from '../ai/rng';
import { DRIVER_LAYERS } from '../ai/drivers';
import { StrokeCollector } from '../render/marks';
import type { TrackLayout } from '../sim/layout';
import type { TrainingWheels } from '../sim/car';
import { Track } from '../sim/track';
import { generateLayout, hashSeed } from '../trackgen';
import type { CarView, RadioLine, SessionSnapshot } from '../events/session';

/**
 * Driving school: a class of drivers taking a lesson, round after round, on
 * a track you can watch. Each round every student drives as a ghost
 * alongside slightly varied copies of itself (evolution strategies); when the
 * round ends each student moves toward the copies that did better. Same
 * training as headless practice, one visible track per round.
 */

export type LessonId = 'rookie' | 'variety' | 'circuits' | 'roadcraft' | 'racecraft' | 'pits' | 'pitTraffic' | 'cautions';

export interface Lesson {
  id: LessonId;
  name: string;
  description: string;
  /** Who it's for. */
  eligible: (driver: { licensed: boolean; pitLicensed?: boolean; pitTrafficLicensed?: boolean; cautionLicensed?: boolean; roadLicensed?: boolean }) => boolean;
  /** Who's eligible, in words. */
  audience: string;
  /** Seconds per round, antithetic pairs per student, learning rate. */
  seconds: number;
  pairs: number;
  learningRate: number;
  /** Only these weights train (1), if set: lessons for skills whose inputs are zero the rest of the time. */
  trains?: Float32Array;
  /** Not offered in the driving school (why); the lab can still run it. */
  withdrawn?: string;
  /** Licensed students keep practising, and the class runs until stopped: the license marks a stage, not the end. */
  practisesOn?: boolean;
  /** Practice scores progress on valid laps only (a lap past the track limits is thrown away). */
  validLaps?: boolean;
  /** Circuit racecraft: the share of drills that are situations (braking packs, chicanes); default SITUATION_SHARE. */
  situations?: number;
  /** Circuit racecraft: every round a drill of this situation, on a circuit that has one (a class focused on chicanes, say). */
  focus?: Situation;
}

export const LESSONS: Record<LessonId, Lesson> = {
  rookie: {
    id: 'rookie', name: 'Rookie school', seconds: 80, pairs: 16, learningRate: 0.03,
    eligible: (d) => !d.licensed, audience: 'rookies (no license yet)',
    description: 'Learn to drive: solo laps with soft walls that harden over the first lessons. A license comes with clean laps on every preset track at full walls.',
  },
  variety: {
    id: 'variety', name: 'Track variety', seconds: 60, pairs: 8, learningRate: 0.01,
    eligible: (d) => d.licensed, audience: 'licensed drivers',
    description: 'A new generated oval every round, so drivers learn to handle tracks they have never seen.',
  },
  circuits: {
    // A small step: at 0.02 practice made apprenticed drivers worse round after round (lab, 2026-10-17).
    id: 'circuits', name: 'Road courses', seconds: 150, pairs: 8, learningRate: 0.002, trains: ROAD_WEIGHTS,
    // Practice keeps improving road-course skills long after the license (lab, 2026-10-17), so it doesn't stop there.
    practisesOn: true,
    // Valid laps are the measure: a lap past the track limits doesn't count. In races this cut track limits by
    // 60% and all but ended corner cutting, for laps ~2% slower (lab, 2026-10-17); slower run-off alone changed
    // nothing the drivers learned.
    validLaps: true,
    eligible: (d) => d.licensed, audience: 'licensed drivers',
    description: "Learn road courses: flat corners from sweepers to hairpins, braking hard off long straights. Trains the driver's road-course skill (a second network used only on circuits, starting as a copy of its oval driving), so oval racing is never touched. A new skill first copies the line follower's laps of circuits, then practises at full tightness (real hairpins, full barriers). A new club circuit every round, starting on a random straight. Skills from before the apprenticeship carry on with the old curriculum: corners no tighter than an oval's and soft barriers at first, tightening and hardening each round the class drives cleanly. Running past the track limits invalidates the lap, and only valid laps count. The license (a test on three new circuits from the line, a valid lap on each) marks a stage: practice carries on after it, and the drivers keep getting better. Runs until stopped.",
  },
  roadcraft: {
    id: 'roadcraft', name: 'Circuit racecraft', seconds: 0, pairs: 8, learningRate: 0.002, trains: ROADCRAFT_WEIGHTS,
    withdrawn: 'headless for now: the driving school hands lessons the oval network, not the road-course skill',
    eligible: (d) => d.licensed && !!d.roadLicensed, audience: 'drivers with a road-course license',
    description: "Race in traffic on road circuits without wrecking anyone. Every round drops the class into a pack on a new circuit: a standing start from a staggered grid into the first corners, or a pack strung out on a straight into the corners after it, against the class's own driving, for 50 s. Scored as racecraft is on ovals (distance, damage taken and done by fault, fear by nerve; solo driving held to how the student drove when the class began), on valid laps. Trains the road-course skill. Runs until stopped.",
  },
  racecraft: {
    id: 'racecraft', name: 'Racecraft', seconds: 0, pairs: 8, learningRate: 0.01,
    eligible: (d) => d.licensed, audience: 'licensed drivers',
    description: "Race in a pack without wrecking anyone. Every round drops the class into a pack somewhere on a preset: a restart, or a pack strung out mid-run, against the class's own driving, for 40 s. Distance counts; so does damage, taken or done (closing on someone from behind or moving across into them is on you, being hit isn't), and fear: time spent with a collision of your own making about to happen. How much fear costs depends on the driver's nerve. Solo driving is checked too, so drivers don't lose their way round the track. Runs until stopped. Experimental: so far it makes drivers cleaner on the speedway but not yet on the short track.",
  },
  pits: {
    id: 'pits', name: 'Pit stops', seconds: 100, pairs: 8, learningRate: 0.02,
    withdrawn: 'it trains the whole driver and costs drivers their racing (lab, 2026-10-16); coming back as a separate pit-stop skill',
    eligible: (d) => d.licensed && !d.pitLicensed, audience: 'licensed drivers who don\'t do their own stops yet',
    description: 'Do your own pit stop: down to the apron, onto pit road under the limit, stop on the box, back out and merge. Students first copy the veteran crews\' pit maneuver, then practise; a pit license comes with a clean stop on every preset track, and from then on they drive their own stops in races.',
  },
  pitTraffic: {
    id: 'pitTraffic', name: 'Pit road in traffic', seconds: 0, pairs: 6, learningRate: 0.02,
    withdrawn: 'it trains the whole driver and costs drivers their racing (lab, 2026-10-16); coming back as a separate pit-stop skill',
    eligible: (d) => d.licensed && !!d.pitLicensed && !d.pitTrafficLicensed, audience: "drivers with a pit license who haven't pitted in traffic yet",
    description: "Pit with a race going on: two cars ahead pit too, so pit road has a queue, and four more keep racing around you, two of them closing from behind as you slow for pit road. Students first go back over the veteran's stop in traffic, then practise; the license comes with a clean stop in traffic (nobody hurt, no speeding) at least as quick as the veteran's on every preset. Drivers need both pit licenses to do their own stops in races.",
  },
  cautions: {
    id: 'cautions', name: 'Cautions', seconds: 0, pairs: 6, learningRate: 0.01, trains: CAUTION_WEIGHTS,
    eligible: (d) => d.licensed && !d.cautionLicensed, audience: 'licensed drivers who don\'t drive their own cautions yet',
    description: 'Drive under caution: form up behind the pace car, hold your place and lane in the line, never pass, take the restart. Drills in a small field: green, a caution for debris, a caution lap, the restart. Students first copy the formation script, then practise; the caution license comes with driving a clean drill at least as well as the script on every preset, and from then on they drive their own cautions in races.',
  },
};

/** One round's trial: ghost laps, ghost pit stops, or caution drills. */
interface LessonTrial {
  readonly world: Trial['world'];
  readonly done: boolean;
  readonly remaining: number;
  step(): void;
  results(): Array<{ fitness: number; laps: number; bestLap: number; health: number }>;
}

/** Where each car on screen comes from: a student's own car, a variation, or the drill's pack (key -1). */
type CarSource = { key: number; variant: boolean };

export interface StudentSpec {
  /** Identifies the student's cars in snapshots (index in the class). */
  key: number;
  id: string;
  name: string;
  weights: Float32Array;
  rounds: number;
  licensed: boolean;
  /** Drives its own pit stops (solo), and in traffic. */
  pitLicensed?: boolean;
  pitTrafficLicensed?: boolean;
  /** Has made a clean stop of its own on a pit road set back across grass (see setBackPitTrack). */
  setBackPits?: boolean;
  /** Drives its own cautions and restarts. */
  cautionLicensed?: boolean;
  /** Has the road-course license. (In the Road courses lesson, `weights` are the road-course skill's.) */
  roadLicensed?: boolean;
  /** Road courses: the tightest corners this driver has reached in the curriculum (m). */
  roadRadius?: number;
  /** Appetite for risk (0 timid .. 1 fearless): what fear costs it in lessons that score it. */
  nerve?: number;
}

export interface ClassSpec {
  lesson: LessonId;
  students: StudentSpec[];
  /** The preset tracks (rookie school rotates through them and tests the license on them). */
  presets: TrackLayout[];
  seed: number;
  /**
   * Road courses: apprenticeships the caller has already run (headless, in parallel), by student:
   * the skill's weights after it and the moments studied. Students without one study here.
   */
  apprenticed?: Array<{ weights: Float32Array; examples: number } | undefined>;
  /** Road courses: how new skills study the line follower (default: the lesson's usual apprenticeship). */
  apprenticeship?: ApprenticeOptions;
  /** Students keep practising after earning the lesson's license, and the class runs until stopped. */
  practiseOn?: boolean;
  /** Practice settings other than the lesson's own (experiments). */
  practice?: Partial<Pick<Lesson, 'learningRate' | 'pairs' | 'seconds' | 'trains' | 'validLaps' | 'situations' | 'focus'>>;
}

/**
 * Runs a round of ghost laps somewhere else (headless: worker threads) and
 * hands back what the in-process trial would have: every car's result in
 * order, and the simulated time the round took.
 */
export type GhostRunner = (layout: TrackLayout, genomes: Float32Array[], opts: TrialOptions) => Promise<{ results: TrialResult[]; time: number }>;

/** A circuit racecraft round as data: what a worker needs to build each candidate's drill. */
export interface RoadcraftRound {
  layout: TrackLayout;
  slot: number;
  pack: PackLayout;
  /** Per student, [own, +e1, -e1, ...]. */
  candidates: Float32Array[];
  perStudent: number;
  /** The pack's drivers: each student's current skill. */
  classmates: Float32Array[];
  nerves: Array<number | undefined>;
  /** Each student as it drove when the class began (the solo anchor). */
  references: Float32Array[];
  /** The track's own pace (m/s): progress converts to seconds at it. */
  pace: number;
}

/**
 * Runs a round somewhere else (headless: worker threads), with the results
 * the in-process trial would have had: ghost laps (every car's result, in
 * order, and the simulated time), and circuit racecraft drills (every
 * candidate's drill result, before the solo anchor, and the drill's time).
 */
export interface RoundRunner {
  ghost: GhostRunner;
  roadcraft(round: RoadcraftRound): Promise<{ results: RacecraftResult[]; time: number }>;
}

/** One student's round. */
export interface RoundReport {
  key: number;
  id: string;
  /** The class's round (the student's own count is `rounds`). */
  round: number;
  weights: Float32Array;
  rounds: number;
  licensed: boolean;
  pitLicensed: boolean;
  pitTrafficLicensed: boolean;
  setBackPits: boolean;
  cautionLicensed: boolean;
  roadLicensed: boolean;
  /** Road courses: the curriculum stage reached (tightest corners, m). */
  roadRadius?: number;
  /** Earned a license this round (which one: the lesson's). */
  graduated: boolean;
  track: string;
  /** The student's own drive this round (not a variation). */
  fitness: number;
  laps: number;
  bestLap: number | null;
  health: number;
  /** Wall damage scale (1 = full). */
  walls: number;
  /** Variations that beat the student this round. */
  beaten: number;
  /** Tracks passed toward the license (rookie school, pit stops). */
  passed: string[];
  /** Pit stop lesson: how the student's own stop went. */
  stop?: { serviced: boolean; completed: boolean; speeding: number; harm?: number };
  /** Racecraft lesson: how the student's own drill went. */
  pack?: { harm: number; gained: number };
  /** Caution lesson: how the student's own drill went. */
  caution?: { placeError: number; passes: number; harm: number };
}

export interface SchoolView {
  lesson: LessonId;
  round: number;
  track: string;
  remaining: number;
  walls: number;
  students: Array<{ key: number; id: string; name: string; rounds: number; licensed: boolean; pitLicensed: boolean; pitTrafficLicensed: boolean; cautionLicensed: boolean; roadLicensed: boolean; passed: string[]; last: RoundSummary | null }>;
  /** Road courses: the tightest corner this round's circuit may have (m). */
  roadRadius?: number;
}

/** A driving-school round kept on tape: watched, or someone earned a license in it. */
export interface RoundTape {
  round: number;
  track: string;
  layout: TrackLayout;
  /** Students (keys) who earned the lesson's license this round. */
  graduated: number[];
  watched: boolean;
  tape: TapeSegment;
}

/** A round's result without the weights (what the viewer shows). */
export type RoundSummary = Omit<RoundReport, 'weights'>;

/** A generated oval whose pit road is set back across grass (the pit lesson's every other round). */
export function setBackPitTrack(seed: number): Track {
  for (let k = 0; ; k++) {
    const variant = ['intermediate', 'speedway'][k % 2];
    const track = new Track(generateLayout({ type: 'oval', seed: hashSeed(seed, `pits${k}`), variant }));
    if (track.pit.entryRoute || k >= 60) return track;
  }
}

/** Pit stop lesson: rounds in a row without a stop before a student goes back to the veteran for a refresher. */
const STUCK_ROUNDS = 6;

interface Student extends StudentSpec {
  pitLicensed: boolean;
  pitTrafficLicensed: boolean;
  setBackPits: boolean;
  cautionLicensed: boolean;
  roadLicensed: boolean;
  /** Pit stop lesson: rounds in a row the student hasn't stopped. */
  noStop: number;
  /** How it drove when the class began (racecraft holds its solo pace to this). */
  reference: Float32Array;
  m: Float32Array;
  v: Float32Array;
  adamSteps: number;
  passed: Set<string>;
  last: RoundSummary | null;
}

/** Road courses curriculum: corners start no tighter than this (m, about an oval turn's)... */
export const ROAD_START_RADIUS = 80;
/** ...and tighten to real hairpins. */
export const ROAD_FULL_RADIUS = 13;
/** Each round most of the class drives cleanly, the tightest corner allowed shrinks by this factor. */
const ROAD_TIGHTEN = 0.9;

/** How far up the road-course curriculum a stage is: 0 at its first corners (80 m), 1 at real hairpins. */
export function roadStage(minRadius: number): number {
  return Math.min(1, Math.max(0, Math.log(ROAD_START_RADIUS / minRadius) / Math.log(ROAD_START_RADIUS / ROAD_FULL_RADIUS)));
}

/** A learner's speed limit at the curriculum's start (m/s: the first corners flat out) and where it ends (no limit at all past it). */
const LEARNER_SPEED = 25;
const LEARNER_SPEED_END = 100;

/**
 * Training wheels at a curriculum stage, for a skill learning without a
 * teacher: off-track ground forgiving at first (a beginner off at a corner
 * keeps going, so its variations still differ) and hardening to real; a speed
 * limit rising from the first corners' flat-out speed to none. None at full
 * tightness, where the apprenticed skills start.
 */
export function roadTrainingWheels(minRadius: number): TrainingWheels | undefined {
  const p = roadStage(minRadius);
  if (p >= 1) return undefined;
  return { forgiving: 1 - p, speedCap: LEARNER_SPEED * (LEARNER_SPEED_END / LEARNER_SPEED) ** p };
}

/**
 * Damage's price at a curriculum stage: rookie school's share of the full
 * price at the start (so driving on and sometimes crashing beats stopping
 * before a corner a beginner can't take yet), the full price by real
 * hairpins. Without it, beginners learned to brake to a stop (lab, 2026-10-18).
 */
export function roadDamageSeconds(minRadius: number): number {
  return COSTS.damage * (ROOKIE_DAMAGE_SHARE + (1 - ROOKIE_DAMAGE_SHARE) * roadStage(minRadius));
}

/** Variation size (ES sigma) at a curriculum stage: twice the usual at the start (a beginner far from anything good), the usual by the end. */
export function roadSigma(minRadius: number): number {
  return DEFAULT_ES.sigma * (2 - roadStage(minRadius));
}

/** The curriculum moves on when, over this many rounds, at least half of all students' drives were clean (and no sooner after its last step). */
const ROAD_GATE_ROUNDS = 10;

/** Barrier softness at a curriculum stage: soft while the corners are gentle, full at real hairpins. */
export function roadWalls(minRadius: number): number {
  const progress = (ROAD_START_RADIUS - minRadius) / (ROAD_START_RADIUS - ROAD_FULL_RADIUS);
  return Math.min(1, Math.max(0.3, 0.3 + 0.7 * progress));
}

/** A new club circuit with corners no tighter than minRadius (the next seed if one can't be laid out). */
export function roadCourseTrack(seed: number, minRadius: number, variant: 'club' | 'gp' = 'club'): Track {
  for (let k = 0; ; k++) {
    try {
      return new Track(generateLayout({ type: 'circuit', seed: hashSeed(seed, `try${k}`), variant, params: { minRadius } }));
    } catch (e) {
      if (k >= 5) throw e;
    }
  }
}

/** A start on a random straight (at least 80 m of it ahead), so a round can begin anywhere round a circuit. */
export function straightStart(track: Track, rng: Rng): number {
  const starts: number[] = [];
  for (let s = 0; s < track.length; s += 10) {
    let straight = true;
    for (let a = -10; a <= 80 && straight; a += 5) straight = Math.abs(track.curvatureAt(s + a)) < 1e-4;
    if (straight) starts.push(s);
  }
  return starts.length ? starts[rng.int(starts.length)] : track.length - 20;
}

export class Classroom {
  readonly lesson: Lesson;
  readonly students: Student[];
  round = 0;
  track!: Track;
  trial!: LessonTrial;
  /** Caution drills: the grid slot this round's students start from. */
  private drillSlot = 0;
  private drillSpread: number | undefined;
  private packWeights: Float32Array[] = [];
  walls = 1;
  private readonly presets: Track[];
  /** Road courses: the tightest corner this round's circuit may have (the curriculum). */
  roadRadius = ROAD_START_RADIUS;
  /** Road courses: share of the class's drives that were clean, per round since the curriculum last moved. */
  private roadClean: number[] = [];
  /** The variation size this round's candidates were drawn with. */
  private roundSigma = DEFAULT_ES.sigma;
  private readonly rng: Rng;
  private readonly seed: number;
  private readonly practiseOn: boolean;
  private noise: Float32Array[][] = [];
  /** This round's ghost laps (lessons that drive plain ghost trials), for a GhostRunner. */
  private ghostRound: { genomes: Float32Array[]; opts: TrialOptions } | null = null;
  /** This round's circuit racecraft drills, for a RoundRunner. */
  private roadcraftRound: RoadcraftRound | null = null;
  private reports: RoundReport[] = [];
  private radio: RadioLine[] = [];
  private timeOffset = 0;
  /** True when the track changed this round (the viewer needs the new layout). */
  trackChanged = true;
  readonly strokes = new StrokeCollector();
  collectStrokes = false;
  /** The round on tape, once the viewer asks for tapes (startTaping): the students' own cars, not their variations. */
  tape: Tape | undefined;
  /** The round on tape was on screen at some point. */
  private roundWatched = false;
  /** Rounds kept on tape since the last takeTapes: ones watched, and ones that earned a license. */
  private keptTapes: RoundTape[] = [];

  constructor(spec: ClassSpec) {
    this.lesson = { ...LESSONS[spec.lesson], ...spec.practice };
    this.presets = spec.presets.map((l) => new Track(l));
    this.seed = spec.seed;
    this.practiseOn = spec.practiseOn ?? this.lesson.practisesOn ?? false;
    this.rng = new Rng(spec.seed);
    const size = genomeSize(DRIVER_LAYERS);
    this.students = spec.students.map((s) => ({
      ...s, weights: adaptWeights(s.weights).slice(), m: new Float32Array(size), v: new Float32Array(size), adamSteps: 0,
      passed: new Set<string>(), last: null, pitLicensed: s.pitLicensed ?? false, pitTrafficLicensed: s.pitTrafficLicensed ?? false,
      setBackPits: s.setBackPits ?? false,
      cautionLicensed: s.cautionLicensed ?? false, roadLicensed: s.roadLicensed ?? false, noStop: 0, reference: adaptWeights(s.weights).slice(),
    }));
    if (this.lesson.id === 'circuits') {
      // A new road-course skill first copies the scripted line follower round circuits; then practice.
      for (const [k, s] of this.students.entries()) {
        // No apprenticeship asked for (rounds 0): the skill learns from practice alone, through the curriculum.
        if (s.rounds > 0 || spec.apprenticeship?.rounds === 0) continue;
        const done = spec.apprenticed?.[k];
        if (done) s.weights.set(done.weights);
        const { examples } = done ?? apprenticeRoadCourses(s.weights, hashSeed(this.seed, s.id), spec.apprenticeship);
        this.say(`${s.name} studied the line follower's laps of road circuits (${examples} moments)`);
        // The line follower drives real hairpins, so its apprentice starts at full tightness. Practising first on
        // gentle corners and soft barriers made apprenticed drivers worse on GP circuits (lab, 2026-10-17: solo
        // crashes 6-7% -> 13-15% over three seeds), and starting tight did better on club circuits (24% -> 18%).
        s.roadRadius = ROAD_FULL_RADIUS;
      }
      // Carry on where the class got to: the least advanced student's stage.
      this.roadRadius = Math.max(ROAD_FULL_RADIUS, ...this.students.map((s) => s.roadRadius ?? ROAD_START_RADIUS));
    }
    if (this.lesson.id === 'pits') {
      // First, each student watches the veteran crews' pit maneuver and learns to copy it.
      for (const s of this.students) {
        const { examples } = apprenticePitStops(s.weights, this.presets, this.rng);
        this.say(`${s.name} studied the veteran's pit stops (${examples} moments)`);
      }
    }
    if (this.lesson.id === 'pitTraffic') {
      // First, a refresher on the veteran's stop, in traffic this time.
      for (const s of this.students) {
        const { examples } = apprenticePitTraffic(s.weights, this.presets, this.rng);
        this.say(`${s.name} studied the veteran's pit stops in traffic (${examples} moments)`);
      }
    }
    if (this.lesson.id === 'cautions') {
      // First, each student drives drills under the formation script's eye and learns to copy it.
      for (const s of this.students) {
        const { examples } = apprenticeCautions(s.weights, this.presets, this.rng);
        this.say(`${s.name} studied the formation script's caution laps (${examples} moments)`);
      }
    }
    this.startRound();
  }

  /** Rookie school ends when everyone holds a license; other lessons run until stopped. */
  /** Has this student earned the license this lesson gives (lessons without one: never)? */
  private passedLesson(s: Student): boolean {
    switch (this.lesson.id) {
      case 'pits': return s.pitLicensed;
      case 'pitTraffic': return s.pitTrafficLicensed;
      case 'cautions': return s.cautionLicensed;
      case 'circuits': return s.roadLicensed;
      default: return false;
    }
  }

  get finished(): boolean {
    if (this.practiseOn) return false;
    if (this.lesson.id === 'rookie') return this.students.every((s) => s.licensed);
    if (this.lesson.id === 'pits') return this.students.every((s) => s.pitLicensed);
    if (this.lesson.id === 'cautions') return this.students.every((s) => s.cautionLicensed);
    if (this.lesson.id === 'pitTraffic') return this.students.every((s) => s.pitTrafficLicensed);
    if (this.lesson.id === 'circuits') return this.students.every((s) => s.roadLicensed);
    return false;
  }

  /** Total simulated time across rounds. */
  get time(): number {
    return this.timeOffset + (this.trial?.world.time ?? 0);
  }

  step(): void {
    if (this.finished) return;
    this.trial.step();
    if (this.collectStrokes) {
      // Only each student's own car marks the track; the variations would paint it black.
      const per = 1 + 2 * this.lesson.pairs;
      this.strokes.collect(this.trial instanceof DrillTrial ? this.trial.world.cars : this.trial.world.cars.filter((c) => c.id % per === 0));
    }
    if (this.tape) {
      if (this.collectStrokes) this.roundWatched = true;
      if (this.trial.world.tick % TAPE_STEPS === 0) this.tape.record(this.snapshot());
    }
    if (this.trial.done) {
      const round = this.round, track = this.track.name, layout = this.track.layout, reported = this.reports.length;
      this.finishRound();
      const graduated = this.reports.slice(reported).filter((r) => r.graduated).map((r) => r.key);
      if (this.tape && (this.roundWatched || graduated.length)) {
        this.keptTapes.push({ round, track, layout, graduated, watched: this.roundWatched, tape: this.tape.segment() });
      }
      if (!this.finished) {
        this.startRound();
        if (this.tape) this.startTaping();
      }
    }
  }

  /** Tape rounds from now on (the viewer's classes; headless ones don't). */
  startTaping(): void {
    const snap = this.snapshot();
    this.tape = new Tape({
      id: this.round + 1,
      cars: snap.cars.filter((c) => !c.variant).map((c) => ({ id: c.id, key: c.key, color: c.color })),
      laps: null,
    });
    this.roundWatched = false; // until it's on screen while it runs
  }

  /** Rounds kept on tape since the last call. */
  takeTapes(): RoundTape[] {
    const out = this.keptTapes;
    this.keptTapes = [];
    return out;
  }

  /** Can a RoundRunner drive this lesson's rounds elsewhere (ghost laps, circuit racecraft)? */
  get runnerRounds(): boolean {
    return this.ghostRound !== null || this.roadcraftRound !== null;
  }

  /**
   * One whole round, driven by the runner (the same results as stepping it
   * here). Headless classes use this to spread a round over threads; the
   * viewer steps the round in front of it instead.
   */
  async runRound(runner: RoundRunner): Promise<void> {
    if (this.finished) return;
    if (this.ghostRound) {
      const { results, time } = await runner.ghost(this.track.layout, this.ghostRound.genomes, this.ghostRound.opts);
      this.finishRound(results, time);
    } else if (this.roadcraftRound) {
      const r = this.roadcraftRound;
      const drills = await runner.roadcraft(r);
      const solo = await runner.ghost(r.layout, [...r.candidates, ...r.references], { ...SOLO_OPTIONS, pace: r.pace });
      this.finishRound(anchored(drills.results, solo.results, r.perStudent, r.candidates.length, this.track.length, r.pace), drills.time);
    } else {
      throw new Error(`${this.lesson.id} rounds can't be run elsewhere`);
    }
    if (!this.finished) this.startRound();
  }

  takeReports(): RoundReport[] {
    const out = this.reports;
    this.reports = [];
    return out;
  }

  takeRadio(): RadioLine[] {
    const out = this.radio;
    this.radio = [];
    return out;
  }

  /** This round's circuit racecraft pack: the focus's situation if the class has one (and the circuit too), else the usual mix. */
  private roadcraftPack(): PackLayout {
    const focus = this.lesson.focus;
    const options = focus ? situationsOn(this.track, focus) : [];
    return focus && options.length
      ? situationLayout(this.track, options[this.rng.int(options.length)], focus, this.rng)
      : roadcraftLayout(this.track, straightStart(this.track, this.rng), this.rng, this.lesson.situations);
  }

  private startRound(): void {
    const lesson = this.lesson;
    const prevTrack = this.track;
    if (lesson.id === 'roadcraft') {
      // A new circuit every round, club and GP in turn, at full tightness (with a focus: the next one that has it).
      const variant = this.round % 2 ? 'gp' : 'club';
      this.track = roadCourseTrack(hashSeed(this.seed, `round${this.round}`), ROAD_FULL_RADIUS, variant);
      for (let k = 1; lesson.focus && k < 40 && !situationsOn(this.track, lesson.focus).length; k++) {
        this.track = roadCourseTrack(hashSeed(this.seed, `round${this.round}-${lesson.focus}${k}`), ROAD_FULL_RADIUS, variant);
      }
      this.walls = 1;
    } else if (lesson.id === 'pits' && this.round % 2 === 1) {
      // Every other pit lesson round: a generated oval whose pit road is set back across grass.
      this.track = setBackPitTrack(hashSeed(this.seed, `round${this.round}`));
      this.walls = 1;
    } else if (lesson.id !== 'variety' && lesson.id !== 'circuits') {
      this.track = this.presets[this.round % this.presets.length];
      // One world, so one wall softness: the class's average experience sets it.
      const lessons = this.students.reduce((a, s) => a + s.rounds, 0) / this.students.length;
      this.walls = lesson.id === 'rookie' ? rookieDamageScale(lessons, DEFAULT_ES.curriculumRounds) : 1;
    } else if (lesson.id === 'variety') {
      this.track = new Track(generateLayout({ type: 'oval', seed: hashSeed(this.seed, `round${this.round}`) }));
      this.walls = 1;
    } else {
      this.track = roadCourseTrack(hashSeed(this.seed, `round${this.round}`), this.roadRadius);
      this.walls = roadWalls(this.roadRadius);
    }
    this.trackChanged = this.track !== prevTrack;
    const size = genomeSize(DRIVER_LAYERS);
    const sigma = lesson.id === 'circuits' ? roadSigma(this.roadRadius) : DEFAULT_ES.sigma;
    this.roundSigma = sigma;
    const candidates: Float32Array[] = [];
    this.noise = [];
    for (const s of this.students) {
      candidates.push(s.weights);
      const eps: Float32Array[] = [];
      for (let p = 0; p < lesson.pairs; p++) {
        const e = new Float32Array(size);
        for (let i = 0; i < size; i++) e[i] = this.rng.gaussian();
        // Lessons that train only some weights (cautions) vary only those.
        if (this.lesson.trains) for (let i = 0; i < size; i++) e[i] *= this.lesson.trains[i];
        eps.push(e);
        const plus = new Float32Array(size), minus = new Float32Array(size);
        for (let i = 0; i < size; i++) {
          plus[i] = s.weights[i] + sigma * e[i];
          minus[i] = s.weights[i] - sigma * e[i];
        }
        candidates.push(plus, minus);
      }
      this.noise.push(eps);
    }
    const lessons = this.students.reduce((a, s) => a + s.rounds, 0) / this.students.length;
    // Caution drills: everyone starts from the same grid slot this round; one student's drill is shown.
    this.drillSlot = 2 + (this.round % (DRILL_FIELD - 3));
    // Every other round the caution finds the field strung out round the lap, as in a race.
    this.drillSpread = this.round % 2 === 1 ? hashSeed(this.seed, `spread${this.round}`) : undefined;
    this.packWeights = this.students.map((s) => s.weights.slice()); // the classmates in this round's packs
    this.roadcraftRound = null;
    if (lesson.id === 'roadcraft') {
      this.roadcraftRound = {
        layout: this.track.layout, pack: this.roadcraftPack(), slot: 0,
        candidates, perStudent: 1 + 2 * lesson.pairs, classmates: this.students.map((s) => s.weights.slice()),
        nerves: this.students.map((s) => s.nerve), references: this.students.map((s) => s.reference), pace: trackPace(this.track),
      };
      this.roadcraftRound.slot = this.round % this.roadcraftRound.pack.spots.length;
    }
    const r = this.roadcraftRound;
    const drill: LessonTrial | null = r
      ? new RoadcraftTrial(this.track, r.candidates, r.perStudent, r.slot, r.classmates, this.round % this.students.length, r.pack, r.nerves, r.references)
      : lesson.id === 'cautions'
      ? new CautionTrial(this.track, candidates, 1 + 2 * lesson.pairs, this.drillSlot, this.round % this.students.length,
        this.students.map((s) => s.reference), this.drillSpread, this.students.map((s) => s.weights))
      : lesson.id === 'racecraft'
        ? new RacecraftTrial(this.track, candidates, 1 + 2 * lesson.pairs, this.round % PACK_SIZE,
          this.students.map((s) => s.weights), this.round % this.students.length, randomLayout(this.track, this.rng),
          this.students.map((s) => s.nerve), this.students.map((s) => s.reference))
      : lesson.id === 'pitTraffic' ? new PitTrafficTrial(this.track, candidates, 1 + 2 * lesson.pairs, this.round % this.students.length,
        this.students.map((s) => s.reference))
      : lesson.id === 'pits' ? new PitTrial(this.track, candidates, lesson.seconds) : null;
    this.ghostRound = null;
    if (drill) this.trial = drill;
    else {
      const opts: TrialOptions = {
        seconds: lesson.seconds,
        startS: lesson.id === 'circuits' ? straightStart(this.track, this.rng) : undefined,
        damageScale: this.walls,
        damageSeconds: lesson.id === 'rookie' ? rookieDamageSeconds(lessons, DEFAULT_ES.curriculumRounds)
          : lesson.id === 'circuits' ? roadDamageSeconds(this.roadRadius) : COSTS.damage,
        wheels: lesson.id === 'circuits' ? roadTrainingWheels(this.roadRadius) : undefined,
        pace: trackPace(this.track),
        // Valid laps count from full tightness: a beginner that leaves the road loses the whole lap, so while
        // the corners are still being tightened nothing it does scores (no-teacher lab, 2026-10-18: 250 rounds and
        // the curriculum never moved). Apprenticed skills start at full tightness, so for them it's always on.
        validLaps: lesson.validLaps && (lesson.id !== 'circuits' || this.roadRadius <= ROAD_FULL_RADIUS),
      };
      this.trial = new Trial(this.track, candidates, opts);
      this.ghostRound = { genomes: candidates, opts };
    }
    this.strokes.reset();
  }

  /** Learn from the round (results: every car's, in order; time: simulated seconds it ran). */
  private finishRound(results: Array<{ fitness: number; laps: number; bestLap: number; health: number }> = this.trial.results(),
    time = this.trial.world.time): void {
    const per = 1 + 2 * this.lesson.pairs;
    const sigma = this.roundSigma;
    const size = genomeSize(DRIVER_LAYERS);
    this.students.forEach((s, l) => {
      const base = l * per;
      const own = results[base];
      const fits = Array.from({ length: 2 * this.lesson.pairs }, (_, k) => results[base + 1 + k].fitness);
      const ranks = centeredRanks(fits);
      const grad = new Float32Array(size);
      for (let p = 0; p < this.lesson.pairs; p++) {
        const w = ranks[2 * p] - ranks[2 * p + 1];
        const e = this.noise[l][p];
        for (let i = 0; i < size; i++) grad[i] += w * e[i];
      }
      s.rounds++;
      // A student who has passed this lesson's license stops learning in it while the rest of the class
      // catches up: practising on, it drifted (racing got slower) after passing.
      if (!this.passedLesson(s) || this.practiseOn) {
        adamStep(s, grad, 1 / (2 * this.lesson.pairs * sigma), this.lesson.learningRate, DEFAULT_ES.weightDecay, this.lesson.trains);
      }

      // The license test: a clean lap at full walls on each preset track.
      let graduated = false;
      if (!s.licensed && this.lesson.id === 'rookie' && this.walls >= 1 && own.laps >= 1 && own.health >= LICENSE_HEALTH) {
        if (!s.passed.has(this.track.name)) {
          s.passed.add(this.track.name);
          this.say(`${s.name} passed the ${this.track.name} test (${s.passed.size} of ${this.presets.length})`);
        }
        if (s.passed.size === this.presets.length) {
          s.licensed = true;
          graduated = true;
          this.say(`${s.name} earned a license after ${s.rounds} lessons`);
        }
      }
      // The pit license: a clean stop of its own on each preset track.
      // Every license below also needs the student to race as it did before the class (racingKept): lessons
      // that only measure their own skill let racing drift, and once a class licensed drivers that couldn't
      // finish a lap.
      const setBack = !!this.track.pit.entryRoute;
      if (!s.setBackPits && setBack && this.lesson.id === 'pits' && cleanStop(own as PitTrialResult) && racingKept(this.track, s.weights, s.reference)) {
        s.setBackPits = true;
        this.say(`${s.name} made a clean stop on a set-back pit road at ${this.track.name}`);
      }
      if (!s.pitLicensed && !setBack && this.lesson.id === 'pits' && cleanStop(own as PitTrialResult) && racingKept(this.track, s.weights, s.reference)) {
        if (!s.passed.has(this.track.name)) {
          s.passed.add(this.track.name);
          this.say(`${s.name} made a clean stop at ${this.track.name} (${s.passed.size} of ${this.presets.length})`);
        }
        if (s.passed.size === this.presets.length) {
          s.pitLicensed = true;
          graduated = true;
          this.say(`${s.name} does their own pit stops now`);
        }
      }
      // The pit-in-traffic license: a clean stop in traffic, at least as good as the veteran's, on each preset track.
      if (!s.pitTrafficLicensed && this.lesson.id === 'pitTraffic') {
        const p = own as PitTrafficResult;
        if (cleanTrafficStop(p) && p.fitness >= trafficBaseline(this.track, s.weights).fitness - TRAFFIC_BASELINE_MARGIN * lapSeconds(this.track)
          && racingKept(this.track, s.weights, s.reference)) {
          if (!s.passed.has(this.track.name)) {
            s.passed.add(this.track.name);
            this.say(`${s.name} made a clean stop in traffic at ${this.track.name} (${s.passed.size} of ${this.presets.length})`);
          }
          if (s.passed.size === this.presets.length) {
            s.pitTrafficLicensed = true;
            graduated = true;
            this.say(`${s.name} does their own pit stops in races now`);
          }
        }
      }
      // The caution license: a clean drill, at least as good as the formation script's own, on each preset track.
      if (!s.cautionLicensed && this.lesson.id === 'cautions') {
        const c = own as CautionResult;
        if (c.health >= 0.95 && c.harm < 0.05 && racingKept(this.track, s.weights, s.reference)
          && c.fitness >= scriptBaseline(this.track, this.drillSlot, s.weights, this.drillSpread, this.packWeights).fitness - BASELINE_MARGIN * lapSeconds(this.track)) {
          if (!s.passed.has(this.track.name)) {
            s.passed.add(this.track.name);
            this.say(`${s.name} drove a clean caution drill at ${this.track.name} (${s.passed.size} of ${this.presets.length})`);
          }
          if (s.passed.size === this.presets.length) {
            s.cautionLicensed = true;
            graduated = true;
            this.say(`${s.name} drives their own cautions and restarts now`);
          }
        }
      }
      // The road-course license: once the curriculum is at full tightness, a test on three new club circuits
      // from the line (a full lap, no crash, on every one). A lucky clean round isn't enough.
      if (!s.roadLicensed && this.lesson.id === 'circuits' && this.roadRadius <= ROAD_FULL_RADIUS && this.walls >= 1) {
        if (roadLicenseTest(s.weights, hashSeed(this.seed, `${s.id}-test${this.round}`), LICENSE_HEALTH)) {
          s.roadLicensed = true;
          graduated = true;
          this.say(`${s.name} passed the road-course test: three new circuits, a clean lap on each`);
        }
      }
      const report: RoundReport = {
        key: s.key, id: s.id, round: this.round, weights: s.weights.slice(), rounds: s.rounds, licensed: s.licensed, pitLicensed: s.pitLicensed,
        pitTrafficLicensed: s.pitTrafficLicensed, setBackPits: s.setBackPits, cautionLicensed: s.cautionLicensed, roadLicensed: s.roadLicensed, graduated,
        roadRadius: this.lesson.id === 'circuits' ? this.roadRadius : undefined,
        track: this.track.name, fitness: own.fitness, laps: own.laps,
        bestLap: Number.isFinite(own.bestLap) ? own.bestLap : null, health: own.health, walls: this.walls,
        beaten: fits.filter((f) => f > own.fitness).length, passed: [...s.passed],
      };
      if (this.lesson.id === 'cautions') {
        const c = own as CautionResult;
        report.caution = { placeError: c.placeError, passes: c.passes, harm: c.harm };
      }
      if (this.lesson.id === 'racecraft' || this.lesson.id === 'roadcraft') {
        const r = own as RacecraftResult;
        report.pack = { harm: r.harm, gained: r.gained };
      }
      if (this.lesson.id === 'pitTraffic') {
        const p = own as PitTrafficResult;
        report.stop = { serviced: p.serviced, completed: p.completed, speeding: p.speeding, harm: p.harm };
        // Stuck skipping the stop (afraid of the traffic): back to the veteran for a refresher.
        s.noStop = p.serviced ? 0 : s.noStop + 1;
        if (s.noStop >= STUCK_ROUNDS && !s.pitTrafficLicensed) {
          apprenticePitTraffic(s.weights, this.presets, this.rng, REFRESHER_ROUNDS);
          s.noStop = 0;
          this.say(`${s.name} went back to watch the veteran pit in traffic`);
        }
      }
      if (this.lesson.id === 'pits') {
        const p = own as PitTrialResult;
        report.stop = { serviced: p.serviced, completed: p.completed, speeding: p.speeding };
        // Stuck (practice can't find a stop to build on): back to the veteran for a refresher.
        s.noStop = p.serviced ? 0 : s.noStop + 1;
        if (s.noStop >= STUCK_ROUNDS && !s.pitLicensed) {
          apprenticePitStops(s.weights, this.presets, this.rng, REFRESHER_ROUNDS);
          s.noStop = 0;
          this.say(`${s.name} went back to watch the veteran's pit stops`);
        }
      }
      // The report's weights are handed to the page (transferred, not copied), so the view keeps a copy without them.
      const { weights: _w, ...summary } = report;
      s.last = summary;
      this.reports.push(report);
    });
    // Road courses: the corners tighten (the barriers harden, the training wheels come off) once the class
    // drives cleanly (a lap's worth, no crash) round after round: half of all its drives over the last
    // ROAD_GATE_ROUNDS. One round's majority wasn't enough: on a circuit shared by the class, a lucky easy one
    // let three of four through, and a class that mostly stopped in the run-off reached hairpins (lab,
    // 2026-10-18). Stopping in the run-off isn't clean.
    if (this.lesson.id === 'circuits' && this.roadRadius > ROAD_FULL_RADIUS) {
      const clean = this.students.filter((_, l) => {
        const r = results[l * per] as unknown as TrialResult;
        return !r.retired && r.health >= LICENSE_HEALTH && r.distance >= this.track.length;
      }).length;
      this.roadClean.push(clean / this.students.length);
      const recent = this.roadClean.slice(-ROAD_GATE_ROUNDS);
      if (recent.length >= ROAD_GATE_ROUNDS && recent.reduce((a, b) => a + b, 0) / recent.length >= 0.5) {
        this.roadRadius = Math.max(ROAD_FULL_RADIUS, this.roadRadius * ROAD_TIGHTEN);
        this.roadClean = [];
        const w = roadTrainingWheels(this.roadRadius);
        this.say(`Corners tighten: down to ${this.roadRadius.toFixed(0)} m (barriers ${Math.round(roadWalls(this.roadRadius) * 100)}%`
          + `${w ? `, speed limit ${(w.speedCap * 3.6).toFixed(0)} km/h, off-track ${Math.round(100 * w.forgiving)}% forgiving` : ', training wheels off'})`);
      }
    }
    this.timeOffset += time;
    this.round++;
  }

  private say(text: string): void {
    this.radio.push({ time: this.time, key: null, text });
  }

  /** What the viewer draws: every student's car solid, its variations faint. */
  snapshot(): SessionSnapshot & { school: SchoolView } {
    const per = 1 + 2 * this.lesson.pairs;
    const shownStudent = this.trial instanceof DrillTrial ? this.trial.shownStudent : null;
    const showKey = this.students[this.round % this.students.length].key;
    const source = (id: number): CarSource => (this.trial instanceof DrillTrial
      ? { key: shownStudent && id === shownStudent.id ? showKey : -1, variant: false } // the drill's pack has no livery
      : { key: this.students[Math.floor(id / per)].key, variant: id % per !== 0 });
    const cars: CarView[] = this.trial.world.cars.map((car) => {
      const src = source(car.id);
      return {
        id: car.id, key: src.key, variant: src.variant,
        x: car.x, y: car.y, s: car.s, d: car.d, dist: car.dist, speed: car.speed, color: car.color,
        retired: car.retired, cleared: car.cleared, towed: car.towed, parked: car.parked, finished: false,
        inputX: car.inputX, inputY: car.inputY, frameX: car.frameX, frameY: car.frameY, trackIdx: car.trackIdx,
        tireLon: car.tireLon, tireLat: car.tireLat, tireUse: car.tireUse, capacity: car.capacity,
        bank: car.bank, bankAcc: car.bankAcc, normalAcc: car.normalAcc,
        surface: car.surface, groove: car.groove, skid: car.skid,
        tireLife: car.tireLife, fuel: car.fuel, health: car.health,
        pitPhase: car.pit.phase, pitTimer: car.pit.timer, stops: car.pit.stops,
        laps: car.lapsCompleted, bestLap: Number.isFinite(bestValidLap(car)) ? bestValidLap(car) : null,
        penalty: null, timePenalty: 0, disqualified: false,
      };
    });
    // Students first (by distance), then their variations.
    const order = [...cars].sort((a, b) => Number(a.variant) - Number(b.variant) || b.dist - a.dist).map((c) => c.id);
    return {
      time: this.time, cars, order, standings: null, race: null, technique: [],
      school: {
        lesson: this.lesson.id, round: this.round, track: this.track.name, remaining: this.trial.remaining, walls: this.walls,
        students: this.students.map((s) => ({
          key: s.key, id: s.id, name: s.name, rounds: s.rounds, licensed: s.licensed, pitLicensed: s.pitLicensed,
          pitTrafficLicensed: s.pitTrafficLicensed, cautionLicensed: s.cautionLicensed, roadLicensed: s.roadLicensed, passed: [...s.passed], last: s.last,
        })),
        roadRadius: this.lesson.id === 'circuits' ? this.roadRadius : undefined,
      },
    };
  }
}

import type { Flag } from '../sim/raceControl';
import { bestValidLap } from '../sim/limits';
import { NeuralDriver, Team } from '../ai/drivers';
import { fastestLine } from '../ai/racingLine';
import { DEFAULT_KNOWLEDGE, type TrackKnowledge } from '../ai/observe';
import { COSTS } from '../ai/costs';
import { danger, fearScale } from '../ai/fear';
import { PaceCarDriver, formationTraits } from '../ai/formation';
import { NeuralCrewChief } from '../ai/neuralChief';
import { OnlineLearner, RACE_LEARNING } from '../ai/online';
import { RunChief, StrategistCrewChief, type CrewChief, type CrewChiefTraits } from '../ai/pitting';
import { Rng } from '../ai/rng';
import { describeRadio, TowerSpotter, type SpotterSkill } from '../ai/spotter';
import { StrokeCollector } from '../render/marks';
import { Car, SIGNATURE_BINS } from '../sim/car';
import { PHYSICS as P } from '../sim/constants';
import { placeOnGrid, ROLLING_START_SPEED } from '../sim/grid';
import { layoutKind, type Surface, type TrackLayout } from '../sim/layout';
import { createQualifying, type Qualifying, type QualifyingFormat, type QualifyingView } from '../sim/qualifying';
import { Race } from '../sim/race';
import { Track } from '../sim/track';
import { World, type WorldEvent } from '../sim/world';
import { OPEN_SESSION_FRAMES, Tape, TAPE_STEPS, WRECKER_SLOTS } from './tape';
import type { Offence, Penalty } from '../rules/rulebook';
import { defaultSeries, racesOn, seriesById, type Series } from '../rules/series';
import type { StewardTraits } from '../rules/stewards';
import type { SchoolView } from '../school/classroom';

/**
 * One session on track (a race, an open practice session, ghost laps), run
 * wherever it's hosted: an event worker, a test, a script. Everything the
 * viewer shows comes out of snapshot(); everything the records need comes out
 * of results(). No DOM, no globals.
 */

export type SessionKind = 'race' | 'qualifying' | 'practice' | 'ghost';

/** A car in the session: a team's car number and livery, and the three agents in it. */
export interface EntrantSpec {
  /** The team's id: identifies the car across snapshots and results. */
  key: number;
  fill: string;
  /** The number on the car (what race control and the stewards call it). */
  number?: number;
  /** pits / cautions: drives its own pit stops / cautions (it has learned to); otherwise the scripts do. */
  /** roadWeights: the driver's road-course skill (drives road circuits instead of its main network). */
  driver: {
    id: string; weights: Float32Array; roadWeights?: Float32Array; pits?: boolean; setBackPits?: boolean; cautions?: boolean; nerve?: number;
    /** What it knows of road circuits (its line); default the usual. */
    roadKnowledge?: TrackKnowledge;
    /** The caution skill (drives while the field is pacing), and the driver's human limits (latency, motor noise). */
    cautionWeights?: Float32Array; limits?: { latency: number; noise: number };
    /** Its caution skill on road circuits, if it has one of its own; its pit skill, if it has one. */
    roadCautionWeights?: Float32Array;
    pitWeights?: Float32Array;
    /** Its broken-car skill, if it's licensed to drive with it. */
    brokenWeights?: Float32Array;
  };
  spotter: { id: string; skill: SpotterSkill };
  chief: { id: string; brain: { kind: 'neural'; weights: Float32Array } | { kind: 'scripted'; traits: CrewChiefTraits } };
}

export interface SessionSpec {
  kind: SessionKind;
  layout: TrackLayout;
  entrants: EntrantSpec[];
  /** Race distance (races only). */
  laps: number;
  /** Tire wear and fuel burn multiplier. */
  pace: number;
  /** Shuffles the grid (and qualifying's run order). */
  seed: number;
  /** The starting order by entrant key (races: what qualifying set); entrants it leaves out start behind, shuffled. */
  grid?: number[];
  /** How qualifying is run (qualifying only; default: the track's rulebook's format, at its usual length). */
  qualifying?: QualifyingFormat;
  /** Drivers learn as they race (races only). */
  learn?: boolean;
  /** Races are run to the series' rulebook; the stewards' panel (default: middling). */
  stewards?: StewardTraits;
  /** The series racing (its rulebook: start, cautions, qualifying). Default: the first series that races on this layout. */
  series?: string;
}

/** The series a session races as (one that races on its layout). */
export function seriesOf(spec: Pick<SessionSpec, 'layout' | 'series'>): Series {
  if (!spec.series) return defaultSeries(spec.layout);
  const series = seriesById(spec.series);
  if (!racesOn(series, spec.layout)) throw new Error(`${series.name} doesn't race on ${spec.layout.name} (a ${layoutKind(spec.layout)} layout)`);
  return series;
}

/** A driver took a learning step during the session: the weights it drives with now. */
export interface LearnedStep {
  driverId: string;
  weights: Float32Array;
  /** Steps this driver has taken this session. */
  steps: number;
  /** When (sim s). */
  time: number;
}

/** What the viewer needs about one car, as plain data. */
export interface CarView {
  id: number;
  key: number;
  /** Driving school: one of a student's practice variations (drawn faint), not the student. */
  variant?: boolean;
  x: number; y: number; s: number; d: number; dist: number; speed: number;
  color: string;
  retired: boolean; cleared: boolean; towed: boolean; parked: boolean; finished: boolean;
  inputX: number; inputY: number; frameX: number; frameY: number; trackIdx: number;
  tireLon: number; tireLat: number; tireUse: number; capacity: number;
  bank: number; bankAcc: number; normalAcc: number;
  surface: Surface; groove: number; skid: number;
  tireLife: number; fuel: number; health: number;
  pitPhase: Car['pit']['phase']; pitTimer: number; stops: number;
  laps: number; bestLap: number | null;
  /** Stewards: a penalty still to serve, seconds added to the race time, shown the black flag. */
  penalty: 'drive-through' | 'stop-go' | null; timePenalty: number; disqualified: boolean;
}

export interface StandingView {
  id: number;
  position: number;
  laps: number;
  time: number;
  status: 'running' | 'finished' | 'out' | 'pit';
}

export interface RaceView {
  laps: number;
  state: Race['state'];
  started: boolean;
  flag: Flag;
  oneToGo: boolean;
  pacing: boolean;
  /** Standing start: red lights showing. */
  lights: number;
  /** Neutralised by a safety car (circuits) rather than a pace car. */
  safetyCar: boolean;
  /** Where the pace car is: out on track, or parked at its post (out false). */
  paceCar: { x: number; y: number; out: boolean } | null;
  /** The wrecker fleet, parked or at work (and marshals' cranes). */
  wreckers: Array<{ x: number; y: number; phase: string }>;
}

/** What a timeline event is: race control's flags and lead changes, or one of the world's announcements. */
export type TimelineKind = 'start' | 'caution' | 'restart' | 'green' | 'checkered' | 'lead' | 'pole' | 'round' | Exclude<WorldEvent['kind'], 'flag'>;

/**
 * Something that happened in a session, when and to whom: the timeline's
 * markers, and (later) what agents' history links to.
 */
export interface TimelineEvent {
  /** Sim time (s). */
  time: number;
  kind: TimelineKind;
  /** The team it's about (entrant key); null for race control. */
  key: number | null;
  /** Other teams in it (entrant keys): the car it made contact with, the other side of a stewards' case. */
  others?: number[];
  /** A stewards' decision: when the incident it's about happened (sim s). */
  incidentTime?: number;
  text: string;
  /** Races: how far through the race distance the leader was (0..1), and the lap they were on. */
  at?: number;
  lap?: number;
}

/** A line for the broadcast feed: a team's radio call, a crew call, a flag. key null = race control. */
export interface RadioLine {
  time: number;
  key: number | null;
  text: string;
}

export interface SessionSnapshot {
  time: number;
  cars: CarView[];
  /** Car ids in classification order. */
  order: number[];
  standings: StandingView[] | null;
  race: RaceView | null;
  /** Technique histogram per entrant key: where the tire force points relative to travel. */
  technique: Array<[number, number[]]>;
  /** Driving school classes: the lesson's state. */
  school?: SchoolView;
  /** Qualifying sessions: the round, its clock and cut line, how far through. */
  qualifying?: QualifyingView;
}

/** How a session went for one entrant (races: the classification). */
export interface EntrantResult {
  key: number;
  driver: string;
  spotter: string;
  chief: string;
  position: number;
  status: StandingView['status'];
  laps: number;
  /** Race time (finishers). */
  time: number;
  bestLap: number | null;
  avgLap: number | null;
  stops: number;
  wallHits: number;
  health: number;
  /** The hardest single hit the car took (health lost; 0 if none), and how fast (m/s): what injures drivers. */
  worstHit: number;
  worstHitSpeed: number;
  /** When the hardest hit happened (sim s), if there was one. */
  worstHitTime: number | null;
  /** What the stewards handed this car (offence, penalty), and whether it was shown the black flag. */
  penalties: Array<{ offence: Offence; penalty: Penalty }>;
  disqualified: boolean;
}

const RADIO_REPEAT = 4; // seconds before the same call from the same team is repeated
/** A lap on which a driver did itself or others this much harm counts, even if spoiled (caution, wreck). */
const FAULT_COUNTS = 0.02;
const RESPAWN_DELAY = 3; // s a wreck sits before an open session puts the car back out
const TECHNIQUE_DECAY = 0.9997;

export class Session {
  readonly kind: SessionKind;
  readonly track: Track;
  readonly world: World;
  readonly race: Race | null;
  /** Qualifying sessions: the run order, who is out, the times. */
  readonly qualifying: Qualifying | null;
  private readonly entrants = new Map<number, EntrantSpec>(); // by car id
  private readonly teams = new Map<number, Team>(); // by car id
  private readonly drivers = new Map<string, NeuralDriver>(); // by driver id
  private readonly technique = new Map<number, Float64Array>(); // by entrant key
  private readonly retiredAt = new Map<number, number>();
  private readonly prevRadio = new Map<number, Float32Array>();
  private readonly recentRadio: RadioLine[] = [];
  private pendingRadio: RadioLine[] = [];
  /** World announcements read so far (counting ones the world has since dropped). */
  private eventsSeen = 0;
  /** Everything that happened, in order. */
  readonly timeline: TimelineEvent[] = [];
  /** Race control's last call this step (its words, and the car it was about), for the flag it goes with. */
  private flagCall: { text: string; key: number | null } | null = null;
  private flagWas: Flag = 'pace';
  private startedWas = false;
  private stateWas: Race['state'] = 'green';
  /** Each car's hardest hit so far and when it came (a new worst hit is a new object on the car). */
  private readonly worstHitAt = new Map<number, { hit: Car['worstHit']; time: number }>();
  /** The leader on the timeline, and a new one until it has held the lead a second. */
  private leaderId = -1;
  private leadCandidate = { id: -1, since: 0 };
  /** Learning while racing: per car, its learner and the lap in progress. */
  private readonly learners = new Map<number, {
    learner: OnlineLearner; driverId: string; laps: number; clean: boolean; done: boolean;
    /** At the start of the lap in progress: health, harm done, self-inflicted damage and trauma. */
    health: number; harm: number; self: number; trauma: number;
    /** Seconds in danger on the lap in progress; how much fear and trauma cost this driver. */
    fear: number; fearScale: number;
    /** Last clean lap time: what a spoiled lap is scored against. */
    ref: number;
  }>();
  private learned: LearnedStep[] = [];
  /** Mark strokes, collected only while someone is watching. */
  readonly strokes = new StrokeCollector();
  /** The session on tape, watched or not (races whole; open sessions their latest half hour). */
  readonly tape: Tape;
  collectStrokes = false;

  constructor(spec: SessionSpec) {
    this.kind = spec.kind;
    this.track = new Track(spec.layout);
    // Drivers' track knowledge (the circuit's lines, one per margin in the field), worked out now rather than at
    // the first decision mid-race.
    if (this.track.kind === 'road') {
      for (const m of new Set(spec.entrants.map((e) => e.driver.roadKnowledge?.margin ?? DEFAULT_KNOWLEDGE.margin))) fastestLine(this.track, m);
    }
    const contact = spec.kind !== 'ghost';
    // Race pace is for races' pit windows (and practice for them); a qualifying run is a few laps on fresh tires.
    const wearScale = spec.kind === 'ghost' || spec.kind === 'qualifying' ? 1 : spec.pace;
    this.world = new World(this.track, { collisions: contact, drafting: contact, wearScale });
    // Shuffle the grid so the starting order isn't always roster order (a set grid goes first).
    const rng = new Rng(spec.seed);
    // Each driver's own way of driving cautions, drawn once per race from the seed.
    const traitRng = new Rng(spec.seed ^ 0x5bd1e995);
    const slot = (e: EntrantSpec) => { const i = spec.grid?.indexOf(e.key) ?? -1; return i < 0 ? Infinity : i; };
    const grid = spec.entrants.map((e) => ({ e, k: rng.next() }))
      .sort((a, b) => (slot(a.e) - slot(b.e)) || a.k - b.k).map((x) => x.e);
    const qualifying: QualifyingFormat | null = spec.kind === 'qualifying' ? spec.qualifying ?? defaultQualifying(seriesOf(spec)) : null;
    grid.forEach((entrant, k) => {
      const car = new Car(k, entrant.fill);
      if (entrant.number !== undefined) car.number = entrant.number;
      if (contact) placeOnGrid(car, this.track, k, true);
      else this.rollingStart(car); // ghosts share one spot
      const limits = entrant.driver.limits && { ...entrant.driver.limits, seed: (spec.seed ^ ((k + 1) * 0x85ebca6b)) >>> 0 };
      const driver = new NeuralDriver(entrant.driver.weights, entrant.driver.roadWeights, entrant.driver.roadKnowledge,
        { limits, caution: entrant.driver.cautionWeights, roadCaution: entrant.driver.roadCautionWeights, pit: entrant.driver.pitWeights,
          broken: entrant.driver.brokenWeights });
      const chief = qualifying ? new RunChief((c) => this.qualifying!.wantsIn(c)) : contact ? makeChief(entrant.chief.brain) : null;
      const team = new Team(driver, new TowerSpotter(entrant.spotter.skill), chief,
        // Its own stops where it has learned to make them: a pit road set back across grass needs that too.
        (entrant.driver.pits ?? false) && (!spec.layout.pit.entryRoute || (entrant.driver.setBackPits ?? false)), entrant.driver.cautions ?? false,
        formationTraits(entrant.driver.nerve, () => traitRng.next()));
      if (entrant.driver.nerve !== undefined) team.autopilot.nerve = entrant.driver.nerve;
      this.world.addCar(car, team);
      this.entrants.set(car.id, entrant);
      this.teams.set(car.id, team);
      this.drivers.set(entrant.driver.id, driver);
      if (spec.learn && spec.kind === 'race') {
        const learner = new OnlineLearner(driver.net.weights, RACE_LEARNING, new Rng(spec.seed ^ ((k + 1) * 0x9e3779b1)));
        this.learners.set(car.id, {
          learner, driverId: entrant.driver.id, laps: 0, clean: true, done: false, health: 1, harm: 0, self: 0, trauma: 0, ref: NaN,
          fear: 0, fearScale: fearScale(entrant.driver.nerve),
        });
      }
    });
    // Races run under race control: pace laps, green at the line, cautions with the wrecker crew.
    this.race = spec.kind === 'race'
      ? new Race(this.world, spec.laps, new PaceCarDriver(), { rulebook: seriesOf(spec).rulebook, stewards: spec.stewards, seed: spec.seed })
      : null;
    // Qualifying goes out in grid order: the draw.
    this.qualifying = qualifying ? createQualifying(this.world, qualifying) : null;
    this.tape = new Tape({
      id: 0,
      cars: this.world.cars.map((car) => ({ id: car.id, key: this.entrants.get(car.id)!.key, color: car.color })),
      laps: this.race ? spec.laps : null,
      wreckers: WRECKER_SLOTS,
    }, this.race || this.qualifying ? Infinity : OPEN_SESSION_FRAMES);
  }

  get time(): number {
    return this.world.time;
  }

  /** The race (or qualifying) has been run to the end (never true for open sessions). */
  get finished(): boolean {
    return this.race?.state === 'finished' || this.qualifying?.state === 'finished';
  }

  /** One physics step, plus the bookkeeping the viewer and records want. */
  step(): void {
    if (this.race) this.race.step();
    else if (this.qualifying) this.qualifying.step();
    else this.world.step();
    if (this.learners.size) this.learnFromLaps();
    this.recordTechnique();
    if (this.collectStrokes) this.strokes.collect(this.world.cars);
    this.readAnnouncements();
    if (this.race) this.watchRace(this.race);
    if (this.qualifying) this.readQualifyingNews(this.qualifying);
    for (const car of this.world.cars) {
      if (car.worstHit && this.worstHitAt.get(car.id)?.hit !== car.worstHit) this.worstHitAt.set(car.id, { hit: car.worstHit, time: this.world.time });
    }
    if (this.world.tick % TAPE_STEPS === 0) this.tape.record(this.snapshot(false));
    if (this.world.tick % P.CONTROL_EVERY === 1) this.pollRadio();
    if (this.world.tick % 12 === 0) this.serviceCars();
  }

  /** Run n seconds as fast as possible (fast-forward, e.g. ?warm=). */
  advance(seconds: number): void {
    const steps = Math.round(seconds / P.DT);
    for (let k = 0; k < steps && !this.finished; k++) this.step();
  }

  /** Practice improved a driver: the car on track drives with the new weights from now on. */
  updateDriver(driverId: string, weights: Float32Array): void {
    this.drivers.get(driverId)?.net.weights.set(weights);
  }

  /** Learning steps drivers took since the last call. */
  takeLearned(): LearnedStep[] {
    const out = this.learned;
    this.learned = [];
    return out;
  }

  /**
   * Score each finished lap for the driver's learner: a clean green-flag lap
   * (no caution, no pit stop) scores its lap time plus a heavy charge for any
   * damage taken or done to others (by fault). A spoiled lap doesn't count and
   * the same variation runs again, unless the driver caused the trouble (did
   * itself or others harm): then it counts, against its last clean lap time,
   * charges included, even if the lap ended in a wreck.
   */
  private learnFromLaps(): void {
    const race = this.race!;
    for (const car of this.world.cars) {
      const l = this.learners.get(car.id);
      if (!l || l.done) continue;
      if (car.retired || car.finished || race.state !== 'green') {
        if (car.retired && race.started) this.scoreLap(l, car, false); // a wreck it caused still teaches
        l.learner.finish(); // the car keeps the driver's own weights from here on
        l.done = true;
        continue;
      }
      if (!race.started) continue;
      if (race.control?.flag !== 'green' || car.pit.phase !== 'none') l.clean = false;
      else if (this.world.tick % P.CONTROL_EVERY === 0) l.fear += danger(car, this.world) * P.CONTROL_EVERY * P.DT;
      const laps = car.lapTimes.length;
      if (laps < l.laps) l.laps = laps; // the green flag reset lap counts
      if (laps === l.laps) continue;
      if (l.clean) l.ref = car.lapTimes[laps - 1];
      this.scoreLap(l, car, l.clean);
      l.laps = laps;
      l.clean = true;
      l.health = car.health;
      l.harm = car.harmDone;
      l.self = car.selfInflicted;
      l.trauma = car.selfTrauma;
      l.fear = 0;
    }
  }

  private scoreLap(l: NonNullable<ReturnType<typeof this.learners.get>>, car: Car, counts: boolean): void {
    const harm = car.harmDone - l.harm;
    const self = car.selfInflicted - l.self;
    const atFault = harm + self >= FAULT_COUNTS;
    if (Number.isNaN(l.ref) || !(counts || atFault)) {
      l.learner.lapDone(null);
      return;
    }
    const extraTrauma = Math.max(0, car.selfTrauma - l.trauma - self);
    // Seconds of race time, priced as every lesson prices them (COSTS); fear and trauma scaled by nerve.
    const score = -l.ref - COSTS.damage * Math.max(0, l.health - car.health) - COSTS.harm * harm
      - l.fearScale * (COSTS.fear * l.fear + COSTS.trauma * extraTrauma);
    if (l.learner.lapDone(score)) {
      this.learned.push({ driverId: l.driverId, weights: l.learner.weights.slice(), steps: l.learner.updates, time: this.world.time });
    }
  }

  /** Radio lines since the last call. */
  takeRadio(): RadioLine[] {
    const out = this.pendingRadio;
    this.pendingRadio = [];
    return out;
  }

  /** What the viewer draws now (technique: the live-only histograms too). */
  snapshot(technique = true): SessionSnapshot {
    const cars = this.world.cars.map((car) => this.view(car));
    const standings = this.race?.standings() ?? this.qualifying?.standings() ?? null;
    const order = standings
      ? standings.map((st) => st.car.id)
      : [...this.world.cars].sort((a, b) => Number(a.retired) - Number(b.retired) || b.dist - a.dist).map((c) => c.id);
    const ctl = this.race?.control ?? null;
    return {
      time: this.world.time,
      cars,
      order,
      standings: standings?.map((st) => ({ id: st.car.id, position: st.position, laps: st.laps, time: st.time, status: st.status })) ?? null,
      race: this.race ? {
        laps: this.race.laps,
        state: this.race.state,
        started: this.race.started,
        flag: ctl?.flag ?? 'green',
        oneToGo: ctl?.oneToGo ?? false,
        pacing: ctl?.pacing ?? false,
        lights: ctl?.lights ?? 0,
        safetyCar: ctl?.safetyCar ?? false,
        paceCar: ctl ? { x: ctl.paceCar.x, y: ctl.paceCar.y, out: ctl.paceCarOut } : null,
        wreckers: (ctl?.wreckers ?? []).map((w) => ({ x: w.x, y: w.y, phase: w.phase })),
      } : null,
      technique: technique ? [...this.technique].map(([key, h]) => [key, Array.from(h)]) : [],
      ...(this.qualifying ? { qualifying: this.qualifying.view() } : {}),
    };
  }

  /** The classification and each entrant's numbers. */
  results(): EntrantResult[] {
    const q = this.qualifying;
    const standings = this.race?.standings() ?? q?.standings()
      ?? this.snapshot().order.map((id, i) => ({ car: this.world.cars.find((c) => c.id === id)!, position: i + 1, laps: 0, time: NaN, status: 'running' as const }));
    return standings.map((st) => {
      const car = st.car;
      const e = this.entrants.get(car.id)!;
      // Qualifying: only the run's timed laps (not the in-lap); its time is the best of them.
      const laps = q ? car.lapTimes.slice(0, st.laps) : car.lapTimes;
      const best = q ? st.time : bestValidLap(car); // laps past the track limits don't count
      return {
        key: e.key, driver: e.driver.id, spotter: e.spotter.id, chief: e.chief.id,
        position: st.position, status: st.status, laps: q ? st.laps : st.laps || car.lapsCompleted, time: st.time,
        bestLap: Number.isFinite(best) ? best : null,
        avgLap: laps.length ? laps.reduce((a, b) => a + b, 0) / laps.length : null,
        stops: car.pit.stops, wallHits: car.wallHits, health: car.health,
        worstHit: car.worstHit?.severity ?? 0, worstHitSpeed: car.worstHit?.speed ?? 0, worstHitTime: this.worstHitAt.get(car.id)?.time ?? null,
        penalties: (this.race?.stewards?.record ?? []).filter((p) => p.car === car).map((p) => ({ offence: p.offence, penalty: p.penalty })),
        disqualified: car.disqualified,
      };
    });
  }

  private view(car: Car): CarView {
    const e = this.entrants.get(car.id)!;
    return {
      id: car.id, key: e.key,
      x: car.x, y: car.y, s: car.s, d: car.d, dist: car.dist, speed: car.speed, color: car.color,
      retired: car.retired, cleared: car.cleared, towed: car.towed, parked: car.parked, finished: car.finished,
      inputX: car.inputX, inputY: car.inputY, frameX: car.frameX, frameY: car.frameY, trackIdx: car.trackIdx,
      tireLon: car.tireLon, tireLat: car.tireLat, tireUse: car.tireUse, capacity: car.capacity,
      bank: car.bank, bankAcc: car.bankAcc, normalAcc: car.normalAcc,
      surface: car.surface, groove: car.groove, skid: car.skid,
      tireLife: car.tireLife, fuel: car.fuel, health: car.health,
      pitPhase: car.pit.phase, pitTimer: car.pit.timer, stops: car.pit.stops,
      laps: car.lapsCompleted, bestLap: Number.isFinite(bestValidLap(car)) ? bestValidLap(car) : null,
      penalty: car.pendingPenalty?.kind ?? null, timePenalty: car.timePenalty, disqualified: car.disqualified,
    };
  }

  /** Released at pace speed behind the start line, as on real ovals. */
  private rollingStart(car: Car): void {
    car.placeOnTrack(this.track, this.track.length - 20, 0);
    car.vx = this.track.tx[car.trackIdx] * ROLLING_START_SPEED;
    car.vy = this.track.ty[car.trackIdx] * ROLLING_START_SPEED;
  }

  /** Open sessions: a wrecked car returns after a pause. Ghosts get instant top-ups (no crew chief). */
  private serviceCars(): void {
    if (this.race || this.qualifying) return; // in a race (or qualifying), wrecks are out and the crew chiefs handle stops
    this.world.cars.forEach((car, k) => {
      if (car.retired) {
        const since = this.retiredAt.get(car.id);
        if (since === undefined) { this.retiredAt.set(car.id, this.world.time); return; }
        if (this.world.time - since < RESPAWN_DELAY) return;
        this.retiredAt.delete(car.id);
        const fresh = new Car(car.id, car.color);
        this.rollingStart(fresh);
        fresh.lapTimes.push(...car.lapTimes);
        fresh.lapValid.push(...car.lapValid);
        this.world.replaceCar(k, fresh);
        return;
      }
      if (this.kind === 'ghost' && (car.tireLife < 0.5 || car.fuel < 3)) {
        car.tireLife = 1;
        car.fuel = P.FUEL_CAPACITY;
      }
    });
  }

  private recordTechnique(): void {
    for (const car of this.world.cars) {
      if (car.retired) continue;
      const key = this.entrants.get(car.id)!.key;
      let h = this.technique.get(key);
      if (!h) this.technique.set(key, (h = new Float64Array(SIGNATURE_BINS)));
      for (let b = 0; b < SIGNATURE_BINS; b++) h[b] *= TECHNIQUE_DECAY;
      const mag = Math.hypot(car.tireLon, car.tireLat);
      if (mag > 0.1) {
        const ang = Math.atan2(car.tireLat, car.tireLon);
        h[Math.floor(((ang + Math.PI) / (2 * Math.PI)) * SIGNATURE_BINS) % SIGNATURE_BINS] += mag * P.DT;
      }
    }
  }

  private pushRadio(line: RadioLine): void {
    this.pendingRadio.push(line);
    this.recentRadio.push(line);
  }

  /** The world's announcements since the last step: to the broadcast feed, and (all but flags) to the timeline. */
  private readAnnouncements(): void {
    const world = this.world;
    this.flagCall = null;
    this.eventsSeen = Math.max(this.eventsSeen, world.eventsDropped);
    for (; this.eventsSeen < world.eventsDropped + world.events.length; this.eventsSeen++) {
      const e = world.events[this.eventsSeen - world.eventsDropped];
      const key = this.entrants.get(e.car.id)?.key ?? null;
      if (e.kind === 'flag') {
        this.pushRadio({ time: e.time, key: null, text: e.text });
        this.flagCall = { text: e.text, key };
        continue;
      }
      // Race control's calls go to the crew but are race control's words; stewards speak for themselves.
      if (key !== null) this.pushRadio({ time: e.time, key, text: e.kind === 'crew' && !e.text.startsWith('Race control') ? `Crew: ${e.text}` : e.text });
      const others = (e.others ?? []).map((o) => this.entrants.get(o.id)?.key).filter((k): k is number => k !== undefined && k !== key);
      this.log(e.kind, key, e.text, others, e.incidentTime, e.time);
    }
  }

  /** Race control's flags (from its state, in its words) and lead changes, to the timeline. */
  private watchRace(race: Race): void {
    const flag = race.control?.flag ?? 'green';
    const call = this.flagCall;
    if (race.started && !this.startedWas) {
      this.log('start', null, call?.text ?? 'Green flag');
      this.leaderId = race.leader()?.id ?? -1;
    } else if (race.started && flag !== this.flagWas) {
      if (flag === 'caution') this.log('caution', call?.key ?? null, call?.text ?? 'Caution');
      else if (flag === 'restart') this.log('restart', null, call?.text ?? 'Restart: leader to the line');
      else if (flag === 'green') this.log('green', null, call?.text ?? 'Green flag');
    }
    if (race.state === 'checkered' && this.stateWas === 'green') {
      const winner = race.standings()[0]?.car;
      this.log('checkered', winner ? this.entrants.get(winner.id)?.key ?? null : null, 'Takes the checkered flag');
    }
    // Lead changes, once the new leader has held it a second (not every nose ahead side by side).
    if (race.started && race.state === 'green' && this.world.tick % 12 === 0) {
      const leader = race.leader();
      if (leader && leader.id !== this.leaderId) {
        if (this.leadCandidate.id !== leader.id) this.leadCandidate = { id: leader.id, since: this.world.time };
        else if (this.world.time - this.leadCandidate.since >= 1) {
          this.leaderId = leader.id;
          this.log('lead', this.entrants.get(leader.id)?.key ?? null, 'Takes the lead');
        }
      } else this.leadCandidate.id = -1;
    }
    this.flagWas = flag;
    this.startedWas = race.started;
    this.stateWas = race.state;
  }

  /** Qualifying's broadcast lines to the feed (a team's, or race control's); the marked ones to the timeline too. */
  private readQualifyingNews(q: Qualifying): void {
    for (const n of q.takeNews()) {
      const key = n.car ? this.entrants.get(n.car.id)!.key : null;
      this.pushRadio({ time: this.world.time, key, text: n.text });
      if (n.mark) this.log(n.mark, key, n.text);
    }
  }

  /** time: when it happened (an announcement's own time), if not now. */
  private log(kind: TimelineKind, key: number | null, text: string, others: number[] = [], incidentTime?: number, time = this.world.time): void {
    const event: TimelineEvent = {
      time, kind, key, text, ...(others.length ? { others } : {}), ...(incidentTime !== undefined ? { incidentTime } : {}),
    };
    const race = this.race;
    if (race) {
      const leader = race.leader();
      const L = this.track.length;
      // (A rolling start's green can come before the line: the race is under way from the leader's first crossing.)
      event.at = race.state !== 'green' ? 1
        : race.started && leader && leader.lapStartTime >= 0 ? Math.min(1, (leader.lapsCompleted + this.track.wrapS(leader.s) / L) / race.laps) : 0;
      event.lap = leader ? Math.min(race.laps, leader.lapsCompleted + 1) : race.laps;
    }
    const q = this.qualifying;
    if (q) event.at = q.view().progress;
    this.timeline.push(event);
  }

  /** Each spotter's calls, for the broadcast feed. */
  private pollRadio(): void {
    const world = this.world;
    const push = (line: RadioLine) => this.pushRadio(line);
    // Forget lines too old to suppress a repeat.
    while (this.recentRadio.length && world.time - this.recentRadio[0].time > RADIO_REPEAT) this.recentRadio.shift();
    for (const car of world.cars) {
      const team = this.teams.get(car.id);
      if (!team || car.retired) continue;
      const key = this.entrants.get(car.id)!.key;
      let prev = this.prevRadio.get(car.id);
      if (!prev) this.prevRadio.set(car.id, (prev = new Float32Array(team.radio.length)));
      for (const text of describeRadio(team.radio, prev)) {
        if (!this.recentRadio.some((l) => l.key === key && l.text === text)) push({ time: world.time, key, text });
      }
      prev.set(team.radio);
    }
  }
}

/** Qualifying as the series' rulebook runs it: ovals one car at a time for a lap, circuits three rounds of six minutes. */
export function defaultQualifying(series: Series): QualifyingFormat {
  return series.rulebook.qualifying === 'group'
    ? { format: 'group', rounds: 3, roundSeconds: 360 }
    : { format: 'solo', laps: 1 };
}

function makeChief(brain: EntrantSpec['chief']['brain']): CrewChief {
  return brain.kind === 'neural' ? new NeuralCrewChief(brain.weights) : new StrategistCrewChief(brain.traits);
}

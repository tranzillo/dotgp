import { NeuralDriver, Team } from '../ai/drivers';
import { danger, fearScale } from '../ai/fear';
import { PaceCarDriver } from '../ai/formation';
import { NeuralCrewChief } from '../ai/neuralChief';
import { OnlineLearner, RACE_LEARNING } from '../ai/online';
import { StrategistCrewChief, type CrewChief, type CrewChiefTraits } from '../ai/pitting';
import { Rng } from '../ai/rng';
import { describeRadio, RADIO_SIZE, TowerSpotter, type SpotterSkill } from '../ai/spotter';
import { StrokeCollector } from '../render/marks';
import { Car, SIGNATURE_BINS } from '../sim/car';
import { PHYSICS as P } from '../sim/constants';
import { placeOnGrid, ROLLING_START_SPEED } from '../sim/grid';
import type { Surface, TrackLayout } from '../sim/layout';
import { Race } from '../sim/race';
import { Track } from '../sim/track';
import { World } from '../sim/world';
import type { SchoolView } from '../school/classroom';

/**
 * One session on track (a race, an open practice session, ghost laps), run
 * wherever it's hosted: an event worker, a test, a script. Everything the
 * viewer shows comes out of snapshot(); everything the records need comes out
 * of results(). No DOM, no globals.
 */

export type SessionKind = 'race' | 'practice' | 'ghost';

/** A car in the session: a team's car number and livery, and the three agents in it. */
export interface EntrantSpec {
  /** The team's id: identifies the car across snapshots and results. */
  key: number;
  fill: string;
  /** pits / cautions: drives its own pit stops / cautions (it has learned to); otherwise the scripts do. */
  driver: { id: string; weights: Float32Array; pits?: boolean; cautions?: boolean; nerve?: number };
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
  /** Shuffles the grid. */
  seed: number;
  /** Drivers learn as they race (races only). */
  learn?: boolean;
}

/** A driver took a learning step during the session: the weights it drives with now. */
export interface LearnedStep {
  driverId: string;
  weights: Float32Array;
  /** Steps this driver has taken this session. */
  steps: number;
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
  flag: 'pace' | 'restart' | 'green' | 'caution';
  oneToGo: boolean;
  pacing: boolean;
  paceCar: { x: number; y: number } | null;
  wreckers: Array<{ x: number; y: number; phase: string }>;
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
}

const RADIO_REPEAT = 4; // seconds before the same call from the same team is repeated
/** Seconds a lap is charged per unit of health lost on it, when comparing laps: contact never pays. */
const DAMAGE_SECONDS = 120;
/** ... and per unit of damage done to others (by its share of the fault). */
const HARM_SECONDS = 120;
/**
 * Fear and trauma, for a driver of middling nerve (scaled by fearScale): seconds
 * a lap is charged per second spent in danger (a collision imminent, of its
 * own making), and per unit of trauma beyond the damage itself (big hits).
 */
const FEAR_SECONDS = 1;
const TRAUMA_SECONDS = 120;
/** A lap on which a driver did itself or others this much harm counts, even if spoiled (caution, wreck). */
const FAULT_COUNTS = 0.02;
const RESPAWN_DELAY = 3; // s a wreck sits before an open session puts the car back out
const TECHNIQUE_DECAY = 0.9997;

export class Session {
  readonly kind: SessionKind;
  readonly track: Track;
  readonly world: World;
  readonly race: Race | null;
  private readonly entrants = new Map<number, EntrantSpec>(); // by car id
  private readonly teams = new Map<number, Team>(); // by car id
  private readonly drivers = new Map<string, NeuralDriver>(); // by driver id
  private readonly technique = new Map<number, Float64Array>(); // by entrant key
  private readonly retiredAt = new Map<number, number>();
  private readonly prevRadio = new Map<number, Float32Array>();
  private readonly recentRadio: RadioLine[] = [];
  private pendingRadio: RadioLine[] = [];
  private eventsSeen = 0;
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
  collectStrokes = false;

  constructor(spec: SessionSpec) {
    this.kind = spec.kind;
    this.track = new Track(spec.layout);
    const contact = spec.kind !== 'ghost';
    this.world = new World(this.track, { collisions: contact, drafting: contact, wearScale: spec.kind === 'ghost' ? 1 : spec.pace });
    // Shuffle the grid so the starting order isn't always roster order.
    const rng = new Rng(spec.seed);
    const grid = spec.entrants.map((e) => ({ e, k: rng.next() })).sort((a, b) => a.k - b.k).map((x) => x.e);
    grid.forEach((entrant, k) => {
      const car = new Car(k, entrant.fill);
      if (contact) placeOnGrid(car, this.track, k, true);
      else this.rollingStart(car); // ghosts share one spot
      const driver = new NeuralDriver(entrant.driver.weights);
      const team = new Team(driver, new TowerSpotter(entrant.spotter.skill), contact ? makeChief(entrant.chief.brain) : null,
        entrant.driver.pits ?? false, entrant.driver.cautions ?? false);
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
    this.race = spec.kind === 'race' ? new Race(this.world, spec.laps, new PaceCarDriver()) : null;
  }

  get time(): number {
    return this.world.time;
  }

  /** The race has been run to the end (never true for open sessions). */
  get finished(): boolean {
    return this.race?.state === 'finished';
  }

  /** One physics step, plus the bookkeeping the viewer and records want. */
  step(): void {
    if (this.race) this.race.step();
    else this.world.step();
    if (this.learners.size) this.learnFromLaps();
    this.recordTechnique();
    if (this.collectStrokes) this.strokes.collect(this.world.cars);
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
    const score = -l.ref - DAMAGE_SECONDS * Math.max(0, l.health - car.health) - HARM_SECONDS * harm
      - l.fearScale * (FEAR_SECONDS * l.fear + TRAUMA_SECONDS * extraTrauma);
    if (l.learner.lapDone(score)) {
      this.learned.push({ driverId: l.driverId, weights: l.learner.weights.slice(), steps: l.learner.updates });
    }
  }

  /** Radio lines since the last call. */
  takeRadio(): RadioLine[] {
    const out = this.pendingRadio;
    this.pendingRadio = [];
    return out;
  }

  snapshot(): SessionSnapshot {
    const cars = this.world.cars.map((car) => this.view(car));
    const standings = this.race?.standings() ?? null;
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
        paceCar: ctl?.paceCarOut ? { x: ctl.paceCar.x, y: ctl.paceCar.y } : null,
        wreckers: (ctl?.wreckers ?? []).map((w) => ({ x: w.x, y: w.y, phase: w.phase })),
      } : null,
      technique: [...this.technique].map(([key, h]) => [key, Array.from(h)]),
    };
  }

  /** The classification and each entrant's numbers. */
  results(): EntrantResult[] {
    const standings = this.race?.standings()
      ?? this.snapshot().order.map((id, i) => ({ car: this.world.cars.find((c) => c.id === id)!, position: i + 1, laps: 0, time: NaN, status: 'running' as const }));
    return standings.map((st) => {
      const car = st.car;
      const e = this.entrants.get(car.id)!;
      const laps = car.lapTimes;
      return {
        key: e.key, driver: e.driver.id, spotter: e.spotter.id, chief: e.chief.id,
        position: st.position, status: st.status, laps: st.laps || car.lapsCompleted, time: st.time,
        bestLap: laps.length ? Math.min(...laps) : null,
        avgLap: laps.length ? laps.reduce((a, b) => a + b, 0) / laps.length : null,
        stops: car.pit.stops, wallHits: car.wallHits, health: car.health,
        worstHit: car.worstHit?.severity ?? 0, worstHitSpeed: car.worstHit?.speed ?? 0,
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
      laps: car.lapsCompleted, bestLap: car.lapTimes.length ? Math.min(...car.lapTimes) : null,
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
    if (this.race) return; // in a race, wrecks are out and the crew chiefs handle stops
    this.world.cars.forEach((car, k) => {
      if (car.retired) {
        const since = this.retiredAt.get(car.id);
        if (since === undefined) { this.retiredAt.set(car.id, this.world.time); return; }
        if (this.world.time - since < RESPAWN_DELAY) return;
        this.retiredAt.delete(car.id);
        const fresh = new Car(car.id, car.color);
        this.rollingStart(fresh);
        fresh.lapTimes.push(...car.lapTimes);
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

  /** Crew calls, pit and retirement events, flags, and each spotter's calls, for the broadcast feed. */
  private pollRadio(): void {
    const world = this.world;
    const push = (line: RadioLine) => {
      this.pendingRadio.push(line);
      this.recentRadio.push(line);
    };
    for (; this.eventsSeen < world.events.length; this.eventsSeen++) {
      const e = world.events[this.eventsSeen];
      const key = this.entrants.get(e.car.id)?.key ?? null;
      if (e.kind === 'flag') push({ time: e.time, key: null, text: e.text });
      else if (key !== null) push({ time: e.time, key, text: e.kind === 'crew' ? `Crew: ${e.text}` : e.text });
    }
    // Forget lines too old to suppress a repeat.
    while (this.recentRadio.length && world.time - this.recentRadio[0].time > RADIO_REPEAT) this.recentRadio.shift();
    for (const car of world.cars) {
      const team = this.teams.get(car.id);
      if (!team || car.retired) continue;
      const key = this.entrants.get(car.id)!.key;
      let prev = this.prevRadio.get(car.id);
      if (!prev) this.prevRadio.set(car.id, (prev = new Float32Array(RADIO_SIZE)));
      for (const text of describeRadio(team.radio, prev)) {
        if (!this.recentRadio.some((l) => l.key === key && l.text === text)) push({ time: world.time, key, text });
      }
      prev.set(team.radio);
    }
  }
}

function makeChief(brain: EntrantSpec['chief']['brain']): CrewChief {
  return brain.kind === 'neural' ? new NeuralCrewChief(brain.weights) : new StrategistCrewChief(brain.traits);
}

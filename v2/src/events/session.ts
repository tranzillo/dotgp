import { NeuralDriver, Team } from '../ai/drivers';
import { PaceCarDriver } from '../ai/formation';
import { NeuralCrewChief } from '../ai/neuralChief';
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
  driver: { id: string; weights: Float32Array };
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
}

/** What the viewer needs about one car, as plain data. */
export interface CarView {
  id: number;
  key: number;
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
}

const RADIO_REPEAT = 4; // seconds before the same call from the same team is repeated
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
      const team = new Team(driver, new TowerSpotter(entrant.spotter.skill), contact ? makeChief(entrant.chief.brain) : null);
      this.world.addCar(car, team);
      this.entrants.set(car.id, entrant);
      this.teams.set(car.id, team);
      this.drivers.set(entrant.driver.id, driver);
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

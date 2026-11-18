import { pitLanes } from '../ai/pitting';
import type { Car } from './car';
import { PHYSICS as P } from './constants';
import type { Standing } from './race';
import type { World } from './world';

/**
 * How a qualifying session is run.
 *
 * Solo (oval style): one car on track at a time, each running the same number
 * of timed laps; its best one counts.
 *
 * Group (F1 style): rounds against the clock with the field on track
 * together. After each round but the last, the slowest are knocked out: the
 * starting field over the number of rounds each time (2 rounds: half, 3: a
 * third...). The last round decides the front; everyone else is classified
 * by their time in the round they went out in.
 */
export interface SoloQualifying {
  format: 'solo';
  /** Timed laps each car runs (after an out-lap from pit road). */
  laps: number;
}
export interface GroupQualifying {
  format: 'group';
  rounds: number;
  /** Each round's clock (s). A lap started before it runs out still counts. */
  roundSeconds: number;
}
export type QualifyingFormat = SoloQualifying | GroupQualifying;

/** Where a qualifying session is, for the viewer (plain data, on tape). */
export interface QualifyingView {
  format: QualifyingFormat['format'];
  /** Group: the round under way or next (0-based), of `rounds`. Solo: 0 of 1. */
  round: number;
  rounds: number;
  /** pits: between rounds (or before the first car goes); green: the clock is running; checkered: cars finishing their laps and coming in. */
  phase: 'pits' | 'green' | 'checkered' | 'finished';
  /** Group: seconds left on the round's clock. */
  clock: number;
  /** How far through the session (0..1). */
  progress: number;
  /** Group: places that go through to the next round (0 in the last). */
  cut: number;
}

/** Something worth putting on the broadcast feed; `mark` also goes on the timeline. */
export interface QualifyingNews {
  car: Car | null;
  text: string;
  mark?: 'pole' | 'round';
}

/** How a car's run ended: back in its box, wrecked, or called off (stuck, or taking far too long). */
export type RunEnd = 'done' | 'out' | 'called-off';

/** One car's time out of its box (a solo run, or a group round). */
interface Run {
  start: number;
  /** Off pit road: its laps are timed from the next line. */
  merged: boolean;
  /** Where (race distance) and when the car was last seen making progress on track. */
  progressDist: number;
  progressAt: number;
  /** Past this long out, the run is called off (s). */
  limit: number;
  end: RunEnd | null;
}

/** A run is called off past this long per lap of it at a crawl (m/s), plus a minute. */
const CRAWL_SPEED = 12;
/** ... or once the car has gone nowhere on track this long (s), under STUCK_DISTANCE (m): beached in the gravel, stuck on the grass, crawling. */
const STUCK_TIME = 15;
const STUCK_DISTANCE = 30;

/** A qualifying session, whatever its format: what the session and its crews need. */
export interface Qualifying {
  readonly format: QualifyingFormat;
  /** Cars in the order they first go out (the draw). */
  readonly runOrder: readonly Car[];
  readonly state: 'running' | 'finished';
  step(): void;
  /** The classification so far: fastest first, then cars without a time. */
  standings(): Standing[];
  /** The crew's call: this car is done for now, bring it in. */
  wantsIn(car: Car): boolean;
  view(): QualifyingView;
  /** Broadcast lines since the last call. */
  takeNews(): QualifyingNews[];
}

export function createQualifying(world: World, format: QualifyingFormat, runOrder: readonly Car[] = world.cars): Qualifying {
  return format.format === 'solo' ? new SoloSession(world, format, runOrder) : new GroupSession(world, format, runOrder);
}

/**
 * What both formats share: every car waits in its pit box, out of the
 * physics, until it's sent out; out of the box it drives pit road, and its
 * laps are timed from the first line after it merges, so the out-lap never
 * counts wherever its box is. The crew (RunChief) calls it in when the format
 * says it's done (wantsIn), and the usual pit cycle (the maneuver, or the
 * driver's own stop) brings it back to its box, where it's parked again.
 */
abstract class QualifyingBase implements Qualifying {
  state: 'running' | 'finished' = 'running';
  protected readonly runs = new Map<Car, Run>();
  private news: QualifyingNews[] = [];

  constructor(readonly world: World, readonly format: QualifyingFormat, readonly runOrder: readonly Car[]) {
    for (const car of runOrder) this.waitInBox(car);
  }

  abstract step(): void;
  abstract standings(): Standing[];
  abstract wantsIn(car: Car): boolean;
  abstract view(): QualifyingView;

  takeNews(): QualifyingNews[] {
    const out = this.news;
    this.news = [];
    return out;
  }

  protected say(car: Car | null, text: string, mark?: QualifyingNews['mark']): void {
    this.news.push({ car, text, ...(mark ? { mark } : {}) });
  }

  /** Cars out of their box now. */
  protected get out(): Car[] {
    return [...this.runs].filter(([, r]) => r.end === null).map(([car]) => car);
  }

  protected isOut(car: Car): boolean {
    const r = this.runs.get(car);
    return !!r && r.end === null;
  }

  /** The car's laps since it merged (the run's, out-lap excluded). */
  protected lapsRun(car: Car): number {
    return this.runs.get(car)?.merged ? car.lapTimes.length : 0;
  }

  /** Send a car out of its box, down pit road (the pit-out maneuver, or the driver's own). Out for at most `seconds`. */
  protected release(car: Car, seconds: number): void {
    this.placeInBox(car);
    car.waiting = false;
    car.cleared = false;
    car.parked = false;
    car.pit.phase = 'out';
    car.pit.call = { tires: false, fuel: 0, repair: false };
    car.lapStartTime = -1;
    car.lapTimes.length = 0;
    car.lapValid.length = 0;
    this.runs.set(car, { start: this.world.time, merged: false, progressDist: car.dist, progressAt: this.world.time, limit: seconds, end: null });
  }

  /** A run's limit: so many laps (out-lap and in-lap included) at a crawl, plus a minute. */
  protected crawl(laps: number): number {
    return 60 + (laps * this.world.track.length) / CRAWL_SPEED;
  }

  /** Follow every car that's out: timing from the merge, and the end of its run. Returns the runs that ended. */
  protected followRuns(): Array<[Car, RunEnd]> {
    const ended: Array<[Car, RunEnd]> = [];
    const time = this.world.time;
    for (const [car, run] of this.runs) {
      if (run.end !== null) continue;
      if (!run.merged && car.pit.phase === 'none') {
        // Off pit road: the clock starts at the line (a crossing on pit road on the way out doesn't count).
        run.merged = true;
        car.lapStartTime = -1;
        car.lapTimes.length = 0;
        car.lapValid.length = 0;
      }
      // Pit road (waiting for a gap, the stop) isn't being stuck.
      if (car.pit.phase !== 'none' || car.dist - run.progressDist >= STUCK_DISTANCE) {
        run.progressDist = car.dist;
        run.progressAt = time;
      }
      let end: RunEnd | null = null;
      if (car.retired) end = car.cleared ? 'out' : null;
      else if (run.merged && (car.pit.phase === 'service' || car.pit.phase === 'out')) end = 'done'; // back in its box (or overshot it)
      else if (time - run.progressAt > STUCK_TIME || time - run.start > run.limit) end = 'called-off';
      if (end) {
        run.end = end;
        this.park(car);
        car.parked = end === 'done'; // parked where it stopped; a wreck or a car called off is taken away
        ended.push([car, end]);
      }
    }
    return ended;
  }

  protected runEnd(car: Car): RunEnd | null {
    return this.runs.get(car)?.end ?? null;
  }

  private placeInBox(car: Car): void {
    car.placeOnTrack(this.world.track, car.pit.boxS, pitLanes(this.world.track).boxLane);
  }

  /** Parked in its pit box, out of the session until it's sent out. */
  private waitInBox(car: Car): void {
    this.placeInBox(car);
    this.park(car);
    car.parked = true; // drawn where it sits
  }

  private park(car: Car): void {
    car.waiting = true;
    car.cleared = true; // not on track for anyone: no contact or draft, spotters and pit traffic ignore it
    car.vx = car.vy = 0;
    car.inputX = car.inputY = 0;
    car.pit.phase = 'none';
    car.pit.call = null;
  }
}

/** Seconds between one car starting its in-lap and the next car leaving its box. */
const NEXT_CAR_DELAY = 2;

/**
 * Solo qualifying: in the run order, one car at a time runs an out-lap and
 * its timed laps; as it starts its in-lap the next car leaves its box. Cars
 * are classified by their best valid timed lap.
 */
class SoloSession extends QualifyingBase {
  /** The car on its timed laps, if one is. */
  private runner: Car | null = null;
  /** Runs started so far. */
  private started = 0;
  private nextAt = NEXT_CAR_DELAY;
  private poleTime = Infinity;
  /** The runner's timed laps put on the feed so far. */
  private lapsCalled = 0;

  constructor(world: World, readonly solo: SoloQualifying, runOrder: readonly Car[]) {
    super(world, solo, runOrder);
  }

  step(): void {
    const world = this.world;
    world.step();
    if (this.state === 'finished') return;
    const ended = this.followRuns();
    const car = this.runner;
    if (car) {
      for (; this.lapsCalled < this.timedLaps(car); this.lapsCalled++) {
        const k = this.lapsCalled;
        this.say(car, `Lap ${k + 1}: ${car.lapTimes[k].toFixed(3)}${car.lapValid[k] ? '' : ' (track limits: deleted)'}`);
      }
      // Its laps run (on to the in-lap), or its run over early: the next car's turn.
      if (this.timedLaps(car) >= this.solo.laps || ended.some(([c]) => c === car)) this.runDone(car);
    }
    if (!this.runner && world.time >= this.nextAt && this.started < this.runOrder.length) {
      const next = this.runOrder[this.started++];
      this.release(next, this.crawl(this.solo.laps + 2));
      this.runner = next;
      this.lapsCalled = 0;
      this.say(next, `On track to qualify (${this.started} of ${this.runOrder.length})`);
    }
    if (this.started === this.runOrder.length && !this.runner && !this.out.length) {
      this.state = 'finished';
      const pole = this.standings()[0];
      if (pole && Number.isFinite(pole.time)) this.say(pole.car, `Takes pole: ${pole.time.toFixed(3)}`, 'pole');
    }
  }

  private runDone(car: Car): void {
    this.runner = null;
    this.nextAt = this.world.time + NEXT_CAR_DELAY;
    const best = this.best(car);
    const end = this.runEnd(car);
    if (!Number.isFinite(best)) {
      this.say(car, end === 'out' ? 'Wrecked: no time' : end === 'called-off' ? 'Stopped on track: no time' : 'No time set');
      return;
    }
    const position = this.standings().findIndex((st) => st.car === car) + 1;
    this.say(car, `${end === 'out' ? 'Wrecked, keeps' : 'Provisionally'} P${position}: ${best.toFixed(3)}`);
    if (best < this.poleTime) {
      this.poleTime = best;
      this.say(car, `Provisional pole: ${best.toFixed(3)}`, 'pole');
    }
  }

  wantsIn(car: Car): boolean {
    return this.timedLaps(car) >= this.solo.laps;
  }

  /** The car's timed laps so far (the run's first `laps` laps after the out-lap). */
  timedLaps(car: Car): number {
    return Math.min(this.solo.laps, this.lapsRun(car));
  }

  /** The car's best valid timed lap (Infinity without one). */
  best(car: Car): number {
    let best = Infinity;
    for (let k = 0; k < this.timedLaps(car); k++) if (car.lapValid[k] && car.lapTimes[k] < best) best = car.lapTimes[k];
    return best;
  }

  /**
   * Cars with a time, fastest first (equal times: the earlier run); then the
   * car on its laps, the cars still to run in the order they'll go, and the
   * cars that ran without setting a time.
   */
  standings(): Standing[] {
    const order = this.runOrder;
    const timed = order.filter((c) => Number.isFinite(this.best(c)))
      .sort((a, b) => this.best(a) - this.best(b) || order.indexOf(a) - order.indexOf(b));
    const rank = (c: Car) => (c === this.runner ? 0 : !this.runs.has(c) ? 1 : 2);
    const untimed = order.filter((c) => !Number.isFinite(this.best(c)))
      .sort((a, b) => rank(a) - rank(b) || order.indexOf(a) - order.indexOf(b));
    return [...timed, ...untimed].map((car, i): Standing => {
      const best = this.best(car);
      return {
        car,
        position: i + 1,
        laps: this.timedLaps(car),
        time: Number.isFinite(best) ? best : NaN,
        status: car === this.runner ? 'running' : !this.runs.has(car) ? 'pit' : car.retired ? 'out' : 'finished',
      };
    });
  }

  view(): QualifyingView {
    const n = this.runOrder.length;
    const done = this.started - (this.runner ? 1 : 0);
    return {
      format: 'solo', round: 0, rounds: 1, clock: 0, cut: 0,
      phase: this.state === 'finished' ? 'finished' : this.runner ? 'green' : 'pits',
      progress: this.state === 'finished' ? 1 : n ? done / n : 1,
    };
  }
}

/** Seconds between the first round's start and the next car leaving pit road, round to round. */
const RELEASE_GAP = 1.5;
/** Seconds in the pits between rounds (and before the first). */
const BETWEEN_ROUNDS = 5;

/**
 * Group qualifying: each round the cars still in it leave the pits a moment
 * apart and lap against the clock; a lap started before the clock runs out
 * still counts, then each car comes in at its next chance. Once they're all
 * in, the round is ranked by best valid lap and the slowest go out.
 */
class GroupSession extends QualifyingBase {
  private round = 0;
  private phase: 'pits' | 'green' | 'checkered' = 'pits';
  private phaseAt = 0;
  private nextAt = BETWEEN_ROUNDS;
  /** Cars still in it, in the order they'd be classified before this round's times. */
  private alive: Car[];
  /** Knocked out, round by round (each fastest first), with their time in that round. */
  private readonly knockedOut: Car[][] = [];
  private readonly knockedTime = new Map<Car, number>();
  /** This round: each car's best valid lap, and laps it has run. */
  private readonly roundBest = new Map<Car, number>();
  private readonly roundLaps = new Map<Car, number>();
  /** Still to leave the pits this round, and when the next goes; those sent out so far. */
  private queue: Car[] = [];
  private readonly sentOut = new Set<Car>();
  private releaseAt = 0;
  /** When the clock ran out this round. */
  private flagAt = Infinity;
  private readonly cutSize: number;

  constructor(world: World, readonly group: GroupQualifying, runOrder: readonly Car[]) {
    super(world, group, runOrder);
    this.alive = [...runOrder];
    this.cutSize = Math.floor(runOrder.length / Math.max(1, group.rounds));
  }

  private get lastRound(): boolean {
    return this.round >= this.group.rounds - 1;
  }

  step(): void {
    const world = this.world;
    world.step();
    if (this.state === 'finished') return;
    const time = world.time;
    this.followRuns();
    if (this.phase === 'pits' && time >= this.nextAt) this.startRound();
    if (this.phase === 'green') {
      while (this.queue.length && time >= this.releaseAt) {
        const car = this.queue.shift()!;
        this.release(car, this.group.roundSeconds + this.crawl(2));
        this.sentOut.add(car);
        this.releaseAt = time + RELEASE_GAP;
      }
      if (time - this.phaseAt >= this.group.roundSeconds) {
        this.phase = 'checkered';
        this.phaseAt = time;
        this.flagAt = time;
        this.queue = []; // not out by now: not out this round
        this.say(null, `${this.name()}: checkered flag, laps under way still count`, 'round');
      }
    }
    this.countLaps();
    if (this.phase === 'checkered' && !this.out.length) this.endRound();
  }

  /** Q1, Q2...; one round is just qualifying. */
  private name(round = this.round): string {
    return this.group.rounds > 1 ? `Q${round + 1}` : 'Qualifying';
  }

  private startRound(): void {
    const time = this.world.time;
    this.phase = 'green';
    this.phaseAt = time;
    this.flagAt = Infinity;
    this.roundBest.clear();
    this.roundLaps.clear();
    this.sentOut.clear();
    // A fresh set and a full tank; the slowest in the last round out first (round one: the draw).
    this.queue = this.alive.filter((c) => !c.retired);
    if (this.round > 0) this.queue.reverse();
    for (const car of this.queue) {
      car.tireLife = 1;
      car.fuel = P.FUEL_CAPACITY;
    }
    this.releaseAt = time;
    this.say(null, `${this.name()}: green, ${this.queue.length} cars, ${Math.round(this.group.roundSeconds / 60)} minutes`, 'round');
  }

  /** New laps from the cars sent out this round: they count if they began before the checkered flag. */
  private countLaps(): void {
    for (const car of this.sentOut) {
      const seen = this.roundLaps.get(car) ?? 0;
      const laps = this.lapsRun(car);
      if (laps <= seen) continue;
      // Each new lap began where the one after it ended, back from the last crossing.
      const began: number[] = [];
      let t = car.lapStartTime;
      for (let k = laps - 1; k >= seen; k--) began[k] = t -= car.lapTimes[k];
      for (let k = seen; k < laps; k++) {
        if (began[k] > this.flagAt || !car.lapValid[k] || car.lapTimes[k] >= (this.roundBest.get(car) ?? Infinity)) continue;
        this.roundBest.set(car, car.lapTimes[k]);
        const position = this.ranking().indexOf(car) + 1;
        const drop = !this.lastRound && position > this.advancing() ? ' (in the drop zone)' : '';
        this.say(car, `${this.name()} lap ${car.lapTimes[k].toFixed(3)}: P${position}${drop}`);
      }
      this.roundLaps.set(car, laps);
    }
  }

  /** Cars still in it, by their best this round (no time: in their order before the round). */
  private ranking(): Car[] {
    const before = this.alive;
    const best = (c: Car) => this.roundBest.get(c) ?? Infinity;
    return [...before].sort((a, b) => {
      const ta = best(a), tb = best(b);
      if (ta !== tb) return ta - tb;
      return before.indexOf(a) - before.indexOf(b);
    });
  }

  /** Places that go through this round. */
  private advancing(): number {
    return this.lastRound ? this.alive.length : Math.max(1, this.alive.length - this.cutSize);
  }

  private endRound(): void {
    const ranking = this.ranking();
    if (this.lastRound) {
      this.alive = ranking;
      this.state = 'finished';
      const pole = ranking[0];
      const t = this.roundBest.get(pole);
      if (t !== undefined) this.say(pole, `Takes pole: ${t.toFixed(3)}`, 'pole');
      else this.say(null, 'Qualifying over: no times in the last round');
      return;
    }
    const through = this.advancing();
    const out = ranking.slice(through);
    for (const car of out) this.knockedTime.set(car, this.roundBest.get(car) ?? NaN);
    this.knockedOut.push(out);
    this.alive = ranking.slice(0, through);
    out.forEach((car) => this.say(car, `Knocked out in ${this.name()}: P${through + 1 + out.indexOf(car)}`));
    this.say(null, `${this.name()} over: ${out.map((c) => `#${c.number}`).join(', ')} knocked out`, 'round');
    this.round++;
    this.phase = 'pits';
    this.phaseAt = this.world.time;
    this.nextAt = this.world.time + BETWEEN_ROUNDS;
  }

  wantsIn(car: Car): boolean {
    // Took the checkered flag: crossed the line since the clock ran out.
    return this.phase === 'checkered' && car.lapStartTime >= this.flagAt;
  }

  /** Still in it (by this round's times so far), then the rounds' knockouts, latest first. */
  standings(): Standing[] {
    const rows: Array<{ car: Car; time: number; laps: number; status: Standing['status'] }> = [];
    for (const car of this.ranking()) {
      const t = this.roundBest.get(car);
      rows.push({
        car, time: t ?? NaN, laps: this.roundLaps.get(car) ?? 0,
        status: car.retired ? 'out' : this.isOut(car) ? 'running' : this.state === 'finished' ? 'finished' : 'pit',
      });
    }
    for (let r = this.knockedOut.length - 1; r >= 0; r--) {
      for (const car of this.knockedOut[r]) {
        rows.push({ car, time: this.knockedTime.get(car) ?? NaN, laps: 0, status: car.retired ? 'out' : 'finished' });
      }
    }
    return rows.map((row, i) => ({ ...row, position: i + 1 }));
  }

  view(): QualifyingView {
    const { rounds, roundSeconds } = this.group;
    const time = this.world.time;
    const within = this.phase === 'green' ? Math.min(1, (time - this.phaseAt) / roundSeconds) : this.phase === 'checkered' ? 1 : 0;
    return {
      format: 'group', round: this.round, rounds,
      phase: this.state === 'finished' ? 'finished' : this.phase,
      clock: this.phase === 'green' ? Math.max(0, roundSeconds - (time - this.phaseAt)) : this.phase === 'pits' ? roundSeconds : 0,
      progress: this.state === 'finished' ? 1 : (this.round + within) / rounds,
      cut: this.lastRound || this.state === 'finished' ? 0 : this.advancing(),
    };
  }
}

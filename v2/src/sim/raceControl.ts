import { Car } from './car';
import { G, PHYSICS as P, PIT_SERVICE } from './constants';
import type { Track } from './track';
import type { World } from './world';
import type { StartProcedure } from '../rules/rulebook';

/**
 * Race control: flags, the pace car and the wrecker crew.
 *
 *   pace     field forms up double file behind the pace car (race start)
 *   restart  pace car has pulled off; the leader sets the pace to the line
 *   green    racing
 *   caution  wreck or stopped car: field slows and forms up behind the pace car
 *            while wreckers tow the wrecks to the garage
 *
 * The green flag flies when the leader crosses the start/finish line.
 */
export type Flag = 'pace' | 'restart' | 'green' | 'caution' | 'formation' | 'grid';
/** A standing start's settings (the rulebook's). */
export type StandingStart = Extract<StartProcedure, { kind: 'standing' }>;
/** Metres from the start line back to the pole position's box. */
const POLE_BOX = 12;
/** How hard the formation lap slows to a stop on the grid (m/s^2): gently. */
const FORMATION_DECEL = 2.5;
/** How far short of its box each car is as a race joins the end of the formation lap (m). */
const FORMATION_ARRIVAL = 50;

/** Minimum laps under caution, however quickly the track is cleared. */
const MIN_CAUTION_LAPS = 2;
export const ROW_GAP = 10; // m between rows in formation
const FIRST_ROW_GAP = 16; // m from the pace car to the front row
/** Single file under caution: a car length and the formation's following gap between cars (m). */
const SINGLE_FILE_GAP = 9;
export const FILE_OFFSET = 2.6; // m either side of the centerline for the two files
const WRECKER_SPEED = 22;
const TOW_SPEED = 15;
const HOOK_TIME = 8;
const STALL_TIME = 5; // s stopped on the racing surface before a car counts as a wreck
/** Marshals' time to lift a wrecked car off a circuit (s). */
const MARSHAL_TIME = 25;

/** The pace car's livery number; it never appears in standings. */
export const PACE_CAR_ID = -1;

type WreckerPhase = 'drive' | 'hook' | 'tow' | 'done';

export interface Wrecker {
  wreck: Car;
  x: number;
  y: number;
  /** Track position while on the oval; a path index once on infield roads. */
  s: number;
  d: number;
  phase: WreckerPhase;
  timer: number;
  /** Remaining waypoints (world) once it leaves the oval for the garage. */
  route: Array<[number, number]>;
  /** Track s where it leaves the oval with the tow, and direction of travel (+1/-1). */
  exitS: number;
  dir: number;
  /** The road network node where it leaves the oval with the tow (an apron access), or '' (marshals). */
  via: string;
  /** Marshals with a crane (circuits) rather than a tow truck. */
  marshals?: boolean;
}

export interface FormationSlot {
  index: number;
  /** Track s the car should hold. */
  s: number;
  d: number;
  /** Speed that slot is moving at. */
  speed: number;
}

/** How far the virtual pace car may run ahead of a leader that can't keep up before it waits for it (m). */
const VIRTUAL_LEAD_MAX = 100;

export class RaceControl {
  readonly world: World;
  readonly track: Track;
  flag: Flag = 'pace';
  readonly paceCar: Car;
  /** Pace car is on track (otherwise parked at the end of pit road). */
  paceCarOut = true;
  /** Pace car is heading for pit road at the next opportunity. */
  oneToGo = true;
  readonly paceSpeed: number;
  readonly wreckers: Wrecker[] = [];
  cautions = 0;
  /** Laps the leader had completed when the current caution came out. */
  private cautionLap = 0;
  get cautionStartLap(): number {
    return this.cautionLap;
  }
  /** The leader's race distance when the pace car picked it up. */
  private pickupDist = 0;
  /** Laps this caution runs at least. */
  private cautionMinLaps = MIN_CAUTION_LAPS;
  private readonly handled = new Set<Car>();
  private readonly cautioned = new Set<Car>();
  private readonly stoppedSince = new Map<Car, number>();
  private garageSlots = 0;
  /** Cars in formation order this tick, and their slots. */
  private order: Car[] = [];
  /** Stewards' penalty, or a car that couldn't keep pace: to the back of the official order. */
  sendToTail(car: Car): void {
    if (!this.pacing) return;
    this.order = this.order.filter((c) => c !== car).concat(car);
  }

  /**
   * Race control's calls to crews this caution: a car ahead on track of a car
   * in an earlier row of the official order (row mates are side by side, so
   * never) is told to line up behind it, with how far the car had gone when
   * told. Still out of order a full lap later: the stewards' case.
   */
  private readonly calls = new Map<string, { car: Car; against: Car; dist: number }>();

  /** Pairs already ruled, or reported as jumped restarts. */
  private readonly ruled = new Set<string>();

  /** For the stewards: a car that didn't give a place back within a lap of being told, or passed before the green at a restart. */
  private readonly cases: Array<{ car: Car; against: Car; restart: boolean }> = [];
  /** Calls still open when the green came out, carried until a lap after each. */
  private carried: Array<{ car: Car; against: Car; dist: number }> = [];

  /**
   * Under caution the field runs single file until one to go, then doubles
   * up for the restart (the start's pace laps are double file throughout).
   */
  get singleFile(): boolean {
    if (this.safetyCar) return this.flag === 'caution' || this.flag === 'restart';
    return this.flag === 'caution' && !this.oneToGo;
  }

  /** Row of a place in the official order: the field doubles up for a pace-car restart, not behind the safety car. */
  rowOf(index: number): number {
    return this.safetyCar ? index : Math.floor(index / 2);
  }

  /**
   * Pace at a point on the lap. The pace car holds one speed all the way
   * round (an oval's corners are all alike); a safety car drives the track,
   * at formation pace.
   */
  paceSpeedAt(s: number): number {
    return this.safetyCar ? this.formationSpeedAt(s) : this.paceSpeed;
  }

  /** Room between places in line: in its place means closer than this to it. */
  lineSpacing(): number {
    return this.singleFile ? SINGLE_FILE_GAP : ROW_GAP;
  }

  /** Where a car giving way drives: low, a car's width (and a little air) inside the line. */
  yieldLane(): number {
    return (this.singleFile ? 0 : FILE_OFFSET) + 2 * P.CAR_RADIUS + 0.5;
  }

  /** The official order (pacing), or the running order (green). */
  lineOrder(): readonly Car[] {
    return this.order;
  }

  /** Race control's call to this car's crew, if any: the car it has been told to line up behind. */
  toLineUpBehind(car: Car): Car | null {
    for (const c of this.calls.values()) if (c.car === car) return c.against;
    return null;
  }

  takeLineupCases(): Array<{ car: Car; against: Car; restart: boolean }> {
    return this.cases.splice(0);
  }

  /** Cars waved around the pace car (between it and the leader before it has picked up the leader). */
  private readonly waved = new Set<Car>();
  private readonly wavedTold = new Set<Car>();
  /**
   * Laps each car in the line is down on the head of the order: lead-lap cars
   * line up ahead of lapped cars, and a car rejoining from the pits goes to
   * the back of its own lap's group. Set when the order freezes, and for a
   * car rejoining, when it rejoins (if the leader lapped it during its stop,
   * it's lapped).
   */
  private readonly lapGroup = new Map<Car, number>();

  wavedAround(car: Car): boolean {
    return this.waved.has(car);
  }

  /** The pace car has picked up the leader (and leads the line) this caution. */
  pickedUp = false;
  /** Where the virtual pace car is when the real one isn't leading the line (NaN: none). */
  private virtualS = NaN;
  private readonly slots = new Map<Car, FormationSlot>();
  /** Set when the green flag waves; used by the race to start the clock. */
  onGreen: ((leader: Car) => void) | null = null;
  /** A standing start's lights going out (the race starts there and then). */
  onLightsOut: (() => void) | null = null;
  /** Standing start: red lights showing (0 when none, or out). */
  lights = 0;
  /** A safety car (circuits) rather than a pace car: drives the track, single file throughout, marshals recover wrecks. */
  safetyCar = false;
  private standing: StandingStart | null = null;
  private readonly boxes = new Map<Car, { s: number; d: number }>();
  /** How far the formation lap has left to its boxes, when the lights sequence began, how long they hold. */
  private formationLeft = 0;
  private lightsFrom = NaN;
  private hold = 0;

  constructor(world: World) {
    this.world = world;
    this.track = world.track;
    this.paceSpeed = paceSpeedFor(this.track);
    this.paceCar = new Car(PACE_CAR_ID, '#ffffff');
    world.control = this;
    world.opts.autoClearWrecks = false;
  }

  get pacing(): boolean {
    return this.flag !== 'green';
  }

  /**
   * Line the field up double file behind the pace car coming off the last
   * turn, at pace speed, with the pace laps already run: the pace car pulls
   * onto pit road and the green flies as the leader first reaches the line.
   */
  formUp(cars: Car[]): void {
    const t = this.track;
    const paceS = pullOffS(t) - 120;
    this.paceCar.placeOnTrack(t, paceS, 0);
    setSpeed(this.paceCar, t, this.paceSpeed);
    cars.forEach((car, k) => {
      const row = Math.floor(k / 2);
      // Behind the line by however far back the row is, even when a big field reaches past half a lap (wrapped,
      // the back rows would count as ahead of the leader).
      const s = paceS - FIRST_ROW_GAP - row * ROW_GAP;
      car.placeOnTrack(t, s, k % 2 === 0 ? FILE_OFFSET : -FILE_OFFSET, s - t.length * Math.ceil(s / t.length)); // leader inside
      setSpeed(car, t, this.paceSpeed);
    });
    this.flag = 'pace';
    this.paceCarOut = true;
    this.pickedUp = true; // the field forms up right behind it
    // Joined on the last pace lap (watchers needn't sit through the rest): the pace car is coming in.
    this.oneToGo = true;
    this.world.announce(cars[0] ?? this.paceCar, 'flag', 'Pace car coming in: green flag next time by');
  }

  /**
   * A standing start: every car in its own grid box behind the line,
   * staggered left and right, stopped; the pace car parked on pit road for
   * cautions. With a formation lap the race joins it at its end (watchers
   * needn't sit through the rest): the field rolls up to its boxes in grid
   * order, already staggered, and brakes to a stop in them; then the lights.
   */
  formUpStanding(cars: Car[], start: StandingStart, random: () => number): void {
    const t = this.track;
    this.standing = start;
    this.hold = start.hold[0] + random() * (start.hold[1] - start.hold[0]);
    const stagger = Math.min(t.halfWidth * 0.45, FILE_OFFSET + 0.4);
    this.formationLeft = start.formationLap ? FORMATION_ARRIVAL : 0;
    this.virtualS = t.wrapS(-POLE_BOX - this.formationLeft);
    const v = this.formationApproachSpeed();
    cars.forEach((car, k) => {
      const s = -POLE_BOX - k * start.gridPitch;
      const d = k % 2 === 0 ? stagger : -stagger;
      car.placeOnTrack(t, s - this.formationLeft, d, s - this.formationLeft);
      setSpeed(car, t, v);
      this.boxes.set(car, { s: t.wrapS(s), d });
    });
    this.paceCar.placeOnTrack(t, (t.pit.wallStart + t.pit.wallEnd) / 2, t.pit.laneD + 2 + t.pitOffset((t.pit.wallStart + t.pit.wallEnd) / 2));
    this.paceCar.cleared = true;
    this.paceCarOut = false;
    this.pickedUp = false;
    this.oneToGo = false;
    this.flag = start.formationLap ? 'formation' : 'grid';
  }

  /**
   * Formation pace at a point on the lap: well within what the corner there
   * allows (60% of it), and no faster than the pace speed on the straights.
   */
  formationSpeedAt(s: number): number {
    const k = Math.abs(this.track.curvatureAt(s));
    const corner = k > 1e-6 ? Math.sqrt((P.TIRE_MU * 0.8 * G) / k) : Infinity;
    return Math.min(PIT_SERVICE.SPEED_LIMIT * 2, 0.6 * corner);
  }

  /** The end of the formation lap: formation pace, braking gently to a stop with the pole box's car in it. */
  private formationApproachSpeed(): number {
    return Math.min(this.formationSpeedAt(this.virtualS), Math.sqrt(2 * FORMATION_DECEL * Math.max(0, this.formationLeft)));
  }

  /** End of the formation lap and the grid: each place is its grid box, as far short of it as the pole car is of its own. */
  private standingSlots(dt: number): void {
    const t = this.track;
    let v = 0;
    if (this.flag === 'formation') {
      v = this.formationApproachSpeed();
      this.virtualS = t.wrapS(this.virtualS + v * dt);
      this.formationLeft -= v * dt;
      if (this.formationLeft < 0.5) {
        this.formationLeft = 0;
        v = 0;
        this.flag = 'grid';
      }
    }
    this.order.forEach((car, index) => {
      const box = this.boxes.get(car);
      if (box) {
        this.slots.set(car, { index, s: t.wrapS(box.s - this.formationLeft), d: box.d, speed: v });
      } else {
        this.slots.set(car, { index, s: t.wrapS(this.virtualS - index * SINGLE_FILE_GAP), d: 0, speed: v });
      }
    });
  }

  /**
   * The start lights: once the whole field is stopped on the grid, one red
   * light comes on each interval; with all of them on they hold for a random
   * time, then go out, and that's the start.
   */
  private startLights(): void {
    const start = this.standing!;
    const now = this.world.time;
    if (Number.isNaN(this.lightsFrom)) {
      const running = this.world.cars.filter((c) => !c.retired && c.pit.phase === 'none');
      if (running.every((c) => c.speed < 0.3)) {
        this.lightsFrom = now;
        this.world.announce(running[0] ?? this.paceCar, 'flag', 'The field is on the grid: lights');
      }
      return;
    }
    const allOn = this.lightsFrom + (start.lights - 1) * start.lightInterval;
    if (now < allOn + this.hold) {
      this.lights = Math.min(start.lights, 1 + Math.floor((now - this.lightsFrom) / start.lightInterval));
      return;
    }
    this.lights = 0;
    this.flag = 'green';
    this.world.announce(this.order[0] ?? this.paceCar, 'flag', 'Lights out!');
    this.onLightsOut?.();
  }

  /**
   * Green from wherever the field is, with no pace laps (drills that begin
   * mid-race): the pace car waits on pit road for the next caution.
   */
  startGreen(): void {
    const t = this.track;
    this.paceCar.placeOnTrack(t, (t.pit.wallStart + t.pit.wallEnd) / 2, t.pit.laneD + 2 + t.pitOffset((t.pit.wallStart + t.pit.wallEnd) / 2));
    this.paceCar.cleared = true;
    this.paceCarOut = false;
    this.oneToGo = false;
    this.flag = 'green';
  }

  slotFor(car: Car): FormationSlot | undefined {
    return this.slots.get(car);
  }

  /** Called every world step, after physics. */
  step(dt: number, leader: Car | null): void {
    const t = this.track;
    this.detectIncidents(dt);
    this.stepWreckers(dt);
    this.updateFormation(leader, dt);
    if (this.flag === 'grid') this.startLights();

    if (this.flag === 'pace' && !this.oneToGo && leader && this.crossedLine(leader)) {
      this.oneToGo = true;
      this.world.announce(leader, 'flag', 'One lap to go to the green');
    }
    if (this.flag === 'caution') {
      const laps = leader ? leader.lapsCompleted - this.cautionLap : 0;
      const clear = this.wreckers.every((w) => w.phase === 'done' || (w.phase === 'tow' && w.wreck.d > t.innerEdge(w.wreck.trackIdx) + 3));
      // One to go once the track is clear and the minimum laps are run. Race control doesn't wait for the
      // field to be lined up: cars still catching up restart from where they are. But the pace car has to have
      // the field first, and a full lap behind it to sort the line out: there's no restart to count down to without it.
      // The head of the official order: the car the pace car picks up (the race leader may have pitted).
      const head = this.order[0] ?? null;
      const lapBehind = this.pickedUp && !!head && head.dist >= this.pickupDist + t.length;
      if (clear && laps >= this.cautionMinLaps && lapBehind) this.oneToGo = true;
      this.releasePaceCar(head);
    }
    // The pace car pulls off onto pit road; the leader takes the field to the green.
    if ((this.flag === 'pace' || this.flag === 'caution') && this.paceCarOut && this.oneToGo
      && this.paceCar.d > t.innerEdge(this.paceCar.trackIdx) + 0.5 && this.paceCarHeadingIn()) {
      this.flag = 'restart';
      this.world.announce(leader ?? this.paceCar, 'flag', this.safetyCar ? 'Safety car in this lap: leader to the line for the restart' : 'Pace car is off: leader to the line for the green');
    }
    if (this.paceCarOut && this.oneToGo && this.paceCar.surface === 'pit' && t.signedS(this.paceCar.s) > t.pit.wallStart + 15
      && t.signedS(this.paceCar.s) < t.pit.wallEnd - 20) {
      this.paceCarOut = false; // pulled in and parked
      this.pickedUp = false;
      this.paceCar.cleared = true; // parked off to the side: not an obstacle on pit road
    }
    if (this.flag === 'restart' && leader && this.crossedLine(leader)) {
      this.flag = 'green';
      this.world.announce(leader, 'flag', 'Green flag!');
      this.onGreen?.(leader);
    }
    this.lineup();
  }

  /** Signed distance from a car to its slot along the track: + it's behind its place, - ahead of it. */
  private slotError(car: Car): number {
    const slot = this.slots.get(car);
    if (!slot) return 0;
    const t = this.track;
    let err = t.distanceFrom(car.s, slot.s);
    if (err > t.length / 2) err -= t.length;
    return err;
  }

  /**
   * The official order against the cars on track, between cars that are in
   * the line (within a row of their place): a car ahead of one in an earlier
   * row is told to line up behind it, and still out of order a full lap later
   * it's the stewards' case; a call still open at the green carries on, and a
   * lap after it the car is a case if it's still ahead of the other. Once the
   * pace car is off, passing a car ahead in line before the green is a jumped
   * restart. Cars still catching up, or dropping back to give places back,
   * aren't in the line yet: they're left to drive.
   */
  private lineup(): void {
    if (!this.pacing) {
      // Calls still open at the green: a lap after each, still ahead of the other car (by race distance,
      // now they're racing) means the place was never given back.
      for (const c of this.calls.values()) this.carried.push(c);
      this.calls.clear();
      this.ruled.clear();
      this.carried = this.carried.filter((c) => {
        if (c.car.retired || c.against.retired) return false;
        if (c.car.dist < c.dist + this.track.length) return true;
        if (c.car.dist > c.against.dist) this.cases.push({ car: c.car, against: c.against, restart: false });
        return false;
      });
      return;
    }
    // Before the pace car has the leader there's no line yet: the field is still slowing, each in its own way.
    if (this.flag === 'caution' && !this.pickedUp) return;
    // The formation lap and the grid: no calls (the field drives round in grid order and stops in its boxes).
    if (this.flag === 'formation' || this.flag === 'grid') return;
    const inLine = this.order.filter((c) => Math.abs(this.slotError(c)) < this.lineSpacing());
    const index = new Map(this.order.map((c, i) => [c, i]));
    const single = this.singleFile;
    const row = (c: Car) => (single ? index.get(c)! : Math.floor(index.get(c)! / 2));
    // Ahead on track, between two cars in the line: the shorter way round (the line is far shorter than half a
    // lap, so for cars in it this is never ambiguous). Not race distance: a car a lap down running ahead of a
    // lead-lap car has less race distance, but it is ahead of it. Cars running ahead of the leader at the
    // caution aren't in the line (their place is at its tail): they're waved around and join it there.
    // Out of order means got past: clear ahead by a car length. Nose to nose is two cars settling into line.
    const L = this.track.length;
    const aheadOf = (b: Car, a: Car) => {
      const d = this.track.distanceFrom(a.s, b.s);
      return d < L / 2 && d > 2 * P.CAR_RADIUS;
    };
    const now = new Map<string, { car: Car; against: Car }>();
    for (const a of inLine) {
      for (const b of inLine) {
        if (b === a || row(b) <= row(a) || !aheadOf(b, a)) continue; // b behind a in line, ahead of it on track
        now.set(`${a.id}:${b.id}`, { car: b, against: a });
      }
    }
    const caseFor = new Set<Car>(); // one ruling per car, however many cars it's ahead of
    for (const [key, w] of now) {
      if (this.ruled.has(key)) continue;
      // Once the pace car is off there's no time to put things right: the stewards judge the whole restart
      // at the green (detect.ts). Calls made before carry on as calls.
      if (this.flag === 'restart' && !this.calls.has(key)) continue;
      const call = this.calls.get(key);
      if (!call) {
        this.calls.set(key, { ...w, dist: w.car.dist });
        this.world.announce(w.car, 'crew', `Race control: line up behind #${w.against.number}`);
      } else if (w.car.dist >= call.dist + this.track.length) {
        this.ruled.add(key);
        this.calls.delete(key);
        if (!caseFor.has(w.car)) this.cases.push({ car: w.car, against: w.against, restart: false });
        caseFor.add(w.car);
      }
    }
    for (const key of [...this.calls.keys()]) if (!now.has(key)) this.calls.delete(key); // put right
  }

  // ---------- incidents ----------

  private detectIncidents(dt: number): void {
    const t = this.track;
    for (const car of this.world.cars) {
      if (this.handled.has(car) || car.cleared) continue;
      // A car stopped on the racing surface (out of fuel, spun) is a wreck too; waiting on the grid it's just
      // waiting (a car that doesn't get away counts from the start).
      if (!car.retired && this.flag !== 'grid' && car.pit.phase === 'none' && car.speed < 3 && car.d < t.innerEdge(car.trackIdx) + 1) {
        const since = (this.stoppedSince.get(car) ?? 0) + dt;
        this.stoppedSince.set(car, since);
        if (since > STALL_TIME) {
          car.retired = true;
          this.world.announce(car, 'retired', 'Stopped on track');
        }
      } else {
        this.stoppedSince.delete(car);
      }
      if (!car.retired) continue;
      // Caution as soon as a car is out on or near the racing surface; the wrecker goes once it stops.
      if (this.flag === 'green' && car.d < t.apronEdgeAt(car.s) + 5 && car.d > t.outerEdgeAt(car.s) - 5 && !this.cautioned.has(car)) {
        this.cautioned.add(car);
        this.throwCaution(car);
      }
      if (car.speed > 1) continue;
      this.handled.add(car);
      this.dispatchWrecker(car);
    }
  }

  private throwCaution(cause: Car): void {
    this.flag = 'caution';
    this.cautions++;
    this.oneToGo = false;
    this.cautionMinLaps = MIN_CAUTION_LAPS;
    const leader = this.order[0];
    this.cautionLap = leader ? leader.lapsCompleted : 0;
    this.world.announce(cause, 'flag', this.safetyCar ? 'Safety car deployed: no overtaking' : 'Caution! Field slows, pace car coming out');
  }

  /**
   * A caution with nothing to clear (debris on track): the field forms up
   * behind the pace car for the minimum caution laps, then restarts. Used by
   * caution drills; real races could call it too.
   */
  debrisCaution(minLaps = MIN_CAUTION_LAPS): void {
    if (this.flag !== 'green' || !this.order.length) return;
    this.flag = 'caution';
    this.cautions++;
    this.oneToGo = false;
    this.cautionMinLaps = minLaps;
    this.cautionLap = this.order[0].lapsCompleted;
    this.world.announce(this.order[0], 'flag', this.safetyCar ? 'Safety car deployed for debris: no overtaking' : 'Caution for debris: field slows, pace car coming out');
  }

  /**
   * The pace car waits at the end of pit road and pulls out just in front of
   * the leader as it arrives, at the distance that counts as picking it up.
   * Cars on the road between them don't hold it in: they're waved around.
   */
  private releasePaceCar(leader: Car | null): void {
    if (this.paceCarOut || !leader || this.oneToGo || leader.pit.phase !== 'none') return;
    const t = this.track;
    const toExit = t.distanceFrom(leader.s, t.pit.wallEnd);
    if (toExit > FIRST_ROW_GAP && toExit < FIRST_ROW_GAP + ROW_GAP) {
      this.paceCar.placeOnTrack(t, t.pit.wallEnd - 5, t.pit.wallD + t.pit.wallThickness / 2 + 3 + t.pitOffset(t.pit.wallEnd - 5));
      setSpeed(this.paceCar, t, this.paceSpeedAt(this.paceCar.s));
      this.paceCar.retired = false;
      this.paceCar.cleared = false;
      this.paceCarOut = true;
    }
  }

  private paceCarHeadingIn(): boolean {
    const r = this.track.signedS(this.paceCar.s);
    return r > pullOffS(this.track) - 10 && r < this.track.pit.wallEnd;
  }

  crossedLine(car: Car): boolean {
    // Lap timing has already registered the crossing this step if lapStartTime is "now".
    return Math.abs(car.lapStartTime - this.world.time) < P.DT * 1.5;
  }

  // ---------- formation ----------

  private updateFormation(leader: Car | null, dt: number): void {
    const t = this.track;
    this.slots.clear();
    const inLine = (c: Car) => !c.retired && !c.cleared && c.pit.phase === 'none';
    const byDistance = (a: Car, b: Car) => b.dist - a.dist;
    const L = t.length;
    const lapsBehind = (head: Car | undefined, c: Car) => (head ? Math.max(0, Math.floor((head.dist - c.dist) / L)) : 0);
    if (!this.pacing || !this.order.length) {
      // Under green, the running order; the first step of pacing freezes it as the official order.
      this.order = this.world.cars.filter(inLine).sort(byDistance);
      this.lapGroup.clear();
      for (const c of this.order) this.lapGroup.set(c, lapsBehind(this.order[0], c));
    } else {
      // The official order, frozen when the caution came out: it changes only when cars leave it (pitting,
      // wrecked) or rejoin (at the back of their lap's group: lead-lap cars ahead of lapped cars), and by
      // race control's rulings, never because cars moved.
      const order = this.order.filter(inLine);
      const joining = this.world.cars.filter((c) => inLine(c) && !order.includes(c)).sort(byDistance);
      for (const c of joining) this.lapGroup.set(c, lapsBehind(order[0] ?? joining[0], c));
      const merged = order.concat(joining);
      const at = new Map(merged.map((c, i) => [c, i]));
      const group = (c: Car) => this.lapGroup.get(c) ?? 0;
      this.order = merged.sort((a, b) => group(a) - group(b) || at.get(a)! - at.get(b)!);
    }
    if (!this.pacing || !this.order.length) return;
    void leader;
    if (this.flag === 'formation' || this.flag === 'grid') {
      this.standingSlots(dt);
      return;
    }
    const pc = this.paceCar;
    const head = this.order[0];
    // The pace car leads once it has picked up the leader (the leader has caught it, on track, right behind
    // it); until then the line follows the virtual pace car, so the slots never jump to wherever it came out.
    if (this.paceCarOut && !this.pickedUp && pc.d < t.innerEdge(pc.trackIdx) + 1
      && t.distanceFrom(head.s, pc.s) < FIRST_ROW_GAP + ROW_GAP) {
      this.pickedUp = true;
      this.pickupDist = head.dist;
    }
    const paceCarLeads = this.paceCarOut && this.pickedUp && !this.paceCarHeadingInAndOff();
    // Waved around: until it has picked up the leader, cars on the road between the pace car and the leader
    // go past the pace car and on round to the tail of the line (their place in the order is behind anyway).
    this.waved.clear();
    if (this.paceCarOut && !this.pickedUp && pc.d < t.innerEdge(pc.trackIdx) + 1) {
      const toPaceCar = t.distanceFrom(head.s, pc.s);
      if (toPaceCar < t.length / 2) {
        for (const car of this.order) {
          const ahead = t.distanceFrom(head.s, car.s);
          if (car === head || ahead <= 0 || ahead >= toPaceCar) continue;
          this.waved.add(car);
          if (!this.wavedTold.has(car)) {
            this.wavedTold.add(car);
            this.world.announce(car, 'crew', `Race control: #${car.number}, you're waved around`);
          }
        }
      }
    }
    if (!this.pacing) this.wavedTold.clear();
    let refS = pc.s;
    if (paceCarLeads) {
      this.virtualS = NaN;
    } else {
      // No pace car in front: the line follows a virtual one, moving at pace speed from where the leader
      // is. Referenced to the leader itself, the line could wait on itself: cars ahead of their slots
      // slowed for them, the leader stuck behind them slowed too, the slots (set from the leader) stopped,
      // and the whole field crawled into each other.
      const ahead = Number.isNaN(this.virtualS) ? NaN : t.distanceFrom(head.s, this.virtualS);
      if (Number.isNaN(ahead) || ahead > VIRTUAL_LEAD_MAX) this.virtualS = head.s; // new, behind the leader, or the leader lost it
      else this.virtualS = t.wrapS(this.virtualS + this.paceSpeedAt(this.virtualS) * (this.flag === 'caution' ? 1.15 : 1) * dt);
      // The real pace car out on track ahead, waiting to pick up the leader: the line can't run past it.
      if (this.paceCarOut && pc.d < t.innerEdge(pc.trackIdx) + 1 && t.distanceFrom(head.s, pc.s) < t.length / 2) {
        const limit = t.wrapS(pc.s - FIRST_ROW_GAP);
        if (t.distanceFrom(limit, this.virtualS) < t.length / 2) this.virtualS = limit;
      }
      refS = this.virtualS;
    }
    const refSpeed = paceCarLeads ? Math.max(pc.speed, this.paceSpeedAt(pc.s) * 0.6) : this.paceSpeedAt(refS) * (this.flag === 'caution' ? 1.15 : 1);
    const single = this.singleFile;
    this.order.forEach((car, index) => {
      const back = (paceCarLeads ? FIRST_ROW_GAP : 0) + (single ? index * SINGLE_FILE_GAP : Math.floor(index / 2) * ROW_GAP);
      this.slots.set(car, {
        index,
        s: t.wrapS(refS - back),
        // Single file in the middle; doubled up, the leader takes the inside and the order alternates.
        d: single ? 0 : index % 2 === 0 ? FILE_OFFSET : -FILE_OFFSET,
        speed: refSpeed,
      });
    });
  }

  /** A stopped wreck still on the racing surface within range ahead of this car, if any. */
  wreckAhead(car: Car, range = 250): Car | null {
    const t = this.track;
    for (const other of this.world.cars) {
      if (!other.retired || other.cleared || other.d > t.innerEdge(other.trackIdx) + 1) continue;
      const gap = t.distanceFrom(car.s, other.s);
      if (gap > 0 && gap < range) return other;
    }
    return null;
  }

  private paceCarHeadingInAndOff(): boolean {
    return this.oneToGo && this.paceCar.d > this.track.innerEdge(this.paceCar.trackIdx) + 0.5;
  }

  /**
   * The nearest car ahead in roughly the same lane, within range: anything
   * physical counts (pacing cars, cars pitting, a stopped wreck, the pace car).
   */
  carAheadInFile(car: Car, lane = car.d): Car | null {
    const t = this.track;
    let best: Car | null = null;
    let bestGap = 220;
    for (const other of [...this.world.cars, ...(this.paceCarOut ? [this.paceCar] : [])]) {
      // In our lane, or close to where we are now (a car cutting down to pit road crosses both).
      if (other === car || other.cleared || (Math.abs(other.d - lane) > 2.6 && Math.abs(other.d - car.d) > 2.6)) continue;
      const gap = t.distanceFrom(car.s, other.s);
      if (gap > 0 && gap < bestGap) { bestGap = gap; best = other; }
    }
    return best;
  }

  // ---------- wreckers ----------

  private dispatchWrecker(wreck: Car): void {
    const t = this.track;
    if (this.safetyCar) {
      // Marshals and a crane where the car stopped: lifted over the barrier, then it's gone.
      this.wreckers.push({
        wreck, x: wreck.x, y: wreck.y, s: wreck.s, d: wreck.d,
        phase: 'hook', timer: MARSHAL_TIME, route: [], exitS: 0, dir: 1, via: '', marshals: true,
      });
      return;
    }
    const start = t.toWorld(t.pit.wallEnd, t.apronEdgeAt(t.pit.wallEnd) - 2);
    // Drive the shorter way round along the apron (against traffic is fine for a wrecker).
    const fwd = t.distanceFrom(t.pit.wallEnd, wreck.s);
    this.wreckers.push({
      wreck, x: start[0], y: start[1], s: t.pit.wallEnd, d: t.apronEdgeAt(t.pit.wallEnd) - 2,
      phase: 'drive', timer: 0, route: [], exitS: 0, dir: fwd < t.length / 2 ? 1 : -1, via: '',
    });
  }

  private stepWreckers(dt: number): void {
    const t = this.track;
    for (const w of this.wreckers) {
      if (w.phase === 'drive') {
        const remaining = w.dir > 0 ? t.distanceFrom(w.s, w.wreck.s) : t.distanceFrom(w.wreck.s, w.s);
        const stepS = Math.min(remaining, WRECKER_SPEED * dt);
        w.s = t.wrapS(w.s + w.dir * stepS);
        // Swing over to the wreck's lane as it gets close.
        const targetD = remaining < 60 ? w.wreck.d : t.apronEdgeAt(w.s) - 2;
        w.d += Math.sign(targetD - w.d) * Math.min(Math.abs(targetD - w.d), 6 * dt);
        [w.x, w.y] = t.toWorld(w.s, w.d);
        if (remaining < 1 && Math.abs(w.d - w.wreck.d) < 1) {
          w.phase = 'hook';
          w.timer = HOOK_TIME;
          w.wreck.cleared = true; // off the physics from here on
          w.wreck.towed = true;
        }
      } else if (w.phase === 'hook') {
        w.timer -= dt;
        if (w.timer <= 0 && w.marshals) {
          // Lifted off: parked out of the way in the paddock.
          const park = t.infield.garage.parking[this.garageSlots++ % t.infield.garage.parking.length];
          w.wreck.cleared = true;
          [w.x, w.y] = park;
          this.parkWreck(w);
        } else if (w.timer <= 0) this.planTow(w);
      } else if (w.phase === 'tow') {
        if (w.route.length === 0) {
          // On the oval: back to the apron, then along it to the exit point.
          const remaining = w.dir > 0 ? t.distanceFrom(w.s, w.exitS) : t.distanceFrom(w.exitS, w.s);
          w.s = t.wrapS(w.s + w.dir * Math.min(remaining, TOW_SPEED * dt));
          const targetD = t.apronEdgeAt(w.s) - 2;
          w.d += Math.sign(targetD - w.d) * Math.min(Math.abs(targetD - w.d), 4 * dt);
          [w.x, w.y] = t.toWorld(w.s, w.d);
          if (remaining < 1) w.route = this.routeToGarage(w);
        } else {
          const [tx, ty] = w.route[0];
          const dx = tx - w.x, dy = ty - w.y;
          const dist = Math.hypot(dx, dy);
          const step = TOW_SPEED * dt;
          if (dist <= step) {
            w.x = tx; w.y = ty;
            w.route.shift();
            if (w.route.length === 0) this.parkWreck(w);
          } else {
            w.x += (dx / dist) * step;
            w.y += (dy / dist) * step;
          }
        }
        // The wreck trails the truck.
        if (w.phase === 'tow') {
          w.wreck.x = w.x;
          w.wreck.y = w.y;
          w.wreck.vx = 0;
          w.wreck.vy = 0;
          const p = t.project(w.x, w.y, w.wreck.trackIdx);
          w.wreck.trackIdx = p.idx; w.wreck.s = p.s; w.wreck.d = p.d;
        }
      }
    }
  }

  /** Pick the nearest way off the oval that leads to a garage (an escape road, pit entry...), along the apron. */
  private planTow(w: Wrecker): void {
    const t = this.track;
    const accesses = t.roads.accesses
      .filter((n) => t.roads.pathToGarage(n.id))
      .map((n) => ({ via: n.id, exitS: t.wrapS(n.s ?? t.project(...n.at).s) }));
    const options = accesses.map(({ via, exitS }) => {
      const fwd = t.distanceFrom(w.s, exitS);
      return fwd < t.length / 2 ? { via, exitS, dir: 1, dist: fwd } : { via, exitS, dir: -1, dist: t.length - fwd };
    }).sort((a, b) => a.dist - b.dist);
    w.exitS = options[0].exitS;
    w.dir = options[0].dir;
    w.via = options[0].via;
    w.phase = 'tow';
    w.route = [];
  }

  /** From the access it left the oval at, along the road network's shortest way to a garage, to a parking spot. */
  private routeToGarage(w: Wrecker): Array<[number, number]> {
    const t = this.track;
    const g = t.infield.garage;
    const park = g.parking[this.garageSlots++ % g.parking.length];
    return [...(t.roads.pathToGarage(w.via) ?? []), park];
  }

  private parkWreck(w: Wrecker): void {
    w.phase = 'done';
    w.wreck.towed = false;
    w.wreck.parked = true;
    w.wreck.x = w.x;
    w.wreck.y = w.y;
  }
}

/** Pace-car speed: comfortably below the corner limit on the low line of the tightest corner. */
export function paceSpeedFor(track: Track): number {
  let tightest = 0;
  for (let i = 0; i < track.n; i++) if (track.kappa[i] > track.kappa[tightest]) tightest = i;
  const R = 1 / track.maxKappa;
  const b = track.bankAt(tightest, track.innerEdge(tightest));
  const mu = P.TIRE_MU * 0.8;
  const vCorner = Math.sqrt((G * (Math.sin(b) + mu * Math.cos(b))) / (Math.cos(b) - mu * Math.sin(b)) * R);
  return Math.min(PIT_SERVICE.SPEED_LIMIT * 2, vCorner * 0.6);
}

/** Where the pace car turns off for pit road: the start of the pit entry. */
export function pullOffS(track: Track): number {
  return track.pit.entryStart;
}

function setSpeed(car: Car, track: Track, speed: number): void {
  const i = car.trackIdx;
  car.vx = track.tx[i] * speed;
  car.vy = track.ty[i] * speed;
}

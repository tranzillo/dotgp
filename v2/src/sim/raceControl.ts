import { Rng } from '../ai/rng';
import { Car } from './car';
import { G, PHYSICS as P, PIT_SERVICE } from './constants';
import { gridBox, POLE_BOX } from './grid';
import { pitBoxD, pitFastD, type RoadNode } from './layout';
import { pathLength, type RoadsFrom } from './roads';
import type { Track } from './track';
import type { World } from './world';
import { driveTruck, setOff, trail, TRUCK, truckBody, TruckPath, TRUCKS_SOLID, type TruckDrive } from './wrecker';
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
/** Hooking a car up (s), and rolling it off into its bay in the garage. */
const HOOK_TIME = 10;
const DROP_TIME = 6;
/** A truck goes by a wreck this far to its inside (m): its width and the car's clear of it. */
const PASS = TRUCK.RADIUS + P.CAR_RADIUS + 1.2;
/** Where it pulls up to back up to a wreck, on from it in its lane (m). */
const HOOK_AHEAD = TRUCK.HITCH + TRUCK.BACK_UP;
/** Longest it backs up for (s), however far it has to go. */
const BACK_TIME = 15;
/** Pace estimates (m/s) for choosing a truck and its route: by road in the infield, and along the apron. */
const ROAD_PACE = 10;
const APRON_PACE = 16;
/** How much the tow back to the garage counts in choosing, against getting to the wreck (the caution waits on that). */
const TURNAROUND_WEIGHT = 0.25;
/** Along the apron against the traffic counts this much more than with it (it meets the field head on). */
const AGAINST_TRAFFIC = 1.5;
/** Turning onto (or off) the apron through more than this (cos of the turn), a U-turn, counts this many seconds. */
const U_TURN_COS = -0.3;
const U_TURN_COST = 20;
/** Trucks posted round the infield besides the garage's, and how much sooner they must reach the far side. */
const MAX_LOT_TRUCKS = 2;
const LOT_GAIN = 0.9;
/** A truck making no headway this long is moved on (s); a wreck no truck has set out for this long, lifted off. */
const STALLED_TIME = 15;
/**
 * A truck going out on the racing surface waits for a gap in the traffic coming: no car there before it's out of the
 * way again (out there at CROSS_PACE, m/s, and a few seconds more); this long at most (s).
 */
const CROSS_PACE = 7;
const CROSS_MARGIN = 4;
const YIELD_TIME = 30;
/** Where a road meets the apron, a truck joins (or leaves) the apron's lane this far along (m, a multiple of 3). */
const JOIN_RUN = 24;
/**
 * A road meeting the apron turned back more than this against the way a truck goes (rad) it leaves (or joins) DIVE_DEPTH
 * metres into the infield, crossing the grass to (from) the apron's lane DIVE_RUN metres on (before).
 */
const DIVE_TURN = (100 * Math.PI) / 180;
const DIVE_DEPTH = 14;
const DIVE_RUN = 30;
/** A free truck this near a wreck (m) may go straight to it across the grass. */
const DIRECT_RANGE = 60;
/** A truck parked within this far of the apron (m) may cross the grass onto it rather than go by road. */
const GRASS_ENTRY = 50;
/** Out of a truck's way across the track to the apron with a tow (m). */
const TOW_CROSSING = 45;
const CALLOUT_GIVE_UP = 120;
/** The wreckers' ids (down from here); the pace car is -1. */
const WRECKER_ID = -10;
const STALL_TIME = 5; // s stopped on the racing surface before it's a hazard (a caution under green)
/**
 * s stopped on the racing surface before a car that could still go (fuel, not wrecked) counts as a wreck, unless it's
 * waiting in line behind another stopped car: a field queued behind a wreck under caution is doing as it's told.
 * (At STALL_TIME, race control retired every car in such a queue: each became a wreck for a wrecker to tow.)
 */
const STUCK_TIME = 30;
/** A stopped car this close behind another stopped car (or the pace car), in its lane, is queued (m). */
const QUEUE_GAP = 25;
/** Stalling under green this many times, a car is out (the first time, it gets going again if it can). */
const STALLS_OUT = 2;
/**
 * s a car on its way to its box may sit stopped on pit road, with nothing stopped in front of it, before its crew
 * pushes it into the garage: out of the race. (A pit driver 10 m short of its box gave no throttle from lap 1 to the
 * flag; the race, waiting for it, never ended.)
 */
const PIT_STUCK_TIME = 60;
/** Marshals' time to lift a wrecked car off a circuit (s). */
const MARSHAL_TIME = 25;
/** A car going from behind the pace car to ahead of it within this much of it got by it (m): not one half a lap away. */
const PASS_RANGE = 50;
/** A place in line more than this far behind a car is reached by going round (m), unless the car got by the pace car. */
const GO_ROUND = 150;

/** The pace car's post is this far short of the pit wall's end (m). */
const PACE_POST_BACK = 8;

/** The pace car's livery number; it never appears in standings. */
export const PACE_CAR_ID = -1;

/**
 * idle: parked at its post; drive: out to a wreck; hook: hooking it up; tow:
 * towing it to the garage; drop: rolling it off into its bay; return: back
 * to its post. done: marshals' work finished.
 */
type WreckerPhase = 'idle' | 'drive' | 'hook' | 'tow' | 'drop' | 'return' | 'done';

export interface Wrecker {
  /** The truck (null: marshals with a crane, circuits). */
  truck: TruckDrive | null;
  /** The car it's out for or towing. */
  wreck: Car | null;
  x: number;
  y: number;
  phase: WreckerPhase;
  timer: number;
  /** Where it parks between jobs. */
  post: [number, number];
  /** Which way round it's going along the apron (+1 the way the race runs). */
  dir: number;
  /** The road network node where it leaves the oval with the tow (an apron access). */
  via: string;
  /** The garage bay it's taking the car to. */
  bay?: [number, number];
  /** How far along its path it had got when last it made headway, and how long since. */
  progress: number;
  stalled: number;
  /** Times it has gone round to a wreck knocked away from where it was. */
  tries: number;
  /** How long it has waited this job for a gap in traffic to go out onto the racing surface (s). */
  waited: number;
  /** Marshals with a crane (circuits) rather than a tow truck. */
  marshals?: boolean;
}

/** A wreck waiting for a truck, how long it has waited (s), and whether any free truck has had a way to it. */
interface Callout { wreck: Car; waited: number; reachable?: boolean }

/** A wreck (and what's with it) on the racing surface to go round: where it is along the lap, and across it (d). */
export interface WorkZone { s: number; lo: number; hi: number }

/** Wrecks and trucks within this far along the track of one another are one thing to go round (m). */
const ZONE_LENGTH = 30;

/** A truck's way to a wreck: onto the apron at `via` (track s), round the way dir runs, off with the tow at `out`. */
/** (direct: straight across the grass to the wreck; grass: across the grass onto the apron's lane at s, not by road.) */
interface Approach { via: string; s: number; dir: number; out: string; cost: number; direct?: boolean; grass?: boolean }

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
/**
 * A rolling start or restart: the starter waves the green somewhere between these shares of the leader's time from the
 * pace car pulling off to the line at pace speed (drawn each time: nobody can know when), or as the leader reaches
 * the line, whichever is first. Until then everyone holds pace speed in their place (detect.ts judges it).
 */
const GREEN_EARLIEST = 0.3;
const GREEN_LATEST = 0.9;
/**
 * The starter looks at the line-up as the pace car nears pulling off (from this far before it, m: before it starts
 * down for pit road): the first LINEUP_CARS each within LINEUP_ALONG of their place, row mates side by side (in
 * separate files, either way round), or the pace car stays out one more lap (once a caution: a wave-off costs
 * everyone a lap).
 */
const LINEUP_LOOK = 250;
const LINEUP_CARS = 6;
const LINEUP_ALONG = 10;

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
  /** The lap a car stopped on track brought a caution out on (it can bring out another once it has made it round). */
  private readonly cautionedLap = new Map<Car, number>();
  /** Times each car has stalled on track under green (stopped long enough to bring out a caution). */
  private readonly stalls = new Map<Car, number>();
  /** How long each car on its way to its box has sat stopped on pit road. */
  private readonly pitStopped = new Map<Car, number>();
  private garageSlots = 0;
  private fleetBuilt = false;
  /** Where trucks can get onto the oval, and where they can leave it for the garage (with the road there's to go). */
  private entries: Array<{ id: string; s: number; tangent: [number, number] }> = [];
  /** (away: the way its road leaves the apron.) */
  private exits: Array<{ id: string; s: number; garage: number; tangent: [number, number]; away: [number, number] }> = [];
  /** The garage bays wrecks are towed to, and how many have been used. */
  private bays: Array<[number, number]> = [];
  private baysUsed = 0;
  /** Wrecks waiting for a truck. */
  private readonly callouts: Callout[] = [];
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
  private readonly cases: Array<{ car: Car; against: Car | null; restart: boolean }> = [];
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

  /** The stewards' cases from the line (against null: the pace car, still ahead of it). */
  takeLineupCases(): Array<{ car: Car; against: Car | null; restart: boolean }> {
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
  /** Race control's own draws (the starter's green, the lights' hold): seeded by the race. */
  random: () => number = (() => { const rng = new Rng(1); return () => rng.next(); })();
  /** When the starter waves the green at this rolling restart (world time; NaN: at the line). */
  private greenAt = NaN;
  /** The starter has looked at this restart's line-up (and waved it off or not). */
  private lineupJudged = false;
  private standing: StandingStart | null = null;
  private readonly boxes = new Map<Car, { s: number; d: number }>();
  /** Cars stopped on the grid, held where they stopped until the lights go out. */
  private readonly held = new Map<Car, { x: number; y: number; s: number; d: number; idx: number; dist: number }>();
  /** Each car in line's distance ahead of the pace car (- behind) at the last look, while the pace car leads the line. */
  private readonly paceCarGap = new Map<Car, number>();
  /** Cars that got by the pace car once it had the field, and their race distance then: told to drop back behind it. */
  private readonly gotByPaceCar = new Map<Car, number>();
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
   * A standing start: every car in its own grid box behind the line (the
   * track's painted grid, sim/grid.ts), staggered left and right, stopped;
   * the pace car parked on pit road for cautions. With a formation lap the
   * race joins it at its end (watchers needn't sit through the rest): the
   * field rolls up to its boxes in grid order, already staggered, and brakes
   * to a stop in them; then the lights. A car stopped on the grid is held
   * there on its brakes until they go out.
   */
  formUpStanding(cars: Car[], start: StandingStart, random: () => number): void {
    const t = this.track;
    this.standing = start;
    this.hold = start.hold[0] + random() * (start.hold[1] - start.hold[0]);
    this.formationLeft = start.formationLap ? FORMATION_ARRIVAL : 0;
    this.virtualS = t.wrapS(-POLE_BOX - this.formationLeft);
    const v = this.formationApproachSpeed();
    cars.forEach((car, k) => {
      const box = gridBox(t, k, start.gridPitch);
      const s = t.signedS(box.s);
      car.placeOnTrack(t, s - this.formationLeft, box.d, s - this.formationLeft);
      setSpeed(car, t, v);
      this.boxes.set(car, box);
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
    this.holdOnGrid();
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
    this.held.clear();
    this.world.announce(this.order[0] ?? this.paceCar, 'flag', 'Lights out!');
    this.onLightsOut?.();
  }

  /**
   * On the grid a car that has stopped stays where it stopped, on its brakes,
   * until the lights go out: whatever its driver asks of it, it doesn't creep
   * (a driver's network holds a car still only so well; front rows crept tens
   * of metres down the straight before the start).
   */
  private holdOnGrid(): void {
    for (const car of this.world.cars) {
      if (car.retired || car.pit.phase !== 'none') continue;
      const at = this.held.get(car);
      if (at) {
        car.x = at.x; car.y = at.y; car.s = at.s; car.d = at.d; car.trackIdx = at.idx; car.dist = at.dist;
        car.vx = 0; car.vy = 0;
      } else if (car.speed < 0.3) {
        this.held.set(car, { x: car.x, y: car.y, s: car.s, d: car.d, idx: car.trackIdx, dist: car.dist });
        car.vx = 0; car.vy = 0;
      }
    }
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
      const clear = this.trackClear();
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
    // The starter's look at the line-up as the pace car nears pulling off: not in neat double file, one more lap.
    if (!this.safetyCar && (this.flag === 'pace' || this.flag === 'caution') && this.paceCarOut && this.oneToGo && !this.lineupJudged) {
      const r = t.pitInS(this.paceCar.s), pull = pullOffS(t);
      if (r > pull - LINEUP_LOOK && r < pull) {
        this.lineupJudged = true;
        const head = this.order[0];
        if (head && !this.linedUp()) {
          this.oneToGo = false; // a start's comes back at the line; a caution's once its extra lap is run
          if (this.flag === 'caution') this.cautionMinLaps = head.lapsCompleted - this.cautionLap + 1;
          this.world.announce(head, 'flag', 'Not lined up: one more lap');
        }
      }
    }
    if ((this.flag === 'pace' || this.flag === 'caution') && this.paceCarOut && this.oneToGo
      && this.paceCar.d > t.innerEdge(this.paceCar.trackIdx) + 0.5 && this.paceCarHeadingIn()) {
      this.flag = 'restart';
      this.greenAt = this.safetyCar ? NaN : this.drawGreen();
      this.world.announce(this.order[0] ?? leader ?? this.paceCar, 'flag', this.safetyCar ? 'Safety car in this lap: leader to the line for the restart' : 'Pace car is off: leader to the line for the green');
    }
    if (this.paceCarOut && this.oneToGo && this.paceCar.surface === 'pit' && t.pitInS(this.paceCar.s) > t.pit.wallStart + 15
      && t.pitInS(this.paceCar.s) < t.pit.wallEnd - 20) {
      this.paceCarOut = false; // pulled in and parked
      this.pickedUp = false;
      this.paceCar.cleared = true; // parked off to the side: not an obstacle on pit road
    }
    // The green is the head of the official order's to take, at the line: not whoever is furthest round (a car out of
    // place ahead of it, past the safety car, took the green for the field).
    const head = this.order[0];
    if (this.flag === 'restart' && head && (this.crossedLine(head) || this.world.time >= this.greenAt)) {
      this.flag = 'green';
      this.greenAt = NaN;
      this.lineupJudged = false;
      this.gotByPaceCar.clear();
      this.world.announce(head, 'flag', 'Green flag!');
      this.onGreen?.(head);
    }
    this.watchPaceCar();
    this.lineup();
  }

  /** The starter's moment for the green: a random share of the leader's time to the line at pace speed. */
  private drawGreen(): number {
    const head = this.order[0];
    if (!head) return NaN;
    const toLine = this.track.distanceFrom(head.s, 0) / this.paceSpeed;
    return this.world.time + toLine * (GREEN_EARLIEST + (GREEN_LATEST - GREEN_EARLIEST) * this.random());
  }

  /** The front rows in neat double file: each car in its place along the line, row mates side by side. */
  private linedUp(): boolean {
    const front = this.order.slice(0, LINEUP_CARS);
    const inPlace = front.every((c) => { const gap = this.slotGap(c); return gap !== null && Math.abs(gap) < LINEUP_ALONG; });
    let abreast = true;
    for (let i = 0; i + 1 < front.length; i += 2) if (Math.abs(front[i].d - front[i + 1].d) < FILE_OFFSET) abreast = false;
    return inPlace && (this.singleFile || abreast);
  }

  /** A car that got by the pace car once it had the field, not yet back behind it (detect.ts judges these at a restart). */
  gotBy(car: Car): boolean {
    return this.gotByPaceCar.has(car);
  }

  /**
   * Nobody gets by the pace car (or the safety car) once it has the field:
   * a car that does is told to drop back behind it, and still ahead of it a
   * lap later it's the stewards' case. Cars already ahead of it when it
   * picked up the leader are going round to the tail, and cars waved around
   * are meant to pass it. At a restart, a car still ahead is judged with the
   * field (detect.ts): it took places before the green.
   */
  private watchPaceCar(): void {
    const t = this.track, pc = this.paceCar;
    for (const car of [...this.gotByPaceCar.keys()]) if (!this.order.includes(car)) this.gotByPaceCar.delete(car); // pitted, out
    const leads = (this.flag === 'caution' || this.flag === 'pace') && this.paceCarOut && this.pickedUp && !this.paceCarHeadingInAndOff();
    if (!leads) {
      this.paceCarGap.clear();
      return;
    }
    for (const car of this.order) {
      if (this.waved.has(car)) { this.paceCarGap.delete(car); continue; }
      let gap = t.distanceFrom(pc.s, car.s);
      if (gap > t.length / 2) gap -= t.length;
      const was = this.paceCarGap.get(car);
      this.paceCarGap.set(car, gap);
      const since = this.gotByPaceCar.get(car);
      if (since !== undefined) {
        if (gap < 0) this.gotByPaceCar.delete(car); // back behind it
        else if (car.dist >= since + t.length) {
          this.gotByPaceCar.delete(car);
          this.cases.push({ car, against: null, restart: false });
        }
      } else if (was !== undefined && was <= 0 && gap > 0 && gap < PASS_RANGE) {
        this.gotByPaceCar.set(car, car.dist);
        this.world.announce(car, 'crew', `Race control: #${car.number}, drop back behind the ${this.safetyCar ? 'safety' : 'pace'} car`);
      }
    }
  }

  /**
   * Metres from a car to its place in line, the way it should go to it (+ its place is ahead, - behind): a place far
   * behind is reached by going round, as a car that was running ahead of the pace car when it picked up the leader
   * does, but never by one that got by the pace car (it drops back). Null without a place.
   */
  slotGap(car: Car): number | null {
    const slot = this.slots.get(car);
    if (!slot) return null;
    const t = this.track;
    let err = t.distanceFrom(car.s, slot.s);
    if (err > t.length / 2) err -= t.length;
    if (err < -GO_ROUND && !this.gotByPaceCar.has(car)) err += t.length;
    return err;
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
      if (!car.retired && car.pit.phase === 'in' && car.surface === 'pit' && car.speed < 0.3 && !this.queued(car)) {
        const since = (this.pitStopped.get(car) ?? 0) + dt;
        this.pitStopped.set(car, since);
        if (since > PIT_STUCK_TIME) {
          car.vx = 0; car.vy = 0;
          car.retired = true; car.parked = true; car.cleared = true;
          this.handled.add(car);
          this.world.announce(car, 'retired', 'Stopped on pit road');
          continue;
        }
      } else this.pitStopped.delete(car);
      // A car stopped on the racing surface (out of fuel, spun) is a wreck too, whether or not it was on its way in;
      // waiting on the grid it's just waiting (a car that doesn't get away counts from the start). A car that has taken
      // the flag is done: one that runs dry on its slowing-down lap (crews fuel to the flag) isn't a wreck to bring the
      // safety car out for.
      const onTrack = car.pit.phase === 'none' || (car.pit.phase === 'in' && car.surface !== 'pit');
      if (!car.retired && !car.finished && this.flag !== 'grid' && onTrack && car.speed < 3 && car.d < t.innerEdge(car.trackIdx) + 1) {
        const since = (this.stoppedSince.get(car) ?? 0) + dt;
        this.stoppedSince.set(car, since);
        // A stopped car is a hazard: a caution under green. It's a wreck only if it can't go on (out of fuel), or
        // it has sat there a long while with nothing stopped in front of it.
        if (since > STALL_TIME && this.flag === 'green' && !this.cautioned.has(car)) {
          this.cautioned.add(car);
          this.cautionedLap.set(car, car.lapsCompleted);
          this.stalls.set(car, (this.stalls.get(car) ?? 0) + 1);
          this.throwCaution(car);
        }
        // (A car that stalls under green again can't be kept running: house drivers that stalled after every
        // restart on a tiny short oval brought out a caution each time, 50 a race.)
        if (since > STALL_TIME && (car.fuel <= 0 || (this.stalls.get(car) ?? 0) >= STALLS_OUT || (since > STUCK_TIME && !this.queued(car)))) {
          car.retired = true;
          this.world.announce(car, 'retired', 'Stopped on track');
        }
      } else if (this.stoppedSince.has(car)) {
        // Going again. Time stopped wears off slowly, so a car that stops and creeps, stops and creeps, adds up to
        // stuck; and a later stop or wreck is a new hazard only once it has made it round. (Forgotten the moment it
        // moved, a house car stalling and creeping on a tiny short oval brought out a caution each time: 52 a race.)
        const since = this.stoppedSince.get(car)! - 0.25 * dt;
        if (since > 0) this.stoppedSince.set(car, since);
        else this.stoppedSince.delete(car);
      }
      if (!car.retired && this.cautioned.has(car) && car.lapsCompleted > (this.cautionedLap.get(car) ?? Infinity)) this.cautioned.delete(car);
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

  /** Stopped behind another stopped car (or the pace car) in its lane: waiting in line, not stuck. */
  private queued(car: Car): boolean {
    const t = this.track;
    return [...this.world.cars, this.paceCar].some((o) => {
      if (o === car || o.cleared || o.speed > 3) return false;
      const gap = t.wrapS(o.s - car.s);
      return gap > 0 && gap < QUEUE_GAP && Math.abs(o.d - car.d) < 2 * P.CAR_RADIUS + 1;
    });
  }

  private throwCaution(cause: Car): void {
    // The checkered flag is out: the race is over, the rest are only finishing their lap.
    if (this.world.cars.some((c) => c.finished)) return;
    this.flag = 'caution';
    this.cautions++;
    this.oneToGo = false;
    this.cautionMinLaps = MIN_CAUTION_LAPS;
    this.lineupJudged = false;
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
    this.lineupJudged = false;
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
    // (Earlier the further it has to come across to the track: some 5 m of track for each metre past the 4.8 m from
    // its lane to the track's edge that pit road stood at before the pit wall stood a car's width clear of it.)
    const across = t.pit.wallD + t.pit.wallThickness / 2 + 3 + t.pitOffset(t.pit.wallEnd - 5) - t.innerEdgeAt(t.pit.wallEnd - 5);
    const early = 5 * Math.max(0, across - 4.8);
    if (toExit > FIRST_ROW_GAP + early && toExit < FIRST_ROW_GAP + ROW_GAP + early) {
      // From its post (put there, if it hadn't got to it yet).
      const post = this.paceCarPost();
      const [px, py] = t.toWorld(post.s, post.d);
      if (Math.hypot(this.paceCar.x - px, this.paceCar.y - py) > 10) this.paceCar.placeOnTrack(t, post.s, post.d);
      setSpeed(this.paceCar, t, this.paceSpeedAt(this.paceCar.s));
      this.paceCar.retired = false;
      this.paceCar.cleared = false;
      this.paceCarOut = true;
    }
  }

  /**
   * Where the pace car waits while it's off: at the end of pit road, past the
   * boxes, on their side of it: out of the fast lane cars leave by.
   */
  paceCarPost(): { s: number; d: number } {
    const t = this.track;
    const s = t.wrapS(t.pit.wallEnd - PACE_POST_BACK);
    return { s, d: pitBoxD(t.pit) + t.pitOffset(s) };
  }

  /** How far the pace car has to go down pit road to its post (m; 0 there or past it). */
  paceCarToPost(s: number): number {
    return Math.max(0, this.track.pit.wallEnd - PACE_POST_BACK - this.track.pitInS(s));
  }

  /** Its way down pit road to its post: the fast lane, over to the boxes' side at the end. */
  paceLaneD(s: number): number {
    const t = this.track;
    const f = smooth(1 - this.paceCarToPost(s) / 30);
    return mix(pitFastD(t.pit), pitBoxD(t.pit), f) + t.pitOffset(s);
  }

  private paceCarHeadingIn(): boolean {
    const r = this.track.pitInS(this.paceCar.s);
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
    // (A car that has taken the flag is done: one that ran dry on its slowing-down lap was picked up by the safety car
    // as the head of the line, and the caution waited for it for ever.)
    const inLine = (c: Car) => !c.retired && !c.cleared && !c.finished && c.pit.phase === 'none';
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
      // (Once the pace car has pulled off for a rolling restart the reference runs on at pace speed, whoever runs off
      // ahead of it: a leader gone early is ahead of its place, not the line's reference. It was: leaders went off from
      // the pace car pulling off, 10% over pace 330-760 m before the line, their place always where they were.)
      const runOff = this.flag === 'restart' && !this.safetyCar && !Number.isNaN(ahead) && ahead > t.length / 2;
      if (!runOff && (Number.isNaN(ahead) || ahead > VIRTUAL_LEAD_MAX)) this.virtualS = head.s; // new, behind the leader, or the leader lost it
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

  /**
   * The nearest wreck still on the racing surface within range ahead of this
   * car, as the stretch of track to go round: the wreck, and with it whatever
   * else is there (other wrecks, a wrecker at work on it), across from lo to
   * hi (d, widened for anything bigger than a car). Going round only the one
   * nearest, cars drove into the truck pulling up beside it.
   */
  wreckAhead(car: Car, range = 250): WorkZone | null {
    const t = this.track;
    const there = [...this.world.cars.filter((c) => c.retired), ...this.world.solidVehicles]
      .filter((o) => !o.cleared && o.d <= t.innerEdge(o.trackIdx) + 1 + o.radius - P.CAR_RADIUS);
    let near: Car | null = null;
    let bestGap = range;
    for (const other of there) {
      const gap = t.distanceFrom(car.s, other.s);
      if (gap > 0 && gap < bestGap) { bestGap = gap; near = other; }
    }
    if (!near) return null;
    const zone: WorkZone = { s: near.s, lo: Infinity, hi: -Infinity };
    for (const o of there) {
      const ds = t.distanceFrom(near.s, o.s);
      if (Math.min(ds, t.length - ds) > ZONE_LENGTH) continue;
      const wide = o.radius - P.CAR_RADIUS;
      zone.lo = Math.min(zone.lo, o.d - wide);
      zone.hi = Math.max(zone.hi, o.d + wide);
    }
    return zone;
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

  /**
   * The wrecker fleet, parked at its posts: most in the garage, and one more
   * round the infield or two (in a parking lot, or staged just off the apron
   * up an escape road) where that gets a truck to the far side of the track
   * much sooner. Built at the first step (the rulebook may call for marshals
   * instead).
   */
  private ensureFleet(): void {
    if (this.fleetBuilt) return;
    this.fleetBuilt = true;
    if (this.safetyCar) return;
    const t = this.track;
    const roads = t.roads;
    const sOf = (n: RoadNode) => t.wrapS(n.s ?? t.project(n.at[0], n.at[1]).s);
    const tangentAt = (n: RoadNode): [number, number] => { const i = t.project(n.at[0], n.at[1]).idx; return [t.tx[i], t.ty[i]]; };
    this.entries = [...roads.nodes.values()].filter((n) => n.kind === 'apron').map((n) => ({ id: n.id, s: sOf(n), tangent: tangentAt(n) }));
    this.exits = roads.accesses.flatMap((n) => {
      const way = roads.pathToGarage(n.id);
      if (!way) return [];
      const far = way.find((p) => Math.hypot(p[0] - n.at[0], p[1] - n.at[1]) > 5) ?? way[way.length - 1];
      const len = Math.hypot(far[0] - n.at[0], far[1] - n.at[1]) || 1;
      return [{
        id: n.id, s: sOf(n), garage: pathLength([n.at, ...way]), tangent: tangentAt(n),
        away: [(far[0] - n.at[0]) / len, (far[1] - n.at[1]) / len] as [number, number],
      }];
    });
    if (!this.entries.length || !this.exits.length) return;

    // The garage's trucks park at the back of its parking; the wrecks they bring in fill it from the front.
    const g = t.infield.garage;
    const inGarage = Math.max(1, Math.min(t.length < 1000 ? 4 : 5, g.parking.length - 1));
    const posts = g.parking.slice(-inGarage).reverse();
    this.bays = g.parking.length > inGarage ? g.parking.slice(0, -inGarage) : [...g.parking];
    // How long the slowest call round the lap takes from the posts so far (s, by the pace estimates).
    const samples: number[] = [];
    for (let s = 0; s < t.length; s += 25) samples.push(s);
    const reach = (from: RoadsFrom) => samples.map((s) => Math.min(...this.entries.map((a) => {
      const road = from.dist.get(a.id);
      return road === undefined ? Infinity : road / ROAD_PACE + Math.min(t.distanceFrom(a.s, s), t.distanceFrom(s, a.s)) / APRON_PACE;
    })));
    let best = reach(roads.from(...posts[0]));
    const worst = (r: number[]) => Math.max(...r);
    const lots = stagingPosts(t).map((at) => ({ at, reach: reach(roads.from(...at)) }));
    for (let k = 0; k < MAX_LOT_TRUCKS && lots.length; k++) {
      const pick = lots.map((lot) => ({ lot, r: best.map((v, i) => Math.min(v, lot.reach[i])) }))
        .reduce((a, b) => (worst(b.r) < worst(a.r) ? b : a));
      if (worst(pick.r) > LOT_GAIN * worst(best)) break;
      posts.push(pick.lot.at);
      best = pick.r;
      lots.splice(lots.indexOf(pick.lot), 1);
    }
    posts.forEach((post, k) => {
      const body = truckBody(WRECKER_ID - k, t, post);
      body.cleared = true; // parked out of everyone's way
      this.world.vehicles.push(body);
      this.wreckers.push({
        truck: { body, heading: 0, speed: 0, kappa: 0, path: null, idx: 0 },
        wreck: null, x: post[0], y: post[1], phase: 'idle', timer: 0, post, dir: 1, via: '', progress: 0, stalled: 0, tries: 0, waited: 0,
      });
    });
  }

  private dispatchWrecker(wreck: Car): void {
    if (this.safetyCar || !this.wreckers.some((w) => w.truck)) {
      // Marshals and a crane where the car stopped: lifted over the barrier, then it's gone.
      this.wreckers.push({
        truck: null, wreck, x: wreck.x, y: wreck.y, phase: 'hook', timer: MARSHAL_TIME,
        post: [wreck.x, wreck.y], dir: 1, via: '', progress: 0, stalled: 0, tries: 0, waited: 0, marshals: true,
      });
      return;
    }
    this.callouts.push({ wreck, waited: 0 });
  }

  /**
   * Send trucks to the wrecks waiting for one: of every free truck (parked, or
   * on its way back) and wreck, the pair that gets a truck there soonest,
   * then the next, until the trucks or the wrecks run out.
   */
  private assignWreckers(dt: number): void {
    for (const c of this.callouts) c.waited += dt;
    // A wreck no truck has had a way to is lifted off by marshals in the end, so a caution always ends. (One waiting
    // for a truck to be free waits: given up on, wrecks vanished from the track.)
    for (const c of this.callouts.filter((c) => c.waited > CALLOUT_GIVE_UP && !c.reachable)) {
      this.callouts.splice(this.callouts.indexOf(c), 1);
      this.wreckers.push({
        truck: null, wreck: c.wreck, x: c.wreck.x, y: c.wreck.y, phase: 'hook', timer: MARSHAL_TIME,
        post: [c.wreck.x, c.wreck.y], dir: 1, via: '', progress: 0, stalled: 0, tries: 0, waited: 0, marshals: true,
      });
    }
    const ways = new Map<Wrecker, RoadsFrom>();
    while (this.callouts.length) {
      let best: { w: Wrecker; callout: Callout; plan: Approach } | null = null;
      for (const w of this.wreckers) {
        if (!w.truck || (w.phase !== 'idle' && w.phase !== 'return')) continue;
        let from = ways.get(w);
        if (!from) ways.set(w, (from = this.track.roads.from(w.truck.body.x, w.truck.body.y)));
        for (const callout of this.callouts) {
          const plan = this.approach(from, callout.wreck, w.truck.body);
          if (plan) callout.reachable = true;
          if (plan && (!best || plan.cost < best.plan.cost)) best = { w, callout, plan };
        }
      }
      if (!best) return;
      this.callouts.splice(this.callouts.indexOf(best.callout), 1);
      this.sendOut(best.w, best.callout.wreck, best.plan, ways.get(best.w)!);
    }
  }

  /**
   * The quickest way to a wreck from where a truck is: by road to a way onto
   * the apron, along it either way round to the wreck, and on the same way
   * with it to the first way off that leads to the garage. Weighed mostly by
   * the time to the wreck (what the caution waits on), a little by the rest.
   */
  private approach(from: RoadsFrom, wreck: Car, truck: Car): Approach | null {
    const t = this.track;
    let best: Approach | null = null;
    // Near enough to go straight there across the grass: from the side that lines it up (the wreck behind it as it
    // comes down to it, so it pulls up ahead of it without turning back).
    const near = Math.hypot(truck.x - wreck.x, truck.y - wreck.y);
    const side = t.distanceFrom(wreck.s, truck.s) < t.length / 2 ? 1 : -1;
    for (const dir of [1, -1]) {
      const hookS = t.wrapS(wreck.s + dir * HOOK_AHEAD);
      // (A road that turns back on the way it goes, onto the apron or off it, is a U-turn: on a truck's turning
      // circle, a loop out across the track.)
      const uTurn = (tangent: [number, number], way: [number, number]) => (dir * (tangent[0] * way[0] + tangent[1] * way[1]) < U_TURN_COS ? U_TURN_COST : 0);
      let out: { id: string; dist: number; cost: number } | null = null;
      for (const e of this.exits) {
        const dist = along(t, hookS, e.s, dir) + e.garage;
        const cost = TURNAROUND_WEIGHT * (dist / ROAD_PACE) + uTurn(e.tangent, e.away);
        if (!out || cost < out.cost) out = { id: e.id, dist, cost };
      }
      if (!out) continue;
      if (near < DIRECT_RANGE && dir === side) {
        const cost = near / TRUCK.GRASS_SPEED + out.cost;
        if (!best || cost < best.cost) best = { via: '', s: wreck.s, dir, out: out.id, cost, direct: true };
      }
      // Parked near the apron (staged up an escape road, a lot by it): across the grass onto its lane, a little way on.
      if (truck.d - t.apronEdgeAt(truck.s) < GRASS_ENTRY) {
        const s0 = t.wrapS(truck.s + dir * DIVE_RUN);
        const [lx, ly] = t.toWorld(s0, this.truckLane(s0));
        if (along(t, s0, wreck.s, dir) < along(t, truck.s, wreck.s, dir)) {
          const cost = Math.hypot(lx - truck.x, ly - truck.y) / TRUCK.GRASS_SPEED
            + (along(t, s0, wreck.s, dir) / APRON_PACE) * (dir < 0 ? AGAINST_TRAFFIC : 1) + out.cost;
          if (!best || cost < best.cost) best = { via: '', s: s0, dir, out: out.id, cost, grass: true };
        }
      }
      for (const a of this.entries) {
        const road = from.dist.get(a.id);
        if (road === undefined) continue;
        const way = from.path(a.id)!;
        const [px, py] = way.length > 1 ? way[way.length - 2] : way[0], [qx, qy] = way[way.length - 1];
        const len = Math.hypot(qx - px, qy - py) || 1;
        const cost = road / ROAD_PACE + (along(t, a.s, wreck.s, dir) / APRON_PACE) * (dir < 0 ? AGAINST_TRAFFIC : 1)
          + out.cost + uTurn(a.tangent, [(qx - px) / len, (qy - py) / len]);
        if (!best || cost < best.cost) best = { via: a.id, s: a.s, dir, out: out.id, cost };
      }
    }
    return best;
  }

  /** The apron's lane for a truck: along its inside, its own width clear of the grass (on the grass where there's no apron). */
  private truckLane(s: number): number {
    const t = this.track;
    const r = TRUCK.RADIUS + 0.4;
    return t.apronWidth >= 2 * r + 0.5 ? t.apronEdgeAt(s) - r : t.apronEdgeAt(s) + r;
  }

  /** World points along the oval the way dir runs from s0, `length` metres, at lateral d(u, s) (u: metres from s0). */
  private alongOval(s0: number, dir: number, length: number, d: (u: number, s: number) => number): Array<[number, number]> {
    const t = this.track;
    const pts: Array<[number, number]> = [];
    if (!(length >= 0)) length = 0; // (never a NaN's endless run)
    for (let u = 0; ; u = Math.min(length, u + 3)) {
      const s = t.wrapS(s0 + dir * u);
      pts.push(t.toWorld(s, d(u, s)));
      if (u >= length) break;
    }
    return pts;
  }

  /**
   * Where the truck pulls up to hook up: past the wreck, in its lane (clear of
   * the wall), to back up to it. In line, the two are one thing in one lane
   * for the field to go round. (Pulled up alongside, cars going round the
   * wreck on that side drove into the truck.)
   */
  private hookPoint(wreck: Car, dir: number): { s: number; d: number } {
    const t = this.track;
    const s = t.wrapS(wreck.s + dir * HOOK_AHEAD);
    return { s, d: Math.max(wreck.d, t.outerEdgeAt(s) + TRUCK.RADIUS + 0.3) };
  }

  private sendOut(w: Wrecker, wreck: Car, plan: Approach, from: RoadsFrom): void {
    const t = this.track;
    const tr = w.truck!;
    if (plan.direct) {
      // Straight across: down to the wreck's inside, and into its lane ahead of it.
      const hook = this.hookPoint(wreck, plan.dir);
      const by = t.toWorld(t.wrapS(wreck.s + plan.dir * 4), Math.max(wreck.d + PASS + 3, this.truckLane(wreck.s)));
      setOff(tr, new TruckPath([[tr.body.x, tr.body.y], by, t.toWorld(hook.s, hook.d)], t, TRUCK.SPEED, TRUCK.BRAKE));
      tr.body.cleared = false;
      Object.assign(w, { wreck, phase: 'drive', dir: plan.dir, via: plan.out, progress: 0, stalled: 0, tries: 0, waited: 0 });
      return;
    }
    const head: Array<[number, number]> = plan.grass ? [[tr.body.x, tr.body.y]] : from.path(plan.via)!;
    // A road meeting the apron at too sharp an angle the way it's going: across the grass onto the apron instead.
    const dive = plan.grass ? null : this.dive(head, plan.dir, true);
    // (A wreck nearer than that: down onto the lane just short of it.)
    if (dive && along(t, dive.s, wreck.s, plan.dir) > along(t, plan.s, wreck.s, plan.dir)) dive.s = t.wrapS(wreck.s - plan.dir * 8);
    const start = dive ? dive.s : plan.s;
    const total = along(t, start, wreck.s, plan.dir);
    const hook = this.hookPoint(wreck, plan.dir);
    // Along the apron, over to go by the wreck on its inside, and into its lane ahead of it.
    const by = wreck.d + PASS;
    const u0 = Math.max(0, total - 70), u1 = Math.max(0, total - 8), u2 = total + 2, u3 = total + HOOK_AHEAD;
    const oval = this.alongOval(start, plan.dir, u3, (u, s) => (u < u2
      ? mix(this.truckLane(s), by, smooth((u - u0) / Math.max(1, u1 - u0)))
      : mix(by, hook.d, smooth((u - u2) / (u3 - u2)))));
    // (Onto the apron's lane a little way along from where the road meets it: room to turn onto it on a curve.)
    const pts = dive ? [...dive.points, ...oval] : plan.grass ? [...head, ...oval] : [...head, ...oval.slice(JOIN_RUN / 3)];
    setOff(tr, new TruckPath(pts, t, TRUCK.SPEED, TRUCK.BRAKE));
    tr.body.cleared = false;
    Object.assign(w, { wreck, phase: 'drive', dir: plan.dir, via: plan.out, progress: 0, stalled: 0, tries: 0, waited: 0 });
  }

  private stepWreckers(dt: number): void {
    this.ensureFleet();
    this.assignWreckers(dt);
    // Marshals' finished jobs drop out (the fleet stays first in the list: a frame has room for WRECKER_SLOTS; finished
    // jobs kept, the trucks at work past them went missing from the viewer).
    for (let k = this.wreckers.length - 1; k >= 0; k--) if (this.wreckers[k].phase === 'done') this.wreckers.splice(k, 1);
    const t = this.track;
    for (const w of this.wreckers) {
      if (w.marshals) {
        if (w.phase !== 'hook') continue;
        w.timer -= dt;
        if (w.timer <= 0) {
          // Lifted off: parked out of the way in the paddock.
          const park = t.infield.garage.parking[this.garageSlots++ % t.infield.garage.parking.length];
          w.wreck!.cleared = true;
          [w.x, w.y] = park;
          this.parkWreck(w);
        }
        continue;
      }
      const tr = w.truck!, body = tr.body;
      if (w.phase === 'idle') continue;
      if (w.phase === 'hook') {
        // Backing up to the car (straight back: it pulled up in line with it), then hooking it up.
        const wreck = w.wreck!;
        const gap = Math.hypot(wreck.x - body.x, wreck.y - body.y);
        if (gap > TRUCK.HITCH + 0.2 && w.timer > HOOK_TIME) {
          const step = Math.min(gap - TRUCK.HITCH, TRUCK.BACK_SPEED * dt);
          body.x += ((wreck.x - body.x) / gap) * step;
          body.y += ((wreck.y - body.y) / gap) * step;
          w.timer -= dt;
        } else w.timer = Math.min(w.timer, HOOK_TIME) - dt;
        // Hooked up: away once there's a gap in the traffic coming (if it's out on the racing surface).
        if (w.timer <= 0 && (!TRUCKS_SOLID || w.timer < -YIELD_TIME || !this.onRacingSurface(body) || !this.trafficComing(body.s, TOW_CROSSING))) this.towAway(w);
      } else if (w.phase === 'drop') {
        // The crew rolls the car off into its bay.
        const wreck = w.wreck!, [bx, by] = w.bay!;
        const f = Math.min(1, dt / Math.max(dt, w.timer));
        wreck.x += (bx - wreck.x) * f;
        wreck.y += (by - wreck.y) * f;
        w.timer -= dt;
        if (w.timer <= 0) {
          this.parkWreck(w);
          const back = t.roads.from(body.x, body.y).to(...w.post);
          setOff(tr, new TruckPath(back.points, t, TRUCK.RETURN_SPEED, TRUCK.BRAKE));
          Object.assign(w, { phase: 'return', progress: 0, stalled: 0 });
        }
      } else {
        const hold = this.mustWait(w, dt);
        const arrived = driveTruck(tr, dt, w.phase === 'tow', hold);
        if (!arrived && !hold) this.watchProgress(w, dt);
        if (w.phase === 'tow') {
          const wreck = w.wreck!;
          trail(wreck, body);
          wreck.vx = 0; wreck.vy = 0;
          const p = t.project(wreck.x, wreck.y);
          wreck.trackIdx = p.idx; wreck.s = p.s; wreck.d = p.d;
        }
        if (arrived && w.phase === 'drive') this.reachWreck(w);
        else if (arrived && w.phase === 'tow') Object.assign(w, { phase: 'drop', timer: DROP_TIME });
        else if (arrived && w.phase === 'return') {
          w.phase = 'idle';
          tr.path = null;
          body.cleared = true;
        }
      }
      // (Found afresh: in the infield, following on from the last step's wanders to the far side of the oval.)
      const p = t.project(body.x, body.y);
      body.trackIdx = p.idx; body.s = p.s; body.d = p.d;
      w.x = body.x; w.y = body.y;
    }
  }

  /** Pulled up at the wreck: hook up, unless it has been knocked away meanwhile (then go round to where it is now). */
  private reachWreck(w: Wrecker): void {
    const t = this.track;
    const tr = w.truck!, wreck = w.wreck!;
    if (Math.hypot(wreck.x - tr.body.x, wreck.y - tr.body.y) > TRUCK.HITCH + 3 && w.tries++ < 3) {
      const hook = this.hookPoint(wreck, w.dir);
      setOff(tr, new TruckPath([[tr.body.x, tr.body.y], t.toWorld(hook.s, hook.d)], t, TRUCK.GRASS_SPEED, TRUCK.BRAKE));
      return;
    }
    w.phase = 'hook';
    w.timer = HOOK_TIME + BACK_TIME;
    wreck.cleared = true; // off the physics from here on
    wreck.towed = true;
  }

  /** Hooked up: back to the apron and along it to the way off, then by road into a bay in the garage. */
  private towAway(w: Wrecker): void {
    const t = this.track;
    const tr = w.truck!, body = tr.body;
    const exit = this.exits.find((e) => e.id === w.via)!;
    const bay = this.bays[this.baysUsed++ % this.bays.length];
    let road = t.roads.fromNode(w.via).to(...bay).points;
    let total = along(t, body.s, exit.s, w.dir);
    if (total > t.length - 20) total = 0;
    // A road leaving the apron back the way it came: off across the grass to it instead, turning round out there.
    const dive = this.dive(road, w.dir, false);
    const dove = !!dive && along(t, body.s, dive.s, w.dir) < total;
    if (dove) { road = dive!.points; total = along(t, body.s, dive!.s, w.dir); }
    const d0 = body.d;
    const oval = this.alongOval(body.s, w.dir, total, (u, s) => mix(d0, this.truckLane(s), smooth(u / 40)));
    // On through the bay by the tow line's length, so the car it tows comes to rest in it.
    const [px, py] = road.length > 1 ? road[road.length - 2] : oval[oval.length - 1];
    const len = Math.hypot(bay[0] - px, bay[1] - py) || 1;
    const through: [number, number] = [bay[0] + ((bay[0] - px) / len) * TRUCK.HITCH, bay[1] + ((bay[1] - py) / len) * TRUCK.HITCH];
    const lead = dove ? oval : oval.slice(0, Math.max(1, oval.length - JOIN_RUN / 3));
    setOff(tr, new TruckPath([...lead, ...road, through], t, TRUCK.TOW_SPEED, TRUCK.TOW_BRAKE));
    Object.assign(w, { phase: 'tow', bay, progress: 0, stalled: 0, waited: 0 });
  }

  /**
   * Where a road meets the apron turned back against the way a truck goes
   * along it (it would turn through more than DIVE_TURN, a loop out across
   * the track on its turning circle): the road as far as it's well into the
   * infield, and the s where the truck meets the apron's lane, DIVE_RUN on
   * from there (entering) or before it (leaving). The truck turns round on
   * the grass. Null where the road meets it fine (or never gets that deep).
   * points: entering, the way to the apron (ending at it); leaving, from it.
   */
  private dive(points: Array<[number, number]>, dir: number, entering: boolean): { points: Array<[number, number]>; s: number } | null {
    const t = this.track;
    if (points.length < 2) return null;
    const depth = (p: [number, number]) => { const q = t.project(p[0], p[1]); return q.d - t.apronEdgeAt(q.s); };
    const ordered = entering ? [...points].reverse() : points; // from the apron out
    const at = ordered[0];
    const far = ordered.find((p) => Math.hypot(p[0] - at[0], p[1] - at[1]) > 12) ?? ordered[ordered.length - 1];
    const q = t.project(at[0], at[1]);
    const ux = far[0] - at[0], uy = far[1] - at[1], len = Math.hypot(ux, uy) || 1;
    // The way the road runs along the lap, away from the apron: entering, the truck comes down it the other way.
    const along = (t.tx[q.idx] * ux + t.ty[q.idx] * uy) / len;
    // (The cosine of the turn from the road onto the lane, or off it.)
    if ((entering ? -along : along) * dir > Math.cos(DIVE_TURN)) return null;
    const k = ordered.findIndex((p) => depth(p) >= DIVE_DEPTH);
    if (k < 0) return null;
    const deep = ordered[k];
    const sDeep = t.project(deep[0], deep[1]).s;
    return entering
      ? { points: points.slice(0, points.length - k), s: t.wrapS(sDeep + dir * DIVE_RUN) }
      : { points: points.slice(k), s: t.wrapS(sDeep - dir * DIVE_RUN) };
  }

  private onRacingSurface(c: Car): boolean {
    return c.d < this.track.innerEdge(c.trackIdx) + 1;
  }

  /**
   * A car on its way round to s on the racing surface (or there), coming fast enough to get there before a truck
   * going out there to drive `out` metres on it is out of the way again.
   */
  private trafficComing(s: number, out: number): boolean {
    const t = this.track;
    const needs = out / CROSS_PACE + CROSS_MARGIN;
    return [...this.world.cars, ...(this.paceCarOut ? [this.paceCar] : [])].some((c) => {
      if (c.retired || c.cleared || c.pit.phase !== 'none' || !this.onRacingSurface(c)) return false;
      const gap = t.distanceFrom(c.s, s);
      return t.distanceFrom(s, c.s) < 15 || (gap < t.length / 2 && gap / Math.max(8, c.speed) < needs);
    });
  }

  /**
   * A truck about to go out onto the racing surface waits short of it for a
   * gap in the traffic coming (cars ran into trucks crossing to a wreck). Once
   * out there, it gets on with it.
   */
  private mustWait(w: Wrecker, dt: number): boolean {
    const tr = w.truck!, path = tr.path!, body = tr.body;
    // (Trucks cars pass through needn't wait for them.)
    if (!TRUCKS_SOLID || this.onRacingSurface(body) || w.waited > YIELD_TIME) return false;
    const look = path.at[tr.idx] + 20 + (tr.speed * tr.speed) / (2 * TRUCK.BRAKE);
    for (let j = tr.idx; j < path.x.length && path.at[j] < look; j++) {
      if (!path.racing[j]) continue;
      // (Out there to the end of the drive: in line with the wreck, pulled up to hook it, the field goes by the two.)
      if (!this.trafficComing(this.track.project(path.x[j], path.y[j]).s, path.length - path.at[j])) break;
      w.waited += dt;
      return true;
    }
    return false;
  }

  /** A truck that has made no headway along its path in a while (caught on something) is moved on along it. */
  private watchProgress(w: Wrecker, dt: number): void {
    const tr = w.truck!, path = tr.path!;
    const at = path.at[tr.idx];
    if (at > w.progress + 1) { w.progress = at; w.stalled = 0; return; }
    w.stalled += dt;
    if (w.stalled < STALLED_TIME) return;
    let j = tr.idx;
    while (j < path.x.length - 1 && path.at[j] < at + 10) j++;
    const k = Math.min(path.x.length - 1, j + 1);
    tr.body.x = path.x[j]; tr.body.y = path.y[j];
    if (k > j) tr.heading = Math.atan2(path.y[k] - path.y[j], path.x[k] - path.x[j]);
    tr.idx = j; tr.kappa = 0;
    w.progress = path.at[j];
    w.stalled = 0;
  }

  /** The track is clear of wrecks: none waiting for a truck, none still on the racing surface. */
  private trackClear(): boolean {
    const t = this.track;
    if (this.callouts.length) return false;
    return this.wreckers.every((w) => !w.wreck || w.phase === 'done'
      || ((w.phase === 'tow' || w.phase === 'drop') && w.wreck.d > t.innerEdge(w.wreck.trackIdx) + 3));
  }

  private parkWreck(w: Wrecker): void {
    const wreck = w.wreck!;
    if (w.marshals) w.phase = 'done';
    wreck.towed = false;
    wreck.parked = true;
    if (w.marshals) { wreck.x = w.x; wreck.y = w.y; }
    w.wreck = null;
  }
}

/**
 * Where a truck can wait round the infield: in each parking lot, a little way
 * in from where its lane reaches it; and staged up each escape road, on its
 * verge a little way from the apron (as wreckers wait at the turns).
 */
function stagingPosts(t: Track): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const road of t.roads.roads) {
    if (!/^lot\d+$/.test(road.to) || road.points.length < 2) continue;
    const [ax, ay] = road.points[road.points.length - 2], [bx, by] = road.points[road.points.length - 1];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    out.push([bx + ((bx - ax) / len) * 8, by + ((by - ay) / len) * 8]);
  }
  for (const road of t.roads.roads) {
    if (road.grade !== 'escape' || t.roads.nodes.get(road.from)?.kind !== 'apron') continue;
    const at = pointAlong(road.points, STAGE_UP_ESCAPE);
    if (!at) continue;
    const [x, y, ux, uy] = at;
    const side = road.width / 2 + TRUCK.RADIUS + 1;
    // On whichever verge is further from the racing surface.
    const verges: Array<[number, number]> = [[x - uy * side, y + ux * side], [x + uy * side, y - ux * side]];
    const inset = (p: [number, number]) => { const q = t.project(p[0], p[1]); return q.d - t.apronEdgeAt(q.s); };
    const post = inset(verges[0]) > inset(verges[1]) ? verges[0] : verges[1];
    if (inset(post) > 3) out.push(post);
  }
  return out;
}

/** How far up an escape road from the apron a truck waits (m). */
const STAGE_UP_ESCAPE = 25;

/** The point `dist` metres along a polyline, and the way it runs there; null if it's shorter. */
function pointAlong(pts: Array<[number, number]>, dist: number): [number, number, number, number] | null {
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
    const seg = Math.hypot(bx - ax, by - ay);
    if (seg > 1e-9 && dist <= seg) return [ax + ((bx - ax) * dist) / seg, ay + ((by - ay) * dist) / seg, (bx - ax) / seg, (by - ay) / seg];
    dist -= seg;
  }
  return null;
}

/** Metres from a to b the way dir runs round the lap. */
function along(t: Track, a: number, b: number, dir: number): number {
  return dir > 0 ? t.distanceFrom(a, b) : t.distanceFrom(b, a);
}

const mix = (a: number, b: number, f: number) => a + (b - a) * f;
const smooth = (x: number) => {
  const f = Math.max(0, Math.min(1, x));
  return f * f * (3 - 2 * f);
};

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

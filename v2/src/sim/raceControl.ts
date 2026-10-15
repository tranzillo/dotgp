import { Car } from './car';
import { G, PHYSICS as P, PIT_SERVICE } from './constants';
import type { Track } from './track';
import type { World } from './world';

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
export type Flag = 'pace' | 'restart' | 'green' | 'caution';

/** Minimum laps under caution, however quickly the track is cleared. */
const MIN_CAUTION_LAPS = 2;
const ROW_GAP = 10; // m between rows in formation
const FIRST_ROW_GAP = 16; // m from the pace car to the front row
const FILE_OFFSET = 2.6; // m either side of the centerline for the two files
const WRECKER_SPEED = 22;
const TOW_SPEED = 15;
const HOOK_TIME = 8;
const STALL_TIME = 5; // s stopped on the racing surface before a car counts as a wreck

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
  /** Escape lane it tows along (index into the infield's lanes), or -1 for pit road. */
  via: number;
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
/** Under pacing, how far one car must be ahead of the car before it in line to take its place (m). */
const SWAP_MARGIN = 8;

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
  /** Laps this caution runs at least. */
  private cautionMinLaps = MIN_CAUTION_LAPS;
  private readonly handled = new Set<Car>();
  private readonly cautioned = new Set<Car>();
  private readonly stoppedSince = new Map<Car, number>();
  private garageSlots = 0;
  /** Cars in formation order this tick, and their slots. */
  private order: Car[] = [];
  /** Where the virtual pace car is when the real one isn't leading the line (NaN: none). */
  private virtualS = NaN;
  private readonly slots = new Map<Car, FormationSlot>();
  /** Set when the green flag waves; used by the race to start the clock. */
  onGreen: ((leader: Car) => void) | null = null;

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

  /** Line the field up double file behind the pace car on the back straight, at pace speed. */
  formUp(cars: Car[]): void {
    const t = this.track;
    const paceS = pullOffS(t) - 120;
    this.paceCar.placeOnTrack(t, paceS, 0);
    setSpeed(this.paceCar, t, this.paceSpeed);
    cars.forEach((car, k) => {
      const row = Math.floor(k / 2);
      car.placeOnTrack(t, paceS - FIRST_ROW_GAP - row * ROW_GAP, k % 2 === 0 ? -FILE_OFFSET : FILE_OFFSET);
      setSpeed(car, t, this.paceSpeed);
    });
    this.flag = 'pace';
    this.paceCarOut = true;
    // A full pace lap: "one to go" once the leader first crosses the line.
    this.oneToGo = false;
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

    if (this.flag === 'pace' && !this.oneToGo && leader && this.crossedLine(leader)) {
      this.oneToGo = true;
      this.world.announce(leader, 'flag', 'One lap to go to the green');
    }
    if (this.flag === 'caution') {
      const laps = leader ? leader.lapsCompleted - this.cautionLap : 0;
      const clear = this.wreckers.every((w) => w.phase === 'done' || (w.phase === 'tow' && w.wreck.d > t.innerEdge(w.wreck.trackIdx) + 3));
      if (clear && laps >= this.cautionMinLaps) this.oneToGo = true;
      this.releasePaceCar(leader);
    }
    // The pace car pulls off onto pit road; the leader takes the field to the green.
    if ((this.flag === 'pace' || this.flag === 'caution') && this.paceCarOut && this.oneToGo
      && this.paceCar.d > t.innerEdge(this.paceCar.trackIdx) + 0.5 && this.paceCarHeadingIn()) {
      this.flag = 'restart';
      this.world.announce(leader ?? this.paceCar, 'flag', 'Pace car is off: leader to the line for the green');
    }
    if (this.paceCarOut && this.oneToGo && this.paceCar.surface === 'pit' && t.signedS(this.paceCar.s) > t.pit.wallStart + 15
      && t.signedS(this.paceCar.s) < t.pit.wallEnd - 20) {
      this.paceCarOut = false; // pulled in and parked
      this.paceCar.cleared = true; // parked off to the side: not an obstacle on pit road
    }
    if (this.flag === 'restart' && leader && this.crossedLine(leader)) {
      this.flag = 'green';
      this.world.announce(leader, 'flag', 'Green flag!');
      this.onGreen?.(leader);
    }
  }

  // ---------- incidents ----------

  private detectIncidents(dt: number): void {
    const t = this.track;
    for (const car of this.world.cars) {
      if (this.handled.has(car) || car.cleared) continue;
      // A car stopped on the racing surface (out of fuel, spun) is a wreck too.
      if (!car.retired && car.pit.phase === 'none' && car.speed < 3 && car.d < t.innerEdge(car.trackIdx) + 1) {
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
      if (this.flag === 'green' && car.d < t.apronEdgeAt(car.s) + 5 && !this.cautioned.has(car)) {
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
    this.world.announce(cause, 'flag', 'Caution! Field slows, pace car coming out');
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
    this.world.announce(this.order[0], 'flag', 'Caution for debris: field slows, pace car coming out');
  }

  /** Release the pace car from the end of pit road so it enters ahead of the leader. */
  private releasePaceCar(leader: Car | null): void {
    if (this.paceCarOut || !leader || this.oneToGo) return;
    const t = this.track;
    const toExit = t.distanceFrom(leader.s, t.pit.wallEnd);
    if (toExit > 150 && toExit < 700) {
      this.paceCar.placeOnTrack(t, t.pit.wallEnd - 5, t.pit.wallD + t.pit.wallThickness / 2 + 3);
      setSpeed(this.paceCar, t, 5);
      this.paceCar.retired = false;
      this.paceCar.cleared = false;
      this.paceCarOut = true;
    }
  }

  private paceCarHeadingIn(): boolean {
    const r = this.track.signedS(this.paceCar.s);
    return r > pullOffS(this.track) - 10 && r < this.track.pit.wallEnd;
  }

  private crossedLine(car: Car): boolean {
    // Lap timing has already registered the crossing this step if lapStartTime is "now".
    return Math.abs(car.lapStartTime - this.world.time) < P.DT * 1.5;
  }

  // ---------- formation ----------

  private updateFormation(leader: Car | null, dt: number): void {
    const t = this.track;
    this.slots.clear();
    const inLine = (c: Car) => !c.retired && !c.cleared && c.pit.phase === 'none';
    const byDistance = (a: Car, b: Car) => b.dist - a.dist;
    if (!this.pacing || !this.order.length) {
      this.order = this.world.cars.filter(inLine).sort(byDistance);
    } else {
      // Under pacing two cars only swap places in line once one is clearly ahead: re-sorting every step
      // swapped cars side by side in a row, and with them their files. Cars drop out (pitting, wrecked)
      // and rejoin where they are.
      const order = this.order.filter(inLine);
      for (const car of this.world.cars) {
        if (!inLine(car) || order.includes(car)) continue;
        const at = order.findIndex((c) => c.dist < car.dist);
        order.splice(at < 0 ? order.length : at, 0, car);
      }
      for (let i = 1; i < order.length; i++) {
        for (let j = i; j > 0 && order[j].dist > order[j - 1].dist + SWAP_MARGIN; j--) {
          [order[j - 1], order[j]] = [order[j], order[j - 1]];
        }
      }
      this.order = order;
    }
    if (!this.pacing || !this.order.length) return;
    void leader;
    const pc = this.paceCar;
    const head = this.order[0];
    // The pace car leads if it's on track ahead of the leader; otherwise the leader sets the pace.
    const paceCarLeads = this.paceCarOut && !this.paceCarHeadingInAndOff() && pc.d < t.innerEdge(pc.trackIdx) + 1
      && t.distanceFrom(head.s, pc.s) < 400;
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
      else this.virtualS = t.wrapS(this.virtualS + this.paceSpeed * (this.flag === 'caution' ? 1.15 : 1) * dt);
      refS = this.virtualS;
    }
    const refSpeed = paceCarLeads ? Math.max(pc.speed, this.paceSpeed * 0.6) : this.paceSpeed * (this.flag === 'caution' ? 1.15 : 1);
    this.order.forEach((car, index) => {
      const row = Math.floor(index / 2);
      const back = paceCarLeads ? FIRST_ROW_GAP + row * ROW_GAP : row * ROW_GAP;
      this.slots.set(car, {
        index,
        s: t.wrapS(refS - back),
        d: index % 2 === 0 ? -FILE_OFFSET : FILE_OFFSET,
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
    const start = t.toWorld(t.pit.wallEnd, t.apronEdgeAt(t.pit.wallEnd) - 2);
    // Drive the shorter way round along the apron (against traffic is fine for a wrecker).
    const fwd = t.distanceFrom(t.pit.wallEnd, wreck.s);
    this.wreckers.push({
      wreck, x: start[0], y: start[1], s: t.pit.wallEnd, d: t.apronEdgeAt(t.pit.wallEnd) - 2,
      phase: 'drive', timer: 0, route: [], exitS: 0, dir: fwd < t.length / 2 ? 1 : -1, via: -1,
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
        if (w.timer <= 0) this.planTow(w);
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

  /** Pick the nearest infield access: an escape lane, or pit entry and pit road. */
  private planTow(w: Wrecker): void {
    const t = this.track;
    const accesses = [
      ...t.infield.escapeLanes.map((lane, via) => ({ via, exitS: t.project(...lane.points[0]).s })),
      { via: -1, exitS: t.wrapS(t.pit.entryStart) },
    ];
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

  private routeToGarage(w: Wrecker): Array<[number, number]> {
    const t = this.track;
    const g = t.infield.garage;
    const park = g.parking[this.garageSlots++ % g.parking.length];
    if (w.via >= 0) return [...t.infield.escapeLanes[w.via].points.slice(1), park];
    // Pit road: in at the entry, along the inner side of pit road, into the garage.
    const lane = t.pit.roadD - 2;
    return [
      t.toWorld(t.pit.wallStart - 10, lane),
      t.toWorld(g.lot.s0 + 4, lane),
      park,
    ];
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

import { PHYSICS as P, PIT_SERVICE } from './constants';
import { applyService, serviceTime, stepCar, type Car } from './car';
import { computeDraft, resolveCarCollisions, resolveWalls } from './collisions';
import type { RaceControl } from './raceControl';
import type { Track } from './track';

/** Whatever controls a car (usually a team: spotter + driver). Sets car.inputX / car.inputY. */
export interface Controller {
  decide(car: Car, world: World): void;
}

export interface WorldOptions {
  /** Car-to-car contact. Off = ghost cars (used for evolution trials). */
  collisions: boolean;
  drafting: boolean;
  /** Multiplies all damage. Below 1 only for training curricula (soft walls for rookies). */
  damageScale: number;
  /** Race pace: multiplies tire wear and fuel burn so pit windows arrive sooner. */
  wearScale: number;
  /** Clear stopped wrecks automatically (open sessions); races use the wrecker crew instead. */
  autoClearWrecks: boolean;
}

/** A car stopped within this far of its box's centre is in the box (boxes are 12 m long). */
const BOX_HALF_LENGTH = 5;

/** Seconds a stopped wreck stays on track before the safety crew clears it. */
export const WRECK_CLEAR_TIME = 4;

/** Something worth putting on the broadcast feed. */
export interface WorldEvent {
  time: number;
  car: Car;
  /** steward: a decision (warning, penalty, black flag); review: an incident looked at (or let go); served: a penalty served. */
  kind: 'pit-in' | 'pit-out' | 'missed-pit' | 'retired' | 'crew' | 'flag' | 'steward' | 'review' | 'served';
  text: string;
}

export class World {
  readonly track: Track;
  readonly opts: WorldOptions;
  readonly cars: Car[] = [];
  readonly controllers: Array<Controller | null> = [];
  /** The latest announcements (the oldest are dropped past 500; see eventsDropped). */
  readonly events: WorldEvent[] = [];
  /** Announcements dropped from the front of `events`: event n is at events[n - eventsDropped]. */
  eventsDropped = 0;
  /** Race distance in laps, or null for open sessions. Crew chiefs plan around it. */
  raceLaps: number | null = null;
  /** Flags, pace car and wreckers, when a race is under race control. */
  control: RaceControl | null = null;
  /** Officials' cars (the pace car): physical, but not competitors. */
  readonly officials: Array<{ car: Car; controller: Controller }> = [];
  time = 0;
  tick = 0;

  constructor(track: Track, opts: Partial<WorldOptions> = {}) {
    this.track = track;
    this.opts = { collisions: true, drafting: true, damageScale: 1, wearScale: 1, autoClearWrecks: true, ...opts };
  }

  addCar(car: Car, controller: Controller | null): void {
    // Pit boxes are handed out in entry order along pit road (shared on tracks with short pit roads).
    const stalls = this.track.pit.stalls;
    car.pit.boxS = stalls[this.cars.length % stalls.length];
    this.cars.push(car);
    this.controllers.push(controller);
  }

  /** Swap a car (e.g. a respawn) keeping its controller and pit box. */
  replaceCar(index: number, car: Car): void {
    car.pit.boxS = this.cars[index].pit.boxS;
    this.cars[index] = car;
  }

  step(): void {
    const dt = P.DT;
    const { cars, controllers, track } = this;

    if (this.tick % P.CONTROL_EVERY === 0) {
      for (let k = 0; k < cars.length; k++) {
        const controller = controllers[k];
        if (controller && !cars[k].retired) controller.decide(cars[k], this);
      }
      for (const o of this.officials) o.controller.decide(o.car, this);
    }
    if (this.opts.drafting) computeDraft(cars, track);

    for (const car of cars) {
      const wasRetired = car.retired;
      stepCar(car, track, dt, this.opts.wearScale);
      reproject(car, track);
      resolveWalls(car, track, this.opts.damageScale);
      if (car.retired && !wasRetired) this.announce(car, 'retired', 'Out of the race');
      // Open sessions: the safety crew clears a wreck once it has stopped.
      if (this.opts.autoClearWrecks && car.retired && !car.cleared) {
        car.stoppedFor = car.speed < 0.5 ? car.stoppedFor + dt : 0;
        if (car.stoppedFor > WRECK_CLEAR_TIME) car.cleared = true;
      }
    }
    for (const { car } of this.officials) {
      stepCar(car, track, dt);
      reproject(car, track);
      resolveWalls(car, track, 0);
    }
    if (this.opts.collisions) {
      const all = this.officials.length ? [...cars, ...this.officials.map((o) => o.car)] : cars;
      const before = cars.map((c) => c.retired);
      resolveCarCollisions(all, track);
      cars.forEach((c, i) => { if (c.retired && !before[i]) this.announce(c, 'retired', 'Out of the race after contact'); });
      for (const car of all) reproject(car, track);
      for (const { car } of this.officials) { car.health = 1; car.retired = false; } // officials don't wreck
    }

    this.time += dt;
    for (const car of cars) {
      updateTiming(car, track, this.time, dt);
      this.updatePit(car, dt);
    }
    this.tick++;
  }

  announce(car: Car, kind: WorldEvent['kind'], text: string): void {
    this.events.push({ time: this.time, car, kind, text });
    if (this.events.length > 500) this.eventsDropped += this.events.splice(0, this.events.length - 500).length;
  }

  /** The pit cycle's rules live in the world, whoever is driving. */
  private updatePit(car: Car, dt: number): void {
    const pit = car.pit;
    if (pit.phase === 'none' || car.retired) return;
    const r = this.track.signedS(car.s);
    if (pit.phase === 'in') {
      const inPitLane = car.d > this.track.pit.wallD;
      if (r > this.track.pit.wallStart + 5 && r < pit.boxS && !inPitLane) {
        pit.phase = 'none';
        pit.call = null;
        this.announce(car, 'missed-pit', 'Missed the pit entry');
      } else if (inPitLane && Math.abs(r - pit.boxS) < BOX_HALF_LENGTH && car.speed < 1.5) {
        pit.phase = 'service';
        pit.timer = serviceTime(car, pit.call!);
        pit.stops++;
        this.announce(car, 'pit-in', describeCall(pit.call!, pit.timer));
      } else if (r > pit.boxS + 15) {
        pit.phase = 'out'; // overshot the box: drive through
        this.announce(car, 'missed-pit', 'Overshot the box, driving through');
      }
    } else if (pit.phase === 'service') {
      car.vx = 0;
      car.vy = 0;
      pit.timer -= dt;
      if (pit.timer <= 0) {
        applyService(car, pit.call!);
        pit.phase = 'out';
        this.announce(car, 'pit-out', 'Leaving the pits');
      }
    } else if (pit.phase === 'out') {
      // Done once the car has merged onto the racing surface past the blend
      // zone (or has given up waiting for a gap and been sent out anyway).
      const t = this.track;
      const u = t.progressFrom(pit.boxS, car.s);
      const blend = t.distanceFrom(pit.boxS, t.pit.blendEnd);
      const merged = u > blend - PIT_SERVICE.MERGE_ZONE && car.d < t.innerEdge(car.trackIdx);
      const giveUp = u > Math.min(blend + PIT_SERVICE.MERGE_GIVE_UP, t.length - 100);
      if (merged || giveUp) {
        pit.phase = 'none';
        pit.call = null;
      }
    }
  }
}

function describeCall(call: { tires: boolean; fuel: number; repair: boolean }, seconds: number): string {
  const parts = [call.tires ? 'four tires' : '', call.fuel > 0.5 ? `${Math.round(call.fuel)} kg fuel` : '', call.repair ? 'repairs' : '']
    .filter(Boolean);
  return `Pit stop: ${parts.join(', ') || 'checks'} (${seconds.toFixed(1)} s)`;
}

function reproject(car: Car, track: Track): void {
  const prevS = car.s;
  const p = track.project(car.x, car.y, car.trackIdx);
  car.trackIdx = p.idx;
  car.d = p.d;
  car.s = p.s;
  const L = track.length;
  let ds = p.s - prevS;
  if (ds > L / 2) ds -= L;
  else if (ds < -L / 2) ds += L;
  // Progress can't outrun the car. Cutting across the infield makes the
  // projection jump; clamping means a shortcut earns nothing.
  const maxStep = car.speed * P.DT * 1.25 + 0.05;
  car.dist += Math.max(-maxStep, Math.min(maxStep, ds));
}

function updateTiming(car: Car, track: Track, time: number, dt: number): void {
  if (car.dist < car.nextLineDist) return;
  // Interpolate the crossing time within the step.
  const along = Math.max(1e-6, car.vx * track.tx[car.trackIdx] + car.vy * track.ty[car.trackIdx]);
  const crossTime = Math.max(time - dt, time - (car.dist - car.nextLineDist) / along);
  if (car.lapStartTime >= 0) car.lapTimes.push(crossTime - car.lapStartTime);
  car.lapStartTime = crossTime;
  car.nextLineDist += track.length;
}

import type { Car } from '../sim/car';
import { PHYSICS as P, PIT_SERVICE } from '../sim/constants';
import type { RaceControl } from '../sim/raceControl';
import type { World } from '../sim/world';
import type { Offence, Rulebook } from './rulebook';

/**
 * Detection: offences the sim can measure, reported once each with how bad
 * they were (severity 0 marginal .. 1 flagrant). Objective, like a timing
 * loop or a camera: judging is the stewards' job.
 */
export interface Violation {
  offence: Offence;
  car: Car;
  time: number;
  severity: number;
  /** The other car involved (passed, hit), if any. */
  against: Car | null;
  /** What happened, for the record. */
  detail: string;
}

/** Contact keeps adding up while cars are touching; it's one incident until they've been apart this long (s). */
const CONTACT_SETTLE = 1;
/** Harm (health, by fault) below which a touch isn't worth reporting, and the fault share that makes it the car's doing. */
const CONTACT_MIN_HARM = 0.1;
const CONTACT_FAULT = 0.6;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export class Detector {
  /** Previous step's running order under green. */
  private greenOrder: Car[] = [];
  /** Per car: seconds over the pit limit this visit, worst excess (m/s), already reported. */
  private pitOver = new Map<Car, { seconds: number; worst: number; reported: boolean }>();
  private blendReported = new Set<Car>();
  private harmBefore = new Map<Car, number>();
  private contacts = new Map<string, { car: Car; against: Car | null; harm: number; last: number; speed: number }>();

  constructor(private readonly world: World, private readonly control: RaceControl, private readonly rules: Rulebook) {}

  step(): Violation[] {
    const out: Violation[] = [];
    const { world, control } = this;
    const now = world.time;
    this.pitRoad(out, now);
    this.contact(out, now);
    this.line(out, now);
    if (control.pacing) this.greenOrder = [];
    else this.belowTheLine(out, now);
    return out;
  }

  /** Speeding on pit road (reported once a visit, when the car leaves it), crossing the blend line early. */
  private pitRoad(out: Violation[], now: number): void {
    const { world, rules } = this;
    const t = world.track;
    for (const car of world.cars) {
      if (car.retired) continue;
      if (car.surface === 'pit') {
        const over = car.speed - PIT_SERVICE.SPEED_LIMIT;
        const st = this.pitOver.get(car) ?? { seconds: 0, worst: 0, reported: false };
        if (over > rules.pitSpeedTolerance) {
          st.seconds += P.DT;
          st.worst = Math.max(st.worst, over);
        }
        this.pitOver.set(car, st);
      } else {
        const st = this.pitOver.get(car);
        if (st && !st.reported && st.seconds > rules.pitSpeedGrace) {
          out.push({
            offence: 'pit-speeding', car, time: now, severity: clamp01(st.worst / 6), against: null,
            detail: `${(st.worst * 3.6).toFixed(0)} km/h over the limit for ${st.seconds.toFixed(1)} s`,
          });
        }
        this.pitOver.delete(car);
      }
      if (car.pit.phase === 'out' && !this.blendReported.has(car) && car.d < t.innerEdge(car.trackIdx) - 0.5) {
        const early = t.distanceFrom(t.wrapS(car.s), t.wrapS(t.pit.blendEnd - PIT_SERVICE.MERGE_ZONE));
        if (early > 0 && early < t.length / 2) {
          this.blendReported.add(car);
          out.push({ offence: 'blend-line', car, time: now, severity: clamp01(early / 100), against: null, detail: `${early.toFixed(0)} m early` });
        }
      }
      if (car.pit.phase === 'none') this.blendReported.delete(car);
    }
  }

  /** Car contact, mostly the car's fault, that hurt the other: one incident per touch, once it's over. */
  private contact(out: Violation[], now: number): void {
    const { world } = this;
    for (const car of world.cars) {
      const before = this.harmBefore.get(car) ?? 0;
      const delta = car.harmDone - before;
      this.harmBefore.set(car, car.harmDone);
      const imp = car.lastImpact;
      if (delta <= 0 || imp?.kind !== 'car' || (imp.fault ?? 0) < CONTACT_FAULT) continue;
      const against = imp.other === null ? null : world.cars.find((c) => c.id === imp.other) ?? null;
      const key = `${car.id}:${imp.other}`;
      const c = this.contacts.get(key) ?? { car, against, harm: 0, last: now, speed: 0 };
      c.harm += delta;
      c.last = now;
      c.speed = Math.max(c.speed, imp.speed);
      this.contacts.set(key, c);
    }
    for (const [key, c] of this.contacts) {
      if (now - c.last < CONTACT_SETTLE) continue;
      this.contacts.delete(key);
      if (c.harm < CONTACT_MIN_HARM) continue;
      const wrecked = c.against?.retired ?? false;
      out.push({
        offence: 'avoidable-contact', car: c.car, time: now, against: c.against,
        severity: clamp01(c.harm * 2 + (wrecked ? 0.4 : 0)),
        detail: `${(c.speed * 3.6).toFixed(0)} km/h, ${(c.harm * 100).toFixed(0)}% damage${wrecked ? ', out of the race' : ''}`,
      });
    }
  }

  /**
   * The caution line: race control keeps the official order, tells crews
   * who's out of order, and hands the stewards what's still wrong at the
   * deadline (a place not given back) or a pass before the green (a jumped
   * restart). Detection only passes those on.
   */
  private line(out: Violation[], now: number): void {
    for (const c of this.control.takeLineupCases()) {
      out.push(c.restart
        ? { offence: 'jumped-restart', car: c.car, time: now, against: c.against, severity: 1, detail: `passed #${c.against.id} before the green` }
        : { offence: 'passing-under-caution', car: c.car, time: now, against: c.against, severity: 1, detail: `still ahead of #${c.against.id} a lap after being told` });
    }
  }

  /** Under green: a pass completed with the passing car entirely on the apron. */
  private belowTheLine(out: Violation[], now: number): void {
    const { world } = this;
    const t = world.track;
    const order = world.cars.filter((c) => !c.retired && !c.finished && c.pit.phase === 'none').sort((a, b) => b.dist - a.dist);
    const before = new Map(this.greenOrder.map((c, i) => [c, i]));
    order.forEach((car, i) => {
      const prev = order[i + 1];
      const was = before.get(car), prevWas = prev ? before.get(prev) : undefined;
      if (!prev || was === undefined || prevWas === undefined || was !== prevWas + 1) return; // not an adjacent pass
      if (Math.abs(car.dist - prev.dist) > 10) return; // a lap apart, not a pass
      const below = car.d - P.CAR_RADIUS > t.innerEdge(car.trackIdx);
      if (below) {
        out.push({ offence: 'passing-below-the-line', car, time: now, against: prev, severity: 0.6, detail: `passed #${prev.id} on the apron` });
      }
    });
    this.greenOrder = order;
  }
}

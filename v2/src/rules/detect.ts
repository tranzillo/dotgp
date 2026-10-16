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
/** A car's length: cars closer than this along the track are alongside; a pass is done when one is a car length clear. */
const CAR_LENGTH = 2 * P.CAR_RADIUS;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export class Detector {
  /** Pairs of cars alongside each other (a possible pass) and the evidence so far. */
  private readonly alongside = new Map<string, { a: Car; b: Car; aStartedAhead: boolean; moments: number; aBelow: number; bBelow: number }>();
  /** When the pace car pulled off: each car in the line, and the cars physically ahead of it then. */
  private restartAhead: Map<Car, Car[]> | null = null;
  /** Lined-up cars that have crossed the line since the pace car pulled off. */
  private restartCrossed = new Set<Car>();
  private lastFlag = '';
  /** Whether this track has the line rule (its size class). */
  private readonly lineRule: boolean;
  /** Per car: seconds over the pit limit this visit, worst excess (m/s), already reported. */
  private pitOver = new Map<Car, { seconds: number; worst: number; reported: boolean }>();
  private blendReported = new Set<Car>();
  private harmBefore = new Map<Car, number>();
  private contacts = new Map<string, { car: Car; against: Car | null; harm: number; last: number; speed: number }>();

  constructor(private readonly world: World, private readonly control: RaceControl, private readonly rules: Rulebook) {
    this.lineRule = rules.belowTheLineOn.includes(String(world.track.layout.params.variant ?? ''));
  }

  step(): Violation[] {
    const out: Violation[] = [];
    const { world, control } = this;
    const now = world.time;
    this.pitRoad(out, now);
    this.contact(out, now);
    this.line(out, now);
    this.restart(out, now);
    if (control.pacing) this.alongside.clear();
    else if (this.lineRule) this.belowTheLine(out, now);
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

  /** In the line: within a row of its place (not still catching up, nor dropping back). */
  private inLine(c: Car): boolean {
    const slot = this.control.slotFor(c);
    if (!slot) return false;
    return Math.abs(this.ahead(c, { s: slot.s } as Car)) < this.control.lineSpacing();
  }

  /** How far a is ahead of b along the track, the shorter way round (negative: behind). */
  private ahead(a: Car, b: Car): number {
    const t = this.world.track;
    const d = t.distanceFrom(b.s, a.s);
    return d > t.length / 2 ? d - t.length : d;
  }

  /**
   * Passing below the line, judged as a move: two cars alongside (overlapping,
   * less than a car length apart) is a possible pass. While they're alongside,
   * how much of the time each had all four wheels below the line is the
   * evidence; when they're no longer alongside the move is over. If the car
   * that started behind came out ahead, it made the pass, and the share of
   * the move it made below the line is what the stewards look at.
   */
  private belowTheLine(out: Violation[], now: number): void {
    const { world } = this;
    const t = world.track;
    const below = (c: Car) => c.d - P.CAR_RADIUS > t.innerEdge(c.trackIdx);
    const racing = world.cars.filter((c) => !c.retired && !c.finished && c.pit.phase === 'none');
    const still = new Set<string>();
    for (const a of racing) {
      for (const b of racing) {
        if (a.id >= b.id) continue;
        const key = `${a.id}:${b.id}`;
        const gap = this.ahead(a, b);
        if (Math.abs(gap) < CAR_LENGTH) {
          still.add(key);
          const m = this.alongside.get(key) ?? { a, b, aStartedAhead: gap > 0, moments: 0, aBelow: 0, bBelow: 0 };
          m.moments++;
          if (below(a)) m.aBelow++;
          if (below(b)) m.bBelow++;
          this.alongside.set(key, m);
        }
      }
    }
    for (const [key, m] of this.alongside) {
      if (still.has(key)) continue;
      this.alongside.delete(key); // the move is over
      if (m.a.retired || m.b.retired) continue;
      const aAhead = this.ahead(m.a, m.b) > 0;
      if (aAhead === m.aStartedAhead) continue; // nobody got by
      const [passer, passed, belowMoments] = aAhead ? [m.a, m.b, m.aBelow] : [m.b, m.a, m.bBelow];
      if (!belowMoments) continue;
      const share = belowMoments / m.moments;
      out.push({
        offence: 'passing-below-the-line', car: passer, time: now, against: passed, severity: share,
        detail: `passed #${passed.id} with ${(share * 100).toFixed(0)}% of the move below the line`,
      });
    }
  }

  /**
   * A restart. The green comes when the leader crosses the line and the field
   * accelerates, but no car may gain a place until it has crossed the line
   * itself. When the pace car pulls off, the cars in the line (within their
   * place; cars still catching up aren't lined up yet) and the official order
   * are the reference. Each lined-up car is judged as it crosses the line:
   * clear (a car length) ahead of a car from an earlier row that hasn't
   * crossed yet, it got by before the line. A place taken and given back
   * before the line is no case.
   */
  private restart(out: Violation[], now: number): void {
    const flag = this.control.flag;
    if (flag === 'restart' && this.lastFlag !== 'restart') {
      const lined = this.control.lineOrder().filter((c) => this.inLine(c));
      // The cars each one must not get by before the line: those in earlier rows of the official order (the
      // field is doubled up; row mates are level). Passing a car that's out of place ahead isn't gaining one.
      const order = this.control.lineOrder();
      const row = (c: Car) => Math.floor(order.indexOf(c) / 2);
      this.restartAhead = new Map(lined.map((c) => [c, lined.filter((o) => row(o) < row(c))]));
      this.restartCrossed = new Set();
    }
    if (flag === 'caution') this.restartAhead = null; // a caution before the field got going: no restart to judge
    if (this.restartAhead) {
      // Lap timing registers each crossing of the start/finish line (the first one at the start included).
      for (const c of this.restartAhead.keys()) if (this.control.crossedLine(c)) this.restartCrossed.add(c);
      const crossed = (c: Car) => this.restartCrossed.has(c);
      for (const [car, wasAhead] of this.restartAhead) {
        if (car.retired || car.pit.phase !== 'none') { this.restartAhead.delete(car); continue; }
        if (!crossed(car)) continue;
        this.restartAhead.delete(car);
        const passed = wasAhead.filter((o) => !o.retired && o.pit.phase === 'none' && !crossed(o) && this.ahead(car, o) > CAR_LENGTH);
        if (!passed.length) continue;
        out.push({
          offence: 'jumped-restart', car, time: now, against: passed[0], severity: Math.min(1, passed.length / 2),
          detail: `got by ${passed.map((c) => `#${c.id}`).join(', ')} before the line`,
        });
      }
      if (!this.restartAhead.size) this.restartAhead = null;
    }
    this.lastFlag = flag;
  }
}

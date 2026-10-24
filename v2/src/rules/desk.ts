import type { Car } from '../sim/car';
import type { RaceControl } from '../sim/raceControl';
import type { World } from '../sim/world';
import { Detector, type Violation } from './detect';
import { OFFENCE_NAMES, type Offence, type Penalty, type Rulebook } from './rulebook';
import { Stewards, type Decision, type StewardTraits } from './stewards';

/**
 * The stewards' desk for one race: detection reports, the stewards judge,
 * the desk enforces. Warnings add up; time is added to the race time; under
 * caution a car can be sent to the back of the line; drive-throughs and
 * stop-and-gos are served on pit road within a few green laps (the team
 * calls the car in) or the car is shown the black flag. Every decision goes
 * on the broadcast feed and into the race's record.
 */
export interface PenaltyRecord {
  car: Car;
  time: number;
  offence: Offence;
  penalty: Penalty;
  detail: string;
}

export const PENALTY_NAMES: Record<Penalty, string> = {
  none: 'no further action', warning: 'a warning', time: 'a time penalty', tail: 'to the back of the line',
  'drive-through': 'a drive-through', 'stop-go': 'a stop-and-go', 'black-flag': 'the black flag',
};

export class StewardsDesk {
  /** Every decision that wasn't "no action", in order. */
  readonly record: PenaltyRecord[] = [];
  private readonly detector: Detector;
  readonly stewards: Stewards;
  private readonly warnings = new Map<Car, number>();
  private readonly lapsSeen = new Map<Car, number>();
  /** What a car owes a drive-through or stop-and-go for. */
  private readonly owed = new Map<Car, Offence>();
  /** Track limits strikes so far, per car. */
  private readonly strikes = new Map<Car, number>();
  /** Incidents the stewards are looking at, and when they'll announce a decision. */
  private readonly underReview: Array<{ v: Violation; due: number }> = [];

  constructor(
    private readonly world: World, private readonly control: RaceControl, private readonly rules: Rulebook,
    traits?: StewardTraits, seed = 1,
  ) {
    this.detector = new Detector(world, control, rules);
    this.stewards = new Stewards(rules, traits, seed);
  }

  /**
   * Incidents are reviewed, not ruled on the spot: each goes under review
   * (on the broadcast feed) and the decision comes after the review time,
   * "no further action" included.
   */
  step(): void {
    const now = this.world.time;
    for (const v of this.detector.step()) {
      if (v.offence === 'track-limits') { this.trackLimits(v); continue; }
      this.underReview.push({ v, due: now + this.rules.reviewSeconds });
      this.world.announce(v.car, 'review', `Stewards: incident under review, #${v.car.number}${v.against ? ` and #${v.against.number}` : ''}, ${OFFENCE_NAMES[v.offence]}`, { others: [v.against] });
    }
    while (this.underReview.length && this.underReview[0].due <= now) this.apply(this.stewards.judge(this.underReview.shift()!.v));
    this.serving();
  }

  /**
   * Track limits are counted by race control as they happen, not reviewed:
   * strikes up to the grace are noted, the last of them with the
   * black-and-white flag; every one after that is a time penalty.
   */
  private trackLimits(v: Violation): void {
    const grace = this.rules.trackLimits?.strikes ?? Infinity;
    const car = v.car;
    const n = (this.strikes.get(car) ?? 0) + 1;
    this.strikes.set(car, n);
    if (n < grace) {
      this.world.announce(car, 'steward', `Race control: #${car.number}, track limits at ${v.detail} (${n} of ${grace})`);
    } else if (n === grace) {
      this.record.push({ car, time: this.world.time, offence: 'track-limits', penalty: 'warning', detail: `${n} times, last at ${v.detail}` });
      this.world.announce(car, 'steward', `Race control: #${car.number}, track limits at ${v.detail} (${n} of ${grace}): black and white flag`);
    } else {
      this.issue(car, 'track-limits', 'time', `#${car.number}: track limits at ${v.detail}, ${n} times: ${PENALTY_NAMES.time}`, `at ${v.detail}`);
    }
  }

  private apply(d: Decision): void {
    const { violation: v } = d;
    const car = v.car;
    if (car.disqualified) return;
    if (d.penalty === 'none') {
      this.world.announce(car, 'steward', `Stewards: #${car.number}, ${OFFENCE_NAMES[v.offence]}${v.against ? ` (#${v.against.number})` : ''}: no further action`, { others: [v.against], incidentTime: v.time });
      return;
    }
    // Out of the race by the time of the decision: nothing left to serve.
    if (car.retired && (d.penalty === 'drive-through' || d.penalty === 'stop-go' || d.penalty === 'tail')) return;
    let penalty = d.penalty;
    if (penalty === 'tail' && !this.control.pacing) penalty = 'drive-through'; // the caution's over: serve it on pit road
    let text = `#${car.number}: ${OFFENCE_NAMES[v.offence]}${v.against ? ` (#${v.against.number})` : ''}, ${v.detail}: ${PENALTY_NAMES[penalty]}`;
    if (penalty === 'warning') {
      const n = (this.warnings.get(car) ?? 0) + 1;
      this.warnings.set(car, n);
      text += ` (${n} of ${this.rules.warningsToDriveThrough})`;
      if (n >= this.rules.warningsToDriveThrough) {
        this.warnings.set(car, 0);
        this.issue(car, v.offence, 'warning', text, v.detail, v);
        penalty = 'drive-through';
        text = `#${car.number}: ${this.rules.warningsToDriveThrough} warnings: a drive-through`;
      }
    }
    this.issue(car, v.offence, penalty, text, v.detail, v);
  }

  /** `about`: the reviewed incident it's for (track limits are called as they happen). */
  private issue(car: Car, offence: Offence, penalty: Penalty, text: string, detail: string, about?: Violation): void {
    const { rules } = this;
    switch (penalty) {
      case 'time': car.timePenalty += rules.timePenalty; text += ` (+${rules.timePenalty} s)`; break;
      case 'tail': this.control.sendToTail(car); break;
      case 'drive-through':
      case 'stop-go': {
        const p = car.pendingPenalty;
        // Already owing one: it becomes a stop-and-go.
        const kind = p || penalty === 'stop-go' ? 'stop-go' : 'drive-through';
        car.pendingPenalty = { kind, seconds: rules.stopGoSeconds, greenLapsLeft: rules.serveWithinLaps };
        this.lapsSeen.set(car, car.lapsCompleted);
        this.owed.set(car, offence);
        break;
      }
      case 'black-flag': this.blackFlag(car); break;
    }
    this.record.push({ car, time: this.world.time, offence, penalty, detail });
    this.world.announce(car, 'steward', `Stewards: ${text}`, about ? { others: [about.against], incidentTime: about.time } : {});
  }

  private blackFlag(car: Car): void {
    car.disqualified = true;
    car.retired = true;
    car.pendingPenalty = null;
  }

  /** Penalties being served: done once the car is back out of the box; green laps run out: black flag. */
  private serving(): void {
    for (const car of this.world.cars) {
      const p = car.pendingPenalty;
      if (!p || car.retired) continue;
      if (car.pit.phase === 'out' && car.pit.call?.penalty) {
        car.pendingPenalty = null;
        this.world.announce(car, 'served', `Stewards: #${car.number} has served the ${p.kind === 'stop-go' ? 'stop-and-go' : 'drive-through'}`);
        continue;
      }
      const seen = this.lapsSeen.get(car) ?? car.lapsCompleted;
      if (car.lapsCompleted > seen) {
        this.lapsSeen.set(car, car.lapsCompleted);
        if (this.control.flag === 'green') p.greenLapsLeft--;
        if (p.greenLapsLeft < 0) {
          this.blackFlag(car);
          this.record.push({ car, time: this.world.time, offence: this.owed.get(car)!, penalty: 'black-flag', detail: 'penalty not served' });
          this.world.announce(car, 'steward', `Stewards: #${car.number} didn't serve the penalty: the black flag`);
        }
      }
    }
  }
}

import { G, PHYSICS as P } from '../sim/constants';
import type { Car } from '../sim/car';
import type { Track } from '../sim/track';
import type { World } from '../sim/world';
import { fastestLine, followRacingLine, lineAt, type RacingLine } from './racingLine';

/**
 * A scripted racer that races in traffic: the fastest line when it has the
 * road to itself, and a few habits of racecraft when it doesn't.
 *
 * - Following: no closer than a safe gap to the car ahead in its path (a
 *   car's length and a reaction time), its speed held to close it no faster.
 * - Room: door to door, a car's width and `room` to spare to the car
 *   alongside, on whichever side it is. Both cars do it, so two can go
 *   through a corner side by side. If there isn't the room, the car that's
 *   behind backs out (the one ahead holds its line).
 * - Passing: catching a car (faster by more than `pass` m/s) on a straight,
 *   with space beside it, it pulls out to the side with more road and goes
 *   for the inside of the corner coming (or past before it); on that line it
 *   drives no faster than the tighter arc allows. It doesn't start a pass in
 *   a corner, where a line beside another car can't be held.
 * - Limits: never past the line's corridor (inside the track limits), even
 *   squeezed; if there's no room, it backs off.
 *
 * A style is how it does this: how much of the grip it uses, how close to
 * the limits its line runs, how much room it leaves, how readily it passes.
 */
export interface RacerStyle {
  /** Share of the tyres' grip it drives at. */
  grip: number;
  /** How far inside the track limits its line runs (m). */
  margin: number;
  /** Room left beside a car alongside, beyond touching (m). */
  room: number;
  /** How much faster than the car ahead it must be to try a pass (m/s). */
  pass: number;
}

export const DEFAULT_STYLE: RacerStyle = { grip: 0.85, margin: 0.6, room: 0.5, pass: 1 };

/** How far (along) another car counts as alongside: door to door, overlapping by more than a little. */
const ALONGSIDE = 2 * P.CAR_RADIUS;
/** How far ahead it looks for a car in its path (m). */
const LOOKAHEAD = 60;
/** Reaction time in the following gap (s). */
const REACTION = 0.4;
/** How fast it moves across the road to a new offset (m/s). */
const CROSS_RATE = 3;
/** A stretch of road counts as straight (for starting a pass) when no tighter than this (1/m). */
const STRAIGHT = 1 / 300;
/** Off the line it tracks less precisely: this much more room kept from the corridor's edges (m). */
const OFF_LINE_BUFFER = 1;

export class TrafficRacer {
  private offset = 0;
  private lastTime = -Infinity;
  /** The side of a pass under way (+1: +d, -1: -d, 0: none): kept until the pass is done or given up. */
  private passSide = 0;
  /** What it was doing at its last decision (for looking into races). */
  last = { want: 0, offset: 0, low: 0, high: 0, follow: Infinity, squeezed: false, passing: false };
  private readonly lineFor: (track: Track) => RacingLine;

  constructor(readonly style: RacerStyle = DEFAULT_STYLE, lineFor?: (track: Track) => RacingLine) {
    this.lineFor = lineFor ?? ((track) => fastestLine(track, style.margin));
  }

  decide(car: Car, world: World): void {
    const track = world.track;
    const line = this.lineFor(track);
    const { room, pass, grip } = this.style;
    const dt = Math.min(0.2, Math.max(0, world.time - this.lastTime));
    this.lastTime = world.time;
    const L = track.length;
    const width = 2 * P.CAR_RADIUS + room;
    const vMe = car.speed;
    const here = lineAt(line, car.s);

    let want = 0; // the offset from the line it heads for
    let passing = false;
    let low = here.lo, high = here.hi; // absolute bounds on d now
    let followCap = Infinity, followAt = 0;
    let yieldTo = Infinity; // the speed of the slowest car alongside and ahead of it, to drop back behind if squeezed
    for (const other of world.cars) {
      if (other === car || other.cleared || other.waiting) continue;
      let ds = other.s - car.s;
      if (ds > L / 2) ds -= L;
      else if (ds < -L / 2) ds += L;
      if (ds < -ALONGSIDE || ds > LOOKAHEAD) continue;
      if (Math.abs(ds) < ALONGSIDE) {
        // Alongside: room on its side.
        if (other.d > car.d) high = Math.min(high, other.d - width);
        else low = Math.max(low, other.d + width);
        if (ds > 0) yieldTo = Math.min(yieldTo, other.speed);
        continue;
      }
      // Ahead: in the path it would take (the line, where that car is, plus its own offset)?
      const there = lineAt(line, other.s);
      const myD = there.d + this.offset;
      if (Math.abs(other.d - myD) >= width) continue;
      const vOther = other.retired ? 0 : other.speed;
      // Faster: by what it's doing, or would on the line there (a car it's catching on the brakes still counts).
      const faster = Math.min(vMe, there.speed) - vOther;
      const straight = Math.abs(track.curvatureAt(car.s)) < STRAIGHT && Math.abs(track.curvatureAt(other.s)) < STRAIGHT;
      // A pass under way (already pulled out) carries on into the braking zone; a new one starts only on a straight.
      if (!other.retired && faster > pass && (straight || Math.abs(this.offset) > 1)) {
        // A way past: the side it's already going (a pass under way keeps its side), else the side with more road.
        const left = there.hi - OFF_LINE_BUFFER - (other.d + width), right = (other.d - width) - (there.lo + OFF_LINE_BUFFER);
        const side = this.passSide > 0 && left > 0 ? 1 : this.passSide < 0 && right > 0 ? -1 : left > 0 || right > 0 ? (left >= right ? 1 : -1) : 0;
        if (side !== 0 && !passing) {
          // Beside it: where it is across the road, measured from the line where this car is now.
          want = (side > 0 ? other.d + width : other.d - width) - here.d;
          this.passSide = side;
          passing = true;
          continue;
        }
      }
      // Follow: no closer than the gap, closing it no faster than it can stop.
      const gap = 2 * P.CAR_RADIUS + 2 + REACTION * vMe;
      const spare = Math.max(0, ds - gap);
      const cap = Math.sqrt(vOther * vOther + 2 * 0.5 * P.TIRE_MU * G * spare);
      if (cap < followCap) { followCap = cap; followAt = ds; }
    }

    // Where it wants to be: the wanted offset, within the room the cars alongside leave (squeezed: the middle
    // of what's left) and the corridor. It gets there across the road at a crossing rate, never in a jump.
    if (!passing) this.passSide = 0;
    // Squeezed (no room between the cars alongside): hold where it is (the car behind drops back, below).
    // Off the line, or hemmed in by a car alongside, a buffer more from the corridor's edges.
    const hemmed = low > here.lo || high < here.hi;
    let target = here.d + want;
    if (low > high) target = car.d;
    else target = Math.max(low, Math.min(high, target));
    const buffer = Math.abs(target - here.d) > 0.3 || hemmed ? OFF_LINE_BUFFER : 0;
    target = Math.max(here.lo + Math.min(buffer, Math.max(0, here.d - here.lo)), Math.min(here.hi - Math.min(buffer, Math.max(0, here.hi - here.d)), target));
    const step = CROSS_RATE * dt;
    this.offset += Math.max(-step, Math.min(step, target - here.d - this.offset));
    const offset = Math.max(here.lo, Math.min(here.hi, here.d + this.offset)) - here.d;

    // Speed: off the line, no faster than its tighter arc allows (and braking for that ahead);
    // behind a car, the follow cap; squeezed, a little slower than the car beside.
    const cornerMu = P.TIRE_MU * G * grip;
    const capAt = (ahead: number) => {
      let cap = Infinity;
      if (Math.abs(offset) > 0.3) {
        for (let a = ahead; a <= ahead + 80; a += 5) {
          // A path beside the line, `offset` across: curvature k / (1 - k offset), tighter on the inside.
          const k = lineAt(line, car.s + a).kappa;
          const arc = Math.abs(k / Math.max(0.2, 1 - k * offset));
          const limit = arc > 1e-6 ? Math.sqrt(cornerMu / arc) : Infinity;
          cap = Math.min(cap, Math.sqrt(limit * limit + 2 * 0.8 * cornerMu * (a - ahead)));
        }
      }
      if (followCap < Infinity && ahead <= followAt) cap = Math.min(cap, followCap);
      if (low > high && yieldTo < Infinity) cap = Math.min(cap, Math.max(5, yieldTo - 4));
      return cap;
    };
    this.last = { want, offset, low, high, follow: followCap, squeezed: low > high, passing };
    followRacingLine(car, world, line, grip, offset, capAt);
  }
}

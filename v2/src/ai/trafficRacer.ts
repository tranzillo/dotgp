import { G, PHYSICS as P } from '../sim/constants';
import type { Car } from '../sim/car';
import type { Track } from '../sim/track';
import type { World } from '../sim/world';
import { FormationDriver, formationTraits, type FormationTraits } from './formation';
import { SmoothFormation } from './smoothFormation';
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
  /**
   * How hard the car ahead might slow that it leaves room for (m/s^2): the room a follower needs is what it loses
   * while it reacts and then out-brakes the car ahead. Insuring against a lift (~1-2 m/s^2) it runs nose to tail in
   * the draft, as oval packs do; against full braking it hangs back a reaction time's worth of speed. A driver's nerve.
   * Unset: room for the car ahead stopping as hard as it can (a reaction time at its speed), as on road circuits.
   */
  insure?: number;
  /**
   * Racing, how hard it drives toward the line's speed when below it (1/s), in proportion; unset, flat out. On ovals
   * (speeds nearly constant) proportional is what a student copies best (lab 2026-10-21); on circuits it made the
   * teacher harder to copy on unseen circuits (81% -> 67% of its answers explained, 2026-10-22): out of a slow corner
   * a proportional racer trails the line's speed by an amount that depends on its recent past, which a student can't
   * see, while flat out is a rule it can. So oval teachers set it and road teachers don't.
   */
  driveGain?: number;
  /**
   * Cautions driven by the smooth formation (src/ai/smoothFormation.ts: the formation's intent without its jumps, so
   * a student can copy it), as the oval stable's teachers do. Unset: the formation script, with its own following.
   */
  smoothCautions?: boolean;
  /**
   * How fast its foot moves (the longitudinal command, throttle to brake, per second): from where the car's pedal is
   * now toward what it wants, no faster. Unset: at once. Behind another car or under caution an instant pedal flicks
   * between flat out and braking on the smallest change, and a student can't copy that from anything it sees (road
   * classroom races: a 64-64 network given the car in its path and its place in the safety-car line explained about
   * a third of the teacher's throttle); its own last command, which a student does see, is where a real foot starts.
   */
  pedalRate?: number;
  /** Behind a car: close on the speed it allows in proportion (1/s), not flat out then braking (followRacingLine's capGain). Unset: as the line. */
  followGain?: number;
  /** Under caution (smooth cautions): how hard it drives toward and brakes to its speed (1/s). Unset: the smooth formation's own. */
  cautionGain?: number;
}

/**
 * Room lost following a car that starts slowing at `lead` m/s^2, reacting after `reaction` s and then braking at
 * `brake` m/s^2, both at `v` to begin with: until the follower is no faster (or the car ahead has stopped).
 */
export function followLoss(v: number, reaction: number, lead: number, brake: number): number {
  const stopAll = v * reaction + (v * v) / (2 * brake) - (v * v) / (2 * lead); // the car ahead stops first
  if (lead >= brake) return stopAll;
  const level = reaction + (lead * reaction) / (brake - lead); // when the follower's speed is down to the leader's
  if (level * lead >= v) return stopAll;
  return 0.5 * lead * reaction * reaction + (lead * reaction) ** 2 / (2 * (brake - lead));
}

export const DEFAULT_STYLE: RacerStyle = { grip: 0.85, margin: 0.6, room: 0.5, pass: 1 };

/** How close to the track limits a racer's line may run (m): a few steps, so a field shares a few lines. */
const MARGINS = [1.0, 0.8, 0.6, 0.4];
/** The deceleration of the car ahead the boldest racer insures against (m/s^2): a lift. */
const BOLD_INSURE = 1.5;

/**
 * A racer's way of racing from who it is: nerve (0 timid, 1 fearless) and talent (0-1). Nerve sets how much of
 * the car ahead's braking it leaves room for (full braking to a lift, so the bold run nose to tail in the draft),
 * how much room it leaves beside a car, how small an edge it pulls out to pass with, how near the limits its line
 * runs, and its caution manners (reaction, gap, eagerness). Talent is how much of the tyres' grip it can use: a
 * spread of a couple of percent in lap time, as in a real field. The rest is individual.
 */
export function racerStyle(nerve: number, talent: number, random: () => number): { style: RacerStyle; traits: FormationTraits } {
  const brake = 0.5 * P.TIRE_MU * G;
  const line = Math.min(MARGINS.length - 1, Math.floor((0.5 * nerve + 0.5 * random()) * MARGINS.length));
  return {
    style: {
      grip: 0.82 + 0.08 * talent,
      margin: MARGINS[line],
      room: 1.0 - 0.8 * nerve,
      pass: 2.0 - 1.5 * nerve,
      insure: brake * Math.pow(BOLD_INSURE / brake, nerve),
      driveGain: OVAL_DRIVE_GAIN,
      smoothCautions: true,
    },
    traits: formationTraits(nerve, random),
  };
}

/** How far (along) another car counts as alongside: door to door, overlapping by more than a little. */
/** (Asked each time: the car's size can be an experiment's.) */
const alongside = () => 2 * P.CAR_RADIUS;
/**
 * How hard it drives toward its speed under caution when below it (1/s): in proportion, as the formation brakes
 * above it, not flat out. A teacher's throttle has to be one a student can copy: one flicking between full throttle
 * and the brakes at caution speeds is learned as its average, coasting where it should brake.
 */
const CAUTION_DRIVE_GAIN = 6;
/** The same for racing, on ovals (the oval stable's teachers): see RacerStyle.driveGain. */
export const OVAL_DRIVE_GAIN = 4;
/**
 * How far ahead it looks for a car in its path (m): at least this, and as far as it takes to stop from its speed at
 * the following brake (plus a reaction). At 55 m/s on a circuit straight, 60 m was 1.1 s: a car slowing for pit
 * road came into view too late to brake for (circuits: the commonest teacher crash).
 */
const LOOKAHEAD = 60;
const lookahead = (v: number) => Math.max(LOOKAHEAD, v * REACTION + (v * v) / (2 * 0.5 * P.TIRE_MU * G));
/** Steps along its path (m) where it checks whether it will come to a slower car ahead before catching it. */
const CATCH_STEP = 10;
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

  /**
   * Cautions and restarts: where to be comes from the formation (its place in line, giving way, round wrecks), how
   * fast from its own following, the same as under green but insuring against the car ahead braking as hard as it
   * can: under a caution the car ahead is about to check up, and it can't know how hard.
   */
  private readonly formation: FormationDriver;
  private readonly smooth: SmoothFormation | null;
  /** Whether race control had the field pacing at its last look, and when that last changed (it reacts in its own time). */
  private flagPacing: boolean | null = null;
  private flagChangedAt = -Infinity;

  constructor(readonly style: RacerStyle = DEFAULT_STYLE, lineFor?: (track: Track) => RacingLine, traits?: FormationTraits) {
    this.lineFor = lineFor ?? ((track) => fastestLine(track, style.margin));
    // Under caution it drives toward its speed smoothly (as it brakes above it), not flat out below it: a teacher's
    // throttle has to be one a student can copy.
    this.formation = new FormationDriver(traits, (car, world, lane) => this.cautionCap(car, world, lane), CAUTION_DRIVE_GAIN);
    this.smooth = style.smoothCautions ? new SmoothFormation((car) => this.formation.traitsFor(car), style.cautionGain) : null;
  }

  /** Under a caution (once it has reacted to the flag, and until it has reacted to the green): the formation's. */
  private inFormation(car: Car, world: World): boolean {
    const ctl = world.control;
    if (!ctl) return false;
    const pacing = ctl.pacing;
    if (this.flagPacing === null) this.flagPacing = pacing;
    else if (pacing !== this.flagPacing) { this.flagPacing = pacing; this.flagChangedAt = world.time; }
    if (car.finished || car.pit.phase !== 'none') return false;
    const reacted = world.time - this.flagChangedAt >= this.formation.traitsFor(car).reaction;
    return pacing ? reacted : !reacted;
  }

  /**
   * The fastest it will go heading for `lane` under a caution: able to stop behind the car ahead in its file (the
   * formation's, the pace car included) even if that car stops as hard as it can. The formation's own following
   * plans on the car ahead holding its speed, which is just what it doesn't do when the caution comes out.
   */
  private cautionCap(car: Car, world: World, lane: number): number {
    const ctl = world.control;
    if (!ctl) return Infinity;
    const brake = 0.5 * P.TIRE_MU * G;
    const gapBehind = (other: Car) => 2 * P.CAR_RADIUS + this.formation.traitsFor(car).followGap
      // A car heading for pit road brakes hard for it: room for full braking (circuits' safety cars: cars at 40 m/s
      // ran into pitters slowing for pit road before the pickup).
      + followLoss(car.speed, REACTION, other.pit.phase === 'in' ? P.TIRE_MU * G : brake, brake);
    // A wreck the lane it's heading for clears (it's going round it) isn't the car ahead: stopping behind it, it
    // couldn't steer round it, and the whole line would queue behind. The next car ahead in the file is.
    const clears = (o: Car) => o.retired && Math.abs(o.d - lane) >= 2 * P.CAR_RADIUS + 0.3;
    let cap = Infinity;
    for (const other of [...world.cars, ...(ctl.paceCarOut ? [ctl.paceCar] : [])]) {
      if (other === car || other.cleared || clears(other)) continue;
      if (Math.abs(other.d - lane) > 2.6 && Math.abs(other.d - car.d) > 2.6) continue; // the formation's file
      const ds = world.track.distanceFrom(car.s, other.s);
      if (ds <= 0 || ds > 220) continue;
      const vOther = other.retired ? 0 : other.speed;
      cap = Math.min(cap, Math.sqrt(vOther * vOther + 2 * brake * Math.max(0, ds - gapBehind(other))));
    }
    return cap;
  }

  /**
   * Plan from where the car really is: its offset from the line now, not the one it was heading for. A teacher
   * labelling someone else's driving (a student at the wheel, or its own hands shaken) must answer "what to do from
   * here"; left to itself its offset follows its own plan wherever the car goes, and its labels answer a car that
   * isn't there, which no student can learn from what it sees.
   */
  takeOver(car: Car, world: World): void {
    this.offset = car.d - lineAt(this.lineFor(world.track), car.s).d;
  }

  decide(car: Car, world: World): void {
    const pedal = car.inputX;
    this.drive(car, world);
    const rate = this.style.pedalRate;
    if (rate !== undefined) {
      const step = rate * P.CONTROL_EVERY * P.DT;
      car.inputX = pedal + Math.max(-step, Math.min(step, car.inputX - pedal));
    }
  }

  private drive(car: Car, world: World): void {
    if (this.inFormation(car, world)) {
      if (this.smooth && world.control?.flag !== 'grid') this.smooth.decide(car, world);
      else this.formation.decide(car, world);
      return;
    }
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
    const reach = lookahead(vMe);
    for (const other of world.cars) {
      if (other === car || other.cleared || other.waiting) continue;
      let ds = other.s - car.s;
      if (ds > L / 2) ds -= L;
      else if (ds < -L / 2) ds += L;
      if (ds > reach) continue;
      if (ds <= -alongside()) {
        // Behind: a car coming up a lane over is as good as alongside if it will be there before this car could
        // be across into its lane ("car outside!"), so it isn't moved over on.
        const closing = other.speed - vMe;
        const across = width / CROSS_RATE;
        if (other.retired || closing <= 0 || -ds - alongside() > closing * across) continue;
        if (Math.abs(other.d - car.d) < width) continue; // in its own lane: it's the car behind, its to follow
        if (other.d > car.d) high = Math.min(high, other.d - width);
        else low = Math.max(low, other.d + width);
        continue;
      }
      if (Math.abs(ds) < alongside()) {
        // Alongside: room on its side.
        if (other.d > car.d) high = Math.min(high, other.d - width);
        else low = Math.max(low, other.d + width);
        if (ds > 0) yieldTo = Math.min(yieldTo, other.speed);
        continue;
      }
      // Ahead: in the path it would take (the line, where that car is, plus its own offset)?
      const there = lineAt(line, other.s);
      const myD = there.d + this.offset;
      // A car heading for pit road, still on the racing surface, is crossing to the pit side (inside): anywhere on
      // that side of it is in its way, and it isn't passed there. (Circuit pit entries cut across the line into the
      // corner before them, and cars turning in for the apex ran into pitters sliding over in front of them.)
      const pitting = other.pit.phase === 'in' && other.d < track.innerEdge(other.trackIdx) + P.CAR_RADIUS;
      const vOther = other.retired ? 0 : other.speed;
      // A slower car is in the way wherever this car's path comes to it before it catches it, not just where the
      // path is beside it now: the line swings across to an apex, and a slow car already there (a pitter on the
      // inside) was only seen once the line reached it, too close to stop.
      let inWay = Math.abs(other.d - myD) < width || (pitting && myD > other.d);
      const closing = vMe - vOther;
      if (!inWay && closing > 0) {
        const caught = Math.min(reach, (Math.max(0, ds) / closing) * vOther);
        for (let a = CATCH_STEP; a <= caught + CATCH_STEP / 2 && !inWay; a += CATCH_STEP) {
          inWay = Math.abs(other.d - (lineAt(line, other.s + Math.min(a, caught)).d + this.offset)) < width;
        }
      }
      if (!inWay) continue;
      // Faster: by what it's doing, or would on the line there (a car it's catching on the brakes still counts).
      const faster = Math.min(vMe, there.speed) - vOther;
      const straight = Math.abs(track.curvatureAt(car.s)) < STRAIGHT && Math.abs(track.curvatureAt(other.s)) < STRAIGHT;
      // A pass under way (already pulled out) carries on into the braking zone; a new one starts only on a straight.
      if (!other.retired && faster > pass && (straight || Math.abs(this.offset) > 1)) {
        // A way past: the side it's already going (a pass under way keeps its side), else the side with more road.
        const left = pitting ? -1 : there.hi - OFF_LINE_BUFFER - (other.d + width), right = (other.d - width) - (there.lo + OFF_LINE_BUFFER);
        const side = this.passSide > 0 && left > 0 ? 1 : this.passSide < 0 && right > 0 ? -1 : left > 0 || right > 0 ? (left >= right ? 1 : -1) : 0;
        if (side !== 0 && !passing) {
          // Beside it: where it is across the road, measured from the line where this car is now.
          want = (side > 0 ? other.d + width : other.d - width) - here.d;
          this.passSide = side;
          passing = true;
          // Beside it, it's not in the way; still behind it, it is, however the pass was meant to go. On banking at
          // speed a passer barely moves across (its grip is the turn's), and one that stopped minding the car it
          // meant to pass ran into it (cars braking hard for pit road: most of a generated superspeedway's wrecks).
          if (Math.abs(other.d - car.d) >= width) continue;
        }
      }
      // Follow: no closer than the gap, closing it no faster than it can stop.
      const brake = 0.5 * P.TIRE_MU * G;
      // A car heading for pit road is about to brake hard, and shows it (down to the apron): room for that, full
      // braking. (Before, it got the reaction gap, which plans on the car ahead braking no harder than this one's
      // own following brake: under a safety car on circuits, cars at 40 m/s ran into pitters slowing for pit road.)
      const insure = other.pit.phase === 'in' ? P.TIRE_MU * G : this.style.insure;
      const gap = 2 * P.CAR_RADIUS + 2 + (insure === undefined ? REACTION * vMe : followLoss(vMe, REACTION, insure, brake));
      const spare = Math.max(0, ds - gap);
      const cap = Math.sqrt(vOther * vOther + 2 * brake * spare);
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
          // A path beside the line, `offset` across: curvature k / (1 - k offset), tighter on the inside. The
          // banking there carries the car round as on the line (the banked curve's limit, as the line's profile has
          // it): flat-ground grip alone held an oval's banked turns to a crawl beside the line.
          const at = lineAt(line, car.s + a), k = at.kappa;
          const arc = Math.abs(k / Math.max(0.2, 1 - k * offset));
          const bank = Math.sign(k) * track.bankAt(track.indexAt(car.s + a), at.d + offset);
          const c = Math.cos(bank), sn = Math.sin(bank), mu = P.TIRE_MU * grip;
          const limit = arc > 1e-6 ? Math.sqrt((G * (sn + mu * c)) / Math.max(0.05, c - mu * sn) / arc) : Infinity;
          cap = Math.min(cap, Math.sqrt(limit * limit + 2 * 0.8 * cornerMu * (a - ahead)));
        }
      }
      if (followCap < Infinity && ahead <= followAt) cap = Math.min(cap, followCap);
      if (low > high && yieldTo < Infinity) cap = Math.min(cap, Math.max(5, yieldTo - 4));
      return cap;
    };
    this.last = { want, offset, low, high, follow: followCap, squeezed: low > high, passing };
    followRacingLine(car, world, line, grip, offset, capAt, this.style.driveGain, this.style.followGain);
  }
}

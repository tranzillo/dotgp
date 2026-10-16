/**
 * The rules of a discipline, as data. A rulebook says what counts as an
 * offence and what each one usually costs; detection (detect.ts) finds them
 * in the sim, stewards (stewards.ts) judge them, the desk (desk.ts) enforces.
 * Other disciplines (road courses, GP, rally) are other rulebooks, not other
 * code paths.
 */

/** What a car can be reported for. */
export type Offence =
  /** Over the pit road speed limit. */
  | 'pit-speeding'
  /** Under caution, still ahead of a car it was told to line up behind, a lap after being told. */
  | 'passing-under-caution'
  /** At a restart, gained places before the green (ahead of cars it should have been behind). */
  | 'jumped-restart'
  /** Made a pass using the apron: below the line (all four wheels) for much of the move. */
  | 'passing-below-the-line'
  /** Crossed onto the racing surface before the end of the pit exit blend line. */
  | 'blend-line'
  /** Hit another car, mostly at fault, and hurt it. */
  | 'avoidable-contact';

/** What a steward can hand out, mildest first. */
export type Penalty =
  | 'none'
  | 'warning'
  /** Seconds added to the race time. */
  | 'time'
  /** Back of the line (under caution). */
  | 'tail'
  /** Down pit road and out again, within a few green laps. */
  | 'drive-through'
  /** Down pit road, a stop in the box for some seconds, out again. */
  | 'stop-go'
  /** Out of the race. */
  | 'black-flag';

/**
 * How a race starts. Rolling: the field forms up behind the pace car and
 * takes the green at the line (ovals). Standing: from a staggered grid behind
 * the line, after a formation lap, when the start lights go out (circuits).
 */
export type StartProcedure =
  | { kind: 'rolling' }
  | {
    kind: 'standing';
    formationLap: boolean;
    /** Metres between grid boxes (each car its own row, staggered left and right). */
    gridPitch: number;
    /** Red lights, one more every lightInterval seconds; all of them stay on for a random hold, then go out. */
    lights: number;
    lightInterval: number;
    hold: [number, number];
  };

/** How an offence is usually punished, by how bad it was (0 marginal .. 1 flagrant). */
export interface OffenceRule {
  /** Penalties for increasing severity: severity below thresholds[i] gets penalties[i], above all the last. */
  thresholds: number[];
  penalties: Penalty[];
}

export interface Rulebook {
  name: string;
  start: StartProcedure;
  /**
   * How a race is neutralised for a wreck. Pace car (ovals): constant pace
   * speed, single file, doubled up for the restart. Safety car (circuits): it
   * drives the track (quick on the straights, slow through corners), single
   * file throughout, restarts single file.
   */
  neutralise: 'pace-car' | 'safety-car';
  offences: Record<Offence, OffenceRule>;
  /** Seconds a 'time' penalty adds, and how long a 'stop-go' stops for. */
  timePenalty: number;
  stopGoSeconds: number;
  /** Green-flag laps a car has to serve a drive-through or stop-go before the black flag. */
  serveWithinLaps: number;
  /** Warnings that add up to a drive-through. */
  warningsToDriveThrough: number;
  /** Pit road speed limit tolerance (m/s over) and how long over before it counts (s). */
  pitSpeedTolerance: number;
  pitSpeedGrace: number;
  /** Seconds the stewards take to review an incident before they announce a decision. */
  reviewSeconds: number;
  /** Track size classes where the apron is out of bounds for passing (the line rule). */
  belowTheLineOn: string[];
}

/** Stock car rules for ovals. */
export const OVAL_RULES: Rulebook = {
  name: 'Oval',
  start: { kind: 'rolling' },
  neutralise: 'pace-car',
  offences: {
    'pit-speeding': { thresholds: [0.15, 0.6], penalties: ['warning', 'drive-through', 'stop-go'] },
    'passing-under-caution': { thresholds: [0.2], penalties: ['warning', 'tail'] },
    // Severity: places gained before the green (half per place).
    'jumped-restart': { thresholds: [0.25], penalties: ['none', 'drive-through'] },
    // Severity: share of the move made below the line; less than half of it gets the benefit of the doubt.
    'passing-below-the-line': { thresholds: [0.5], penalties: ['none', 'drive-through'] },
    'blend-line': { thresholds: [0.3], penalties: ['warning', 'drive-through'] },
    'avoidable-contact': { thresholds: [0.25, 0.5, 0.85], penalties: ['warning', 'time', 'drive-through', 'black-flag'] },
  },
  timePenalty: 5,
  stopGoSeconds: 10,
  serveWithinLaps: 3,
  warningsToDriveThrough: 3,
  pitSpeedTolerance: 0.5,
  pitSpeedGrace: 0.3,
  reviewSeconds: 10,
  // As in NASCAR: the out-of-bounds line is a superspeedway rule; elsewhere the apron is just slow.
  belowTheLineOn: ['superspeedway'],
};

/**
 * Road circuit rules: standing start after a formation lap, the safety car.
 * The line rule is an oval thing; everything else carries over.
 */
export const CIRCUIT_RULES: Rulebook = {
  ...OVAL_RULES,
  name: 'Circuit',
  start: { kind: 'standing', formationLap: true, gridPitch: 8, lights: 5, lightInterval: 1, hold: [0.2, 3] },
  neutralise: 'safety-car',
  belowTheLineOn: [],
};

/** The rulebook a track races to. */
export function rulebookFor(trackType: string): Rulebook {
  return trackType === 'circuit' ? CIRCUIT_RULES : OVAL_RULES;
}

export const OFFENCE_NAMES: Record<Offence, string> = {
  'pit-speeding': 'speeding on pit road',
  'passing-under-caution': 'passing under caution',
  'jumped-restart': 'jumping the restart',
  'passing-below-the-line': 'passing below the line',
  'blend-line': 'crossing the blend line',
  'avoidable-contact': 'avoidable contact',
};

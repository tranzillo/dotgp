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
  /** Gained a place in line under caution (past a car still keeping pace). */
  | 'passing-under-caution'
  /** Passed before the start/finish line at a start or restart. */
  | 'jumped-restart'
  /** Below the line: completed a pass with all four wheels on the apron. */
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

/** How an offence is usually punished, by how bad it was (0 marginal .. 1 flagrant). */
export interface OffenceRule {
  /** Penalties for increasing severity: severity below thresholds[i] gets penalties[i], above all the last. */
  thresholds: number[];
  penalties: Penalty[];
}

export interface Rulebook {
  name: string;
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
}

/** Stock car rules for ovals. */
export const OVAL_RULES: Rulebook = {
  name: 'Oval',
  offences: {
    'pit-speeding': { thresholds: [0.15, 0.6], penalties: ['warning', 'drive-through', 'stop-go'] },
    'passing-under-caution': { thresholds: [0.2], penalties: ['warning', 'tail'] },
    'jumped-restart': { thresholds: [0.3], penalties: ['warning', 'drive-through'] },
    'passing-below-the-line': { thresholds: [0.5], penalties: ['drive-through', 'drive-through'] },
    'blend-line': { thresholds: [0.3], penalties: ['warning', 'drive-through'] },
    'avoidable-contact': { thresholds: [0.25, 0.5, 0.85], penalties: ['warning', 'time', 'drive-through', 'black-flag'] },
  },
  timePenalty: 5,
  stopGoSeconds: 10,
  serveWithinLaps: 3,
  warningsToDriveThrough: 3,
  pitSpeedTolerance: 0.5,
  pitSpeedGrace: 0.3,
};

export const OFFENCE_NAMES: Record<Offence, string> = {
  'pit-speeding': 'speeding on pit road',
  'passing-under-caution': 'passing under caution',
  'jumped-restart': 'jumping the restart',
  'passing-below-the-line': 'passing below the line',
  'blend-line': 'crossing the blend line',
  'avoidable-contact': 'avoidable contact',
};

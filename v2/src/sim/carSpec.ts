import { PHYSICS as P } from './constants';
import { EXPERIMENT } from './experiment';

/** What the car physics needs to know of a track to pick a car's package. */
interface PackageTrack { kind: string; length: number; n: number; bankAt: (i: number, d: number) => number }

/**
 * A kind of car: its mass, and per track its engine package (power, drag)
 * and its downforce. The classic car is the one the sim has always raced
 * (PHYSICS's numbers, no downforce); a NASCAR Cup car (Next Gen, ?spec=cup)
 * is calibrated against real pole laps (scripts/calibrate.ts).
 */
export interface CarSpec {
  name: string;
  /** Without fuel, with the driver (kg). */
  dryMass: number;
  /** Engine power (W) and drag area (m^2) at a track: its package. */
  power: (track: PackageTrack) => number;
  cda: (track: PackageTrack) => number;
  /** Downforce area (m^2): downforce 0.5 rho ClA v^2, pressing the tires down. */
  cla: (track: PackageTrack) => number;
  /** Its tires' grip, as a share of PHYSICS.TIRE_MU. */
  grip: number;
}

export const CLASSIC_CAR: CarSpec = {
  name: 'classic', dryMass: P.DRY_MASS, power: () => P.ENGINE_POWER, cda: () => P.CDA, cla: () => 0, grip: 1,
};

/**
 * Ovals this long (m) and banked this steeply (rad, somewhere) race a superspeedway package: Daytona and Talladega,
 * not Indianapolis (9 degrees) or Michigan (18).
 */
const SUPERSPEEDWAY_LENGTH = 3200, SUPERSPEEDWAY_BANK = (20 * Math.PI) / 180;
const superspeedways = new WeakMap<PackageTrack, boolean>();
function superspeedway(t: PackageTrack): boolean {
  let is = superspeedways.get(t);
  if (is === undefined) {
    is = false;
    for (let i = 0; i < t.n && !is && t.kind !== 'road' && t.length >= SUPERSPEEDWAY_LENGTH; i += 20) is = t.bankAt(i, 0) >= SUPERSPEEDWAY_BANK;
    superspeedways.set(t, is);
  }
  return is;
}

/**
 * NASCAR's Next Gen Cup car: 3,400 lb plus the driver; 670 hp, or 510 hp with
 * the superspeedways' tapered spacer and its bigger spoiler. Drag and
 * downforce, and its tires' grip, are fitted to the real tracks' pole laps (CUP_FIT).
 */
export const CUP_CAR: CarSpec = {
  name: 'cup', dryMass: 1625,
  power: (t) => (superspeedway(t) ? 380_000 : 500_000),
  cda: (t) => (superspeedway(t) ? CUP_FIT.cdaSuper : CUP_FIT.cda),
  cla: (t) => (superspeedway(t) ? CUP_FIT.claSuper : CUP_FIT.cla),
  get grip() { return CUP_FIT.grip; },
};

/**
 * The Cup car's fitted numbers (mutable: scripts/calibrate.ts --fit searches them), 2026-10-24: best laps within 0.4%
 * of the superspeedway poles, 2-3% slow at Indianapolis and Michigan, 4-6% fast on the steep banks of Charlotte and
 * Bristol, 7% slow at flat Martinsville (tires that grip less as the load on them grows would close that pattern).
 * Effective numbers: the drag areas stand in for drivetrain losses as well.
 */
export const CUP_FIT = { cda: 1.52, cdaSuper: 1.27, cla: 4.0, claSuper: 4.0, grip: 1.0 };

/** The car in use: the classic, or the experiment's (?spec=cup). */
export function carSpec(): CarSpec {
  return EXPERIMENT.spec === 'cup' ? CUP_CAR : CLASSIC_CAR;
}

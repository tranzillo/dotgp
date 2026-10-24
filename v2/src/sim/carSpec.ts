import { G, PHYSICS as P } from './constants';
import { EXPERIMENT } from './experiment';

/** What the car physics needs to know of a track to pick a car's package. */
interface PackageTrack { kind: string; length: number; n: number; bankAt: (i: number, d: number) => number }

/**
 * A kind of car: its mass, and per track its engine package (power, drag)
 * and its downforce. The classic car is the one the sim has always raced
 * (PHYSICS's numbers, no downforce); a NASCAR Cup car (Next Gen, ?spec=cup)
 * and a Formula 1 car (2024, ?spec=f1) are calibrated against real pole laps
 * (scripts/calibrate.ts); ?spec=series races each in its own series, the Cup
 * car on ovals and the F1 car on road circuits.
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
  /** Its tires' grip, as a share of PHYSICS.TIRE_MU, at 1 g of load. */
  grip: number;
  /** ...and how it falls as the load grows: grip x (load / g)^-loadSensitivity (0: not at all). */
  loadSensitivity: number;
  /** The share of the tires' grip that can drive the car (the driven wheels' share of the load: about half on a car driven by its rear wheels; 1: all). */
  driveShare: number;
}

export const CLASSIC_CAR: CarSpec = {
  name: 'classic', dryMass: P.DRY_MASS, power: () => P.ENGINE_POWER, cda: () => P.CDA, cla: () => 0, grip: 1, loadSensitivity: 0, driveShare: 1,
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
  get loadSensitivity() { return CUP_FIT.loadSensitivity; },
  // (Rear-wheel drive: half the weight on the rear wheels at rest, more as it moves back under acceleration.)
  driveShare: 0.7,
};

/**
 * The Cup car's fitted numbers (mutable: scripts/calibrate.ts --fit searches them), 2026-10-24: best laps within 1.9%
 * of all seven ovals' poles (Daytona, Talladega, Indianapolis, Michigan, Charlotte, Bristol, Martinsville). Tires that
 * grip less as the load on them grows put the steep banks and the flat paperclip in line. Effective numbers: the
 * drag areas stand in for drivetrain losses as well.
 */
export const CUP_FIT = { cda: 1.33, cdaSuper: 1.359, cla: 3.857, claSuper: 3.857, grip: 1.3, loadSensitivity: 0.25 };

/**
 * A 2024 Formula 1 car: 798 kg with the driver, about 1,000 hp from the power unit (700 kW at the wheels), its
 * drag, downforce and tires fitted to the real circuits' pole laps (F1_FIT).
 */
export const F1_CAR: CarSpec = {
  name: 'f1', dryMass: 805,
  power: () => 700_000,
  cda: () => F1_FIT.cda,
  cla: () => F1_FIT.cla,
  get grip() { return F1_FIT.grip; },
  get loadSensitivity() { return F1_FIT.loadSensitivity; },
  // (Rear-wheel drive: a little over half the weight and downforce on the rear wheels, more under acceleration.)
  driveShare: 0.7,
};

/** The F1 car's fitted numbers (mutable: scripts/calibrate.ts --f1 --fit searches them). */
export const F1_FIT = { cda: 1.1, cla: 4.5, grip: 1.6, loadSensitivity: 0.2 };

/** The car in use at a track: the classic, or the experiment's (?spec=cup, f1, or series: by the kind of track). */
export function carSpec(track?: PackageTrack): CarSpec {
  switch (EXPERIMENT.spec) {
    case 'cup': return CUP_CAR;
    case 'f1': return F1_CAR;
    case 'series': return track?.kind === 'road' ? F1_CAR : CUP_CAR;
    default: return CLASSIC_CAR;
  }
}

/**
 * The fastest a car can take a turn of curvature k (1/m) on banking `bank` (rad, leaning into the turn), its tires
 * gripping `mu` (TIRE_MU with the surface and wear; the spec's own grip is applied here), at mass m: with its downforce
 * (which grows with speed) and tires that grip less under more load, as the racing line has it. The classic car's is
 * the plain banked-curve limit.
 */
export function cornerSpeed(spec: CarSpec, track: PackageTrack, mu: number, k: number, bank: number, mass: number, top = 105): number {
  const ak = Math.abs(k);
  if (ak < 1e-6) return top;
  const c = Math.cos(bank), sn = Math.sin(bank), m0 = mu * spec.grip;
  const q = (0.5 * P.AIR_DENSITY * spec.cla(track)) / mass;
  if (spec.loadSensitivity === 0) {
    const cap = (G * (sn + m0 * c)) / Math.max(0.05, c - m0 * sn);
    const aero = (q * m0) / Math.max(0.05, c - m0 * sn);
    return ak > aero ? Math.min(top, Math.sqrt(cap / (ak - aero))) : top;
  }
  const lat = (v: number) => {
    const down = q * v * v, load = (G + down * c) / Math.max(0.05, c - m0 * sn);
    const m = m0 * Math.pow(Math.max(0.3, load / G), -spec.loadSensitivity);
    return ((G + down * c) * (sn + m * c)) / Math.max(0.05, c - m * sn) - down * sn;
  };
  // (Bisection up to the top speed, or 150 m/s if there's none.)
  const most = Number.isFinite(top) ? top : 150;
  if (ak * most * most <= lat(most)) return most;
  let lo = 0, hi = most;
  for (let it = 0; it < 18; it++) { const v = (lo + hi) / 2; if (ak * v * v <= lat(v)) lo = v; else hi = v; }
  return lo;
}

/** The braking the tires give at speed v (m/s^2), gripping `mu` (TIRE_MU with surface and wear), at mass m: downforce adds load, load sensitivity takes some back. */
export function brakingAt(spec: CarSpec, track: PackageTrack, mu: number, v: number, mass: number): number {
  const load = 1 + (0.5 * P.AIR_DENSITY * spec.cla(track) * v * v) / mass / G;
  return mu * spec.grip * Math.pow(load, -spec.loadSensitivity) * load * G;
}

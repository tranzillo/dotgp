/**
 * Injuries. A race's hardest single hit can hurt the driver, not just the
 * car: the harder the hit, the likelier, and the worse. A hurt driver sits
 * out races while they recover (an academy driver takes the seat); the
 * hardest hits can end a career. Fault doesn't come into it: being hit hurts
 * as much as hitting. This is what makes a driver's nerve matter beyond the
 * result of one race.
 *
 * Calibrated on today's fields (24 cars): about 8% of drivers are hurt in a
 * race (two a race), and a career ends every five or six races. Cleaner
 * drivers mean fewer.
 */

export type InjurySeverity = 'minor' | 'serious' | 'career';

export interface Injury {
  severity: InjurySeverity;
  /** Races to sit out (0 for a career-ending injury: there's no coming back). */
  races: number;
}

/** Below this much health lost in one hit nobody gets hurt. */
export const SAFE_HIT = 0.4;
/** Chance of injury rises with the hit past SAFE_HIT, to at most MAX_CHANCE. */
const CHANCE_SLOPE = 1 / 1.6;
const MAX_CHANCE = 0.4;
/** Hits this hard (health lost) are serious; a car destroyed in one hit may end a career. */
const SERIOUS_HIT = 0.8;
const CAREER_HIT = 1;
const CAREER_CHANCE = 0.1;

/** Roll for an injury from the hardest hit a driver took (health lost in one impact). */
export function injuryFrom(hit: number, random: () => number): Injury | null {
  const chance = Math.min(MAX_CHANCE, Math.max(0, (hit - SAFE_HIT) * CHANCE_SLOPE));
  if (random() >= chance) return null;
  if (hit >= CAREER_HIT && random() < CAREER_CHANCE) return { severity: 'career', races: 0 };
  if (hit >= SERIOUS_HIT) return { severity: 'serious', races: 3 + Math.floor(random() * 4) };
  return { severity: 'minor', races: 1 + Math.floor(random() * 2) };
}

import { EXPERIMENT } from './experiment';

/**
 * The second damage model (?damage=2), against the first (constants.ts's DAMAGE_* numbers alone):
 *
 * - Light contact is free: rubbing, bumping and brushing the wall (impacts under FREE_IMPACT, and scraping) cost
 *   speed and tyres, as the physics has it, but no health. Under the first model it wore cars down until the next
 *   real hit finished them (most cars wrecked were under 0.3 health before the hit that did it), and the clean
 *   teachers' wall scrapes made nearly half their pit stops repairs.
 * - A car loses pace as it nears a wreck: below SOUND_ABOVE health it's compromised, and power and grip fall away
 *   to a crawl at zero, where it's out (a hard enough hit still wrecks it outright). Under the first model a car
 *   raced as normal until it failed, on the racing line at speed: a caution and a wrecker.
 * - A compromised car smokes, thicker the worse it is: everyone can see it (drivers, spotters, the crew, viewers),
 *   it heads low and comes in, and the field goes round it.
 */
export const DAMAGE2 = {
  /** Normal impact speed below which contact costs no health (m/s; the first model's threshold is 4). */
  FREE_IMPACT: 6,
  /** Health above which a car is sound: no lost pace, no smoke. */
  SOUND_ABOVE: 0.5,
  /** At health zero: the share of the engine's power left (a crawl: about a third of top speed) ... */
  POWER_LEFT: 0.04,
  /** ... and of the tyres' grip. */
  GRIP_LEFT: 0.6,
};

/** The second damage model in force. */
export const damage2 = (): boolean => EXPERIMENT.damage === 2;

/** How compromised a car is, from its health: 0 sound, 1 about to fail. Its smoke and its lost pace follow it. */
export function compromise(health: number): number {
  if (!damage2()) return 0;
  return Math.max(0, Math.min(1, (DAMAGE2.SOUND_ABOVE - health) / DAMAGE2.SOUND_ABOVE));
}

/** The share of its power a compromised car has left (falling fast at first, a crawl near the end). */
export function powerLeft(c: number): number {
  return DAMAGE2.POWER_LEFT + (1 - DAMAGE2.POWER_LEFT) * (1 - c) * (1 - c);
}

/** The share of its grip a compromised car has left. */
export function gripLeft(c: number): number {
  return 1 - (1 - DAMAGE2.GRIP_LEFT) * c;
}

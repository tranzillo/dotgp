import { EXPERIMENT } from './experiment';

/**
 * The second damage model, against the first (constants.ts's DAMAGE_* numbers alone). Ovals race the second, road
 * circuits the first (the second isn't measured there yet); ?damage=1 or ?damage=2 races one everywhere. Each car
 * carries the one its race runs (Car.damageModel, set as it's put on a track):
 *
 * - Light contact is free: rubbing, bumping and brushing the wall (impacts under FREE_IMPACT, and scraping) cost
 *   speed and tyres, as the physics has it, but no health. Under the first model it wore cars down until the next
 *   real hit finished them (most cars wrecked were under 0.3 health before the hit that did it), and the clean
 *   teachers' wall scrapes made nearly half their pit stops repairs.
 * - One curve from health to pace, whatever was hit: down to SOUND_ABOVE a car loses a little (a buffer: worth
 *   racing on and fixing at the next stop), then it's compromised and the wheels come off: power and grip fall away
 *   to a crawl at zero, where it's out (a hard enough hit still wrecks it outright). The first model's damaged parts
 *   (aero, handling, engine) cost pace by how the car was hit, up to half again the drag, a third of the grip, 40% of
 *   the power, at any health, and the crews pitted to fix light damage; and a car raced on until it failed, on the
 *   racing line at speed: a caution and a wrecker.
 * - A compromised car smokes, thicker the worse it is: everyone can see it (drivers, spotters, the crew, viewers),
 *   it heads low and comes in, and the field goes round it.
 */
export const DAMAGE2 = {
  /** Normal impact speed below which contact costs no health (m/s; the first model's threshold is 4). */
  FREE_IMPACT: 6,
  /** Health above which a car is sound: a little lost pace, no smoke. */
  SOUND_ABOVE: 0.5,
  /** Down at SOUND_ABOVE, the share of the engine's power left (falling evenly from full health) ... */
  SOUND_POWER: 0.96,
  /** ... and of the tyres' grip. */
  SOUND_GRIP: 0.98,
  /** At health zero: the share of the engine's power left (a crawl: about a third of top speed) ... */
  POWER_LEFT: 0.04,
  /** ... and of the tyres' grip. */
  GRIP_LEFT: 0.6,
};

export type DamageModel = 1 | 2;

/** The damage model a race at this kind of track runs (2026-10-25: experiments/2026-10-25-damage-model-2). */
export function damageModel(kind: string): DamageModel {
  return EXPERIMENT.damage === 1 || EXPERIMENT.damage === 2 ? EXPERIMENT.damage : kind === 'road' ? 1 : 2;
}

/** How compromised a car is, from its health: 0 sound, 1 about to fail. Its smoke and its lost pace follow it. */
export function compromise(car: { health: number; damageModel: DamageModel }): number {
  if (car.damageModel !== 2) return 0;
  return Math.max(0, Math.min(1, (DAMAGE2.SOUND_ABOVE - car.health) / DAMAGE2.SOUND_ABOVE));
}

/** How far a sound car is down its buffer: 0 at full health, 1 at SOUND_ABOVE. */
const worn = (health: number) => Math.max(0, Math.min(1, (1 - health) / (1 - DAMAGE2.SOUND_ABOVE)));

/** The share of its engine's power a car's damage leaves it: a little off when sound; compromised, falling fast at first, a crawl near the end. */
export function powerLeft(car: { health: number; damageModel: DamageModel }): number {
  if (car.damageModel !== 2) return 1;
  const c = compromise(car);
  if (c === 0) return 1 - (1 - DAMAGE2.SOUND_POWER) * worn(car.health);
  return DAMAGE2.POWER_LEFT + (DAMAGE2.SOUND_POWER - DAMAGE2.POWER_LEFT) * (1 - c) * (1 - c);
}

/** The share of its tyres' grip a car's damage leaves it. */
export function gripLeft(car: { health: number; damageModel: DamageModel }): number {
  if (car.damageModel !== 2) return 1;
  const c = compromise(car);
  if (c === 0) return 1 - (1 - DAMAGE2.SOUND_GRIP) * worn(car.health);
  return DAMAGE2.SOUND_GRIP - (DAMAGE2.SOUND_GRIP - DAMAGE2.GRIP_LEFT) * c;
}

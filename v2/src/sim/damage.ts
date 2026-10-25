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
 * - One curve from health to pace, whatever was hit: down to SOUND_ABOVE a car loses a little, more the further
 *   down it is (a buffer: worth racing on and fixing at the next stop); past it the car breaks, going over the limit:
 *   at once it's down to a fraction of its power with much more drag, then less and less, barely moving by a tenth
 *   of its health, where it's out at zero (a hard enough hit still wrecks it outright). The engine and the aero carry
 *   it, its acceleration and its top speed: the grip stays (a car that lost its grip as it broke went into the wall
 *   from mid-corner, 2026-10-25), so a broken car still steers where its driver puts it. The first model's damaged parts
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
  /** Down at SOUND_ABOVE, the share of the engine's power left (falling slowly from full health, then faster) ... */
  SOUND_POWER: 0.8,
  /** ... and its drag, × a sound car's. */
  SOUND_DRAG: 1.2,
  /** Broken (just past SOUND_ABOVE): the share of the engine's power left, at once ... */
  BROKEN_POWER: 0.13,
  /** ... and its drag, rising to DRAG_AT_ZERO. */
  BROKEN_DRAG: 1.5,
  DRAG_AT_ZERO: 2,
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

/** The share of its engine's power a car's damage leaves it: a little off when sound; broken, a fraction, down to barely moving. */
export function powerLeft(car: { health: number; damageModel: DamageModel }): number {
  if (car.damageModel !== 2) return 1;
  const c = compromise(car);
  if (c === 0) return 1 - (1 - DAMAGE2.SOUND_POWER) * worn(car.health) ** 2;
  return DAMAGE2.BROKEN_POWER * (1 - c) * (1 - c);
}

/** Its drag, × a sound car's: a little up when sound; broken, much more, and more again the worse it is. */
export function dragFactor(car: { health: number; damageModel: DamageModel }): number {
  if (car.damageModel !== 2) return 1;
  const c = compromise(car);
  if (c === 0) return 1 + (DAMAGE2.SOUND_DRAG - 1) * worn(car.health) ** 2;
  return DAMAGE2.BROKEN_DRAG + (DAMAGE2.DRAG_AT_ZERO - DAMAGE2.BROKEN_DRAG) * c;
}

import type { Rng } from '../ai/rng';

/**
 * Track names: an invented place plus the kind of venue. Purely cosmetic; a
 * stage of its own so names can grow (sponsors, regions) without touching
 * any other stage's random stream.
 */
const STARTS = ['Ash', 'Bram', 'Cal', 'Dun', 'El', 'Fair', 'Glen', 'Har', 'Iron', 'Kings', 'Lyn', 'Mar', 'North',
  'Oak', 'Pine', 'Red', 'Stone', 'Thorn', 'Wex', 'Whit', 'Wood', 'Ox', 'Cray', 'Bel'];
const ENDS = ['ford', 'ton', 'field', 'ville', 'ridge', 'brook', 'wick', 'mont', 'dale', 'port', 'stead', 'bury',
  'haven', 'moor', 'well', 'gate'];

export function trackName(rng: Rng, venue: string): string {
  return `${STARTS[rng.int(STARTS.length)]}${ENDS[rng.int(ENDS.length)]} ${venue}`;
}

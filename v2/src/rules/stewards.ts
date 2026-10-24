import { Rng } from '../ai/rng';
import type { Violation } from './detect';
import type { Penalty, Rulebook } from './rulebook';

/**
 * Stewards: officials who judge what detection reports. They go by the
 * rulebook's tables (consistent rules are what drivers learn against), but
 * they're people: a strict panel reads an incident as worse than a lenient
 * one, and a less consistent one varies from case to case.
 */
export interface StewardTraits {
  /** 0 lenient .. 1 strict: shifts how bad an incident is judged to be (±0.15 of severity). */
  strictness: number;
  /** 0 erratic .. 1 consistent: how much the reading varies from case to case (up to ±0.15). */
  consistency: number;
}

export const DEFAULT_STEWARDS: StewardTraits = { strictness: 0.5, consistency: 0.8 };

export function randomStewardTraits(random: () => number): StewardTraits {
  return { strictness: 0.2 + 0.6 * random(), consistency: 0.5 + 0.5 * random() };
}

export interface Decision {
  violation: Violation;
  penalty: Penalty;
  /** How bad the panel judged it (severity after its reading). */
  judged: number;
}

export class Stewards {
  private readonly rng: Rng;

  constructor(private readonly rules: Rulebook, readonly traits: StewardTraits = DEFAULT_STEWARDS, seed = 1) {
    this.rng = new Rng(seed);
  }

  judge(v: Violation): Decision {
    const { traits } = this;
    const noise = (1 - traits.consistency) * 0.3 * (this.rng.next() - 0.5);
    const judged = Math.max(0, Math.min(1, v.severity + (traits.strictness - 0.5) * 0.3 + noise));
    const rule = this.rules.offences[v.offence];
    let i = 0;
    while (i < rule.thresholds.length && judged >= rule.thresholds[i]) i++;
    return { violation: v, penalty: rule.penalties[i], judged };
  }
}

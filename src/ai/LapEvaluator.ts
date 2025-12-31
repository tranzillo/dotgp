/**
 * LapEvaluator - Scores laps for training quality and selects best laps.
 *
 * Used by SIL (Self-Imitation Learning) to automatically identify
 * high-quality laps for training data.
 *
 * Scoring factors:
 * - Time score: How fast compared to reference/best
 * - Consistency score: Sector time variance (consistent = good)
 * - Validity bonus: Full bonus for valid laps (no off-track)
 * - Improvement bonus: Beat agent's previous best
 */

import type { LapReplay, LapReplaySummary } from '../replay/types';

/**
 * Detailed quality breakdown for a lap.
 */
export interface LapQualityScore {
  /** Overall score 0-100 */
  overall: number;
  /** Score based on lap time vs reference (0-50) */
  timeScore: number;
  /** Score based on sector time consistency (0-20) */
  consistencyScore: number;
  /** Bonus for valid lap with no off-track (0-20) */
  validityBonus: number;
  /** Bonus for improving on previous best (0-10) */
  improvementBonus: number;
  /** Penalty for incidents: off-track and collisions (0 to -20) */
  incidentPenalty: number;
  /** Star rating from lap data (0-5) */
  starRating: number;
}

/**
 * Reference times for scoring (best known times).
 */
export interface ReferenceTimes {
  /** Best lap time on this track */
  bestLapTime: number;
  /** Best sector times [S1, S2, S3] */
  bestSectorTimes: number[];
  /** Agent's personal best (for improvement bonus) */
  agentBestLapTime?: number;
}

/**
 * Quality tier thresholds.
 * Designed so that without reference times, a clean lap scores ~50 (Good).
 * You need fast times AND clean driving to reach Excellent.
 */
export enum QualityTier {
  Excellent = 85, // ⭐⭐⭐ - Fast, clean, consistent
  Great = 70, // ⭐⭐ - Good time or very clean
  Good = 50, // ⭐ - Completed cleanly
  Poor = 0, // No stars - Incidents or slow
}

/**
 * Get quality tier label for display.
 */
export function getQualityLabel(score: number): string {
  if (score >= QualityTier.Excellent) return '⭐⭐⭐';
  if (score >= QualityTier.Great) return '⭐⭐';
  if (score >= QualityTier.Good) return '⭐';
  return '';
}

/**
 * Get quality tier name for display.
 */
export function getQualityTierName(score: number): string {
  if (score >= QualityTier.Excellent) return 'Excellent';
  if (score >= QualityTier.Great) return 'Great';
  if (score >= QualityTier.Good) return 'Good';
  return 'Poor';
}

export class LapEvaluator {
  private referenceTimes: ReferenceTimes;

  constructor(referenceTimes?: ReferenceTimes) {
    this.referenceTimes = referenceTimes ?? {
      bestLapTime: Infinity,
      bestSectorTimes: [Infinity, Infinity, Infinity],
    };
  }

  /**
   * Update reference times (call when new best is set).
   */
  setReferenceTimes(times: ReferenceTimes): void {
    this.referenceTimes = times;
  }

  /**
   * Update just the best lap time reference.
   */
  setBestLapTime(time: number): void {
    if (time < this.referenceTimes.bestLapTime) {
      this.referenceTimes.bestLapTime = time;
    }
  }

  /**
   * Update just the best sector times reference.
   */
  setBestSectorTimes(times: number[]): void {
    for (let i = 0; i < Math.min(times.length, 3); i++) {
      if (times[i] < this.referenceTimes.bestSectorTimes[i]) {
        this.referenceTimes.bestSectorTimes[i] = times[i];
      }
    }
  }

  /**
   * Set the agent's personal best for improvement bonus calculation.
   */
  setAgentBestLapTime(time: number): void {
    this.referenceTimes.agentBestLapTime = time;
  }

  /**
   * Evaluate a lap and return detailed quality score.
   */
  evaluate(lap: LapReplay | LapReplaySummary): LapQualityScore {
    const timeScore = this.calculateTimeScore(lap.lapTime);
    const consistencyScore = this.calculateConsistencyScore(lap.sectorTimes);
    const validityBonus = this.calculateValidityBonus(lap);
    const improvementBonus = this.calculateImprovementBonus(lap.lapTime);
    const incidentPenalty = this.calculateIncidentPenalty(lap);

    // Get star rating from lap data (if available), otherwise estimate from incidents
    const starRating = lap.starRating ?? this.estimateStarRating(lap);

    const overall = Math.max(0, Math.min(100,
      timeScore + consistencyScore + validityBonus + improvementBonus + incidentPenalty
    ));

    return {
      overall: Math.round(overall),
      timeScore: Math.round(timeScore),
      consistencyScore: Math.round(consistencyScore),
      validityBonus: Math.round(validityBonus),
      improvementBonus: Math.round(improvementBonus),
      incidentPenalty: Math.round(incidentPenalty),
      starRating,
    };
  }

  /**
   * Evaluate a lap using percentile-based time scoring.
   * Quality is relative to all laps on the track (including invalid laps).
   * @param lap The lap to evaluate
   * @param allTrackLapTimes All lap times on this track for percentile calculation
   */
  evaluateWithContext(
    lap: LapReplay | LapReplaySummary,
    allTrackLapTimes: number[]
  ): LapQualityScore {
    const timeScore = this.calculateRelativeTimeScore(lap.lapTime, allTrackLapTimes);
    const consistencyScore = this.calculateConsistencyScore(lap.sectorTimes);
    const validityBonus = this.calculateValidityBonus(lap);
    const improvementBonus = this.calculateImprovementBonus(lap.lapTime);
    const incidentPenalty = this.calculateIncidentPenalty(lap);

    const starRating = lap.starRating ?? this.estimateStarRating(lap);

    const overall = Math.max(0, Math.min(100,
      timeScore + consistencyScore + validityBonus + improvementBonus + incidentPenalty
    ));

    return {
      overall: Math.round(overall),
      timeScore: Math.round(timeScore),
      consistencyScore: Math.round(consistencyScore),
      validityBonus: Math.round(validityBonus),
      improvementBonus: Math.round(improvementBonus),
      incidentPenalty: Math.round(incidentPenalty),
      starRating,
    };
  }

  /**
   * Calculate time score using percentile rank among all laps.
   * All completed laps are included in the ranking.
   * @param lapTime The lap time to score
   * @param allLapTimes All lap times on this track
   * @returns Score 0-50 based on percentile rank
   */
  calculateRelativeTimeScore(lapTime: number, allLapTimes: number[]): number {
    if (allLapTimes.length <= 1) {
      return 25; // Default to middle score with no comparison
    }

    // Sort ascending (fastest first)
    const sorted = [...allLapTimes].sort((a, b) => a - b);

    // Find this lap's rank (0 = fastest)
    let rank = sorted.findIndex(t => t >= lapTime);
    if (rank === -1) rank = sorted.length;

    // Convert to percentile (1.0 = best, 0.0 = worst)
    const percentile = 1 - (rank / sorted.length);

    // Map to 0-50 point range
    return Math.round(percentile * 50);
  }

  /**
   * Estimate star rating from incidents when not stored in lap data.
   * 5 stars = perfect, deductions for incidents.
   */
  private estimateStarRating(lap: LapReplay | LapReplaySummary): number {
    const incidents = lap.incidents;
    if (!incidents || incidents.length === 0) {
      return 5;
    }

    let stars = 5.0;
    for (const incident of incidents) {
      if (incident.type === 'off_track') {
        stars -= 0.5 * incident.severity;
      } else if (incident.type === 'wall_collision') {
        stars -= 1.0 * incident.severity;
      }
    }

    // Round to nearest 0.5, clamp to 0-5
    return Math.max(0, Math.round(stars * 2) / 2);
  }

  /**
   * Calculate time score (0-50) based on lap time vs reference.
   * Closer to best = higher score.
   */
  private calculateTimeScore(lapTime: number): number {
    const bestTime = this.referenceTimes.bestLapTime;

    // If no reference, give a low base score - you need to prove yourself
    if (bestTime === Infinity || bestTime <= 0) {
      return 20; // Low score when no reference - must earn higher through comparison
    }

    // Calculate delta percentage
    const delta = lapTime - bestTime;
    const deltaPercent = (delta / bestTime) * 100;

    // Score based on how close to best:
    // 0% delta = 50 points (best time)
    // 2% delta = 45 points (excellent)
    // 5% delta = 35 points (great)
    // 10% delta = 25 points (good)
    // 20% delta = 15 points (fair)
    // 30%+ delta = 5 points (poor)

    if (deltaPercent <= 0) return 50; // At or better than best
    if (deltaPercent <= 2) return 50 - deltaPercent * 2.5; // 50 to 45
    if (deltaPercent <= 5) return 45 - (deltaPercent - 2) * 3.33; // 45 to 35
    if (deltaPercent <= 10) return 35 - (deltaPercent - 5) * 2; // 35 to 25
    if (deltaPercent <= 20) return 25 - (deltaPercent - 10); // 25 to 15
    if (deltaPercent <= 30) return 15 - (deltaPercent - 20); // 15 to 5
    return 5; // More than 30% slower
  }

  /**
   * Calculate consistency score (0-20) based on sector time variance.
   * Lower variance = more consistent = higher score.
   */
  private calculateConsistencyScore(sectorTimes: number[]): number {
    if (!sectorTimes || sectorTimes.length < 3) {
      return 5; // Low score if no sector data
    }

    const bestSectors = this.referenceTimes.bestSectorTimes;

    // If no reference sectors, use variance of actual sector times
    if (bestSectors.some((t) => t === Infinity)) {
      // Calculate coefficient of variation (CV) of sector times
      const mean = sectorTimes.reduce((a, b) => a + b, 0) / sectorTimes.length;
      const variance = sectorTimes.reduce((sum, t) => sum + Math.pow(t - mean, 2), 0) / sectorTimes.length;
      const cv = Math.sqrt(variance) / mean;

      // CV < 0.05 = very consistent = 20 points
      // CV < 0.1 = consistent = 15 points
      // CV < 0.2 = moderate = 10 points
      // CV >= 0.2 = inconsistent = 5 points
      if (cv < 0.05) return 20;
      if (cv < 0.1) return 15;
      if (cv < 0.2) return 10;
      return 5;
    }

    // Compare each sector to best sector
    let totalDeltaPercent = 0;
    for (let i = 0; i < 3; i++) {
      const delta = sectorTimes[i] - bestSectors[i];
      const deltaPercent = Math.abs(delta / bestSectors[i]) * 100;
      totalDeltaPercent += deltaPercent;
    }

    const avgDeltaPercent = totalDeltaPercent / 3;

    // Score based on average sector delta:
    // 0-3% avg delta = 20 points
    // 3-7% = 15 points
    // 7-15% = 10 points
    // 15%+ = 5 points
    if (avgDeltaPercent <= 3) return 20;
    if (avgDeltaPercent <= 7) return 15;
    if (avgDeltaPercent <= 15) return 10;
    return 5;
  }

  /**
   * Calculate validity bonus (0-20) for clean laps.
   * Now uses incident data directly - no incidents = clean = bonus.
   */
  private calculateValidityBonus(lap: LapReplay | LapReplaySummary): number {
    const incidents = lap.incidents;

    // No incidents = clean lap = full bonus
    if (!incidents || incidents.length === 0) {
      return 20;
    }

    // Has incidents - check if minor or major
    const totalSeverity = incidents.reduce((sum, i) => sum + i.severity, 0);

    // Minor incidents (total severity < 0.5): partial bonus
    if (totalSeverity < 0.5) {
      return 10;
    }

    // Significant incidents: no bonus
    return 0;
  }

  /**
   * Calculate incident penalty (0 to -30) based on collisions and off-track events.
   * More severe penalties to differentiate clean vs dirty laps.
   * Off-track: -8 × severity per incident
   * Collision: -15 × severity per incident
   */
  private calculateIncidentPenalty(lap: LapReplay | LapReplaySummary): number {
    const incidents = lap.incidents;
    if (!incidents || incidents.length === 0) {
      return 0;
    }

    let penalty = 0;
    for (const incident of incidents) {
      if (incident.type === 'off_track') {
        penalty -= 8 * incident.severity;
      } else if (incident.type === 'wall_collision') {
        penalty -= 15 * incident.severity;
      }
    }

    // Cap at -30
    return Math.max(-30, penalty);
  }

  /**
   * Calculate improvement bonus (0-10) for beating agent's previous best.
   */
  private calculateImprovementBonus(lapTime: number): number {
    const agentBest = this.referenceTimes.agentBestLapTime;

    if (!agentBest || agentBest === Infinity) {
      return 3; // Small first lap bonus - need to prove yourself
    }

    const delta = lapTime - agentBest;
    const deltaPercent = (delta / agentBest) * 100;

    // Beat previous best = 10 points
    // Within 2% = 7 points
    // Within 5% = 5 points
    // Within 10% = 3 points
    // Worse than 10% = 0 points
    if (deltaPercent <= 0) return 10;
    if (deltaPercent <= 2) return 7;
    if (deltaPercent <= 5) return 5;
    if (deltaPercent <= 10) return 3;
    return 0;
  }

  /**
   * Check if a lap is good enough for training based on threshold.
   */
  isGoodEnoughForTraining(lap: LapReplay | LapReplaySummary, threshold: number = 40): boolean {
    const score = this.evaluate(lap);
    return score.overall >= threshold;
  }

  /**
   * Get the overall quality score for a lap.
   */
  getQualityScore(lap: LapReplay | LapReplaySummary): number {
    return this.evaluate(lap).overall;
  }

  /**
   * Select the best laps from a collection.
   * @param laps All available laps
   * @param topPercent Top percentage to keep (e.g., 30 = top 30%)
   * @param minCount Minimum number to return even if below threshold
   */
  selectBestLaps<T extends LapReplay | LapReplaySummary>(
    laps: T[],
    topPercent: number = 30,
    minCount: number = 1
  ): T[] {
    if (laps.length === 0) return [];

    // Score all laps
    const scored = laps.map((lap) => ({
      lap,
      score: this.evaluate(lap).overall,
    }));

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Calculate how many to keep
    const countByPercent = Math.ceil((laps.length * topPercent) / 100);
    const keepCount = Math.max(minCount, countByPercent);

    // Return top laps
    return scored.slice(0, keepCount).map((s) => s.lap);
  }

  /**
   * Select laps above a quality threshold.
   * @param laps All available laps
   * @param threshold Minimum quality score (0-100)
   */
  selectLapsAboveThreshold<T extends LapReplay | LapReplaySummary>(laps: T[], threshold: number = 40): T[] {
    return laps.filter((lap) => this.evaluate(lap).overall >= threshold);
  }

  /**
   * Compute quality score for a lap and return it (for storing in replay).
   */
  computeAndGetScore(lap: LapReplay): number {
    const score = this.evaluate(lap);
    return score.overall;
  }
}

// Singleton for convenient access
let defaultEvaluator: LapEvaluator | null = null;

export function getDefaultLapEvaluator(): LapEvaluator {
  if (!defaultEvaluator) {
    defaultEvaluator = new LapEvaluator();
  }
  return defaultEvaluator;
}

export function resetDefaultLapEvaluator(): void {
  defaultEvaluator = null;
}

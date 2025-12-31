/**
 * Seeded pseudo-random number generator for deterministic randomness.
 * Uses the Mulberry32 algorithm - fast, simple, and has good statistical properties.
 *
 * Usage:
 *   const rng = new SeededRandom(12345);
 *   const value = rng.random();  // 0 to 1
 *   const int = rng.randomInt(0, 100);  // 0 to 99
 *   const gaussian = rng.randomGaussian();  // Box-Muller
 */
export class SeededRandom {
  private state: number;
  private initialSeed: number;

  constructor(seed: number) {
    this.initialSeed = seed;
    this.state = seed;
  }

  /**
   * Get the current seed (for saving/restoring state)
   */
  getSeed(): number {
    return this.initialSeed;
  }

  /**
   * Get current internal state (for precise state restoration)
   */
  getState(): number {
    return this.state;
  }

  /**
   * Set internal state (for precise state restoration)
   */
  setState(state: number): void {
    this.state = state;
  }

  /**
   * Reset to initial seed
   */
  reset(): void {
    this.state = this.initialSeed;
  }

  /**
   * Generate a random number in [0, 1)
   * Uses Mulberry32 algorithm
   */
  random(): number {
    // Mulberry32 algorithm
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Generate a random integer in [min, max)
   */
  randomInt(min: number, max: number): number {
    return Math.floor(this.random() * (max - min)) + min;
  }

  /**
   * Generate a random number in [min, max)
   */
  randomRange(min: number, max: number): number {
    return this.random() * (max - min) + min;
  }

  /**
   * Generate a random boolean with given probability of true
   */
  randomBool(probability: number = 0.5): boolean {
    return this.random() < probability;
  }

  /**
   * Generate a random number from a Gaussian distribution
   * Uses Box-Muller transform
   * @param mean Mean of the distribution (default 0)
   * @param std Standard deviation (default 1)
   */
  randomGaussian(mean: number = 0, std: number = 1): number {
    const u1 = this.random();
    const u2 = this.random();
    // Box-Muller transform
    const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return z0 * std + mean;
  }

  /**
   * Shuffle an array in-place using Fisher-Yates algorithm
   */
  shuffle<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
      const j = this.randomInt(0, i + 1);
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  /**
   * Pick a random element from an array
   */
  pick<T>(array: T[]): T {
    return array[this.randomInt(0, array.length)];
  }

  /**
   * Create a new SeededRandom with a derived seed
   * Useful for creating independent RNG streams
   * @param salt Optional string to make the derived seed unique
   */
  derive(salt?: string): SeededRandom {
    // Use salt to create a deterministic but unique seed
    let derivedSeed = this.randomInt(0, 2147483647);
    if (salt) {
      // Simple string hash to modify the seed
      for (let i = 0; i < salt.length; i++) {
        derivedSeed = ((derivedSeed << 5) - derivedSeed + salt.charCodeAt(i)) | 0;
      }
      derivedSeed = Math.abs(derivedSeed);
    }
    return new SeededRandom(derivedSeed);
  }
}

/**
 * Global RNG instance for general use.
 * Should be seeded at game start for deterministic behavior.
 */
let globalRng: SeededRandom | null = null;

/**
 * Initialize the global RNG with a seed.
 * Call this at game start with a known seed for deterministic behavior.
 */
export function initGlobalRng(seed: number): SeededRandom {
  globalRng = new SeededRandom(seed);
  return globalRng;
}

/**
 * Get the global RNG instance.
 * If not initialized, creates one with a random seed (non-deterministic).
 */
export function getGlobalRng(): SeededRandom {
  if (!globalRng) {
    // Fallback to random seed if not initialized
    globalRng = new SeededRandom(Math.floor(Math.random() * 2147483647));
  }
  return globalRng;
}

/**
 * Get the current global RNG state for saving
 */
export function getGlobalRngState(): { seed: number; state: number } | null {
  if (!globalRng) return null;
  return {
    seed: globalRng.getSeed(),
    state: globalRng.getState(),
  };
}

/**
 * Restore global RNG from saved state
 */
export function restoreGlobalRng(savedState: { seed: number; state: number }): void {
  globalRng = new SeededRandom(savedState.seed);
  globalRng.setState(savedState.state);
}

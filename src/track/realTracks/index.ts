/**
 * Registry of real-world track profiles.
 *
 * To add a new track:
 * 1. Create a new file (e.g., spa.ts) with the track definition
 * 2. Import and add to REAL_TRACKS below
 * 3. The track will automatically be available via F key cycling
 */

import { RealTrackDefinition } from './types';
import { MONACO } from './monaco';

/**
 * Registry of all available real tracks.
 */
export const REAL_TRACKS: Record<string, RealTrackDefinition> = {
  monaco: MONACO,
  // Future tracks:
  // spa: SPA,
  // silverstone: SILVERSTONE,
  // suzuka: SUZUKA,
  // monza: MONZA,
};

/**
 * List of available track IDs (for cycling through tracks).
 */
export const REAL_TRACK_IDS = Object.keys(REAL_TRACKS);

/**
 * Get a track definition by ID.
 * @param id Track identifier (e.g., "monaco")
 * @returns The track definition or null if not found
 */
export function getRealTrackById(id: string): RealTrackDefinition | null {
  return REAL_TRACKS[id] ?? null;
}

/**
 * Get list of all available real tracks with metadata.
 * Useful for building track selection UI.
 */
export function getAvailableRealTracks(): { id: string; name: string; country: string }[] {
  return Object.values(REAL_TRACKS).map(t => ({
    id: t.id,
    name: t.name,
    country: t.country,
  }));
}

// Re-export types and generator
export * from './types';
export { RealTrackGenerator } from './RealTrackGenerator';

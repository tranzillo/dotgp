/**
 * Time Trial System Types
 *
 * Data structures for async time trial racing with localStorage persistence.
 */

export type TimeTrialTrackType = 'gp' | 'oval';

// Size classes per track type
export type GPSizeClass = 'park' | 'circuit' | 'autodrome';
export type OvalSizeClass = 'short' | 'speedway' | 'superspeedway';

export type SizeClass = GPSizeClass | OvalSizeClass;

// Oval-specific options
export type OvalShape = 'elliptical' | 'trioval' | 'triangle' | 'square' | 'egg' | 'paperclip';
export type SurfaceType = 'asphalt' | 'dirt';

/**
 * Filter options for leaderboard display.
 */
export type LeaderboardFilter = 'all' | 'human' | 'ai';

export interface TrackMeta {
  type: TimeTrialTrackType;
  sizeClass: SizeClass;
  surfaceType: SurfaceType; // For ovals - asphalt or dirt
  ovalShape: OvalShape; // For ovals - elliptical, trioval, triangle
}

/**
 * A single time trial record (one completed lap).
 */
export interface TimeTrialRecord {
  id: string; // crypto.randomUUID()
  initials: string; // 3-letter initials or "AAA" for anonymous
  lapTime: number; // Total lap time in seconds
  sectorTimes: number[]; // S1, S2, S3 times in seconds
  timestamp: number; // Unix timestamp when recorded
  trackMeta: TrackMeta;
  // AI-specific fields (optional for backward compatibility)
  isAI?: boolean; // True if time was set by an AI agent
  agentName?: string; // Name of the AI agent
  trainedBy?: string; // Initials of player who trained the agent
}

/**
 * Leaderboard for a specific track configuration.
 * Each unique combination of seed + type + size + surface + shape gets its own leaderboard.
 */
export interface TrackLeaderboard {
  seed: number;
  trackType: TimeTrialTrackType;
  sizeClass: SizeClass;
  surfaceType: SurfaceType; // For ovals
  ovalShape: OvalShape; // For ovals
  records: TimeTrialRecord[]; // Sorted by lapTime ascending (fastest first)
  lapCount: number; // Total valid laps recorded (for popularity ranking)
}

/**
 * Root data structure stored in localStorage.
 */
export interface TimeTrialData {
  version: number; // Schema version for future migrations
  userInitials: string; // Persisted user preference
  leaderboards: Record<string, TrackLeaderboard>; // Key = getTrackKey(seed, type, sizeClass)
}

/**
 * Generate a unique key for a track configuration.
 * Includes all parameters that affect track geometry.
 */
export function getTrackKey(
  seed: number,
  trackType: TimeTrialTrackType,
  sizeClass: SizeClass,
  surfaceType: SurfaceType,
  ovalShape: OvalShape
): string {
  return `${seed}_${trackType}_${sizeClass}_${surfaceType}_${ovalShape}`;
}

/**
 * Parse a track key back into its components.
 */
export function parseTrackKey(key: string): {
  seed: number;
  trackType: TimeTrialTrackType;
  sizeClass: SizeClass;
  surfaceType: SurfaceType;
  ovalShape: OvalShape;
} | null {
  const parts = key.split('_');
  // Support both old format (3 parts) and new format (5 parts)
  if (parts.length === 3) {
    // Old format - add defaults for migration
    const seed = parseInt(parts[0], 10);
    if (isNaN(seed)) return null;
    return {
      seed,
      trackType: parts[1] as TimeTrialTrackType,
      sizeClass: parts[2] as SizeClass,
      surfaceType: 'asphalt',
      ovalShape: 'elliptical',
    };
  }
  if (parts.length !== 5) return null;

  const seed = parseInt(parts[0], 10);
  if (isNaN(seed)) return null;

  return {
    seed,
    trackType: parts[1] as TimeTrialTrackType,
    sizeClass: parts[2] as SizeClass,
    surfaceType: parts[3] as SurfaceType,
    ovalShape: parts[4] as OvalShape,
  };
}

/**
 * Size class options for each track type.
 */
export const SIZE_CLASS_OPTIONS: Record<TimeTrialTrackType, SizeClass[]> = {
  gp: ['park', 'circuit', 'autodrome'],
  oval: ['short', 'speedway', 'superspeedway'],
};

/**
 * Default size class for each track type.
 */
export const DEFAULT_SIZE_CLASS: Record<TimeTrialTrackType, SizeClass> = {
  gp: 'circuit',
  oval: 'speedway',
};

// ─────────────────────────────────────────────────────────────
// Composite Seed Encoding
// ─────────────────────────────────────────────────────────────
//
// Encodes all track configuration into a single shareable number.
//
// Bit layout (from LSB):
//   Bits 0-1:   Track type (0=GP, 1=Oval)
//   Bits 2-3:   Size class index (0=small, 1=medium, 2=large)
//   Bit 4:      Surface type (0=asphalt, 1=dirt) - only for oval
//   Bits 5-7:   Oval shape (0=elliptical, 1=trioval, 2=triangle, 3=square, 4=egg, 5=paperclip)
//   Bits 8+:    Base seed (shifted left by 8 bits)
//
// This allows the same base seed to produce different tracks
// when combined with different type/size/surface options.

export interface FullTrackConfig {
  baseSeed: number;
  trackType: TimeTrialTrackType;
  sizeClass: SizeClass;
  surfaceType: SurfaceType; // Only used for oval
  ovalShape: OvalShape; // Only used for oval
}

// Encoding constants
const TRACK_TYPE_BITS = 2;
const SIZE_CLASS_BITS = 2;
const SURFACE_BITS = 1;
const SHAPE_BITS = 3; // 3 bits for 6 shapes (elliptical, trioval, triangle, square, egg, paperclip)
const CONFIG_BITS = TRACK_TYPE_BITS + SIZE_CLASS_BITS + SURFACE_BITS + SHAPE_BITS; // 8 bits

const TRACK_TYPE_MAP: TimeTrialTrackType[] = ['gp', 'oval'];
const SIZE_CLASS_MAP: Record<TimeTrialTrackType, SizeClass[]> = {
  gp: ['park', 'circuit', 'autodrome'],
  oval: ['short', 'speedway', 'superspeedway'],
};
const SURFACE_MAP: SurfaceType[] = ['asphalt', 'dirt'];
const SHAPE_MAP: OvalShape[] = ['elliptical', 'trioval', 'triangle', 'square', 'egg', 'paperclip'];

/**
 * Encode a full track configuration into a single composite seed.
 */
export function encodeCompositeSeed(config: FullTrackConfig): number {
  const typeIndex = TRACK_TYPE_MAP.indexOf(config.trackType);
  const sizeIndex = SIZE_CLASS_MAP[config.trackType].indexOf(config.sizeClass);
  const surfaceIndex = SURFACE_MAP.indexOf(config.surfaceType);
  const shapeIndex = SHAPE_MAP.indexOf(config.ovalShape);

  // Pack bits: baseSeed | shape | surface | size | type
  let composite = config.baseSeed << CONFIG_BITS;
  composite |= shapeIndex << (TRACK_TYPE_BITS + SIZE_CLASS_BITS + SURFACE_BITS);
  composite |= surfaceIndex << (TRACK_TYPE_BITS + SIZE_CLASS_BITS);
  composite |= sizeIndex << TRACK_TYPE_BITS;
  composite |= typeIndex;

  return composite;
}

/**
 * Decode a composite seed into full track configuration.
 */
export function decodeCompositeSeed(composite: number): FullTrackConfig {
  const typeIndex = composite & 0b11;
  const sizeIndex = (composite >> TRACK_TYPE_BITS) & 0b11;
  const surfaceIndex = (composite >> (TRACK_TYPE_BITS + SIZE_CLASS_BITS)) & 0b1;
  const shapeIndex = (composite >> (TRACK_TYPE_BITS + SIZE_CLASS_BITS + SURFACE_BITS)) & 0b111;
  const baseSeed = composite >> CONFIG_BITS;

  const trackType = TRACK_TYPE_MAP[typeIndex] || 'gp';
  const sizeClass = SIZE_CLASS_MAP[trackType][sizeIndex] || SIZE_CLASS_MAP[trackType][1];
  const surfaceType = SURFACE_MAP[surfaceIndex] || 'asphalt';
  const ovalShape = SHAPE_MAP[shapeIndex] || 'elliptical';

  return {
    baseSeed,
    trackType,
    sizeClass,
    surfaceType,
    ovalShape,
  };
}

/**
 * Check if a number looks like a composite seed (has config bits set).
 * A raw seed entered by user would typically be smaller and have config bits = 0.
 */
export function isCompositeSeed(seed: number): boolean {
  // If the number is large enough that it must have come from encoding
  // (baseSeed >= 1 means composite >= 128)
  return seed >= (1 << CONFIG_BITS);
}

/**
 * Get display-friendly string for a composite seed.
 */
export function formatCompositeSeed(composite: number): string {
  return composite.toString();
}

import type { TrackLayout } from '../sim/layout';
import { Track } from '../sim/track';
import { buildLayout, generateLayout, type GenerateOptions } from './generator';
import { FLAT_TRACK, SHORT_TRACK, SPEEDWAY, type OvalParams } from './oval';

/**
 * Track generation entry point: registered track types, the preset catalog,
 * and helpers that go straight to a runtime Track.
 *
 * Importing this module registers every built-in track type.
 */
export * from './generator';
export * from './oval';
export * from './circuit';
export * from './complex';
export * from './course';
export * from './roval';
export { mirrorLayout } from './mirror';
export type { Problem } from './validate';

/** Hand-tuned tracks the drivers train on: fixed parameters, always the same layout. */
export const PRESETS: Record<string, { type: string; params: OvalParams }> = {
  speedway: { type: 'oval', params: SPEEDWAY },
  short: { type: 'oval', params: SHORT_TRACK },
  flat: { type: 'oval', params: FLAT_TRACK },
};

export function presetLayout(id: string): TrackLayout {
  const preset = PRESETS[id];
  if (!preset) throw new Error(`unknown preset track "${id}"`);
  return buildLayout(preset.type, preset.params);
}

const presetCache = new Map<string, Track>();

/** The runtime track for a preset (built once, shared: tracks are immutable). */
export function presetTrack(id: string): Track {
  let track = presetCache.get(id);
  if (!track) {
    track = new Track(presetLayout(id));
    presetCache.set(id, track);
  }
  return track;
}

/** Generate a new track from a seed. */
export function generateTrack(opts: GenerateOptions): Track {
  return new Track(generateLayout(opts));
}

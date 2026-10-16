import { Rng } from '../ai/rng';
import type { TrackLayout } from '../sim/layout';
import { Track } from '../sim/track';
import { validateLayout, type Problem } from './validate';

/**
 * Track generation. A track type (oval, later road courses, tri-ovals...) is
 * registered here and turns a seed into a TrackLayout in two steps:
 *
 *   sample(rng, variant) -> params    pick parameters within the variant's ranges
 *   build(params, ctx)   -> layout    lay out the track from those parameters,
 *                                     usually by composing the shared stages in
 *                                     stages.ts (pit lane, garage, escape lanes,
 *                                     surfaces, walls, markings, decor)
 *
 * Every layout is validated (generic checks plus the type's own); a layout
 * with errors is thrown away and the generator retries with a derived seed.
 * Generation is deterministic: the same type, seed, variant and overrides
 * always give the same layout.
 */

export interface GenContext {
  /** Seed actually used (the requested seed, or one derived from it on a retry). */
  seed: number;
  /**
   * An independent random stream per stage. Each stage draws from its own
   * stream, so adding a stage or changing how many numbers one stage draws
   * doesn't reshuffle the others: existing seeds keep their layouts.
   */
  rng(stage: string): Rng;
}

export interface TrackType<P extends object = object> {
  id: string;
  name: string;
  /** Families of this type (size classes, shapes) that sample() understands. */
  variants: readonly string[];
  /** Random parameters for a variant (hints: the caller's fixed parameters, which sampling may respect). */
  sample(rng: Rng, variant: string, hints?: Record<string, unknown>): P;
  /** Lay out a track from parameters. */
  build(params: P, ctx: GenContext): TrackLayout;
  /** Checks only this type knows how to make. */
  validate?(layout: TrackLayout, track: Track): Problem[];
}

const registry = new Map<string, TrackType>();

export function registerTrackType<P extends object>(type: TrackType<P>): TrackType<P> {
  registry.set(type.id, type as unknown as TrackType);
  return type;
}

export function trackType(id: string): TrackType {
  const type = registry.get(id);
  if (!type) throw new Error(`unknown track type "${id}" (registered: ${[...registry.keys()].join(', ')})`);
  return type;
}

export function trackTypes(): TrackType[] {
  return [...registry.values()];
}

export interface GenerateOptions {
  type: string;
  seed: number;
  /** Defaults to a variant chosen by the seed. */
  variant?: string;
  /** Fix some parameters instead of sampling them. */
  params?: Record<string, unknown>;
  /** Seeds to try before giving up (default 20). */
  attempts?: number;
}

export function generateLayout(opts: GenerateOptions): TrackLayout {
  const type = trackType(opts.type);
  const attempts = opts.attempts ?? 20;
  const failures: string[] = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    const seed = attempt === 0 ? opts.seed >>> 0 : hashSeed(opts.seed, `retry${attempt}`);
    const ctx = context(seed);
    const variant = opts.variant ?? type.variants[ctx.rng('variant').int(type.variants.length)];
    const params = { ...type.sample(ctx.rng('params'), variant, opts.params), ...opts.params };
    const layout = type.build(params, ctx);
    layout.seed = opts.seed;
    layout.params = { ...layout.params, variant, attempt };
    const problems = check(type, layout);
    const errors = problems.filter((p) => p.severity === 'error');
    if (!errors.length) {
      layout.notes = problems.map((p) => p.message);
      return layout;
    }
    failures.push(`seed ${seed}: ${errors.map((e) => e.message).join('; ')}`);
  }
  throw new Error(`could not generate a valid ${type.id} track from seed ${opts.seed}:\n  ${failures.join('\n  ')}`);
}

/** Lay out a track from fixed parameters (presets, tests). Throws if it isn't valid. */
export function buildLayout<P extends object>(typeId: string, params: P, seed = 0): TrackLayout {
  const type = trackType(typeId);
  const layout = type.build(params, context(seed));
  const problems = check(type, layout);
  const errors = problems.filter((p) => p.severity === 'error');
  if (errors.length) throw new Error(`invalid ${typeId} layout: ${errors.map((e) => e.message).join('; ')}`);
  layout.notes = problems.map((p) => p.message);
  return layout;
}

function check(type: TrackType, layout: TrackLayout): Problem[] {
  const track = new Track(layout);
  return [...validateLayout(layout, track), ...(type.validate?.(layout, track) ?? [])];
}

function context(seed: number): GenContext {
  return { seed, rng: (stage) => new Rng(hashSeed(seed, stage)) };
}

/** FNV-1a over the seed and a label: a stable, well-mixed seed per stage or retry. */
export function hashSeed(seed: number, label: string): number {
  let h = 0x811c9dc5 ^ (seed >>> 0);
  h = Math.imul(h, 0x01000193) >>> 0;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

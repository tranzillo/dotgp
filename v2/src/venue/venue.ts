import type { LayoutKind, TrackLayout } from '../sim/layout';
import { Track } from '../sim/track';
import { racesOn, seriesFor, type Series } from '../rules/series';

/**
 * A venue: a place with one or more track layouts. A layout is a whole lap a
 * race can run on (an oval, a road course through the infield...); a race is
 * a series on one of the venue's layouts. Making a venue (generating it, or
 * a preset) is separate from racing at it.
 *
 * Every track so far is a venue with one layout. Complexes (ovals inside
 * ovals, joined by roads into road courses) have many.
 */
export interface VenueLayout {
  /** Unique within the venue. */
  id: string;
  name: string;
  kind: LayoutKind;
  track: Track;
}

export interface Venue {
  /** Unique among the venues on offer. */
  id: string;
  name: string;
  layouts: VenueLayout[];
  /** How to open it again (generated venues): the ?track= value, e.g. oval:1234:short. */
  source?: string;
}

/** A venue with one layout: the track. */
export function singleLayoutVenue(track: Track, opts: { id?: string; name?: string; source?: string } = {}): Venue {
  return {
    id: opts.id ?? track.layout.id,
    name: opts.name ?? track.name,
    layouts: [{ id: track.layout.id, name: track.name, kind: track.kind, track }],
    ...(opts.source ? { source: opts.source } : {}),
  };
}

/** A venue of several layouts (each with the others as its neighbours: see trackgen/complex.ts). */
export function multiLayoutVenue(id: string, name: string, layouts: TrackLayout[]): Venue {
  return {
    id, name,
    layouts: layouts.map((layout) => {
      const track = new Track(layout);
      return { id: layout.id, name: layout.name, kind: track.kind, track };
    }),
  };
}

/** The series that race here: on at least one of its layouts. */
export function venueSeries(venue: Venue): Series[] {
  return seriesFor(venue.layouts.map((l) => l.track.layout));
}

/** The layouts a series races on here. */
export function layoutsFor(venue: Venue, series: Series): VenueLayout[] {
  return venue.layouts.filter((l) => racesOn(series, l.track.layout));
}

/** How a race at this venue is named: the venue, and the layout where there's a choice. */
export function layoutLabel(venue: Venue, layout: VenueLayout): string {
  return venue.layouts.length > 1 ? `${venue.name} · ${layout.name}` : venue.name;
}

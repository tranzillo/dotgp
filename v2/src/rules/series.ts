import type { LayoutKind, TrackLayout } from '../sim/layout';
import { layoutKind } from '../sim/layout';
import { CIRCUIT_RULES, OVAL_RULES, type Rulebook } from './rulebook';

/**
 * A racing series: the kinds of layout it races on and the rulebook it races
 * to. A venue with several layouts can host several series, each on the
 * layouts that suit it; a race is a series on one of a venue's layouts.
 */
export interface Series {
  id: string;
  name: string;
  /** The layout kinds it races on. */
  races: readonly LayoutKind[];
  rulebook: Rulebook;
  blurb: string;
}

export const SERIES: readonly Series[] = [
  {
    id: 'stock', name: 'Stock cars', races: ['superspeedway', 'speedway', 'short-oval'], rulebook: OVAL_RULES,
    blurb: 'Paved ovals of every size: rolling starts, the pace car, solo qualifying',
  },
  {
    id: 'short', name: 'Short track', races: ['short-oval'], rulebook: OVAL_RULES,
    blurb: 'Short ovals only: bullrings and bowls',
  },
  {
    id: 'road', name: 'Road racing', races: ['road'], rulebook: CIRCUIT_RULES,
    blurb: 'Road courses: standing starts, the safety car, group qualifying, track limits',
  },
];

export function seriesById(id: string): Series {
  const series = SERIES.find((s) => s.id === id);
  if (!series) throw new Error(`unknown series "${id}" (series: ${SERIES.map((s) => s.id).join(', ')})`);
  return series;
}

/** Whether a series races on this layout. */
export function racesOn(series: Series, layout: TrackLayout): boolean {
  return series.races.includes(layoutKind(layout));
}

/** The series that race on at least one of these layouts, in registry order. */
export function seriesFor(layouts: TrackLayout[]): Series[] {
  return SERIES.filter((s) => layouts.some((l) => racesOn(s, l)));
}

/** The series a layout races to when none is named: the first that races on its kind. */
export function defaultSeries(layout: TrackLayout): Series {
  return SERIES.find((s) => racesOn(s, layout)) ?? SERIES[0];
}

import { describe, expect, it } from 'vitest';
import { Session, seriesOf } from '../src/events/session';
import { defaultSeries, seriesById, SERIES } from '../src/rules/series';
import { layoutKind } from '../src/sim/layout';
import { Track } from '../src/sim/track';
import { generateLayout, presetLayout, presetTrack } from '../src/trackgen';
import { layoutsFor, singleLayoutVenue, venueSeries } from '../src/venue/venue';

describe('venues, layouts and series', () => {
  it('knows what kind of racing each layout is for', () => {
    expect(layoutKind(presetLayout('speedway'))).toBe('speedway');
    expect(layoutKind(presetLayout('short'))).toBe('short-oval');
    expect(layoutKind(presetLayout('flat'))).toBe('speedway');
    expect(layoutKind(generateLayout({ type: 'oval', seed: 1, variant: 'superspeedway' }))).toBe('superspeedway');
    expect(layoutKind(generateLayout({ type: 'oval', seed: 1, variant: 'short' }))).toBe('short-oval');
    expect(layoutKind(generateLayout({ type: 'circuit', seed: 1, variant: 'club' }))).toBe('road');
    expect(new Track(generateLayout({ type: 'circuit', seed: 1, variant: 'club' })).kind).toBe('road');
  });

  it('offers only the series that race on one of the venue layouts', () => {
    const names = (v: ReturnType<typeof singleLayoutVenue>) => venueSeries(v).map((s) => s.id);
    expect(names(singleLayoutVenue(presetTrack('speedway')))).toEqual(['stock']);
    expect(names(singleLayoutVenue(presetTrack('short')))).toEqual(['stock', 'short']);
    expect(names(singleLayoutVenue(new Track(generateLayout({ type: 'circuit', seed: 2, variant: 'gp' }))))).toEqual(['road']);
  });

  it('picks the layouts a series races on at a venue', () => {
    const oval = presetTrack('short');
    const road = new Track(generateLayout({ type: 'circuit', seed: 3, variant: 'club' }));
    // A venue with two layouts: one each.
    const venue = { id: 'both', name: 'Both', layouts: [...singleLayoutVenue(oval).layouts, ...singleLayoutVenue(road).layouts] };
    expect(venueSeries(venue).map((s) => s.id)).toEqual(SERIES.map((s) => s.id));
    expect(layoutsFor(venue, seriesById('road')).map((l) => l.track)).toEqual([road]);
    expect(layoutsFor(venue, seriesById('stock')).map((l) => l.track)).toEqual([oval]);
  });

  it('races to the series rulebook, and refuses a series that does not race there', () => {
    const layout = presetLayout('short');
    expect(seriesOf({ layout }).id).toBe('stock');
    expect(seriesOf({ layout, series: 'short' }).id).toBe('short');
    expect(() => seriesOf({ layout, series: 'road' })).toThrow(/doesn't race/);
    const circuit = generateLayout({ type: 'circuit', seed: 4, variant: 'club' });
    expect(defaultSeries(circuit).rulebook.start.kind).toBe('standing');
    // The race runs to it: road racing's safety car on the circuit, the pace car on the oval.
    const race = (spec: { layout: typeof layout; series?: string }) => new Session({ kind: 'race', entrants: [], laps: 1, pace: 4, seed: 1, ...spec }).race!;
    expect(race({ layout: circuit, series: 'road' }).control!.safetyCar).toBe(true);
    expect(race({ layout, series: 'short' }).control!.safetyCar).toBe(false);
  });
});

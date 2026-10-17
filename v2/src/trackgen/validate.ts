import type { TrackLayout, TrackRect } from '../sim/layout';
import type { Track } from '../sim/track';

export interface Problem {
  /** Errors reject the layout (the generator retries); warnings are kept as notes. */
  severity: 'error' | 'warning';
  message: string;
}

/** Fewer pit boxes than this and cars share boxes. */
const MIN_STALLS = 12;

/**
 * Checks every layout gets, whatever made it. A check that only one track
 * type can get wrong belongs in that type's validate().
 */
export function validateLayout(layout: TrackLayout, track: Track): Problem[] {
  const problems: Problem[] = [];
  const error = (message: string) => problems.push({ severity: 'error', message });
  const warn = (message: string) => problems.push({ severity: 'warning', message });

  if (track.closureError > 1) error(`centerline doesn't close (${track.closureError.toFixed(2)} m gap)`);

  const pit = layout.pit;
  if (!(pit.entryStart < pit.wallStart && pit.wallStart < pit.wallEnd && pit.wallEnd < pit.exitEnd && pit.exitEnd <= pit.blendEnd)) {
    error('pit lane points out of order (entry < wall start < wall end < exit <= blend end)');
  }
  if (pit.blendEnd - pit.entryStart >= track.length) error('pit lane is longer than the lap');
  if (!pit.stalls.length) error('pit road has no boxes');
  else if (pit.stalls.length < MIN_STALLS) warn(`only ${pit.stalls.length} pit boxes: cars will share`);
  if (!layout.infield.garage.parking.length) error('garage has no parking for retired cars');

  // Infield features must stay on their own side of the infield: a point laid
  // out at (s, d) should project back to (s, d). If it doesn't, the feature
  // reached past the middle of the infield toward the far side of the track.
  const staysPut = (s: number, d: number) => {
    const [x, y] = track.toWorld(s, d);
    const p = track.project(x, y);
    return Math.abs(track.signedS(p.s - s)) < 1 && Math.abs(p.d - d) < 0.5;
  };
  const rectStaysPut = (r: TrackRect) => [[r.s0, r.d1], [r.s1, r.d1], [(r.s0 + r.s1) / 2, r.d1]].every(([s, d]) => staysPut(s, d));
  if (!rectStaysPut(layout.infield.garage.lot)) error('garage lot reaches across the infield');
  for (const deco of layout.decor) {
    if (deco.kind === 'building' && !rectStaysPut(deco.rect)) error('a building reaches across the infield');
  }

  // Roads must start at the pavement and must not run through buildings.
  layout.infield.escapeLanes.forEach((lane, i) => {
    const [x0, y0] = lane.points[0];
    const start = track.project(x0, y0);
    if (start.d > track.pavedInnerD(start.s) || start.d < track.innerEdgeAt(start.s) - 1) error(`escape lane ${i} doesn't start at the apron`);
    for (let k = 0; k + 1 < lane.points.length; k++) {
      const [ax, ay] = lane.points[k], [bx, by] = lane.points[k + 1];
      for (let t = 0; t <= 1; t += 0.05) {
        const p = track.project(ax + (bx - ax) * t, ay + (by - ay) * t);
        const r = track.signedS(p.s);
        const hit = layout.decor.some((deco) => deco.kind === 'building'
          && r >= deco.rect.s0 && r <= deco.rect.s1 && p.d >= deco.rect.d0 && p.d <= deco.rect.d1);
        if (hit) { error(`escape lane ${i} runs through a building`); return; }
      }
    }
  });
  return problems;
}

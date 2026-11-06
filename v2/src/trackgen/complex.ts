import type { LayoutKind, Placement, TrackLayout } from '../sim/layout';
import { placeLayout, validateVenue } from './geometry';
import { buildLayout } from './generator';
export { placeLayout, validateVenue } from './geometry';
import { venueWithCourses } from './roval';
import { closeOval, type AnyOvalParams, type OvalCorner, type ShapedOvalParams } from './oval';

/**
 * Venues with several tracks: rings (ovals) placed in one frame, typically
 * nested, each inside the infield of the one round it. Each ring is a layout
 * of its own (a race runs on one); the others come with it as neighbours,
 * scenery it can see, drive onto and hit.
 *
 * Later: connector roads between the rings, and road-course layouts routed
 * through them.
 */
export interface RingSpec {
  /** Unique within the venue. */
  id: string;
  name: string;
  params: AnyOvalParams;
  /** Where its centre goes in the venue's frame, and how it's turned (default: the venue's centre, unturned). */
  placement?: Placement;
  kind?: LayoutKind;
}

export interface ComplexSpec {
  id: string;
  name: string;
  rings: RingSpec[];
}

const ORIGIN: Placement = { x: 0, y: 0, angle: 0 };

/**
 * Every layout of the venue a generated track belongs to: the track, the
 * tracks in its infield (an inner oval), each with all the others as its
 * neighbours, and the road courses routed through its infield.
 */
export function venueLayouts(layout: TrackLayout): TrackLayout[] {
  if (layout.infield.rovals?.length) return venueWithCourses(layout);
  const all = [{ ...layout, neighbours: undefined }, ...(layout.neighbours ?? [])];
  return all.length > 1 ? all.map((l, i) => ({ ...l, neighbours: all.filter((_, j) => j !== i) })) : [layout];
}

/** The venue's layouts, one per ring, each with the others as its neighbours. Throws if the rings get in each other's way. */
export function complexLayouts(spec: ComplexSpec): TrackLayout[] {
  const rings = spec.rings.map((r) => {
    const built = buildLayout('oval', { ...r.params, name: r.name });
    return placeLayout({ ...built, id: `${spec.id}/${r.id}`, ...(r.kind ? { kind: r.kind } : {}) }, r.placement ?? ORIGIN);
  });
  const problems = validateVenue(rings);
  if (problems.length) throw new Error(`invalid venue ${spec.name}: ${problems.join('; ')}`);
  return rings.map((layout, i) => ({ ...layout, neighbours: rings.filter((_, j) => j !== i) }));
}

// ---------- the mega complex ----------

const deg = (x: number) => (x * Math.PI) / 180;

function corner(angle: number, radius: number, ease: number, bank: [number, number], extra: Partial<OvalCorner> = {}): OvalCorner {
  return { angle: deg(angle), radius, easeIn: ease, easeOut: ease, bankInner: deg(bank[0]), bankOuter: deg(bank[1]), ...extra };
}

/** A tri-oval closed and with the line at the bend's apex. */
function triOval(o: { bend: number; bendRadius: number; bendEase: number; bendBank: [number, number]; turnRadius: number; turnEase: number; turnBank: [number, number]; sides: number; back: number } & Omit<ShapedOvalParams, 'shape' | 'straights' | 'corners' | 'start'>): ShapedOvalParams {
  const { bend, bendRadius, bendEase, bendBank, turnRadius, turnEase, turnBank, sides, back, ...rest } = o;
  const turn = corner(180 - bend / 2, turnRadius, turnEase, turnBank, { widening: 2 });
  const p: ShapedOvalParams = {
    ...rest,
    shape: 'tri-oval',
    straights: [{ length: sides }, { length: sides }, { length: back }],
    corners: [corner(bend, bendRadius, bendEase, bendBank, { dogleg: true }), turn, { ...turn }],
    start: sides + (deg(bend) * bendRadius + bendEase) / 2,
  };
  if (!closeOval(p)) throw new Error('tri-oval does not close');
  return p;
}

/**
 * The default venue: a 4.6 km tri-oval superspeedway banked 33 degrees, an
 * Indy-style rectangle speedway in its infield, a Bristol-style short-track
 * bowl inside that, and a bullring on its own in the superspeedway's turn 3-4
 * end (it becomes the dirt track). Each ring has its own pit road and garage;
 * the two that hold another track reach their garage by a road round the edge
 * of their infield.
 */
export const MEGA_COMPLEX: ComplexSpec = {
  id: 'mega',
  name: 'Mega Complex',
  rings: [
    {
      id: 'superspeedway', name: 'Superspeedway',
      params: triOval({
        bend: 34, bendRadius: 1100, bendEase: 190, bendBank: [18, 19],
        turnRadius: 380, turnEase: 120, turnBank: [33, 35],
        sides: 265, back: 1150,
        width: 22, apronWidth: 10, bankStraight: deg(3), escapeRoute: 'around',
      }),
    },
    {
      id: 'speedway', name: 'Speedway',
      params: {
        shape: 'rectangle',
        straights: [{ length: 600 }, { length: 150 }, { length: 600 }, { length: 150 }],
        corners: [0, 1, 2, 3].map(() => corner(90, 150, 45, [12, 14])),
        start: 300,
        width: 18, apronWidth: 8, bankStraight: deg(1), escapeRoute: 'around',
      },
      placement: { x: 0, y: 0, angle: 0 },
    },
    {
      id: 'short', name: 'Short track',
      params: {
        straightLength: 200, turnRadius: 80, easementLength: 30, width: 16, apronWidth: 6,
        bankInner: deg(24), bankOuter: deg(28), bankStraight: deg(6),
      },
    },
    {
      id: 'bullring', name: 'Bullring',
      params: {
        straightLength: 140, turnRadius: 55, easementLength: 20, width: 14, apronWidth: 5,
        bankInner: deg(12), bankOuter: deg(15), bankStraight: deg(4),
      },
      placement: { x: -700, y: 0, angle: 0 },
    },
  ],
};

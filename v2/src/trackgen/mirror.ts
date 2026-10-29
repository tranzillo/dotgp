import type { Edge, Profile, SurfaceRegion, TrackLayout, TrackRect, Wall, Marking } from '../sim/layout';

/**
 * The same track driven the other way round in mirror image: every left turn
 * a right turn. Curvature changes sign, and every lateral feature (edges,
 * banking, surfaces, walls, pit, infield, paint) moves to the other side.
 * The centerline is integrated from the origin heading along +x, so negating
 * its curvature reflects the world shape exactly: (x, y) -> (x, -y).
 *
 * The sim treats the two the same (a check that it has no handedness); the
 * oval procedures (pit road, the apron, race control's lanes) still assume
 * the infield is on the left, so a mirrored oval is for driving, not racing.
 */
export function mirrorLayout(layout: TrackLayout): TrackLayout {
  const cs = layout.crossSection;
  return {
    ...layout,
    id: `${layout.id}:mirrored`,
    name: `${layout.name} (mirrored)`,
    params: { ...layout.params, mirrored: true },
    centerline: { ...layout.centerline, sections: layout.centerline.sections.map(([len, k0, k1]) => [len, -k0, -k1]) },
    crossSection: {
      edgeIn: negEdge(cs.edgeOut),
      edgeOut: negEdge(cs.edgeIn),
      apronWidth: cs.apronWidth,
      pavedInner: negEdge(cs.pavedInner),
      bankInner: negProfile(cs.bankOuter),
      bankOuter: negProfile(cs.bankInner),
      bankInfield: negProfile(cs.bankInfield),
    },
    surfaces: layout.surfaces.map(mirrorRegion),
    ...(layout.barriers ? { barriers: layout.barriers.map((b) => ({ ...b, points: b.points.map(flipY) })) } : {}),
    walls: layout.walls.map((w): Wall => ({ ...w, d: negEdge(w.d), faces: w.faces === 'in' ? 'out' : w.faces === 'out' ? 'in' : 'both' })),
    pit: {
      ...layout.pit, wallD: -layout.pit.wallD, roadD: -layout.pit.roadD, laneD: -layout.pit.laneD,
      ...(layout.pit.offset ? { offset: negProfile(layout.pit.offset) } : {}),
      ...(layout.pit.entryRoute ? { entryRoute: negProfile(layout.pit.entryRoute) } : {}),
      ...(layout.pit.exitRoute ? { exitRoute: negProfile(layout.pit.exitRoute) } : {}),
    },
    infield: {
      garage: { lot: mirrorRect(layout.infield.garage.lot), parking: layout.infield.garage.parking.map(flipY) },
      escapeLanes: layout.infield.escapeLanes.map((e) => ({ ...e, points: e.points.map(flipY) })),
      ...(layout.infield.network ? {
        network: {
          nodes: layout.infield.network.nodes.map((n) => ({ ...n, at: flipY(n.at) })),
          roads: layout.infield.network.roads.map((r) => ({ ...r, points: r.points.map(flipY) })),
          ...(layout.infield.network.areas ? { areas: layout.infield.network.areas.map((a) => ({ ...a, rings: a.rings.map((ring) => ring.map(flipY)) })) } : {}),
        },
      } : {}),
    },
    markings: layout.markings.map((m): Marking => (m.kind === 'line' ? { ...m, d: negEdge(m.d) } : { ...m, d0: -m.d1, d1: -m.d0 })),
    decor: layout.decor.map((d) => ({ ...d, rect: mirrorRect(d.rect) })),
  };
}

const negProfile = (p: Profile): Profile => ({ ...p, keys: p.keys.map(([s, v]) => [s, -v]) });
const negEdge = (e: Edge): Edge => (typeof e === 'number' ? -e : negProfile(e));
const mirrorRect = (r: TrackRect): TrackRect => ({ ...r, d0: -r.d1, d1: -r.d0 });
const flipY = ([x, y]: [number, number]): [number, number] => [x, -y];

function mirrorRegion(region: SurfaceRegion): SurfaceRegion {
  const shape = region.shape;
  switch (shape.kind) {
    case 'band':
      return { ...region, shape: { ...shape, d0: negEdge(shape.d1), d1: negEdge(shape.d0), openOut: shape.openIn, openIn: shape.openOut } };
    case 'rect':
      return { ...region, shape: { ...shape, rect: mirrorRect(shape.rect) } };
    case 'path':
      return { ...region, shape: { ...shape, points: shape.points.map(flipY) } };
    case 'polygon':
      return { ...region, shape: { ...shape, rings: shape.rings.map((ring) => ring.map(flipY)) } };
  }
}

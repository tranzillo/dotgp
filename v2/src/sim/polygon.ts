/**
 * Point-in-polygon for big world-space regions (an infield's pavement: an
 * outline with holes, the grass islands), fast enough for per-car,
 * per-step surface lookups. Even-odd over all rings, so a ring inside
 * another is a hole. The edges are bucketed by horizontal band; a test only
 * crosses the few edges in its point's band.
 */
export class PolygonIndex {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  private readonly band: number;
  /** Per band: the edges (x0, y0, x1, y1) that overlap it, flattened. */
  private readonly bands: Float64Array[];

  constructor(rings: Array<Array<[number, number]>>, band = 8) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of rings) for (const [x, y] of ring) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    this.minX = minX; this.minY = minY; this.maxX = maxX; this.maxY = maxY;
    this.band = band;
    const n = Math.max(1, Math.ceil((maxY - minY) / band) + 1);
    const lists: number[][] = Array.from({ length: n }, () => []);
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length];
        if (y0 === y1) continue; // horizontal edges never cross a horizontal ray
        const a = Math.floor((Math.min(y0, y1) - minY) / band), b = Math.floor((Math.max(y0, y1) - minY) / band);
        for (let k = Math.max(0, a); k <= Math.min(n - 1, b); k++) lists[k].push(x0, y0, x1, y1);
      }
    }
    this.bands = lists.map((l) => Float64Array.from(l));
  }

  contains(x: number, y: number): boolean {
    if (x < this.minX || x > this.maxX || y < this.minY || y > this.maxY) return false;
    const edges = this.bands[Math.floor((y - this.minY) / this.band)];
    if (!edges) return false;
    let inside = false;
    for (let i = 0; i < edges.length; i += 4) {
      const x0 = edges[i], y0 = edges[i + 1], x1 = edges[i + 2], y1 = edges[i + 3];
      // Crossing of the ray from (x, y) toward +x, half-open in y so shared vertices count once.
      if ((y0 > y) !== (y1 > y) && x < x0 + ((y - y0) * (x1 - x0)) / (y1 - y0)) inside = !inside;
    }
    return inside;
  }
}

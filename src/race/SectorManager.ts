import type { Track } from '../track/Track';
import type { Sector } from '../types';
import { Vector2 } from '../utils/Vector2';

export interface SectorCrossingResult {
  crossed: boolean;
  sectorEntered: number;
  wrongDirection: boolean;
}

export class SectorManager {
  private sectors: Sector[];
  private trackLength: number;
  private track: Track;

  constructor(track: Track) {
    this.track = track;
    this.trackLength = track.trackPoints.length;
    this.sectors = this.generateSectors();
  }

  private generateSectors(): Sector[] {
    const pointsPerSector = Math.floor(this.trackLength / 3);

    // Calculate initial boundaries
    let s1Start = 0;
    let s2Start = pointsPerSector;
    let s3Start = pointsPerSector * 2;

    // Adjust sector boundaries to avoid overlap zones
    console.log(`Initial S2 at ${s2Start}, S3 at ${s3Start}`);
    // Debug: check intersection counts for initial positions
    this.sectorLineCrossesSelf(s2Start, true);
    this.sectorLineCrossesSelf(s3Start, true);
    s2Start = this.adjustBoundaryAwayFromOverlaps(s2Start);
    s3Start = this.adjustBoundaryAwayFromOverlaps(s3Start);
    console.log(`Final S2 at ${s2Start}, S3 at ${s3Start}`);

    return [
      {
        index: 0,
        startTrackIndex: s1Start,
        endTrackIndex: s2Start - 1,
      },
      {
        index: 1,
        startTrackIndex: s2Start,
        endTrackIndex: s3Start - 1,
      },
      {
        index: 2,
        startTrackIndex: s3Start,
        endTrackIndex: this.trackLength - 1,
      },
    ];
  }

  /**
   * Adjust a sector boundary index to avoid placing it where the sector line
   * would intersect with another part of the track (self-intersection).
   * Searches forward and backward to find the nearest safe position.
   */
  private adjustBoundaryAwayFromOverlaps(index: number): number {
    const searchRange = Math.floor(this.trackLength / 6); // Max 1/6 of track to search
    const minClearanceBuffer = 10; // Require at least 10 consecutive clear points

    // Check if current position crosses through another part of the track
    if (!this.sectorLineCrossesSelf(index)) {
      return index;
    }

    console.log(`Sector boundary at ${index} crosses track, searching for clear position...`);

    // Search forward and backward for a safe position with buffer
    for (let offset = 1; offset <= searchRange; offset++) {
      // Try forward - check that position AND surrounding buffer are all clear
      const forwardIdx = (index + offset) % this.trackLength;
      if (this.isPositionClearWithBuffer(forwardIdx, minClearanceBuffer)) {
        console.log(`  Found clear position at ${forwardIdx} (forward +${offset})`);
        return forwardIdx;
      }

      // Try backward
      const backwardIdx = (index - offset + this.trackLength) % this.trackLength;
      if (this.isPositionClearWithBuffer(backwardIdx, minClearanceBuffer)) {
        console.log(`  Found clear position at ${backwardIdx} (backward -${offset})`);
        return backwardIdx;
      }
    }

    // Couldn't find safe position, return original
    console.log(`  No clear position found within ${searchRange} points, using original`);
    return index;
  }

  /**
   * Check if a position and its surrounding buffer are all clear of track crossings.
   */
  private isPositionClearWithBuffer(index: number, buffer: number): boolean {
    // Check the position itself and points on both sides
    for (let offset = -buffer; offset <= buffer; offset++) {
      const checkIdx = (index + offset + this.trackLength) % this.trackLength;
      if (this.sectorLineCrossesSelf(checkIdx)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Check if a sector line at this track index would cross through
   * another part of the track (making it a bad place for a sector boundary).
   *
   * A valid sector line crosses the track boundary exactly 2 times
   * (once at inner edge, once at outer edge). More crossings = overlap.
   */
  private sectorLineCrossesSelf(index: number, debug: boolean = false): boolean {
    const trackPoint = this.track.trackPoints[index];
    const halfWidth = trackPoint.width / 2;

    // Extend sector line well beyond track edges to ensure we catch boundary crossings
    // Use a larger extension to guarantee we cross the boundary polygons
    const extension = halfWidth * 0.5; // 50% extra beyond track edge
    const sectorStart = trackPoint.position.add(
      trackPoint.normal.scale(halfWidth + extension)
    );
    const sectorEnd = trackPoint.position.subtract(
      trackPoint.normal.scale(halfWidth + extension)
    );

    // Count intersections with inner boundary
    const innerIntersections = this.countLinePolygonIntersections(
      sectorStart, sectorEnd, this.track.innerBoundary
    );

    // Count intersections with outer boundary
    const outerIntersections = this.countLinePolygonIntersections(
      sectorStart, sectorEnd, this.track.outerBoundary
    );

    const totalIntersections = innerIntersections + outerIntersections;

    if (debug) {
      console.log(`  Index ${index}: inner=${innerIntersections}, outer=${outerIntersections}, total=${totalIntersections}`);
      console.log(`    Sector line: (${sectorStart.x.toFixed(1)}, ${sectorStart.y.toFixed(1)}) to (${sectorEnd.x.toFixed(1)}, ${sectorEnd.y.toFixed(1)})`);
      console.log(`    Track pos: (${trackPoint.position.x.toFixed(1)}, ${trackPoint.position.y.toFixed(1)}), halfWidth=${halfWidth.toFixed(1)}`);
      console.log(`    Inner boundary length: ${this.track.innerBoundary.length}, Outer: ${this.track.outerBoundary.length}`);
    }

    // Valid sector line: 1 inner + 1 outer = 2 total
    // More than 2 = sector line crosses through another track section
    return totalIntersections > 2;
  }

  /**
   * Count how many times a line segment intersects the edges of a polygon.
   */
  private countLinePolygonIntersections(
    lineStart: Vector2,
    lineEnd: Vector2,
    polygon: Vector2[]
  ): number {
    let count = 0;
    const n = polygon.length;

    for (let i = 0; i < n; i++) {
      const p1 = polygon[i];
      const p2 = polygon[(i + 1) % n];

      if (this.lineSegmentsIntersect(lineStart, lineEnd, p1, p2)) {
        count++;
      }
    }

    return count;
  }

  /**
   * Check if two line segments intersect.
   */
  private lineSegmentsIntersect(a1: Vector2, a2: Vector2, b1: Vector2, b2: Vector2): boolean {
    const d1 = this.crossProduct(b1, b2, a1);
    const d2 = this.crossProduct(b1, b2, a2);
    const d3 = this.crossProduct(a1, a2, b1);
    const d4 = this.crossProduct(a1, a2, b2);

    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
        ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
      return true;
    }

    return false;
  }

  /**
   * Cross product of vectors (b-a) and (c-a).
   */
  private crossProduct(a: Vector2, b: Vector2, c: Vector2): number {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }

  getSectors(): Sector[] {
    return this.sectors;
  }

  getSectorBoundaries(): number[] {
    return [0, this.sectors[1].startTrackIndex, this.sectors[2].startTrackIndex];
  }

  getSectorForIndex(trackIndex: number): number {
    for (let i = 2; i >= 0; i--) {
      if (trackIndex >= this.sectors[i].startTrackIndex) {
        return i;
      }
    }
    return 0;
  }

  checkSectorCrossing(prevIndex: number, currIndex: number): SectorCrossingResult {
    const result: SectorCrossingResult = {
      crossed: false,
      sectorEntered: -1,
      wrongDirection: false,
    };

    // Handle invalid indices
    if (prevIndex < 0 || currIndex < 0) {
      return result;
    }

    // Check for wrong direction (going backwards)
    // Use modular arithmetic to handle wrap-around
    const forwardDelta = (currIndex - prevIndex + this.trackLength) % this.trackLength;
    const backwardDelta = (prevIndex - currIndex + this.trackLength) % this.trackLength;

    // If backward delta is smaller and significant, we're going the wrong way
    if (backwardDelta < forwardDelta && backwardDelta > 5) {
      result.wrongDirection = true;
    }

    // Check sector boundary crossings
    const prevSector = this.getSectorForIndex(prevIndex);
    const currSector = this.getSectorForIndex(currIndex);

    if (currSector !== prevSector) {
      // Determine if this is a forward crossing
      const expectedNextSector = (prevSector + 1) % 3;

      if (currSector === expectedNextSector) {
        result.crossed = true;
        result.sectorEntered = currSector;
      } else if (!result.wrongDirection) {
        // Crossed multiple sectors or went backwards - mark as wrong direction
        result.wrongDirection = true;
      }
    }

    // Special case: crossing the finish line (wrap from end to start)
    if (prevIndex > this.trackLength - 20 && currIndex < 20) {
      result.crossed = true;
      result.sectorEntered = 0;
      result.wrongDirection = false; // This is the correct direction
    }

    return result;
  }

  getTrackLength(): number {
    return this.trackLength;
  }
}

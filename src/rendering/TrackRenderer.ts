import { Track } from '../track/Track';
import { Vector2 } from '../utils/Vector2';
import { CONFIG } from '../utils/Constants';
import type { SectorManager } from '../race/SectorManager';

export class TrackRenderer {
  private showDebug = false;
  private bankingLogged = false;

  // Cache for static track elements
  private cachedTrackCanvas: HTMLCanvasElement | null = null;
  private cachedTrackCtx: CanvasRenderingContext2D | null = null;
  private cachedTrackSeed: number | null = null;
  private cachedCanvasWidth: number = 0;
  private cachedCanvasHeight: number = 0;
  private cachedScale: number = 1;
  private cachedOffsetX: number = 0;
  private cachedOffsetY: number = 0;

  constructor() {}

  setDebug(show: boolean): void {
    this.showDebug = show;
    // Invalidate cache when debug mode changes since it affects rendering
    this.invalidateCache();
  }

  toggleDebug(): void {
    this.showDebug = !this.showDebug;
    this.invalidateCache();
  }

  /**
   * Invalidate the track cache, forcing a re-render on next frame
   */
  invalidateCache(): void {
    this.cachedTrackSeed = null;
  }

  render(ctx: CanvasRenderingContext2D, track: Track, sectorManager?: SectorManager, scale: number = 1, offsetX: number = 0, offsetY: number = 0): void {
    const canvasWidth = ctx.canvas.width;
    const canvasHeight = ctx.canvas.height;

    // Check if we can use cached track rendering
    const cacheValid = this.cachedTrackCanvas !== null &&
                       this.cachedTrackSeed === track.seed &&
                       this.cachedCanvasWidth === canvasWidth &&
                       this.cachedCanvasHeight === canvasHeight &&
                       this.cachedScale === scale &&
                       this.cachedOffsetX === offsetX &&
                       this.cachedOffsetY === offsetY;

    if (!cacheValid) {
      // Rebuild cache
      this.rebuildCache(track, canvasWidth, canvasHeight, scale, offsetX, offsetY);
    }

    // Draw cached static track elements - reset transform to draw pixel-perfect
    if (this.cachedTrackCanvas) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.cachedTrackCanvas, 0, 0);
      ctx.restore();
    }

    // Draw dynamic elements directly (sector lines change based on sector manager state)
    if (sectorManager) {
      this.drawSectorLines(ctx, track, sectorManager);
    }

    // Debug overlays (not cached as they're typically toggled on/off)
    if (this.showDebug) {
      this.drawCenterline(ctx, track);
      this.drawTrackPoints(ctx, track);
      this.drawBankingDebugLabels(ctx, track);
    }
  }

  /**
   * Rebuild the cached track canvas with all static elements
   */
  private rebuildCache(track: Track, canvasWidth: number, canvasHeight: number, scale: number, offsetX: number, offsetY: number): void {
    // Create or resize cached canvas
    if (!this.cachedTrackCanvas ||
        this.cachedCanvasWidth !== canvasWidth ||
        this.cachedCanvasHeight !== canvasHeight) {
      this.cachedTrackCanvas = document.createElement('canvas');
      this.cachedTrackCanvas.width = canvasWidth;
      this.cachedTrackCanvas.height = canvasHeight;
      this.cachedTrackCtx = this.cachedTrackCanvas.getContext('2d');
    }

    const cacheCtx = this.cachedTrackCtx;
    if (!cacheCtx) return;

    // Clear the cached canvas (transparent background)
    cacheCtx.clearRect(0, 0, canvasWidth, canvasHeight);

    // Apply the same transform as the main canvas (scale * DPR + offset translation)
    // This ensures track is rendered at the correct resolution and position
    const dpr = window.devicePixelRatio || 1;
    const combinedScale = scale * dpr;
    cacheCtx.setTransform(
      combinedScale, 0, 0, combinedScale,
      -offsetX * combinedScale,
      -offsetY * combinedScale
    );

    // Render all static track elements to cache
    // 1. Draw track surface (dark fill)
    this.drawTrackSurface(cacheCtx, track);

    // 2. Draw pit lane or legacy pit zone
    if (track.pitLane) {
      this.drawPitLane(cacheCtx, track);
    } else {
      this.drawPitZone(cacheCtx, track);
    }

    // 3. Draw track outline (F1 minimal style)
    this.drawTrackOutline(cacheCtx, track);

    // 4. Draw banking gradient overlay on turns
    this.drawBankingGradient(cacheCtx, track);

    // 5. Draw walls
    this.drawWalls(cacheCtx, track);

    // 6. Draw start/finish line (static)
    this.drawStartFinishLine(cacheCtx, track);

    // Update cache metadata
    this.cachedTrackSeed = track.seed;
    this.cachedCanvasWidth = canvasWidth;
    this.cachedCanvasHeight = canvasHeight;
    this.cachedScale = scale;
    this.cachedOffsetX = offsetX;
    this.cachedOffsetY = offsetY;
  }

  private drawPitZone(ctx: CanvasRenderingContext2D, track: Track): void {
    const pit = track.pitZone;
    if (!pit) return;

    ctx.save();

    // Transform to pit zone coordinates
    ctx.translate(pit.position.x, pit.position.y);
    ctx.rotate(pit.angle);

    // Draw pit box rectangle
    const halfLength = pit.length / 2;
    const halfWidth = pit.width / 2;

    // Fill with a distinct color
    ctx.fillStyle = '#1a2a1a'; // Slightly green tint
    ctx.fillRect(-halfLength, -halfWidth, pit.length, pit.width);

    // Outline
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 4]);
    ctx.strokeRect(-halfLength, -halfWidth, pit.length, pit.width);
    ctx.setLineDash([]);

    // "PIT" label
    ctx.fillStyle = '#00ff00';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('PIT', 0, 0);

    ctx.restore();
  }

  private drawPitLane(ctx: CanvasRenderingContext2D, track: Track): void {
    const pit = track.pitLane;
    if (!pit || pit.polygon.length < 3) return;

    ctx.save();

    // Draw pit zone polygon fill
    ctx.beginPath();
    ctx.moveTo(pit.polygon[0].x, pit.polygon[0].y);
    for (let i = 1; i < pit.polygon.length; i++) {
      ctx.lineTo(pit.polygon[i].x, pit.polygon[i].y);
    }
    ctx.closePath();
    ctx.fillStyle = '#1a2a1a';  // Dark green surface
    ctx.fill();

    // Draw outline
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // PIT label at center
    ctx.fillStyle = '#00ff00';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('PIT', pit.center.x, pit.center.y);

    ctx.restore();
  }

  private drawTrackSurface(ctx: CanvasRenderingContext2D, track: Track): void {
    if (track.innerBoundary.length === 0 || track.outerBoundary.length === 0) return;

    ctx.beginPath();

    // Draw outer boundary clockwise
    ctx.moveTo(track.outerBoundary[0].x, track.outerBoundary[0].y);
    for (let i = 1; i < track.outerBoundary.length; i++) {
      ctx.lineTo(track.outerBoundary[i].x, track.outerBoundary[i].y);
    }
    ctx.closePath();

    // Draw inner boundary counter-clockwise (creates hole)
    ctx.moveTo(track.innerBoundary[0].x, track.innerBoundary[0].y);
    for (let i = track.innerBoundary.length - 1; i >= 0; i--) {
      ctx.lineTo(track.innerBoundary[i].x, track.innerBoundary[i].y);
    }
    ctx.closePath();

    // Use dirt color for rallycross tracks
    const surfaceColor = track.metadata.surfaceType === 'dirt'
      ? CONFIG.COLORS.RALLYCROSS_SURFACE
      : CONFIG.COLORS.TRACK_SURFACE;
    ctx.fillStyle = surfaceColor;
    ctx.fill('evenodd');
  }

  /**
   * Draw banking gradient overlay on banked sections of the track.
   * Darker at the outer edge where banking is steeper, transparent at inner edge.
   */
  private drawBankingGradient(ctx: CanvasRenderingContext2D, track: Track): void {
    const trackPoints = track.trackPoints;
    if (trackPoints.length < 2) return;

    ctx.save();

    // Log banking stats for debugging (only once per track)
    if (!this.bankingLogged) {
      let posCount = 0, negCount = 0, zeroCount = 0;
      for (const p of trackPoints) {
        if (p.banking > 0.01) posCount++;
        else if (p.banking < -0.01) negCount++;
        else zeroCount++;
      }
      console.log(`[Banking Stats] Positive: ${posCount}, Negative: ${negCount}, Zero: ${zeroCount}`);
      this.bankingLogged = true;
    }

    // Pre-compute track center and infield sign (used for all segments)
    const trackCenter = this.computeTrackCenter(track);
    const samplePoint = trackPoints[0];
    const toCenter = trackCenter.subtract(samplePoint.position);
    let infieldSign = Math.sign(toCenter.dot(samplePoint.normal));
    const isOval = track.metadata.type === 'oval';
    if (isOval) {
      infieldSign = -infieldSign;
    }

    // Find contiguous banked sections and draw gradient quads
    let i = 0;
    while (i < trackPoints.length) {
      const point = trackPoints[i];

      // Skip non-banked sections (check absolute value for signed banking)
      if (Math.abs(point.banking) <= 0.01) {
        i++;
        continue;
      }

      // Found a banked section - collect all consecutive banked points
      const bankedSection: number[] = [];
      while (i < trackPoints.length && Math.abs(trackPoints[i].banking) > 0.01) {
        bankedSection.push(i);
        i++;
      }

      // Also check wrap-around for closed loop
      if (i >= trackPoints.length && Math.abs(trackPoints[0].banking) > 0.01) {
        let j = 0;
        while (j < bankedSection[0] && Math.abs(trackPoints[j].banking) > 0.01) {
          bankedSection.push(j);
          j++;
        }
      }

      // Draw gradient for this banked section
      if (bankedSection.length >= 2) {
        this.drawBankedSectionGradient(ctx, track, bankedSection, isOval, infieldSign);
      }
    }

    ctx.restore();
  }

  /**
   * Draw gradient overlay for a contiguous banked section.
   * Banking darkens the OUTSIDE edge of each turn (the higher, raised edge).
   */
  private drawBankedSectionGradient(
    ctx: CanvasRenderingContext2D,
    track: Track,
    indices: number[],
    isOval: boolean,
    infieldSign: number
  ): void {
    const trackPoints = track.trackPoints;
    const n = trackPoints.length;

    // Check if this section wraps around (entire track is banked)
    // If first and last indices are adjacent in the track (accounting for wrap), close the loop
    const firstIdx = indices[0];
    const lastIdx = indices[indices.length - 1];
    const wrapsAround = (lastIdx + 1) % n === firstIdx;

    // Draw segments between consecutive indices in the section
    const segmentCount = wrapsAround ? indices.length : indices.length - 1;

    for (let i = 0; i < segmentCount; i++) {
      const idx1 = indices[i];
      const idx2 = indices[(i + 1) % indices.length];

      const p1 = trackPoints[idx1];
      const p2 = trackPoints[idx2];

      const banking = Math.max(Math.abs(p1.banking), Math.abs(p2.banking));
      if (banking < 0.02) continue;

      // Determine which edge should be darkened (the raised outside edge)
      let darkOnOutfield: boolean;
      if (isOval) {
        darkOnOutfield = true;
      } else {
        const bankingSign = Math.sign(p1.banking + p2.banking);
        darkOnOutfield = bankingSign < 0;
      }

      // Get all four corners of this track segment quad
      const inner1 = track.innerBoundary[idx1];
      const inner2 = track.innerBoundary[idx2];
      const outer1 = track.outerBoundary[idx1];
      const outer2 = track.outerBoundary[idx2];

      // Determine which boundary is infield vs outfield
      let darkEdge1: Vector2, darkEdge2: Vector2, lightEdge1: Vector2, lightEdge2: Vector2;
      if (darkOnOutfield) {
        if (infieldSign > 0) {
          darkEdge1 = outer1; darkEdge2 = outer2;
          lightEdge1 = inner1; lightEdge2 = inner2;
        } else {
          darkEdge1 = inner1; darkEdge2 = inner2;
          lightEdge1 = outer1; lightEdge2 = outer2;
        }
      } else {
        if (infieldSign > 0) {
          darkEdge1 = inner1; darkEdge2 = inner2;
          lightEdge1 = outer1; lightEdge2 = outer2;
        } else {
          darkEdge1 = outer1; darkEdge2 = outer2;
          lightEdge1 = inner1; lightEdge2 = inner2;
        }
      }

      // Calculate gradient direction (from light edge center to dark edge center)
      const lightCenterX = (lightEdge1.x + lightEdge2.x) * 0.5;
      const lightCenterY = (lightEdge1.y + lightEdge2.y) * 0.5;
      const darkCenterX = (darkEdge1.x + darkEdge2.x) * 0.5;
      const darkCenterY = (darkEdge1.y + darkEdge2.y) * 0.5;

      // Create linear gradient from light to dark edge
      const gradient = ctx.createLinearGradient(
        lightCenterX, lightCenterY,
        darkCenterX, darkCenterY
      );

      // Gradient: transparent at light edge, semi-dark at dark edge
      const intensity = Math.min(0.4, banking * 2); // Scale with banking angle
      gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
      gradient.addColorStop(1, `rgba(0, 0, 0, ${intensity})`);

      // Draw quad from light edge to dark edge
      ctx.beginPath();
      ctx.moveTo(lightEdge1.x, lightEdge1.y);
      ctx.lineTo(lightEdge2.x, lightEdge2.y);
      ctx.lineTo(darkEdge2.x, darkEdge2.y);
      ctx.lineTo(darkEdge1.x, darkEdge1.y);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
    }
  }

  private computeTrackCenter(track: Track): Vector2 {
    let sumX = 0, sumY = 0;
    for (const p of track.trackPoints) {
      sumX += p.position.x;
      sumY += p.position.y;
    }
    return new Vector2(sumX / track.trackPoints.length, sumY / track.trackPoints.length);
  }

  private drawTrackOutline(ctx: CanvasRenderingContext2D, track: Track): void {
    // Draw outline as variable-width stroke along centerline
    // Each segment is stroked with width matching the track width at that point
    const points = track.trackPoints;
    if (points.length < 2) return;

    // Use ochre outline for rallycross/dirt tracks
    const outlineColor = track.metadata.surfaceType === 'dirt'
      ? CONFIG.COLORS.RALLYCROSS_OUTLINE
      : CONFIG.COLORS.TRACK_OUTLINE;
    const surfaceColor = track.metadata.surfaceType === 'dirt'
      ? CONFIG.COLORS.RALLYCROSS_SURFACE
      : CONFIG.COLORS.TRACK_SURFACE;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);

    // OPTIMIZATION: Batch segments by similar widths to reduce stroke() calls
    const n = points.length;
    const widthBuckets = new Map<number, Array<{x1: number, y1: number, x2: number, y2: number}>>();

    for (let i = 0; i < n; i++) {
      const curr = points[i];
      const next = points[(i + 1) % n];
      const width = Math.round((curr.width + next.width) / 2);

      if (!widthBuckets.has(width)) {
        widthBuckets.set(width, []);
      }
      widthBuckets.get(width)!.push({
        x1: curr.position.x, y1: curr.position.y,
        x2: next.position.x, y2: next.position.y
      });
    }

    // Draw outline pass (larger width)
    ctx.strokeStyle = outlineColor;
    for (const [width, segments] of widthBuckets) {
      ctx.lineWidth = width + 4;
      ctx.beginPath();
      for (const seg of segments) {
        ctx.moveTo(seg.x1, seg.y1);
        ctx.lineTo(seg.x2, seg.y2);
      }
      ctx.stroke();
    }

    // Draw surface pass (smaller width - creates outline effect)
    ctx.strokeStyle = surfaceColor;
    for (const [width, segments] of widthBuckets) {
      ctx.lineWidth = width;
      ctx.beginPath();
      for (const seg of segments) {
        ctx.moveTo(seg.x1, seg.y1);
        ctx.lineTo(seg.x2, seg.y2);
      }
      ctx.stroke();
    }
  }

  /**
   * Draw walls as thick gray lines on outer boundary segments where walls exist.
   * Walls are rendered on top of the track outline for visibility.
   */
  private drawWalls(ctx: CanvasRenderingContext2D, track: Track): void {
    if (track.wallSegments.length === 0) return;

    ctx.save();
    ctx.strokeStyle = '#888888';  // Gray concrete color
    ctx.lineWidth = 6;            // Thicker than track outline
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);

    for (const segment of track.wallSegments) {
      ctx.beginPath();
      const startPoint = track.outerBoundary[segment.startIndex];
      ctx.moveTo(startPoint.x, startPoint.y);

      // Draw line through all points in this segment
      for (let i = segment.startIndex + 1; i <= segment.endIndex + 1; i++) {
        const point = track.outerBoundary[i % track.outerBoundary.length];
        ctx.lineTo(point.x, point.y);
      }
      ctx.stroke();
    }

    ctx.restore();
  }

  private drawSectorLines(ctx: CanvasRenderingContext2D, track: Track, sectorManager: SectorManager): void {
    const boundaries = sectorManager.getSectorBoundaries();
    const colors = ['#ffff00', '#00ffff', '#ff00ff']; // S1: yellow, S2: cyan, S3: magenta

    // Skip first boundary (0) as that's the start/finish line
    for (let i = 1; i < boundaries.length; i++) {
      const trackIndex = boundaries[i];
      if (trackIndex >= track.trackPoints.length) continue;

      const point = track.trackPoints[trackIndex];
      const halfWidth = point.width / 2;

      // Calculate line endpoints perpendicular to track
      const start = point.position.add(point.normal.scale(halfWidth));
      const end = point.position.subtract(point.normal.scale(halfWidth));

      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);

      ctx.strokeStyle = colors[i] || '#ffffff';
      ctx.lineWidth = 3;
      ctx.setLineDash([]);
      ctx.stroke();

      // Sector label
      ctx.font = '10px monospace';
      ctx.fillStyle = colors[i] || '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`S${i + 1}`, point.position.x, point.position.y - point.width);
    }
  }

  private drawStartFinishLine(ctx: CanvasRenderingContext2D, track: Track): void {
    const { start, end } = track.startFinishLine;

    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    ctx.setLineDash([]);
    ctx.stroke();

    // Checkered pattern effect (simplified)
    ctx.strokeStyle = '#cccccc';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawCenterline(ctx: CanvasRenderingContext2D, track: Track): void {
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 8]);
    this.strokePath(ctx, track.centerline);
    ctx.setLineDash([]);
  }

  private drawTrackPoints(ctx: CanvasRenderingContext2D, track: Track): void {
    // Draw every Nth track point for debugging
    const step = Math.max(1, Math.floor(track.trackPoints.length / 20));

    for (let i = 0; i < track.trackPoints.length; i += step) {
      const point = track.trackPoints[i];
      const pos = point.position;

      // Draw point
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#ff00ff';
      ctx.fill();

      // Draw normal
      const normalEnd = pos.add(point.normal.scale(20));
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
      ctx.lineTo(normalEnd.x, normalEnd.y);
      ctx.strokeStyle = '#ffff00';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  /**
   * Draw banking angle debug labels at key points in banked sections.
   * Labels appear on the banked edge (outside of each turn).
   */
  private drawBankingDebugLabels(ctx: CanvasRenderingContext2D, track: Track): void {
    const trackPoints = track.trackPoints;
    if (trackPoints.length === 0) return;

    const isOval = track.metadata.type === 'oval';

    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Compute which direction along the normal points toward outfield (away from track center)
    const trackCenter = this.computeTrackCenter(track);
    const samplePoint = trackPoints[0];
    const toCenter = trackCenter.subtract(samplePoint.position);
    const infieldDotNormal = toCenter.dot(samplePoint.normal);
    const outfieldNormalSign = infieldDotNormal > 0 ? -1 : 1;

    // Find banked sections and label them
    let inBankedSection = false;
    let bankedSectionStart = 0;
    let labelCount = 0;

    for (let i = 0; i < trackPoints.length; i++) {
      const point = trackPoints[i];
      const hasBanking = Math.abs(point.banking) > 0.01;

      if (hasBanking && !inBankedSection) {
        inBankedSection = true;
        bankedSectionStart = i;
        labelCount = 0;
      } else if (!hasBanking && inBankedSection) {
        inBankedSection = false;
      }

      if (inBankedSection) {
        const sectionLength = i - bankedSectionStart;
        const shouldLabel =
          sectionLength === 0 ||
          (sectionLength > 0 && sectionLength % Math.max(5, Math.floor(trackPoints.length / 40)) === 0);

        if (shouldLabel && labelCount < 10) {
          const bankingDeg = (Math.abs(point.banking) * 180 / Math.PI).toFixed(1);

          let labelOnOutfield: boolean;
          if (isOval) {
            labelOnOutfield = true;
          } else {
            labelOnOutfield = point.banking < 0;
          }

          const labelSign = labelOnOutfield ? outfieldNormalSign : -outfieldNormalSign;

          const labelOffset = point.width / 2 + 25;
          const labelPos = point.position.add(point.normal.scale(labelSign * labelOffset));

          const text = `${bankingDeg}°`;
          const textWidth = ctx.measureText(text).width;
          ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
          ctx.fillRect(labelPos.x - textWidth/2 - 2, labelPos.y - 6, textWidth + 4, 12);

          ctx.fillStyle = Math.abs(point.banking) > 0.15 ? '#ff8800' : '#88ff88';
          ctx.fillText(text, labelPos.x, labelPos.y);

          labelCount++;
        }
      }
    }

    // Max banking label
    let maxBanking = 0;
    let maxBankingIdx = 0;
    for (let i = 0; i < trackPoints.length; i++) {
      if (Math.abs(trackPoints[i].banking) > Math.abs(maxBanking)) {
        maxBanking = trackPoints[i].banking;
        maxBankingIdx = i;
      }
    }

    if (Math.abs(maxBanking) > 0) {
      const point = trackPoints[maxBankingIdx];
      const bankingDeg = (Math.abs(maxBanking) * 180 / Math.PI).toFixed(1);

      let labelOnOutfield: boolean;
      if (isOval) {
        labelOnOutfield = true;
      } else {
        labelOnOutfield = maxBanking < 0;
      }

      const labelSign = labelOnOutfield ? outfieldNormalSign : -outfieldNormalSign;

      const labelPos = point.position.add(point.normal.scale(labelSign * (point.width / 2 + 45)));

      ctx.fillStyle = 'rgba(255, 0, 0, 0.8)';
      const text = `MAX: ${bankingDeg}°`;
      const textWidth = ctx.measureText(text).width;
      ctx.fillRect(labelPos.x - textWidth/2 - 3, labelPos.y - 7, textWidth + 6, 14);

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 10px monospace';
      ctx.fillText(text, labelPos.x, labelPos.y);
    }
  }

  private strokePath(ctx: CanvasRenderingContext2D, points: Vector2[]): void {
    if (points.length < 2) return;

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }

    ctx.closePath();
    ctx.stroke();
  }
}

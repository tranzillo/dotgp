import { Vector2 } from '../utils/Vector2';
import { Spline } from '../utils/Spline';
import { Track, TrackPoint, PitLane, GPSizeClass, GPTrackShape, OverlapZone } from './Track';

export interface TrackGeneratorConfig {
  seed: number;
  sizeClass: GPSizeClass;
  shape: GPTrackShape;
  numControlPoints: number;
  displacementIterations: number; // How many times to apply midpoint displacement (more = more complex)
  minRadius: number;
  maxRadius: number;
  minWidth: number;
  maxWidth: number;
  roughness: number;
  segmentsPerPoint: number;
  centerX: number;
  centerY: number;
  // Straight length constraints (in track points)
  minStraightLength: number;
  maxStraightLength: number;
  // Banking configuration for sweeping turns
  enableBanking: boolean;
  maxBankingAngle: number; // Maximum banking in radians (at turn apex)
  // Dogleg configuration for front straight
  maxDoglegAngle: number; // Maximum dogleg angle in radians (kink in the straight)
}

/**
 * Size class constraints for GP tracks.
 * Park: Smallest, tightest tracks (street circuits, park courses)
 * Circuit: Medium-sized racing circuits
 * Autodrome: Large, wide professional racing facilities
 */
interface GPSizeClassConstraints {
  minRadius: { min: number; max: number };
  maxRadius: { min: number; max: number };
  minWidth: { min: number; max: number };
  maxWidth: { min: number; max: number };
  roughness: { min: number; max: number };
  straightLength: { min: number; max: number }; // In track points
  numControlPoints: { min: number; max: number }; // Base corners before displacement
  displacementIterations: { min: number; max: number }; // More = more complex track
  allowedShapes: GPTrackShape[]; // Which shapes can appear for this size class
  maxBankingAngle: { min: number; max: number }; // Banking angle range in radians
  maxDoglegAngle: { min: number; max: number }; // Dogleg angle range in radians for front straight
}

const GP_SIZE_CLASS_CONSTRAINTS: Record<GPSizeClass, GPSizeClassConstraints> = {
  park: {
    minRadius: { min: 240, max: 320 },
    maxRadius: { min: 400, max: 480 },
    minWidth: { min: 28, max: 42 },
    maxWidth: { min: 58, max: 90 },
    roughness: { min: 28, max: 50 },
    straightLength: { min: 70, max: 100 },
    numControlPoints: { min: 6, max: 8 }, // Fewer corners for tight park circuits
    displacementIterations: { min: 1, max: 1.05 }, // Less complexity
    allowedShapes: ['circular', 'elongated'],
    maxBankingAngle: { min: 0.05, max: 0.15 }, // ~3-6 degrees - minimal banking for tight tracks
    maxDoglegAngle: { min: -0.16, max: 0.16 }, // ~1-2 degrees - subtle kink for tight tracks
  },
  circuit: {
    minRadius: { min: 420, max: 500 },
    maxRadius: { min: 640, max: 820 },
    minWidth: { min: 32, max: 60 },
    maxWidth: { min: 80, max: 120 },
    roughness: { min: 30, max: 60 },
    straightLength: { min: 100, max: 140 },
    numControlPoints: { min: 8, max: 9 }, // Medium corner count
    displacementIterations: { min: 1.05, max: 1.125 }, // Moderate complexity
    allowedShapes: ['circular', 'elongated'],
    maxBankingAngle: { min: 0.12, max: 0.32 }, // ~7-10 degrees - moderate banking
    maxDoglegAngle: { min: -0.24, max: 0.24 }, // ~2-3 degrees - moderate kink
  },
  autodrome: {
    minRadius: { min: 620, max: 760 },
    maxRadius: { min: 900, max: 1680 },
    minWidth: { min: 48, max: 72 },
    maxWidth: { min: 110, max: 128 },
    roughness: { min: 40, max: 60 },
    straightLength: { min: 120, max: 180 },
    numControlPoints: { min: 12, max: 14 }, // Many corners for large tracks
    displacementIterations: { min: 1.2, max: 1.4 }, // More complex layouts
    allowedShapes: ['circular', 'elongated'],
    maxBankingAngle: { min: 0.25, max: 0.5 }, // ~9-14 degrees - more banking for wide sweepers
    maxDoglegAngle: { min: -0.32, max: 0.32 }, // ~2-4 degrees - more noticeable kink for long straights
  },
};

// Center must be at least maxRadius + roughness + padding from origin
// to ensure track stays in positive coordinate space
// Center values of 0 signal that they should be auto-calculated for minimal canvas usage
const DEFAULT_CONFIG: TrackGeneratorConfig = {
  seed: Date.now(),
  sizeClass: 'circuit',
  shape: 'circular',
  numControlPoints: 10,
  displacementIterations: 2,
  minRadius: 420,
  maxRadius: 640,
  minWidth: 28,
  maxWidth: 100,
  roughness: 100,
  segmentsPerPoint: 20,
  centerX: 0, // Auto-calculated to minimize canvas space
  centerY: 0, // Auto-calculated to minimize canvas space
  minStraightLength: 50,
  maxStraightLength: 70,
  enableBanking: true,
  maxBankingAngle: 0.15, // ~9 degrees - subtle banking for GP tracks
  maxDoglegAngle: 0.04, // ~2.3 degrees - subtle kink in front straight
};

export class TrackGenerator {
  private config: TrackGeneratorConfig;
  private rng: () => number;

  constructor(config: Partial<TrackGeneratorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.rng = this.createSeededRandom(this.config.seed);

    // Calculate minimum center coordinates based on track shape
    // For elongated tracks, X needs more space than Y due to aspect ratio
    const padding = 20;
    const { maxRadius, roughness, shape } = this.config;

    if (shape === 'elongated') {
      // Elongated tracks use aspect ratio 1.5:1 to 2.5:1
      // Use max aspect ratio (2.5) to ensure enough space for any generated track
      const maxAspectRatio = 2.5;
      const perimeterScale = Math.sqrt((1 + maxAspectRatio) / 2);
      const maxRadiusX = maxRadius * perimeterScale;
      const maxRadiusY = maxRadius * perimeterScale / maxAspectRatio;

      const minCenterX = maxRadiusX + roughness + padding;
      const minCenterY = maxRadiusY + roughness + padding;

      this.config.centerX = this.config.centerX > 0 ? Math.max(this.config.centerX, minCenterX) : minCenterX;
      this.config.centerY = this.config.centerY > 0 ? Math.max(this.config.centerY, minCenterY) : minCenterY;
    } else {
      // Circular tracks use same radius for both axes
      const minCenter = maxRadius + roughness + padding;
      this.config.centerX = this.config.centerX > 0 ? Math.max(this.config.centerX, minCenter) : minCenter;
      this.config.centerY = this.config.centerY > 0 ? Math.max(this.config.centerY, minCenter) : minCenter;
    }
  }

  /**
   * Create a seeded random number generator
   */
  private createSeededRandom(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  }

  /**
   * Generate a complete track
   */
  generate(): Track {
    // Step 1: Generate control points in a rough circle
    const controlPoints = this.generateControlPoints();

    // Step 2: Apply displacement iterations for variation
    // Each iteration adds midpoints and displaces them, increasing complexity
    let displacedPoints = controlPoints;
    for (let i = 0; i < this.config.displacementIterations; i++) {
      // Reduce roughness for each iteration to avoid over-displacement
      const iterationRoughness = this.config.roughness / (i + 1);
      displacedPoints = this.displaceMidpoints(displacedPoints, iterationRoughness);
    }

    // Step 3: Generate smooth centerline with Catmull-Rom spline
    const splineCenterline = Spline.generateClosedSpline(displacedPoints, this.config.segmentsPerPoint);

    // Step 4: Generate tangents for each centerline point
    const tangents = Spline.generateClosedSplineTangents(displacedPoints, this.config.segmentsPerPoint);

    // Step 5: Generate track width variation
    const widths = this.generateWidthVariation(splineCenterline.length);

    // Step 6: Create track points with position, width, tangent, normal
    let trackPoints = this.createTrackPoints(splineCenterline, tangents, widths);

    // Step 7: Find best location for upward-facing front straight
    // Straight length varies based on size class
    const { minStraightLength, maxStraightLength } = this.config;
    const straightLength = Math.floor(minStraightLength + this.rng() * (maxStraightLength - minStraightLength));
    const { startIdx } = this.findUpwardSegment(trackPoints, straightLength);
    const endIdx = (startIdx + straightLength) % trackPoints.length;

    // Step 8: Replace that segment with a straight
    trackPoints = this.replaceStraight(trackPoints, startIdx, endIdx);

    // Step 9: Smooth transitions between straight and curved sections
    trackPoints = this.smoothTransitions(trackPoints);

    // Step 10: Rotate so start/finish is at middle of front straight
    // After replaceStraight, the straight starts at startIdx in the new array
    trackPoints = this.rotateToStartLine(trackPoints, startIdx, straightLength);

    // Step 11: Analyze track and apply banking to sweeping turns
    if (this.config.enableBanking) {
      trackPoints = this.applyBankingToTurns(trackPoints);
    }

    // Step 12: Generate inner and outer boundaries
    const { inner, outer } = this.generateBoundaries(trackPoints);

    // Step 13: Detect self-intersecting track sections and create overlap zones
    const overlapZones = this.detectOverlapZones(trackPoints);

    // Step 14: Generate polygon pit lane on infield side
    const pitLane = this.generatePitLane(trackPoints, straightLength);

    // Step 15: Update centerline from final track points
    const centerline = trackPoints.map((p) => p.position);

    return new Track(centerline, trackPoints, inner, outer, this.config.seed, undefined, { type: 'grandprix', gpSizeClass: this.config.sizeClass, gpTrackShape: this.config.shape }, pitLane, undefined, undefined, overlapZones);
  }

  /**
   * Find the segment of track where tangent is closest to pointing upward (-Y direction)
   */
  private findUpwardSegment(trackPoints: TrackPoint[], segmentLength: number): { startIdx: number; endIdx: number } {
    const targetDirection = new Vector2(0, -1); // UP in screen coords

    let bestStartIdx = 0;
    let bestScore = -Infinity;

    // Scan through track to find segment with best upward alignment
    for (let i = 0; i < trackPoints.length; i++) {
      let score = 0;
      // Average alignment over segment
      for (let j = 0; j < segmentLength; j++) {
        const idx = (i + j) % trackPoints.length;
        score += trackPoints[idx].tangent.dot(targetDirection);
      }
      if (score > bestScore) {
        bestScore = score;
        bestStartIdx = i;
      }
    }

    return {
      startIdx: bestStartIdx,
      endIdx: (bestStartIdx + segmentLength) % trackPoints.length,
    };
  }

  /**
   * Replace a curved segment with straight track points.
   * Adds a subtle dogleg (kink) to prevent perfectly straight lines.
   * Uses wider track width on the straight and into the first turn.
   */
  private replaceStraight(
    trackPoints: TrackPoint[],
    startIdx: number,
    endIdx: number
  ): TrackPoint[] {
    const n = trackPoints.length;

    // Get entry and exit points (these stay fixed for smooth transition)
    const entryPoint = trackPoints[startIdx];
    const exitPoint = trackPoints[endIdx];

    // Calculate straight direction and length
    const direction = exitPoint.position.subtract(entryPoint.position);
    const length = direction.magnitude();
    const baseTangent = direction.normalize();
    const baseNormal = baseTangent.perpendicular();

    // Calculate how many points we're replacing
    let segmentCount = endIdx - startIdx;
    if (segmentCount < 0) segmentCount += n; // Handle wrap-around

    // Generate a random dogleg angle using config (always positive, direction determined below)
    const doglegAngle = this.rng() * this.config.maxDoglegAngle;

    // Dogleg position along the straight (randomized between 30-70% of the way)
    const doglegPosition = 0.3 + this.rng() * 0.4;

    // Determine which direction is OUTWARD from track center
    // The dogleg should bow away from the infield (toward the outside of the track)
    const trackCenter = this.getTrackCenter(trackPoints);
    const straightMidpoint = entryPoint.position.add(direction.scale(0.5));
    const toCenter = trackCenter.subtract(straightMidpoint);
    // outwardSign: positive if baseNormal points away from center, negative if toward center
    const outwardSign = toCenter.dot(baseNormal) < 0 ? 1 : -1;

    // Use the UPPER end of track width for the straight (prevents pile-ups at race start)
    // Take the wider of entry/exit widths, then bias toward maxWidth
    const baseWidth = Math.max(entryPoint.width, exitPoint.width);
    const straightWidth = baseWidth + (this.config.maxWidth - baseWidth) * 0.6;

    // Helper function to calculate lateral offset at a given t
    const calcLateralOffset = (t: number): number => {
      let offset = 0;
      if (t < doglegPosition) {
        // Ramp up to dogleg peak
        offset = Math.sin((t / doglegPosition) * Math.PI / 2) * Math.tan(doglegAngle) * length * doglegPosition;
      } else {
        // Ramp down from dogleg peak
        const remainingT = (t - doglegPosition) / (1 - doglegPosition);
        offset = Math.cos(remainingT * Math.PI / 2) * Math.tan(doglegAngle) * length * doglegPosition;
      }
      return offset * outwardSign; // Apply outward direction
    };

    // Generate replacement straight points with dogleg
    const straightPoints: TrackPoint[] = [];

    for (let i = 0; i <= segmentCount; i++) {
      const t = i / segmentCount;

      // Calculate position with dogleg offset (bowing outward from track center)
      const lateralOffset = calcLateralOffset(t);

      // Calculate position along the main axis plus lateral offset
      const mainPosition = entryPoint.position.add(baseTangent.scale(length * t));
      const position = mainPosition.add(baseNormal.scale(lateralOffset));

      // Calculate local tangent (derivative of position)
      // For smooth transitions, compute tangent from position change
      let tangent = baseTangent;
      let normal = baseNormal;

      if (i > 0 && i < segmentCount) {
        // Approximate tangent from neighboring points for smoothness
        const prevT = (i - 1) / segmentCount;
        const nextT = (i + 1) / segmentCount;

        const prevOffset = calcLateralOffset(prevT);
        const nextOffset = calcLateralOffset(nextT);

        const prevPos = entryPoint.position.add(baseTangent.scale(length * prevT)).add(baseNormal.scale(prevOffset));
        const nextPos = entryPoint.position.add(baseTangent.scale(length * nextT)).add(baseNormal.scale(nextOffset));

        tangent = nextPos.subtract(prevPos).normalize();
        normal = tangent.perpendicular();
      }

      straightPoints.push({
        position,
        width: straightWidth,
        tangent,
        normal,
        banking: 0,
      });
    }

    // Build new track: [0..startIdx] + straightPoints + [endIdx..n]
    const before = trackPoints.slice(0, startIdx);
    const after = trackPoints.slice(endIdx + 1);

    // Apply wider width to the first turn after the straight (prevents pile-ups)
    // The "after" section starts immediately after the straight ends
    const turnWidthExtension = Math.min(30, Math.floor(after.length * 0.15)); // Extend width into ~15% of remaining track or 30 points
    for (let i = 0; i < turnWidthExtension && i < after.length; i++) {
      // Gradually taper from straight width back to original width
      const taperT = i / turnWidthExtension;
      const taperFactor = 1 - taperT * taperT; // Quadratic ease-out
      after[i] = {
        ...after[i],
        width: after[i].width + (straightWidth - after[i].width) * taperFactor,
      };
    }

    return [...before, ...straightPoints, ...after];
  }

  /**
   * Rotate track points so start/finish is at middle of front straight
   */
  private rotateToStartLine(trackPoints: TrackPoint[], straightStartIdx: number, straightLength: number): TrackPoint[] {
    // Start line should be at middle of front straight
    const startIdx = (straightStartIdx + Math.floor(straightLength / 2)) % trackPoints.length;

    // Rotate array so startIdx becomes index 0
    return [...trackPoints.slice(startIdx), ...trackPoints.slice(0, startIdx)];
  }

  /**
   * Analyze the track for sweeping turns and apply banking.
   * Banking is applied to sustained turns that meet criteria:
   * - Minimum turn length (consecutive points turning same direction)
   * - Curvature in the "sweeper" range (not too tight, not too gentle)
   * - Adequate track width
   */
  private applyBankingToTurns(trackPoints: TrackPoint[]): TrackPoint[] {
    // Calculate curvature at each point (change in tangent direction)
    const curvatures = this.calculateCurvatures(trackPoints);

    // Find turn segments (consecutive points with consistent curvature direction)
    const turnSegments = this.findTurnSegments(curvatures, trackPoints);

    // Apply banking to eligible turn segments
    const bankedPoints = trackPoints.map((p) => ({ ...p })); // Clone

    for (const segment of turnSegments) {
      this.applyBankingToSegment(bankedPoints, segment);
    }

    // Smooth banking transitions
    return this.smoothBanking(bankedPoints);
  }

  /**
   * Calculate curvature (rate of tangent direction change) at each track point.
   * Positive = turning left, Negative = turning right
   */
  private calculateCurvatures(trackPoints: TrackPoint[]): number[] {
    const n = trackPoints.length;
    const curvatures: number[] = [];

    for (let i = 0; i < n; i++) {
      const curr = trackPoints[i];
      const next = trackPoints[(i + 1) % n];

      // Calculate angle change between consecutive tangents
      const angle1 = Math.atan2(curr.tangent.y, curr.tangent.x);
      const angle2 = Math.atan2(next.tangent.y, next.tangent.x);

      // Normalize angle difference to [-PI, PI]
      let angleDiff = angle2 - angle1;
      while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
      while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

      curvatures.push(angleDiff);
    }

    return curvatures;
  }

  /**
   * Find contiguous segments where the track is turning consistently in one direction.
   * Returns segments that meet minimum length and curvature criteria.
   */
  private findTurnSegments(
    curvatures: number[],
    trackPoints: TrackPoint[]
  ): { startIdx: number; endIdx: number; direction: number; avgCurvature: number }[] {
    const n = curvatures.length;
    const segments: { startIdx: number; endIdx: number; direction: number; avgCurvature: number }[] = [];

    // Thresholds for turn detection - banking is a RARE feature for exceptionally long sweepers
    const minTurnLength = 35; // Minimum points - must be a long sustained turn
    const minCurvature = 0.012; // Minimum curvature to be "turning" (radians/point)
    const maxCurvature = 0.04; // Maximum curvature - only gentle sweepers, not medium turns
    const minAvgWidth = 70; // Minimum average width - only wide sections get banking

    let segmentStart = -1;
    let segmentDirection = 0;
    let curvatureSum = 0;
    let widthSum = 0;
    let segmentLength = 0;

    for (let i = 0; i <= n; i++) {
      const idx = i % n;
      const curvature = curvatures[idx];
      const absCurvature = Math.abs(curvature);
      const direction = curvature > 0 ? 1 : curvature < 0 ? -1 : 0;

      // Check if this point continues the current turn segment
      const isTurning = absCurvature >= minCurvature && absCurvature <= maxCurvature;
      const sameDirection = direction === segmentDirection || segmentDirection === 0;

      if (isTurning && sameDirection && segmentStart >= 0) {
        // Continue the segment
        curvatureSum += curvature;
        widthSum += trackPoints[idx].width;
        segmentLength++;
        if (segmentDirection === 0) segmentDirection = direction;
      } else {
        // End current segment if it exists and meets criteria
        if (segmentStart >= 0 && segmentLength >= minTurnLength) {
          const avgWidth = widthSum / segmentLength;
          const avgCurvature = curvatureSum / segmentLength;

          if (avgWidth >= minAvgWidth) {
            segments.push({
              startIdx: segmentStart,
              endIdx: (segmentStart + segmentLength - 1) % n,
              direction: segmentDirection,
              avgCurvature,
            });
          }
        }

        // Start new segment if this point is turning
        if (isTurning && i < n) {
          segmentStart = idx;
          segmentDirection = direction;
          curvatureSum = curvature;
          widthSum = trackPoints[idx].width;
          segmentLength = 1;
        } else {
          segmentStart = -1;
          segmentDirection = 0;
          curvatureSum = 0;
          widthSum = 0;
          segmentLength = 0;
        }
      }
    }

    return segments;
  }

  /**
   * Apply banking to a turn segment using sine interpolation (like ovals).
   * Banking peaks at the apex (middle) of the turn.
   */
  private applyBankingToSegment(
    trackPoints: TrackPoint[],
    segment: { startIdx: number; endIdx: number; direction: number; avgCurvature: number }
  ): void {
    const n = trackPoints.length;

    // Calculate segment length handling wrap-around
    let length = segment.endIdx - segment.startIdx + 1;
    if (length <= 0) length += n;

    // Scale banking based on curvature intensity (more curvature = more banking)
    // Normalize to 0-1 range within our curvature bounds
    const minCurvature = 0.008;
    const maxCurvature = 0.06;
    const curvatureIntensity = Math.min(1, (Math.abs(segment.avgCurvature) - minCurvature) / (maxCurvature - minCurvature));

    // Max banking scaled by curvature intensity
    const effectiveMaxBanking = this.config.maxBankingAngle * (0.4 + 0.6 * curvatureIntensity);

    for (let i = 0; i < length; i++) {
      const idx = (segment.startIdx + i) % n;

      // Sine interpolation: 0 at entry/exit, peaks at apex
      const t = i / (length - 1);
      const bankingFactor = Math.sin(t * Math.PI);

      // Apply banking with NEGATED direction so that:
      // - Right turn (dir=-1, clockwise track): banking=+1 → gradient on outfield (correct outside of turn)
      // - Left turn (dir=+1, counterclockwise track): banking=-1 → gradient on infield (correct outside of turn)
      trackPoints[idx].banking = effectiveMaxBanking * bankingFactor * -segment.direction;
    }
  }

  /**
   * Smooth banking transitions using a moving average to prevent abrupt changes.
   */
  private smoothBanking(trackPoints: TrackPoint[]): TrackPoint[] {
    const n = trackPoints.length;
    const windowSize = 5;

    const smoothed: TrackPoint[] = [];

    for (let i = 0; i < n; i++) {
      let bankingSum = 0;
      let count = 0;

      for (let j = -windowSize; j <= windowSize; j++) {
        const idx = (i + j + n) % n;
        bankingSum += trackPoints[idx].banking;
        count++;
      }

      smoothed.push({
        ...trackPoints[i],
        banking: bankingSum / count,
      });
    }

    return smoothed;
  }

  /**
   * Smooth width and tangent transitions using a moving average.
   * This prevents abrupt jumps where the straight meets the curved sections.
   */
  private smoothTransitions(points: TrackPoint[]): TrackPoint[] {
    if (points.length < 5) return points;

    const windowSize = Math.min(8, Math.floor(points.length / 10));
    if (windowSize < 2) return points;

    const smoothed: TrackPoint[] = [];

    for (let i = 0; i < points.length; i++) {
      const point = points[i];

      // Calculate average width over the window
      let widthSum = 0;
      let count = 0;

      for (let j = -windowSize; j <= windowSize; j++) {
        // Wrap around for closed loop
        const idx = (i + j + points.length) % points.length;
        widthSum += points[idx].width;
        count++;
      }

      const avgWidth = widthSum / count;

      smoothed.push({
        position: point.position,
        tangent: point.tangent,
        normal: point.normal,
        width: avgWidth,
        banking: point.banking,
      });
    }

    return smoothed;
  }

  /**
   * Generate polygon-based pit lane on infield side of front straight.
   * Pit lane stretches the full length of the straight, attached to the infield edge.
   */
  private generatePitLane(trackPoints: TrackPoint[], straightLength: number): PitLane {
    const pitWidth = 50;
    const pitGap = 5;

    // Pit lane runs the full length of front straight (index 0 is middle of straight)
    // Use small margin at ends for smooth visual transition
    const halfStraight = Math.floor(straightLength / 2);
    const margin = 3;
    const pitStartIdx = -halfStraight + margin;
    const pitEndIdx = halfStraight - margin;

    // Build polygon along inside edge
    const innerEdgePoints: Vector2[] = [];
    const outerEdgePoints: Vector2[] = [];

    // For GP tracks, determine which side is "inside" based on track center
    const trackCenter = this.getTrackCenter(trackPoints);
    const samplePoint = trackPoints[0];
    const toCenter = trackCenter.subtract(samplePoint.position);
    const insideSign = Math.sign(toCenter.dot(samplePoint.normal));

    for (let i = pitStartIdx; i <= pitEndIdx; i++) {
      const idx = (i + trackPoints.length) % trackPoints.length;
      const point = trackPoints[idx];
      const halfWidth = point.width / 2;

      // Inside edge (toward center of track)
      const innerEdge = point.position.add(point.normal.scale(insideSign * (halfWidth + pitGap)));
      const outerEdge = point.position.add(point.normal.scale(insideSign * (halfWidth + pitGap + pitWidth)));

      innerEdgePoints.push(innerEdge);
      outerEdgePoints.push(outerEdge);
    }

    const polygon = [...innerEdgePoints, ...outerEdgePoints.reverse()];
    const center = this.calculatePolygonCenter(polygon);

    return { polygon, center };
  }

  /**
   * Calculate the centroid of a polygon
   */
  private calculatePolygonCenter(polygon: Vector2[]): Vector2 {
    let sumX = 0,
      sumY = 0;
    for (const p of polygon) {
      sumX += p.x;
      sumY += p.y;
    }
    return new Vector2(sumX / polygon.length, sumY / polygon.length);
  }

  /**
   * Get the center of all track points
   */
  private getTrackCenter(trackPoints: TrackPoint[]): Vector2 {
    let sumX = 0,
      sumY = 0;
    for (const p of trackPoints) {
      sumX += p.position.x;
      sumY += p.position.y;
    }
    return new Vector2(sumX / trackPoints.length, sumY / trackPoints.length);
  }

  /**
   * Generate control points based on the configured shape
   */
  private generateControlPoints(): Vector2[] {
    switch (this.config.shape) {
      case 'elongated':
        return this.generateElongatedPoints();
      case 'circular':
      default:
        return this.generateCircularPoints();
    }
  }

  /**
   * Generate control points in a circular pattern with radius variation
   */
  private generateCircularPoints(): Vector2[] {
    const points: Vector2[] = [];
    const { numControlPoints, minRadius, maxRadius, centerX, centerY } = this.config;

    for (let i = 0; i < numControlPoints; i++) {
      const angle = (i / numControlPoints) * Math.PI * 2;
      const radius = minRadius + this.rng() * (maxRadius - minRadius);

      points.push(
        new Vector2(centerX + Math.cos(angle) * radius, centerY + Math.sin(angle) * radius)
      );
    }

    return points;
  }

  /**
   * Generate control points in an elongated ellipse pattern.
   * Uses a randomized aspect ratio between 1.5:1 and 2.5:1.
   * Scales radii to maintain similar perimeter/track length as circular tracks.
   */
  private generateElongatedPoints(): Vector2[] {
    const points: Vector2[] = [];
    const { numControlPoints, minRadius, maxRadius, centerX, centerY } = this.config;

    // Randomized aspect ratio for variety (1.5:1 to 2.5:1)
    const aspectRatio = 1.5 + this.rng() * 1.0;

    // Compensate for aspect ratio to maintain similar perimeter
    // Ellipse perimeter ≈ π * (3(a+b) - √((3a+b)(a+3b))) (Ramanujan approximation)
    // For a circle of radius r: perimeter = 2πr
    // For an ellipse with a=r, b=r/aspectRatio: we need to scale up
    // Approximate scale factor to keep perimeter similar: √((1 + aspectRatio) / 2)
    const perimeterScale = Math.sqrt((1 + aspectRatio) / 2);

    for (let i = 0; i < numControlPoints; i++) {
      const angle = (i / numControlPoints) * Math.PI * 2;
      // Base radius with variation, scaled up to compensate for compression
      const baseRadius = minRadius + this.rng() * (maxRadius - minRadius);
      const scaledRadius = baseRadius * perimeterScale;
      // Ellipse: x uses scaled radius, y is compressed by aspect ratio
      const radiusX = scaledRadius;
      const radiusY = scaledRadius / aspectRatio;

      points.push(
        new Vector2(centerX + Math.cos(angle) * radiusX, centerY + Math.sin(angle) * radiusY)
      );
    }

    return points;
  }

  /**
   * Add displaced midpoints between control points for more variation
   */
  private displaceMidpoints(points: Vector2[], roughness?: number): Vector2[] {
    const result: Vector2[] = [];
    const maxDisplacement = roughness ?? this.config.roughness;

    for (let i = 0; i < points.length; i++) {
      const curr = points[i];
      const next = points[(i + 1) % points.length];

      result.push(curr);

      // Calculate midpoint
      const mid = curr.add(next).scale(0.5);

      // Calculate perpendicular direction
      const direction = next.subtract(curr);
      const perpendicular = direction.perpendicular().normalize();

      // Apply random displacement
      const offset = (this.rng() - 0.5) * 2 * maxDisplacement;
      result.push(mid.add(perpendicular.scale(offset)));
    }

    return result;
  }

  /**
   * Generate varying track widths along the centerline
   */
  private generateWidthVariation(count: number): number[] {
    const { minWidth, maxWidth } = this.config;
    const widths: number[] = [];

    // Generate a few random width control points
    const numWidthPoints = 6;
    const widthControlPoints: number[] = [];
    for (let i = 0; i < numWidthPoints; i++) {
      widthControlPoints.push(minWidth + this.rng() * (maxWidth - minWidth));
    }

    // Interpolate widths smoothly
    for (let i = 0; i < count; i++) {
      const t = (i / count) * numWidthPoints;
      const index = Math.floor(t) % numWidthPoints;
      const nextIndex = (index + 1) % numWidthPoints;
      const frac = t - Math.floor(t);

      // Smooth interpolation
      const smoothFrac = frac * frac * (3 - 2 * frac);
      const width =
        widthControlPoints[index] * (1 - smoothFrac) + widthControlPoints[nextIndex] * smoothFrac;

      widths.push(width);
    }

    return widths;
  }

  /**
   * Create track points with all necessary data
   */
  private createTrackPoints(
    centerline: Vector2[],
    tangents: Vector2[],
    widths: number[]
  ): TrackPoint[] {
    const trackPoints: TrackPoint[] = [];

    for (let i = 0; i < centerline.length; i++) {
      const tangent = tangents[i] || new Vector2(1, 0);
      const normal = tangent.perpendicular();

      trackPoints.push({
        position: centerline[i],
        width: widths[i],
        tangent,
        normal,
        banking: 0, // Grand Prix tracks have no banking
      });
    }

    return trackPoints;
  }

  /**
   * Detect self-intersecting sections of the track and create overlap zones.
   * An overlap zone is created when two non-adjacent track segments are close enough
   * that their widths would overlap visually.
   */
  private detectOverlapZones(trackPoints: TrackPoint[]): OverlapZone[] {
    const zones: OverlapZone[] = [];
    const n = trackPoints.length;
    const minSeparation = 30; // Minimum index separation to consider (skip adjacent segments)
    const visited = new Set<string>();

    for (let i = 0; i < n; i++) {
      const p1 = trackPoints[i];

      for (let j = i + minSeparation; j < n; j++) {
        // Skip if too close in track order (would wrap around)
        if (j > n - minSeparation && i < minSeparation) continue;

        const p2 = trackPoints[j];
        const distance = p1.position.distanceTo(p2.position);
        const combinedHalfWidths = (p1.width + p2.width) / 2;

        // Check if track segments overlap
        if (distance < combinedHalfWidths * 1.2) {
          // Create a unique key for this overlap pair region
          const regionKey = `${Math.floor(i / 10)}-${Math.floor(j / 10)}`;
          if (visited.has(regionKey)) continue;
          visited.add(regionKey);

          // Create overlap zone polygon from the overlapping points
          const polygon = this.createOverlapPolygon(p1, p2);
          if (polygon.length >= 3) {
            zones.push({ polygon });
          }
        }
      }
    }

    // Merge nearby zones into larger polygons
    return this.mergeOverlapZones(zones);
  }

  /**
   * Create a polygon covering the overlap between two track points.
   */
  private createOverlapPolygon(p1: TrackPoint, p2: TrackPoint): Vector2[] {
    const hw1 = p1.width / 2 + 5; // Add padding
    const hw2 = p2.width / 2 + 5;

    // Get the four corners of each track segment
    const p1Left = p1.position.add(p1.normal.scale(hw1));
    const p1Right = p1.position.add(p1.normal.scale(-hw1));
    const p2Left = p2.position.add(p2.normal.scale(hw2));
    const p2Right = p2.position.add(p2.normal.scale(-hw2));

    // Return a polygon that covers the overlap region
    return [p1Left, p1Right, p2Right, p2Left];
  }

  /**
   * Merge nearby overlap zones into larger consolidated zones.
   */
  private mergeOverlapZones(zones: OverlapZone[]): OverlapZone[] {
    if (zones.length <= 1) return zones;

    // Simple approach: merge zones whose centers are close
    const merged: OverlapZone[] = [];
    const used = new Set<number>();

    for (let i = 0; i < zones.length; i++) {
      if (used.has(i)) continue;

      const center1 = this.polygonCenter(zones[i].polygon);
      const combinedPoints: Vector2[] = [...zones[i].polygon];

      for (let j = i + 1; j < zones.length; j++) {
        if (used.has(j)) continue;

        const center2 = this.polygonCenter(zones[j].polygon);
        if (center1.distanceTo(center2) < 100) {
          combinedPoints.push(...zones[j].polygon);
          used.add(j);
        }
      }

      // Create convex hull of combined points
      const hull = this.convexHull(combinedPoints);
      merged.push({ polygon: hull });
      used.add(i);
    }

    return merged;
  }

  /**
   * Calculate center of a polygon.
   */
  private polygonCenter(polygon: Vector2[]): Vector2 {
    let sumX = 0, sumY = 0;
    for (const p of polygon) {
      sumX += p.x;
      sumY += p.y;
    }
    return new Vector2(sumX / polygon.length, sumY / polygon.length);
  }

  /**
   * Compute convex hull using Graham scan algorithm.
   */
  private convexHull(points: Vector2[]): Vector2[] {
    if (points.length < 3) return points;

    // Find the bottom-most point (or left-most in case of tie)
    let start = 0;
    for (let i = 1; i < points.length; i++) {
      if (points[i].y > points[start].y ||
          (points[i].y === points[start].y && points[i].x < points[start].x)) {
        start = i;
      }
    }

    const pivot = points[start];

    // Sort points by polar angle with respect to pivot
    const sorted = points
      .filter((_, i) => i !== start)
      .sort((a, b) => {
        const angleA = Math.atan2(a.y - pivot.y, a.x - pivot.x);
        const angleB = Math.atan2(b.y - pivot.y, b.x - pivot.x);
        return angleA - angleB;
      });

    // Build hull
    const hull: Vector2[] = [pivot];

    for (const point of sorted) {
      while (hull.length > 1 && this.crossProduct(hull[hull.length - 2], hull[hull.length - 1], point) <= 0) {
        hull.pop();
      }
      hull.push(point);
    }

    return hull;
  }

  /**
   * Cross product of vectors OA and OB where O is origin.
   */
  private crossProduct(o: Vector2, a: Vector2, b: Vector2): number {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  }

  /**
   * Generate inner and outer track boundaries from track points
   */
  private generateBoundaries(trackPoints: TrackPoint[]): { inner: Vector2[]; outer: Vector2[] } {
    const inner: Vector2[] = [];
    const outer: Vector2[] = [];

    for (const point of trackPoints) {
      const halfWidth = point.width / 2;
      inner.push(point.position.add(point.normal.scale(halfWidth)));
      outer.push(point.position.add(point.normal.scale(-halfWidth)));
    }

    return { inner, outer };
  }

  /**
   * Create a seeded random number generator (static version for generateRandom)
   */
  private static createSeededRng(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  }

  /**
   * Helper to get random value within a range using a seeded RNG
   */
  private static randomInRange(rng: () => number, min: number, max: number): number {
    return min + rng() * (max - min);
  }

  /**
   * Generate a random GP track with size class constraints.
   * All parameters are randomized within the bounds for the selected size class.
   * IMPORTANT: Uses seeded randomness so the same seed always produces the same track.
   */
  static generateRandom(config: Partial<TrackGeneratorConfig> = {}): Track {
    // Create seeded RNG for parameter selection - use provided seed or generate one
    const seed = config.seed ?? Math.floor(Math.random() * 1000000);
    const rng = this.createSeededRng(seed);

    // Select random size class if not specified (using seeded RNG)
    const sizeClasses: GPSizeClass[] = ['park', 'circuit', 'autodrome'];
    const providedSizeClass = config.sizeClass;
    // Validate size class - must be one of the GP size classes
    const isValidSizeClass = providedSizeClass && sizeClasses.includes(providedSizeClass);
    const selectedSizeClass = isValidSizeClass
      ? providedSizeClass
      : sizeClasses[Math.floor(rng() * sizeClasses.length)];

    // Get constraints for the selected size class
    const constraints = GP_SIZE_CLASS_CONSTRAINTS[selectedSizeClass];

    // Randomize all parameters within size class bounds (using seeded RNG)
    const minRadius = config.minRadius ?? this.randomInRange(rng, constraints.minRadius.min, constraints.minRadius.max);
    const maxRadius = config.maxRadius ?? this.randomInRange(rng, constraints.maxRadius.min, constraints.maxRadius.max);
    const minWidth = config.minWidth ?? this.randomInRange(rng, constraints.minWidth.min, constraints.minWidth.max);
    const maxWidth = config.maxWidth ?? this.randomInRange(rng, constraints.maxWidth.min, constraints.maxWidth.max);
    const roughness = config.roughness ?? this.randomInRange(rng, constraints.roughness.min, constraints.roughness.max);
    const minStraightLength = config.minStraightLength ?? constraints.straightLength.min;
    const maxStraightLength = config.maxStraightLength ?? constraints.straightLength.max;
    const numControlPoints = config.numControlPoints ?? Math.floor(this.randomInRange(rng, constraints.numControlPoints.min, constraints.numControlPoints.max + 1));
    const displacementIterations = config.displacementIterations ?? Math.floor(this.randomInRange(rng, constraints.displacementIterations.min, constraints.displacementIterations.max + 1));
    const maxBankingAngle = config.maxBankingAngle ?? this.randomInRange(rng, constraints.maxBankingAngle.min, constraints.maxBankingAngle.max);
    const maxDoglegAngle = config.maxDoglegAngle ?? this.randomInRange(rng, constraints.maxDoglegAngle.min, constraints.maxDoglegAngle.max);

    // Pick random shape from allowed shapes for this size class (using seeded RNG)
    const allowedShapes = constraints.allowedShapes;
    const shape = config.shape ?? allowedShapes[Math.floor(rng() * allowedShapes.length)];

    const generator = new TrackGenerator({
      ...config,
      sizeClass: selectedSizeClass,
      shape,
      seed, // Use the same seed for internal generation
      numControlPoints,
      displacementIterations,
      minRadius,
      maxRadius,
      minWidth,
      maxWidth,
      roughness,
      minStraightLength,
      maxStraightLength,
      maxBankingAngle,
      maxDoglegAngle,
    });
    return generator.generate();
  }
}

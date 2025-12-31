import { Vector2 } from '../utils/Vector2';
import { Track, TrackPoint, PitZone, PitLane, OvalShape, OvalSizeClass, WallSegment, SurfaceType } from './Track';
import { CONFIG } from '../utils/Constants';

export interface OvalTrackConfig {
  seed: number;
  shape: OvalShape;
  sizeClass: OvalSizeClass;
  surfaceType: SurfaceType; // 'asphalt' or 'dirt'

  // Dimensions
  straightLength: number;
  turnRadius: number;
  trackWidth: number;
  turnWidthMultiplier: number; // Turns can be wider than straights (1.0-1.5)

  // Banking (in radians)
  maxBankingAngle: number; // Max banking at outside edge
  minBankingAngle: number; // Min banking at inside edge

  // Tri-oval specific
  triOvalAngle: number; // How much to cut from turns for dogleg (radians)
  doglegIntensity: number; // How much the dogleg bulges outward

  // Egg specific (dual-dogleg trioval)
  eggAngle: number; // Cut angle for egg doglegs (radians)
  eggIntensity: number; // Dogleg bulge intensity for egg

  // Triangle specific
  triangleRadius: number; // Distance from center to each vertex
  triangleRotation: number; // Random rotation offset (0 to 2π)

  // Square specific (same concept as triangle but 4 vertices)
  squareRadius: number; // Distance from center to each vertex
  squareRotation: number; // Random rotation offset (0 to 2π)

  // Paperclip specific (Martinsville-style)
  paperclipEccentricity: number; // How elongated (1.5-3.0, higher = longer straights)
  paperclipBankingMultiplier: number; // Reduces banking (0.2-0.5 of normal)

  // Generation resolution
  pointsPerTurn: number;
  pointsPerStraight: number;

  // Position
  centerX: number;
  centerY: number;
}

/**
 * Size class constraints - each class has min/max ranges for track properties.
 * Short tracks are smaller, narrower, and less banked than speedways.
 * Superspeedways are the largest with the steepest banking.
 */
interface SizeClassConstraints {
  straightLength: { min: number; max: number };
  turnRadius: { min: number; max: number };
  trackWidth: { min: number; max: number };
  turnWidthMultiplier: { min: number; max: number };
  maxBankingAngle: { min: number; max: number }; // radians
  triangleRadius: { min: number; max: number };
  squareRadius: { min: number; max: number };
}

const SIZE_CLASS_CONSTRAINTS: Record<OvalSizeClass, SizeClassConstraints> = {
  short: {
    straightLength: { min: 160, max: 320 },
    turnRadius: { min: 120, max: 175 },
    trackWidth: { min: 48, max: 60 },
    turnWidthMultiplier: { min: 1.0, max: 1.2 },
    maxBankingAngle: { min: 0.1, max: 0.2 }, // ~6-12 degrees
    triangleRadius: { min: 150, max: 220 },
    squareRadius: { min: 180, max: 250 },
  },
  speedway: {
    straightLength: { min: 350, max: 550 },
    turnRadius: { min: 180, max: 320 },
    trackWidth: { min: 65, max: 80 },
    turnWidthMultiplier: { min: 1.0, max: 1.3 },
    maxBankingAngle: { min: 0.15, max: 0.3 }, // ~9-17 degrees
    triangleRadius: { min: 250, max: 400 },
    squareRadius: { min: 300, max: 450 },
  },
  superspeedway: {
    straightLength: { min: 600, max: 1000 },
    turnRadius: { min: 350, max: 600 },
    trackWidth: { min: 90, max: 160 },
    turnWidthMultiplier: { min: 1.1, max: 1.5 },
    maxBankingAngle: { min: 0.25, max: 0.55 }, // ~14-31 degrees
    triangleRadius: { min: 500, max: 800 },
    squareRadius: { min: 550, max: 820 },
  },
};

const DEFAULT_OVAL_CONFIG: OvalTrackConfig = {
  seed: Date.now(),
  shape: 'elliptical',
  sizeClass: 'speedway',
  surfaceType: 'asphalt',
  straightLength: 500,
  turnRadius: 250,
  trackWidth: 80,
  turnWidthMultiplier: 1.0,
  maxBankingAngle: 0.420,
  minBankingAngle: 0.075,
  triOvalAngle: 0.30,
  doglegIntensity: 0.75,
  eggAngle: 0.4, // Slightly larger cut for egg
  eggIntensity: 0.6, // Slightly more pronounced doglegs
  triangleRadius: 360,
  triangleRotation: 0,
  squareRadius: 220,
  squareRotation: 0,
  paperclipEccentricity: 1.5,
  paperclipBankingMultiplier: 0.8,
  pointsPerTurn: 60,
  pointsPerStraight: 40,
  centerX: 600,
  centerY: 400,
};

export class OvalTrackGenerator {
  private config: OvalTrackConfig;
  private randomState: number;

  constructor(config: Partial<OvalTrackConfig> = {}) {
    this.config = { ...DEFAULT_OVAL_CONFIG, ...config };
    this.randomState = this.config.seed;

    // Ensure center is far enough from origin to keep entire track in positive space
    // Oval extends: centerX ± (halfStraight + turnRadius + halfTrackWidth)
    //               centerY ± (turnRadius + halfTrackWidth)
    const padding = 20;
    const halfStraight = this.config.straightLength / 2;
    const halfTrackWidth = this.config.trackWidth / 2;

    const minCenterX = halfStraight + this.config.turnRadius + halfTrackWidth + padding;
    const minCenterY = this.config.turnRadius + halfTrackWidth + padding;

    this.config.centerX = Math.max(this.config.centerX, minCenterX);
    this.config.centerY = Math.max(this.config.centerY, minCenterY);
  }

  generate(): Track {
    let trackPoints: TrackPoint[];

    switch (this.config.shape) {
      case 'trioval':
        trackPoints = this.generateTriOval();
        break;
      case 'triangle':
        trackPoints = this.generateTriangle();
        break;
      case 'square':
        trackPoints = this.generateSquare();
        break;
      case 'egg':
        trackPoints = this.generateEgg();
        break;
      case 'paperclip':
        trackPoints = this.generatePaperclip();
        break;
      case 'elliptical':
      default:
        trackPoints = this.generateElliptical();
        break;
    }

    // Smooth width and banking transitions
    trackPoints = this.smoothTransitions(trackPoints);

    // Rotate track points so start/finish line is at middle of front straight
    trackPoints = this.rotateToStartLine(trackPoints);

    // Generate boundaries
    const { inner, outer } = this.generateBoundaries(trackPoints);

    // Generate centerline
    const centerline = trackPoints.map((p) => p.position);

    // Generate pit lane
    const pitLane = this.generatePitLane(trackPoints);

    // Legacy pit zone (kept for backwards compatibility)
    const pitZone = this.generatePitZone(trackPoints);

    // Generate wall segments based on track type and banking
    const wallSegments = this.generateWallSegments(trackPoints);

    return new Track(centerline, trackPoints, inner, outer, this.config.seed, pitZone, {
      type: 'oval',
      ovalShape: this.config.shape,
      ovalSizeClass: this.config.sizeClass,
      surfaceType: this.config.surfaceType,
    }, pitLane, wallSegments);
  }

  /**
   * Calculate turn width and banking at a given progress through the turn.
   * Width and banking both peak at apex (t=0.5) and taper to straight values at entry/exit.
   * Uses sine curve for smooth interpolation.
   */
  private getTurnWidthAndBanking(t: number, trackWidth: number, turnWidthMultiplier: number, maxBanking: number): { width: number; banking: number } {
    // Sine-based interpolation: 0 at t=0 and t=1, peaks at t=0.5
    const factor = Math.sin(t * Math.PI);
    const width = trackWidth * (1 + (turnWidthMultiplier - 1) * factor);
    const banking = maxBanking * factor;
    return { width, banking };
  }

  /**
   * Get width and banking with INVERTED profile - wide at edges (t=0, t=1), narrow in middle.
   * Used for triangle/square tracks where the "turns" are at the vertices, not the dogleg centers.
   */
  private getVertexWidthAndBanking(t: number, trackWidth: number, turnWidthMultiplier: number, maxBanking: number): { width: number; banking: number } {
    // Cosine-based interpolation: peaks at t=0 and t=1 (vertices/turns), minimum at t=0.5 (midpoint)
    // cos(2πt) gives: t=0 → 1, t=0.5 → -1, t=1 → 1 (full cosine wave)
    const factor = Math.cos(2 * Math.PI * t);
    const normalizedFactor = (factor + 1) / 2; // Normalize to 0-1 range: 1 → 0 → 1
    const width = trackWidth * (1 + (turnWidthMultiplier - 1) * normalizedFactor);
    const banking = maxBanking * normalizedFactor;
    return { width, banking };
  }

  /**
   * Generate a standard elliptical oval (two straights, two semicircular turns)
   * Track runs counterclockwise
   */
  private generateElliptical(): TrackPoint[] {
    const points: TrackPoint[] = [];
    const { straightLength, turnRadius, trackWidth, turnWidthMultiplier, pointsPerTurn, pointsPerStraight, centerX, centerY } = this.config;

    const halfStraight = straightLength / 2;

    // Turn centers are at the ends of the straights
    const leftTurnCenterX = centerX - halfStraight;
    const rightTurnCenterX = centerX + halfStraight;

    // Section 1: Front straight (bottom, left to right)
    for (let i = 0; i < pointsPerStraight; i++) {
      const t = i / pointsPerStraight;
      const x = leftTurnCenterX + t * straightLength;
      const y = centerY + turnRadius;
      points.push(this.createTrackPoint(x, y, 0, trackWidth, 0));
    }

    // Section 2: Turn 1 (right semicircle, bottom to top)
    for (let i = 0; i < pointsPerTurn; i++) {
      const t = i / pointsPerTurn;
      const angle = (Math.PI / 2) - t * Math.PI;
      const x = rightTurnCenterX + Math.cos(angle) * turnRadius;
      const y = centerY + Math.sin(angle) * turnRadius;
      const tangentAngle = angle - Math.PI / 2;
      const { width, banking } = this.getTurnWidthAndBanking(t, trackWidth, turnWidthMultiplier, this.config.maxBankingAngle);
      points.push(this.createTrackPoint(x, y, tangentAngle, width, banking));
    }

    // Section 3: Back straight (top, right to left)
    for (let i = 0; i < pointsPerStraight; i++) {
      const t = i / pointsPerStraight;
      const x = rightTurnCenterX - t * straightLength;
      const y = centerY - turnRadius;
      points.push(this.createTrackPoint(x, y, Math.PI, trackWidth, 0));
    }

    // Section 4: Turn 2 (left semicircle, top to bottom)
    for (let i = 0; i < pointsPerTurn; i++) {
      const t = i / pointsPerTurn;
      const angle = (-Math.PI / 2) - t * Math.PI;
      const x = leftTurnCenterX + Math.cos(angle) * turnRadius;
      const y = centerY + Math.sin(angle) * turnRadius;
      const tangentAngle = angle - Math.PI / 2;
      const { width, banking } = this.getTurnWidthAndBanking(t, trackWidth, turnWidthMultiplier, this.config.maxBankingAngle);
      points.push(this.createTrackPoint(x, y, tangentAngle, width, banking));
    }

    return points;
  }

  /**
   * Generate a tri-oval track (like Daytona)
   * Turns are LESS than 180° to make room for the dogleg arc on the front stretch
   */
  private generateTriOval(): TrackPoint[] {
    const points: TrackPoint[] = [];
    const { straightLength, turnRadius, trackWidth, turnWidthMultiplier, pointsPerTurn, pointsPerStraight, centerX, centerY } = this.config;

    const halfStraight = straightLength / 2;

    // Turn centers are at the ends of the straights
    const leftTurnCenterX = centerX - halfStraight;
    const rightTurnCenterX = centerX + halfStraight;

    // Back straight Y position
    const backY = centerY - turnRadius;

    // Dogleg cut angle: how much we "cut" from each turn to make room for the dogleg
    // Uses triOvalAngle from config (default ~20°, range 0.2-0.5 radians = 11°-29°)
    const doglegCutAngle = this.config.triOvalAngle;

    // Turn 1 (right): starts at (90° - cut) = 60°, ends at -90°
    // Turn 2 (left): starts at -90°, ends at (90° + cut) = -300° = 60°
    // Dogleg connects: from 60° on left circle to 120° on right circle

    // Connection points on each turn circle
    const leftExitAngle = Math.PI / 2 + doglegCutAngle;  // 120° - where turn 2 ends
    const rightEntryAngle = Math.PI / 2 - doglegCutAngle; // 60° - where turn 1 starts

    // Calculate connection positions
    const leftExitX = leftTurnCenterX + Math.cos(leftExitAngle) * turnRadius;
    const leftExitY = centerY + Math.sin(leftExitAngle) * turnRadius;
    const rightEntryX = rightTurnCenterX + Math.cos(rightEntryAngle) * turnRadius;
    const rightEntryY = centerY + Math.sin(rightEntryAngle) * turnRadius;

    // Tangent angles at connection points (perpendicular to radius, counterclockwise direction)
    const leftExitTangent = leftExitAngle - Math.PI / 2;   // 30° (pointing down-right)
    const rightEntryTangent = rightEntryAngle - Math.PI / 2; // -30° (pointing down-right)

    // Turn sweep: 180° - cut = 150° for each turn
    const turnSweep = Math.PI - doglegCutAngle;
    const turnPoints = Math.floor(pointsPerTurn * (turnSweep / Math.PI));

    // Section 1: Dogleg (curved front stretch from left exit to right entry)
    // Use Hermite spline for smooth tangent-matching curve
    for (let i = 0; i <= pointsPerStraight; i++) {
      const t = i / pointsPerStraight;

      // Hermite basis functions
      const h00 = 2*t*t*t - 3*t*t + 1;
      const h10 = t*t*t - 2*t*t + t;
      const h01 = -2*t*t*t + 3*t*t;
      const h11 = t*t*t - t*t;

      // Tangent vectors scaled by distance and intensity for proper curve shape
      // Higher intensity = more outward bulge
      const dist = Math.sqrt(Math.pow(rightEntryX - leftExitX, 2) + Math.pow(rightEntryY - leftExitY, 2));
      const tangentScale = dist * this.config.doglegIntensity;

      const m0x = Math.cos(leftExitTangent) * tangentScale;
      const m0y = Math.sin(leftExitTangent) * tangentScale;
      const m1x = Math.cos(rightEntryTangent) * tangentScale;
      const m1y = Math.sin(rightEntryTangent) * tangentScale;

      // Interpolated position
      const x = h00 * leftExitX + h10 * m0x + h01 * rightEntryX + h11 * m1x;
      const y = h00 * leftExitY + h10 * m0y + h01 * rightEntryY + h11 * m1y;

      // Derivative for tangent angle
      const dh00 = 6*t*t - 6*t;
      const dh10 = 3*t*t - 4*t + 1;
      const dh01 = -6*t*t + 6*t;
      const dh11 = 3*t*t - 2*t;

      const dx = dh00 * leftExitX + dh10 * m0x + dh01 * rightEntryX + dh11 * m1x;
      const dy = dh00 * leftExitY + dh10 * m0y + dh01 * rightEntryY + dh11 * m1y;
      const tangentAngle = Math.atan2(dy, dx);

      // Gentle banking on dogleg
      points.push(this.createTrackPoint(x, y, tangentAngle, trackWidth, this.config.minBankingAngle));
    }

    // Section 2: Turn 1 (right turn, 150° from 60° to -90°)
    for (let i = 0; i < turnPoints; i++) {
      const t = i / turnPoints;
      const angle = rightEntryAngle - t * turnSweep;
      const x = rightTurnCenterX + Math.cos(angle) * turnRadius;
      const y = centerY + Math.sin(angle) * turnRadius;
      const tangentAngle = angle - Math.PI / 2;
      const { width, banking } = this.getTurnWidthAndBanking(t, trackWidth, turnWidthMultiplier, this.config.maxBankingAngle);
      points.push(this.createTrackPoint(x, y, tangentAngle, width, banking));
    }

    // Section 3: Back straight (top, right to left)
    for (let i = 0; i < pointsPerStraight; i++) {
      const t = i / pointsPerStraight;
      const x = rightTurnCenterX - t * straightLength;
      const y = backY;
      points.push(this.createTrackPoint(x, y, Math.PI, trackWidth, 0));
    }

    // Section 4: Turn 2 (left turn, 150° from -90° to 120°)
    for (let i = 0; i < turnPoints; i++) {
      const t = i / turnPoints;
      const angle = -Math.PI / 2 - t * turnSweep;
      const x = leftTurnCenterX + Math.cos(angle) * turnRadius;
      const y = centerY + Math.sin(angle) * turnRadius;
      const tangentAngle = angle - Math.PI / 2;
      const { width, banking } = this.getTurnWidthAndBanking(t, trackWidth, turnWidthMultiplier, this.config.maxBankingAngle);
      points.push(this.createTrackPoint(x, y, tangentAngle, width, banking));
    }

    return points;
  }

  /**
   * Generate a triangle track (3 doglegs connected together)
   * Each side is a Hermite spline curve like the tri-oval dogleg
   * Width and banking peak at apex (t=0.5) and taper at entry/exit
   *
   * Track runs CCW (turn left) to match other ovals.
   * Vertices are traversed in CLOCKWISE order around the triangle center
   * so that the car travels CCW around the track (turning left at each corner).
   */
  private generateTriangle(): TrackPoint[] {
    const points: TrackPoint[] = [];
    const { triangleRadius, triangleRotation, doglegIntensity, trackWidth, turnWidthMultiplier, pointsPerStraight, centerX, centerY } = this.config;

    // Calculate 3 vertices at 120° apart, in CLOCKWISE order (negative angular direction)
    // This makes the car travel CCW around the track (turning left at each vertex)
    const vertices: { x: number; y: number; tangent: number }[] = [];
    for (let i = 0; i < 3; i++) {
      // Negative increment = clockwise vertex order
      const angle = triangleRotation - (i * 2 * Math.PI / 3);
      // Tangent points in CW direction around vertices (angle - π/2)
      // This creates outward-bulging curves between vertices
      vertices.push({
        x: centerX + triangleRadius * Math.cos(angle),
        y: centerY + triangleRadius * Math.sin(angle),
        tangent: angle - Math.PI / 2
      });
    }

    // Generate 3 doglegs connecting vertices (CW order: 0→1→2→0)
    for (let i = 0; i < 3; i++) {
      const start = vertices[i];
      const end = vertices[(i + 1) % 3];

      // Slight variation in intensity per side (±20%) - use seeded random
      const sideIntensity = doglegIntensity * (0.5 + this.random() * 0.5);

      // Distance between vertices for tangent scaling
      const dist = Math.sqrt(Math.pow(end.x - start.x, 2) + Math.pow(end.y - start.y, 2));
      const tangentScale = dist * sideIntensity;

      // Tangent vectors
      const m0x = Math.cos(start.tangent) * tangentScale;
      const m0y = Math.sin(start.tangent) * tangentScale;
      const m1x = Math.cos(end.tangent) * tangentScale;
      const m1y = Math.sin(end.tangent) * tangentScale;

      // Hermite spline between vertices
      for (let j = 0; j < pointsPerStraight; j++) {
        const t = j / pointsPerStraight;

        // Hermite basis functions
        const h00 = 2*t*t*t - 3*t*t + 1;
        const h10 = t*t*t - 2*t*t + t;
        const h01 = -2*t*t*t + 3*t*t;
        const h11 = t*t*t - t*t;

        // Interpolated position
        const x = h00 * start.x + h10 * m0x + h01 * end.x + h11 * m1x;
        const y = h00 * start.y + h10 * m0y + h01 * end.y + h11 * m1y;

        // Derivative for tangent angle
        const dh00 = 6*t*t - 6*t;
        const dh10 = 3*t*t - 4*t + 1;
        const dh01 = -6*t*t + 6*t;
        const dh11 = 3*t*t - 2*t;

        const dx = dh00 * start.x + dh10 * m0x + dh01 * end.x + dh11 * m1x;
        const dy = dh00 * start.y + dh10 * m0y + dh01 * end.y + dh11 * m1y;
        const tangentAngle = Math.atan2(dy, dx);

        // Triangle: wider at vertices (turns), narrower at dogleg midpoints
        // Banking also peaks at vertices where the actual turning happens
        const { width, banking } = this.getVertexWidthAndBanking(t, trackWidth, turnWidthMultiplier, this.config.maxBankingAngle);

        // Calculate normal perpendicular to tangent, then ensure it points OUTWARD (away from center)
        // Normal must be perpendicular to tangent for track edges to align properly
        const tangent = Vector2.fromAngle(tangentAngle);
        let normal = tangent.perpendicular(); // Points left of travel direction

        // For triangle, "left of travel" points TOWARD center (inside), not outside
        // Check if normal points toward center; if so, flip it to point outward
        const toCenter = new Vector2(centerX - x, centerY - y);
        if (normal.dot(toCenter) > 0) {
          // Normal points toward center, flip it to point outward
          normal = normal.scale(-1);
        }

        points.push(this.createTrackPointWithNormal(x, y, tangentAngle, width, banking, normal));
      }
    }

    return points;
  }

  /**
   * Generate a square track (4 doglegs connected together, like Indianapolis)
   * Same structure as triangle but with 4 vertices at 90° intervals.
   * Track runs CCW (turn left) to match other ovals.
   */
  private generateSquare(): TrackPoint[] {
    const points: TrackPoint[] = [];
    const { squareRadius, squareRotation, doglegIntensity, trackWidth, turnWidthMultiplier, pointsPerStraight, centerX, centerY } = this.config;

    // Calculate 4 vertices at 90° apart, in CLOCKWISE order (negative angular direction)
    // This makes the car travel CCW around the track (turning left at each corner)
    const vertices: { x: number; y: number; tangent: number }[] = [];
    for (let i = 0; i < 4; i++) {
      // Negative increment = clockwise vertex order
      const angle = squareRotation - (i * 2 * Math.PI / 4);
      // Tangent points in CW direction around vertices (angle - π/2)
      vertices.push({
        x: centerX + squareRadius * Math.cos(angle),
        y: centerY + squareRadius * Math.sin(angle),
        tangent: angle - Math.PI / 2
      });
    }

    // Generate 4 doglegs connecting vertices (CW order: 0→1→2→3→0)
    for (let i = 0; i < 4; i++) {
      const start = vertices[i];
      const end = vertices[(i + 1) % 4];

      // Slight variation in intensity per side (±20%) - use seeded random
      const sideIntensity = doglegIntensity * (0.5 + this.random() * 0.5);

      // Distance between vertices for tangent scaling
      const dist = Math.sqrt(Math.pow(end.x - start.x, 2) + Math.pow(end.y - start.y, 2));
      const tangentScale = dist * sideIntensity;

      // Tangent vectors
      const m0x = Math.cos(start.tangent) * tangentScale;
      const m0y = Math.sin(start.tangent) * tangentScale;
      const m1x = Math.cos(end.tangent) * tangentScale;
      const m1y = Math.sin(end.tangent) * tangentScale;

      // Hermite spline between vertices
      for (let j = 0; j < pointsPerStraight; j++) {
        const t = j / pointsPerStraight;

        // Hermite basis functions
        const h00 = 2*t*t*t - 3*t*t + 1;
        const h10 = t*t*t - 2*t*t + t;
        const h01 = -2*t*t*t + 3*t*t;
        const h11 = t*t*t - t*t;

        // Interpolated position
        const x = h00 * start.x + h10 * m0x + h01 * end.x + h11 * m1x;
        const y = h00 * start.y + h10 * m0y + h01 * end.y + h11 * m1y;

        // Derivative for tangent angle
        const dh00 = 6*t*t - 6*t;
        const dh10 = 3*t*t - 4*t + 1;
        const dh01 = -6*t*t + 6*t;
        const dh11 = 3*t*t - 2*t;

        const dx = dh00 * start.x + dh10 * m0x + dh01 * end.x + dh11 * m1x;
        const dy = dh00 * start.y + dh10 * m0y + dh01 * end.y + dh11 * m1y;
        const tangentAngle = Math.atan2(dy, dx);

        // Square: wider at vertices (turns), narrower at dogleg midpoints
        // Banking also peaks at vertices where the actual turning happens
        const { width, banking } = this.getVertexWidthAndBanking(t, trackWidth, turnWidthMultiplier, this.config.maxBankingAngle);

        // Calculate normal perpendicular to tangent, ensure it points OUTWARD
        const tangent = Vector2.fromAngle(tangentAngle);
        let normal = tangent.perpendicular();

        const toCenter = new Vector2(centerX - x, centerY - y);
        if (normal.dot(toCenter) > 0) {
          normal = normal.scale(-1);
        }

        points.push(this.createTrackPointWithNormal(x, y, tangentAngle, width, banking, normal));
      }
    }

    return points;
  }

  /**
   * Generate an egg track (trioval with doglegs on BOTH straights)
   * Front and back straights both have Hermite spline curves bulging outward.
   * Each turn is reduced to accommodate doglegs on both ends.
   */
  private generateEgg(): TrackPoint[] {
    const points: TrackPoint[] = [];
    const { straightLength, turnRadius, trackWidth, turnWidthMultiplier, pointsPerTurn, pointsPerStraight, centerX, centerY, eggAngle, eggIntensity } = this.config;

    const halfStraight = straightLength / 2;

    // Turn centers at the ends of the straights
    const leftTurnCenterX = centerX - halfStraight;
    const rightTurnCenterX = centerX + halfStraight;

    // Dogleg cut angle - use egg-specific config
    const doglegCutAngle = eggAngle;

    // For egg, each turn is cut on BOTH sides (entry and exit)
    // Front dogleg: connects left turn (exit at 90°+cut) to right turn (entry at 90°-cut)
    // Back dogleg: connects right turn (exit at -90°-cut) to left turn (entry at -90°+cut)

    // Front dogleg connection points (bottom of track, bulges downward/outward)
    const frontLeftExitAngle = Math.PI / 2 + doglegCutAngle;   // ~110° on left circle
    const frontRightEntryAngle = Math.PI / 2 - doglegCutAngle; // ~70° on right circle

    // Back dogleg connection points (top of track, bulges upward/outward)
    // RIGHT exit is at top-right of right circle: -90° + cut = -70°
    // LEFT entry is at top-left of left circle: -90° - cut = -110°
    const backRightExitAngle = -Math.PI / 2 + doglegCutAngle;  // ~-70° on right circle
    const backLeftEntryAngle = -Math.PI / 2 - doglegCutAngle;  // ~-110° on left circle

    // Calculate connection positions
    const frontLeftExitX = leftTurnCenterX + Math.cos(frontLeftExitAngle) * turnRadius;
    const frontLeftExitY = centerY + Math.sin(frontLeftExitAngle) * turnRadius;
    const frontRightEntryX = rightTurnCenterX + Math.cos(frontRightEntryAngle) * turnRadius;
    const frontRightEntryY = centerY + Math.sin(frontRightEntryAngle) * turnRadius;

    const backRightExitX = rightTurnCenterX + Math.cos(backRightExitAngle) * turnRadius;
    const backRightExitY = centerY + Math.sin(backRightExitAngle) * turnRadius;
    const backLeftEntryX = leftTurnCenterX + Math.cos(backLeftEntryAngle) * turnRadius;
    const backLeftEntryY = centerY + Math.sin(backLeftEntryAngle) * turnRadius;

    // Tangent angles at connection points (perpendicular to radius, pointing in travel direction)
    // Use angle - π/2 for all tangents (same formula as trioval front dogleg)
    const frontLeftExitTangent = frontLeftExitAngle - Math.PI / 2;
    const frontRightEntryTangent = frontRightEntryAngle - Math.PI / 2;
    const backRightExitTangent = backRightExitAngle - Math.PI / 2;
    const backLeftEntryTangent = backLeftEntryAngle - Math.PI / 2;

    // Each turn sweeps 180° (π radians) - the cut angles just shift WHERE the turn happens,
    // but the total angular sweep remains the same
    const turnPoints = pointsPerTurn;

    // Section 1: Front dogleg (from left exit to right entry, bulges outward/downward)
    const frontDist = Math.sqrt(Math.pow(frontRightEntryX - frontLeftExitX, 2) + Math.pow(frontRightEntryY - frontLeftExitY, 2));
    const frontTangentScale = frontDist * eggIntensity;

    for (let i = 0; i <= pointsPerStraight; i++) {
      const t = i / pointsPerStraight;

      const h00 = 2*t*t*t - 3*t*t + 1;
      const h10 = t*t*t - 2*t*t + t;
      const h01 = -2*t*t*t + 3*t*t;
      const h11 = t*t*t - t*t;

      const m0x = Math.cos(frontLeftExitTangent) * frontTangentScale;
      const m0y = Math.sin(frontLeftExitTangent) * frontTangentScale;
      const m1x = Math.cos(frontRightEntryTangent) * frontTangentScale;
      const m1y = Math.sin(frontRightEntryTangent) * frontTangentScale;

      const x = h00 * frontLeftExitX + h10 * m0x + h01 * frontRightEntryX + h11 * m1x;
      const y = h00 * frontLeftExitY + h10 * m0y + h01 * frontRightEntryY + h11 * m1y;

      const dh00 = 6*t*t - 6*t;
      const dh10 = 3*t*t - 4*t + 1;
      const dh01 = -6*t*t + 6*t;
      const dh11 = 3*t*t - 2*t;

      const dx = dh00 * frontLeftExitX + dh10 * m0x + dh01 * frontRightEntryX + dh11 * m1x;
      const dy = dh00 * frontLeftExitY + dh10 * m0y + dh01 * frontRightEntryY + dh11 * m1y;
      const tangentAngle = Math.atan2(dy, dx);

      points.push(this.createTrackPoint(x, y, tangentAngle, trackWidth, this.config.minBankingAngle));
    }

    // Section 2: Turn 1 (right turn, from frontRightEntry to backRightExit)
    // Sweeps clockwise (decreasing angle) on right circle
    for (let i = 0; i < turnPoints; i++) {
      const t = i / turnPoints;
      // Interpolate from frontRightEntryAngle to backRightExitAngle
      const angle = frontRightEntryAngle + t * (backRightExitAngle - frontRightEntryAngle);
      const x = rightTurnCenterX + Math.cos(angle) * turnRadius;
      const y = centerY + Math.sin(angle) * turnRadius;
      const tangentAngle = angle - Math.PI / 2;
      const { width, banking } = this.getTurnWidthAndBanking(t, trackWidth, turnWidthMultiplier, this.config.maxBankingAngle);
      points.push(this.createTrackPoint(x, y, tangentAngle, width, banking));
    }

    // Section 3: Back dogleg (from right exit to left entry, bulges outward/upward)
    const backDist = Math.sqrt(Math.pow(backLeftEntryX - backRightExitX, 2) + Math.pow(backLeftEntryY - backRightExitY, 2));
    const backTangentScale = backDist * eggIntensity;

    for (let i = 0; i <= pointsPerStraight; i++) {
      const t = i / pointsPerStraight;

      const h00 = 2*t*t*t - 3*t*t + 1;
      const h10 = t*t*t - 2*t*t + t;
      const h01 = -2*t*t*t + 3*t*t;
      const h11 = t*t*t - t*t;

      // Same tangent calculation as front dogleg - curve naturally bulges outward
      const m0x = Math.cos(backRightExitTangent) * backTangentScale;
      const m0y = Math.sin(backRightExitTangent) * backTangentScale;
      const m1x = Math.cos(backLeftEntryTangent) * backTangentScale;
      const m1y = Math.sin(backLeftEntryTangent) * backTangentScale;

      const x = h00 * backRightExitX + h10 * m0x + h01 * backLeftEntryX + h11 * m1x;
      const y = h00 * backRightExitY + h10 * m0y + h01 * backLeftEntryY + h11 * m1y;

      const dh00 = 6*t*t - 6*t;
      const dh10 = 3*t*t - 4*t + 1;
      const dh01 = -6*t*t + 6*t;
      const dh11 = 3*t*t - 2*t;

      const dx = dh00 * backRightExitX + dh10 * m0x + dh01 * backLeftEntryX + dh11 * m1x;
      const dy = dh00 * backRightExitY + dh10 * m0y + dh01 * backLeftEntryY + dh11 * m1y;
      const tangentAngle = Math.atan2(dy, dx);

      points.push(this.createTrackPoint(x, y, tangentAngle, trackWidth, this.config.minBankingAngle));
    }

    // Section 4: Turn 2 (left turn, from backLeftEntry to frontLeftExit)
    // Must go the "long way" around the left side of the circle (through ±180°)
    // From -110° to 110° going counterclockwise would cut through the center
    // Instead, go clockwise: -110° → -180° → 180° → 110° (total 140° sweep)
    const turn2Sweep = 2 * Math.PI - (frontLeftExitAngle - backLeftEntryAngle); // ~140°
    for (let i = 0; i < turnPoints; i++) {
      const t = i / turnPoints;
      // Sweep clockwise (subtract from start angle)
      const angle = backLeftEntryAngle - t * turn2Sweep;
      const x = leftTurnCenterX + Math.cos(angle) * turnRadius;
      const y = centerY + Math.sin(angle) * turnRadius;
      const tangentAngle = angle - Math.PI / 2;
      const { width, banking } = this.getTurnWidthAndBanking(t, trackWidth, turnWidthMultiplier, this.config.maxBankingAngle);
      points.push(this.createTrackPoint(x, y, tangentAngle, width, banking));
    }

    return points;
  }

  /**
   * Generate a paperclip track (elongated elliptical like Martinsville)
   * Features very long straights, tight hairpin turns, and low banking.
   */
  private generatePaperclip(): TrackPoint[] {
    const points: TrackPoint[] = [];
    const { straightLength, turnRadius, trackWidth, turnWidthMultiplier, pointsPerTurn, pointsPerStraight, centerX, centerY, paperclipEccentricity, paperclipBankingMultiplier } = this.config;

    // Paperclip has much longer straights and tighter turns
    // eccentricity controls how elongated (1.5 = mild, 3.0 = very long)
    const paperclipStraight = straightLength * paperclipEccentricity;
    // Enforce minimum turn radius to prevent banking overlap
    // Min radius should be at least 1.5x track width to have room for banking gradient
    const minTurnRadius = trackWidth * 2.0;
    const paperclipTurnRadius = Math.max(turnRadius / paperclipEccentricity, minTurnRadius);
    const paperclipBanking = this.config.maxBankingAngle * paperclipBankingMultiplier;

    const halfStraight = paperclipStraight / 2;

    // Turn centers at the ends of the straights
    const leftTurnCenterX = centerX - halfStraight;
    const rightTurnCenterX = centerX + halfStraight;

    // Section 1: Front straight (bottom, left to right)
    for (let i = 0; i < pointsPerStraight; i++) {
      const t = i / pointsPerStraight;
      const x = leftTurnCenterX + t * paperclipStraight;
      const y = centerY + paperclipTurnRadius;
      points.push(this.createTrackPoint(x, y, 0, trackWidth, 0));
    }

    // Section 2: Turn 1 (right semicircle, bottom to top) - tight hairpin
    for (let i = 0; i < pointsPerTurn; i++) {
      const t = i / pointsPerTurn;
      const angle = (Math.PI / 2) - t * Math.PI;
      const x = rightTurnCenterX + Math.cos(angle) * paperclipTurnRadius;
      const y = centerY + Math.sin(angle) * paperclipTurnRadius;
      const tangentAngle = angle - Math.PI / 2;
      // Extra wide in turns since they're so tight, but low banking
      const { width } = this.getTurnWidthAndBanking(t, trackWidth, turnWidthMultiplier * 1.2, this.config.maxBankingAngle);
      const banking = paperclipBanking * Math.sin(t * Math.PI);
      points.push(this.createTrackPoint(x, y, tangentAngle, width, banking));
    }

    // Section 3: Back straight (top, right to left)
    for (let i = 0; i < pointsPerStraight; i++) {
      const t = i / pointsPerStraight;
      const x = rightTurnCenterX - t * paperclipStraight;
      const y = centerY - paperclipTurnRadius;
      points.push(this.createTrackPoint(x, y, Math.PI, trackWidth, 0));
    }

    // Section 4: Turn 2 (left semicircle, top to bottom) - tight hairpin
    for (let i = 0; i < pointsPerTurn; i++) {
      const t = i / pointsPerTurn;
      const angle = (-Math.PI / 2) - t * Math.PI;
      const x = leftTurnCenterX + Math.cos(angle) * paperclipTurnRadius;
      const y = centerY + Math.sin(angle) * paperclipTurnRadius;
      const tangentAngle = angle - Math.PI / 2;
      const { width } = this.getTurnWidthAndBanking(t, trackWidth, turnWidthMultiplier * 1.2, this.config.maxBankingAngle);
      const banking = paperclipBanking * Math.sin(t * Math.PI);
      points.push(this.createTrackPoint(x, y, tangentAngle, width, banking));
    }

    return points;
  }

  /**
   * Create a single track point with normal computed from tangent.
   * Normal points LEFT of travel direction (perpendicular CCW).
   * For standard ovals, this means +normal = outside, -normal = inside.
   */
  private createTrackPoint(
    x: number,
    y: number,
    tangentAngle: number,
    width: number,
    banking: number
  ): TrackPoint {
    const tangent = Vector2.fromAngle(tangentAngle);
    const normal = tangent.perpendicular();
    return {
      position: new Vector2(x, y),
      width,
      tangent,
      normal,
      banking,
    };
  }

  /**
   * Create a track point with an explicit normal direction.
   * Used for triangle tracks where normal must point away from center
   * to match the unified system (+normal = outside, -normal = inside).
   */
  private createTrackPointWithNormal(
    x: number,
    y: number,
    tangentAngle: number,
    width: number,
    banking: number,
    explicitNormal: Vector2
  ): TrackPoint {
    const tangent = Vector2.fromAngle(tangentAngle);
    return {
      position: new Vector2(x, y),
      width,
      tangent,
      normal: explicitNormal,
      banking,
    };
  }

  /**
   * Smooth width and banking transitions using a moving average.
   * This prevents abrupt jumps when transitioning between straights and turns.
   */
  private smoothTransitions(points: TrackPoint[]): TrackPoint[] {
    if (points.length < 5) return points;

    const windowSize = Math.min(8, Math.floor(points.length / 10));
    if (windowSize < 2) return points;

    const smoothed: TrackPoint[] = [];

    for (let i = 0; i < points.length; i++) {
      const point = points[i];

      // Calculate average width and banking over the window
      let widthSum = 0;
      let bankingSum = 0;
      let count = 0;

      for (let j = -windowSize; j <= windowSize; j++) {
        // Wrap around for closed loop
        const idx = (i + j + points.length) % points.length;
        widthSum += points[idx].width;
        bankingSum += points[idx].banking;
        count++;
      }

      const avgWidth = widthSum / count;
      const avgBanking = bankingSum / count;

      smoothed.push({
        position: point.position,
        tangent: point.tangent,
        normal: point.normal,
        width: avgWidth,
        banking: avgBanking,
      });
    }

    return smoothed;
  }

  /**
   * Rotate track points so the start/finish line is at the middle of the front straight.
   * This makes index 0 the start line position.
   */
  private rotateToStartLine(points: TrackPoint[]): TrackPoint[] {
    const startIndex = this.getStartLineIndex(points.length);
    if (startIndex === 0 || startIndex >= points.length) return points;

    // Rotate array so startIndex becomes index 0
    return [...points.slice(startIndex), ...points.slice(0, startIndex)];
  }

  /**
   * Get the index where the start/finish line should be placed.
   * For all shapes, this is the middle of the first section (front straight or dogleg).
   */
  private getStartLineIndex(_totalPoints: number): number {
    const { pointsPerStraight } = this.config;

    // For all shapes, front stretch is the first section
    // Start line at middle of that section
    return Math.floor(pointsPerStraight / 2);
  }

  /**
   * Generate pit zone polygon that fits along the inside of the front straight.
   * Creates a polygon that hugs the inside edge of the track.
   */
  private generatePitLane(trackPoints: TrackPoint[]): PitLane {
    const pitWidth = 50;  // Width of pit area
    const pitGap = 10;    // Gap between track edge and pit zone
    const { pointsPerStraight } = this.config;

    // For tri-oval and egg, pit zone is a straight rectangle beneath the dogleg
    if (this.config.shape === 'trioval' || this.config.shape === 'egg') {
      return this.generateTriOvalPitLane(trackPoints, pitWidth, pitGap);
    }

    // For triangle and square, pit goes on the inside (toward polygon center)
    // Same as other ovals: -normal = inside
    if (this.config.shape === 'triangle' || this.config.shape === 'square') {
      return this.generateTrianglePitLane(trackPoints, pitWidth, pitGap);
    }

    // Paperclip uses default elliptical pit lane (along front straight)

    // After rotation, index 0 is middle of front straight
    // Front straight spans from ~(-pointsPerStraight/2) to ~(+pointsPerStraight/2)
    const halfStraight = Math.floor(pointsPerStraight / 2);

    // Pit zone covers most of the front straight (80%)
    const pitStartIdx = (trackPoints.length - Math.floor(halfStraight * 0.8)) % trackPoints.length;
    const pitEndIdx = Math.floor(halfStraight * 0.8);

    // Collect points along the inside edge of the front straight
    const innerEdgePoints: Vector2[] = [];
    const outerEdgePoints: Vector2[] = [];

    // Walk from pit start to pit end
    let idx = pitStartIdx;
    while (true) {
      const point = trackPoints[idx];
      const halfWidth = point.width / 2;

      // Inner edge of track (inside the racing surface)
      const innerEdge = point.position.add(point.normal.scale(-halfWidth - pitGap));
      // Outer edge of pit zone (further inside)
      const outerEdge = point.position.add(point.normal.scale(-halfWidth - pitGap - pitWidth));

      innerEdgePoints.push(innerEdge);
      outerEdgePoints.push(outerEdge);

      if (idx === pitEndIdx) break;
      idx = (idx + 1) % trackPoints.length;
    }

    // Build polygon: inner edge forward, then outer edge backward
    const polygon: Vector2[] = [
      ...innerEdgePoints,
      ...outerEdgePoints.reverse()
    ];

    // Calculate center for label
    const center = this.calculatePolygonCenter(polygon);

    return { polygon, center };
  }

  /**
   * Generate tri-oval pit zone that cuts straight beneath the dogleg.
   * Creates a rectangular zone that bypasses the curved dogleg.
   */
  private generateTriOvalPitLane(trackPoints: TrackPoint[], pitWidth: number, pitGap: number): PitLane {
    const { pointsPerStraight } = this.config;

    // After rotation, index 0 is middle of dogleg
    // Dogleg endpoints are at roughly ±pointsPerStraight/2
    const halfDogleg = Math.floor(pointsPerStraight / 2);

    // Get the dogleg endpoint positions
    const startIdx = (trackPoints.length - halfDogleg + 2) % trackPoints.length;
    const endIdx = (halfDogleg - 2 + trackPoints.length) % trackPoints.length;

    const startPoint = trackPoints[startIdx];
    const endPoint = trackPoints[endIdx];

    // Calculate offset for inside of track
    const startHalfWidth = startPoint.width / 2;
    const endHalfWidth = endPoint.width / 2;

    // The pit zone is a straight rectangle connecting the dogleg endpoints
    // but offset to the inside (beneath the bulging dogleg curve)
    const innerStart = startPoint.position.add(startPoint.normal.scale(-startHalfWidth - pitGap));
    const innerEnd = endPoint.position.add(endPoint.normal.scale(-endHalfWidth - pitGap));
    const outerStart = startPoint.position.add(startPoint.normal.scale(-startHalfWidth - pitGap - pitWidth));
    const outerEnd = endPoint.position.add(endPoint.normal.scale(-endHalfWidth - pitGap - pitWidth));

    // Build rectangular polygon
    const polygon: Vector2[] = [
      innerStart,
      innerEnd,
      outerEnd,
      outerStart
    ];

    // Calculate center for label
    const center = this.calculatePolygonCenter(polygon);

    return { polygon, center };
  }

  /**
   * Generate triangle pit lane on the inside of the track (toward triangle center).
   * Pit is placed around the start/finish line (index 0), same as other ovals.
   * Uses unified normal system: -normal = inside (toward center).
   */
  private generateTrianglePitLane(trackPoints: TrackPoint[], pitWidth: number, pitGap: number): PitLane {
    const { pointsPerStraight } = this.config;

    // After rotation, index 0 is middle of first side (start/finish)
    // Pit covers 80% of the first side, centered around index 0
    const halfStraight = Math.floor(pointsPerStraight / 2);
    const pitStartIdx = (trackPoints.length - Math.floor(halfStraight * 0.8)) % trackPoints.length;
    const pitEndIdx = Math.floor(halfStraight * 0.8);

    const innerEdgePoints: Vector2[] = [];
    const outerEdgePoints: Vector2[] = [];

    // Walk from pit start to pit end (wrapping around index 0)
    let idx = pitStartIdx;
    while (true) {
      const point = trackPoints[idx];
      const halfWidth = point.width / 2;

      // Unified system: -normal goes toward inside (triangle center)
      const innerEdge = point.position.add(point.normal.scale(-halfWidth - pitGap));
      const outerEdge = point.position.add(point.normal.scale(-halfWidth - pitGap - pitWidth));

      innerEdgePoints.push(innerEdge);
      outerEdgePoints.push(outerEdge);

      if (idx === pitEndIdx) break;
      idx = (idx + 1) % trackPoints.length;
    }

    const polygon: Vector2[] = [
      ...innerEdgePoints,
      ...outerEdgePoints.reverse()
    ];

    const center = this.calculatePolygonCenter(polygon);

    return { polygon, center };
  }

  /**
   * Calculate the centroid of a polygon
   */
  private calculatePolygonCenter(polygon: Vector2[]): Vector2 {
    let sumX = 0, sumY = 0;
    for (const p of polygon) {
      sumX += p.x;
      sumY += p.y;
    }
    return new Vector2(sumX / polygon.length, sumY / polygon.length);
  }

  /**
   * Generate inner and outer track boundaries.
   * For counterclockwise tracks:
   * - Positive normal points to the LEFT of travel = OUTSIDE of the track
   * - Negative normal points to the RIGHT of travel = INSIDE of the track
   */
  private generateBoundaries(trackPoints: TrackPoint[]): { inner: Vector2[]; outer: Vector2[] } {
    const inner: Vector2[] = [];
    const outer: Vector2[] = [];

    for (const point of trackPoints) {
      const halfWidth = point.width / 2;
      // Positive normal = outer (left of travel direction for CCW)
      // Negative normal = inner (right of travel direction for CCW)
      outer.push(point.position.add(point.normal.scale(halfWidth)));
      inner.push(point.position.add(point.normal.scale(-halfWidth)));
    }

    return { inner, outer };
  }

  /**
   * Generate pit zone on the inside of the front straight
   */
  private generatePitZone(trackPoints: TrackPoint[]): PitZone {
    // Use track points near the start (front straight)
    const startPoint = trackPoints[0];
    const pitLength = 150;
    const pitWidth = 50;

    // Offset pit zone to the inside of the track
    const offsetDistance = startPoint.width / 2 + pitWidth / 2 + 15;
    const pitPosition = startPoint.position.add(startPoint.normal.scale(-offsetDistance));

    // Angle aligned with track tangent
    const angle = Math.atan2(startPoint.tangent.y, startPoint.tangent.x);

    return {
      position: pitPosition,
      width: pitWidth,
      length: pitLength,
      angle,
    };
  }

  /**
   * Seeded random number generator (0-1 range).
   * Uses a simple LCG algorithm for deterministic randomness.
   */
  private random(): number {
    this.randomState = (this.randomState * 1664525 + 1013904223) % 4294967296;
    return this.randomState / 4294967296;
  }

  /**
   * Generate wall segments based on track type and banking.
   * - Superspeedways and speedways: full outer wall
   * - Short tracks and triangles: 50% chance for full wall, otherwise banking-only
   * - Any section with banking > threshold gets a wall regardless
   */
  private generateWallSegments(trackPoints: TrackPoint[]): WallSegment[] {
    const { sizeClass } = this.config;

    // Superspeedways and speedways always have full walls
    if (sizeClass === 'superspeedway' || sizeClass === 'speedway') {
      return [{ startIndex: 0, endIndex: trackPoints.length - 1 }];
    }

    // Short tracks: 50% chance for full wall
    const hasFullWall = this.random() < 0.5;
    if (hasFullWall) {
      return [{ startIndex: 0, endIndex: trackPoints.length - 1 }];
    }

    // Otherwise: walls only on banked sections exceeding threshold
    const segments: WallSegment[] = [];
    const threshold = CONFIG.WALL_BANKING_THRESHOLD;

    let inWall = false;
    let wallStart = 0;

    for (let i = 0; i < trackPoints.length; i++) {
      const isBanked = trackPoints[i].banking > threshold;

      if (isBanked && !inWall) {
        inWall = true;
        wallStart = i;
      } else if (!isBanked && inWall) {
        inWall = false;
        segments.push({ startIndex: wallStart, endIndex: i - 1 });
      }
    }

    // Handle wrap-around: if still in wall at end, close it
    if (inWall) {
      // Check if the wall wraps around to the start
      if (trackPoints[0].banking > threshold) {
        // Find where the wrap-around wall ends
        let wrapEnd = 0;
        for (let i = 0; i < trackPoints.length; i++) {
          if (trackPoints[i].banking <= threshold) {
            wrapEnd = i - 1;
            break;
          }
        }
        // Merge wrap-around: wall from wallStart to end, and 0 to wrapEnd
        // Store as two segments or one that wraps
        segments.push({ startIndex: wallStart, endIndex: trackPoints.length - 1 });
        if (wrapEnd > 0) {
          segments.push({ startIndex: 0, endIndex: wrapEnd });
        }
      } else {
        segments.push({ startIndex: wallStart, endIndex: trackPoints.length - 1 });
      }
    }

    return segments;
  }

  /**
   * Create a seeded random number generator (static version for generateRandom)
   */
  private static createSeededRng(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
  }

  /**
   * Helper to get random value within a range using a seeded RNG
   */
  private static randomInRange(rng: () => number, min: number, max: number): number {
    return min + rng() * (max - min);
  }

  /**
   * Generate a random oval track with size class constraints.
   * All parameters are randomized within the bounds for the selected size class.
   * IMPORTANT: Uses seeded randomness so the same seed always produces the same track.
   */
  static generateRandom(config: Partial<OvalTrackConfig> = {}): Track {
    // Create seeded RNG for parameter selection - use provided seed or generate one
    const seed = config.seed ?? Math.floor(Math.random() * 1000000);
    const rng = this.createSeededRng(seed);

    // Select random shape and size class if not specified (using seeded RNG)
    const shapes: OvalShape[] = ['elliptical', 'trioval', 'triangle', 'square', 'egg', 'paperclip'];
    const sizeClasses: OvalSizeClass[] = ['short', 'speedway', 'superspeedway'];

    const selectedShape = config.shape ?? shapes[Math.floor(rng() * shapes.length)];
    const providedSizeClass = config.sizeClass;
    // Validate size class - must be one of the oval size classes
    const isValidSizeClass = providedSizeClass && sizeClasses.includes(providedSizeClass);
    const selectedSizeClass = isValidSizeClass
      ? providedSizeClass
      : sizeClasses[Math.floor(rng() * sizeClasses.length)];

    // Get constraints for the selected size class
    const constraints = SIZE_CLASS_CONSTRAINTS[selectedSizeClass];

    // Randomize all parameters within size class bounds (using seeded RNG)
    const straightLength = config.straightLength ?? this.randomInRange(rng, constraints.straightLength.min, constraints.straightLength.max);
    const turnRadius = config.turnRadius ?? this.randomInRange(rng, constraints.turnRadius.min, constraints.turnRadius.max);
    const trackWidth = config.trackWidth ?? this.randomInRange(rng, constraints.trackWidth.min, constraints.trackWidth.max);
    const turnWidthMultiplier = config.turnWidthMultiplier ?? this.randomInRange(rng, constraints.turnWidthMultiplier.min, constraints.turnWidthMultiplier.max);
    const maxBankingAngle = config.maxBankingAngle ?? this.randomInRange(rng, constraints.maxBankingAngle.min, constraints.maxBankingAngle.max);
    const triangleRadius = config.triangleRadius ?? this.randomInRange(rng, constraints.triangleRadius.min, constraints.triangleRadius.max);
    const squareRadius = config.squareRadius ?? this.randomInRange(rng, constraints.squareRadius.min, constraints.squareRadius.max);

    // Min banking is roughly 1/3 of max banking
    const minBankingAngle = config.minBankingAngle ?? maxBankingAngle * 0.33;

    // Shape-specific parameters (using seeded RNG)
    const triOvalAngle = config.triOvalAngle ?? this.randomInRange(rng, 0.5, 1.3);
    const doglegIntensity = config.doglegIntensity ?? this.randomInRange(rng, 0.5, 1.0);
    const triangleRotation = config.triangleRotation ?? rng() * Math.PI * 2;
    const squareRotation = config.squareRotation ?? rng() * Math.PI * 2;

    // Egg-specific parameters (separate from trioval for independent tuning)
    const eggAngle = config.eggAngle ?? this.randomInRange(rng, 0.3, 0.6);
    const eggIntensity = config.eggIntensity ?? this.randomInRange(rng, 0.4, 0.8);

    // Paperclip-specific parameters
    const paperclipEccentricity = config.paperclipEccentricity ?? this.randomInRange(rng, 1.5, 3.0);
    const paperclipBankingMultiplier = config.paperclipBankingMultiplier ?? this.randomInRange(rng, 0.25, 0.5);

    // Surface type defaults to asphalt if not specified
    const surfaceType = config.surfaceType ?? 'asphalt';

    const generator = new OvalTrackGenerator({
      ...config,
      shape: selectedShape,
      sizeClass: selectedSizeClass,
      surfaceType,
      seed, // Use the same seed for internal generation
      straightLength,
      turnRadius,
      trackWidth,
      turnWidthMultiplier,
      maxBankingAngle,
      minBankingAngle,
      triangleRadius,
      triOvalAngle,
      doglegIntensity,
      triangleRotation,
      squareRadius,
      squareRotation,
      eggAngle,
      eggIntensity,
      paperclipEccentricity,
      paperclipBankingMultiplier,
    });
    return generator.generate();
  }
}

import { CONFIG } from '../utils/Constants';
import type { Car } from '../entities/Car';
import type { Track } from '../track/Track';
import type { RaceTimer } from '../race/RaceTimer';
import { TrackRenderer } from './TrackRenderer';
import { SkidMarkRenderer } from './SkidMarkRenderer';
import { Vector2 } from '../utils/Vector2';

export type ResizeCallback = (scale: number, offsetX: number, offsetY: number) => void;

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private trackRenderer: TrackRenderer;
  private skidMarkRenderer: SkidMarkRenderer;
  private scale: number = 1;
  private trackWidth: number = 0;
  private trackHeight: number = 0;
  private trackOffsetX: number = 0;
  private trackOffsetY: number = 0;
  private currentTrack: Track | null = null;
  private resizeHandler: (() => void) | null = null;
  private onResizeCallback: ResizeCallback | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D context');
    this.ctx = ctx;
    this.trackRenderer = new TrackRenderer();
    this.skidMarkRenderer = new SkidMarkRenderer();

    // Set up window resize handler
    this.resizeHandler = () => {
      if (this.currentTrack) {
        this.resizeToFitTrack(this.currentTrack);
        if (this.onResizeCallback) {
          this.onResizeCallback(this.scale, this.trackOffsetX, this.trackOffsetY);
        }
      }
    };
    window.addEventListener('resize', this.resizeHandler);
  }

  /**
   * Set a callback to be notified when canvas is resized.
   * Used to update input scale.
   */
  setOnResize(callback: ResizeCallback): void {
    this.onResizeCallback = callback;
  }

  /**
   * Resize canvas to fit viewport while maintaining track aspect ratio.
   *
   * Strategy for crisp rendering:
   * - Canvas internal resolution = track size * scale * DPR (full resolution at display size)
   * - CSS size = track size * scale (display size in CSS pixels)
   * - Context transform = DPR only (maps CSS coordinates to canvas pixels)
   * - Drawing uses world coordinates directly (no additional scaling needed)
   *
   * This ensures 1:1 pixel mapping between canvas buffer and display pixels.
   */
  resizeToFitTrack(track: Track): void {
    // Store track reference for resize handler
    this.currentTrack = track;

    const bounds = track.getBounds();

    // Use more padding for GP tracks to show off-track areas
    // Ovals have walls so less padding is needed
    const trackType = track.metadata.type;
    const padding = trackType === 'grandprix' ? 60 : 20;

    // Track logical dimensions (what we're rendering in world units)
    // Add padding on all sides: account for min bounds (offset from origin) + max bounds + padding on both ends
    this.trackWidth = bounds.max.x - bounds.min.x + padding * 2;
    this.trackHeight = bounds.max.y - bounds.min.y + padding * 2;

    // Store offset for rendering transform (to center content with padding)
    this.trackOffsetX = bounds.min.x - padding;
    this.trackOffsetY = bounds.min.y - padding;

    // Get available viewport space from the canvas container
    const container = this.canvas.parentElement;
    if (!container) {
      // Fallback to track size if no container
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = this.trackWidth * dpr;
      this.canvas.height = this.trackHeight * dpr;
      this.canvas.style.width = `${this.trackWidth}px`;
      this.canvas.style.height = `${this.trackHeight}px`;
      this.scale = 1;
      return;
    }

    // Get container dimensions directly - it's sized by flexbox
    const containerRect = container.getBoundingClientRect();
    const viewportWidth = containerRect.width;
    const viewportHeight = containerRect.height;

    // Ensure we have valid dimensions (container may not be laid out yet)
    if (viewportWidth <= 0 || viewportHeight <= 0) {
      // Fallback to track size
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = this.trackWidth * dpr;
      this.canvas.height = this.trackHeight * dpr;
      this.canvas.style.width = `${this.trackWidth}px`;
      this.canvas.style.height = `${this.trackHeight}px`;
      this.scale = 1;
      return;
    }

    // Calculate scale to fit track in viewport while maintaining aspect ratio
    const scaleX = viewportWidth / this.trackWidth;
    const scaleY = viewportHeight / this.trackHeight;
    this.scale = Math.min(scaleX, scaleY);

    // Display size in CSS pixels
    const displayWidth = Math.floor(this.trackWidth * this.scale);
    const displayHeight = Math.floor(this.trackHeight * this.scale);

    // Canvas internal resolution = display size * DPR for crisp HiDPI rendering
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = displayWidth * dpr;
    this.canvas.height = displayHeight * dpr;

    // CSS size matches display size
    this.canvas.style.width = `${displayWidth}px`;
    this.canvas.style.height = `${displayHeight}px`;

    // Base transform: DPR scaling only (applied once in resizeToFitTrack)
    // The render transform will add the world-to-display scale
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }


  clear(): void {
    // Reset transform to clear entire canvas
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.fillStyle = CONFIG.COLORS.BACKGROUND;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
  }

  /**
   * Apply the combined transform for rendering.
   * Maps world coordinates to canvas pixels: world -> translate (offset) -> display (scale) -> canvas (DPR)
   */
  private applyRenderTransform(): void {
    const dpr = window.devicePixelRatio || 1;
    const combinedScale = this.scale * dpr;
    // Combined transform: translate to account for padding offset, then scale
    this.ctx.setTransform(
      combinedScale, 0, 0, combinedScale,
      -this.trackOffsetX * combinedScale,
      -this.trackOffsetY * combinedScale
    );
  }

  render(cars: Car[], track?: Track, raceTimer?: RaceTimer, carInputs?: Map<Car, Vector2>): void {
    this.clear();

    // Apply scale transform for all rendering
    this.applyRenderTransform();

    // Render track first (background)
    if (track) {
      this.trackRenderer.render(this.ctx, track, raceTimer?.getSectorManager(), this.scale, this.trackOffsetX, this.trackOffsetY);
    }

    // Render skid marks (between track and cars)
    for (const car of cars) {
      this.skidMarkRenderer.render(this.ctx, car);
    }

    // Render all cars
    for (const car of cars) {
      const input = carInputs?.get(car) ?? Vector2.zero();
      this.renderCar(car, input);
    }
  }

  clearSkidMarks(): void {
    this.skidMarkRenderer.clear();
  }

  recordSkidMark(car: Car, heat: number): void {
    this.skidMarkRenderer.addPoint(car, heat);
  }

  setTrackDebug(show: boolean): void {
    this.trackRenderer.setDebug(show);
  }

  toggleTrackDebug(): void {
    this.trackRenderer.toggleDebug();
  }

  private renderCar(car: Car, input: Vector2): void {
    const pos = car.getPosition();
    const radius = car.config.radius;

    // Off-track warning ring
    if (!car.state.isOnTrack) {
      this.ctx.beginPath();
      this.ctx.arc(pos.x, pos.y, radius + 4, 0, Math.PI * 2);
      this.ctx.strokeStyle = '#ff6600';
      this.ctx.lineWidth = 2;
      this.ctx.stroke();
    }

    // Car dot
    this.ctx.beginPath();
    this.ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
    this.ctx.fillStyle = car.config.teamColor;
    this.ctx.fill();

    // Input indicator (line showing input direction and magnitude)
    const inputMag = input.magnitude();
    if (inputMag > 0.01) {
      const dir = input.normalize();
      const indicatorLength = radius * 2 * inputMag; // Scale by input magnitude
      this.ctx.beginPath();
      this.ctx.moveTo(pos.x, pos.y);
      this.ctx.lineTo(pos.x + dir.x * indicatorLength, pos.y + dir.y * indicatorLength);
      this.ctx.strokeStyle = '#ffffff';
      this.ctx.lineWidth = 2;
      this.ctx.stroke();
    }
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  getContext(): CanvasRenderingContext2D {
    return this.ctx;
  }

  /**
   * Get the current render scale (viewport scale, not including DPR)
   */
  getScale(): number {
    return this.scale;
  }

  /**
   * Get the current track offset (world coordinates of canvas origin)
   */
  getOffset(): { x: number; y: number } {
    return { x: this.trackOffsetX, y: this.trackOffsetY };
  }

  /**
   * Convert screen/CSS coordinates to world coordinates.
   * Used for mouse input handling.
   */
  screenToWorld(screenX: number, screenY: number): Vector2 {
    return new Vector2(
      screenX / this.scale + this.trackOffsetX,
      screenY / this.scale + this.trackOffsetY
    );
  }

  /**
   * Convert world coordinates to screen/CSS coordinates.
   */
  worldToScreen(worldX: number, worldY: number): Vector2 {
    return new Vector2(
      (worldX - this.trackOffsetX) * this.scale,
      (worldY - this.trackOffsetY) * this.scale
    );
  }

  destroy(): void {
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
      this.resizeHandler = null;
    }
    this.onResizeCallback = null;
    this.currentTrack = null;
  }
}

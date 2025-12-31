import { CONFIG } from '../utils/Constants';

export type UpdateCallback = (deltaTime: number) => void;
export type RenderCallback = (interpolation: number) => void;

export class GameLoop {
  private accumulator = 0;
  private lastTime = 0;
  private isRunning = false;
  private animationFrameId: number | null = null;

  private readonly timestep = CONFIG.PHYSICS_TIMESTEP;

  constructor(
    private readonly onUpdate: UpdateCallback,
    private readonly onRender: RenderCallback
  ) {}

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastTime = performance.now();
    this.loop(this.lastTime);
  }

  stop(): void {
    this.isRunning = false;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  private loop = (currentTime: number): void => {
    if (!this.isRunning) return;

    const deltaTime = currentTime - this.lastTime;
    this.lastTime = currentTime;

    // Cap delta time to prevent spiral of death
    const cappedDelta = Math.min(deltaTime, 250);
    this.accumulator += cappedDelta;

    // Fixed timestep physics updates
    while (this.accumulator >= this.timestep) {
      this.onUpdate(this.timestep / 1000); // Convert to seconds
      this.accumulator -= this.timestep;
    }

    // Render with interpolation factor for smooth visuals
    const interpolation = this.accumulator / this.timestep;
    this.onRender(interpolation);

    this.animationFrameId = requestAnimationFrame(this.loop);
  };
}

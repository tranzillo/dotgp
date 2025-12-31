import { GameLoop } from './GameLoop';
import { PhysicsEngine } from '../physics/PhysicsEngine';
import { Renderer } from '../rendering/Renderer';
import { InputManager } from '../input/InputManager';
import { Car } from '../entities/Car';
import { Track, TrackType, OvalShape, OvalSizeClass, GPSizeClass, SurfaceType } from '../track/Track';
import type { LapCompleteCallback } from '../race/RaceTimer';
import type {
  TimeTrialTrackType,
  SizeClass,
  OvalShape as TTOvalShape,
  SurfaceType as TTSurfaceType,
  FullTrackConfig,
} from '../timetrials/types';
import { TrackGenerator } from '../track/TrackGenerator';
import { OvalTrackGenerator } from '../track/OvalTrackGenerator';
import { RealTrackGenerator, getRealTrackById, REAL_TRACK_IDS } from '../track/realTracks';
import { RaceTimer } from '../race/RaceTimer';
import { ObservationBuilder } from '../ai/ObservationBuilder';
import { ReplayController } from '../replay/ReplayController';
import { CONFIG } from '../utils/Constants';
import { Vector2 } from '../utils/Vector2';
import type { RaceConfig } from '../types';
import type { Agent } from '../ai/Agent';
import type { RecordedEpisode } from '../ai/EpisodeRecorder';
import type { TrainingManager } from '../ai/TrainingManager';
import { LapReplayRecorder } from '../replay/LapReplayRecorder';
import type { LapReplay } from '../replay/types';
import type Matter from 'matter-js';
import { HTMLGameHUD } from '../ui/HTMLGameHUD';

type GameMode = 'normal' | 'replay';

/**
 * Callbacks for live lap/sector updates during gameplay.
 * Used for real-time UI updates and notifications.
 */
export interface LiveLapCallbacks {
  /** Called when a sector is completed */
  onSectorComplete?: (sectorIndex: number, sectorTime: number, deltaToReference: number) => void;
  /** Called when a lap is completed */
  onLapComplete?: (lapTime: number, sectorTimes: number[], isNewBest: boolean, isAI: boolean) => void;
  /** Called periodically with current lap progress (throttled) */
  onProgressUpdate?: (progress: number, currentLapTime: number, currentSectorTime: number) => void;
}

export class Game {
  private gameLoop: GameLoop;
  private physicsEngine: PhysicsEngine;
  private renderer: Renderer;
  private inputManager: InputManager;
  private car: Car;
  private track: Track;
  private trackSeed: number;
  private raceTimer: RaceTimer;
  private raceConfig: RaceConfig = { totalLaps: 0 }; // 0 = practice mode
  private agent: Agent | null = null;
  private observationBuilder: ObservationBuilder;
  private replayController: ReplayController;
  private mode: GameMode = 'normal';
  private trainingManager: TrainingManager | null = null;
  private trackMode: TrackType = 'grandprix';
  private ovalShape: OvalShape = 'elliptical';
  private ovalSizeClass: OvalSizeClass = 'speedway';
  private ovalSurfaceType: SurfaceType = 'asphalt';
  private paperclipEccentricity: number | undefined = undefined; // User-specified eccentricity for paperclip tracks
  private triOvalAngle: number | undefined = undefined; // User-specified cut angle for trioval/egg
  private doglegIntensity: number | undefined = undefined; // User-specified dogleg bulge for trioval/egg
  private ovalStraightLength: number | undefined = undefined;
  private ovalTurnRadius: number | undefined = undefined;
  private ovalTrackWidth: number | undefined = undefined;
  private ovalMaxBankingAngle: number | undefined = undefined;
  private gpRoughness: number | undefined = undefined;
  private gpMaxBankingAngle: number | undefined = undefined;
  private gpNumControlPoints: number | undefined = undefined;
  private gpSizeClass: GPSizeClass = 'circuit';
  private realTrackId: string = 'monaco';
  private outerWalls: Matter.Body[] = [];
  private lastInput: Vector2 = Vector2.zero();
  private lapCompleteCallback: LapCompleteCallback | null = null;
  private lapRecorder: LapReplayRecorder;
  private onReplaySaved: ((replay: LapReplay) => void) | null = null;
  private onTrackChange: ((config: FullTrackConfig) => void) | null = null;
  private aiOffTrackTime: number = 0; // Track how long AI has been off-track
  private static readonly AI_OFF_TRACK_RESET_THRESHOLD = 2.5; // seconds before reset

  // Off-track transition tracking for incident recording
  private wasOnTrack: boolean = true;

  // Live lap tracking
  private liveLapCallbacks: LiveLapCallbacks | null = null;
  private bestSectorTimes: number[] = [Infinity, Infinity, Infinity];
  private sessionBestLapTime: number = Infinity;
  private lastProgressUpdateTime: number = 0;
  private static readonly PROGRESS_UPDATE_INTERVAL = 0.1; // seconds between progress updates

  // Control mode change callback
  private onControlModeChange: ((isAI: boolean) => void) | null = null;

  // AI lap complete callback (for SIL)
  private onAILapComplete: ((replay: LapReplay) => void) | null = null;

  // HTML-based HUD
  private gameHUD: HTMLGameHUD;

  constructor(canvas: HTMLCanvasElement) {
    this.physicsEngine = new PhysicsEngine();
    this.renderer = new Renderer(canvas);
    this.inputManager = new InputManager();
    this.inputManager.setCanvas(canvas);

    // Generate initial track
    this.trackSeed = Math.floor(Math.random() * 1000000);
    this.track = this.generateTrack(this.trackSeed);

    // NOTE: Canvas resize is deferred until after HUD is created (see below)

    // Create outer wall collision bodies from wall segments
    console.log(`[INIT] Track has ${this.track.wallSegments.length} wall segments, outerBoundary has ${this.track.outerBoundary.length} points`);
    if (this.track.wallSegments.length > 0) {
      this.outerWalls = this.physicsEngine.createWallsFromSegments(
        this.track.outerBoundary,
        this.track.wallSegments,
        CONFIG.WALL_THICKNESS
      );
      console.log(`[INIT] Created ${this.outerWalls.length} wall bodies (isSensor: ${this.outerWalls[0]?.isSensor})`);
    } else {
      console.log('[INIT] NO WALL SEGMENTS - no physics walls created!');
    }

    // Create car at track spawn position
    const spawnPos = this.track.getSpawnPosition();
    this.car = new Car(this.physicsEngine, spawnPos.x, spawnPos.y);

    // Set track reference on car for banking calculations
    this.car.setTrack(this.track);

    // Create race timer
    this.raceTimer = new RaceTimer(this.track);
    this.raceTimer.setOnRaceStart(() => this.startLapRecording());
    this.raceTimer.startRace(this.car, this.raceConfig);

    // Create observation builder for AI
    this.observationBuilder = new ObservationBuilder();

    // Create replay controller
    this.replayController = new ReplayController();

    // Create always-on lap recorder
    this.lapRecorder = new LapReplayRecorder();

    // Set up input callbacks
    this.inputManager.onKeyDown('tab', () => {
      this.toggleControlMode();
    });

    this.inputManager.onKeyDown('r', () => this.resetCar());
    this.inputManager.onGamepadButton(3, () => this.resetCar()); // Y button

    this.inputManager.onKeyDown('n', () => {
      this.generateNewTrack();
    });

    this.inputManager.onKeyDown('`', () => {
      this.renderer.toggleTrackDebug();
    });

    // Track mode shortcuts - cycle size classes and generate new track
    this.inputManager.onKeyDown('g', () => {
      // Cycle GP size classes: park → circuit → autodrome
      const gpClasses: GPSizeClass[] = ['park', 'circuit', 'autodrome'];
      if (this.trackMode !== 'grandprix') {
        // Switch to GP mode with current size class
        this.trackMode = 'grandprix';
      } else {
        // Cycle to next size class
        const currentIndex = gpClasses.indexOf(this.gpSizeClass);
        this.gpSizeClass = gpClasses[(currentIndex + 1) % gpClasses.length];
      }
      this.generateNewTrack();
    });

    this.inputManager.onKeyDown('o', () => {
      // Cycle oval size classes: short → speedway → superspeedway
      const ovalClasses: OvalSizeClass[] = ['short', 'speedway', 'superspeedway'];
      if (this.trackMode !== 'oval') {
        // Switch to oval mode with current size class
        this.trackMode = 'oval';
      } else {
        // Cycle to next size class
        const currentIndex = ovalClasses.indexOf(this.ovalSizeClass);
        this.ovalSizeClass = ovalClasses[(currentIndex + 1) % ovalClasses.length];
      }
      this.generateNewTrack();
    });

    this.inputManager.onKeyDown('v', () => {
      // Toggle oval surface type: asphalt ↔ dirt
      if (this.trackMode === 'oval') {
        this.ovalSurfaceType = this.ovalSurfaceType === 'asphalt' ? 'dirt' : 'asphalt';
        this.generateNewTrack();
      }
    });

    this.inputManager.onKeyDown('f', () => {
      // Toggle to real tracks or cycle through available real tracks
      if (this.trackMode !== 'real') {
        // Switch to real track mode
        this.trackMode = 'real';
        this.realTrackId = REAL_TRACK_IDS[0];
      } else {
        // Cycle to next real track
        const currentIndex = REAL_TRACK_IDS.indexOf(this.realTrackId);
        this.realTrackId = REAL_TRACK_IDS[(currentIndex + 1) % REAL_TRACK_IDS.length];
      }
      this.generateNewTrack();
    });

    // Create HTML-based HUD
    this.gameHUD = new HTMLGameHUD('game-header', 'game-footer', {
      onReset: () => this.resetCar(),
      onNewTrack: () => this.generateNewTrack(),
      onGP: () => {
        if (this.trackMode !== 'grandprix') {
          this.trackMode = 'grandprix';
        } else {
          const gpClasses: GPSizeClass[] = ['park', 'circuit', 'autodrome'];
          const currentIndex = gpClasses.indexOf(this.gpSizeClass);
          this.gpSizeClass = gpClasses[(currentIndex + 1) % gpClasses.length];
        }
        this.generateNewTrack();
      },
      onOval: () => {
        if (this.trackMode !== 'oval') {
          this.trackMode = 'oval';
        } else {
          const ovalClasses: OvalSizeClass[] = ['short', 'speedway', 'superspeedway'];
          const currentIndex = ovalClasses.indexOf(this.ovalSizeClass);
          this.ovalSizeClass = ovalClasses[(currentIndex + 1) % ovalClasses.length];
        }
        this.generateNewTrack();
      },
      onDirt: () => {
        if (this.trackMode === 'oval') {
          this.ovalSurfaceType = this.ovalSurfaceType === 'asphalt' ? 'dirt' : 'asphalt';
          this.generateNewTrack();
        }
      },
      onToggleMode: () => this.toggleControlMode(),
    });

    // Now that HUD is created, resize canvas to fit track
    // This needs to happen after HUD so we can measure header/footer heights
    this.renderer.resizeToFitTrack(this.track);
    const offset = this.renderer.getOffset();
    this.inputManager.setRenderTransform(this.renderer.getScale(), offset.x, offset.y);

    // Update input transform when window is resized
    this.renderer.setOnResize((scale, offsetX, offsetY) => {
      this.inputManager.setRenderTransform(scale, offsetX, offsetY);
    });

    // Set up wall collision handler - just for damage, Matter.js handles physics
    this.physicsEngine.setCollisionCallback((_carBody, _wallBody, normal, speed) => {
      this.handleWallCollision(normal, speed);
    });

    // Create game loop
    this.gameLoop = new GameLoop(
      this.update.bind(this),
      this.render.bind(this)
    );
  }

  /**
   * Handle wall collision - apply damage and record incident.
   * Matter.js handles physics response.
   */
  private handleWallCollision(collisionNormal: Vector2, speed: number): void {
    // Ignore very slow collisions
    if (speed < CONFIG.COLLISION_MIN_SPEED) return;

    const velocity = this.car.getVelocity();
    const velocityMag = velocity.magnitude();
    if (velocityMag < 0.1) return;

    // Calculate impact factor for damage
    const normalDot = velocity.dot(collisionNormal);
    const impactFactor = Math.abs(normalDot) / velocityMag;

    // Apply damage only - Matter.js handles the physics
    this.car.applyCollisionDamage(impactFactor, speed);

    // Record collision incident for training quality scoring
    const pos = this.car.getPosition();
    this.lapRecorder.recordCollision({ x: pos.x, y: pos.y }, speed);
  }

  private generateTrack(seed: number): Track {
    let track: Track;

    if (this.trackMode === 'real') {
      const definition = getRealTrackById(this.realTrackId);
      if (definition) {
        track = RealTrackGenerator.generate(definition, {});
        return Track.translateToOrigin(track);
      }
      // Fallback to GP if track not found
      console.warn(`Real track '${this.realTrackId}' not found, falling back to GP`);
    }

    if (this.trackMode === 'oval') {
      track = OvalTrackGenerator.generateRandom({
        seed,
        shape: this.ovalShape,
        sizeClass: this.ovalSizeClass,
        surfaceType: this.ovalSurfaceType,
        // Pass user-specified values (undefined = randomize)
        paperclipEccentricity: this.paperclipEccentricity,
        triOvalAngle: this.triOvalAngle,
        doglegIntensity: this.doglegIntensity,
        straightLength: this.ovalStraightLength,
        turnRadius: this.ovalTurnRadius,
        trackWidth: this.ovalTrackWidth,
        maxBankingAngle: this.ovalMaxBankingAngle,
      });
    } else {
      track = TrackGenerator.generateRandom({
        seed,
        sizeClass: this.gpSizeClass,
        roughness: this.gpRoughness,
        maxBankingAngle: this.gpMaxBankingAngle,
        numControlPoints: this.gpNumControlPoints,
      });
    }

    // Translate track to minimize empty space from origin
    return Track.translateToOrigin(track);
  }

  private generateNewTrack(): void {
    // Remove old walls before generating new track
    if (this.outerWalls.length > 0) {
      this.physicsEngine.removeWalls(this.outerWalls);
      this.outerWalls = [];
    }

    // Clear all advanced params so they randomize when using keyboard shortcuts
    this.clearAdvancedTrackParams();

    // Randomize oval shape each time
    if (this.trackMode === 'oval') {
      const shapes: OvalShape[] = ['elliptical', 'trioval', 'triangle', 'square', 'egg', 'paperclip'];
      this.ovalShape = shapes[Math.floor(Math.random() * shapes.length)];
    }

    this.trackSeed = Math.floor(Math.random() * 1000000);
    this.track = this.generateTrack(this.trackSeed);

    // Resize canvas and clear skid marks for new track
    this.renderer.resizeToFitTrack(this.track);
    const newOffset = this.renderer.getOffset();
    this.inputManager.setRenderTransform(this.renderer.getScale(), newOffset.x, newOffset.y);
    this.renderer.clearSkidMarks();

    // Create outer wall collision bodies from wall segments
    if (this.track.wallSegments.length > 0) {
      this.outerWalls = this.physicsEngine.createWallsFromSegments(
        this.track.outerBoundary,
        this.track.wallSegments,
        CONFIG.WALL_THICKNESS
      );
    }

    // Create new race timer for new track and re-hook callbacks
    this.raceTimer = new RaceTimer(this.track);
    this.raceTimer.setOnRaceStart(() => this.startLapRecording());
    if (this.lapCompleteCallback) {
      this.raceTimer.setOnLapComplete(this.lapCompleteCallback);
    }

    // Set track reference on car for banking calculations
    this.car.setTrack(this.track);

    const spawn = this.track.getSpawnPosition();
    const spawnAngle = this.track.getSpawnAngle();
    this.car.reset(spawn.x, spawn.y, spawnAngle);
    this.raceTimer.startRace(this.car, this.raceConfig);

    const trackTypeStr = this.trackMode === 'real'
      ? `real track: ${this.realTrackId}`
      : this.trackMode === 'oval'
      ? `oval ${this.ovalSizeClass} (${this.ovalShape}, ${this.ovalSurfaceType})`
      : `grand prix ${this.gpSizeClass}`;
    console.log(`New ${trackTypeStr} track generated with seed: ${this.trackSeed}`);

    // Reset session best times for new track
    this.resetSessionBests();

    // Notify track change callback
    this.onTrackChange?.(this.getFullTrackConfig());
  }

  private resetCar(): void {
    // Discard any in-progress recording
    this.lapRecorder.discardLap();

    // Reset car to spawn
    const spawn = this.track.getSpawnPosition();
    const spawnAngle = this.track.getSpawnAngle();
    this.car.reset(spawn.x, spawn.y, spawnAngle);

    // Reset timer to waiting state
    this.raceTimer.resetTimer();
    this.raceTimer.startRace(this.car, this.raceConfig);

    // Clear skid marks for clean visual
    this.renderer.clearSkidMarks();

    // Reset AI off-track timer and track state
    this.aiOffTrackTime = 0;
    this.wasOnTrack = true;
  }

  /**
   * Reset for a new lap attempt.
   * Resets car position, timer, and discards any in-progress recording.
   * Used when activating AI agent or manually restarting.
   */
  resetForNewLap(): void {
    // Discard any in-progress recording
    this.lapRecorder.discardLap();

    // Reset car to spawn
    const spawn = this.track.getSpawnPosition();
    const spawnAngle = this.track.getSpawnAngle();
    this.car.reset(spawn.x, spawn.y, spawnAngle);

    // Reset timer to waiting state
    this.raceTimer.resetTimer();
    this.raceTimer.startRace(this.car, this.raceConfig);

    // Clear skid marks for clean visual
    this.renderer.clearSkidMarks();

    // Reset AI off-track timer and track state
    this.aiOffTrackTime = 0;
    this.wasOnTrack = true;
  }

  start(): void {
    this.gameLoop.start();
  }

  stop(): void {
    this.gameLoop.stop();
  }

  private update(deltaTime: number): void {
    // Poll gamepad buttons
    this.inputManager.pollGamepadButtons();

    // Handle replay mode
    if (this.mode === 'replay') {
      this.updateReplay(deltaTime);
      return;
    }

    // Handle pit stop logic first
    this.car.state.isInPit = this.track.isPointInPitZone(this.car.getPosition());

    if (this.car.state.isPitting) {
      // Currently pitting - update timer
      const completed = this.car.updatePitStop(deltaTime);
      if (completed) {
        console.log('Pit stop complete! Resources restored.');
      }
      // Can't accelerate while pitting
      this.lastInput = Vector2.zero();
    } else {
      // Check if should start pit stop
      if (
        this.car.state.isInPit &&
        this.car.getSpeed() < CONFIG.PIT_STOP_MAX_SPEED
      ) {
        this.car.startPitStop(CONFIG.PIT_STOP_DURATION);
        console.log('Pit stop started...');
      }

      // Handle input (only when not pitting)
      // Update car position for mouse control
      this.inputManager.setCarPosition(this.car.getPosition());

      if (this.car.state.controlMode === 'keyboard') {
        const input = this.inputManager.getAccelerationInput();
        this.lastInput = input;

        // Race starts on line crossing (handled by RaceTimer callback)
        // Record lap frames with observations for training (only after race started)
        if (this.lapRecorder.isRecording() && !this.raceTimer.isWaitingForStart(this.car)) {
          const obs = this.observationBuilder.build(this.car, this.track);
          this.lapRecorder.recordFrame({ x: input.x, y: input.y }, obs.features);
        }

        this.car.applyAcceleration(input);
      } else if (this.car.state.controlMode === 'ai' && this.agent) {
        // Get observation and action from AI agent
        const observation = this.observationBuilder.build(this.car, this.track);
        const action = this.agent.getAction(observation.features);
        this.lastInput = new Vector2(action.x, action.y);

        // Race starts on line crossing (handled by RaceTimer callback)
        // Record lap frames with observations for training (only after race started)
        if (this.lapRecorder.isRecording() && !this.raceTimer.isWaitingForStart(this.car)) {
          this.lapRecorder.recordFrame(action, observation.features);
        }

        this.car.applyAcceleration(this.lastInput);
      }
    }

    // Update physics (collision response now handled inside PhysicsEngine)
    this.physicsEngine.update(deltaTime);

    // Update car state (pass track for off-track detection)
    const isOnTrack = this.track.isPointOnTrack(this.car.getPosition());
    this.car.state.isOnTrack = isOnTrack;

    // Track off-track transitions for incident recording
    if (this.wasOnTrack && !isOnTrack) {
      // Just went off-track
      const pos = this.car.getPosition();
      this.lapRecorder.startOffTrack({ x: pos.x, y: pos.y });
    } else if (!this.wasOnTrack && isOnTrack) {
      // Just returned to track
      this.lapRecorder.endOffTrack();
    }
    this.wasOnTrack = isOnTrack;

    this.car.update(deltaTime);

    // AI off-track timeout: reset lap if AI is stuck off-track too long
    if (this.car.state.controlMode === 'ai' && this.agent) {
      if (!this.car.state.isOnTrack) {
        this.aiOffTrackTime += deltaTime;
        if (this.aiOffTrackTime >= Game.AI_OFF_TRACK_RESET_THRESHOLD) {
          console.log('AI off-track too long, resetting lap...');
          this.resetForNewLap();
          this.aiOffTrackTime = 0;
        }
      } else {
        // Reset timer when back on track
        this.aiOffTrackTime = 0;
      }
    }

    // Update race timer (sector/lap tracking)
    this.raceTimer.update(this.car, deltaTime);

    // Fire throttled progress updates for live UI
    this.lastProgressUpdateTime += deltaTime;
    if (this.lastProgressUpdateTime >= Game.PROGRESS_UPDATE_INTERVAL && this.liveLapCallbacks?.onProgressUpdate) {
      this.lastProgressUpdateTime = 0;
      const progress = this.track.getTrackProgress(this.car.getPosition());
      const lapTime = this.raceTimer.getCurrentLapTime(this.car);
      const sectorTime = this.raceTimer.getCurrentSectorTime(this.car);
      this.liveLapCallbacks.onProgressUpdate(progress, lapTime, sectorTime);
    }

    // Record skid marks based on tire heat
    const heat = this.car.getHeat();
    if (heat > 0.01 || this.car.getSpeed() > 0.5) {
      // Always record when moving, heat determines opacity
      this.renderer.recordSkidMark(this.car, heat);
    }
  }

  private updateReplay(deltaTime: number): void {
    // Get current action from replay
    const action = this.replayController.getCurrentAction();

    if (action) {
      // Apply the recorded action
      this.lastInput = new Vector2(action.x, action.y);
      this.car.applyAcceleration(this.lastInput);

      // Advance to next frame
      this.replayController.advance();
    } else {
      this.lastInput = Vector2.zero();
    }

    // Update physics
    this.physicsEngine.update(deltaTime);

    // Update car state
    this.car.state.isOnTrack = this.track.isPointOnTrack(this.car.getPosition());
    this.car.update(deltaTime);

    // Update race timer
    this.raceTimer.update(this.car, deltaTime);

    // Record skid marks
    const heat = this.car.getHeat();
    if (heat > 0.01 || this.car.getSpeed() > 0.5) {
      this.renderer.recordSkidMark(this.car, heat);
    }

    // Check if replay is done
    if (this.replayController.isDone()) {
      // Replay finished - stay in replay mode but paused
      // User must click "Stop Replay" to exit
    }
  }

  private render(_interpolation: number): void {
    const carInputs = new Map<Car, Vector2>();
    carInputs.set(this.car, this.lastInput);
    this.renderer.render([this.car], this.track, this.raceTimer, carInputs);

    // Update HTML HUD
    this.gameHUD.update(this.car, this.track, this.raceTimer);
  }

  destroy(): void {
    this.stop();
    this.inputManager.destroy();
    this.renderer.destroy();
  }

  /**
   * Set AI agent for controlling the car.
   */
  setAgent(agent: Agent | null): void {
    this.agent = agent;
    if (agent) {
      this.car.setControlMode('ai');
      this.onControlModeChange?.(true);
    }
  }

  /**
   * Get current AI agent.
   */
  getAgent(): Agent | null {
    return this.agent;
  }

  /**
   * Toggle between keyboard and AI control modes.
   * Fires the control mode change callback.
   */
  toggleControlMode(): void {
    const wasAI = this.car.state.controlMode === 'ai';
    this.car.toggleControlMode();
    const isAI = this.car.state.controlMode === 'ai';

    // Only fire callback if mode actually changed
    if (wasAI !== isAI) {
      this.onControlModeChange?.(isAI);
    }
  }

  /**
   * Set callback for control mode changes (keyboard <-> AI).
   * Used to auto-start/stop SIL when AI is activated/deactivated.
   */
  setControlModeChangeCallback(callback: ((isAI: boolean) => void) | null): void {
    this.onControlModeChange = callback;
  }

  /**
   * Set callback for AI lap completions.
   * Used by SIL to collect completed laps for self-training.
   */
  setAILapCompleteCallback(callback: ((replay: LapReplay) => void) | null): void {
    this.onAILapComplete = callback;
  }

  /**
   * Get game objects for external use (e.g., visual training).
   */
  getCar(): Car {
    return this.car;
  }

  getTrack(): Track {
    return this.track;
  }

  getRaceTimer(): RaceTimer {
    return this.raceTimer;
  }

  getTrackSeed(): number {
    return this.trackSeed;
  }

  getRenderer(): Renderer {
    return this.renderer;
  }

  getInputManager(): InputManager {
    return this.inputManager;
  }

  /**
   * Enter replay mode with a recorded episode.
   */
  setReplayMode(episode: RecordedEpisode): void {
    // Remove old walls before generating new track
    if (this.outerWalls.length > 0) {
      this.physicsEngine.removeWalls(this.outerWalls);
      this.outerWalls = [];
    }

    // Generate the track from the episode's seed
    this.trackSeed = episode.trackSeed;
    this.track = this.generateTrack(this.trackSeed);

    // Resize canvas and clear skid marks
    this.renderer.resizeToFitTrack(this.track);
    const replayOffset = this.renderer.getOffset();
    this.inputManager.setRenderTransform(this.renderer.getScale(), replayOffset.x, replayOffset.y);
    this.renderer.clearSkidMarks();

    // Create outer wall collision bodies from wall segments
    if (this.track.wallSegments.length > 0) {
      this.outerWalls = this.physicsEngine.createWallsFromSegments(
        this.track.outerBoundary,
        this.track.wallSegments,
        CONFIG.WALL_THICKNESS
      );
    }

    // Reset car to spawn position with correct heading
    const spawn = this.track.getSpawnPosition();
    const spawnAngle = this.track.getSpawnAngle();
    this.car.reset(spawn.x, spawn.y, spawnAngle);

    // Create new race timer for the track and re-hook callbacks
    this.raceTimer = new RaceTimer(this.track);
    this.raceTimer.setOnRaceStart(() => this.startLapRecording());
    if (this.lapCompleteCallback) {
      this.raceTimer.setOnLapComplete(this.lapCompleteCallback);
    }
    this.raceTimer.startRace(this.car, this.raceConfig);

    // Load and start replay
    this.replayController.loadEpisode(episode);
    this.replayController.play();

    this.mode = 'replay';
    console.log(`Replaying episode ${episode.episodeNumber} (${episode.frames.length} frames)`);
  }

  /**
   * Enter replay mode with a lap replay.
   */
  playLapReplay(replay: LapReplay): void {
    // Remove old walls before generating new track
    if (this.outerWalls.length > 0) {
      this.physicsEngine.removeWalls(this.outerWalls);
      this.outerWalls = [];
    }

    // Load the track from replay config
    const config = replay.trackConfig;
    this.loadTrackFromSeed(
      config.baseSeed,
      config.trackType,
      config.sizeClass,
      config.surfaceType,
      config.ovalShape
    );

    // Restore car state from replay OR fallback to spawn
    if (replay.initialState) {
      this.car.restoreState(replay.initialState);
    } else {
      // Fallback for old replays without initial state
      const spawn = this.track.getSpawnPosition();
      const spawnAngle = this.track.getSpawnAngle();
      this.car.reset(spawn.x, spawn.y, spawnAngle);
      console.warn('Replay missing initial state - using spawn position');
    }

    // Create new race timer and start immediately (no waiting)
    // Note: We must re-hook the callbacks since loadTrackFromSeed created a timer that we're replacing
    this.raceTimer = new RaceTimer(this.track);
    this.raceTimer.setOnRaceStart(() => this.startLapRecording());
    if (this.lapCompleteCallback) {
      this.raceTimer.setOnLapComplete(this.lapCompleteCallback);
    }
    this.raceTimer.startRace(this.car, this.raceConfig);
    this.raceTimer.beginRace(this.car); // Start timing immediately for replay

    // Load and start replay
    this.replayController.loadLapReplay(replay);
    this.replayController.play();

    this.mode = 'replay';
    console.log(`Playing lap replay: ${replay.lapTime.toFixed(2)}s (${replay.frames.length} frames)`);
  }

  /**
   * Exit replay mode.
   */
  exitReplayMode(): void {
    console.log('[DEBUG] exitReplayMode called');
    this.replayController.stop();
    this.replayController.clear();
    this.mode = 'normal';

    // Discard any stale lap recording from before replay mode
    this.lapRecorder.discardLap();

    // Reset car position with correct heading
    const spawn = this.track.getSpawnPosition();
    const spawnAngle = this.track.getSpawnAngle();
    this.car.reset(spawn.x, spawn.y, spawnAngle);

    // Reset timer to waiting state so new laps can be recorded
    this.raceTimer.resetTimer();
    this.raceTimer.startRace(this.car, this.raceConfig);

    console.log('[DEBUG] After exitReplayMode: isWaitingForStart=', this.raceTimer.isWaitingForStart(this.car));
    console.log('[DEBUG] After exitReplayMode: controlMode=', this.car.state.controlMode);
    console.log('[DEBUG] After exitReplayMode: isRecording=', this.lapRecorder.isRecording());

    // Clear skid marks for clean visual
    this.renderer.clearSkidMarks();

    // Reset AI off-track timer
    this.aiOffTrackTime = 0;
  }

  /**
   * Check if in replay mode.
   */
  isReplayMode(): boolean {
    return this.mode === 'replay';
  }

  /**
   * Get replay controller.
   */
  getReplayController(): ReplayController {
    return this.replayController;
  }

  /**
   * Set the training manager for UI integration.
   */
  setTrainingManager(manager: TrainingManager): void {
    this.trainingManager = manager;
  }

  /**
   * Get the training manager.
   */
  getTrainingManager(): TrainingManager | null {
    return this.trainingManager;
  }

  /**
   * Get the canvas element.
   */
  getCanvas(): HTMLCanvasElement {
    return this.renderer.getCanvas();
  }

  /**
   * Set a callback to be invoked when a lap is completed.
   * The callback is automatically re-hooked when the track changes.
   */
  setLapCompleteCallback(callback: LapCompleteCallback | null): void {
    this.lapCompleteCallback = callback;
    if (callback) {
      this.raceTimer.setOnLapComplete(callback);
    } else {
      this.raceTimer.clearOnLapComplete();
    }
  }

  /**
   * Load a specific track from seed with full configuration.
   * Used by the time trial system to load specific track configurations.
   */
  loadTrackFromSeed(
    seed: number,
    trackType: TimeTrialTrackType,
    sizeClass: SizeClass,
    surfaceType?: TTSurfaceType,
    ovalShape?: TTOvalShape
  ): void {
    // Remove old walls
    if (this.outerWalls.length > 0) {
      this.physicsEngine.removeWalls(this.outerWalls);
      this.outerWalls = [];
    }

    // Set track mode and size class based on type
    if (trackType === 'gp') {
      this.trackMode = 'grandprix';
      this.gpSizeClass = sizeClass as GPSizeClass;
    } else if (trackType === 'oval') {
      this.trackMode = 'oval';
      this.ovalSizeClass = sizeClass as OvalSizeClass;
      // Use provided oval shape or default
      this.ovalShape = (ovalShape as OvalShape) || 'elliptical';
      this.ovalSurfaceType = (surfaceType as SurfaceType) || 'asphalt';
    }

    // Generate track with the specified seed
    this.trackSeed = seed;
    this.track = this.generateTrack(seed);

    // Resize canvas and clear skid marks
    this.renderer.resizeToFitTrack(this.track);
    const seedOffset = this.renderer.getOffset();
    this.inputManager.setRenderTransform(this.renderer.getScale(), seedOffset.x, seedOffset.y);
    this.renderer.clearSkidMarks();

    // Create outer wall collision bodies
    if (this.track.wallSegments.length > 0) {
      this.outerWalls = this.physicsEngine.createWallsFromSegments(
        this.track.outerBoundary,
        this.track.wallSegments,
        CONFIG.WALL_THICKNESS
      );
    }

    // Create new race timer and re-hook callbacks
    this.raceTimer = new RaceTimer(this.track);
    this.raceTimer.setOnRaceStart(() => this.startLapRecording());
    if (this.lapCompleteCallback) {
      this.raceTimer.setOnLapComplete(this.lapCompleteCallback);
    }

    // Set track reference on car
    this.car.setTrack(this.track);

    // Reset car position
    const spawn = this.track.getSpawnPosition();
    const spawnAngle = this.track.getSpawnAngle();
    this.car.reset(spawn.x, spawn.y, spawnAngle);
    this.raceTimer.startRace(this.car, this.raceConfig);

    const trackTypeStr =
      trackType === 'oval'
        ? `oval ${sizeClass} (${this.ovalShape}, ${this.ovalSurfaceType})`
        : `grand prix ${sizeClass}`;
    console.log(`Loaded ${trackTypeStr} track with seed: ${seed}`);

    // Notify track change callback
    this.onTrackChange?.(this.getFullTrackConfig());
  }

  /**
   * Get the current track type in TimeTrialTrackType format.
   */
  getCurrentTrackType(): TimeTrialTrackType {
    if (this.trackMode === 'oval') return 'oval';
    return 'gp';
  }

  /**
   * Get the current size class.
   */
  getCurrentSizeClass(): SizeClass {
    if (this.trackMode === 'oval') return this.ovalSizeClass;
    return this.gpSizeClass;
  }

  /**
   * Get full track configuration for composite seed encoding.
   */
  getFullTrackConfig(): FullTrackConfig {
    return {
      baseSeed: this.trackSeed,
      trackType: this.getCurrentTrackType(),
      sizeClass: this.getCurrentSizeClass(),
      surfaceType: this.ovalSurfaceType as TTSurfaceType,
      ovalShape: this.ovalShape as TTOvalShape,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Track Configuration Setters
  // ─────────────────────────────────────────────────────────────

  /**
   * Set the track type (gp, oval).
   */
  setTrackType(type: TimeTrialTrackType): void {
    if (type === 'gp') this.trackMode = 'grandprix';
    else if (type === 'oval') this.trackMode = 'oval';
  }

  /**
   * Set the size class for the current track type.
   */
  setSizeClass(sizeClass: SizeClass): void {
    if (this.trackMode === 'oval') {
      this.ovalSizeClass = sizeClass as OvalSizeClass;
    } else {
      this.gpSizeClass = sizeClass as GPSizeClass;
    }
  }

  /**
   * Set the surface type (asphalt, dirt) for oval tracks.
   */
  setSurfaceType(surface: SurfaceType): void {
    this.ovalSurfaceType = surface;
  }

  /**
   * Set the oval shape.
   */
  setOvalShape(shape: OvalShape): void {
    this.ovalShape = shape;
  }

  /**
   * Set the paperclip eccentricity (stretch factor for paperclip tracks).
   * Values 1.5-3.0, higher = longer straights.
   */
  setPaperclipEccentricity(eccentricity: number | undefined): void {
    this.paperclipEccentricity = eccentricity;
  }

  /**
   * Set trioval/egg cut angle (radians).
   */
  setTriOvalAngle(angle: number | undefined): void {
    this.triOvalAngle = angle;
  }

  /**
   * Set dogleg intensity for trioval/egg shapes.
   */
  setDoglegIntensity(intensity: number | undefined): void {
    this.doglegIntensity = intensity;
  }

  /**
   * Set oval straight length.
   */
  setOvalStraightLength(length: number | undefined): void {
    this.ovalStraightLength = length;
  }

  /**
   * Set oval turn radius.
   */
  setOvalTurnRadius(radius: number | undefined): void {
    this.ovalTurnRadius = radius;
  }

  /**
   * Set oval track width.
   */
  setOvalTrackWidth(width: number | undefined): void {
    this.ovalTrackWidth = width;
  }

  /**
   * Set oval max banking angle (radians).
   */
  setOvalMaxBankingAngle(angle: number | undefined): void {
    this.ovalMaxBankingAngle = angle;
  }

  /**
   * Set GP roughness.
   */
  setGPRoughness(roughness: number | undefined): void {
    this.gpRoughness = roughness;
  }

  /**
   * Set GP max banking angle (radians).
   */
  setGPMaxBankingAngle(angle: number | undefined): void {
    this.gpMaxBankingAngle = angle;
  }

  /**
   * Set GP number of control points (corners).
   */
  setGPNumControlPoints(count: number | undefined): void {
    this.gpNumControlPoints = count;
  }

  /**
   * Clear all advanced track parameters (reset to randomize).
   */
  clearAdvancedTrackParams(): void {
    this.paperclipEccentricity = undefined;
    this.triOvalAngle = undefined;
    this.doglegIntensity = undefined;
    this.ovalStraightLength = undefined;
    this.ovalTurnRadius = undefined;
    this.ovalTrackWidth = undefined;
    this.ovalMaxBankingAngle = undefined;
    this.gpRoughness = undefined;
    this.gpMaxBankingAngle = undefined;
    this.gpNumControlPoints = undefined;
  }

  /**
   * Generate a new track with current settings (no randomization).
   * Unlike generateNewTrack(), this does NOT randomize oval shape.
   */
  generateNewTrackWithCurrentSettings(): void {
    // Remove old walls before generating new track
    if (this.outerWalls.length > 0) {
      this.physicsEngine.removeWalls(this.outerWalls);
      this.outerWalls = [];
    }

    // Generate with current settings (do NOT randomize shape)
    this.trackSeed = Math.floor(Math.random() * 1000000);
    this.track = this.generateTrack(this.trackSeed);

    // Resize canvas and clear skid marks for new track
    this.renderer.resizeToFitTrack(this.track);
    const newOffset = this.renderer.getOffset();
    this.inputManager.setRenderTransform(this.renderer.getScale(), newOffset.x, newOffset.y);
    this.renderer.clearSkidMarks();

    // Create outer wall collision bodies from wall segments
    if (this.track.wallSegments.length > 0) {
      this.outerWalls = this.physicsEngine.createWallsFromSegments(
        this.track.outerBoundary,
        this.track.wallSegments,
        CONFIG.WALL_THICKNESS
      );
    }

    // Create new race timer for new track and re-hook callbacks
    this.raceTimer = new RaceTimer(this.track);
    this.raceTimer.setOnRaceStart(() => this.startLapRecording());
    if (this.lapCompleteCallback) {
      this.raceTimer.setOnLapComplete(this.lapCompleteCallback);
    }

    // Set track reference on car for banking calculations
    this.car.setTrack(this.track);

    const spawn = this.track.getSpawnPosition();
    const spawnAngle = this.track.getSpawnAngle();
    this.car.reset(spawn.x, spawn.y, spawnAngle);
    this.raceTimer.startRace(this.car, this.raceConfig);

    const trackTypeStr = this.trackMode === 'real'
      ? `real track: ${this.realTrackId}`
      : this.trackMode === 'oval'
      ? `oval ${this.ovalSizeClass} (${this.ovalShape}, ${this.ovalSurfaceType})`
      : `grand prix ${this.gpSizeClass}`;
    console.log(`New ${trackTypeStr} track generated with seed: ${this.trackSeed}`);

    // Reset session best times for new track
    this.resetSessionBests();

    // Notify track change callback
    this.onTrackChange?.(this.getFullTrackConfig());
  }

  // ─────────────────────────────────────────────────────────────
  // Always-On Lap Recording
  // ─────────────────────────────────────────────────────────────

  /**
   * Start recording a new lap.
   * Called when car crosses start line.
   * Captures initial car state for accurate replay playback.
   */
  startLapRecording(): void {
    console.log('[DEBUG] startLapRecording called');
    const trackConfig = this.getFullTrackConfig();
    const initialState = this.car.captureState();
    this.lapRecorder.startLap(trackConfig, initialState);
    console.log('[DEBUG] After startLapRecording: isRecording=', this.lapRecorder.isRecording());
  }

  /**
   * Discard current lap recording.
   * Called on car reset or when lap is invalid.
   */
  discardLapRecording(): void {
    this.lapRecorder.discardLap();
  }

  /**
   * Complete current lap recording and save to storage.
   * Called when a valid lap is completed.
   */
  async completeLapRecording(
    lapTime: number,
    sectorTimes: number[],
    isAI: boolean,
    agentName?: string
  ): Promise<LapReplay | null> {
    console.log('[DEBUG] completeLapRecording called:', { lapTime, isAI, isRecording: this.lapRecorder.isRecording() });

    // Check if this is a new session best
    const isNewBest = lapTime < this.sessionBestLapTime;
    if (isNewBest) {
      this.sessionBestLapTime = lapTime;
    }

    // Fire live lap complete callback
    this.liveLapCallbacks?.onLapComplete?.(lapTime, sectorTimes, isNewBest, isAI);

    const replay = await this.lapRecorder.completeLap(lapTime, sectorTimes, isAI, agentName);
    console.log('[DEBUG] completeLap returned:', replay ? `replay with ${replay.frames.length} frames` : 'null');
    if (replay) {
      this.onReplaySaved?.(replay);

      // Fire AI lap complete callback for SIL
      if (isAI) {
        this.onAILapComplete?.(replay);
      }
    }
    return replay;
  }

  /**
   * Set player initials for lap recordings.
   */
  setPlayerInitials(initials: string): void {
    this.lapRecorder.setPlayerInitials(initials);
  }

  /**
   * Set callback for when a replay is saved.
   */
  setReplaySavedCallback(callback: ((replay: LapReplay) => void) | null): void {
    this.onReplaySaved = callback;
  }

  /**
   * Set callbacks for live lap/sector updates.
   * Used for real-time UI feedback and notifications.
   */
  setLiveLapCallbacks(callbacks: LiveLapCallbacks | null): void {
    this.liveLapCallbacks = callbacks;

    // Set up sector complete callback on race timer
    if (callbacks?.onSectorComplete) {
      this.raceTimer.setOnSectorComplete((_car, sectorIndex, sectorTime) => {
        // Calculate delta to best sector time
        const delta = sectorTime - this.bestSectorTimes[sectorIndex];

        // Update best sector time if this is faster
        if (sectorTime < this.bestSectorTimes[sectorIndex]) {
          this.bestSectorTimes[sectorIndex] = sectorTime;
        }

        callbacks.onSectorComplete?.(sectorIndex, sectorTime, delta);
      });
    } else {
      this.raceTimer.clearOnSectorComplete();
    }
  }

  /**
   * Get current best sector times for this session.
   */
  getBestSectorTimes(): number[] {
    return [...this.bestSectorTimes];
  }

  /**
   * Get session best lap time.
   */
  getSessionBestLapTime(): number {
    return this.sessionBestLapTime;
  }

  /**
   * Reset session best times (called when track changes).
   */
  private resetSessionBests(): void {
    this.bestSectorTimes = [Infinity, Infinity, Infinity];
    this.sessionBestLapTime = Infinity;
  }

  /**
   * Set callback for when the track changes.
   */
  setTrackChangeCallback(callback: ((config: FullTrackConfig) => void) | null): void {
    this.onTrackChange = callback;
  }

  /**
   * Get the lap recorder instance.
   */
  getLapRecorder(): LapReplayRecorder {
    return this.lapRecorder;
  }

  /**
   * Check if AI mode is active.
   */
  isAIMode(): boolean {
    return this.car.state.controlMode === 'ai';
  }

  /**
   * Get current agent name (if any).
   */
  getAgentName(): string | undefined {
    return this.agent?.getName();
  }
}

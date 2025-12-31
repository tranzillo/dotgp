/**
 * Demonstration Recorder
 *
 * Records player inputs with corresponding observations during gameplay.
 * Captures frame-by-frame data for behavior cloning training.
 */

import type { Action, Observation } from './types';
import type {
  PlayerDemonstration,
  DemonstrationFrame,
} from './DemonstrationTypes';
import type { FullTrackConfig } from '../timetrials/types';
import { encodeCompositeSeed } from '../timetrials/types';

/**
 * State of the current recording session.
 */
interface RecordingState {
  trackConfig: FullTrackConfig;
  compositeSeed: number;
  frames: DemonstrationFrame[];
  startTime: number;
  lapStartStep: number;
  currentStep: number;
  isLapValid: boolean;
  sectorTimes: number[];
  lastSectorStep: number;
}

/**
 * Records player demonstrations for behavior cloning.
 *
 * Usage:
 * 1. Call startRecording() when entering demo mode
 * 2. Call recordFrame() each game update with observation + player input
 * 3. Call onSectorComplete() when player crosses a sector boundary
 * 4. Call onLapComplete() when player finishes a lap - returns demo if valid
 * 5. Call onOffTrack() when player goes off-track - marks lap as invalid
 */
export class DemonstrationRecorder {
  private state: RecordingState | null = null;
  private playerInitials: string = 'AAA';

  /**
   * Set the player initials for recorded demos.
   */
  setPlayerInitials(initials: string): void {
    this.playerInitials = initials.toUpperCase().substring(0, 3).padEnd(3, 'A');
  }

  /**
   * Start a new recording session.
   * Call this when entering demo recording mode.
   */
  startRecording(trackConfig: FullTrackConfig): void {
    this.state = {
      trackConfig,
      compositeSeed: encodeCompositeSeed(trackConfig),
      frames: [],
      startTime: Date.now(),
      lapStartStep: 0,
      currentStep: 0,
      isLapValid: true,
      sectorTimes: [],
      lastSectorStep: 0,
    };
  }

  /**
   * Record a single frame of the demonstration.
   * Call this every game update while recording.
   *
   * @param observation The 20-feature observation from ObservationBuilder
   * @param action The player's input as an action {x, y}
   */
  recordFrame(observation: Observation, action: Action): void {
    if (!this.state) return;

    // Store frame relative to lap start
    const lapStep = this.state.currentStep - this.state.lapStartStep;

    this.state.frames.push({
      step: lapStep,
      observation: [...observation.features],
      action: { x: action.x, y: action.y },
    });

    this.state.currentStep++;
  }

  /**
   * Called when player goes off-track.
   * Marks the current lap as invalid (demo won't be saved).
   */
  onOffTrack(): void {
    if (!this.state) return;
    this.state.isLapValid = false;
  }

  /**
   * Called when player crosses a sector boundary.
   * Records the sector time.
   *
   * @param sectorTime Time in seconds for the completed sector
   */
  onSectorComplete(sectorTime: number): void {
    if (!this.state) return;
    this.state.sectorTimes.push(sectorTime);
    this.state.lastSectorStep = this.state.currentStep;
  }

  /**
   * Called when player completes a lap.
   * Returns the demonstration if the lap was valid, otherwise null.
   *
   * @param lapTime Total lap time in seconds
   * @param sectorTimes Array of sector times [S1, S2, S3]
   * @returns PlayerDemonstration if lap was valid, null otherwise
   */
  onLapComplete(lapTime: number, sectorTimes: number[]): PlayerDemonstration | null {
    if (!this.state) return null;

    // Only save valid laps
    if (!this.state.isLapValid) {
      // Reset for next lap attempt
      this.resetLap();
      return null;
    }

    // Need at least some frames
    if (this.state.frames.length < 10) {
      this.resetLap();
      return null;
    }

    const demo: PlayerDemonstration = {
      id: crypto.randomUUID(),
      playerInitials: this.playerInitials,
      trackConfig: this.state.trackConfig,
      compositeSeed: this.state.compositeSeed,
      frames: [...this.state.frames],
      lapTime,
      sectorTimes: sectorTimes.length > 0 ? sectorTimes : [...this.state.sectorTimes],
      timestamp: Date.now(),
      isValid: true,
    };

    // Reset for next lap
    this.resetLap();

    return demo;
  }

  /**
   * Reset state for a new lap within the same recording session.
   */
  private resetLap(): void {
    if (!this.state) return;

    this.state.frames = [];
    this.state.lapStartStep = this.state.currentStep;
    this.state.isLapValid = true;
    this.state.sectorTimes = [];
    this.state.lastSectorStep = this.state.currentStep;
  }

  /**
   * Cancel the current recording session.
   * Discards all recorded data.
   */
  cancelRecording(): void {
    this.state = null;
  }

  /**
   * Stop recording and return to normal mode.
   * Alias for cancelRecording().
   */
  stopRecording(): void {
    this.cancelRecording();
  }

  /**
   * Check if currently recording.
   */
  isRecording(): boolean {
    return this.state !== null;
  }

  /**
   * Check if the current lap is still valid.
   */
  isCurrentLapValid(): boolean {
    return this.state?.isLapValid ?? false;
  }

  /**
   * Get the current frame count for this lap.
   */
  getCurrentFrameCount(): number {
    return this.state?.frames.length ?? 0;
  }

  /**
   * Get the total step count since recording started.
   */
  getTotalStepCount(): number {
    return this.state?.currentStep ?? 0;
  }

  /**
   * Get the track config being recorded.
   */
  getTrackConfig(): FullTrackConfig | null {
    return this.state?.trackConfig ?? null;
  }

  /**
   * Get recording start time.
   */
  getStartTime(): number {
    return this.state?.startTime ?? 0;
  }
}

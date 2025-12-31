import type { RecordedEpisode } from '../ai/EpisodeRecorder';
import type { Action } from '../ai/types';
import type { LapReplay, RngState } from './types';
import { restoreGlobalRng } from '../utils/SeededRandom';

/**
 * Controls playback of recorded episodes and lap replays.
 */
export class ReplayController {
  private recording: RecordedEpisode | null = null;
  private lapReplay: LapReplay | null = null;
  private currentFrame: number = 0;
  private isPlaying: boolean = false;
  private savedRngState: RngState | null = null;

  /**
   * Load an episode for playback (legacy training episodes).
   */
  loadEpisode(episode: RecordedEpisode): void {
    this.recording = episode;
    this.lapReplay = null;
    this.currentFrame = 0;
    this.isPlaying = false;
    this.savedRngState = null;
  }

  /**
   * Load a lap replay for playback.
   */
  loadLapReplay(replay: LapReplay): void {
    this.lapReplay = replay;
    this.recording = null;
    this.currentFrame = 0;
    this.isPlaying = false;
    this.savedRngState = replay.rngState ?? null;
  }

  /**
   * Start playback.
   * Restores global RNG state if available for deterministic replay.
   */
  play(): void {
    const frames = this.getFrames();
    if (frames && this.currentFrame < frames.length) {
      // Restore global RNG state for deterministic replay
      if (this.savedRngState?.globalRngState) {
        restoreGlobalRng(this.savedRngState.globalRngState);
      }
      this.isPlaying = true;
    }
  }

  /**
   * Get the agent RNG state for restoring agent determinism.
   * Returns undefined if no RNG state was saved or not an AI replay.
   */
  getAgentRngState(): number | undefined {
    return this.savedRngState?.agentRngState;
  }

  /**
   * Stop playback and reset to beginning.
   */
  stop(): void {
    this.isPlaying = false;
    this.currentFrame = 0;
  }

  /**
   * Restart playback from the beginning with RNG state restoration.
   */
  restart(): void {
    this.currentFrame = 0;
    // Restore RNG state when restarting for consistent replay
    if (this.savedRngState?.globalRngState) {
      restoreGlobalRng(this.savedRngState.globalRngState);
    }
    this.isPlaying = true;
  }

  /**
   * Pause playback without resetting position.
   */
  pause(): void {
    this.isPlaying = false;
  }

  /**
   * Get the current action to apply.
   */
  getCurrentAction(): Action | null {
    if (!this.isPlaying) return null;

    const frames = this.getFrames();
    if (!frames || this.currentFrame >= frames.length) return null;

    return frames[this.currentFrame].action;
  }

  /**
   * Advance to the next frame.
   */
  advance(): void {
    if (!this.isPlaying) return;

    const frames = this.getFrames();
    if (!frames) return;

    this.currentFrame++;
    if (this.currentFrame >= frames.length) {
      this.isPlaying = false;
    }
  }

  /**
   * Check if playback is done.
   */
  isDone(): boolean {
    const frames = this.getFrames();
    if (!frames) return true;
    return this.currentFrame >= frames.length;
  }

  /**
   * Check if currently playing.
   */
  isCurrentlyPlaying(): boolean {
    return this.isPlaying;
  }

  /**
   * Get current frame number.
   */
  getCurrentFrame(): number {
    return this.currentFrame;
  }

  /**
   * Get total frame count.
   */
  getTotalFrames(): number {
    return this.getFrames()?.length ?? 0;
  }

  /**
   * Get the loaded episode.
   */
  getEpisode(): RecordedEpisode | null {
    return this.recording;
  }

  /**
   * Get the loaded lap replay.
   */
  getLapReplay(): LapReplay | null {
    return this.lapReplay;
  }

  /**
   * Get playback progress (0-1).
   */
  getProgress(): number {
    const frames = this.getFrames();
    if (!frames || frames.length === 0) return 0;
    return this.currentFrame / frames.length;
  }

  /**
   * Clear the loaded episode/replay.
   */
  clear(): void {
    this.recording = null;
    this.lapReplay = null;
    this.currentFrame = 0;
    this.isPlaying = false;
    this.savedRngState = null;
  }

  /**
   * Check if anything is loaded.
   */
  hasContent(): boolean {
    return this.recording !== null || this.lapReplay !== null;
  }

  /**
   * Helper to get frames from either source.
   */
  private getFrames(): { action: Action }[] | null {
    if (this.lapReplay) {
      return this.lapReplay.frames;
    }
    if (this.recording) {
      return this.recording.frames;
    }
    return null;
  }
}

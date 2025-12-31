import type { Action, EpisodeStats } from './types';

/**
 * A single frame of recorded data.
 */
export interface RecordedFrame {
  step: number;
  action: Action;
}

/**
 * A complete recorded episode.
 */
export interface RecordedEpisode {
  episodeNumber: number;
  trackSeed: number;
  frames: RecordedFrame[];
  stats: EpisodeStats;
}

/**
 * Records action sequences during training for later replay.
 */
export class EpisodeRecorder {
  private currentFrames: RecordedFrame[] = [];
  private currentTrackSeed: number = 0;
  private isRecording: boolean = false;
  private savedEpisodes: RecordedEpisode[] = [];
  private maxStoredEpisodes: number;

  constructor(maxStoredEpisodes: number = 20) {
    this.maxStoredEpisodes = maxStoredEpisodes;
  }

  /**
   * Start recording a new episode.
   */
  startRecording(trackSeed: number): void {
    this.currentFrames = [];
    this.currentTrackSeed = trackSeed;
    this.isRecording = true;
  }

  /**
   * Record a single frame.
   */
  recordFrame(step: number, action: Action): void {
    if (!this.isRecording) return;

    this.currentFrames.push({
      step,
      action: { x: action.x, y: action.y },
    });
  }

  /**
   * Finish recording and save the episode.
   */
  finishRecording(episodeNumber: number, stats: EpisodeStats): RecordedEpisode {
    this.isRecording = false;

    const episode: RecordedEpisode = {
      episodeNumber,
      trackSeed: this.currentTrackSeed,
      frames: this.currentFrames,
      stats: { ...stats },
    };

    // Add to saved episodes
    this.savedEpisodes.unshift(episode);

    // Trim to max size, but prioritize lap-completing episodes
    if (this.savedEpisodes.length > this.maxStoredEpisodes) {
      // Find the oldest non-lap-completing episode to remove
      let removeIndex = this.savedEpisodes.length - 1;
      for (let i = this.savedEpisodes.length - 1; i >= this.maxStoredEpisodes / 2; i--) {
        if (!this.savedEpisodes[i].stats.lapCompleted) {
          removeIndex = i;
          break;
        }
      }
      this.savedEpisodes.splice(removeIndex, 1);
    }

    this.currentFrames = [];
    return episode;
  }

  /**
   * Cancel current recording without saving.
   */
  cancelRecording(): void {
    this.isRecording = false;
    this.currentFrames = [];
  }

  /**
   * Check if currently recording.
   */
  isCurrentlyRecording(): boolean {
    return this.isRecording;
  }

  /**
   * Get a saved episode by episode number.
   */
  getEpisode(episodeNumber: number): RecordedEpisode | null {
    return this.savedEpisodes.find(e => e.episodeNumber === episodeNumber) ?? null;
  }

  /**
   * Get all saved episodes.
   */
  getAllEpisodes(): RecordedEpisode[] {
    return this.savedEpisodes;
  }

  /**
   * Get the most recent episode.
   */
  getLatestEpisode(): RecordedEpisode | null {
    return this.savedEpisodes[0] ?? null;
  }

  /**
   * Clear all saved episodes.
   */
  clear(): void {
    this.savedEpisodes = [];
    this.currentFrames = [];
    this.isRecording = false;
  }

  /**
   * Get the number of saved episodes.
   */
  getCount(): number {
    return this.savedEpisodes.length;
  }
}

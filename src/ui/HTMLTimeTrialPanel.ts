/**
 * HTMLTimeTrialPanel - UI panel for time trial system.
 *
 * Provides:
 * - User initials input
 * - Leaderboard display for current track
 * - Popular tracks list
 */

import type {
  TimeTrialRecord,
  TrackLeaderboard,
  LeaderboardFilter,
} from '../timetrials/types';
import { encodeCompositeSeed } from '../timetrials/types';
import { isSupabaseConfigured } from '../sync';
import type { LeaderboardEntry, PopularTrack } from '../sync';

export type LeaderboardSource = 'local' | 'global';

export const TIMETRIAL_PANEL_WIDTH = 260;

export interface TimeTrialPanelCallbacks {
  onInitialsChange: (initials: string) => void;
  onPopularTrackClick: (compositeSeed: number) => void;
  onFilterChange?: (filter: LeaderboardFilter) => void;
  onSourceChange?: (source: LeaderboardSource) => void;
}

export class HTMLTimeTrialPanel {
  private container: HTMLElement;
  private callbacks: TimeTrialPanelCallbacks;

  // DOM elements
  private initialsInput!: HTMLInputElement;
  private leaderboardList!: HTMLDivElement;
  private popularTracksList!: HTMLDivElement;
  private noRecordsLabel!: HTMLDivElement;
  private filterButtons!: HTMLDivElement;
  private sourceButtons!: HTMLDivElement;
  private playerRankDiv!: HTMLDivElement;

  // State
  private currentSource: LeaderboardSource = 'global';
  private cloudAvailable: boolean = false;

  constructor(containerId: string, callbacks: TimeTrialPanelCallbacks) {
    const container = document.getElementById(containerId);
    if (!container) {
      throw new Error(`Container element #${containerId} not found`);
    }
    this.container = container;
    this.callbacks = callbacks;

    // Check if cloud is available and set default source accordingly
    this.cloudAvailable = isSupabaseConfigured();
    this.currentSource = this.cloudAvailable ? 'global' : 'local';

    // Build DOM structure
    this.container.innerHTML = `
      <div class="panel-header">TIME TRIALS</div>
      <div class="panel-content">
        <!-- Initials Input -->
        <div class="section">
          <div class="input-row">
            <label for="tt-initials">Initials:</label>
            <input type="text" id="tt-initials" placeholder="AAA" maxlength="3">
          </div>
        </div>

        <!-- Leaderboard -->
        <div class="section-header">LEADERBOARD</div>
        <!-- Local/Global Source Toggle -->
        <div class="source-buttons" id="tt-source">
          <button class="source-btn${this.cloudAvailable ? '' : ' active'}" data-source="local">Local</button>
          <button class="source-btn${this.cloudAvailable ? ' active' : ' disabled'}" data-source="global" ${this.cloudAvailable ? '' : 'disabled'}>Global</button>
        </div>
        <div class="filter-buttons" id="tt-filter">
          <button class="filter-btn active" data-filter="all">All</button>
          <button class="filter-btn" data-filter="human">Human</button>
          <button class="filter-btn" data-filter="ai">AI</button>
        </div>
        <!-- Player rank display (for global) -->
        <div id="tt-player-rank" class="player-rank" style="display: ${this.cloudAvailable ? 'block' : 'none'};"></div>
        <div id="tt-leaderboard" class="leaderboard"></div>
        <div id="tt-no-records" class="no-records">No records yet</div>

        <!-- Popular Tracks -->
        <div class="section-header">POPULAR TRACKS</div>
        <div id="tt-popular" class="track-list"></div>
      </div>
    `;

    // Get element references
    this.initialsInput = document.getElementById('tt-initials') as HTMLInputElement;
    this.leaderboardList = document.getElementById('tt-leaderboard') as HTMLDivElement;
    this.popularTracksList = document.getElementById('tt-popular') as HTMLDivElement;
    this.noRecordsLabel = document.getElementById('tt-no-records') as HTMLDivElement;
    this.filterButtons = document.getElementById('tt-filter') as HTMLDivElement;
    this.sourceButtons = document.getElementById('tt-source') as HTMLDivElement;
    this.playerRankDiv = document.getElementById('tt-player-rank') as HTMLDivElement;

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    // Initials input - save on change
    this.initialsInput.addEventListener('input', () => {
      const value = this.initialsInput.value.toUpperCase();
      this.initialsInput.value = value;
      if (value.length >= 1) {
        this.callbacks.onInitialsChange(value);
      }
    });

    // Prevent game controls while typing
    this.initialsInput.addEventListener('keydown', (e) => e.stopPropagation());

    // Filter buttons
    this.filterButtons.querySelectorAll('.filter-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const filter = btn.getAttribute('data-filter') as LeaderboardFilter;
        this.setFilter(filter);
      });
    });

    // Source buttons (Local/Global)
    this.sourceButtons.querySelectorAll('.source-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.hasAttribute('disabled')) return;
        const source = btn.getAttribute('data-source') as LeaderboardSource;
        this.setSource(source);
      });
    });
  }

  /**
   * Set the current filter and update UI.
   */
  setFilter(filter: LeaderboardFilter): void {
    // Update button states
    this.filterButtons.querySelectorAll('.filter-btn').forEach((btn) => {
      const btnFilter = btn.getAttribute('data-filter');
      btn.classList.toggle('active', btnFilter === filter);
    });

    // Notify callback
    this.callbacks.onFilterChange?.(filter);
  }

  /**
   * Set the leaderboard source (local/global) and update UI.
   */
  setSource(source: LeaderboardSource): void {
    this.currentSource = source;

    // Update button states
    this.sourceButtons.querySelectorAll('.source-btn').forEach((btn) => {
      const btnSource = btn.getAttribute('data-source');
      btn.classList.toggle('active', btnSource === source);
    });

    // Show/hide player rank for global view
    this.playerRankDiv.style.display = source === 'global' ? 'block' : 'none';

    // Notify callback
    this.callbacks.onSourceChange?.(source);
  }

  /**
   * Get the current leaderboard source.
   */
  getSource(): LeaderboardSource {
    return this.currentSource;
  }

  /**
   * Set the user initials in the input.
   */
  setInitials(initials: string): void {
    this.initialsInput.value = initials;
  }

  /**
   * Update the leaderboard display (local records).
   */
  setLeaderboard(leaderboard: TrackLeaderboard | null): void {
    if (!leaderboard || leaderboard.records.length === 0) {
      this.leaderboardList.innerHTML = '';
      this.noRecordsLabel.style.display = 'block';
      this.noRecordsLabel.textContent = 'No records yet';
      return;
    }

    this.noRecordsLabel.style.display = 'none';

    // Show top 10 records
    const records = leaderboard.records.slice(0, 10);
    this.leaderboardList.innerHTML = records
      .map((record, index) => this.renderLeaderboardRow(record, index + 1))
      .join('');
  }

  private renderLeaderboardRow(record: TimeTrialRecord, position: number): string {
    const timeStr = this.formatTime(record.lapTime);
    const posClass = position <= 3 ? `pos-${position}` : '';
    const isAI = record.isAI ?? false;
    const aiClass = isAI ? 'ai-record' : '';
    const aiIndicator = isAI ? '<span class="ai-badge" title="AI Agent">AI</span>' : '';

    return `
      <div class="leaderboard-row ${posClass} ${aiClass}" data-id="${record.id}">
        <span class="position">${position}.</span>
        <span class="initials">${record.initials}${aiIndicator}</span>
        <span class="time">${timeStr}</span>
      </div>
    `;
  }

  /**
   * Highlight a newly recorded time.
   */
  highlightNewRecord(record: TimeTrialRecord): void {
    setTimeout(() => {
      const row = this.leaderboardList.querySelector(`[data-id="${record.id}"]`);
      if (row) {
        row.classList.add('new-record');
        setTimeout(() => row.classList.remove('new-record'), 2000);
      }
    }, 50);
  }

  /**
   * Update the leaderboard display with global entries.
   */
  setGlobalLeaderboard(entries: LeaderboardEntry[]): void {
    if (entries.length === 0) {
      this.leaderboardList.innerHTML = '';
      this.noRecordsLabel.style.display = 'block';
      this.noRecordsLabel.textContent = 'No global records yet';
      return;
    }

    this.noRecordsLabel.style.display = 'none';

    // Show top 10 entries
    const topEntries = entries.slice(0, 10);
    this.leaderboardList.innerHTML = topEntries
      .map((entry) => this.renderGlobalLeaderboardRow(entry))
      .join('');
  }

  private renderGlobalLeaderboardRow(entry: LeaderboardEntry): string {
    const timeStr = this.formatTime(entry.lapTime);
    const posClass = entry.rank <= 3 ? `pos-${entry.rank}` : '';
    const isAI = entry.isAI ?? false;
    const aiClass = isAI ? 'ai-record' : '';
    const aiIndicator = isAI ? '<span class="ai-badge" title="AI Agent">AI</span>' : '';
    const currentDeviceClass = entry.isCurrentDevice ? 'current-device' : '';

    return `
      <div class="leaderboard-row ${posClass} ${aiClass} ${currentDeviceClass}" data-id="${entry.replayId}">
        <span class="position">${entry.rank}.</span>
        <span class="initials">${entry.playerInitials}${aiIndicator}</span>
        <span class="time">${timeStr}</span>
      </div>
    `;
  }

  /**
   * Set the player's global rank display.
   */
  setPlayerRank(rank: { rank: number; total: number; bestTime: number } | null): void {
    if (!rank) {
      this.playerRankDiv.innerHTML = '<span class="rank-label">Your rank: --</span>';
      return;
    }

    const timeStr = this.formatTime(rank.bestTime);
    this.playerRankDiv.innerHTML = `
      <span class="rank-label">Your rank:</span>
      <span class="rank-value">#${rank.rank}</span>
      <span class="rank-total">of ${rank.total}</span>
      <span class="rank-time">(${timeStr})</span>
    `;
  }

  /**
   * Show loading state for global leaderboard.
   */
  setGlobalLeaderboardLoading(loading: boolean): void {
    if (loading) {
      this.leaderboardList.innerHTML = '<div class="loading">Loading...</div>';
      this.noRecordsLabel.style.display = 'none';
    }
  }

  /**
   * Update the popular tracks list.
   */
  setPopularTracks(tracks: TrackLeaderboard[]): void {
    if (tracks.length === 0) {
      this.popularTracksList.innerHTML = '<div class="no-tracks">No tracks yet</div>';
      return;
    }

    this.popularTracksList.innerHTML = tracks
      .map((track) => this.renderPopularTrack(track))
      .join('');

    // Add click handlers
    this.popularTracksList.querySelectorAll('.popular-track').forEach((el) => {
      el.addEventListener('click', () => {
        const compositeSeed = parseInt(el.getAttribute('data-composite') || '0', 10);
        this.callbacks.onPopularTrackClick(compositeSeed);
      });
    });
  }

  private renderPopularTrack(track: TrackLeaderboard): string {
    const bestTime = track.records[0]?.lapTime;
    const timeStr = bestTime ? this.formatTime(bestTime) : '--:--';
    const typeLabel = track.trackType.toUpperCase();

    // Create composite seed using the actual stored track configuration
    const compositeSeed = encodeCompositeSeed({
      baseSeed: track.seed,
      trackType: track.trackType,
      sizeClass: track.sizeClass,
      surfaceType: track.surfaceType,
      ovalShape: track.ovalShape,
    });

    return `
      <div class="popular-track" data-composite="${compositeSeed}">
        <span class="seed">${compositeSeed}</span>
        <span class="type">${typeLabel}</span>
        <span class="best">${timeStr}</span>
        <span class="laps">${track.lapCount}</span>
      </div>
    `;
  }

  /**
   * Update the popular tracks list with global tracks.
   */
  setGlobalPopularTracks(tracks: PopularTrack[]): void {
    if (tracks.length === 0) {
      this.popularTracksList.innerHTML = '<div class="no-tracks">No global tracks yet</div>';
      return;
    }

    this.popularTracksList.innerHTML = tracks
      .map((track) => this.renderGlobalPopularTrack(track))
      .join('');

    // Add click handlers
    this.popularTracksList.querySelectorAll('.popular-track').forEach((el) => {
      el.addEventListener('click', () => {
        const compositeSeed = parseInt(el.getAttribute('data-composite') || '0', 10);
        this.callbacks.onPopularTrackClick(compositeSeed);
      });
    });
  }

  private renderGlobalPopularTrack(track: PopularTrack): string {
    const timeStr = track.bestLapTime ? this.formatTime(track.bestLapTime) : '--:--';
    const typeLabel = track.trackConfig.trackType.toUpperCase();

    return `
      <div class="popular-track" data-composite="${track.compositeSeed}">
        <span class="seed">${track.compositeSeed}</span>
        <span class="type">${typeLabel}</span>
        <span class="best">${timeStr}</span>
        <span class="laps">${track.lapCount}</span>
      </div>
    `;
  }

  /**
   * Show loading state for popular tracks.
   */
  setPopularTracksLoading(loading: boolean): void {
    if (loading) {
      this.popularTracksList.innerHTML = '<div class="loading">Loading...</div>';
    }
  }

  private formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins > 0) {
      return `${mins}:${secs.toFixed(2).padStart(5, '0')}`;
    }
    return secs.toFixed(2);
  }

  getWidth(): number {
    return TIMETRIAL_PANEL_WIDTH;
  }
}

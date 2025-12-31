/**
 * HTMLTrainingPanel - Consolidated panel for replays, agents, rewards, and training.
 *
 * Combines all training-related functionality into a single coherent panel:
 * - Lap replays with play/select for training
 * - Agent management (create/select/delete)
 * - Reward weight configuration (collapsible)
 * - Training controls with progress
 * - Agent activation
 */

import { lapReplayStorage } from '../replay/LapReplayStorage';
import { agentStorage } from '../ai/AgentStorage';
import type { LapReplaySummary } from '../replay/types';
import type { AgentProfileSummary, RewardWeights } from '../ai/AgentProfile';
import { DEFAULT_REWARD_WEIGHTS } from '../ai/AgentProfile';
import { REWARD_PRESETS } from '../ai/ConfigurableRewardCalculator';
import type { FullTrackConfig } from '../timetrials/types';
import { encodeCompositeSeed } from '../timetrials/types';
import { LapEvaluator } from '../ai/LapEvaluator';

export const TRAINING_PANEL_WIDTH = 300;

// Slider configuration for reward weights
interface SliderConfig {
  key: keyof RewardWeights;
  label: string;
  min: number;
  max: number;
  step: number;
}

const SLIDER_CONFIGS: SliderConfig[] = [
  { key: 'progress', label: 'Progress', min: 0, max: 2, step: 0.1 },
  { key: 'speed', label: 'Speed', min: 0, max: 1, step: 0.1 },
  { key: 'heading', label: 'Heading', min: 0, max: 1, step: 0.1 },
  { key: 'centerline', label: 'Centerline', min: 0, max: 1, step: 0.1 },
  { key: 'offTrackPenalty', label: 'Off-Track', min: 0, max: 1, step: 0.1 },
  { key: 'lapBonus', label: 'Lap Bonus', min: 0, max: 2, step: 0.1 },
  { key: 'validLapBonus', label: 'Valid Lap', min: 0, max: 1, step: 0.1 },
  { key: 'cuttingPenalty', label: 'Cutting', min: 0, max: 2, step: 0.1 },
  { key: 'timePenalty', label: 'Time', min: 0, max: 0.5, step: 0.01 },
  { key: 'gripConservation', label: 'Grip', min: 0, max: 0.5, step: 0.05 },
];

export type TrainingMode = 'bc' | 'rl';

export interface TrainingPanelCallbacks {
  onPlayReplay: (replayId: string) => void;
  onStopReplay: () => void;
  onStartTraining: (
    agentId: string | null,
    agentName: string | null,
    lapIds: string[],
    rewardWeights: RewardWeights,
    episodes: number,
    mode: TrainingMode
  ) => void;
  onActivateAgent: (agentId: string) => void;
  onDeleteAgent: (agentId: string) => void;
  onDeleteLaps: (lapIds: string[]) => void;
}

type PanelState = 'idle' | 'playing' | 'training' | 'sil';

export class HTMLTrainingPanel {
  private container: HTMLElement;
  private callbacks: TrainingPanelCallbacks;

  // State
  private state: PanelState = 'idle';
  private currentTrackConfig: FullTrackConfig | null = null;
  private currentlyPlayingId: string | null = null;
  private rewardWeights: RewardWeights = { ...DEFAULT_REWARD_WEIGHTS };
  private rewardsExpanded: boolean = true;
  private trainingMode: TrainingMode = 'bc';
  private trainingEpisodes: number = 100;
  private selectedAgentId: string | null = null;
  private agents: AgentProfileSummary[] = [];
  private replays: LapReplaySummary[] = [];

  // Personal best tracking (key: "human:INITIALS" or "ai:AGENTNAME" -> lap ID)
  private personalBestIds: Map<string, string> = new Map();
  private currentPlayerInitials: string = 'AAA';

  // Computed quality scores (percentile-based, updated when laps change)
  private computedQualityScores: Map<string, number> = new Map();

  // SIL state (session vs all-time stats)
  private silSessionLaps: number = 0;
  private silSessionGoodLaps: number = 0;
  private silSessionBestTime: number | null = null;
  private silSelectedCount: number = 0;
  private silAllTimeBestTime: number | null = null;

  constructor(containerId: string, callbacks: TrainingPanelCallbacks) {
    const container = document.getElementById(containerId);
    if (!container) {
      throw new Error(`Container element #${containerId} not found`);
    }
    this.container = container;
    this.callbacks = callbacks;

    this.render();
  }

  private render(): void {
    const selectedCount = this.replays.filter((r) => r.isTrainingData).length;
    const canTrain = selectedCount > 0 && this.state === 'idle';

    this.container.innerHTML = `
      <div class="panel-header">TRAINING</div>
      <div class="panel-content">
        <!-- Playing Indicator -->
        <div id="tp-playing" class="playing-indicator" style="display: ${this.state === 'playing' ? 'flex' : 'none'};">
          <span>Playing replay...</span>
          <button id="tp-stop" class="stop-btn">Stop</button>
        </div>

        <!-- Laps Section -->
        <div class="section">
          <div class="section-header laps-header">
            <span>LAPS <span class="count-badge">(${this.replays.length})</span></span>
            <button id="tp-delete-laps" class="icon-btn danger small" title="Delete selected laps" ${selectedCount === 0 ? 'disabled' : ''}>🗑</button>
          </div>
          <div id="tp-lap-list" class="replay-list">
            ${this.renderLapList()}
          </div>
        </div>

        <!-- Agent Section -->
        <div class="section">
          <div class="section-header">AGENT</div>
          <div class="agent-select-row">
            <select id="tp-agent-select" class="agent-select">
              <option value="">+ New Agent</option>
              ${this.agents.map((a) => `<option value="${a.id}" ${a.id === this.selectedAgentId ? 'selected' : ''}>${this.escapeHtml(a.name)}</option>`).join('')}
            </select>
            ${this.selectedAgentId ? `<button id="tp-delete-agent" class="icon-btn danger" title="Delete agent">×</button>` : ''}
          </div>
          ${!this.selectedAgentId ? `
          <div class="new-agent-row">
            <input type="text" id="tp-agent-name" placeholder="Agent name..." maxlength="20" class="agent-name-input">
          </div>
          ` : ''}
          ${this.selectedAgentId ? this.renderAgentInfo() : ''}
        </div>

        <!-- Training Section -->
        <div class="section">
          <div class="section-header">
            TRAINING <span class="count-badge">(${selectedCount} laps selected)</span>
          </div>

          <!-- Training Mode Toggle -->
          <div class="mode-toggle">
            <button id="tp-mode-bc" class="mode-btn ${this.trainingMode === 'bc' ? 'active' : ''}">
              Imitation (Fast)
            </button>
            <button id="tp-mode-rl" class="mode-btn ${this.trainingMode === 'rl' ? 'active' : ''}">
              RL + Rewards
            </button>
          </div>

          <!-- Episodes Slider (both modes) -->
          <div class="episodes-slider-row">
            <label>Episodes: <span id="tp-episodes-value">${this.trainingEpisodes}</span></label>
            <input type="range" id="tp-episodes" value="${this.trainingEpisodes}" min="10" max="1000" step="10" class="episodes-slider">
          </div>
          ${this.trainingMode === 'bc' ? `
          <div class="mode-hint">Learns directly from your laps - no reward tuning needed</div>
          ` : ''}

          ${this.trainingMode === 'rl' ? `
          <!-- Rewards Section (only for RL mode) -->
          <div class="rewards-section">
            <div class="section-header clickable" id="tp-rewards-toggle">
              REWARDS <span class="chevron">${this.rewardsExpanded ? '▲' : '▼'}</span>
            </div>
            <div id="tp-rewards-content" class="rewards-content" style="display: ${this.rewardsExpanded ? 'block' : 'none'};">
              <div class="preset-row">
                <select id="tp-preset" class="preset-select">
                  <option value="">Custom</option>
                  <option value="balanced">Balanced</option>
                  <option value="speed">Speed</option>
                  <option value="safe">Safe</option>
                  <option value="aggressive">Aggressive</option>
                </select>
                <button id="tp-reset-rewards" class="small-btn">Reset</button>
              </div>
              <div class="sliders-container">
                ${SLIDER_CONFIGS.map((c) => this.renderSlider(c)).join('')}
              </div>
            </div>
          </div>
          ` : ''}

          <button id="tp-train" class="action-btn primary" ${!canTrain ? 'disabled' : ''}>
            ${this.state === 'training' ? 'Training...' : (this.trainingMode === 'bc' ? 'Train (Imitation)' : 'Train (RL)')}
          </button>
          <div id="tp-progress" class="train-progress" style="display: ${this.state === 'training' ? 'block' : 'none'};">
            <div class="progress-bar">
              <div class="progress-fill" id="tp-progress-fill"></div>
            </div>
            <span id="tp-progress-text">Episode 0/${this.trainingEpisodes}</span>
          </div>
        </div>

        <!-- Activate Section -->
        ${this.selectedAgentId ? `
        <div class="section">
          <button id="tp-activate" class="action-btn secondary" ${this.state === 'sil' ? 'disabled' : ''}>
            Activate Agent
          </button>
        </div>
        ` : ''}

        <!-- SIL Section (only show when agent is selected and has training) -->
        ${this.selectedAgentId && this.agents.find(a => a.id === this.selectedAgentId)?.totalEpochs ? `
        <div class="section sil-section">
          <div class="section-header">SELF-IMPROVEMENT</div>
          ${this.state === 'sil' ? `
          <div class="sil-status">
            <div class="sil-running">
              <span class="sil-indicator">●</span> Learning
            </div>
            <div class="sil-stats-grid">
              <div class="sil-stat-group">
                <div class="sil-stat-label">SESSION</div>
                <div class="sil-stat-row">
                  Laps: <span id="tp-sil-session-laps">${this.silSessionLaps}</span>
                </div>
                <div class="sil-stat-row">
                  Good laps: <span id="tp-sil-session-good">${this.silSessionGoodLaps}</span>
                </div>
                <div class="sil-stat-row">
                  Best: <span id="tp-sil-session-best">${this.silSessionBestTime ? this.formatTime(this.silSessionBestTime) : '--:--'}</span>
                </div>
              </div>
              <div class="sil-stat-group">
                <div class="sil-stat-label">ALL TIME</div>
                <div class="sil-stat-row">
                  Good laps: <span id="tp-sil-selected">${this.silSelectedCount}</span>
                </div>
                <div class="sil-stat-row">
                  Best: <span id="tp-sil-alltime-best">${this.silAllTimeBestTime ? this.formatTime(this.silAllTimeBestTime) : '--:--'}</span>
                </div>
              </div>
            </div>
          </div>
          ` : `
          <div class="sil-info">
            <p>Self-learning starts automatically when agent is activated (Tab key or Activate button).</p>
          </div>
          `}
        </div>
        ` : ''}

        <!-- Stats -->
        <div class="section stats-section">
          <span class="stats-label">Total: ${this.replays.length} laps on this track</span>
        </div>
      </div>
    `;

    this.attachEventHandlers();
  }

  private renderLapList(): string {
    if (this.replays.length === 0) {
      return '<div class="no-replays">No laps recorded yet. Drive a lap!</div>';
    }

    return this.replays
      .map((replay, index) => {
        const timeStr = this.formatTime(replay.lapTime);
        const isPlaying = replay.id === this.currentlyPlayingId;
        const playingClass = isPlaying ? 'playing' : '';

        // For AI laps, show agent name; for player laps, show initials
        let driverDisplay: string;
        if (replay.isAI) {
          const agentName = replay.agentName || 'AI';
          // Truncate long agent names
          const shortName = agentName.length > 12 ? agentName.slice(0, 10) + '..' : agentName;
          driverDisplay = `<span class="ai-driver" title="${agentName}">${shortName}</span>`;
        } else {
          driverDisplay = replay.playerInitials;
        }

        // Star rating display (0-5 stars) or PB badge
        const starRatingBadge = this.renderStarRatingOrPB(replay);

        // Incident indicators
        const incidentBadges = this.renderIncidentBadges(replay);

        return `
        <div class="replay-row ${playingClass}" data-id="${replay.id}">
          <span class="replay-pos">${index + 1}.</span>
          <span class="replay-time">${timeStr}</span>
          <span class="replay-driver">${driverDisplay}</span>
          ${starRatingBadge}
          ${incidentBadges}
          <button class="replay-play" data-id="${replay.id}" title="Watch">▶</button>
          <label class="replay-train-label" title="Use for training">
            <input type="checkbox" class="replay-train" data-id="${replay.id}"
                   ${replay.isTrainingData ? 'checked' : ''}>
          </label>
        </div>
      `;
      })
      .join('');
  }

  /**
   * Render quality score OR PB badge for a lap.
   * Shows "PB" badge if this is the driver's personal best, otherwise shows quality score.
   */
  private renderStarRatingOrPB(replay: LapReplaySummary): string {
    // Build the key to check personal best
    const key = replay.isAI
      ? `ai:${replay.agentName}`
      : `human:${replay.playerInitials}`;

    // Check if this lap is the personal best for its driver
    if (this.personalBestIds.get(key) === replay.id) {
      return '<span class="pb-badge" title="Personal Best">PB</span>';
    }

    // Fall back to quality score display
    return this.renderQualityScore(replay.id);
  }

  /**
   * Render quality score badge (0-100).
   * Uses percentile-based scoring computed when data is refreshed.
   */
  private renderQualityScore(lapId: string): string {
    const score = this.computedQualityScores.get(lapId);
    if (score === undefined) {
      return '<span class="quality-score">--</span>';
    }

    // Color based on score tier
    let scoreClass = 'quality-poor';
    if (score >= 85) {
      scoreClass = 'quality-excellent';
    } else if (score >= 70) {
      scoreClass = 'quality-great';
    } else if (score >= 50) {
      scoreClass = 'quality-good';
    } else if (score >= 30) {
      scoreClass = 'quality-fair';
    }

    return `<span class="quality-score ${scoreClass}" title="Quality: ${score}/100">${score}</span>`;
  }

  /**
   * Render incident badges (off-track, collision indicators).
   */
  private renderIncidentBadges(replay: LapReplaySummary): string {
    if (!replay.incidents || replay.incidents.length === 0) {
      return '<span class="incident-badges clean" title="Clean lap">✓</span>';
    }

    const offTrackCount = replay.incidents.filter(i => i.type === 'off_track').length;
    const collisionCount = replay.incidents.filter(i => i.type === 'wall_collision').length;

    const badges: string[] = [];

    if (offTrackCount > 0) {
      badges.push(`<span class="incident-badge off-track" title="${offTrackCount} off-track">⚠${offTrackCount > 1 ? offTrackCount : ''}</span>`);
    }

    if (collisionCount > 0) {
      badges.push(`<span class="incident-badge collision" title="${collisionCount} collision${collisionCount > 1 ? 's' : ''}">💥${collisionCount > 1 ? collisionCount : ''}</span>`);
    }

    return `<span class="incident-badges">${badges.join('')}</span>`;
  }

  private renderAgentInfo(): string {
    const agent = this.agents.find((a) => a.id === this.selectedAgentId);
    if (!agent) return '';

    const lapTimeStr = agent.bestLapTime ? this.formatTime(agent.bestLapTime) : 'N/A';
    const epochsStr = agent.totalEpochs > 0 ? `${agent.totalEpochs} epochs` : 'Untrained';

    return `
      <div class="agent-info">
        <span class="agent-stat">${epochsStr}</span>
        <span class="agent-stat">Best: ${lapTimeStr}</span>
      </div>
    `;
  }

  private renderSlider(config: SliderConfig): string {
    const value = this.rewardWeights[config.key];
    return `
      <div class="slider-row">
        <label class="slider-label">${config.label}</label>
        <input type="range" class="slider-input" data-key="${config.key}"
               min="${config.min}" max="${config.max}" step="${config.step}" value="${value}">
        <span class="slider-value" data-key="${config.key}">${value.toFixed(2)}</span>
      </div>
    `;
  }

  private attachEventHandlers(): void {
    // Stop replay button
    const stopBtn = document.getElementById('tp-stop');
    stopBtn?.addEventListener('click', () => this.callbacks.onStopReplay());

    // Play buttons
    this.container.querySelectorAll('.replay-play').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = (btn as HTMLElement).dataset.id;
        if (id) this.callbacks.onPlayReplay(id);
      });
    });

    // Training checkboxes
    this.container.querySelectorAll('.replay-train').forEach((checkbox) => {
      checkbox.addEventListener('change', async (e) => {
        const id = (checkbox as HTMLElement).dataset.id;
        const isChecked = (e.target as HTMLInputElement).checked;
        if (id) {
          await lapReplayStorage.setTrainingData(id, isChecked);
          await this.refreshData();
        }
      });
    });

    // Delete selected laps
    const deleteLapsBtn = document.getElementById('tp-delete-laps');
    deleteLapsBtn?.addEventListener('click', () => {
      const selectedLaps = this.replays.filter((r) => r.isTrainingData);
      if (selectedLaps.length === 0) return;

      const confirmMsg = selectedLaps.length === 1
        ? 'Delete this lap?'
        : `Delete ${selectedLaps.length} selected laps?`;

      if (confirm(confirmMsg)) {
        this.callbacks.onDeleteLaps(selectedLaps.map((r) => r.id));
      }
    });

    // Agent select
    const agentSelect = document.getElementById('tp-agent-select') as HTMLSelectElement;
    agentSelect?.addEventListener('change', () => {
      this.selectedAgentId = agentSelect.value || null;
      this.render();
    });

    // Delete agent
    const deleteBtn = document.getElementById('tp-delete-agent');
    deleteBtn?.addEventListener('click', () => {
      if (this.selectedAgentId && confirm('Delete this agent?')) {
        this.callbacks.onDeleteAgent(this.selectedAgentId);
      }
    });

    // Training mode toggle
    const modeBcBtn = document.getElementById('tp-mode-bc');
    const modeRlBtn = document.getElementById('tp-mode-rl');
    modeBcBtn?.addEventListener('click', () => {
      this.trainingMode = 'bc';
      this.render();
    });
    modeRlBtn?.addEventListener('click', () => {
      this.trainingMode = 'rl';
      this.render();
    });

    // Episodes slider
    const episodesSlider = document.getElementById('tp-episodes') as HTMLInputElement;
    const episodesValue = document.getElementById('tp-episodes-value');
    episodesSlider?.addEventListener('input', () => {
      this.trainingEpisodes = parseInt(episodesSlider.value);
      if (episodesValue) {
        episodesValue.textContent = this.trainingEpisodes.toString();
      }
    });

    // Rewards toggle
    const rewardsToggle = document.getElementById('tp-rewards-toggle');
    rewardsToggle?.addEventListener('click', () => {
      this.rewardsExpanded = !this.rewardsExpanded;
      this.render();
    });

    // Preset select
    const presetSelect = document.getElementById('tp-preset') as HTMLSelectElement;
    presetSelect?.addEventListener('change', () => {
      const preset = presetSelect.value;
      if (preset && REWARD_PRESETS[preset]) {
        this.rewardWeights = { ...DEFAULT_REWARD_WEIGHTS, ...REWARD_PRESETS[preset] };
        this.render();
      }
    });

    // Reset rewards
    const resetBtn = document.getElementById('tp-reset-rewards');
    resetBtn?.addEventListener('click', () => {
      this.rewardWeights = { ...DEFAULT_REWARD_WEIGHTS };
      this.render();
    });

    // Sliders
    this.container.querySelectorAll('.slider-input').forEach((input) => {
      input.addEventListener('input', (e) => {
        const key = (input as HTMLElement).dataset.key as keyof RewardWeights;
        const value = parseFloat((e.target as HTMLInputElement).value);
        this.rewardWeights[key] = value;

        // Update value display
        const valueSpan = this.container.querySelector(`.slider-value[data-key="${key}"]`);
        if (valueSpan) valueSpan.textContent = value.toFixed(2);

        // Clear preset
        const presetSel = document.getElementById('tp-preset') as HTMLSelectElement;
        if (presetSel) presetSel.value = '';
      });
    });

    // Train button
    const trainBtn = document.getElementById('tp-train');
    trainBtn?.addEventListener('click', () => {
      if (this.state !== 'idle') return;

      const selectedLaps = this.replays.filter((r) => r.isTrainingData).map((r) => r.id);
      if (selectedLaps.length === 0) return;

      const episodes = this.trainingEpisodes;

      // Get agent name for new agents
      const agentNameInput = document.getElementById('tp-agent-name') as HTMLInputElement;
      const agentName = agentNameInput?.value.trim() || null;

      // If no agent selected and no name provided, generate one
      const finalName = this.selectedAgentId ? null : (agentName || `Agent ${Date.now() % 10000}`);

      this.callbacks.onStartTraining(
        this.selectedAgentId,
        finalName,
        selectedLaps,
        this.rewardWeights,
        episodes,
        this.trainingMode
      );
    });

    // Activate button
    const activateBtn = document.getElementById('tp-activate');
    activateBtn?.addEventListener('click', () => {
      if (this.selectedAgentId) {
        this.callbacks.onActivateAgent(this.selectedAgentId);
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────

  async setCurrentTrack(config: FullTrackConfig): Promise<void> {
    this.currentTrackConfig = config;
    this.selectedAgentId = null;
    await this.refreshData();
  }

  async refreshData(): Promise<void> {
    if (!this.currentTrackConfig) {
      this.replays = [];
      this.agents = [];
      this.personalBestIds.clear();
      this.computedQualityScores.clear();
      this.render();
      return;
    }

    const compositeSeed = encodeCompositeSeed(this.currentTrackConfig);
    this.replays = await lapReplayStorage.getReplaySummariesForTrack(compositeSeed);
    this.agents = await agentStorage.getAgentSummariesForTrack(compositeSeed);

    // Compute personal bests for all drivers
    this.computePersonalBests();

    // Compute percentile-based quality scores for all laps
    this.computeQualityScores();

    this.render();
  }

  /**
   * Compute percentile-based quality scores for all laps.
   * Quality is relative to all laps on this track.
   */
  private computeQualityScores(): void {
    this.computedQualityScores.clear();

    if (this.replays.length === 0) return;

    // Get all lap times for percentile calculation
    const allLapTimes = this.replays.map(r => r.lapTime);

    // Create evaluator and compute scores for each lap
    const evaluator = new LapEvaluator();
    for (const replay of this.replays) {
      const score = evaluator.evaluateWithContext(replay, allLapTimes);
      this.computedQualityScores.set(replay.id, score.overall);
    }
  }

  /**
   * Compute personal best IDs for all drivers (human + AI agents).
   * PB = fastest valid (leaderboard-eligible) lap for each driver.
   */
  private computePersonalBests(): void {
    this.personalBestIds.clear();

    // Find PB for current human player
    const humanPB = this.findPersonalBestId(this.currentPlayerInitials, false);
    if (humanPB) {
      this.personalBestIds.set(`human:${this.currentPlayerInitials}`, humanPB);
    }

    // Find PB for each AI agent
    const agentNames = new Set(
      this.replays
        .filter(r => r.isAI && r.agentName)
        .map(r => r.agentName!)
    );
    for (const agentName of agentNames) {
      const aiPB = this.findPersonalBestId(agentName, true);
      if (aiPB) {
        this.personalBestIds.set(`ai:${agentName}`, aiPB);
      }
    }
  }

  /**
   * Find the personal best lap ID for a driver.
   * @param identifier Player initials (for human) or agent name (for AI)
   * @param isAI Whether to search AI laps
   */
  private findPersonalBestId(identifier: string, isAI: boolean): string | null {
    const validLaps = this.replays.filter(r => {
      // Must be leaderboard eligible (no off-track)
      if (!r.cleanliness?.isLeaderboardEligible) return false;

      if (isAI) {
        return r.isAI && r.agentName === identifier;
      }
      return !r.isAI && r.playerInitials === identifier;
    });

    if (validLaps.length === 0) return null;

    // Replays are already sorted by lapTime ascending - first is fastest
    return validLaps[0].id;
  }

  setPlayingState(isPlaying: boolean, replayId?: string): void {
    if (this.state !== 'training') {
      this.state = isPlaying ? 'playing' : 'idle';
    }
    this.currentlyPlayingId = isPlaying ? replayId || null : null;
    this.render();
  }

  setTrainingState(isTraining: boolean): void {
    this.state = isTraining ? 'training' : 'idle';
    this.render();
  }

  setTrainingProgress(episode: number, totalEpisodes: number, loss: number): void {
    const progressFill = document.getElementById('tp-progress-fill');
    const progressText = document.getElementById('tp-progress-text');

    if (progressFill) {
      const percent = (episode / totalEpisodes) * 100;
      progressFill.style.width = `${percent}%`;
    }

    if (progressText) {
      progressText.textContent = `Episode ${episode}/${totalEpisodes} (loss: ${loss.toFixed(4)})`;
    }
  }

  setSelectedAgent(agentId: string | null): void {
    this.selectedAgentId = agentId;
    this.render();
  }

  setRewardWeights(weights: RewardWeights): void {
    this.rewardWeights = { ...weights };
    this.render();
  }

  getRewardWeights(): RewardWeights {
    return { ...this.rewardWeights };
  }

  showReplaySaved(lapTime: number): void {
    console.log(`Replay saved: ${this.formatTime(lapTime)}`);
    this.refreshData();
  }

  /**
   * Update the current player initials.
   * This triggers a PB recomputation to show the correct PB badge.
   */
  setPlayerInitials(initials: string): void {
    this.currentPlayerInitials = initials.toUpperCase().slice(0, 3);
    // Recompute PBs and re-render if we have data
    if (this.replays.length > 0) {
      this.computePersonalBests();
      this.render();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // SIL API (Session vs All-Time Stats)
  // ─────────────────────────────────────────────────────────────

  /**
   * Set SIL state (running or stopped).
   */
  setSILState(isActive: boolean): void {
    if (isActive) {
      this.state = 'sil';
    } else if (this.state === 'sil') {
      this.state = 'idle';
      // Reset session stats
      this.silSessionLaps = 0;
      this.silSessionGoodLaps = 0;
      this.silSessionBestTime = null;
      this.silSelectedCount = 0;
      this.silAllTimeBestTime = null;
    }
    this.render();
  }

  /**
   * Update SIL progress display with session and all-time stats.
   */
  updateSILProgress(
    sessionLaps: number,
    sessionGoodLaps: number,
    sessionBestTime: number | null,
    selectedCount: number,
    allTimeBestTime: number | null
  ): void {
    this.silSessionLaps = sessionLaps;
    this.silSessionGoodLaps = sessionGoodLaps;
    this.silSessionBestTime = sessionBestTime;
    this.silSelectedCount = selectedCount;
    this.silAllTimeBestTime = allTimeBestTime;

    // Update DOM directly without full re-render
    const sessionLapsEl = document.getElementById('tp-sil-session-laps');
    const sessionGoodEl = document.getElementById('tp-sil-session-good');
    const sessionBestEl = document.getElementById('tp-sil-session-best');
    const selectedEl = document.getElementById('tp-sil-selected');
    const allTimeBestEl = document.getElementById('tp-sil-alltime-best');

    if (sessionLapsEl) sessionLapsEl.textContent = String(sessionLaps);
    if (sessionGoodEl) sessionGoodEl.textContent = String(sessionGoodLaps);
    if (sessionBestEl) sessionBestEl.textContent = sessionBestTime ? this.formatTime(sessionBestTime) : '--:--';
    if (selectedEl) selectedEl.textContent = String(selectedCount);
    if (allTimeBestEl) allTimeBestEl.textContent = allTimeBestTime ? this.formatTime(allTimeBestTime) : '--:--';
  }

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────

  private formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins > 0) {
      return `${mins}:${secs.toFixed(2).padStart(5, '0')}`;
    }
    return secs.toFixed(2);
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  getWidth(): number {
    return TRAINING_PANEL_WIDTH;
  }
}

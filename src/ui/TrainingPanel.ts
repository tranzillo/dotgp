import { UI_COLORS } from './UIComponent';
import { UIButton } from './components/UIButton';
import { UIPanel } from './components/UIPanel';
import { UILabel } from './components/UILabel';
import { UIProgressBar } from './components/UIProgressBar';
import { UIChart } from './components/UIChart';
import { UIList } from './components/UIList';
import type { EpisodeStats } from '../ai/types';

export const TRAINING_PANEL_WIDTH = 280;

export interface TrainingPanelCallbacks {
  onStartTraining: () => void;
  onStopTraining: () => void;
  onReplayEpisode: (episodeNumber: number) => void;
  onStopReplay: () => void;
}

/**
 * Training control panel UI.
 */
export class TrainingPanel {
  private x: number;
  private y: number;
  private width: number;
  private height: number;
  private callbacks: TrainingPanelCallbacks;

  // Components
  private panel: UIPanel;
  private startButton: UIButton;
  private stopButton: UIButton;
  private stopReplayButton: UIButton;
  private progressBar: UIProgressBar;
  private rewardChart: UIChart;
  private episodeList: UIList;

  // Labels
  private episodeLabel: UILabel;
  private rewardLabel: UILabel;
  private speedLabel: UILabel;
  private lapsLabel: UILabel;
  private statusLabel: UILabel;

  // State
  private isTraining: boolean = false;
  private isReplaying: boolean = false;
  private currentEpisode: number = 0;
  private totalEpisodes: number = 0;
  private totalLaps: number = 0;

  constructor(x: number, y: number, height: number, callbacks: TrainingPanelCallbacks) {
    this.x = x;
    this.y = y;
    this.width = TRAINING_PANEL_WIDTH;
    this.height = height;
    this.callbacks = callbacks;

    // Create components
    this.panel = new UIPanel(x, y, this.width, height, 'AI TRAINING');

    const contentX = x + 10;
    let contentY = this.panel.getContentStartY() + 5;

    // Control buttons
    this.startButton = new UIButton(contentX, contentY, 120, 28, 'Start Training');
    this.startButton.setOnClick(() => {
      if (!this.isTraining) {
        this.callbacks.onStartTraining();
      }
    });

    this.stopButton = new UIButton(contentX + 130, contentY, 120, 28, 'Stop');
    this.stopButton.setDisabled(true);
    this.stopButton.setOnClick(() => {
      if (this.isTraining) {
        this.callbacks.onStopTraining();
      }
    });

    this.stopReplayButton = new UIButton(contentX, contentY, 250, 28, 'Stop Replay');
    this.stopReplayButton.visible = false;
    this.stopReplayButton.setOnClick(() => {
      this.callbacks.onStopReplay();
    });

    contentY += 40;

    // Status label
    this.statusLabel = new UILabel(contentX, contentY, 'Ready', {
      color: UI_COLORS.textMuted,
      fontSize: 11,
    });
    contentY += 20;

    // Progress bar
    this.progressBar = new UIProgressBar(contentX, contentY, 250, 18);
    this.progressBar.setLabel('0 / 0');
    contentY += 30;

    // Episode counter
    this.episodeLabel = new UILabel(contentX, contentY, 'Episode: 0 / 0', { fontSize: 12 });
    contentY += 18;

    // Stats labels
    this.rewardLabel = new UILabel(contentX, contentY, 'Reward: --', { fontSize: 11 });
    contentY += 16;

    this.speedLabel = new UILabel(contentX, contentY, 'Avg Speed: --', { fontSize: 11 });
    contentY += 16;

    this.lapsLabel = new UILabel(contentX, contentY, 'Laps Completed: 0', { fontSize: 11 });
    contentY += 25;

    // Reward chart
    this.rewardChart = new UIChart(contentX, contentY, 250, 80, 100);
    this.rewardChart.setTitle('Reward');
    contentY += 90;

    // Episode list
    const listHeight = height - contentY - 10;
    this.episodeList = new UIList(contentX, contentY, 250, Math.max(100, listHeight), 20);
    this.episodeList.setTitle('EPISODES');
    this.episodeList.setOnItemClick((item) => {
      if (!this.isTraining) {
        this.callbacks.onReplayEpisode(item.id as number);
      }
    });
  }

  /**
   * Update training state.
   */
  setTrainingState(isTraining: boolean, currentEpisode: number, totalEpisodes: number): void {
    this.isTraining = isTraining;
    this.currentEpisode = currentEpisode;
    this.totalEpisodes = totalEpisodes;

    this.startButton.setDisabled(isTraining);
    this.stopButton.setDisabled(!isTraining);

    if (isTraining) {
      this.statusLabel.setText('Training...');
      this.statusLabel.setColor(UI_COLORS.textHighlight);
    } else {
      this.statusLabel.setText('Ready');
      this.statusLabel.setColor(UI_COLORS.textMuted);
    }

    this.updateProgress();
  }

  /**
   * Update replay state.
   */
  setReplayState(isReplaying: boolean, episodeNumber?: number): void {
    this.isReplaying = isReplaying;

    this.startButton.visible = !isReplaying;
    this.stopButton.visible = !isReplaying;
    this.stopReplayButton.visible = isReplaying;

    if (isReplaying && episodeNumber !== undefined) {
      this.statusLabel.setText(`Replaying Episode ${episodeNumber}`);
      this.statusLabel.setColor(UI_COLORS.warning);
    } else if (!this.isTraining) {
      this.statusLabel.setText('Ready');
      this.statusLabel.setColor(UI_COLORS.textMuted);
    }
  }

  /**
   * Update with episode results.
   */
  addEpisodeResult(stats: EpisodeStats): void {
    // Update chart
    this.rewardChart.addPoint(stats.totalReward);

    // Update labels
    this.rewardLabel.setText(`Reward: ${stats.totalReward.toFixed(1)}`);
    this.speedLabel.setText(`Avg Speed: ${stats.avgSpeed.toFixed(2)}`);

    if (stats.lapCompleted) {
      this.totalLaps++;
    }
    this.lapsLabel.setText(`Laps Completed: ${this.totalLaps}`);

    // Add to list
    const lapTimeStr = stats.lapTime ? `${stats.lapTime.toFixed(1)}s` : '';
    this.episodeList.addItem({
      id: stats.episode,
      label: `Ep ${stats.episode}: ${stats.totalReward.toFixed(0)}`,
      sublabel: lapTimeStr,
      highlight: stats.lapCompleted,
    });

    this.updateProgress();
  }

  /**
   * Update episode counter.
   */
  updateEpisode(episode: number, total: number): void {
    this.currentEpisode = episode;
    this.totalEpisodes = total;
    this.updateProgress();
  }

  private updateProgress(): void {
    const progress = this.totalEpisodes > 0 ? this.currentEpisode / this.totalEpisodes : 0;
    this.progressBar.setValue(progress);
    this.progressBar.setLabel(`${this.currentEpisode} / ${this.totalEpisodes}`);
    this.episodeLabel.setText(`Episode: ${this.currentEpisode} / ${this.totalEpisodes}`);
  }

  /**
   * Reset panel state.
   */
  reset(): void {
    this.currentEpisode = 0;
    this.totalEpisodes = 0;
    this.totalLaps = 0;
    this.isTraining = false;
    this.isReplaying = false;

    this.rewardChart.clear();
    this.episodeList.clear();
    this.progressBar.setValue(0);
    this.progressBar.setLabel('0 / 0');
    this.episodeLabel.setText('Episode: 0 / 0');
    this.rewardLabel.setText('Reward: --');
    this.speedLabel.setText('Avg Speed: --');
    this.lapsLabel.setText('Laps Completed: 0');
    this.statusLabel.setText('Ready');
    this.statusLabel.setColor(UI_COLORS.textMuted);

    this.startButton.setDisabled(false);
    this.stopButton.setDisabled(true);
    this.startButton.visible = true;
    this.stopButton.visible = true;
    this.stopReplayButton.visible = false;
  }

  /**
   * Handle mouse click.
   */
  handleClick(x: number, y: number): boolean {
    // Check buttons
    if (this.startButton.visible && this.startButton.containsPoint(x, y)) {
      this.startButton.onClick();
      return true;
    }
    if (this.stopButton.visible && this.stopButton.containsPoint(x, y)) {
      this.stopButton.onClick();
      return true;
    }
    if (this.stopReplayButton.visible && this.stopReplayButton.containsPoint(x, y)) {
      this.stopReplayButton.onClick();
      return true;
    }

    // Check episode list
    if (!this.isTraining && this.episodeList.containsPoint(x, y)) {
      this.episodeList.onClick();
      return true;
    }

    return false;
  }

  /**
   * Handle mouse move for hover effects.
   */
  handleMouseMove(x: number, y: number): void {
    // Update hover states
    this.startButton.onHover(this.startButton.containsPoint(x, y));
    this.stopButton.onHover(this.stopButton.containsPoint(x, y));
    this.stopReplayButton.onHover(this.stopReplayButton.containsPoint(x, y));
    this.episodeList.containsPoint(x, y); // Updates internal hover state
  }

  /**
   * Render the panel.
   */
  render(ctx: CanvasRenderingContext2D): void {
    // Main panel background
    this.panel.render(ctx);

    // Buttons
    if (this.isReplaying) {
      this.stopReplayButton.render(ctx);
    } else {
      this.startButton.render(ctx);
      this.stopButton.render(ctx);
    }

    // Status and progress
    this.statusLabel.render(ctx);
    this.progressBar.render(ctx);

    // Stats
    this.episodeLabel.render(ctx);
    this.rewardLabel.render(ctx);
    this.speedLabel.render(ctx);
    this.lapsLabel.render(ctx);

    // Chart
    this.rewardChart.render(ctx);

    // Episode list
    this.episodeList.render(ctx);
  }

  /**
   * Check if point is within panel bounds.
   */
  containsPoint(x: number, y: number): boolean {
    return x >= this.x && x <= this.x + this.width && y >= this.y && y <= this.y + this.height;
  }

  getWidth(): number {
    return this.width;
  }

  /**
   * Update panel position (called when canvas resizes).
   */
  setPosition(newX: number, newY: number): void {
    const dx = newX - this.x;
    const dy = newY - this.y;

    if (dx === 0 && dy === 0) return;

    this.x = newX;
    this.y = newY;

    // Update all components by offset
    this.panel.setPosition(this.panel.x + dx, this.panel.y + dy);
    this.startButton.setPosition(this.startButton.x + dx, this.startButton.y + dy);
    this.stopButton.setPosition(this.stopButton.x + dx, this.stopButton.y + dy);
    this.stopReplayButton.setPosition(this.stopReplayButton.x + dx, this.stopReplayButton.y + dy);
    this.progressBar.setPosition(this.progressBar.x + dx, this.progressBar.y + dy);
    this.rewardChart.setPosition(this.rewardChart.x + dx, this.rewardChart.y + dy);
    this.episodeList.setPosition(this.episodeList.x + dx, this.episodeList.y + dy);
    this.statusLabel.setPosition(this.statusLabel.x + dx, this.statusLabel.y + dy);
    this.episodeLabel.setPosition(this.episodeLabel.x + dx, this.episodeLabel.y + dy);
    this.rewardLabel.setPosition(this.rewardLabel.x + dx, this.rewardLabel.y + dy);
    this.speedLabel.setPosition(this.speedLabel.x + dx, this.speedLabel.y + dy);
    this.lapsLabel.setPosition(this.lapsLabel.x + dx, this.lapsLabel.y + dy);
  }
}

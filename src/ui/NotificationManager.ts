/**
 * NotificationManager - Toast notification system
 *
 * Shows brief, non-intrusive notifications for notable events:
 * - Personal bests (human and AI)
 * - Fast laps
 * - Good training data collected
 * - Agent improvements
 * - Sector improvements
 */

export type NotificationType = 'success' | 'info' | 'warning' | 'improvement' | 'gold';

export interface Notification {
  type: NotificationType;
  message: string;
  duration: number;  // ms
  icon?: string;
}

const DEFAULT_DURATION = 3000;  // 3 seconds

export class NotificationManager {
  private container: HTMLElement;
  private activeNotifications: HTMLElement[] = [];
  private maxNotifications: number = 3;

  constructor() {
    // Create container if it doesn't exist
    let container = document.getElementById('notification-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'notification-container';
      container.className = 'notification-container';
      document.body.appendChild(container);
    }
    this.container = container;
  }

  /**
   * Show a notification.
   */
  show(notification: Notification): void {
    // Limit active notifications
    if (this.activeNotifications.length >= this.maxNotifications) {
      const oldest = this.activeNotifications.shift();
      oldest?.remove();
    }

    const element = document.createElement('div');
    element.className = `notification notification-${notification.type}`;

    // Build content
    let content = '';
    if (notification.icon) {
      content += `<span class="notification-icon">${notification.icon}</span>`;
    }
    content += `<span class="notification-message">${this.escapeHtml(notification.message)}</span>`;
    element.innerHTML = content;

    // Add to container
    this.container.appendChild(element);
    this.activeNotifications.push(element);

    // Auto-remove after duration
    setTimeout(() => {
      element.classList.add('notification-fade-out');
      setTimeout(() => {
        element.remove();
        const idx = this.activeNotifications.indexOf(element);
        if (idx >= 0) {
          this.activeNotifications.splice(idx, 1);
        }
      }, 300);  // Match CSS fade-out duration
    }, notification.duration);
  }

  /**
   * Show a fast lap notification (human player).
   */
  showFastLap(time: number, delta: number): void {
    const timeStr = this.formatTime(time);
    const deltaStr = delta < 0 ? `${delta.toFixed(2)}s` : `+${delta.toFixed(2)}s`;
    this.show({
      type: 'success',
      message: `Fast lap! ${timeStr} (${deltaStr})`,
      duration: DEFAULT_DURATION,
      icon: '🏎️',
    });
  }

  /**
   * Show a new personal best notification.
   */
  showNewBest(time: number, isAI: boolean = false): void {
    const timeStr = this.formatTime(time);
    this.show({
      type: 'gold',
      message: isAI ? `New AI best! ${timeStr}` : `New personal best! ${timeStr}`,
      duration: DEFAULT_DURATION + 1000,  // Show longer for PB
      icon: '🏆',
    });
  }

  /**
   * Show good training data collected notification.
   */
  showGoodTrainingData(qualityScore: number): void {
    const stars = qualityScore >= 80 ? '⭐⭐⭐' : qualityScore >= 60 ? '⭐⭐' : '⭐';
    this.show({
      type: 'info',
      message: `Good training data ${stars}`,
      duration: DEFAULT_DURATION,
      icon: '📊',
    });
  }

  /**
   * Show agent improvement notification.
   */
  showAgentImprovement(oldBest: number, newBest: number): void {
    const delta = oldBest - newBest;
    this.show({
      type: 'improvement',
      message: `Agent improved! ${this.formatTime(oldBest)} → ${this.formatTime(newBest)} (-${delta.toFixed(2)}s)`,
      duration: DEFAULT_DURATION + 1000,
      icon: '📈',
    });
  }

  /**
   * Show sector improvement notification.
   */
  showSectorBest(sector: number, time: number): void {
    this.show({
      type: 'success',
      message: `S${sector} best: ${time.toFixed(2)}s`,
      duration: 2000,  // Shorter for sector
      icon: '⚡',
    });
  }

  /**
   * Show SIL cycle complete notification.
   */
  showCycleComplete(cycle: number, lapsUsed: number): void {
    this.show({
      type: 'info',
      message: `Training cycle ${cycle} complete (${lapsUsed} laps used)`,
      duration: DEFAULT_DURATION,
      icon: '🔄',
    });
  }

  /**
   * Show a generic info notification.
   */
  showInfo(message: string): void {
    this.show({
      type: 'info',
      message,
      duration: DEFAULT_DURATION,
    });
  }

  /**
   * Format time as M:SS.cc
   */
  private formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toFixed(2).padStart(5, '0')}`;
  }

  /**
   * Escape HTML to prevent XSS.
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Singleton instance
let instance: NotificationManager | null = null;

export function getNotificationManager(): NotificationManager {
  if (!instance) {
    instance = new NotificationManager();
  }
  return instance;
}

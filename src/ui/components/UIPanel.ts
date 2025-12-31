import { UIComponentBase, UI_COLORS } from '../UIComponent';

export class UIPanel extends UIComponentBase {
  private title: string;
  private showTitle: boolean;

  constructor(x: number, y: number, width: number, height: number, title: string = '') {
    super(x, y, width, height);
    this.title = title;
    this.showTitle = title.length > 0;
  }

  setTitle(title: string): void {
    this.title = title;
    this.showTitle = title.length > 0;
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.visible) return;

    // Background
    ctx.fillStyle = UI_COLORS.panelBackground;
    ctx.fillRect(this.x, this.y, this.width, this.height);

    // Border
    ctx.strokeStyle = UI_COLORS.panelBorder;
    ctx.lineWidth = 2;
    ctx.strokeRect(this.x, this.y, this.width, this.height);

    // Title
    if (this.showTitle) {
      ctx.fillStyle = UI_COLORS.text;
      ctx.font = 'bold 14px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(this.title, this.x + 10, this.y + 10);

      // Title underline
      ctx.strokeStyle = UI_COLORS.panelBorder;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(this.x + 10, this.y + 28);
      ctx.lineTo(this.x + this.width - 10, this.y + 28);
      ctx.stroke();
    }
  }

  /**
   * Get the Y position where content should start (after title).
   */
  getContentStartY(): number {
    return this.showTitle ? this.y + 35 : this.y + 10;
  }
}

import { UIComponentBase, UI_COLORS } from '../UIComponent';

export type TextAlign = 'left' | 'center' | 'right';

export class UILabel extends UIComponentBase {
  private text: string;
  private color: string;
  private fontSize: number;
  private fontWeight: string;
  private align: TextAlign;

  constructor(
    x: number,
    y: number,
    text: string,
    options: {
      color?: string;
      fontSize?: number;
      fontWeight?: string;
      align?: TextAlign;
    } = {}
  ) {
    super(x, y, 0, 0); // Width/height calculated from text
    this.text = text;
    this.color = options.color ?? UI_COLORS.text;
    this.fontSize = options.fontSize ?? 12;
    this.fontWeight = options.fontWeight ?? 'normal';
    this.align = options.align ?? 'left';
  }

  setText(text: string): void {
    this.text = text;
  }

  setColor(color: string): void {
    this.color = color;
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.visible) return;

    ctx.fillStyle = this.color;
    ctx.font = `${this.fontWeight} ${this.fontSize}px monospace`;
    ctx.textAlign = this.align;
    ctx.textBaseline = 'top';
    ctx.fillText(this.text, this.x, this.y);
  }
}

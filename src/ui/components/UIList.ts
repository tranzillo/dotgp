import { UIComponentBase, UI_COLORS } from '../UIComponent';

export interface ListItem {
  id: string | number;
  label: string;
  sublabel?: string;
  highlight?: boolean;
}

export class UIList extends UIComponentBase {
  private items: ListItem[] = [];
  private maxItems: number;
  private itemHeight: number = 24;
  private selectedIndex: number = -1;
  private hoveredIndex: number = -1;
  private onItemClick: ((item: ListItem, index: number) => void) | null = null;
  private title: string = '';

  constructor(x: number, y: number, width: number, height: number, maxItems: number = 20) {
    super(x, y, width, height);
    this.maxItems = maxItems;
  }

  setTitle(title: string): void {
    this.title = title;
  }

  addItem(item: ListItem): void {
    this.items.unshift(item); // Add to beginning (newest first)
    if (this.items.length > this.maxItems) {
      this.items.pop();
    }
  }

  clear(): void {
    this.items = [];
    this.selectedIndex = -1;
    this.hoveredIndex = -1;
  }

  getItems(): ListItem[] {
    return this.items;
  }

  setOnItemClick(handler: (item: ListItem, index: number) => void): void {
    this.onItemClick = handler;
  }

  onClick(): void {
    if (this.hoveredIndex >= 0 && this.hoveredIndex < this.items.length) {
      this.selectedIndex = this.hoveredIndex;
      if (this.onItemClick) {
        this.onItemClick(this.items[this.hoveredIndex], this.hoveredIndex);
      }
    }
  }

  containsPoint(px: number, py: number): boolean {
    const inBounds = super.containsPoint(px, py);
    if (inBounds) {
      // Calculate which item is hovered
      const titleOffset = this.title ? 20 : 0;
      const relativeY = py - this.y - titleOffset;
      this.hoveredIndex = Math.floor(relativeY / this.itemHeight);
      if (this.hoveredIndex < 0 || this.hoveredIndex >= this.items.length) {
        this.hoveredIndex = -1;
      }
    } else {
      this.hoveredIndex = -1;
    }
    return inBounds;
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.visible) return;

    // Background
    ctx.fillStyle = UI_COLORS.chartBackground;
    ctx.fillRect(this.x, this.y, this.width, this.height);

    // Border
    ctx.strokeStyle = UI_COLORS.panelBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(this.x, this.y, this.width, this.height);

    // Title
    let contentY = this.y;
    if (this.title) {
      ctx.fillStyle = UI_COLORS.textMuted;
      ctx.font = '10px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(this.title, this.x + 6, this.y + 4);
      contentY += 20;
    }

    // Calculate visible items
    const visibleHeight = this.height - (this.title ? 20 : 0);
    const maxVisible = Math.floor(visibleHeight / this.itemHeight);

    // Render items
    for (let i = 0; i < Math.min(this.items.length, maxVisible); i++) {
      const item = this.items[i];
      const itemY = contentY + i * this.itemHeight;

      // Item background (hover/selected)
      if (i === this.selectedIndex) {
        ctx.fillStyle = UI_COLORS.listItemSelected;
        ctx.fillRect(this.x + 1, itemY, this.width - 2, this.itemHeight);
      } else if (i === this.hoveredIndex) {
        ctx.fillStyle = UI_COLORS.listItemHover;
        ctx.fillRect(this.x + 1, itemY, this.width - 2, this.itemHeight);
      }

      // Item label
      ctx.fillStyle = item.highlight ? UI_COLORS.success : UI_COLORS.text;
      ctx.font = '11px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(item.label, this.x + 8, itemY + this.itemHeight / 2);

      // Sublabel (right-aligned)
      if (item.sublabel) {
        ctx.fillStyle = UI_COLORS.textMuted;
        ctx.textAlign = 'right';
        ctx.fillText(item.sublabel, this.x + this.width - 8, itemY + this.itemHeight / 2);
      }

      // Highlight indicator
      if (item.highlight) {
        ctx.fillStyle = UI_COLORS.success;
        ctx.font = '10px monospace';
        ctx.textAlign = 'right';
        ctx.fillText('✓', this.x + this.width - 8, itemY + this.itemHeight / 2);
      }
    }

    // Show "click to replay" hint if items exist
    if (this.items.length > 0) {
      ctx.fillStyle = UI_COLORS.textMuted;
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('click to replay', this.x + this.width / 2, this.y + this.height - 4);
    }
  }
}

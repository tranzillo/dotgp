import { Vector2 } from '../utils/Vector2';
import { CONFIG } from '../utils/Constants';

export type MouseClickCallback = (x: number, y: number) => void;
export type MouseMoveCallback = (x: number, y: number) => void;

export class InputManager {
  private keys: Set<string> = new Set();
  private keyDownCallbacks: Map<string, () => void> = new Map();

  // Mouse state
  private canvas: HTMLCanvasElement | null = null;
  private mousePosition: Vector2 = Vector2.zero();
  private mouseButtonDown: boolean = false;
  private carPosition: Vector2 = Vector2.zero();
  private mouseClickCallbacks: MouseClickCallback[] = [];
  private mouseMoveCallbacks: MouseMoveCallback[] = [];
  private renderScale: number = 1; // Scale factor for screen-to-world conversion
  private renderOffsetX: number = 0; // World offset for screen-to-world conversion
  private renderOffsetY: number = 0;

  // Gamepad state
  private gamepadIndex: number | null = null;
  private currentInput: Vector2 = Vector2.zero();
  private readonly DEADZONE = 0.15;
  private gamepadButtonCallbacks: Map<number, () => void> = new Map();
  private gamepadButtonsPressed: Set<number> = new Set();

  constructor() {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('gamepadconnected', this.handleGamepadConnected);
    window.addEventListener('gamepaddisconnected', this.handleGamepadDisconnected);
  }

  /**
   * Set the canvas element for mouse coordinate conversion.
   */
  setCanvas(canvas: HTMLCanvasElement): void {
    // Remove old listeners if canvas was already set
    if (this.canvas) {
      this.canvas.removeEventListener('mousedown', this.handleMouseDown);
      this.canvas.removeEventListener('mouseup', this.handleMouseUp);
      this.canvas.removeEventListener('mousemove', this.handleMouseMove);
      this.canvas.removeEventListener('mouseleave', this.handleMouseLeave);
    }

    this.canvas = canvas;
    this.canvas.addEventListener('mousedown', this.handleMouseDown);
    this.canvas.addEventListener('mouseup', this.handleMouseUp);
    this.canvas.addEventListener('mousemove', this.handleMouseMove);
    this.canvas.addEventListener('mouseleave', this.handleMouseLeave);

    // Also listen for mouseup on window to catch releases outside canvas
    window.addEventListener('mouseup', this.handleMouseUp);
  }

  private handleMouseDown = (e: MouseEvent): void => {
    // Only track left mouse button (button 0)
    if (e.button === 0) {
      this.mouseButtonDown = true;
    }
    const pos = this.getCanvasPosition(e);
    for (const callback of this.mouseClickCallbacks) {
      callback(pos.x, pos.y);
    }
  };

  private handleMouseUp = (e: MouseEvent): void => {
    // Only track left mouse button (button 0)
    if (e.button === 0) {
      this.mouseButtonDown = false;
    }
  };

  private handleMouseMove = (e: MouseEvent): void => {
    this.mousePosition = this.getCanvasPosition(e);
    for (const callback of this.mouseMoveCallbacks) {
      callback(this.mousePosition.x, this.mousePosition.y);
    }
  };

  private handleMouseLeave = (): void => {
    this.mousePosition = new Vector2(-1, -1);
    this.mouseButtonDown = false;
  };

  private getCanvasPosition(e: MouseEvent): Vector2 {
    if (!this.canvas) return Vector2.zero();
    const rect = this.canvas.getBoundingClientRect();
    // Convert screen coordinates to world coordinates using render scale and offset
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    return new Vector2(
      screenX / this.renderScale + this.renderOffsetX,
      screenY / this.renderScale + this.renderOffsetY
    );
  }

  /**
   * Set the render transform for screen-to-world coordinate conversion.
   * Should be called whenever the canvas scale or offset changes.
   */
  setRenderTransform(scale: number, offsetX: number = 0, offsetY: number = 0): void {
    this.renderScale = scale;
    this.renderOffsetX = offsetX;
    this.renderOffsetY = offsetY;
  }

  /**
   * Set the render scale for screen-to-world coordinate conversion.
   * @deprecated Use setRenderTransform instead
   */
  setRenderScale(scale: number): void {
    this.renderScale = scale;
  }

  /**
   * Get current mouse position in canvas coordinates.
   */
  getMousePosition(): Vector2 {
    return this.mousePosition;
  }

  /**
   * Set the car position for mouse direction calculation.
   * Should be called each frame by the game loop.
   */
  setCarPosition(pos: Vector2): void {
    this.carPosition = pos;
  }

  /**
   * Get mouse-based acceleration input.
   * Returns a direction vector toward the cursor, scaled by distance.
   */
  private getMouseInput(): Vector2 {
    if (!this.mouseButtonDown) return Vector2.zero();
    if (this.mousePosition.x < 0) return Vector2.zero(); // Mouse left canvas

    const direction = this.mousePosition.subtract(this.carPosition);
    const distance = direction.magnitude();

    if (distance < 1) return Vector2.zero(); // Avoid division issues

    // Calculate throttle based on distance
    const normalizedDistance = Math.min(distance / CONFIG.MOUSE_THROTTLE_MAX_DISTANCE, 1);
    const throttle =
      CONFIG.MOUSE_THROTTLE_MIN + (1 - CONFIG.MOUSE_THROTTLE_MIN) * normalizedDistance;

    return direction.normalize().scale(throttle);
  }

  /**
   * Register a callback for mouse click events.
   */
  onMouseClick(callback: MouseClickCallback): void {
    this.mouseClickCallbacks.push(callback);
  }

  /**
   * Register a callback for mouse move events.
   */
  onMouseMove(callback: MouseMoveCallback): void {
    this.mouseMoveCallbacks.push(callback);
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    const key = e.key.toLowerCase();
    if (!this.keys.has(key)) {
      this.keys.add(key);
      const callback = this.keyDownCallbacks.get(key);
      if (callback) callback();
    }
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
  };

  private handleGamepadConnected = (e: GamepadEvent): void => {
    this.gamepadIndex = e.gamepad.index;
    console.log(`Gamepad connected: ${e.gamepad.id}`);
  };

  private handleGamepadDisconnected = (e: GamepadEvent): void => {
    if (this.gamepadIndex === e.gamepad.index) {
      this.gamepadIndex = null;
      console.log('Gamepad disconnected');
    }
  };

  private getKeyboardInput(): Vector2 {
    let x = 0;
    let y = 0;

    if (this.isKeyPressed('w') || this.isKeyPressed('arrowup')) y -= 1;
    if (this.isKeyPressed('s') || this.isKeyPressed('arrowdown')) y += 1;
    if (this.isKeyPressed('a') || this.isKeyPressed('arrowleft')) x -= 1;
    if (this.isKeyPressed('d') || this.isKeyPressed('arrowright')) x += 1;

    const input = new Vector2(x, y);
    return input.magnitude() > 0 ? input.normalize() : input;
  }

  private getGamepadInput(): Vector2 {
    if (this.gamepadIndex === null) return Vector2.zero();
    const gamepads = navigator.getGamepads();
    const gamepad = gamepads[this.gamepadIndex];
    if (!gamepad) return Vector2.zero();

    const x = gamepad.axes[0]; // Left stick X
    const y = gamepad.axes[1]; // Left stick Y

    // Apply radial deadzone
    const mag = Math.sqrt(x * x + y * y);
    if (mag < this.DEADZONE) return Vector2.zero();

    // Rescale magnitude to 0-1 after deadzone
    const scale = (mag - this.DEADZONE) / (1 - this.DEADZONE);
    return new Vector2(x, y).normalize().scale(Math.min(1, scale));
  }

  /**
   * Poll gamepad buttons and fire callbacks on button press.
   * Should be called each frame.
   */
  pollGamepadButtons(): void {
    if (this.gamepadIndex === null) return;
    const gamepads = navigator.getGamepads();
    const gamepad = gamepads[this.gamepadIndex];
    if (!gamepad) return;

    for (let i = 0; i < gamepad.buttons.length; i++) {
      const isPressed = gamepad.buttons[i].pressed;
      const wasPressed = this.gamepadButtonsPressed.has(i);

      if (isPressed && !wasPressed) {
        // Button just pressed - fire callback
        this.gamepadButtonsPressed.add(i);
        const callback = this.gamepadButtonCallbacks.get(i);
        if (callback) callback();
      } else if (!isPressed && wasPressed) {
        // Button released
        this.gamepadButtonsPressed.delete(i);
      }
    }
  }

  /**
   * Register a callback for a gamepad button press.
   * XInput button mapping:
   *   0 = A, 1 = B, 2 = X, 3 = Y
   *   4 = LB, 5 = RB, 6 = LT, 7 = RT
   *   8 = Back, 9 = Start
   *   10 = Left Stick, 11 = Right Stick
   *   12 = D-pad Up, 13 = D-pad Down, 14 = D-pad Left, 15 = D-pad Right
   */
  onGamepadButton(button: number, callback: () => void): void {
    this.gamepadButtonCallbacks.set(button, callback);
  }

  getAccelerationInput(): Vector2 {
    // Mouse takes priority when button is held
    const mouseInput = this.getMouseInput();
    if (mouseInput.magnitude() > 0.01) {
      this.currentInput = mouseInput;
      return this.currentInput;
    }

    // Fall back to gamepad/keyboard
    const gamepadInput = this.getGamepadInput();
    const keyboardInput = this.getKeyboardInput();

    // Prefer gamepad if it has input, else keyboard
    this.currentInput = gamepadInput.magnitude() > 0.01
      ? gamepadInput
      : keyboardInput;

    return this.currentInput;
  }

  getCurrentInput(): Vector2 {
    return this.currentInput;
  }

  isKeyPressed(key: string): boolean {
    return this.keys.has(key.toLowerCase());
  }

  onKeyDown(key: string, callback: () => void): void {
    this.keyDownCallbacks.set(key.toLowerCase(), callback);
  }

  destroy(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('gamepadconnected', this.handleGamepadConnected);
    window.removeEventListener('gamepaddisconnected', this.handleGamepadDisconnected);
    window.removeEventListener('mouseup', this.handleMouseUp);

    if (this.canvas) {
      this.canvas.removeEventListener('mousedown', this.handleMouseDown);
      this.canvas.removeEventListener('mouseup', this.handleMouseUp);
      this.canvas.removeEventListener('mousemove', this.handleMouseMove);
      this.canvas.removeEventListener('mouseleave', this.handleMouseLeave);
    }

    this.keys.clear();
    this.keyDownCallbacks.clear();
    this.mouseClickCallbacks = [];
    this.mouseMoveCallbacks = [];
    this.mouseButtonDown = false;
    this.gamepadIndex = null;
    this.gamepadButtonCallbacks.clear();
    this.gamepadButtonsPressed.clear();
  }
}

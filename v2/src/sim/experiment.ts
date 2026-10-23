import { PHYSICS } from './constants';

/**
 * Experiment switches, to try a change by eye before making it for real:
 * ?car=2 (the cars' width, m) and ?widths=0.75 (racing surfaces scaled,
 * generated and preset tracks alike, everything laid round them following).
 * Read from the page's address when this loads (the page imports it first);
 * a worker gets the page's in its first message (experimentName) and applies
 * them before it builds or simulates anything. Off outside a browser
 * (scripts, tests).
 */
export const EXPERIMENT = { widthScale: 1, car: 0 };

/** Puts the switches in a query (?car=2&widths=0.75) in force. */
export function applyExperiment(query: string): void {
  const params = new URLSearchParams(query);
  const car = Number(params.get('car'));
  if (car >= 1 && car <= 6) {
    EXPERIMENT.car = car;
    (PHYSICS as { CAR_RADIUS: number }).CAR_RADIUS = car / 2;
  }
  const widths = Number(params.get('widths'));
  if (widths >= 0.4 && widths <= 2.5) EXPERIMENT.widthScale = widths;
}
if (typeof window !== 'undefined') applyExperiment(window.location.search);

/** The switches in force, as a query for a worker to apply too, or '' if none. */
export function experimentName(): string {
  const on = new URLSearchParams();
  if (EXPERIMENT.car) on.set('car', String(EXPERIMENT.car));
  if (EXPERIMENT.widthScale !== 1) on.set('widths', String(EXPERIMENT.widthScale));
  return on.size ? `?${on}` : '';
}

/** A track's parameters with its widths scaled by the experiment (racing surface, narrower back straights, apron). */
export function scaledWidths<P extends object>(params: P): P {
  const k = EXPERIMENT.widthScale;
  if (k === 1) return params;
  const out = { ...params } as Record<string, unknown>;
  for (const key of ['width', 'backWidth', 'apronWidth']) if (typeof out[key] === 'number') out[key] = (out[key] as number) * k;
  return out as P;
}

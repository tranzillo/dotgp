import { PHYSICS } from './constants';

/**
 * Experiment switches, to try a change by eye before making it for real:
 * ?car=2 (the cars' width, m), ?widths=0.75 (racing surfaces scaled,
 * generated and preset tracks alike, everything laid round them following)
 * ?pitwidth=1.3 (pit road's travel lane and boxes scaled) and ?spec=cup, f1
 * or series (a NASCAR Cup car, an F1 car, or each in its series: carSpec.ts;
 * 2 m wide unless ?car says otherwise); ?damage=1 or 2 (one damage model
 * on every track, not the second on ovals and the first on road circuits:
 * damage.ts); ?lines=2 (ovals banked for two lines, low and high, both off
 * the wall: trackgen/balance.ts).
 * Read from the page's address when this loads (the page imports it first);
 * a worker gets the page's in its first message (experimentName) and applies
 * them before it builds or simulates anything. Outside a browser (scripts,
 * tests) off, unless DOTGP_EXPERIMENT says otherwise.
 */
export const EXPERIMENT = { widthScale: 1, car: 0, pitWidth: 1, spec: '', damage: 0, lines: 0 };

/** Puts the switches in a query (?car=2&widths=0.75) in force. */
export function applyExperiment(query: string): void {
  const params = new URLSearchParams(query);
  const spec = params.get('spec');
  if (spec === 'cup' || spec === 'f1' || spec === 'series') {
    EXPERIMENT.spec = spec;
    (PHYSICS as { CAR_RADIUS: number }).CAR_RADIUS = 1;
  }
  const car = Number(params.get('car'));
  if (car >= 1 && car <= 6) {
    EXPERIMENT.car = car;
    (PHYSICS as { CAR_RADIUS: number }).CAR_RADIUS = car / 2;
  }
  const widths = Number(params.get('widths'));
  if (widths >= 0.4 && widths <= 2.5) EXPERIMENT.widthScale = widths;
  const pit = Number(params.get('pitwidth'));
  if (pit >= 0.5 && pit <= 2.5) EXPERIMENT.pitWidth = pit;
  const damage = params.get('damage');
  if (damage === '1' || damage === '2') EXPERIMENT.damage = Number(damage);
  if (params.get('lines') === '2') EXPERIMENT.lines = 2;
}
if (typeof window !== 'undefined') applyExperiment(window.location.search);
// Scripts and the lab (node): the same switches from the environment, DOTGP_EXPERIMENT='?spec=cup' (worker threads
// inherit it).
else if (typeof process !== 'undefined' && process.env?.DOTGP_EXPERIMENT) applyExperiment(process.env.DOTGP_EXPERIMENT);

/** The switches in force, as a query for a worker to apply too, or '' if none. */
export function experimentName(): string {
  const on = new URLSearchParams();
  if (EXPERIMENT.car) on.set('car', String(EXPERIMENT.car));
  if (EXPERIMENT.widthScale !== 1) on.set('widths', String(EXPERIMENT.widthScale));
  if (EXPERIMENT.pitWidth !== 1) on.set('pitwidth', String(EXPERIMENT.pitWidth));
  if (EXPERIMENT.spec) on.set('spec', EXPERIMENT.spec);
  if (EXPERIMENT.damage) on.set('damage', String(EXPERIMENT.damage));
  if (EXPERIMENT.lines) on.set('lines', String(EXPERIMENT.lines));
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

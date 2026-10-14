import { describe, expect, it } from 'vitest';
import { borderReads, randomLivery, withLegibleBorder } from '../src/render/livery';

describe('liveries', () => {
  it('only gives borders that read on the asphalt', () => {
    let seed = 1;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 500; i++) expect(borderReads(randomLivery([], random).border)).toBe(true);
  });

  it('rejects dark borders', () => {
    for (const dark of ['#111111', '#000000', '#14532d', '#1d4ed8', '#0d0d0f']) expect(borderReads(dark)).toBe(false);
  });

  it('migrates a saved dark border, the same way every time', () => {
    const old = { number: 7, fill: '#e63946', border: '#111111' };
    const a = withLegibleBorder(old);
    expect(borderReads(a.border)).toBe(true);
    expect(a.fill).toBe(old.fill);
    expect(withLegibleBorder(old)).toEqual(a);
    const fine = { number: 3, fill: '#111111', border: '#ffd60a' };
    expect(withLegibleBorder(fine)).toBe(fine);
  });
});

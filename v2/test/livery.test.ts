import { describe, expect, it } from 'vitest';
import { borderReads, randomLivery, withLegibleBorder, withTrim } from '../src/render/livery';

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

  it('gives every new livery a trim, and an old one the same trim every time', () => {
    let seed = 3;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 100; i++) expect(randomLivery([], random).trim).toMatch(/^#[0-9a-f]{6}$/);
    const old = { number: 12, fill: '#e63946', border: '#f8f9fa' };
    expect(withTrim(old).trim).toBeTruthy();
    expect(withTrim(old)).toEqual(withTrim(old));
    const trimmed = { ...old, trim: '#111111' };
    expect(withTrim(trimmed)).toBe(trimmed);
  });
});

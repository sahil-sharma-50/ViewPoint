import { describe, it, expect } from 'vitest';
import { formatDate } from './utils/formatDate.js';
import { toggleDarkMode } from './features/darkMode.js';
import { renderDashboard } from './features/newDashboard.js';
import { generateLegacyExport } from './features/legacyExport.js';

describe('formatDate', () => {
  it('formats a known date as YYYY-MM-DD', () => {
    const date = new Date(2024, 0, 5); // Jan 5 2024
    expect(formatDate(date)).toBe('2024-01-05');
  });

  it('pads single-digit month and day', () => {
    const date = new Date(2023, 2, 9); // Mar 9 2023
    expect(formatDate(date)).toBe('2023-03-09');
  });
});

describe('toggleDarkMode', () => {
  it('returns enabled message when true', () => {
    const result = toggleDarkMode(true);
    expect(result).toMatch(/Dark mode enabled/);
  });

  it('returns disabled message when false', () => {
    const result = toggleDarkMode(false);
    expect(result).toMatch(/Dark mode disabled/);
  });
});

describe('renderDashboard (newDashboard — retirement candidate)', () => {
  it('includes the title in output', () => {
    const result = renderDashboard('Analytics');
    expect(result).toContain('Analytics');
  });
});

describe('generateLegacyExport (legacyExport — retirement candidate)', () => {
  it('includes the name and ends with .csv', () => {
    const result = generateLegacyExport('users');
    expect(result).toContain('users');
    expect(result).toMatch(/\.csv$/);
  });
});

/**
 * darkMode.ts — Dark mode feature toggle.
 *
 * Consumed by: index.ts
 * fanIn: 1 → certainty: 'unsafe' (has internal consumers)
 */

import { formatDate } from '../utils/formatDate.js';

/**
 * Toggle dark mode and return a status string with the current date.
 */
export function toggleDarkMode(enabled: boolean): string {
  const timestamp = formatDate(new Date());
  return `Dark mode ${enabled ? 'enabled' : 'disabled'} on ${timestamp}`;
}

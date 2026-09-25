/**
 * formatDate.ts — Shared date formatting utility.
 *
 * Consumed by: darkMode.ts, newDashboard.ts, legacyExport.ts
 * fanIn: 3 → certainty: 'unsafe' (protected shared dependency)
 */

/**
 * Format a Date as "YYYY-MM-DD".
 */
export function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

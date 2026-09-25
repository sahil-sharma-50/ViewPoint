/**
 * newDashboard.ts — New dashboard feature (retired).
 *
 * Consumed by: nobody
 * fanIn: 0, isSoleExport: true → certainty: 'candidate' (whole-file removal path)
 */

import { formatDate } from '../utils/formatDate.js';

/**
 * Render the new dashboard header with a formatted timestamp.
 */
export function renderDashboard(title: string): string {
  const timestamp = formatDate(new Date());
  return `[${timestamp}] Dashboard: ${title}`;
}

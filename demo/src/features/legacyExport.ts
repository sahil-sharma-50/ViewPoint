/**
 * legacyExport.ts — Legacy export feature (retired).
 *
 * Consumed by: nobody
 * fanIn: 0, isSoleExport: true → certainty: 'candidate' (whole-file removal path)
 */

import { formatDate } from '../utils/formatDate.js';

/**
 * Generate a legacy export filename with a formatted date prefix.
 */
export function generateLegacyExport(name: string): string {
  const timestamp = formatDate(new Date());
  return `export_${timestamp}_${name}.csv`;
}

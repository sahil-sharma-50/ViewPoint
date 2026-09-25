/**
 * lazyFeature.ts — Feature loaded via literal dynamic import from loader.ts.
 *
 * Consumed by: loader.ts (via import('./lazyFeature.js'))
 * fanIn: 1 → certainty: 'unsafe' (has an internal consumer via dynamic import)
 */

/**
 * Return a placeholder string for the lazy-loaded feature.
 */
export function lazyFeature(): string {
  return 'lazy-feature-active';
}

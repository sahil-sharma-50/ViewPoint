/**
 * loader.ts — Demonstrates literal dynamic import.
 *
 * Uses import('./features/lazyFeature.js') with a string literal so the
 * dependency graph can resolve it as a real incoming edge.
 *
 * This file intentionally has no named exports; it exists only as an edge
 * source to prove that literal dynamic imports produce fan-in counts.
 */

/**
 * Load and invoke the lazy feature on demand.
 */
export async function loadFeature(): Promise<string> {
  const mod = await import('./features/lazyFeature.js');
  return mod.lazyFeature();
}

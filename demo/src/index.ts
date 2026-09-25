/**
 * index.ts — App entry point.
 *
 * Imports only darkMode. Does NOT import newDashboard or legacyExport.
 * This is intentional: newDashboard and legacyExport have fanIn === 0.
 */

import { toggleDarkMode } from './features/darkMode.js';

const status = toggleDarkMode(true);
console.log(status);

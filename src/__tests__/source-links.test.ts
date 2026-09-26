import { expect, it } from 'vitest';
import { evidenceParts, githubFileUrl } from '../source-links.js';

it('links only known evidence files to their GitHub source', () => {
  const files = new Set(['components/ActivityDrawer.tsx', 'features/session/session.types.ts']);
  expect(evidenceParts('components/ActivityDrawer.tsx → features/session/session.types.ts', files))
    .toEqual([
      { text: 'components/ActivityDrawer.tsx', file: 'components/ActivityDrawer.tsx' },
      { text: ' → ' },
      { text: 'features/session/session.types.ts', file: 'features/session/session.types.ts' },
    ]);
  expect(evidenceParts('Source excerpt: components/ActivityDrawer.tsx, first 60 lines.', files))
    .toEqual([{ text: 'Source excerpt: ' }, { text: 'components/ActivityDrawer.tsx', file: 'components/ActivityDrawer.tsx' }, { text: ', first 60 lines.' }]);
  expect(evidenceParts('components/ActivityDrawer.tsx: 2 known incoming files.', files))
    .toEqual([{ text: 'components/ActivityDrawer.tsx', file: 'components/ActivityDrawer.tsx' }, { text: ': 2 known incoming files.' }]);
  expect(evidenceParts('Incomplete connection map: parser failed.', files))
    .toEqual([{ text: 'Incomplete connection map: parser failed.' }]);
  expect(githubFileUrl('https://github.com/owner/repo', 'components/Activity Drawer.tsx'))
    .toBe('https://github.com/owner/repo/blob/HEAD/components/Activity%20Drawer.tsx');
  expect(githubFileUrl('https://example.com/owner/repo', 'components/ActivityDrawer.tsx')).toBeUndefined();
});

import { describe, it, expect } from 'vitest';
import type { ExportNode, Certainty, EvidenceItem } from '../types.js';

describe('smoke', () => {
  it('Certainty type allows candidate, unknown, unsafe', () => {
    const values: Certainty[] = ['candidate', 'unknown', 'unsafe'];
    expect(values).toHaveLength(3);
  });

  it('ExportNode shape is well-formed', () => {
    const evidence: EvidenceItem[] = [{ kind: 'no-internal-refs', detail: 'zero internal importers' }];
    const node: ExportNode = {
      id: 'src/features/newDashboard.ts',
      file: 'src/features/newDashboard.ts',
      name: 'newDashboard',
      kind: 'function',
      fanIn: 0,
      fanOut: 1,
      isSoleExport: true,
      isEntryPoint: false,
      certainty: 'candidate',
      evidence,
    };
    expect(node.certainty).toBe('candidate');
    expect(node.isEntryPoint).toBe(false);
    expect(node.isSoleExport).toBe(true);
  });

  it('entry-point evidence kind is valid', () => {
    const item: EvidenceItem = { kind: 'entry-point', detail: 'listed in package.json exports' };
    expect(item.kind).toBe('entry-point');
  });
});

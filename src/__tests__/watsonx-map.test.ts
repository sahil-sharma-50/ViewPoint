import { afterEach, expect, it, vi } from 'vitest';
import { explainArchitecture, explainMapContext } from '../watsonx.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('retries an uncited map answer and accepts a numeric citation string', async () => {
  vi.stubEnv('WATSONX_API_KEY', 'test-map-key');
  vi.stubEnv('WATSONX_PROJECT_ID', 'test-project');
  vi.stubEnv('WATSONX_API_ENDPOINT', 'https://us-south.ml.cloud.ibm.com');
  const replies = [
    { summary: 'Uncited answer', evidenceIds: [] },
    { summary: 'The selected folder contains twelve files.', evidenceIds: Array.from({ length: 13 }, (_, id) => String(id)) },
  ];
  let chatCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('identity/token'))
      return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 300 }), { status: 200 });
    chatCalls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(replies.shift()) } }] }), { status: 200 });
  }));

  const evidence = Array.from({ length: 13 }, (_, id) => `File ${id} is in the selected folder.`);
  const result = await explainMapContext('Folder test', evidence, 'Which files are there?', []);

  expect(result).toMatchObject({ ok: true, evidenceIds: Array.from({ length: 13 }, (_, id) => id), evidence });
  expect(chatCalls).toBe(2);
});

it('rejects citations to evidence omitted from the bounded model request', async () => {
  vi.stubEnv('WATSONX_API_KEY', 'test-bounded-evidence-key');
  vi.stubEnv('WATSONX_PROJECT_ID', 'test-project');
  vi.stubEnv('WATSONX_API_ENDPOINT', 'https://us-south.ml.cloud.ibm.com');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('identity/token'))
      return Response.json({ access_token: 'test-token', expires_in: 300 });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: 'An unsupported fact.', evidenceIds: [18] }) } }] });
  }));

  const result = await explainMapContext('Folder bounded', Array.from({ length: 19 }, (_, id) => `Fact ${id}`), 'Explain this folder', []);
  expect(result.ok).toBe(false);
});

it('accepts IBM AWS regional endpoints for both explanation paths', async () => {
  vi.stubEnv('WATSONX_API_KEY', 'test-aws-endpoint-key');
  vi.stubEnv('WATSONX_PROJECT_ID', 'test-project');
  vi.stubEnv('WATSONX_API_ENDPOINT', 'https://ap-south-1.aws.wxai.ibm.com');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('identity/token'))
      return Response.json({ access_token: 'test-token', expires_in: 300 });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: 'A source route.', evidenceIds: [0] }) } }] });
  }));
  expect((await explainMapContext('File server.ts', ['A source route.'], 'Explain', [])).ok).toBe(true);
  expect((await explainArchitecture({ schema: 1, files: [], calls: [], routes: [{ url: '/api/test', file: 'server.ts' }], deployments: [], states: [], scannedFiles: 1, skippedFiles: 0 })).ok).toBe(true);
});

it('accepts an architecture brief citing every supplied fact', async () => {
  vi.stubEnv('WATSONX_API_KEY', 'test-architecture-citations-key');
  vi.stubEnv('WATSONX_PROJECT_ID', 'test-project');
  vi.stubEnv('WATSONX_API_ENDPOINT', 'https://us-south.ml.cloud.ibm.com');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('identity/token')) return Response.json({ access_token: 'test-token', expires_in: 300 });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: 'Six routes are declared.', evidenceIds: [0, 1, 2, 3, 4, 5] }) } }] });
  }));
  const result = await explainArchitecture({ schema: 1, files: [], calls: [], routes: Array.from({ length: 6 }, (_, id) => ({ url: `/api/${id}`, file: `route-${id}.ts` })), deployments: [], states: [], scannedFiles: 6, skippedFiles: 0 });
  expect(result).toMatchObject({ ok: true, evidenceIds: [0, 1, 2, 3, 4, 5], focusFiles: ['route-0.ts', 'route-1.ts', 'route-2.ts', 'route-3.ts', 'route-4.ts', 'route-5.ts'] });
});

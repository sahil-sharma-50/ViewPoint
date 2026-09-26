'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { SerialGraph } from '../src/server';
import type { Architecture } from '../src/architecture';
import { evidenceParts, githubFileUrl } from '../src/source-links';

export function useWorkspace(view: 'architecture' | 'files') {
  const [data, setData] = useState<{
    graph: SerialGraph;
    architecture?: Architecture;
    repoUrl: string;
  }>();
  const [error, setError] = useState('');
  const sessionId = useSearchParams().get('session') ?? '';
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setData(undefined);
    setError('');
    async function load() {
      try {
        const response = await fetch(
          `/api/workspace?session=${encodeURIComponent(sessionId)}&view=${view}`,
          { signal: controller.signal, cache: 'no-store' },
        );
        const body = await response.json();
        if (response.status === 202) { timer = setTimeout(() => void load(), 500); return; }
        if (!response.ok) throw new Error(body.error || 'Could not load the repository.');
        setData(body);
      } catch (reason) {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : 'Could not load the repository.');
      }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [view, sessionId]);
  return { data, error, sessionId };
}

export function ViewSwitch({
  sessionId,
  view,
}: {
  sessionId: string;
  view: 'architecture' | 'files' | 'full-map';
}) {
  return (
    <nav className="view-switch" aria-label="Repository views">
      <Link
        href={`/architecture?session=${encodeURIComponent(sessionId)}`}
        aria-current={view === 'architecture' ? 'page' : undefined}
      >
        Architecture
      </Link>
      <Link
        href={`/full-map?session=${encodeURIComponent(sessionId)}`}
        aria-current={view === 'full-map' ? 'page' : undefined}
      >
        Full Map
      </Link>
      <Link
        href={`/graph-view?session=${encodeURIComponent(sessionId)}`}
        aria-current={view === 'files' ? 'page' : undefined}
      >
        Files
      </Link>
    </nav>
  );
}

export function WorkspaceStatus({ error }: { error: string }) {
  return (
    <main className="expired">
      <p role={error ? 'alert' : 'status'}>{error || 'Loading repository…'}</p>
      {error && (
        <Link className="btn" href="/">
          Analyse Repository
        </Link>
      )}
    </main>
  );
}

type AiReply = { ok: true; summary: string; evidence?: string[] } | { ok: false; error: string };

function AnswerText({ text }: { text: string }) {
  return text.split(/(`[^`\n]+`)/g).map((part, index) =>
    part.startsWith('`') && part.endsWith('`')
      ? <code key={index}>{part.slice(1, -1)}</code>
      : part,
  );
}

export function AiExchange({ question, answer, busy, repoUrl, files }: { question: string; answer?: AiReply; busy: boolean; repoUrl: string; files: SerialGraph['nodes'] }) {
  if (!question) return null;
  const knownFiles = new Set(files.map(node => node.file));
  return <div className="vp-ai-exchange" aria-busy={busy}>
    <div className="vp-ai-question"><span className="vp-ai-role">You asked</span><p>{question}</p></div>
    <div className={`vp-ai-result ${answer && !answer.ok ? 'is-error' : ''}`}>
      <div className="vp-ai-result-heading"><span className="vp-ai-role">Granite</span></div>
      {busy ? <div className="vp-ai-thinking" role="status" aria-label="Granite is preparing an answer"><span>Reading source evidence</span><span className="vp-ai-dots" aria-hidden="true"><i /><i /><i /></span></div>
        : answer?.ok ? <>
          <div className="vp-ai-answer">{answer.summary.split(/\n\s*\n/).map((paragraph, index) => <p key={index}><AnswerText text={paragraph} /></p>)}</div>
          {!!answer.evidence?.length && <div className="vp-ai-evidence"><span className="vp-ai-role">Source evidence</span><ul>{answer.evidence.map((item, index) => <li key={index}>{evidenceParts(item, knownFiles).map((part, partIndex) => {
            const href = part.file && githubFileUrl(repoUrl, part.file);
            return href ? <a key={partIndex} href={href} target="_blank" rel="noopener noreferrer">{part.text}</a> : <span key={partIndex}><AnswerText text={part.text} /></span>;
          })}</li>)}</ul></div>}
        </> : answer ? <p className="vp-ai-error">{answer.error}</p> : null}
    </div>
  </div>;
}

export function WorkspaceWarnings({ warnings }: { warnings?: string[] }) {
  if (!warnings?.length) return null;
  return <aside className="workspace-warnings" role="status" aria-label="Incomplete connection map">
    <strong>Some connections are unavailable</strong>
    <ul>{warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
    <p>Files with no shown connections may still import or be imported by other files.</p>
  </aside>;
}

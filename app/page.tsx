'use client';

import { useEffect, useRef, useState } from 'react';
import Header from './header';
import CodePreview from './code-preview';
import AnalysisProgress from './analysis-progress';

const descriptions = {
  cloning: 'Creating a temporary copy. Large repositories take a little longer.',
  analysing: 'Reading source files and tracing known internal dependencies.',
  complete: 'Your dependency map is ready.',
};
const examples = [
  ['Talk-OS', 'Voice-directed productivity workspace'],
  ['QuorumCast', 'Ask a video archive a question and get a written answer'],
  ['LexGuard', 'Paper-only autonomous options trading system'],
];

export default function Home() {
  const [repoUrl, setRepoUrl] = useState('');
  const [session, setSession] = useState('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<keyof typeof descriptions>('cloning');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const request = useRef<AbortController | null>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const saved = new URLSearchParams(window.location.search).get('session');
    if (saved) { setSession(saved); setBusy(true); }
    return () => request.current?.abort();
  }, []);
  useEffect(() => {
    if (!busy) return;
    title.current?.focus();
    const start = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => { if (error) input.current?.focus(); }, [error]);
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch(`/analysis-status?session=${encodeURIComponent(session)}`, { signal: controller.signal, cache: 'no-store' });
        const state = await response.json();
        if (!response.ok || state.status === 'error') throw new Error(state.error || 'Analysis could not finish. Please try again.');
        setStage(state.status in descriptions ? state.status : 'analysing');
        if (state.status === 'complete') window.location.replace(`/architecture?session=${encodeURIComponent(session)}`);
        else timer = setTimeout(poll, 800);
      } catch (reason) {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : 'Connection interrupted. Please try again.');
        setBusy(false); setSession('');
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [session]);

  async function analyse(value: string) {
    const url = value.trim();
    if (!url) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setRepoUrl(url); setError(''); setStage('cloning'); setSession(''); setBusy(true);
    try {
      const response = await fetch('/analyse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, async: true }), signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not start analysis.');
      history.replaceState(null, '', '/?session=' + encodeURIComponent(data.sessionId));
      setSession(data.sessionId);
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : 'Could not reach the server.');
      setBusy(false);
    }
  }

  return <><Header />
    <main id="landing" className="landing" hidden={busy}>
      <section className="hero" aria-labelledby="hero-title"><div className="hero-copy">
        <h1 id="hero-title">Understand the codebase.<br />See how it connects.</h1>
        <p className="hero-description">Map the architecture of a public GitHub repository, trace file connections, and understand how the project fits together.</p>
        <form id="analyseForm" action="/analyse" method="post" onSubmit={event => { event.preventDefault(); void analyse(repoUrl); }}>
          <label htmlFor="repoUrl">Public GitHub repository</label><div className="input-row">
            <input ref={input} id="repoUrl" type="text" name="repoUrl" placeholder="owner/repository or GitHub URL" required spellCheck={false} autoComplete="url" aria-describedby="statusBox" value={repoUrl} onChange={event => setRepoUrl(event.target.value)} />
            <button className="btn" type="submit" id="submitBtn" disabled={!repoUrl.trim() || busy}>Analyse Repository <span aria-hidden="true">→</span></button>
          </div><div className="status-box error" id="statusBox" role="alert" hidden={!error}>{error}</div>
        </form><p className="hero-note">Any public repository. Analysis stays in a temporary copy.</p>
      </div><CodePreview /></section>
      <section className="examples" aria-labelledby="examples-title"><h2 id="examples-title">START WITH AN EXAMPLE</h2><div className="example-cards">
        {examples.map(([name, description]) => <button key={name} type="button" className="example-card" data-repo={`https://github.com/sahil-sharma-50/${name}`} onClick={() => void analyse(`https://github.com/sahil-sharma-50/${name}`)}><strong>{name}</strong><small className="example-path">sahil-sharma-50 / {name}</small><span className="example-description">{description}</span></button>)}
      </div></section>
    </main>
    <AnalysisProgress busy={busy} stage={stage} repoUrl={repoUrl} elapsed={elapsed} session={session} titleRef={title} />
    <footer className="site-footer"><span className="footer-tagline">See how the codebase fits together.</span><span className="footer-credit">Built with IBM Bob</span></footer>
  </>;
}

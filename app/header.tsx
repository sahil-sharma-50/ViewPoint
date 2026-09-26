'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

export default function Header({ workspace = false, repoName }: { workspace?: boolean; repoName?: string }) {
  const [theme, setTheme] = useState('dark');
  useEffect(() => {
    let saved = 'dark';
    try { saved = localStorage.getItem('viewpoint-theme') === 'light' ? 'light' : 'dark'; } catch { /* Storage is optional. */ }
    setTheme(saved);
    document.documentElement.dataset.theme = saved;
  }, []);
  function toggleTheme() {
    const value = theme === 'dark' ? 'light' : 'dark';
    setTheme(value);
    document.documentElement.dataset.theme = value;
    try { localStorage.setItem('viewpoint-theme', value); } catch { /* Storage is optional. */ }
  }
  return <header className="site-header"><div className="brand-group">{workspace && <Link className="workspace-back" href="/" aria-label="Back to start" title="Back to start"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m12 5-7 7 7 7M5 12h14" /></svg></Link>}<Link className="brand" href="/">{workspace ? 'VP' : 'ViewPoint'}</Link>{repoName && <><span className="header-divider" aria-hidden="true">|</span><strong className="header-repo" title={repoName}>{repoName}</strong></>}</div><nav aria-label="Main navigation">
    <a className="icon-link" href="https://github.com/sahil-sharma-50/ViewPoint" target="_blank" rel="noreferrer" aria-label="View ViewPoint on GitHub"><span className="icon github-icon" aria-hidden="true" /></a>
    <button className="theme-toggle icon-button" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}><span className="icon theme-icon" aria-hidden="true" /></button>
  </nav></header>;
}

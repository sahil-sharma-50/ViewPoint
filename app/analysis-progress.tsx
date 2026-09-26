import type { Ref } from 'react';
import './analysis-progress.css';

const stages = [
  { id: 'cloning', label: 'Clone repository', detail: 'Create a temporary copy of the source.', title: 'Cloning repository' },
  { id: 'analysing', label: 'Analyse dependencies', detail: 'Find imports and trace their connections.', title: 'Tracing dependencies' },
  { id: 'complete', label: 'Prepare map', detail: 'Organise the results for you to explore.', title: 'Your map is ready' },
] as const;

export default function AnalysisProgress({ busy, stage, repoUrl, elapsed, session, titleRef }: {
  busy: boolean;
  stage: 'cloning' | 'analysing' | 'complete';
  repoUrl: string;
  elapsed: number;
  session: string;
  titleRef: Ref<HTMLHeadingElement>;
}) {
  const active = stages.findIndex(item => item.id === stage);
  const nodes = [[96, 105], [253, 55], [419, 105], [96, 321], [253, 371], [419, 321]];
  return <main id="progress" className="analysis-progress" hidden={!busy} aria-labelledby="progress-title" data-stage={stage}>
          <svg className="analysis-network" aria-hidden="true" viewBox="0 0 520 430" fill="none">
            {nodes.map(([x, y], index) => <g key={index}>
              <path className="analysis-wire" d={`M${x} ${y} H${x < 260 ? 180 : 340} V215 H260`} />
              <path className="analysis-packet" pathLength="100" style={{ animationDelay: `${index * -.5}s` }} d={`M${x} ${y} H${x < 260 ? 180 : 340} V215 H260`} />
              <rect className="analysis-file" x={x - 23} y={y - 26} width="46" height="52" rx="9" />
              <path className="analysis-file-icon" d={`M${x - 8} ${y - 11} h10 l6 6 v17 h-16 z M${x + 2} ${y - 11} v6 h6 M${x - 3} ${y + 1} h6 M${x - 3} ${y + 6} h6`} />
              <circle className="analysis-port" cx={x + 22} cy={y - 23} r="3" />
            </g>)}
            <g className="analysis-core">
              <path className="analysis-layer lower" d="m260 192 79 44-79 46-79-46z" />
              <path className="analysis-layer middle" d="m260 172 79 44-79 46-79-46z" />
              <path className="analysis-layer upper" d="m260 152 79 44-79 46-79-46z" />
              <path className="analysis-code-mark" d="m243 182-18 11 18 10m34-21 18 11-18 10m-13-26-9 33" />
            </g>
          </svg>
    <h1 ref={titleRef} id="progress-title" tabIndex={-1} aria-live="polite">{stages[active].title}</h1>
    <p id="progress-repo">{repoUrl.replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '') || 'Resuming your analysis'}</p>
    <ol className="analysis-stages" aria-label="Analysis progress">
      {stages.map((item, index) => <li key={item.id} data-complete={index < active || stage === 'complete'} aria-current={index === active ? 'step' : undefined}>
        <span className="analysis-step-marker" aria-hidden="true">{(index < active || stage === 'complete') ? <svg className="analysis-check" viewBox="0 0 20 20"><path pathLength="1" d="m5 10 3 3 7-7" /></svg> : <span />}</span>
        <div><strong>{item.label}</strong><p>{item.detail}</p></div>
        <span className="analysis-step-status">{index < active || stage === 'complete' ? 'Done' : index === active ? 'Working' : 'Waiting'}</span>
      </li>)}
    </ol>
    <p id="elapsed">{elapsed} seconds elapsed</p>
    {stage === 'complete' && <a className="btn" href={`/architecture?session=${encodeURIComponent(session)}`}>Open architecture</a>}
  </main>;
}

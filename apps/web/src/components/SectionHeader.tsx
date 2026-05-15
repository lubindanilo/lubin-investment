import type { ReactNode } from 'react';
import './SectionHeader.css';

export function SectionHeader({ title, sub, score, right }: {
  title: string;
  sub?: string;
  score?: string;
  right?: ReactNode;
}) {
  return (
    <div className="section-header">
      <div>
        <div className="section-block-title">{title}</div>
        {sub && (
          <div className="section-block-sub">
            {sub}
            {score && <> · <span className="score-chip">{score}</span></>}
          </div>
        )}
      </div>
      {right}
    </div>
  );
}

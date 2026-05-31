import type { AnalyzeResponse } from '@lubin/shared';
import './ScoreCard.css';

export function ScoreCard({ analysis, onAddWatchlist, alreadyInWatchlist }: {
  analysis: AnalyzeResponse;
  onAddWatchlist: () => void;
  alreadyInWatchlist: boolean;
}) {
  const pct = analysis.score / analysis.scoreMax;
  const cls = pct >= 0.75 ? 'high' : pct >= 0.5 ? 'mid' : 'low';

  return (
    <div className="score-wrap">
      <div className={`score-circle ${cls}`}>
        <div className="score-num">{analysis.score}/{analysis.scoreMax}</div>
        <div className="score-label">SCORE</div>
      </div>
      <div className="score-info">
        <div className="score-header">
          <h1 className="score-company">
            {analysis.company} <span className="score-ticker">{analysis.ticker}</span>
          </h1>
          <button
            className="btn-secondary score-add-btn"
            onClick={onAddWatchlist}
            disabled={alreadyInWatchlist}
          >
            {alreadyInWatchlist ? 'Dans ta watchlist' : 'Ajouter à la watchlist'}
          </button>
        </div>
        {analysis.verdict_direct?.trim() && <p className="verdict-direct">{analysis.verdict_direct}</p>}
      </div>
    </div>
  );
}

import type { NewsItem } from '@lubin/shared';
import './NewsPanel.css';

const TYPE_COLORS: Record<NewsItem['type'], string> = {
  rachat: 'var(--green)',
  dividende: 'var(--brand)',
  'résultats': 'var(--orange)',
  'M&A': 'var(--brand-dark)',
  mgmt: 'var(--text)',
};

export function NewsPanel({ ticker, news }: { ticker: string; news: NewsItem[] }) {
  if (news.length === 0) return null;
  return (
    <div className="news-section">
      <div className="news-title">
        <span>Actualités récentes — {ticker}</span>
        <span className="news-subtitle">60 derniers jours</span>
      </div>
      <div className="news-list">
        {news.map((n, i) => (
          <a key={i} href={n.url} target="_blank" rel="noopener noreferrer" className="news-item">
            <span className="news-type" style={{ color: TYPE_COLORS[n.type] }}>
              {n.type.toUpperCase()}
            </span>
            <div className="news-body">
              <div className="news-headline">{n.titre}</div>
              <div className="news-summary">{n.resume}</div>
              {n.source && <div className="news-source">{n.source}</div>}
            </div>
            <span className="news-date">{n.date}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

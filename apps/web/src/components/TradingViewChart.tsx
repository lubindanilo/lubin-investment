import { useState } from 'react';
import './TradingViewChart.css';

const RANGES = ['1M', '3M', '6M', '1A', '5A'] as const;
const TV_RANGE_MAP: Record<string, string> = { '1M': '1M', '3M': '3M', '6M': '6M', '1A': '12M', '5A': '60M' };

export function TradingViewChart({ ticker }: { ticker: string }) {
  const [range, setRange] = useState<string>('1A');
  const tvRange = TV_RANGE_MAP[range] ?? '12M';

  const src = `https://s.tradingview.com/widgetembed/?frameElementId=tv_${ticker}`
    + `&symbol=${encodeURIComponent(ticker)}`
    + `&interval=D&hidesidetoolbar=1&hidetoptoolbar=1&hidelegend=0&saveimage=0`
    + `&theme=light&style=3&range=${tvRange}&locale=fr&utm_source=lubin-investment`;

  return (
    <div className="chart-section">
      <div className="chart-title">
        <span>Cours boursier — {ticker}</span>
        <div className="chart-periods">
          {RANGES.map(r => (
            <button
              key={r}
              className={`period-btn ${r === range ? 'active' : ''}`}
              onClick={() => setRange(r)}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      <div className="chart-iframe-wrap">
        <iframe src={src} title={`TradingView ${ticker}`} />
      </div>
    </div>
  );
}

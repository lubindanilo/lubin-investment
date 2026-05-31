/**
 * Primitives UI — direction "Moderne fintech" (portées du handoff design/ui.jsx).
 * Icônes line maison, Logo, ScoreCircle, StatusBadge, ScorePill, PriceChange, IconBtn, InfoPop.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import '../../styles/ui.css';

// ─── Icônes (set line, stroke 1.7) ──────────────────────────────────────────
export const ICON_PATHS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  bars: '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h7M15 18h5"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="13" cy="18" r="2"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  chevronR: '<path d="m9 6 6 6-6 6"/>',
  chevronD: '<path d="m6 9 6 6 6-6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.3M21 4v5h-5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  shield: '<path d="M12 3 5 6v6c0 4 3 6.5 7 9 4-2.5 7-5 7-9V6l-7-3Z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5ZM3 13l9 5 9-5"/>',
  pulse: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/>',
  star: '<path d="m12 3 2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.8 6.6 19.5l1.2-6L3.3 9.3l6.1-.7L12 3Z"/>',
  scale: '<path d="M12 3v18M5 7h14M5 7l-3 7h6l-3-7ZM19 7l-3 7h6l-3-7Z"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4-2v-4L3 5Z"/>',
} as const;

export type IconName = keyof typeof ICON_PATHS;

export function Icon({ name, size = 18, stroke = 1.7, className = '', style }: {
  name: IconName; size?: number; stroke?: number; className?: string; style?: CSSProperties;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round"
      className={className} style={style}
      dangerouslySetInnerHTML={{ __html: ICON_PATHS[name] }} />
  );
}

// ─── Logo Lubin ──────────────────────────────────────────────────────────────
export function Logo({ size = 30, showWord = true, color }: { size?: number; showWord?: boolean; color?: string }) {
  const c = color || 'var(--brand)';
  return (
    <div className="row gap-10">
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <rect x="0.5" y="0.5" width="31" height="31" rx="9" fill={c} />
        <path d="M9 21a7 7 0 0 1 14 0" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" fill="none" opacity="0.45" />
        <path d="M9 21a7 7 0 0 1 11.5-5.4" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" fill="none" />
        <circle cx="16" cy="21" r="2.1" fill="#fff" />
        <rect x="15.3" y="11" width="1.4" height="6.2" rx="0.7" fill="#fff" transform="rotate(34 16 14)" />
      </svg>
      {showWord && (
        <span style={{ fontWeight: 800, fontSize: size * 0.62, letterSpacing: '-0.04em', color: 'var(--ink)' }}>Lubin</span>
      )}
    </div>
  );
}

// ─── Couleur par niveau de note ──────────────────────────────────────────────
export interface ScoreTone { ring: string; bg: string; ink: string; label: string; }
export function scoreColor(score: number): ScoreTone {
  if (score >= 8) return { ring: 'var(--good)', bg: 'var(--good-bg)', ink: 'var(--good-ink)', label: 'Élevée' };
  if (score >= 6) return { ring: 'var(--warn)', bg: 'var(--warn-bg)', ink: 'var(--warn-ink)', label: 'Moyenne' };
  return { ring: 'var(--bad)', bg: 'var(--bad-bg)', ink: 'var(--bad-ink)', label: 'Faible' };
}

// ─── ScoreCircle (anneau /10) ────────────────────────────────────────────────
export function ScoreCircle({ score, size = 116, stroke = 9, animate = true }: {
  score: number; size?: number; stroke?: number; animate?: boolean;
}) {
  const c = scoreColor(score);
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - Math.max(0, Math.min(score, 10)) / 10);
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={c.ring} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={offset}
          style={animate ? { transition: 'stroke-dashoffset 1s cubic-bezier(.3,.7,.3,1)' } : undefined} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <div className="num" style={{ fontSize: size * 0.34, fontWeight: 700, lineHeight: 1, color: c.ink }}>
          {score}<span style={{ fontSize: size * 0.16, color: 'var(--ink-3)', fontWeight: 600 }}>/10</span>
        </div>
        <div style={{ fontSize: size * 0.1, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: c.ink, marginTop: 3 }}>
          {c.label}
        </div>
      </div>
    </div>
  );
}

// ─── StatusBadge (OUI / PARTIEL / NON) ───────────────────────────────────────
export type DataStatus = 'good' | 'warn' | 'bad';
const STATUS_LABEL: Record<DataStatus, string> = { good: 'OUI', warn: 'PARTIEL', bad: 'NON' };
/** Mappe les statuts backend (pass/warn/fail) vers la sémantique data. */
export function toDataStatus(s: 'pass' | 'warn' | 'fail'): DataStatus {
  return s === 'pass' ? 'good' : s === 'fail' ? 'bad' : 'warn';
}
export function StatusBadge({ status }: { status: DataStatus }) {
  return (
    <span className={`s-badge s-badge-${status}`}>
      <span className={`s-badge-dot s-dot-${status}`} />
      {STATUS_LABEL[status]}
    </span>
  );
}

// ─── ScorePill (compact, tables) ─────────────────────────────────────────────
export function ScorePill({ score }: { score: number }) {
  const c = scoreColor(score);
  return (
    <span className="num" style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 2,
      minWidth: 46, padding: '4px 9px', borderRadius: 8, fontWeight: 700, fontSize: 13.5,
      background: c.bg, color: c.ink,
    }}>
      {score}<span style={{ fontSize: 10.5, opacity: 0.65 }}>/10</span>
    </span>
  );
}

// ─── PriceChange ─────────────────────────────────────────────────────────────
export function PriceChange({ change, abs, currency = '$', size = 13 }: {
  change: number; abs?: number | null; currency?: string; size?: number;
}) {
  const up = change >= 0;
  return (
    <span className="num" style={{ color: up ? 'var(--good)' : 'var(--bad)', fontSize: size, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap' }}>
      <Icon name={up ? 'arrowUp' : 'arrowDown'} size={size - 1} stroke={2.4} />
      {up ? '+' : ''}{change.toFixed(2)} %
      {abs != null && <span style={{ color: 'var(--ink-4)', fontWeight: 500 }}>· {up ? '+' : ''}{currency}{Math.abs(abs).toFixed(2)}</span>}
    </span>
  );
}

// ─── IconBtn ─────────────────────────────────────────────────────────────────
export function IconBtn({ name, onClick, label, active = false, size = 16 }: {
  name: IconName; onClick?: () => void; label: string; active?: boolean; size?: number;
}) {
  return (
    <button onClick={onClick} aria-label={label} title={label} type="button"
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 30, height: 30, borderRadius: 8,
        border: '1px solid ' + (active ? 'var(--brand)' : 'var(--line)'),
        background: active ? 'var(--brand-soft)' : 'var(--surface)',
        color: active ? 'var(--brand-ink)' : 'var(--ink-3)', transition: 'all .14s', flexShrink: 0,
      }}>
      <Icon name={name} size={size} />
    </button>
  );
}

// ─── InfoPop (popover "i" : pourquoi + comment) ──────────────────────────────
export function InfoPop({ title, why, calc }: { title: string; why: string; calc: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(!open); }} aria-label="En savoir plus"
        style={{ display: 'inline-flex', width: 22, height: 22, borderRadius: 6, alignItems: 'center', justifyContent: 'center',
          border: '1px solid var(--line)', background: open ? 'var(--brand-soft)' : 'transparent', color: open ? 'var(--brand-ink)' : 'var(--ink-4)', transition: 'all .14s' }}>
        <Icon name="info" size={13} />
      </button>
      {open && (
        <span className="pop fade-in" style={{ top: 28, left: '50%', transform: 'translateX(-50%)' }} onClick={(e) => e.stopPropagation()}>
          <span className="pop-arrow" style={{ top: -5, left: '50%', marginLeft: -5 }} />
          <b style={{ display: 'block', marginBottom: 6, fontSize: 12.5 }}>{title}</b>
          <span style={{ display: 'block', opacity: 0.85, marginBottom: 8 }}>{why}</span>
          <span style={{ display: 'block', fontSize: 11, opacity: 0.6, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Calcul</span>
          <span className="mono" style={{ display: 'block', fontSize: 11.5, opacity: 0.8 }}>{calc}</span>
        </span>
      )}
    </span>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { WatchlistEntry } from '@lubin/shared';
import { api, ApiError } from '../lib/api.js';
import { useToast } from '../components/Toast.js';
import { Icon, ScorePill } from '../components/ui/primitives.js';
import { formatPrice } from '../lib/format.js';
import './WatchlistPage.css';

type SortKey = 'default' | 'price' | 'pfcf' | 'score' | 'earnings';
type SortDir = 'asc' | 'desc';
interface SortState { key: SortKey; dir: SortDir }
const SORT_STORAGE_KEY = 'li_watchlist_sort';

function loadSort(): SortState {
  try {
    const s = JSON.parse(localStorage.getItem(SORT_STORAGE_KEY) ?? '');
    if (s && ['default', 'price', 'pfcf', 'score', 'earnings'].includes(s.key) && ['asc', 'desc'].includes(s.dir)) return s as SortState;
  } catch { /* ignore */ }
  return { key: 'score', dir: 'desc' };
}
function saveSort(s: SortState) { localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(s)); }

function sortItems(items: WatchlistEntry[], { key, dir }: SortState): WatchlistEntry[] {
  if (key === 'default') return items;
  return [...items].sort((a, b) => {
    let cmp = 0;
    if (key === 'price') { const av = a.price, bv = b.price; if (av == null) return 1; if (bv == null) return -1; cmp = av - bv; }
    else if (key === 'pfcf') { const av = a.pfcfTTM, bv = b.pfcfTTM; if (av == null) return 1; if (bv == null) return -1; cmp = av - bv; }
    else if (key === 'earnings') { const av = a.nextEarningsDate, bv = b.nextEarningsDate; if (!av) return 1; if (!bv) return -1; cmp = av.localeCompare(bv); }
    else { const ra = a.scoreChiffresMax > 0 ? a.scoreChiffres / a.scoreChiffresMax : -1; const rb = b.scoreChiffresMax > 0 ? b.scoreChiffres / b.scoreChiffresMax : -1; cmp = ra - rb; }
    return dir === 'asc' ? cmp : -cmp;
  });
}

function formatEarnings(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso + 'T12:00:00Z');
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function WatchlistPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [items, setItems] = useState<WatchlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newTicker, setNewTicker] = useState('');
  const [sort, setSort] = useState<SortState>(() => loadSort());

  const sortedItems = useMemo(() => sortItems(items, sort), [items, sort]);

  function toggleSort(key: Exclude<SortKey, 'default'>) {
    setSort(prev => {
      const next: SortState = prev.key === key ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: key === 'score' ? 'desc' : 'asc' };
      saveSort(next); return next;
    });
  }

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try { setItems(await api.watchlist.refresh(true)); }
    catch (e) { toast.push('error', (e as Error).message); }
    finally { setRefreshing(false); }
  }, [toast]);

  const inFlight = useRef(false);
  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try { setItems(await api.watchlist.list()); }
    catch { /* silencieux : on garde l'affichage courant */ }
    finally { setLoading(false); inFlight.current = false; }
  }, []);

  useEffect(() => {
    load();
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  async function addTicker() {
    const t = newTicker.trim().toUpperCase();
    if (!t) return;
    if (items.some(i => i.ticker === t)) { toast.push('warn', `${t} est déjà dans ta watchlist.`); return; }
    setAdding(true);
    try { const entry = await api.watchlist.add(t); setItems(prev => [...prev, entry]); setNewTicker(''); toast.push('success', `${t} ajouté`); }
    catch (e) { toast.push('error', (e as Error).message); }
    finally { setAdding(false); }
  }

  async function remove(ticker: string) {
    try { await api.watchlist.remove(ticker); setItems(prev => prev.filter(e => e.ticker !== ticker)); }
    catch (e) { toast.push('error', (e as Error).message); }
  }

  const SortTh = ({ label, col, align = 'right' }: { label: string; col: Exclude<SortKey, 'default'>; align?: 'left' | 'right' }) => {
    const active = sort.key === col;
    return (
      <th className={'sortable' + (align === 'right' ? ' num-cell' : '')} onClick={() => toggleSort(col)}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: align === 'right' ? 'flex-end' : 'flex-start' }}>
          {label}<span style={{ opacity: active ? 1 : 0.25 }}><Icon name={active && sort.dir === 'asc' ? 'arrowUp' : 'arrowDown'} size={11} stroke={2.4} /></span>
        </span>
      </th>
    );
  };

  return (
    <div className="wl">
      <div className="wrap-wide wl-wrap">
        <div className="wl-head">
          <div className="col gap-4">
            <h1 className="wl-title">Watchlist</h1>
            <p className="muted" style={{ fontSize: 14 }}>
              {items.length} action{items.length > 1 ? 's' : ''} suivie{items.length > 1 ? 's' : ''} · prix et P/FCF mis à jour à chaque visite.
            </p>
          </div>
          <div className="row gap-10">
            <button className="btn btn-ghost btn-sm" onClick={refresh} disabled={refreshing}>
              {refreshing ? <><span className="spinner" /> Maj…</> : <><Icon name="refresh" size={15} /> Rafraîchir</>}
            </button>
            <Link to="/screener" className="btn btn-ghost btn-sm"><Icon name="plus" size={15} /> Depuis le screener</Link>
          </div>
        </div>

        <div className="wl-add">
          <div className="anl-search-field" style={{ maxWidth: 320 }}>
            <Icon name="search" size={16} className="anl-search-icon" />
            <input className="anl-search-input num" style={{ height: 40, paddingLeft: 40, fontSize: 14 }}
              value={newTicker} placeholder="Ajouter un ticker…"
              onChange={e => setNewTicker(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && addTicker()} />
          </div>
          <button className="btn btn-brand btn-sm" style={{ height: 40 }} onClick={addTicker} disabled={adding || !newTicker.trim()}>
            {adding ? <span className="spinner" /> : <><Icon name="plus" size={14} /> Ajouter</>}
          </button>
        </div>

        {loading ? (
          <div className="card skel-ui" style={{ height: 240 }} />
        ) : items.length === 0 ? (
          <div className="card wl-empty">
            <div className="wl-empty-icon"><Icon name="star" size={24} /></div>
            <h3>Votre watchlist est vide</h3>
            <p className="muted">Ajoutez un ticker ci-dessus, ou explorez le screener pour suivre les mieux notées.</p>
            <Link to="/screener" className="btn btn-brand" style={{ marginTop: 4 }}>Explorer le screener</Link>
          </div>
        ) : (
          <div className="card scroll-x" style={{ padding: 0, overflow: 'hidden' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Société</th>
                  <SortTh label="Cours" col="price" />
                  <SortTh label="P/FCF" col="pfcf" />
                  <SortTh label="Note" col="score" />
                  <SortTh label="Prochains résultats" col="earnings" align="left" />
                  <th style={{ width: 50 }}></th>
                </tr>
              </thead>
              <tbody>
                {sortedItems.map(w => {
                  const s = w.scoreChiffresMax > 0 ? Math.round(w.scoreChiffres / w.scoreChiffresMax * 10) : null;
                  return (
                    <tr key={w.ticker} onClick={() => navigate(`/analyse/${w.ticker}`)}>
                      <td style={{ maxWidth: 340 }}>
                        <div className="tbl-soc">
                          <span className="num tbl-soc-ticker">{w.ticker}</span>
                          <span className="tbl-soc-name">{w.name}</span>
                        </div>
                      </td>
                      <td className="num-cell num" style={{ fontWeight: 600 }}>{formatPrice(w.price, w.currency)}</td>
                      <td className="num-cell num">{w.pfcfTTM != null && w.pfcfTTM > 0 ? w.pfcfTTM.toFixed(1) + '×' : '—'}</td>
                      <td className="num-cell">{s != null ? <ScorePill score={s} /> : <span className="muted">—</span>}</td>
                      <td><span className="num tiny wl-earn"><Icon name="calendar" size={13} style={{ color: 'var(--ink-4)' }} />{formatEarnings(w.nextEarningsDate)}</span></td>
                      <td className="num-cell" style={{ width: 50 }}>
                        <button className="wl-remove" onClick={e => { e.stopPropagation(); remove(w.ticker); }} aria-label="Retirer">
                          <Icon name="trash" size={16} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ height: 50 }} />
      </div>
    </div>
  );
}

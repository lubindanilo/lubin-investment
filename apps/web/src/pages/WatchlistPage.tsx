import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WatchlistEntry } from '@lubin/shared';
import { api, ApiError } from '../lib/api.js';
import { useToast } from '../components/Toast.js';
import './WatchlistPage.css';

// ─── Tri ─────────────────────────────────────────────────────────────
type SortKey = 'default' | 'ticker' | 'pfcf' | 'score';
type SortDir = 'asc' | 'desc';
interface SortState { key: SortKey; dir: SortDir }

const SORT_STORAGE_KEY = 'li_watchlist_sort';

function loadSort(): SortState {
  try {
    const s = JSON.parse(localStorage.getItem(SORT_STORAGE_KEY) ?? '');
    if (s && ['default','ticker','pfcf','score'].includes(s.key) && ['asc','desc'].includes(s.dir)) {
      return s as SortState;
    }
  } catch {}
  return { key: 'default', dir: 'asc' };
}
function saveSort(s: SortState) {
  localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(s));
}

/** Direction par défaut selon la colonne (P/FCF asc = bon marché en premier ; Score desc = meilleur en premier). */
function defaultDirFor(key: SortKey): SortDir {
  return key === 'score' ? 'desc' : 'asc';
}

function sortItems(items: WatchlistEntry[], { key, dir }: SortState): WatchlistEntry[] {
  if (key === 'default') return items;
  const arr = [...items];
  arr.sort((a, b) => {
    let cmp = 0;
    if (key === 'ticker') {
      cmp = a.ticker.localeCompare(b.ticker);
    } else if (key === 'pfcf') {
      // null toujours en fin de liste
      if (a.pfcfTTM == null && b.pfcfTTM == null) cmp = 0;
      else if (a.pfcfTTM == null) return 1;
      else if (b.pfcfTTM == null) return -1;
      else cmp = a.pfcfTTM - b.pfcfTTM;
    } else if (key === 'score') {
      const ra = a.scoreChiffresMax > 0 ? a.scoreChiffres / a.scoreChiffresMax : 0;
      const rb = b.scoreChiffresMax > 0 ? b.scoreChiffres / b.scoreChiffresMax : 0;
      cmp = ra - rb;
    }
    return dir === 'asc' ? cmp : -cmp;
  });
  return arr;
}

export function WatchlistPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [items, setItems] = useState<WatchlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newTicker, setNewTicker] = useState('');
  const [sort, setSort] = useState<SortState>(() => loadSort());

  const sortedItems = useMemo(() => sortItems(items, sort), [items, sort]);

  function toggleSort(key: Exclude<SortKey, 'default'>) {
    setSort(prev => {
      // Si déjà actif sur cette colonne : toggle asc/desc ; sinon : direction par défaut
      const next: SortState = prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: defaultDirFor(key) };
      saveSort(next);
      return next;
    });
  }

  function resetSort() {
    const next: SortState = { key: 'default', dir: 'asc' };
    setSort(next);
    saveSort(next);
  }

  const refresh = useCallback(async (force = false) => {
    setRefreshing(true);
    try {
      const list = await api.watchlist.refresh(force);
      setItems(list);
    } catch (e) {
      toast.push('error', (e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, [toast]);

  // Charge la liste depuis le cache global + overlay prix live (GET /api/watchlist
  // recompute le P/FCF maison à partir du prix temps réel). C'est volontairement LÉGER :
  // aucun recompute de score/critères ici — uniquement la mise à jour du prix.
  // Le guard inFlight évite d'empiler 2 charges concurrentes (mount + retour onglet).
  const inFlight = useRef(false);
  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoadError(null);
    try {
      const list = await api.watchlist.list();
      setItems(list);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e : new ApiError(0, (e as Error).message));
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    // Recharge prix + P/FCF à chaque fois que l'user (re)vient sur la page :
    //   - navigation vers /watchlist → react-router remonte le composant → load()
    //   - retour sur l'onglet du navigateur → visibilitychange → load()
    // Pas de recompute de score : c'est juste un overlay prix (≈ 1 appel /quote par ticker).
    load();
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  async function addTicker() {
    const t = newTicker.trim().toUpperCase();
    if (!t) return;
    if (items.some(i => i.ticker === t)) {
      toast.push('warn', `${t} est déjà dans ta watchlist.`);
      return;
    }
    setAdding(true);
    try {
      const entry = await api.watchlist.add(t);
      setItems(prev => [...prev, entry]);
      setNewTicker('');
      toast.push('success', `${t} ajouté`);
    } catch (e) {
      toast.push('error', (e as Error).message);
    } finally {
      setAdding(false);
    }
  }

  async function remove(ticker: string) {
    try {
      await api.watchlist.remove(ticker);
      setItems(prev => prev.filter(e => e.ticker !== ticker));
    } catch (e) {
      toast.push('error', (e as Error).message);
    }
  }

  return (
    <>
      <h1 className="section-title">Watchlist</h1>
      <p className="section-sub">Tes entreprises à surveiller. P/FCF et score chiffres actualisés en temps réel.</p>

      <div className="search-wrap">
        <input
          className="input"
          placeholder="Ticker à ajouter (ex : MEDP, ADBE, QLYS)"
          value={newTicker}
          onChange={e => setNewTicker(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && addTicker()}
        />
        <button className="btn-primary" onClick={addTicker} disabled={adding || !newTicker.trim()}>
          {adding ? <><span className="spinner" /> Ajout…</> : '＋ Ajouter'}
        </button>
        <button className="btn-secondary" onClick={() => refresh(true)} disabled={refreshing} title="Rafraîchir (force)">
          {refreshing ? <span className="spinner" /> : '↻'}
        </button>
      </div>

      {loadError && (
        <div className="error-box">
          <div className="error-box-title">Impossible de charger la watchlist</div>
          <div className="error-box-hint">{loadError.userMessage}</div>
          <button className="btn-secondary" style={{ marginTop: 12 }} onClick={() => { setLoading(true); load(); }}>
            ↻ Réessayer
          </button>
        </div>
      )}

      {loading ? (
        <div className="empty-state">
          <div className="empty-state-text">Chargement…</div>
        </div>
      ) : items.length === 0 && !loadError ? (
        <div className="empty-state">
          <div className="empty-state-text">Watchlist vide</div>
          <div className="empty-state-sub">Ajoute un ticker ci-dessus, ou clique « Ajouter à la watchlist » après une analyse.</div>
        </div>
      ) : (
        <div className="wl-table-wrap">
          <table className="wl-table">
            <thead>
              <tr>
                <SortableTh label="Ticker" colKey="ticker" sort={sort} onSort={toggleSort} />
                <th>Nom</th>
                <th style={{ textAlign: 'right' }}>Prix</th>
                <SortableTh label="P/FCF" colKey="pfcf" sort={sort} onSort={toggleSort} align="right" />
                <SortableTh label="Score chiffres" colKey="score" sort={sort} onSort={toggleSort} align="right" />
                <th style={{ textAlign: 'right' }}>Prochain earnings</th>
                <th style={{ textAlign: 'right' }}>
                  {sort.key !== 'default' && (
                    <button className="wl-sort-reset" onClick={resetSort} title="Réinitialiser le tri">
                      ↺
                    </button>
                  )}
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedItems.map(e => (
                <WatchRow
                  key={e.ticker}
                  e={e}
                  onOpen={() => navigate(`/analyse/${e.ticker}`)}
                  onRemove={() => remove(e.ticker)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function SortableTh({ label, colKey, sort, onSort, align }: {
  label: string;
  colKey: Exclude<SortKey, 'default'>;
  sort: SortState;
  onSort: (k: Exclude<SortKey, 'default'>) => void;
  align?: 'left' | 'right';
}) {
  const active = sort.key === colKey;
  const arrow = active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '';
  return (
    <th
      className={`wl-th-sortable ${active ? 'active' : ''}`}
      style={{ textAlign: align ?? 'left' }}
      onClick={() => onSort(colKey)}
      title={`Trier par ${label.toLowerCase()}`}
    >
      {label}<span className="wl-sort-arrow">{arrow}</span>
    </th>
  );
}

/** Formate la date du prochain earnings (ex "28 juil. 2026"). "—" si inconnue. */
function formatEarningsDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso + 'T12:00:00Z');
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}

function WatchRow({ e, onOpen, onRemove }: { e: WatchlistEntry; onOpen: () => void; onRemove: () => void }) {
  const pfcfCls = e.pfcfTTM == null ? '' : e.pfcfTTM < 25 ? 'pass' : e.pfcfTTM < 35 ? 'warn' : 'fail';
  const pct = e.scoreChiffres / e.scoreChiffresMax;
  const scoreCls = pct >= 0.75 ? 'high' : pct >= 0.5 ? 'mid' : 'low';
  return (
    <tr onClick={onOpen}>
      <td><span className="wl-ticker">{e.ticker}</span></td>
      <td className="wl-name">{e.name}</td>
      <td style={{ textAlign: 'right' }} className="wl-price">{e.price != null ? `${e.price.toFixed(2)} ${e.currency ?? 'USD'}` : 'N/A'}</td>
      <td style={{ textAlign: 'right' }} className={`wl-pfcf ${pfcfCls}`}>
        {e.pfcfTTM != null ? e.pfcfTTM.toFixed(1) + '×' : 'N/A'}
      </td>
      <td style={{ textAlign: 'right' }} className={`wl-score ${scoreCls}`}>
        {e.scoreChiffres}/{e.scoreChiffresMax}
      </td>
      <td style={{ textAlign: 'right' }} className="wl-earnings">{formatEarningsDate(e.nextEarningsDate)}</td>
      <td style={{ textAlign: 'right' }}>
        <button
          className="wl-remove"
          onClick={ev => { ev.stopPropagation(); onRemove(); }}
          title="Retirer"
        >
          ✕
        </button>
      </td>
    </tr>
  );
}

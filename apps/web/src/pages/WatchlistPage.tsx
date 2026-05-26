import { useCallback, useEffect, useMemo, useState } from 'react';
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

  /** Version courante du schéma snapshot. Bump quand le backend change la structure
   *  (cf. SNAPSHOT_SCHEMA_SCORE_MAX dans watchlist.ts). Détecte les snapshots stockés
   *  avant un refactor pour déclencher un refresh auto. */
  const CURRENT_SCHEMA_SCORE_MAX = 10;
  const hasOutdatedSnapshots = useCallback(
    (list: WatchlistEntry[]) =>
      list.some(e => e.source != null && e.scoreChiffresMax > 0 && e.scoreChiffresMax !== CURRENT_SCHEMA_SCORE_MAX),
    [],
  );

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

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const list = await api.watchlist.list();
      setItems(list);
      // Si des snapshots ont un schéma obsolète (refactor backend), déclenche un
      // refresh silencieux en arrière-plan. /refresh re-fetch UNIQUEMENT les stales
      // (incl. schéma périmé via le check isFresh) — pas tout. Fire-and-forget : on
      // n'attend pas la fin pour afficher la liste, le re-render se fait quand
      // setItems re-fire depuis refresh().
      if (hasOutdatedSnapshots(list)) {
        void refresh(false);
      }
    } catch (e) {
      setLoadError(e instanceof ApiError ? e : new ApiError(0, (e as Error).message));
    } finally {
      setLoading(false);
    }
  }, [hasOutdatedSnapshots, refresh]);

  useEffect(() => {
    // On charge les snapshots stockés en DB une seule fois au mount.
    // Pas de re-fetch automatique des tickers (qui ferait N appels Finnhub à chaque visite) —
    // l'utilisateur déclenche un refresh manuel via le bouton ↻ s'il veut des prix frais.
    // Exception : si certains snapshots ont un schéma obsolète (cf. load() ci-dessus),
    // un refresh silencieux est déclenché pour propager le nouveau format.
    load();
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
          <div className="empty-state-icon">⏳</div>
          <div className="empty-state-text">Chargement…</div>
        </div>
      ) : items.length === 0 && !loadError ? (
        <div className="empty-state">
          <div className="empty-state-icon">⭐</div>
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

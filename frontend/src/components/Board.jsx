// frontend/src/components/Board.jsx

import { useEffect, useState } from 'react';
import { adminFetch, isAdmin } from '../adminSession.js';
import { fetchBoard, fetchMessage } from '../api.js';
import { Receipt } from './Receipt.jsx';

const PAGE_SIZE = 12;
const DEBOUNCE_MS = 300;

/**
 * @param {{ onPrint: (message: any) => void, reloadToken?: number, focusId?: string }} props
 */
export function Board({ onPrint, reloadToken = 0, focusId }) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(0);
  const [state, setState] = useState({ items: [], total: 0, loading: true, error: '' });
  const [focus, setFocus] = useState(/** @type {{ message: any, missing: boolean }} */ ({
    message: null,
    missing: false
  }));
  const [localReload, setLocalReload] = useState(0);
  const admin = isAdmin();

  /** @param {any} message */
  async function takeDown(message) {
    const preview = message.text.slice(0, 60);
    if (!window.confirm(`Togliere dalla bacheca?\n\n"${preview}"`)) return;

    try {
      await adminFetch(`/messages/${message.id}/takedown`, { method: 'POST' });
      setLocalReload((token) => token + 1);
    } catch (error) {
      setState((current) => ({ ...current, error: error.message }));
    }
  }

  // 20260902 ++ RG #deep_link_focus
  // A shared link names one message, and that message can sit on any page of the
  // board. Fetching it on its own is the only way it is guaranteed to be there.
  useEffect(() => {
    if (!focusId) {
      setFocus({ message: null, missing: false });
      return;
    }

    let cancelled = false;
    fetchMessage(focusId)
      .then((message) => {
        if (!cancelled) setFocus({ message, missing: false });
      })
      .catch(() => {
        if (!cancelled) setFocus({ message: null, missing: true });
      });

    return () => {
      cancelled = true;
    };
  }, [focusId, reloadToken, localReload]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(0);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setState((current) => ({ ...current, loading: true }));

    fetchBoard({ search: debounced, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
      .then((data) => {
        if (cancelled) return;
        setState({ items: data.items, total: data.total, loading: false, error: '' });
      })
      .catch((error) => {
        if (cancelled) return;
        setState({ items: [], total: 0, loading: false, error: error.message });
      });

    return () => {
      cancelled = true;
    };
  }, [debounced, page, reloadToken, localReload]);

  const lastPage = Math.max(0, Math.ceil(state.total / PAGE_SIZE) - 1);

  // The pinned copy above is the same message: showing it twice reads as a bug.
  const listed = focus.message
    ? state.items.filter((message) => message.id !== focus.message.id)
    : state.items;

  return (
    <section>
      {focus.message ? (
        <div className="focus">
          <div className="focus__head">
            <h2>Messaggio condiviso</h2>
            <a className="status-pill" href="#/bacheca">
              Tutta la bacheca
            </a>
          </div>
          <Receipt
            message={focus.message}
            onPrint={onPrint}
            onTakeDown={admin ? takeDown : undefined}
          />
        </div>
      ) : null}

      {focus.missing ? (
        <div className="notice" data-tone="error">
          Questo messaggio non è (più) in bacheca. Qui sotto c'è tutto il resto.
        </div>
      ) : null}

      <div className="searchbar">
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Cerca nel testo o per utente..."
          aria-label="Cerca in bacheca"
        />
      </div>

      {state.error ? (
        <div className="notice" data-tone="error">
          {state.error}
        </div>
      ) : null}

      {state.loading ? (
        <div className="board">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="skeleton" />
          ))}
        </div>
      ) : null}

      {!state.loading && listed.length === 0 && !focus.message ? (
        <p className="muted">
          {debounced ? 'Nessun messaggio corrisponde alla ricerca.' : 'La bacheca è ancora vuota.'}
        </p>
      ) : null}

      {!state.loading && listed.length > 0 ? (
        <div className="board">
          {listed.map((message) => (
            <Receipt
              key={message.id}
              message={message}
              onPrint={onPrint}
              onTakeDown={admin ? takeDown : undefined}
            />
          ))}
        </div>
      ) : null}

      {lastPage > 0 ? (
        <div className="receipt__actions" style={{ marginTop: '2rem' }}>
          <button className="ghost" onClick={() => setPage((p) => p - 1)} disabled={page === 0}>
            Precedente
          </button>
          <span className="muted">
            Pagina {page + 1} di {lastPage + 1}
          </span>
          <button
            className="ghost"
            onClick={() => setPage((p) => p + 1)}
            disabled={page >= lastPage}
          >
            Successiva
          </button>
        </div>
      ) : null}
    </section>
  );
}

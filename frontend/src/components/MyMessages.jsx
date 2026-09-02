// frontend/src/components/MyMessages.jsx

import { useEffect, useState } from 'react';
import { fetchStatuses } from '../api.js';
import { forgetAll, readMyMessageIds } from '../storage.js';

const STATUS_COPY = {
  pending: 'In moderazione',
  approved: 'In bacheca',
  rejected: 'Scartato'
};

// 20260902 ++ RG #one_at_a_time
// Almost everybody writes once. A list built for the rare graphomaniac pushed the
// board off the screen for everyone else, so this shows a single entry with dots to
// step through the others.
const MAX_SHOWN = 10;

/** @param {{ reloadToken?: number }} props */
export function MyMessages({ reloadToken = 0 }) {
  const [items, setItems] = useState(/** @type {any[]} */ ([]));
  const [index, setIndex] = useState(0);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    const ids = readMyMessageIds();
    if (ids.length === 0) {
      setItems([]);
      setChecked(true);
      return;
    }

    let cancelled = false;
    fetchStatuses(ids)
      .then((data) => {
        if (!cancelled) {
          setItems(data.items.slice(0, MAX_SHOWN));
          setIndex(0);
        }
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      })
      .finally(() => {
        if (!cancelled) setChecked(true);
      });

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  if (!checked || items.length === 0) return null;

  const current = items[Math.min(index, items.length - 1)];
  const label = STATUS_COPY[current.status] ?? current.status;

  const entry = (
    <>
      <span className="status-pill" data-status={current.status}>
        {label}
      </span>
      <span className="mine__excerpt">{current.excerpt}</span>
      {current.status === 'approved' ? <span className="mine__go">vedi in bacheca →</span> : null}
    </>
  );

  return (
    <section className="mine">
      <div className="mine__head">
        <h2>I tuoi messaggi</h2>
        <button
          className="ghost"
          onClick={() => {
            forgetAll();
            setItems([]);
          }}
        >
          Dimentica
        </button>
      </div>

      {current.status === 'approved' ? (
        <a className="mine__entry" href={`#/bacheca/${current.id}`}>
          {entry}
        </a>
      ) : (
        <div className="mine__entry">{entry}</div>
      )}

      {items.length > 1 ? (
        <div className="mine__dots" role="tablist" aria-label="I tuoi messaggi">
          {items.map((item, position) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              className="mine__dot"
              aria-selected={position === index}
              aria-label={`Messaggio ${position + 1} di ${items.length}`}
              onClick={() => setIndex(position)}
            />
          ))}
        </div>
      ) : null}

      <p className="muted">Questa lista vive solo in questo browser: niente account, niente tracciamento.</p>
    </section>
  );
}

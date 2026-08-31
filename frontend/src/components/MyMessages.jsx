// frontend/src/components/MyMessages.jsx

import { useEffect, useState } from 'react';
import { fetchStatuses } from '../api.js';
import { forgetAll, readMyMessageIds } from '../storage.js';

const STATUS_COPY = {
  pending: 'In attesa di moderazione',
  approved: 'Pubblicato in bacheca',
  rejected: 'Scartato'
};

/** @param {{ reloadToken?: number }} props */
export function MyMessages({ reloadToken = 0 }) {
  const [items, setItems] = useState(/** @type {any[]} */ ([]));
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
        if (!cancelled) setItems(data.items);
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

  return (
    <section>
      <h2>I tuoi messaggi</h2>
      <p className="muted">
        Questa lista vive solo in questo browser: niente account, niente tracciamento.
      </p>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <span className="status-pill">{STATUS_COPY[item.status] ?? item.status}</span>
          </li>
        ))}
      </ul>
      <button
        className="ghost"
        onClick={() => {
          forgetAll();
          setItems([]);
        }}
      >
        Dimentica tutto
      </button>
    </section>
  );
}

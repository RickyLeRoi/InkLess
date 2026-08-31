// frontend/src/components/PrintDialog.jsx

import { useState } from 'react';
import { requestPrint } from '../api.js';

const TIERS = [
  {
    id: 'print',
    amountCents: 100,
    title: '1,00 € — stampa + video',
    detail: 'Stampiamo il messaggio e ti mandiamo la clip della stampante che lo sputa fuori.'
  },
  {
    id: 'paper',
    amountCents: 60,
    title: '0,60 € — solo stampa',
    detail: 'Finisce su carta termica, senza video.'
  }
];

/**
 * @param {{ message: any, onClose: () => void }} props
 */
export function PrintDialog({ message, onClose }) {
  const [amountCents, setAmountCents] = useState(TIERS[0].amountCents);
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      const { redirectUrl } = await requestPrint(message.id, {
        amountCents,
        printerInstagram: handle
      });
      window.location.href = redirectUrl;
    } catch (caught) {
      setError(caught.message);
      setBusy(false);
    }
  }

  const attribution = handle
    ? `Scritto da: ${message.author} - Stampato da: @${handle.replace(/^@+/, '')}`
    : `Scritto da: ${message.author}`;

  return (
    <div className="dialog" role="dialog" aria-modal="true" aria-label="Stampa messaggio">
      <div className="dialog__panel">
        <h2>Stampalo davvero</h2>
        <p className="muted">{message.text}</p>

        {TIERS.map((tier) => (
          <button
            key={tier.id}
            type="button"
            className="tier"
            aria-pressed={amountCents === tier.amountCents}
            onClick={() => setAmountCents(tier.amountCents)}
          >
            <span>
              <strong>{tier.title}</strong>
              <span className="muted">{tier.detail}</span>
            </span>
          </button>
        ))}

        <div className="field">
          <label htmlFor="printer">Il tuo Instagram (facoltativo)</label>
          <input
            id="printer"
            type="text"
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
            placeholder="@iltuonome"
          />
          <div className="muted">Finirà sullo scontrino: {attribution}</div>
        </div>

        {error ? (
          <div className="notice" data-tone="error">
            {error}
          </div>
        ) : null}

        <div className="receipt__actions">
          <button type="button" onClick={confirm} disabled={busy}>
            {busy ? 'Attendi...' : 'Vai al pagamento'}
          </button>
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            Annulla
          </button>
        </div>
      </div>
    </div>
  );
}

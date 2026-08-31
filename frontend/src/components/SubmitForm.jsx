// frontend/src/components/SubmitForm.jsx

import { useState } from 'react';
import { submitMessage } from '../api.js';
import { rememberMessageId } from '../storage.js';

const MAX_LENGTH = 200;

const OUTCOME_COPY = {
  approved: {
    tone: 'ok',
    text: 'Pubblicato! Il tuo messaggio è già in bacheca.'
  },
  pending: {
    tone: 'neutral',
    text: 'Ricevuto. Un umano gli darà un occhio prima di pubblicarlo: ripassa più tardi, lo stato resta salvato in questo browser.'
  },
  rejected: {
    tone: 'error',
    text: 'Questo messaggio non passa il filtro. Riprova con parole diverse.'
  }
};

/** @param {{ onSubmitted: () => void }} props */
export function SubmitForm({ onSubmitted }) {
  const [text, setText] = useState('');
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(/** @type {any} */ (null));
  const [error, setError] = useState('');

  const remaining = MAX_LENGTH - text.length;
  const tooLong = remaining < 0;

  /** @param {import('react').FormEvent} event */
  async function handleSubmit(event) {
    event.preventDefault();
    if (busy || tooLong || text.trim().length === 0) return;

    setBusy(true);
    setError('');
    setOutcome(null);

    try {
      const result = await submitMessage({ text, authorInstagram: handle });
      rememberMessageId(result.id);
      setOutcome(result);
      setText('');
      onSubmitted();
    } catch (caught) {
      setError(
        caught.status === 429
          ? 'Hai scritto parecchio in poco tempo. Riprova fra un po’.'
          : caught.message
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="field">
        <label htmlFor="message">Il tuo messaggio</label>
        <textarea
          id="message"
          value={text}
          maxLength={MAX_LENGTH + 20}
          onChange={(event) => setText(event.target.value)}
          placeholder="Scrivi qualcosa che valga la carta..."
        />
        <div className="counter" data-over={tooLong}>
          {remaining} caratteri
        </div>
      </div>

      <div className="field">
        <label htmlFor="handle">Instagram (facoltativo)</label>
        <input
          id="handle"
          type="text"
          value={handle}
          onChange={(event) => setHandle(event.target.value)}
          placeholder="@iltuonome"
        />
        <div className="muted">Se lo lasci vuoto ti assegniamo un nome tipo Doe#001.</div>
      </div>

      <button type="submit" disabled={busy || tooLong || text.trim().length === 0}>
        {busy ? 'Invio...' : 'Manda in bacheca'}
      </button>

      {error ? (
        <div className="notice" data-tone="error">
          {error}
        </div>
      ) : null}

      {outcome ? (
        <div className="notice" data-tone={OUTCOME_COPY[outcome.status]?.tone ?? 'neutral'}>
          {OUTCOME_COPY[outcome.status]?.text}
          <div className="muted">Firmato come {outcome.author}</div>
        </div>
      ) : null}
    </form>
  );
}

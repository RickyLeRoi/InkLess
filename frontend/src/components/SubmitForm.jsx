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
    text: 'Questo messaggio è stato moderato. Riprova con parole diverse.'
  }
};

/**
 * 20260902 ++ RG #reason_categories
 * The category, never the word that tripped the filter: quoting it back turns the
 * form into an oracle that tells anybody exactly what to disguise. A label is enough
 * for an honest author to see what happened.
 *
 * @type {Record<string, string>}
 */
const REASON_COPY = {
  hate_speech: 'linguaggio d’odio',
  blasphemy: 'bestemmia',
  profanity: 'parolacce',
  link_spam: 'link',
  oversized: 'messaggio troppo lungo',
  ambiguous_language: 'linguaggio al limite',
  contact_details: 'contatti personali',
  phone_number: 'numero di telefono',
  character_flood: 'caratteri ripetuti',
  shouting: 'tutto maiuscolo',
  handle_hate_speech: 'nome Instagram: linguaggio d’odio',
  handle_blasphemy: 'nome Instagram: bestemmia',
  handle_profanity: 'nome Instagram: parolacce',
  handle_ambiguous: 'nome Instagram: al limite',
  handle_oversized: 'nome Instagram troppo lungo'
};

/** @param {string[]} reasons */
function describeReasons(reasons) {
  const labels = reasons.map((reason) => REASON_COPY[reason]).filter(Boolean);
  return labels.length > 0 ? [...new Set(labels)].join(', ') : '';
}

/** @param {{ onSubmitted: () => void }} props */
export function SubmitForm({ onSubmitted }) {
  const [text, setText] = useState('');
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(/** @type {any} */ (null));
  const [error, setError] = useState('');

  const remaining = MAX_LENGTH - text.length;
  const tooLong = remaining < 0;
  const reasonSummary = outcome ? describeReasons(outcome.moderation?.reasons ?? []) : '';

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
          {reasonSummary ? <div className="muted">Motivo: {reasonSummary}.</div> : null}
          <div className="muted">Firmato come {outcome.author}</div>
        </div>
      ) : null}
    </form>
  );
}

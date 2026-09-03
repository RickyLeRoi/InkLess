// frontend/src/pages/AdminPage.jsx

import { useCallback, useEffect, useState } from 'react';
import { adminFetch, isAdmin, storeAdminAuth } from '../adminSession.js';
import { maskWord } from '../lib/censor.js';

const REASON_LABELS = {
  hate_speech: 'odio',
  blasphemy: 'bestemmia',
  profanity: 'volgarita',
  ambiguous_language: 'ambiguo',
  link_spam: 'link',
  contact_details: 'contatti',
  phone_number: 'telefono',
  character_flood: 'caratteri ripetuti',
  shouting: 'urlato',
  handle_hate_speech: 'username: odio',
  handle_blasphemy: 'username: bestemmia',
  handle_profanity: 'username: volgarita',
  handle_ambiguous: 'username: ambiguo',
  appeal_requested: 'reclamo',
  llm_takedown: 'ritirato dalla bacheca dal modello'
};

/** @param {string} reason */
function labelFor(reason) {
  if (reason.startsWith('llm_failed:')) return `modello non ha risposto (${reason.split(':')[1]})`;
  if (reason.startsWith('llm:')) return `modello: ${reason.slice(4)}`;
  return REASON_LABELS[reason] ?? reason;
}

/**
 * The message laid back out as it was written, with only the words clickable. The
 * separators come from the offsets the server sends, so punctuation and spacing are
 * the author's, never reconstructed by guesswork.
 *
 * @param {{ text: string, words: any[], censored: number[], onToggle: (index: number) => void }} props
 */
function CensorableText({ text, words, censored, onToggle }) {
  const pieces = [];
  let cursor = 0;

  for (const word of words) {
    if (word.start > cursor) {
      pieces.push(<span key={`gap-${word.index}`}>{text.slice(cursor, word.start)}</span>);
    }

    const isCensored = censored.includes(word.index);
    pieces.push(
      word.censorable ? (
        <button
          key={`word-${word.index}`}
          type="button"
          className="word"
          data-censored={isCensored ? 'yes' : 'no'}
          onClick={() => onToggle(word.index)}
          title={isCensored ? 'Rimetti in chiaro' : 'Censura'}
        >
          {isCensored ? maskWord(word.word) : word.word}
        </button>
      ) : (
        // Two letters have no interior to hide: a toggle here would change nothing
        // and read as broken.
        <span key={`word-${word.index}`} className="word word--short">
          {word.word}
        </span>
      )
    );
    cursor = word.end;
  }

  pieces.push(<span key="tail">{text.slice(cursor)}</span>);
  return <p className="censorable">{pieces}</p>;
}

export function AdminPage() {
  const [authed, setAuthed] = useState(isAdmin);
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('pending');
  const [items, setItems] = useState(/** @type {any[]} */ ([]));
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [drafts, setDrafts] = useState(/** @type {Record<string, any>} */ ({}));

  const reload = useCallback(() => {
    if (!authed) return;
    // The appeals view is the rejected list with the ones nobody contested removed:
    // an appeal is a moderation reason, not a status of its own.
    const appealsOnly = status === 'appeals';
    adminFetch(`/messages?status=${appealsOnly ? 'rejected' : status}`)
      .then((data) => {
        setItems(appealsOnly ? data.items.filter(/** @param {any} item */ (item) => item.appealRequested) : data.items);
        setDrafts({});
        setError('');
      })
      .catch((caught) => {
        setError(caught.message);
        if (caught.message === 'Credenziali rifiutate') setAuthed(false);
      });
  }, [authed, status]);

  useEffect(reload, [reload]);

  if (!authed) {
    return (
      <section>
        <h2>Moderazione</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            storeAdminAuth(`Basic ${btoa(`${user}:${password}`)}`);
            setAuthed(true);
            setPassword('');
          }}
        >
          <div className="field">
            <label htmlFor="user">Utente</label>
            <input id="user" type="text" value={user} onChange={(e) => setUser(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <button type="submit">Entra</button>
        </form>
      </section>
    );
  }

  /**
   * @param {string} id
   * @param {string} action
   */
  async function act(id, action) {
    try {
      await adminFetch(`/messages/${id}/${action}`, { method: 'POST' });
      reload();
    } catch (caught) {
      setError(caught.message);
    }
  }

  /**
   * The toggles live in the panel until they are saved, so a wrong click costs a
   * second click and nothing else.
   *
   * @param {any} item
   */
  function draftOf(item) {
    return (
      drafts[item.id] ?? {
        censored: item.words
          .filter(/** @param {any} word */ (word) => word.censored)
          .map(/** @param {any} word */ (word) => word.index),
        handleCensored: item.handleCensored
      }
    );
  }

  /**
   * @param {any} item
   * @param {any} changes
   */
  function setDraft(item, changes) {
    setDrafts((current) => ({ ...current, [item.id]: { ...draftOf(item), ...changes } }));
  }

  /**
   * @param {any} item
   * @param {number} index
   */
  function toggleWord(item, index) {
    const { censored } = draftOf(item);
    setDraft(item, {
      censored: censored.includes(index)
        ? censored.filter(/** @param {number} kept */ (kept) => kept !== index)
        : [...censored, index]
    });
  }

  /** @param {any} item */
  async function publish(item) {
    const draft = draftOf(item);
    try {
      await adminFetch(`/messages/${item.id}`, {
        method: 'PATCH',
        // Always the complete state, never a delta: the server recomputes the body
        // from the original, so sending this twice changes nothing.
        body: JSON.stringify({
          censoredWords: draft.censored,
          censorHandle: draft.handleCensored,
          approve: true
        })
      });
      reload();
    } catch (caught) {
      setError(caught.message);
    }
  }

  async function escalate() {
    try {
      const outcome = await adminFetch('/moderation/escalate', { method: 'POST' });
      setNotice(
        outcome.ran
          ? `Esaminati ${outcome.examined}: ${outcome.approved} pubblicati, ${outcome.rejected} scartati, ${outcome.keptForHuman} a te, ${outcome.retryable} da riprovare.`
          : `Batch non partito: ${outcome.reason}.`
      );
      reload();
    } catch (caught) {
      setError(caught.message);
    }
  }

  return (
    <section>
      <h2>Moderazione</h2>

      <div className="searchbar">
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="pending">In attesa</option>
          <option value="approved">Approvati</option>
          <option value="rejected">Scartati</option>
          <option value="appeals">Reclami</option>
        </select>
        <button className="ghost" onClick={escalate}>
          Passa il batch al modello
        </button>
      </div>

      {error ? (
        <div className="notice" data-tone="error">
          {error}
        </div>
      ) : null}
      {notice ? <div className="notice">{notice}</div> : null}

      {items.length === 0 ? <p className="muted">Niente da moderare qui.</p> : null}

      {items.map((item) => {
        const draft = draftOf(item);
        const identity = item.authorInstagram ? `@${item.authorInstagram}` : item.author;
        const shownIdentity = draft.handleCensored
          ? identity.startsWith('@')
            ? `@${maskWord(identity.slice(1))}`
            : maskWord(identity)
          : identity;

        return (
          <div key={item.id} className="admin-row">
            <div className="muted">
              {new Date(item.createdAt).toLocaleString('it-IT')}
              {item.llmReviewed ? ' — il modello ha gia guardato' : ''}
            </div>

            {item.moderationReasons?.length ? (
              <div className="reasons">
                {item.moderationReasons.map((reason) => (
                  <span
                    key={reason}
                    className="reason-pill"
                    data-kind={reason.startsWith('handle_') ? 'handle' : 'text'}
                  >
                    {labelFor(reason)}
                  </span>
                ))}
              </div>
            ) : null}

            <div className="field">
              <label>Messaggio — clicca una parola per censurarla</label>
              <CensorableText
                text={item.originalText}
                words={item.words}
                censored={draft.censored}
                onToggle={(index) => toggleWord(item, index)}
              />
              {item.handEdited ? (
                <div className="notice" data-tone="error">
                  Questo testo era stato riscritto a mano: ora in bacheca c&apos;è
                  «{item.text}». Salvando torna all&apos;originale qui sopra, con le sole
                  parole che censuri.
                </div>
              ) : null}
            </div>

            <div className="field">
              <label>Username</label>
              <div className="handle-row">
                <span className="handle" data-censored={draft.handleCensored ? 'yes' : 'no'}>
                  {shownIdentity}
                </span>
                <button
                  className="ghost"
                  onClick={() => setDraft(item, { handleCensored: !draft.handleCensored })}
                >
                  {draft.handleCensored ? 'Rimetti in chiaro' : 'Censura'}
                </button>
              </div>
              <div className="muted">
                {item.authorInstagram ? (
                  <>
                    Non verifichiamo che esista:{' '}
                    <a
                      href={`https://instagram.com/${item.authorInstagram}`}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      controlla il profilo
                    </a>
                  </>
                ) : (
                  'Identità generata: nessun profilo Instagram dietro.'
                )}
              </div>
            </div>

            <div className="receipt__actions">
              <button onClick={() => publish(item)}>
                {item.status === 'approved' ? 'Salva' : 'Pubblica'}
              </button>
              {item.status !== 'rejected' ? (
                <button className="danger" onClick={() => act(item.id, 'reject')}>
                  Scarta
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </section>
  );
}

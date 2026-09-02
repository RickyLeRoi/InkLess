// frontend/src/pages/AdminPage.jsx

import { useCallback, useEffect, useState } from 'react';
import { adminFetch, isAdmin, storeAdminAuth } from '../adminSession.js';

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
  appeal_requested: 'reclamo'
};

/** @param {string} reason */
function labelFor(reason) {
  if (reason.startsWith('llm_failed:')) return `modello non ha risposto (${reason.split(':')[1]})`;
  if (reason.startsWith('llm:')) return `modello: ${reason.slice(4)}`;
  return REASON_LABELS[reason] ?? reason;
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

  /** @param {any} item */
  async function saveEdits(item) {
    const draft = drafts[item.id] ?? {};
    /** @type {Record<string, any>} */
    const body = {};

    if (draft.text !== undefined && draft.text !== item.text) body.text = draft.text;
    if (draft.handle !== undefined && draft.handle !== (item.authorInstagram ?? '')) {
      body.authorInstagram = draft.handle;
    }
    if (Object.keys(body).length === 0) {
      setNotice('Niente da salvare su questo messaggio.');
      return;
    }
    body.approve = true;

    try {
      await adminFetch(`/messages/${item.id}`, { method: 'PATCH', body: JSON.stringify(body) });
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

  /**
   * @param {string} id
   * @param {string} field
   * @param {string} value
   */
  function setDraft(id, field, value) {
    setDrafts((current) => ({ ...current, [id]: { ...current[id], [field]: value } }));
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
        const draft = drafts[item.id] ?? {};
        const handle = draft.handle ?? item.authorInstagram ?? '';

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
              <label htmlFor={`text-${item.id}`}>Messaggio</label>
              <textarea
                id={`text-${item.id}`}
                value={draft.text ?? item.text}
                onChange={(event) => setDraft(item.id, 'text', event.target.value)}
              />
              {item.wasCensored ? (
                <div className="muted">Originale: {item.originalText}</div>
              ) : null}
            </div>

            <div className="field">
              <label htmlFor={`handle-${item.id}`}>Username</label>
              <input
                id={`handle-${item.id}`}
                type="text"
                value={handle}
                placeholder="vuoto = anonimo Doe#NNN"
                onChange={(event) => setDraft(item.id, 'handle', event.target.value)}
              />
              <div className="muted">
                {handle ? (
                  <>
                    Non verifichiamo che esista:{' '}
                    <a
                      href={`https://instagram.com/${handle.replace(/^@+/, '')}`}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      controlla il profilo
                    </a>
                  </>
                ) : (
                  `Firmato come ${item.author}`
                )}
              </div>
            </div>

            <div className="receipt__actions">
              {item.status !== 'approved' ? (
                <button onClick={() => act(item.id, 'approve')}>Approva cosi</button>
              ) : null}
              <button className="ghost" onClick={() => saveEdits(item)}>
                Salva modifiche e pubblica
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

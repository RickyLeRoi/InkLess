// frontend/src/pages/JobPage.jsx

import { useEffect, useState } from 'react';
import { fetchJob, streamJob } from '../api.js';
import { navigate } from '../router.js';
import { readPendingKofiCode } from '../storage.js';

// 20260831 ++ RG #clip_url_must_be_safe
// The backend already refuses anything but http/https, so this is the second lock on
// the same door: React escapes text but happily renders href="javascript:...".
const CLIP_URL_SCHEMES = ['https:', 'http:'];

/** @param {unknown} value */
function safeClipUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    return CLIP_URL_SCHEMES.includes(new URL(value, window.location.href).protocol)
      ? value
      : null;
  } catch {
    return null;
  }
}

const STATUS_COPY = {
  awaiting_payment: 'In attesa del pagamento...',
  queued: 'In coda. La stampante sta per svegliarsi.',
  printing: 'Sta stampando adesso.',
  completed: 'Fatto.',
  failed: 'Qualcosa è andato storto.'
};

/** @param {{ jobId: string }} props */
export function JobPage({ jobId }) {
  const [job, setJob] = useState(/** @type {any} */ (null));
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    fetchJob(jobId)
      .then((data) => {
        if (!cancelled) setJob(data);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught.message);
      });

    // The stream carries every later transition, so the page never needs to poll.
    const stop = streamJob(jobId, (payload) => {
      if (!cancelled) setJob(payload);
    });

    return () => {
      cancelled = true;
      stop();
    };
  }, [jobId]);

  if (error) {
    return (
      <div className="notice" data-tone="error">
        {error}
      </div>
    );
  }

  if (!job) return <div className="skeleton" />;

  const clipUrl = safeClipUrl(job.videoUrl);
  const kofiCode = job.status === 'awaiting_payment' ? readPendingKofiCode(jobId) : null;

  return (
    <section>
      <h2>Stampa in corso</h2>
      <p>{STATUS_COPY[job.status] ?? job.status}</p>

      {kofiCode ? (
        <div className="notice" data-tone="ok">
          Hai pagato su Ko-fi? Incolla questo codice nel campo messaggio della donazione,
          altrimenti non riusciamo ad abbinarla da soli: <strong>{kofiCode}</strong>
        </div>
      ) : null}

      {job.includesVideo && job.status !== 'completed' && job.status !== 'failed' ? (
        <p className="muted">
          Hai pagato anche la clip: resta qui, la carichiamo appena la stampa finisce.
        </p>
      ) : null}

      {job.status === 'completed' && clipUrl ? (
        <div>
          <video src={clipUrl} controls playsInline style={{ width: '100%', maxWidth: '32rem' }} />
          <div className="receipt__actions">
            <a className="status-pill" href={clipUrl} target="_blank" rel="noreferrer noopener">
              Apri il video
            </a>
          </div>
        </div>
      ) : null}

      {job.status === 'completed' && !clipUrl ? (
        <div className="notice" data-tone="ok">
          Il messaggio è uscito dalla stampante. Niente video con questa donazione.
        </div>
      ) : null}

      {job.status === 'failed' ? (
        <div className="notice" data-tone="error">
          La stampa non è riuscita. Scrivimi su Instagram e sistemiamo.
        </div>
      ) : null}

      <button className="ghost" onClick={() => navigate('/bacheca')}>
        Torna in bacheca
      </button>
    </section>
  );
}

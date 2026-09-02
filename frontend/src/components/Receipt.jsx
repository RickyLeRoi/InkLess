// frontend/src/components/Receipt.jsx

import { useState } from 'react';
import { profileUrl } from '../lib/instagram.js';
import { shareStoryImage } from '../lib/storyImage.js';
import { QrCode } from './QrCode.jsx';

const SHARE_TARGETS = [
  {
    id: 'threads',
    label: 'Threads',
    href: (text, url) =>
      `https://www.threads.net/intent/post?text=${encodeURIComponent(`${text} ${url}`)}`
  },
  {
    id: 'x',
    label: 'X',
    href: (text, url) =>
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    href: (text, url) => `https://api.whatsapp.com/send?text=${encodeURIComponent(`${text} ${url}`)}`
  }
];

const canShareNatively = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

/**
 * @param {{ createdAt: string }} message
 */
function formatDate(createdAt) {
  return new Date(createdAt).toLocaleString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * A link to this exact message rather than to the board: the board is paginated, so
 * a generic link buries whatever was being shared.
 *
 * @param {string} id
 */
function permalinkOf(id) {
  return `${window.location.origin}/#/bacheca/${id}`;
}

/**
 * @param {{
 *   message: any,
 *   onPrint?: (message: any) => void,
 *   onTakeDown?: (message: any) => void,
 *   footer?: string
 * }} props
 */
export function Receipt({ message, onPrint, onTakeDown, footer }) {
  const [story, setStory] = useState({ busy: false, note: '' });

  const profile = message.authorInstagram ? profileUrl(message.authorInstagram) : null;

  const shareUrl = permalinkOf(message.id);
  const shareText = `"${message.text}" — ${message.author} su InkLess`;

  async function shareToInstagram() {
    setStory({ busy: true, note: '' });
    try {
      const outcome = await shareStoryImage(message);
      setStory({
        busy: false,
        note: outcome === 'shared' ? '' : 'Immagine salvata: aprila su Instagram come Storia.'
      });
    } catch (error) {
      // Dismissing the OS share sheet reports an abort. That is a choice, not a failure.
      setStory({
        busy: false,
        note: error.name === 'AbortError' ? '' : "Non sono riuscito a generare l'immagine."
      });
    }
  }

  /**
   * 20260902 ** RG #whatsapp_kept_only_the_url
   * The native sheet gets text and url glued into a single `text`, with no `url`
   * field at all. Handed both, WhatsApp keeps the url and throws the message away —
   * which is why sharing looked right from the desktop links and arrived stripped
   * from a phone.
   */
  async function shareNatively() {
    try {
      await navigator.share({ text: `${shareText} ${shareUrl}` });
      setStory({ busy: false, note: '' });
    } catch (error) {
      if (error.name === 'AbortError') return;
      setStory({ busy: false, note: 'Condivisione non riuscita, riprova.' });
    }
  }

  return (
    <article className="receipt">
      <div className="receipt__head">InkLess</div>
      <hr className="receipt__rule" />

      <p className="receipt__body">{message.text}</p>

      <hr className="receipt__rule" />
      <div className="receipt__meta">
        <span>
          {profile ? (
            <a href={profile} target="_blank" rel="noreferrer noopener">
              {message.author}
            </a>
          ) : (
            message.author
          )}
        </span>
        <span>{formatDate(message.createdAt)}</span>
      </div>

      <div className="receipt__meta">
        <span>Stampato {message.printCount} {message.printCount === 1 ? 'volta' : 'volte'}</span>
      </div>

      {profile ? (
        <div className="receipt__qr">
          <QrCode value={profile} label={`Profilo Instagram di ${message.author}`} />
          <span>
            Inquadra o tocca{' '}
            <a href={profile} target="_blank" rel="noreferrer noopener">
              {message.author}
            </a>{' '}
            per aprire il profilo Instagram.
          </span>
        </div>
      ) : null}

      {footer ? <div className="receipt__foot">{footer}</div> : null}

      <div className="receipt__actions">
        {onPrint ? <button onClick={() => onPrint(message)}>Stampa questo</button> : null}
        {onTakeDown ? (
          <button className="danger" onClick={() => onTakeDown(message)}>
            Rimuovi
          </button>
        ) : null}
        <button className="ghost" onClick={shareToInstagram} disabled={story.busy}>
          {story.busy ? 'Genero...' : 'Instagram'}
        </button>

        {canShareNatively ? (
          <button className="ghost" onClick={shareNatively}>
            Condividi
          </button>
        ) : (
          SHARE_TARGETS.map((target) => (
            <a
              key={target.id}
              className="status-pill"
              href={target.href(shareText, shareUrl)}
              target="_blank"
              rel="noreferrer noopener"
            >
              {target.label}
            </a>
          ))
        )}
      </div>

      {story.note ? <p className="muted receipt__hint">{story.note}</p> : null}
    </article>
  );
}

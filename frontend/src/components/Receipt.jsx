// frontend/src/components/Receipt.jsx

const SHARE_TARGETS = [
  { id: 'threads', label: 'Threads', href: (text, url) => `https://www.threads.net/intent/post?text=${text}%20${url}` },
  { id: 'x', label: 'X', href: (text, url) => `https://twitter.com/intent/tweet?text=${text}&url=${url}` },
  { id: 'whatsapp', label: 'WhatsApp', href: (text, url) => `https://wa.me/?text=${text}%20${url}` }
];

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
 * @param {{
 *   message: any,
 *   onPrint?: (message: any) => void,
 *   onTakeDown?: (message: any) => void,
 *   footer?: string
 * }} props
 */
export function Receipt({ message, onPrint, onTakeDown, footer }) {
  const profileUrl = message.authorInstagram
    ? `https://instagram.com/${message.authorInstagram}`
    : null;

  const shareUrl = encodeURIComponent(`${window.location.origin}/#/bacheca`);
  const shareText = encodeURIComponent(`"${message.text}" — ${message.author} su InkLess`);

  return (
    <article className="receipt">
      <div className="receipt__head">InkLess</div>
      <hr className="receipt__rule" />

      <p className="receipt__body">{message.text}</p>

      <hr className="receipt__rule" />
      <div className="receipt__meta">
        <span>
          {profileUrl ? (
            <a href={profileUrl} target="_blank" rel="noreferrer noopener">
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

      {footer ? <div className="receipt__foot">{footer}</div> : null}

      <div className="receipt__actions">
        {onPrint ? <button onClick={() => onPrint(message)}>Stampa questo</button> : null}
        {onTakeDown ? (
          <button className="danger" onClick={() => onTakeDown(message)}>
            Rimuovi
          </button>
        ) : null}
        {SHARE_TARGETS.map((target) => (
          <a
            key={target.id}
            className="status-pill"
            href={target.href(shareText, shareUrl)}
            target="_blank"
            rel="noreferrer noopener"
          >
            {target.label}
          </a>
        ))}
      </div>
    </article>
  );
}

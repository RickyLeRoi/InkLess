// frontend/src/components/PrintDialog.jsx

import { useState } from 'react';
import { requestPrint } from '../api.js';
import { navigate } from '../router.js';
import { rememberPendingKofiCode } from '../storage.js';

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
  // 20260903 ++ RG #kofi_code_before_redirect
  // Set once requestPrint comes back with a Ko-fi checkout, so the payer sees the code
  // they must carry into Ko-fi's message field before this dialog sends them there —
  // rather than after, when the Ko-fi tab has already grabbed their attention.
  const [kofiStep, setKofiStep] = useState(/** @type {{ jobId: string, redirectUrl: string, code: string } | null} */ (null));

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      const { jobId, redirectUrl, redirectMode, paymentRef } = await requestPrint(message.id, {
        amountCents,
        printerInstagram: handle
      });

      // 20260903 ++ RG #kofi_has_no_return_url
      // Stripe/PayPal bring the browser back on their own once paid, so a full
      // navigation to their hosted checkout is fine. Ko-fi never does — there is no
      // return URL to give it — so instead the payment opens in another tab, and this
      // dialog switches to a confirmation step showing paymentRef before actually
      // opening it, so the payer can carry the code into Ko-fi's message field.
      if (redirectMode === 'newTab') {
        if (paymentRef) rememberPendingKofiCode(jobId, { code: paymentRef, redirectUrl });
        setBusy(false);
        setKofiStep({ jobId, redirectUrl, code: paymentRef });
      } else {
        window.location.href = redirectUrl;
      }
    } catch (caught) {
      setError(caught.message);
      setBusy(false);
    }
  }

  // 20260903 ++ RG #kofi_dialog_must_close
  // Without onClose() here, App.jsx keeps this dialog mounted as an overlay on top of
  // the JobPage that navigate() reveals underneath — stuck on its own busy state
  // forever, since nothing else ever clears it.
  function openKofi() {
    window.open(kofiStep.redirectUrl, '_blank', 'noopener');
    navigate(`/job/${kofiStep.jobId}`);
    onClose();
  }

  if (kofiStep) {
    return (
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Codice Ko-fi">
        <div className="dialog__panel">
          <h2>Prima di andare su Ko-fi</h2>
          <p>
            Scrivi questo codice nel campo <strong>messaggio</strong> della donazione, altrimenti
            non riusciamo ad abbinarla da soli:
          </p>
          <p className="notice" data-tone="ok">
            <strong>{kofiStep.code}</strong>
          </p>
          <div className="receipt__actions">
            <button type="button" onClick={openKofi}>
              Apri Ko-fi e paga
            </button>
            <button type="button" className="ghost" onClick={onClose}>
              Annulla
            </button>
          </div>
        </div>
      </div>
    );
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

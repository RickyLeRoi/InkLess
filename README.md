# InkLess

**Una bacheca digitale che stampa davvero.**

Lasci un messaggio da 200 caratteri. Se passa la moderazione finisce su una bacheca pubblica
disegnata come uno scontrino. Da lì chiunque, con una donazione da mezzo euro, può farlo uscire
fisicamente da una stampante termica a casa mia — e con un euro si porta a casa anche il video
della stampa.

Niente account, niente login, niente OAuth. Solo un messaggio e della carta.

```
        ╔══════════════════════════════╗
        ║          I N K L E S S       ║
        ╟──────────────────────────────╢
        ║  Ho scritto questa frase su  ║
        ║  internet e adesso esiste su ║
        ║  un pezzo di carta a casa di ║
        ║  uno che non conosco.        ║
        ╟──────────────────────────────╢
        ║  @tizio          31/08/2026  ║
        ║  Stampato 3 volte            ║
        ║           ▄▄▄▄▄ ▄ ▄▄▄▄▄      ║
        ║           █ ▄ █ ▀▄█ ▄ █      ║
        ║           █▄▄▄█ █ █▄▄▄█      ║
        ╟──────────────────────────────╢
        ║   INKLESS.GIORDANORICCARDO.IT║
        ╚══════════════════════════════╝
```

---

## Come funziona

1. **Scrivi.** Massimo 200 caratteri, handle Instagram facoltativo. Chi non lo lascia riceve
   un'identità generata (`Doe#001`, progressiva).
2. **Modera.** Un filtro regex sincrono decide subito sui casi netti; i dubbi vengono valutati
   a lotti da un LLM locale, e quel che resta ambiguo finisce su un umano.
3. **Pubblica.** I messaggi approvati compaiono in bacheca, con ricerca full-text, contatore
   di stampe, QR al profilo dell'autore e condivisione social.
4. **Stampa.** Chi paga può accreditarsi a sua volta: lo scontrino esce con
   *"Scritto da: @autore — Stampato da: @stampatore"*, che collassa in
   *"Scritto e stampato da: @autore"* quando coincidono.

| Donazione | Cosa succede |
|---|---|
| **> 0,50 €** | il messaggio entra in coda e viene stampato su carta termica |
| **≥ 1,00 €** | oltre alla stampa, una webcam puntata sulla stampante registra la clip |

Chi paga resta sulla pagina e riceve l'aggiornamento in tempo reale via SSE: coda, stampa in
corso, clip pronta.

---

## Architettura

Tre nodi, tre responsabilità, nessuna porta aperta sul router.

```
        Internet
           │
           │  (solo traffico in uscita: cloudflared apre lui il tunnel)
    ┌──────┴───────┐
    │  Cloudflare  │   giordanoriccardo.it
    └──────┬───────┘
           │
  ═════════╪═══════════════ LAN casalinga ══════════════════
           │
   ┌───────┴────────────────────┐         ┌──────────────────────┐
   │  Home server  .248         │  SSE +  │  Raspberry Pi 4  .254│
   │  Dell OptiPlex, Docker     │◄───────►│  Docker              │
   │                            │  POST   │                      │
   │  Fastify + SQLite          │         │  demone Python       │
   │  moderazione, coda, paghe  │         │  stampante + webcam   │
   └────────────────────────────┘         └──────────────────────┘
      reti: backend_net, hw_net              mai esposto a internet
```

**Frontend** — React su Vite. Build statico: landing, bacheca, dashboard di moderazione.

**Backend** — Node.js + Fastify + SQLite (`node:sqlite` built-in). Architettura esagonale:
il dominio non conosce né Fastify, né SQLite, né la stampante. Possiede API pubblica e admin,
pipeline di moderazione, donazioni, webhook e coda di stampa.

**Nodo hardware** — demone Python sul RPi 4. Consuma la coda, pilota la stampante ESC/POS
e la webcam V4L2, carica le clip su storage S3-compatibile.

### Scelte che vale la pena conoscere

- **SSE, non WebSocket.** Il push è unidirezionale e le risposte del demone sono normali POST.
  Zero dipendenze aggiunte da entrambi i lati, ed `EventSource` è nativo nel browser.
- **La coda vive nella tabella `print_jobs`, non nello stream.** Un lavoro pagato mentre il RPi
  è spento non si perde: alla riconnessione il demone rilegge `/internal/jobs/queued` e recupera.
  La deduplica per job id evita che il recupero ristampi quel che è già uscito.
- **I soldi sono centesimi interi, ovunque.** Le soglie stanno esattamente a 0,50 e 1,00 €, e un
  confronto tra float non è la cosa su cui scommettere una feature a pagamento.
- **Rimuovere dalla bacheca è un cambio di stato, mai una DELETE.** I lavori di stampa
  referenziano i messaggi in cascata: cancellare una riga distruggerebbe il registro di stampe
  che qualcuno ha davvero pagato.
- **Stripe è parlato via REST + HMAC, senza SDK.** Due chiamate non giustificavano l'albero di
  dipendenze, e PayPal resta un'alternativa viva: nel dominio non entra vocabolario Stripe.

---

## Avvio rapido

**Serve Node 22.** Il backend usa `node:sqlite`, che prima della 22.5 non esiste.

```bash
# backend → :3000
cd backend && nvm use && npm install
npm run dev

# frontend → :5173, con proxy su /api
cd frontend && npm install
npm run dev

# demone hardware — gira su un portatile senza nulla attaccato
cd hardware
PYTHONPATH=src PRINTER_KIND=fake python3 -m inkless
```

Il demone parte con stampante, webcam e storage **finti**: il flusso completo è percorribile
a hardware spento. Si passa al reale con `PRINTER_KIND=escpos`, `RECORDER_KIND=ffmpeg`,
`UPLOADER_KIND=s3`.

### Test

```bash
cd backend   && npm test && npm run typecheck   # 155 test, typecheck a zero errori
cd hardware  && python3 -m unittest discover -s tests   # 13 test
```

### Deploy

```bash
docker compose -f docker/docker-compose.homeserver.yml up -d   # sulla VM .248
docker compose -f docker/docker-compose.rpi.yml up -d          # sul RPi .254
```

Configurazione: copia [.env.example](.env.example) in `.env` e riempilo. Nessun segreto è
hardcoded, e `.env` è ignorato da git.

---

## API

| Metodo | Rotta | Cosa fa |
|---|---|---|
| `GET` | `/health` | stato del servizio e se il nodo hardware è vivo |
| `POST` | `/api/messages` | invio di un messaggio (rate-limited) |
| `GET` | `/api/messages` | bacheca, con ricerca full-text e paginazione |
| `GET` | `/api/messages/status` | stato dei messaggi il cui id sta nel `localStorage` del visitatore |
| `POST` | `/api/messages/:id/print` | apre la donazione per una stampa |
| `GET` | `/api/jobs/:id` | stato di un lavoro di stampa |
| `GET` | `/api/jobs/:id/stream` | aggiornamenti live del lavoro (SSE) |
| `POST` | `/api/payments/callback` | webhook del provider di pagamento |

**Admin** — sotto `/api/admin`, tutte protette da Basic auth lato server:
elenco della coda, `approve`, `reject`, `takedown`, `PATCH` per correggere testo o handle,
e `moderation/escalate` per forzare un lotto LLM.

**Interne** — sotto `/internal`, solo LAN e solo con token condiviso: recupero della coda,
stream dei lavori, e le callback `start` / `complete` / `fail` del demone.

---

## Moderazione

Due stadi, deliberatamente non entrambi sul percorso di invio.

**Regex, sincrona.** Gira su ogni invio, sul corpo del messaggio *e* sull'handle Instagram —
l'handle viene pubblicato e stampato, quindi è contenuto a tutti gli effetti. Quattro livelli:
rifiuto secco, bestemmie (coppie composizionali), volgarità, e sospetti che vanno a un umano.
La blocklist contiene solo grafie da dizionario: è l'adapter che prima ripiega leetspeak,
accenti, omoglifi, forme fullwidth, lettere ripetute e separatori.

**LLM, a lotti.** Parte solo quando si è accumulata abbastanza roba che il modello non ha mai
visto. Approva il chiaramente innocuo, rifiuta il chiaramente brutto, e marca il resto perché
il lotto successivo non lo riguardi. Funziona con Ollama o con qualsiasi runtime che parli
`chat/completions` (LM Studio, vLLM, llama.cpp, OpenRouter).

La distinzione che conta: un messaggio che il modello **ha giudicato incerto** finisce
all'admin, mentre uno che il modello **non è riuscito a giudicare** (timeout, servizio giù,
risposta illeggibile) resta non marcato apposta, così un lotto successivo ci riprova.
Confonderli significherebbe scaricare l'intero arretrato su un umano al primo disservizio.

**L'handle fa scalare a revisione, ma non rifiuta mai da solo.** Cercare sottostringhe dentro
un token di 30 caratteri è abbastanza grezzo da colpire cognomi veri, e l'handle è l'unico campo
che un admin può semplicemente riscrivere.

---

## Sicurezza

Non sono preferenze, sono il punto della topologia.

- **Ingresso zero-trust** — nessuna porta aperta sul router domestico. Tutto il traffico pubblico
  passa da un tunnel Cloudflare che si apre dall'interno.
- **Reti Docker isolate** — `frontend_net`, `backend_net`, `hw_net`; ogni container entra solo
  in quelle che gli servono, senza `privileged`, con `no-new-privileges` e filesystem in sola
  lettura dove possibile.
- **Il Raspberry non vede internet.** Parla solo con il backend, su un segmento LAN dedicato.
- **Rate limiting** — 3 messaggi/ora per IP, più un tetto sulle richieste di stampa.
- **Sanitizzazione degli input** contro XSS, su client e server, per testo e handle.
- **Segreti solo via `.env`** — chiavi di pagamento, credenziali admin, token hardware.

---

## Stato

Backend, frontend, demone hardware e configurazione Docker sono implementati e verdi:
155 test sul backend, 13 sul demone, typecheck pulito, flusso end-to-end percorso dal messaggio
alla carta con gli adapter finti.

Resta da fare il deploy del frontend, la consegna della clip come post Instagram, l'adapter
PayPal, dei test end-to-end, e il collaudo su una stampante e una webcam che **non sono ancora
state comprate**. Il dettaglio sta in [PLAN.md](PLAN.md).

## Documenti

| File | A cosa serve |
|---|---|
| [PLAN.md](PLAN.md) | stato reale, struttura dei moduli, decisioni di stack, cosa manca |
| [CLAUDE.md](CLAUDE.md) | contesto per gli agenti che lavorano sul codice |
| [prompt.txt](prompt.txt) | il brief originale, così com'è nato |

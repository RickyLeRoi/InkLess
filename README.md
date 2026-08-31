# InkLess

**Una bacheca digitale che stampa davvero.**

Lasci un messaggio da 200 caratteri. Se passa la moderazione finisce su una bacheca pubblica
disegnata come uno scontrino. Da lì chiunque, con una donazione da mezzo euro, può farlo uscire
fisicamente da una stampante termica — e con un euro si porta a casa anche il video della stampa.

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
2. **Modera.** Un primo filtro automatico decide subito sui casi netti. Tutto ciò che resta
   ambiguo finisce sotto gli occhi di una persona, non di un algoritmo.
3. **Pubblica.** I messaggi approvati compaiono in bacheca, con ricerca full-text, contatore
   di stampe, QR al profilo dell'autore e condivisione social.
4. **Stampa.** Chi paga può accreditarsi a sua volta: lo scontrino esce con
   *"Scritto da: @autore — Stampato da: @stampatore"*, che collassa in
   *"Scritto e stampato da: @autore"* quando coincidono.

| Donazione | Cosa succede |
|---|---|
| **> 0,50 €** | il messaggio entra in coda e viene stampato su carta termica |
| **≥ 1,00 €** | oltre alla stampa, una webcam puntata sulla stampante registra la clip |

Chi paga resta sulla pagina e riceve l'aggiornamento in tempo reale: coda, stampa in corso,
clip pronta.

---

## Stack

| | |
|---|---|
| **Frontend** | React su Vite — build statico, design responsive, estetica scontrino |
| **Backend** | Node.js 22 + Fastify + SQLite, architettura esagonale (ports & adapters) |
| **Nodo hardware** | demone Python per stampante termica ESC/POS e webcam |
| **Infrastruttura** | Docker Compose |

Il dominio non conosce né il framework HTTP, né il database, né la stampante: sono tutti
adapter dietro una porta. Il che, tra le altre cose, è la ragione per cui il progetto è stato
sviluppabile per intero prima che la stampante esistesse.

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
a hardware spento, dal messaggio alla carta. Gli adapter reali si attivano da configurazione.

### Test

```bash
cd backend   && npm test && npm run typecheck
cd hardware  && python3 -m unittest discover -s tests
cd e2e       && npm test    # avvia backend e demone davvero, e segue il flusso fino alla carta
```

### Configurazione

Copia [.env.example](.env.example) in `.env` e riempilo. Nessun segreto è hardcoded, e `.env`
non entra in git.

Per il deploy in produzione — home server e nodo hardware — c'è [INSTALL.md](INSTALL.md).

---

## Moderazione

Due stadi, deliberatamente non entrambi sul percorso di invio. Un filtro automatico sincrono
gira su ogni messaggio; quello che non è né chiaramente innocuo né chiaramente inaccettabile
viene valutato a lotti da un modello linguistico locale — e ciò che resta incerto viene messo
in coda per una revisione umana, con l'indicazione del perché.

La moderazione guarda sia il testo sia l'handle Instagram: l'handle viene pubblicato e stampato,
quindi è contenuto a tutti gli effetti.

---

## Sicurezza

Il progetto nasce attorno a un vincolo: **nessuna porta aperta sul router di casa**. Tutto il
traffico pubblico entra da un tunnel che si apre dall'interno, i container sono segmentati per
ruolo e girano senza privilegi, il nodo che pilota l'hardware non è raggiungibile da internet,
e ogni segreto vive solo in `.env`. Rate limiting sugli endpoint pubblici e sanitizzazione
degli input su client e server completano il quadro.

---

## Stato

Backend, frontend, demone hardware e configurazione Docker sono implementati e verdi: test
automatici su backend e demone, typecheck pulito, flusso end-to-end percorso dal messaggio alla
carta con gli adapter simulati.

Manca il collaudo su una stampante termica e una webcam che **non sono ancora state comprate**.
Quando arriveranno, l'unica cosa da cambiare sarà una variabile d'ambiente.

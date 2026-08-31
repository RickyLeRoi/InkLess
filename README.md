# Documento di Specifica Progetto: CartaCanta / InkLess
**Da fornire come system prompt / contesto architetturale a Claude (o altri LLM) per lo sviluppo.**

---

## 1. Visione d'Insieme
Il progetto, temporaneamente chiamato **CartaCanta** o **InkLess**, è una piattaforma web ibrida (digitale/fisica) che permette agli utenti di lasciare brevi messaggi su una bacheca digitale e, tramite una piccola donazione, stamparli fisicamente su una stampante termica situata a casa dell'amministratore.

**Obiettivo per Claude:** Sviluppare l'intera architettura software (Frontend, Backend, Script Hardware e configurazioni Docker), tenendo conto che l'utente è uno sviluppatore esperto e richiede codice pulito, modulare e focalizzato sulla sicurezza.

---

## 2. Architettura e Infrastruttura
- **Hardware:** 
  - Home Server principale: **DELL OptiPlex**, vm 248 con Docker per eseguire i container (Backend, DB, Frontend, LLM locale).
  - Hardware Node: **Raspberry Pi 4 (8GB)** delegato alla gestione fisica della Stampante Termica e della Webcam.
- **Rete e Sicurezza (Fondamentale):**
  - Dominio gestito su Aruba, interfacciato con **Cloudflare Tunnels (cloudflared)**.
  - Nessuna porta aperta sul router domestico. Il tunnel punta direttamente al container del reverse proxy/backend sul RPi 4, blindando la rete LAN.
  - I container devono girare su reti Docker isolate (`frontend_net`, `backend_net`, `hw_net`).
- **Stack Tecnologico Richiesto:** 
  - **Backend:** Node.js (Express o Fastify) - *Linguaggio preferito dal committente per questa logica.*
  - **Hardware/Edge (RPi 4):** Python o Node.js (Python è consigliato per l'interfacciamento con OpenCV/Cam e librerie ESC/POS per la stampante termica).
  - **Frontend:** A discrezione (React/Vue o Vanilla JS ben strutturato), con design responsive.
  - **Database:** SQLite o PostgreSQL (leggero, su container).

---

## 3. Specifiche Funzionali: Frontend (Lato Utente)
Il sito non prevede alcuna registrazione o login tramite social (No OAuth).

### 3.1. Pagina Principale (Landing & Invio)
- **Sezione Info:** Breve spiegazione del progetto.
- **Anteprima Bacheca:** Un carousel che mostra gli ultimi messaggi approvati.
- **Form di Invio:** 
  - Campo di testo per il messaggio (**Max 200 caratteri**).
  - Campo opzionale: ID Instagram dell'autore. (Se vuoto, assegnare un ID generico es. `Doe#001`).
- **Logica di Stato (Local Storage):** Quando un utente invia un messaggio, l'ID univoco del messaggio viene salvato nel `localStorage` del browser. Al suo ritorno, l'interfaccia legge il localStorage e mostra lo stato del messaggio (In attesa, Approvato, Scartato).

### 3.2. Pagina Bacheca Digitale (Pubblica)
- **Layout Grafico:** Stile "scontrino fiscale" / stampa su carta termica (monocromatico, font monospace, bordi seghettati).
- **Contenuto del Messaggio:** Testo del messaggio, ID Instagram dell'autore (con link o QR code generato al profilo IG).
- **Funzionalità di Ricerca:** Barra di ricerca testuale (per contenuto del messaggio o per ID utente).
- **Interazioni sui Messaggi:** 
  - Contatore che indica quante volte il messaggio è stato stampato fisicamente.
  - Tasti per la **Condivisione Social** (Instagram, Threads, X, ecc.).
  - **Pulsante "Stampa questo messaggio"**.

### 3.3. Flusso di Donazione e Stampa (Checkout)
Quando un utente sceglie di stampare un messaggio (suo o di altri):
- Può inserire il proprio ID Instagram (Es. *"Scritto da: @autore - Stampato da: @stampatore"* o *"Scritto e stampato da: @autore"*).
- **Tier 1 (Donazione > 0.50€):** Il messaggio viene accodato per la stampa fisica.
- **Tier 2 (Donazione >= 1.00€):** Oltre alla stampa, viene registrata una **clip video** (tramite la webcam puntata sulla stampante termica). 
- **Consegna Video:** L'utente viene invitato ad attendere sulla pagina. Il backend elabora la coda di stampa e, appena completato, invia via WebSocket/Polling la clip video o la carica su un profilo Instagram taggando l'utente.

---

## 4. Specifiche Funzionali: Backend e Moderazione (Admin)

### 4.1. Pagina di Moderazione (Protetta)
- Dashboard accessibile solo all'admin (tramite auth robusta, es. JWT/Basic Auth con credenziali iniettate via ENV).
- Azioni possibili sui messaggi in coda: **Approva, Scarta, Modifica/Censura parziale**.

### 4.2. Automoderazione (AI / Regex)
- Il sistema deve implementare una pipeline di pre-validazione:
  1. Filtro Regex per bloccare immediatamente parolacce o link spam.
  2. (Opzionale/Avanzato) Integrazione con un **piccolo LLM locale** (es. via Ollama sul RPi 4) per valutare l'innocuità del testo.
- I messaggi considerati innocui vengono **auto-approvati** e mandati in bacheca. Quelli dubbi restano in attesa di moderazione manuale.

---

## 5. Vincoli di Sicurezza da Rispettare (Istruzioni Cruciali per Claude)
1. **Zero-Trust Network:** Nessuna esposizione diretta. Tutte le API passano per il Cloudflare Tunnel.
2. **Protezione API e Rate Limiting:** Implementare rate-limiting aggressivo su Node.js per prevenire spam di messaggi (es. max 3 messaggi/ora per IP) e DDoS sul form di donazione.
3. **Validazione Input:** Tutti gli input (testo, IG ID) devono essere severamente sanitizzati contro XSS (sia lato client che server).
4. **Isolamento LAN:** Il container Node.js sull'homeserver comunica con lo script Python sul RPi 4 solo tramite una rete locale segregata (es. WebSocket interna o MQTT), senza che il RPi 4 sia esposto a Internet.
5. **Gestione Segreti:** Webhook secrets (Stripe/PayPal per donazioni), password e token devono essere gestiti esclusivamente tramite file `.env` (non hardcoded).

---

## 6. Variabili Incognite (Da configurare in seguito)
*Nota per lo sviluppatore:* Le seguenti informazioni non sono attualmente disponibili e dovranno essere configurate tramite variabili d'ambiente (.env):
- **Indirizzi IP interni:** 
  IP della VM con Docker (Home Server): 192.168.1.248
  IP del RPi 4 (Hardware Node): 192.168.1.254
  bridge della rete Docker: ?
- **Nomi a Dominio:** Dominio ufficiale Aruba / endpoint Cloudflare: giordanoriccardo.it
- **Modello Stampante Termica:** Da definire (probabile interfaccia USB/Seriale con ESC/POS).
- **Modello Webcam:** Da definire (probabile interfaccia USB/V4L2).
- **Provider di Pagamento:** **Stripe** (deciso). PayPal resta un'alternativa non scartata, quindi l'integrazione va tenuta dietro un'astrazione neutra rispetto al provider.

---
**Istruzione Finale per Claude:** Utilizza questo README come base architetturale. Inizia strutturando il boilerplate per il backend in Node.js (con Express/Fastify e SQLite), proponi un layout frontend (HTML/CSS/JS) che simuli lo scontrino, e prepara gli script Python (RPi 4) per simulare l'ascolto della coda di stampa e registrazione video.

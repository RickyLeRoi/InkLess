# Installazione

Guida operativa per mettere InkLess in produzione: **home server** (backend in Docker) e
**nodo hardware** (demone Python sul Raspberry Pi).

> Tutti gli indirizzi in questa guida sono segnaposto — `<home-server-ip>`, `<dominio>`.
> I valori veri vivono solo nei file `.env`, che non entrano in git.

---

## 0. Prerequisiti

| Dove | Cosa serve |
|---|---|
| Home server | Docker Engine + plugin Compose, `git` |
| Raspberry Pi | Raspberry Pi OS **64-bit** (Lite basta e avanza), `git` |
| Cloudflare | il dominio delegato, e accesso a Zero Trust per creare il tunnel |
| Stripe **o** PayPal | Stripe: chiave segreta e secret del webhook. PayPal: client id, client secret e webhook id |
| Storage clip | un bucket S3-compatibile (facoltativo: senza, le clip restano locali) |

### Sul Raspberry non serve Docker

Il demone è un **client puro**: apre uno stream verso il backend e risponde con delle POST.
Non ascolta su nessuna porta. Gira come servizio systemd in un virtualenv, e basta.

Docker sul Pi aggiungerebbe solo attrito dove fa più male: i device USB vengono legati
all'avvio del container, quindi una stampante staccata e riattaccata richiede un restart,
mentre con una regola udev il demone la ritrova da solo.

**Non devi sostituire Raspbian.** Raspberry Pi OS è il sistema giusto. Verifica solo che sia
a 64 bit:

```bash
uname -m     # aarch64 = ok. armv7l = installazione a 32 bit
```

Se risponde `armv7l` vale la pena riscrivere la SD con l'immagine 64-bit Lite: l'encoder
hardware `h264_v4l2m2m` e gli 8 GB di RAM li sfrutti davvero solo lì. È l'unico caso in cui
tocca reinstallare.

---

## 1. I due file `.env`

**Due file distinti, non uno copiato due volte.** Il Pi non ha nessun motivo di conoscere le
chiavi Stripe, la password dell'admin o il token del tunnel: se un giorno quel nodo viene
compromesso, deve poter fare danni solo alla stampante.

Genera i segreti condivisi una volta sola:

```bash
openssl rand -hex 32     # HARDWARE_TOKEN — lo stesso su entrambe le macchine
openssl rand -base64 24  # ADMIN_PASSWORD
```

### `.env` sull'home server

Parti da [.env.example](.env.example) e compila **tutto**. In particolare:

| Variabile | Valore |
|---|---|
| `NODE_ENV` | `production` — sotto questo valore il backend **rifiuta di partire** senza credenziali admin e token hardware, e vieta il provider di pagamento finto |
| `BACKEND_BIND_IP` | l'IP LAN dell'home server, così il Pi lo raggiunge. Lasciato a `127.0.0.1` la porta non esce dalla macchina |
| `PUBLIC_BASE_URL` / `CORS_ORIGIN` | `https://<dominio>` |
| `ADMIN_USER` / `ADMIN_PASSWORD` | credenziali della dashboard di moderazione |
| `HARDWARE_TOKEN` | il segreto generato sopra |
| `CLOUDFLARE_TUNNEL_TOKEN` | dal passo 2 |
| `PAYMENT_PROVIDER` | `stripe` o `paypal`. In produzione `fake` viene rifiutato |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | dalla dashboard Stripe, solo con `PAYMENT_PROVIDER=stripe` |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | dall'app REST sul developer dashboard, solo con `PAYMENT_PROVIDER=paypal` |
| `PAYPAL_WEBHOOK_ID` | l'id che PayPal assegna all'endpoint quando lo registri. Entra nella firma: se è sbagliato **ogni** notifica fallisce la verifica, e sembrerà che nessuno paghi |
| `PAYPAL_ENVIRONMENT` | `live` o `sandbox` |
| `MODERATION_LLM_*` | `MODERATION_LLM_PROVIDER=none` se non vuoi l'LLM: la coda resta tutta manuale |

### `.env` sul Raspberry

Solo quello che serve a stampare. Niente Stripe, niente admin, niente tunnel:

```bash
BACKEND_URL=http://<home-server-ip>:3000
HARDWARE_TOKEN=<lo stesso dell'home server>

PRINTER_KIND=escpos
PRINTER_USB_VENDOR_ID=0x0000     # dal passo 4
PRINTER_USB_PRODUCT_ID=0x0000

RECORDER_KIND=ffmpeg
WEBCAM_DEVICE=/dev/video0

UPLOADER_KIND=s3
S3_ENDPOINT_URL=
S3_ACCESS_KEY=
S3_SECRET_KEY=
S3_BUCKET_NAME=
PUBLIC_CLIPS_URL=https://<host-pubblico-delle-clip>

# Fuori da /tmp: systemd isola /tmp al servizio, e le clip devono sopravvivere al riavvio.
CLIPS_DIRECTORY=/var/lib/inkless/clips
OVERLAY_PATH=/var/lib/inkless/current_user.txt
```

Permessi stretti su entrambi: `chmod 600 .env`.

---

## 2. Cloudflare Tunnel

Nel pannello **Zero Trust → Networks → Tunnels**:

1. Crea un tunnel, scegli **Docker** come metodo di installazione.
2. Copia il token dal comando che ti mostra e mettilo in `CLOUDFLARE_TUNNEL_TOKEN`.
   Il token **è** una credenziale: non finisce in git e non si incolla in chat.
3. Nella scheda *Public Hostnames* aggiungi:
   - **Hostname:** `<dominio>`
   - **Service:** `http://inkless-frontend:80` — è il nome del servizio Compose, risolto dentro la
     rete Docker. Non un IP, e **non** il backend: nginx serve il sito e inoltra `/api`,
     così il browser vede una sola origine.

Il tunnel si apre dall'interno: **nessuna porta va aperta sul router**, ed è il punto di tutta
la topologia. Se ti ritrovi a fare port forwarding, hai sbagliato strada.

---

## 3. Home server — backend

```bash
git clone <repo> /opt/inkless
cd /opt/inkless
cp .env.example .env
$EDITOR .env                      # compila come da passo 1
chmod 600 .env

docker compose --env-file .env -f docker/docker-compose.homeserver.yml up -d --build
```

> **Il flag `--env-file` non è opzionale.** Compose risolve i `${...}` del file compose
> leggendo quello, e di default cercherebbe un `.env` dentro `docker/` che non esiste. Senza,
> la porta finisce su `127.0.0.1` e il Pi non si collegherà mai.

Verifica:

```bash
curl -s http://<home-server-ip>:3000/health
# {"status":"ok","hardwareOnline":false}   ← false è corretto: il Pi non c'è ancora
docker compose -f docker/docker-compose.homeserver.yml logs -f inkless-backend
```

Lo schema del database si applica da solo alla prima apertura, migrazioni comprese. Non c'è
nessun comando di migrazione da lanciare a mano.

Il volume `inkless-data` contiene il database: **è l'unica cosa da salvare**.

```bash
docker run --rm -v inkless-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/inkless-$(date +%F).tar.gz -C /data .
```

### Se sul server c'è già uno stack Compose

Il file del repo presume di essere solo sulla macchina. Se il server ne ospita già uno con
altri servizi, ci sono due strade.

**Tenerli separati.** Non tocchi nulla: restano due progetti Compose distinti.

```bash
docker compose -p inkless --env-file .env -f docker/docker-compose.homeserver.yml up -d --build
```

Costa un secondo `cloudflared`, e quindi **un secondo tunnel con un token suo**. Riusare lo
stesso token su due connettori non è una scorciatoia: Cloudflare bilancia tra i due, e metà
delle richieste finisce su quello che il servizio non ce l'ha.

**Fondere i servizi nello stack esistente.** Riusi il `cloudflared` che c'è già. Copi
`inkless-backend` e `inkless-frontend` dentro il `services:` dell'altro file, con due
aggiustamenti: `build.context` diventa il percorso assoluto del repo sul server, e
`env_file` punta al `.env` del repo — non a quello dello stack ospite, che resta riservato
alle interpolazioni `${...}`. In fondo aggiungi le reti:

```yaml
networks:
  frontend_net:
  backend_net:
  hw_net:
```

Infine `cloudflared` deve poter raggiungere nginx:

```yaml
    networks:
      - default
      - frontend_net
```

Prima di lanciare, i tre controlli che corrispondono ai tre modi in cui questa fusione si
rompe:

1. **La rete `default`.** È la trappola vera. Nel momento in cui un servizio dichiara un
   blocco `networks:`, esce dalla rete di default: se nella riga qui sopra ometti `default`,
   `cloudflared` smette di vedere *tutti* gli altri servizi dello stack, non solo InkLess.
2. **Porte host.** `inkless-backend` pubblica la `3000`. Se è già presa, cambia la parte
   sinistra della mappatura (`3010:3000`) e allinea `BACKEND_URL` sul Raspberry, che deve
   puntare alla porta nuova.
3. **Servizi duplicati.** Un secondo `cloudflared` nello stesso file è una chiave YAML
   ripetuta: Compose tiene l'ultima e l'altra sparisce in silenzio. I nomi `inkless-*` sono
   scelti per non collidere, ma il `cloudflared` del file del repo va lasciato fuori.

Se il servizio dei dati diventa un bind mount invece del volume `inkless-data`, la cartella
va creata prima e assegnata all'utente che gira nel container: `chown 1000:1000`. Il backend
non gira come root e il filesystem è read-only tranne quel percorso.

In entrambi gli scenari, **non lanciare i due stack insieme**: userebbero lo stesso database.

---

## 4. Raspberry Pi — demone hardware

### 4.1 Pacchetti

```bash
sudo apt update
sudo apt install -y python3-venv python3-pip libusb-1.0-0 ffmpeg git
```

### 4.2 Utente e cartelle

```bash
sudo useradd --system --create-home --home-dir /var/lib/inkless --shell /usr/sbin/nologin inkless
sudo mkdir -p /var/lib/inkless/clips
sudo chown -R inkless:inkless /var/lib/inkless

# accesso a webcam e USB
sudo usermod -aG video,plugdev inkless
```

### 4.3 Codice e virtualenv

```bash
sudo git clone <repo> /opt/inkless
cd /opt/inkless/hardware
sudo python3 -m venv .venv
sudo .venv/bin/pip install -r requirements.txt

sudo cp /percorso/del/tuo/.env /opt/inkless/.env
sudo chown inkless:inkless /opt/inkless/.env
sudo chmod 600 /opt/inkless/.env
```

### 4.4 Identificare la stampante

Con la stampante collegata:

```bash
lsusb
# Bus 001 Device 005: ID 04b8:0e15 Seiko Epson Corp. ...
#                        ^^^^ ^^^^ vendor : product
```

Metti i due valori in `PRINTER_USB_VENDOR_ID` e `PRINTER_USB_PRODUCT_ID` come `0x04b8` /
`0x0e15`.

Poi la regola udev che dà accesso al device senza root, e soprattutto lo **rende stabile
attraverso stacca-e-riattacca**:

```bash
sudo tee /etc/udev/rules.d/99-inkless-printer.rules <<'EOF'
SUBSYSTEM=="usb", ATTRS{idVendor}=="04b8", ATTRS{idProduct}=="0e15", MODE="0660", GROUP="plugdev"
EOF

sudo udevadm control --reload-rules && sudo udevadm trigger
```

> La libreria parla con la stampante via **libusb**, non tramite `/dev/usb/lp0`. È il motivo
> per cui serve la regola udev sul gruppo e non un permesso su quel file.

### 4.5 Servizio systemd

```bash
sudo tee /etc/systemd/system/inkless-hardware.service <<'EOF'
[Unit]
Description=InkLess hardware daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=inkless
WorkingDirectory=/opt/inkless/hardware
EnvironmentFile=/opt/inkless/.env
Environment=PYTHONPATH=/opt/inkless/hardware/src
ExecStart=/opt/inkless/hardware/.venv/bin/python -m inkless

Restart=always
RestartSec=5

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/inkless

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now inkless-hardware
sudo systemctl status inkless-hardware
journalctl -u inkless-hardware -f
```

Il demone riprova da solo se il backend non risponde, e alla riconnessione **recupera i lavori
pagati mentre era spento** prima di mettersi in ascolto. Non serve orchestrare nulla a mano.

### 4.6 Prova senza hardware

Prima di collegare stampante e webcam, verifica che il collegamento col backend regga:

```bash
sudo systemctl stop inkless-hardware
cd /opt/inkless/hardware
sudo -u inkless PYTHONPATH=src PRINTER_KIND=fake RECORDER_KIND=fake UPLOADER_KIND=local \
  BACKEND_URL=http://<home-server-ip>:3000 HARDWARE_TOKEN=<token> .venv/bin/python -m inkless
```

Da un'altra shell, `curl http://<home-server-ip>:3000/health` deve rispondere
`"hardwareOnline":true`.

---

## 5. Frontend

Nessun passo a parte: il servizio `inkless-frontend` vive nello stesso compose del backend e viene
costruito dal `up -d --build` del passo 3. L'immagine è a due stadi — Node compila con Vite,
poi in produzione resta solo `dist/` dentro nginx, senza runtime JavaScript.

Chi raggiunge cosa:

```
internet → cloudflared ─[frontend_net]─ nginx ─[backend_net]─ backend ─[hw_net]─ RPi
```

`nginx` è l'unico container su due reti, e l'unico che il tunnel vede. Verso l'esterno esiste
una sola origine: il sito e `/api` arrivano dalla stessa porta. La pubblicazione
`${BACKEND_BIND_IP}:3000` sull'host resta, ma serve al Pi, non al pubblico.

Verifica dopo il deploy:

```bash
docker compose -f docker/docker-compose.homeserver.yml logs -f inkless-frontend
docker compose -f docker/docker-compose.homeserver.yml exec inkless-frontend wget -qO- http://inkless-backend:3000/health
```

Il secondo comando è quello che conta: se risponde, la catena nginx → backend regge, e un 502
sul sito ha un'altra causa.

### Sviluppo in locale

Invariato, e non passa da Docker:

```bash
cd frontend && npm install && npm run dev   # :5173, con il proxy di Vite su :3000
```

`CORS_ORIGIN` in produzione non serve più al browser, visto che l'origine è una sola.
Tenerlo valorizzato col dominio pubblico resta la difesa buona il giorno in cui qualcuno
raggiunge il backend per un'altra strada.

### Provare la build da una macchina senza Docker

Capita di sviluppare su una macchina dove il daemon Docker non gira, perché i container
vivono solo sul server. Non serve clonare il repo là: il client Docker parla con un daemon
remoto via SSH e gli spedisce il contesto di build.

Prerequisiti sul server: chiave SSH già autorizzata, host key già accettata almeno una volta
(`ssh <utente>@<home-server-ip>` a mano), utente nel gruppo `docker`.

```bash
docker context create inkless-hs --docker "host=ssh://<utente>@<home-server-ip>"

# la build gira sul server, il contesto parte da qui
docker --context inkless-hs build -f docker/frontend.Dockerfile -t inkless-frontend:check .

# il parser vero di nginx sulla conf che andrà in produzione
docker --context inkless-hs run --rm --entrypoint nginx inkless-frontend:check -t
```

L'ultimo comando deve rispondere `syntax is ok` / `test is successful`, ed è **l'unica** prova
che `docker/nginx.conf` regge: `docker compose config` non lo apre nemmeno, perché valida solo
il file compose ed è interamente client-side.

Poi si pulisce:

```bash
docker --context inkless-hs image rm inkless-frontend:check
docker context rm inkless-hs
```

Lo stesso context serve per qualsiasi altro comando: basta anteporre `--context inkless-hs`.

---

## 6. Verifica end-to-end

1. Apri `https://<dominio>` e invia un messaggio.
2. Vai su `#/admin`, autenticati con `ADMIN_USER` / `ADMIN_PASSWORD`, approva.
3. Dalla bacheca premi **Stampa questo** e completa il pagamento con le credenziali di test del provider configurato (carta di prova su Stripe, buyer di sandbox su PayPal).
4. Guarda `journalctl -u inkless-hardware -f` sul Pi: il lavoro arriva, la carta esce.
5. La pagina del lavoro si aggiorna da sola fino a `completato`.

---

## 7. Aggiornamenti

```bash
# home server
cd /opt/inkless && git pull
docker compose --env-file .env -f docker/docker-compose.homeserver.yml up -d --build

# raspberry
cd /opt/inkless && sudo git pull
sudo /opt/inkless/hardware/.venv/bin/pip install -r hardware/requirements.txt
sudo systemctl restart inkless-hardware
```

---

## 8. Quando qualcosa non va

| Sintomo | Causa quasi sempre |
|---|---|
| `hardwareOnline: false` con il demone acceso | `HARDWARE_TOKEN` diverso tra le due macchine, oppure `BACKEND_BIND_IP` lasciato a `127.0.0.1` |
| Il backend non parte, `Missing required environment variable` | in `NODE_ENV=production` mancano `ADMIN_USER`, `ADMIN_PASSWORD` o `HARDWARE_TOKEN`. È voluto |
| Compose pubblica sulla porta sbagliata | manca `--env-file .env` |
| `usb.core.NoBackendError` o accesso negato | regola udev assente, oppure l'utente non è in `plugdev`. Serve un logout o un `udevadm trigger` |
| La stampante sparisce dopo averla staccata | è esattamente ciò che la regola udev previene: verifica che vendor e product id siano quelli giusti |
| Nessun messaggio si auto-approva | `MODERATION_LLM_PROVIDER=none`, oppure il runtime LLM non risponde a `MODERATION_LLM_BASE_URL` |
| `502 Bad Gateway` sul sito | il backend non è su, o non è sulla stessa `backend_net`. Provalo da dentro nginx con la `exec wget` del passo 5 |
| La pagina del lavoro resta ferma su "in coda" | qualcosa bufferizza l'SSE. Se hai messo un altro proxy davanti a nginx, gli serve `proxy_buffering off` sulla rotta dello stream |
| Nessun pagamento risulta mai confermato, su PayPal | `PAYPAL_WEBHOOK_ID` non è quello dell'endpoint registrato. Entra nel payload firmato, quindi sbagliarlo fa fallire la verifica di tutto senza distinzione |
| Il video non arriva | l'utente ha pagato sotto la soglia della clip, oppure `UPLOADER_KIND=s3` con credenziali vuote |

Log utili:

```bash
docker compose -f docker/docker-compose.homeserver.yml logs -f inkless-backend   # home server
journalctl -u inkless-hardware -f                                        # raspberry
```

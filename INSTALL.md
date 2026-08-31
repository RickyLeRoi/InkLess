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
| Stripe | chiave segreta e secret del webhook |
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
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | dalla dashboard Stripe |
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
   - **Service:** `http://backend:3000` — è il nome del servizio Compose, risolto dentro la
     rete Docker. Non un IP.

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
docker compose -f docker/docker-compose.homeserver.yml logs -f backend
```

Lo schema del database si applica da solo alla prima apertura, migrazioni comprese. Non c'è
nessun comando di migrazione da lanciare a mano.

Il volume `inkless-data` contiene il database: **è l'unica cosa da salvare**.

```bash
docker run --rm -v inkless-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/inkless-$(date +%F).tar.gz -C /data .
```

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

## 5. Frontend — ancora da decidere

**Questo è l'unico pezzo non ancora cablato**, ed è bene saperlo prima di andare live: il
backend serve solo l'API, non i file statici.

```bash
cd frontend && npm ci && npm run build   # produce dist/
```

Due strade:

- **Cloudflare Pages** — pubblichi `dist/`, poi instradi `<dominio>/api/*` verso il tunnel e
  tutto il resto verso Pages. Zero container in più, ma la regola di routing va scritta su
  Cloudflare.
- **Container nginx** — serve `dist/` e inoltra `/api` al backend; il tunnel punta a lui invece
  che al backend. Tutto resta dentro il compose e sotto una sola origine, al prezzo di un
  servizio in più da scrivere.

In entrambi i casi `CORS_ORIGIN` deve elencare l'origine da cui il browser carica il sito.

---

## 6. Verifica end-to-end

1. Apri `https://<dominio>` e invia un messaggio.
2. Vai su `#/admin`, autenticati con `ADMIN_USER` / `ADMIN_PASSWORD`, approva.
3. Dalla bacheca premi **Stampa questo** e completa il pagamento con una carta di test Stripe.
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
| Il video non arriva | l'utente ha pagato sotto la soglia della clip, oppure `UPLOADER_KIND=s3` con credenziali vuote |

Log utili:

```bash
docker compose -f docker/docker-compose.homeserver.yml logs -f backend   # home server
journalctl -u inkless-hardware -f                                        # raspberry
```

# 🛠️ Guía Completa de Recreación desde Cero — Personal Daily Hub

> Manual técnico paso a paso para instalar dependencias, construir cada capa del código desde cero, configurar variables de entorno y servicios externos, validar todas las pruebas y desplegar **Personal Daily Hub** en desarrollo local o producción (**Ubuntu Server + Docker Blue-Green + Caddy + Tailscale**).

---

## 📑 Índice de Contenidos

* [Fase 1: Requisitos e Instalación de Herramientas](#fase-1-requisitos-e-instalación-de-herramientas)
* [Fase 2: Creación de la Estructura del Proyecto desde Cero](#fase-2-creación-de-la-estructura-del-proyecto-desde-cero)
* [Fase 3: Configuración Completa de Variables de Entorno (`.env` y `.env.enc`)](#fase-3-configuración-completa-de-variables-de-entorno-env-y-envenc)
* [Fase 4: Configuración Paso a Paso de Servicios Externos e Integraciones](#fase-4-configuración-paso-a-paso-de-servicios-externos-e-integraciones)
* [Fase 5: Ejecución Local y Suite de Pruebas Automatizadas](#fase-5-ejecución-local-y-suite-de-pruebas-automatizadas)
* [Fase 6: Despliegue en Producción en Ubuntu Server (Docker + Caddy Blue-Green + Tailscale + CI/CD)](#fase-6-despliegue-en-producción-en-ubuntu-server-docker--caddy-blue-green--tailscale--cicd)
* [Fase 7: Operación, Respaldos y Solución de Problemas (Troubleshooting)](#fase-7-operación-respaldos-y-solución-de-problemas-troubleshooting)

---

## Fase 1: Requisitos e Instalación de Herramientas

### 1.1 Matriz de herramientas necesarias

| Herramienta | Versión recomendada | Entorno Local (Windows / Dev) | Ubuntu Server (Producción) | Para qué se usa |
| :--- | :--- | :--- | :--- | :--- |
| **Node.js + npm** | **20 LTS** (o superior compatible con `node:test`) | Obligatorio | En contenedor (`node:20-alpine`) | Backend Express 5, scripts vault/SemVer y suite `npm test`. |
| **Git** | 2.40+ | Obligatorio | Obligatorio | Control de versiones, tags SemVer y worktrees de rollback. |
| **Python 3 + `pip`** | **3.10+** (3.12 en Docker Alpine) | Recomendado / Requerido para pruebas Python | En contenedor (`python3`) + host si usas scripts locales | `lib/docx_writer.py` (OOXML/OLE2) y puente opcional `sincronitation/`. |
| **Paquetes Python** | `msoffcrypto-tool`, `pycryptodome`, `requests` (+ `pywin32` solo Windows) | `pip` | `msoffcrypto-tool` + `py3-cryptography` + `py3-olefile` en `Dockerfile` | Cifrado MS-OFFCRYPTO de `Diario.docx` y cliente PC opcional. |
| **`yt-dlp` y `ffmpeg`** | Última estable | Opcional (letras/media local) | Instalados en `Dockerfile` (`/usr/local/bin/yt-dlp`) | Extracción de subtítulos y streaming multimedia sin persistir archivos. |
| **MySQL 8.0** | `8.0` | Local o Docker | Contenedor `mysql:8.0` (`mood_db`) | Almacén relacional de las 15 tablas en `init.sql`. |
| **Docker Engine + Compose v2** | Docker 24+ / Compose v2 | Opcional en local | Obligatorio | Orquestación de `db`, `app_blue`, `app_green` y `proxy` (`caddy:2-alpine`). |
| **`rclone` y Tailscale** | Última estable | Opcional (`rclone` para backups) | Obligatorio (`tailscale`) / Opcional (`rclone`) | Dual Drive (`gdrive` / estudio) y red privada HTTPS (`*.ts.net`). |

### 1.2 Comandos de instalación rápida

#### En Windows (Desarrollo local / PowerShell o Git Bash)
```powershell
# 1. Verificar Node.js 20+, Git y Python 3.10+
node -v
npm.cmd -v
git --version
python --version

# 2. Instalar dependencias Python locales (para ejecutar pruebas OOXML/sincronizador)
python -m pip install --upgrade pip
python -m pip install msoffcrypto-tool pycryptodome requests pywin32

# 3. Opcional: instalar yt-dlp, ffmpeg y rclone vía winget
winget install -e --id yt-dlp.yt-dlp
winget install -e --id Gyan.FFmpeg
winget install -e --id Rclone.Rclone
```

#### En Ubuntu Server 24.04 / 26.04 LTS (Host de producción)
```bash
# 1. Actualizar paquetes base y herramientas del sistema
sudo apt-get update && sudo apt-get install -y curl git jq openssl ca-certificates sqlite3 cron

# 2. Instalar Docker Engine y plugin Docker Compose v2
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
# (Cerrar sesión y volver a entrar para aplicar el grupo docker)

# 3. Instalar Tailscale
curl -fsSL https://tailscale.com/install.sh | sh

# 4. Instalar rclone (para respaldos automáticos Dual Drive desde scripts/backup.sh)
curl -fsSL https://rclone.org/install.sh | sudo bash

# 5. Verificar versiones instaladas
docker --version
docker compose version
tailscale version
rclone --version
```

---

## Fase 2: Creación de la Estructura del Proyecto desde Cero

Si estás recreando la aplicación desde un directorio vacío o clonando la estructura base, sigue exactamente este orden lógico de construcción.

### 2.1 Inicialización del proyecto e instalación de dependencias npm
```bash
mkdir -p personal-daily-hub && cd personal-daily-hub
git init

# Inicializar package.json e instalar exactamente las 6 dependencias de producción
npm init -y
npm install bcryptjs@^3.0.3 cors@^2.8.6 dotenv@^18.0.4 express@^5.2.1 mysql2@^3.24.4 nodemailer@^10.5.0

# Crear árbol completo de carpetas del proyecto
mkdir -p lib public/vendor sincronitation scripts tests \
         data/journal data/ytdlp data/deploy-state \
         english-notes logs docs guides .github/workflows
```

En `package.json`, asegúrate de configurar el script de pruebas nativo de Node:
```json
{
  "name": "mood-tracker",
  "version": "1.17.0",
  "private": true,
  "scripts": {
    "test": "node --test tests/*.test.js"
  }
}
```

### 2.2 Árbol real y orden lógico de reconstrucción por capas

```text
personal-daily-hub/
├── init.sql                       # Capa 1: Esquema de 15 tablas MySQL
├── lib/                           # Capa 2: Módulos backend y escritor OOXML
│   ├── distributed-lock.js        #   GET_LOCK / RELEASE_LOCK en MySQL
│   ├── server-i18n.js             #   Diccionarios EN/ES para API, tray y ntfy
│   ├── server-logger.js           #   Logs rotativos con redacción de secretos
│   ├── transport-crypto.js        #   Túnel X25519 + HKDF + AES-256-CTR + HMAC
│   ├── docx_writer.py             #   Escritura/cifrado/exportación OOXML en RAM
│   ├── server-notes-service.js    #   Puente Node <-> docx_writer.py y pdh-j2
│   ├── language-studio.js         #   Estudio EN/KO/JA/K-Pop, Hangul y Gemini
│   ├── youtube-metadata.js        #   Normalizador YT/YT Music y limpiador VTT/SRT
│   ├── ytdlp-service.js           #   Extractor yt-dlp + lock FIFO (maxConcurrency=1)
│   ├── ytmusic-lyrics.js          #   Cliente InnerTube + scoring de pistas
│   └── external-lyrics-and-meta.js#   Fuentes externas allowlisted anti-SSRF
├── server.js                      # Capa 3: Express 5, RBAC, rutas API, SSE y schedulers
├── public/                        # Capa 4: SPA estática CSP-safe (script-src 'self')
│   ├── vendor/crypto-js.min.js    #   CryptoJS local (0 CDNs externos)
│   ├── theme-init.js              #   Modo oscuro permanente sin FOUC
│   ├── i18n.js                    #   Motor bilingüe EN <-> ES sincronizado
│   ├── transport-crypto.js        #   Cliente X25519 + AES-256-CTR + HMAC
│   ├── index.html                 #   Shell SPA completo y modales
│   ├── style.css                  #   Estilos unificados (--brand-primary) y responsive
│   ├── frontend.js                #   Controladores, E2EE pdh-j2, DnD Jira, Planner, SSE
│   ├── dashboard.html / .js       #   Redirección bilingüe a index.html#resumen
│   ├── translator-widget.js       #   Widget traductor reutilizable
│   ├── translator-popup.html / .js#   Ventana emergente independiente Alt+T
│   └── guia-visual.html / .js     #   Guía visual interactiva
├── scripts/                       # Capa 5: Bóveda, Blue-Green, SemVer y Backups
├── sincronitation/                # Capa 5 (opcional PC): sincronizador.py + yt_lyrics_helper.py
├── tests/                         # Capa 6: Suite completa node:test
├── Dockerfile                     # Capa 7: Imagen Node 20 Alpine + Python 3 + yt-dlp
├── docker-compose.yml             #   db + app_blue + app_green + proxy (Caddy)
├── Caddyfile                      #   Proxy dinámico /etc/caddy/state/upstream.caddy
└── .github/workflows/             #   ci.yml, deploy.yml, rollback.yml
```

1. **Capa 1 — Base de Datos (`init.sql`):**
   * Crea las **15 tablas**: `RegistrosMood`, `RegistrosSleep`, `RegistrosCrisis`, `RegistrosAgenda` (incluye `tipo`, `categoria`, `materia_id`, `materia_nombre`, `estado`, `recordatorio_min`, `en_progreso_desde`), `Usuarios`, `SesionesAuth`, `CodigosSeguridad`, `ConfiguracionUsuario`, `RecordatoriosEstado`, `MusicaArtistas`, `MusicaAlbumes`, `MusicaCanciones`, `MusicaCancionArtistas`, `EstudioLecciones` y `SyncRevisions`.
2. **Capa 2 — Librerías Core (`lib/`):**
   * Implementa primero `lib/distributed-lock.js` (mutex SQL), `lib/server-i18n.js` (diccionarios `en`/`es` sin dependencias) y `lib/server-logger.js`.
   * Construye el motor de documentos `lib/docx_writer.py` (modos `english`, `journal`, `journal-inspect`, `journal-nothing`, `journal-export-plain`, `english-read`) y su envoltorio Node `lib/server-notes-service.js` (`pdh-j2`).
   * Añade seguridad de transporte (`lib/transport-crypto.js`) y módulos de idiomas/música (`lib/language-studio.js`, `lib/youtube-metadata.js`, `lib/ytmusic-lyrics.js`, `lib/ytdlp-service.js`, `lib/external-lyrics-and-meta.js`).
3. **Capa 3 — Servidor Backend (`server.js`):**
   * Configura Helmet/headers CSP (`script-src 'self'`), limitadores de tasa (`createRateLimiter`), middleware anti-duplicados (`preventDuplicateSubmit`), migraciones idempotentes al arranque (`inicializarTablasSeguridad`), endpoints de auth/RBAC, módulos clínicos, Diario E2EE (`pdh-j2` + `/api/journal/download-encrypted`), Agenda (`en_progreso_desde` + snooze), Planner ITS (pausa/promedio por materia, campus CRUD, Maps/GPS), Idiomas/Música, SSE (`/api/sync/stream`), Settings (`uiLanguage`, `PATCH /api/settings/language`), schedulers de recordatorios inteligentes + `ntfy` y `/healthz`.
4. **Capa 4 — Interfaz Web SPA (`public/`):**
   * Coloca `crypto-js.min.js` en `public/vendor/` para cumplir `script-src 'self'`.
   * Maqueta `public/index.html` y `public/style.css` con `--brand-primary`, modo oscuro permanente (`data-theme="dark"`), `.secret-input-masked` anti-autofill, modales con scroll lock y clases `cursor: grab`/`grabbing` en tarjetas de agenda.
   * Conecta `public/i18n.js` + `public/frontend.js` para sincronizar idioma con `/api/settings/language`, cifrar notas/exportaciones `pdh-j2` en navegador, manejar SSE y habilitar Drag & Drop desde toda la tarjeta (`isAgendaCardInteractiveTarget`).
5. **Capa 5 — Scripts Operativos y Contenedores:**
   * Configura `Dockerfile`, `docker-compose.yml`, `Caddyfile` y `scripts/` (`local-vault.js`, `env-vault.sh`, `blue-green.sh`, `backup.sh`, `restore.sh`, `release-version.js`, `verify-ubuntu-local.sh`).
   * Opcional en Windows: `sincronitation/sincronizador.py` y `sincronitation/yt_lyrics_helper.py`.

---

## Fase 3: Configuración Completa de Variables de Entorno (`.env` y `.env.enc`)

> Copia la plantilla base con `cp .env.example .env` y rellena **únicamente valores propios sin subir `.env` ni `.env.enc` con secretos reales a repositorios públicos**.

### 3.1 Comandos para generar secretos seguros localmente
```bash
# Generar DB_PASS, ADMIN_SECRET o WORD_PASSWORD (32 chars hex)
openssl rand -hex 16

# Generar JOURNAL_SECRET_KEY (DEBE medir exactamente 32 bytes UTF-8)
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"

# Generar tópico privado aleatorio para ntfy (sin espacios ni acentos)
node -e "console.log('hub_' + require('crypto').randomBytes(6).toString('hex'))"
```

### 3.2 Matriz completa de variables de entorno reales del proyecto

| Variable | Oblig. | Default / Ejemplo seguro | Cómo se obtiene / genera | Propósito |
| :--- | :---: | :--- | :--- | :--- |
| `DB_HOST` | Sí | `db` (Docker) / `127.0.0.1` (local) | Host de MySQL | Dirección del servidor MySQL. |
| `DB_USER` | Sí | `root` | Usuario MySQL | Usuario con permisos sobre `DB_NAME`. |
| `DB_PASS` | Sí | `<CONTRASEÑA_BD_SEGURA>` | `openssl rand -hex 16` | Contraseña de MySQL (`MYSQL_ROOT_PASSWORD` en Compose). |
| `DB_NAME` | Sí | `MoodTrackerLocal` | Nombre de esquema | Base de datos donde carga `init.sql`. |
| `PORT` | No | `3000` | Entero puerto | Puerto interno de Express dentro del contenedor. |
| `BLUE_PORT` / `GREEN_PORT` | No | `3001` / `3002` | Puertos libres en host | Puertos loopback `127.0.0.1` para smoke tests Blue-Green. |
| `PROXY_HTTP_PORT` / `PROXY_HTTPS_PORT` | No | `8080` / `8443` | Puertos libres en host | Puertos loopback de Caddy detrás de Tailscale Serve. |
| `SITE_ADDRESS` | No | `:80` | Caddy binding | Dirección de escucha interna de Caddy en `Caddyfile`. |
| `APP_UID` / `APP_GID` | No | `1000` / `1000` | `id -u` / `id -g` en Ubuntu | UID/GID no-root del contenedor para escribir en volúmenes. |
| `TZ` | No | `America/Monterrey` | Zona IANA | Zona horaria por defecto para Node, MySQL y `tzdata`. |
| `ADMIN_EMAIL` | Sí | `<TU_CORREO_ADMIN>` | Tu correo principal | Único correo autorizado para obtener rol `admin`. |
| `ADMIN_SECRET` | Sí | `<SECRETO_REGISTRO_ADMIN>` | `openssl rand -hex 16` | Clave alternativa al OTP para validar el primer registro `admin`. |
| `SMTP_USER` | Sí | `<CORREO_ENVIO_GMAIL>` | Cuenta Gmail | Remitente SMTP para códigos OTP, reset y MFA. |
| `SMTP_PASS` | Sí | `<APP_PASSWORD_16_LETRAS>` | Google Account → Seguridad → Contraseñas de aplicación | App Password de 16 caracteres (sin espacios) para Nodemailer. |
| `APP_BASE_URL` | Sí (prod) | `https://<TU_SERVIDOR>.<TU_TAILNET>.ts.net` | URL MagicDNS Tailscale | URL pública usada en enlaces de correo y botones `ntfy`. |
| `TRUST_PROXY` | Sí (prod) | `1` o `2` | `2` tras Tailscale→Caddy | Niveles de proxy confiables para IP real y protocolo `https`. |
| `REQUIRE_HTTPS` | No | `true` (prod) / `false` (dev) | Booleano | En `true` responde HTTP `426` a peticiones API sin TLS. |
| `REQUIRE_PC_BRIDGE_AUTH` | No | `true` | Booleano | Exige firma HMAC en rutas puente PC (`/api/pull-text`, `/api/pull-english`, `/api/pc-jobs/*`). |
| `CORS_ALLOWED_ORIGINS` | No | *(vacío)* | Lista separada por comas | Orígenes extra permitidos en CORS además de `APP_BASE_URL` y `*.ts.net`. |
| `ENABLE_LOGIN_MFA` | No | `false` | Booleano | Activa código OTP por correo en cada login. |
| `SETTINGS_ENCRYPTION_KEY` | No | `<CLAVE_CIFRADO_AJUSTES>` | `openssl rand -hex 32` | Llave maestra para cifrar `pdh-s1:` en `ConfiguracionUsuario`. |
| `MFA_CHALLENGE_SECRET` | No | `<SECRETO_CHALLENGE_MFA>` | `openssl rand -hex 32` | Firma HMAC de desafíos temporales MFA en login. |
| `WORD_PASSWORD` | Sí | `<CONTRASEÑA_OLE2_WORD>` | Cadena robusta propia | Contraseña OLE2 de `Diario.docx` usada por `docx_writer.py`. |
| `JOURNAL_SECRET_KEY` | Sí | `<LLAVE_E2EE_32_CHARS>` | Exactamente 32 bytes UTF-8 | Llave E2EE compartida navegador ↔ servidor/PC para `pdh-j2`. |
| `SERVER_AUTONOMOUS_NOTES` | No | `true` | Booleano | Habilita escritura autónoma directa a `.docx` desde el servidor. |
| `JOURNAL_LOCAL_PATH` | No | `/app/journal-data/Diario.docx` | Ruta absoluta (Linux/Win) | Ruta del archivo cifrado `Diario.docx` (aísla rutas Windows en Linux). |
| `ENGLISH_WORD_FILE_PATH` | No | `/app/english-notes/English_Learning_Notebook.docx` | Ruta absoluta | Ruta local del Cuaderno de Idiomas. |
| `RCLONE_REMOTE` / `RCLONE_BACKUP_DIR` | Opc. | `gdrive` / `RespaldosApp` | Nombre remoto en `rclone` | Drive 1: respaldos SQL y JSON histórico. |
| `RCLONE_CONF_B64` | Opc. | `<BASE64_RCLONE_CONF>` | `base64 -w 0 ~/.config/rclone/rclone.conf` | Configuración inyectada de Drive 1 para despliegues sin archivos manuales. |
| `REQUIRE_DRIVE_BACKUP` | No | `false` | Booleano | Si es `true`, `backup.sh` falla si no logra subir a Google Drive. |
| `STUDY_RCLONE_REMOTE` / `STUDY_RCLONE_DIR` | Opc. | *(vacío)* / `NotasIdiomas` | Segundo remoto `rclone` | Drive 2 exclusivo para `English_Learning_Notebook.docx` (nunca Diario). |
| `STUDY_RCLONE_CONF_B64` | Opc. | `<BASE64_STUDY_RCLONE>` | `base64 -w 0` | Configuración `rclone` opcional del Drive 2. |
| `DB_RETENTION_DAYS` | No | `0` | Entero (`0` = ilimitado) | Días a retener registros locales en MySQL tras archivar. |
| `LOCAL_SQL_DAILY_BACKUP_DAYS` | No | `180` | Entero | Días de retención para backups SQL diarios locales. |
| `LOCAL_WORD_BACKUP_DAYS` | No | `365` | Entero | Días de retención para copias diarias de Word locales. |
| `GEMINI_API_KEY` | Opc. | `<API_KEY_GEMINI>` | Google AI Studio | Respaldo/override env para tutor de idiomas y análisis IA. |
| `GOOGLE_MAPS_API_KEY` | Opc. | `<API_KEY_MAPS>` | Google Cloud Console | Opcional para cálculos avanzados de ruta/tráfico si se configura. |
| `YOUTUBE_API_KEY` | Opc. | `<API_KEY_YOUTUBE>` | Google Cloud Console | Opcional para búsquedas vía YouTube Data API v3. |
| `YT_DLP_PATH` / `YTDLP_COOKIES_PATH` | Opc. | *(vacío)* / `/app/ytdlp-config/cookies.txt` | Ruta binario / cookies Netscape | Ruta personalizada de `yt-dlp` y cookies opcionales contra bloqueos anti-bot. |
| `YTM_INNERTUBE` | No | `1` | `1` o `0` | Habilita obtención rápida de letras/metadatos vía InnerTube antes de `yt-dlp`. |
| `LOG_DIR` / `LOG_LEVEL` / `LOG_MAX_BYTES` / `LOG_MAX_FILES` | No | `/app/logs` / `info` / `20971520` / `10` | Parámetros de log | Directorio y rotación persistente en `./logs/{blue,green}`. |
| `DISABLE_REMINDER_SCHEDULER` / `DISABLE_CLEANUP_SCHEDULER` | No | `false` / `false` | Booleano | Desactiva schedulers de fondo (útil al correr pruebas). |
| `APP_SLOT` / `REPLICA_ID` / `APP_SLOT_STATE_FILE` | Docker | `blue` / `/app/deploy-state/active-slot` | Gestionado por Compose/BG | Permite a los contenedores saber si son el slot activo. |
| `GITHUB_REPO` / `GITHUB_TOKEN` / `SERVER_HOST` (`EC2_HOST`) | PC opt. | `<USUARIO>/<REPO>` | Fine-grained PAT (Variables RO) | Usadas por `sincronizador.py` para descubrir el host automáticamente. |
| `MOOD_ENV_PASS` / `MOOD_DPAPI_VAULT_PATH` | Local/CLI | *(solo sesión RAM)* | Clave de `.env.enc` | Evita prompts interactivos al usar `local-vault.js` o DPAPI en Windows. |
| `RATE_LIMIT_*` | Opc. | Ver `.env.example` | Enteros positivos | Ajuste fino de límites por minuto/ventana (`API`, `READ`, `WRITE`, `LOGIN`, `MFA`, `MAP_TILE`, `PC_PULL`, `PC_WRITE`, `REMINDER_ACTION`). |

### 3.3 Sellar secretos con la bóveda local (`scripts/local-vault.js`) o en Linux (`scripts/env-vault.sh`)

```bash
# En desarrollo local (Windows / Mac / Linux):
node scripts/local-vault.js encrypt   # Cifra .env -> .env.enc (PBKDF2 600k + AES-256-CBC)
node scripts/local-vault.js status    # Verifica estado sin revelar secretos
node scripts/local-vault.js lock      # Elimina el archivo .env en texto plano tras cifrar
node scripts/local-vault.js run node server.js  # Inyecta .env.enc en RAM sin tocar disco

# En servidor Ubuntu:
./scripts/env-vault.sh encrypt
./scripts/env-vault.sh status
./scripts/env-vault.sh up             # Levanta docker compose inyectando secretos vía /dev/shm y haciendo shred al instante
```

---

## Fase 4: Configuración Paso a Paso de Servicios Externos e Integraciones

### 4.1 MySQL 8.0 (Contenedor `mood_db` o local)
1. **Con Docker Compose (recomendado):**
   ```bash
   docker compose up -d db
   docker compose ps db
   # Esperar hasta estado "healthy" y verificar que las 15 tablas de init.sql existan:
   docker exec -i mood_db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -u root "$MYSQL_DATABASE" -e "SHOW TABLES;"'
   ```
   *(Si la base arrancó antes de existir `init.sql`, cárgala manualmente una sola vez con:)*
   ```bash
   docker exec -i mood_db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -u root "$MYSQL_DATABASE"' < init.sql
   ```
2. **Con MySQL local instalado en Windows/Linux:**
   ```sql
   CREATE DATABASE IF NOT EXISTS MoodTrackerLocal CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   ```
   ```bash
   mysql -u root -p MoodTrackerLocal < init.sql
   ```

### 4.2 Google Drive + `rclone` (Arquitectura Dual Drive)
1. Configura tu remoto principal de respaldos (`gdrive` = Drive 1):
   ```bash
   rclone config
   # n) New remote -> name: gdrive -> Storage: Google Drive -> sigue el asistente OAuth en navegador
   rclone mkdir gdrive:RespaldosApp
   rclone lsd gdrive:RespaldosApp
   ```
2. *(Opcional)* Si deseas separar el Cuaderno de Idiomas en una segunda cuenta Google Drive (`STUDY_RCLONE_REMOTE`):
   ```bash
   rclone config   # crea p. ej. gdrive_estudio
   rclone mkdir gdrive_estudio:NotasIdiomas
   ```
3. Para automatizar CI/CD, codifica tu `rclone.conf` en una sola línea Base64 sin exponer archivos:
   ```bash
   base64 -w 0 ~/.config/rclone/rclone.conf
   # Copia el resultado en el Secret RCLONE_CONF_B64 de GitHub Actions
   ```

### 4.3 Notificaciones Push con `ntfy`
1. Instala la app gratuita **ntfy** en tu teléfono (Android/iOS) o abre `https://ntfy.sh`.
2. Suscríbete a un tópico privado difícil de adivinar (ej. `hub_<CARACTERES_ALEATORIOS>`).
3. Dentro de Personal Daily Hub → **Ajustes (`#view-settings`)**:
   * Activa notificaciones móviles (`ntfy`).
   * Ingresa URL del servidor (`https://ntfy.sh` o instancia propia) y el nombre exacto de tu tópico.
   * Guarda Ajustes y pulsa **Enviar Notificación de Prueba (`POST /api/reminders/test-push` / `/api/settings/test-notification`)**.
4. Verifica que en el celular aparezca el mensaje en el idioma activo (`uiLanguage`: **EN** o **ES**) con botones de acción (`Abrir App` / `Open App`, `Posponer 15m` / `Snooze 15m`, `Marcar hecha` / `Mark done`, `OK`, `Actualizar GPS` / `Update GPS`).

### 4.4 Google Maps / GPS, Webhook Móvil HTTP y Gemini API
1. **Gemini API:** Obtén una API Key gratuita en Google AI Studio (`https://aistudio.google.com/apikey`), pégala en `#view-settings` (cifrada con `pdh-s1:` en BD) o en `GEMINI_API_KEY` dentro de `.env`, y usa el botón **Probar Conexión IA** para listar los modelos activos.
2. **Smart Commute y Ubicaciones (`#view-horario` + `#view-settings`):**
   * Registra tus materias, horarios y campus manuales desde **Horario ITS (`#view-horario`)** (`#itsCroquisDirectoryCards`).
   * Fija **Casa / Ubicación Base** en el mapa interactivo (`#locationMapPickerModal` servido con tiles proxy locales) y opcionalmente genera tu **Webhook GPS HTTP firmado con HMAC** (`GET /api/planner/phone-gps-token`) para enviarlo automáticamente desde apps Android como MacroDroid / Automate.
   * Ajusta tus umbrales de alerta inteligente (`+30 min` de margen en Casa/Lejos, repetición cada `5 min`, y hitos `20, 15, 10 min` en radio `<= 0.5 km`) en `#view-settings`.

### 4.5 Llave E2EE del Diario y Contraseña de Descarga `.docx`
1. Verifica que `JOURNAL_SECRET_KEY` tenga **exactamente 32 caracteres** en `.env` y que `WORD_PASSWORD` coincida con la contraseña de cifrado OLE2 de tu archivo `Diario.docx`.
2. En el navegador (`#view-journal`), pulsa **`🔑 Llave E2EE`** e introduce la misma llave de 32 caracteres (se guarda únicamente en el dispositivo local, nunca se envía al servidor).
3. Para descargar `Diario.docx` estándar descifrado en tu dispositivo desde `#view-journal`: configura una **contraseña de descarga (8–128 caracteres)** en `#view-settings` o introdúcela al momento en el modal `#journalDownloadPasswordModal`.

---

## Fase 5: Ejecución Local y Suite de Pruebas Automatizadas

### 5.1 Arrancar el servidor en desarrollo
```bash
# Opción A: usando la bóveda cifrada .env.enc (recomendado)
node scripts/local-vault.js run node server.js

# Opción B: usando .env temporal en desarrollo local
# (Asegura REQUIRE_HTTPS=false en .env local si entras por http://localhost:3000)
node server.js
```

Verifica salud inmediata en otra terminal:
```bash
curl -fsS http://127.0.0.1:3000/healthz
```

### 5.2 Ejecutar toda la suite automatizada (`npm test`)
Las pruebas usan `node:test` nativo con base de datos simulada para la capa de integración, por lo que corren completas en segundos sin requerir Docker ni MySQL activos:

```bash
# Linux / macOS / Git Bash
npm test

# Windows PowerShell
npm.cmd test

# Ejecutar un archivo de pruebas específico
node --test tests/server.integration.test.js
node --test tests/syntax-and-config.test.js
```

| Archivo en `tests/` | Qué valida |
| :--- | :--- |
| `tests/syntax-and-config.test.js` | Sintaxis `node --check`/`python`/`bash`, reglas SQL `init.sql`, CSP `script-src 'self'`, anti-autofill, i18n `EN↔ES` completo, reglas CSS/responsividad, Docker/Blue-Green e integridad documental. |
| `tests/server.integration.test.js` | API HTTP completa, Auth/RBAC (`admin` vs `psiquiatra`), MFA, SSE `SyncRevisions`, rate limiting, Planner ITS, pausa/promedio por materia, regla 1h `en_progreso`, Smart Commute, i18n en `ntfy`/`#reminderTray` y descarga cifrada `pdh-j2`. |
| `tests/server-notes-service.test.js` | Cifrado `pdh-j2` con salt (texto y binario `.docx`), interoperabilidad CryptoJS, `lib/docx_writer.py`, TOC único en Word y exportación RAM sin disco. |
| `tests/distributed-lock.test.js` | Adquisición/liberación de `GET_LOCK`/`RELEASE_LOCK`, timeouts (`503`) y limpieza tras excepciones. |
| `tests/local-vault.test.js` | Cifrado/descifrado `.env.enc` (`Salted__`), interoperabilidad Node ↔ OpenSSL ↔ Python y limpieza segura. |
| `tests/youtube-metadata.test.js` | Normalización de URLs YT/YT Music, inferencia de álbum/pista/año y limpiador `.vtt`/`.srt`/`.lrc`. |
| `tests/ytdlp-service.test.js` | Seguridad anti-SSRF, `--js-runtimes node`, aislamiento de idiomas y lock FIFO (`maxConcurrency = 1`). |
| `tests/ytmusic-lyrics.test.js` | Cliente InnerTube, scoring de coincidencias y filtrado de versiones incompatibles. |
| `tests/py_study_notebook_check.py` | Validación directa de generación OOXML de apartados en `English_Learning_Notebook.docx`. |

---

## Fase 6: Despliegue en Producción en Ubuntu Server (Docker + Caddy Blue-Green + Tailscale + CI/CD)

### 6.1 Preparar usuario, carpetas y Swap en Ubuntu Server
```bash
# 1. Crear archivo de Swap 2 GB si no existe (ideal para 8 GB RAM)
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 2. Clonar repositorio y crear carpetas persistentes con dueño UID/GID 1000
mkdir -p ~/projects && cd ~/projects
git clone <URL_DEL_REPOSITORIO_GIT> mood-tracker
cd mood-tracker
mkdir -p data/journal data/ytdlp data/deploy-state english-notes logs ~/projects/respaldos
sudo chown -R 1000:1000 data english-notes logs
chmod 700 data/journal

# 3. (Si ya tienes un Diario.docx previo) cópialo cifrado con WORD_PASSWORD a:
# ~/projects/mood-tracker/data/journal/Diario.docx (chmod 600)
```

### 6.2 Configurar Tailscale HTTPS Serve (sin colisionar con otros proyectos)
```bash
sudo tailscale up
# Exponer el balanceador Caddy (127.0.0.1:8080) en HTTPS :443 dentro de tu tailnet:
sudo tailscale serve --bg --https=443 http://127.0.0.1:8080
tailscale serve status
```
> **Importante:** Si otro servicio/proyecto corre en el mismo Ubuntu Server usando Tailscale Serve en otro puerto, **nunca ejecutes `tailscale serve reset`** (borraría los demás servicios). Ajusta puertos en `.env` (`PROXY_HTTP_PORT`, `BLUE_PORT`, `GREEN_PORT`) si hubiera conflicto.

### 6.3 Primer arranque Blue-Green manual con `.env.enc`
```bash
cd ~/projects/mood-tracker

# 1. Crear .env temporal, validar valores y sellar con bóveda
cp .env.example .env
nano .env
./scripts/env-vault.sh encrypt
rm -f .env   # Opcional tras verificar que .env.enc descifra

# 2. Inicializar estado Blue-Green en slot "blue"
./scripts/blue-green.sh init-state blue

# 3. Levantar base de datos, restaurar backup si está vacía, compilar y levantar blue + proxy
./scripts/env-vault.sh up -d db
./scripts/env-vault.sh exec -- ./scripts/restore.sh --if-empty
./scripts/env-vault.sh up -d --build app_blue proxy

# 4. Verificar salud local, swap Blue-Green y auditoría completa [1/10]-[10/10]
./scripts/blue-green.sh status
./scripts/blue-green.sh switch blue
./scripts/verify-ubuntu-local.sh
```

### 6.4 Configurar GitHub Actions (Despliegue Automático SemVer + Rollback en 1 Clic)

Configura estos **Repository Secrets** y **Variables** en **GitHub → Settings → Secrets and variables → Actions**:

| Tipo | Nombres requeridos / recomendados | Propósito |
| :--- | :--- | :--- |
| **Secrets** | `SERVER_SSH_KEY` (o `EC2_SSH_KEY`), `SERVER_SUDO_PASS` *(si `sudo` pide clave)*, `DB_PASS`, `ADMIN_SECRET`, `WORD_PASSWORD`, `JOURNAL_SECRET_KEY`, `SMTP_PASS`, `TS_OAUTH_SECRET` *(o `TS_AUTHKEY`)*, `RCLONE_CONF_B64` *(opc.)*, `STUDY_RCLONE_CONF_B64` *(opc.)*, `GEMINI_API_KEY` *(opc.)*, `YOUTUBE_API_KEY` *(opc.)* | Credenciales inyectadas en RAM (`/dev/shm`) durante el deploy y destruidas con `shred` al terminar (`SEAL_ENV_AFTER_DEPLOY=true`). |
| **Variables** | `SERVER_HOST` (tu dominio `*.ts.net` o IP), `SERVER_USER` (ej. `ubuntu`), `SERVER_SSH_PORT` (`22`), `TS_OAUTH_CLIENT_ID`, `TS_TAGS` (`tag:ci`), `DB_HOST` (`db`), `DB_USER` (`root`), `DB_NAME` (`MoodTrackerLocal`), `ADMIN_EMAIL`, `SMTP_USER`, `APP_BASE_URL` (`https://<servidor>.<tailnet>.ts.net`), `TRUST_PROXY` (`2`), `REQUIRE_HTTPS` (`true`), `DB_RETENTION_DAYS` (`0`), `AUTO_CONFIGURE_SERVER` (`true`), `RELEASE_PUSH_TO_MAIN` (`false`) | Parámetros operativos y flags de endurecimiento del host Ubuntu (UFW, Fail2ban, unattended-upgrades, hidepid=2, auditd, desactivación de suspensión). |

* **Para desplegar una versión:** Haz merge (PR) hacia `main` o ejecuta manualmente **Actions → Deploy to Ubuntu Server → Run workflow**. El job `release` calcula el tag SemVer (`scripts/release-version.js`) y el job `deploy` compila el slot *standby*, ejecuta smoke tests en `127.0.0.1` y realiza `./scripts/blue-green.sh switch`.
* **Para revertir en 1 clic:** Ve a **Actions → Rollback Blue-Green → Run workflow** y elige:
  * `instant-switch`: conmuta Caddy en ~5 s al slot anterior sin recompilar.
  * `specific-tag`: reconstruye cualquier tag `vX.Y.Z` en un `git worktree` aislado sobre el slot inactivo y cambia el tráfico tras validar `/healthz`.

---

## Fase 7: Operación, Respaldos y Solución de Problemas (Troubleshooting)

### 7.1 Comandos cotidianos de monitoreo y mantenimiento
```bash
# Estado de contenedores y slot Blue-Green activo
cd ~/projects/mood-tracker
docker compose ps
./scripts/blue-green.sh status

# Logs en vivo del slot activo y de Caddy
docker compose logs -f --tail=120 app_blue proxy

# Respaldo manual completo (BD SQL + historico_completo.json.gz + copia Word)
./scripts/env-vault.sh exec -- ./scripts/backup.sh
# Con verificación estricta de subida a Google Drive:
./scripts/env-vault.sh exec -- ./scripts/backup.sh --require-drive

# Verificación integral del host y seguridad [1/10] a [10/10]
./scripts/verify-ubuntu-local.sh
```

### 7.2 Solución de problemas comunes

| Síntoma / Error | Causa probable | Solución exacta |
| :--- | :--- | :--- |
| **`426 Upgrade Required` al abrir en localhost** | `REQUIRE_HTTPS=true` activo en desarrollo local HTTP. | En tu `.env` local de desarrollo establece `REQUIRE_HTTPS=false` y reinicia Node. (En producción con Tailscale HTTPS mantén `true`). |
| **`503 LOCK_TIMEOUT` o error al guardar Diario** | Otro proceso mantiene ocupado `pdh_docx_journal` o `WORD_PASSWORD` no coincide con `Diario.docx`. | Verifica conexiones MySQL (`docker exec mood_db mysqladmin processlist -u root -p`) y comprueba en RAM que `WORD_PASSWORD` descifra `./data/journal/Diario.docx`. |
| **Error descargando `Diario.docx` en navegador** | Contraseña de descarga incorrecta o diferente a la guardada/ingresada. | Ingresa la contraseña exacta de `8–128` caracteres definida en `#view-settings` (o reconfigúrala allí). |
| **Fallo de `rclone` en `backup.sh` o Drive Estudio** | Token OAuth expirado en `rclone.conf` o remoto no encontrado. | Reautoriza con `rclone config reconnect <REMOTO>:` y actualiza `RCLONE_CONF_B64` / `STUDY_RCLONE_CONF_B64`. |
| **Bot check o HTTP 403/429 al extraer letras con `yt-dlp`** | YouTube exige sesión desde la IP del servidor o binario `yt-dlp` desactualizado. | Actualiza en contenedor (`docker exec -u 0 mood_app_blue /usr/local/bin/yt-dlp -U`), coloca cookies Netscape en `./data/ytdlp/cookies.txt` y define `YTDLP_COOKIES_PATH=/app/ytdlp-config/cookies.txt`, o usa `sincronitation/yt_lyrics_helper.py` en tu PC. |
| **No llegan notificaciones `ntfy` al celular** | Tópico distinto entre app móvil y Ajustes, o contenedor *standby* mal sincronizado. | Verifica `./scripts/blue-green.sh status`, confirma tópico en `#view-settings` y pulsa **Enviar Notificación de Prueba**. |
| **Restaurar copia previa `.bak` de Word** | Interrupción externa previa antes del reemplazo atómico. | Revisa `./data/journal/Diario.docx.bak` o `./english-notes/English_Learning_Notebook.docx.bak` y valida su apertura antes de renombrar. |

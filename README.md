# Personal Daily Hub

Plataforma web full-stack responsiva (**PC, Tablet y Celular**) en **Modo Oscuro Permanente** e idioma **Bilingüe sincronizado (`EN` ↔ `ES`)**, diseñada para **Ubuntu Server (8 GB RAM) + Tailscale Serve HTTPS + Caddy Blue-Green (`mood_app_blue` / `mood_app_green`) + MySQL 8.0**. Integra seguimiento clínico diario, diario personal cifrado E2EE con descarga `.docx` cifrada en RAM, estudio de idiomas con IA y música, agenda semanal tipo Jira, planificador universitario/laboral con alertas inteligentes en `ntfy` y sincronización en tiempo real SSE.

---

## 📑 Índice de Contenidos

* [✨ Resumen de Módulos y Funcionalidades](#-resumen-de-módulos-y-funcionalidades)
* [🛠️ Stack Tecnológico Completo](#️-stack-tecnológico-completo)
* [📁 Mapa Completo de Archivos y Carpetas](#-mapa-completo-de-archivos-y-carpetas)
* [📚 Documentación y Guías Detalladas](#-documentación-y-guías-detalladas)
* [🚀 Inicio Rápido (Desarrollo y Producción Blue-Green)](#-inicio-rápido-despliegue-blue-green-y-rollback)

---

## ✨ Resumen de Módulos y Funcionalidades

1. **🧭 Inicio y Sync en Tiempo Real (`SyncRevisions` SSE):** Panel diario, bandeja `#reminderTray` localizada en el idioma activo y sincronización instantánea entre PC y celular vía **Server-Sent Events (`GET /api/sync/stream`)** con pausa automática en segundo plano (`0` queries SQL en reposo), historial navegable (`pushState`/`popstate`) con retorno limpio a Inicio y *swipe-to-close* táctil en menú móvil.
2. **🧠 Estado de Ánimo (`#view-mood`):** Registro por franja horaria (*Madrugada, Morning, Noon, Afternoon, Night*) con 16 emociones/colores y recordatorios automáticos.
3. **🌙 Sueño Nocturno, Siestas y Desvelos (`#view-sueno`):** Registro en dos tiempos con despertar pendiente (`PATCH /api/update-sleep/:id`), **Siestas (`siesta`)** separadas del sueño nocturno, marcado automático de desvelo (`<7h` o `>=01:00`) y **Desvelo Total (`0 hrs`)**.
4. **⚠️ Bitácora Clínica de Crisis (`#view-crisis`):** Botón rápido `⏱️ Now`, intensidad `1–5`, **tipos de episodio editables/personalizados** (categoría `Otro` limpia sin corchetes), motivo opcional (`250` chars) y vista **solo lectura** para cuenta médica (`psiquiatra`).
5. **🖋️ Notas de Diario E2EE + Descarga Segura `.docx` (`#view-journal`):** Entradas cifradas en navegador con esquema **`pdh-j2`** (`PBKDF2-HMAC-SHA256` 120,000 iter + salt aleatorio 16B + `AES-256-CBC` + `HMAC-SHA256`) hacia `Diario.docx` (cifrado OLE2 con `WORD_PASSWORD` bajo lock `pdh_docx_journal` y jamás guardado en MySQL ni Google Drive). Incluye **descarga cifrada en RAM** (`/api/journal/download-encrypted`) protegida con contraseña elegida por el usuario (`8–128` chars) y descifrada en el dispositivo lista para Word.
6. **📖 Estudio de Idiomas y Música (`#view-english`):** Soporte **EN / KR / JP / K-Pop / J-Pop**, estudio Hangul (constructor de sílabas, comparador y notas Drive solo lectura), tutor dual Gemini API / local, traductor flotante (`Alt + T`) y popup (`/translator-popup.html`) con scroll lock global, extractor InnerTube + `yt-dlp`, **verificación y unicidad de letras entre canciones, separación EN/KO/JP/ES sin etiquetas de ruido, índice TOC único y reemplazo atómico en `English_Learning_Notebook.docx`**.
7. **🗓️ Agenda Semanal (`#view-agenda`):** Separación **Personal** vs. **Escuela/Universidad**, calendario mensual fijo (Lunes–Domingo), flujo tipo Jira (**To Do / In Progress / Done / Skipped**), **arrastre desde toda la tarjeta excluyendo controles interactivos (`isAgendaCardInteractiveTarget`)** con *long-press* táctil (`220 ms`) sin bloquear scroll, validación de hora en `#agendaDropTimeModal`, posponer por minutos/horas/días sin saltar de vista y **silenciamiento de tareas `en_progreso` durante 1 hora** (`en_progreso_desde`).
8. **🎓 Horario ITS / Residencias / Trabajo (`#view-horario`) y Alertas Inteligentes (`#view-settings`):** CRUD dinámico de campus/salones y materias con **pausa de avisos (`remindersPaused`) y captura de promedio (`finalGrade`)** que calcula el promedio semestral automático, Estimador de Ruta en Vivo con mapa proxy local (`OSM`/`Esri`), **Alertas Inteligentes Google Maps/GPS configurables en Ajustes** (`ruta + 30 min` cada `5 min` en Casa/Lejos y `20, 15, 10 min` Cerca del radio) y confirmación **`OK`** en `ntfy` que detiene avisos restantes del turno/clase.
9. **🌐 Bilingüe 100% `EN / ES` y Seguridad:** Cambio instantáneo `EN` ↔ `ES` sincronizado en BD (`PATCH /api/settings/language`), en `#reminderTray` y en todos los títulos, cuerpos y botones `Actions` de `ntfy` mediante `lib/server-i18n.js`; protección anti-autofill (`.secret-input-masked`), CSP estricto `script-src 'self'`, túnel `X25519 + AES-256-CTR + HMAC` y `GET /api/version`.

---

## 🛠️ Stack Tecnológico Completo

| Capa | Tecnología real del proyecto |
| :--- | :--- |
| **Backend** | **Node.js 20**, **Express 5** (`5.2.1`), `mysql2` (`3.24.4`), `bcryptjs` (`3.0.3`, 12 rondas), `nodemailer` (`10.5.0`), `cors` (`2.8.6`), `dotenv` (`18.0.4`), SSE y rate-limiting/idempotencia propios. |
| **Base de datos** | **MySQL 8.0** (`mood_db`, **15 tablas** en `init.sql`, afinada para bajo I/O en HDD y locking distribuido `GET_LOCK`/`RELEASE_LOCK`). |
| **Frontend** | **Vanilla HTML5, CSS3 y JavaScript** (`script-src 'self'`), tokens `--brand-primary`, modo oscuro permanente (`data-theme="dark"`), `public/vendor/crypto-js.min.js` local (`0` CDNs externos) y motor i18n bidireccional `public/i18n.js`. |
| **Motor Word y Media** | **Python 3** + `lib/docx_writer.py` + **`msoffcrypto-tool`** (cifrado/descifrado OLE2 en RAM) + **`yt-dlp`** + **`ffmpeg`** + InnerTube. |
| **Infraestructura y Red** | **Docker Compose** (`db`, `app_blue`, `app_green`, `proxy`), **Caddy 2 Alpine** (`blue-green.sh`), **Tailscale Serve (TLS 1.3)**, **Dual Google Drive (`rclone`)**, **`ntfy`**, y **GitHub Actions** (`ci.yml`, `deploy.yml`, `rollback.yml`). |

---

## 📁 Mapa Completo de Archivos y Carpetas

```text
personal-daily-hub/
├── .github/workflows/
│   ├── ci.yml                              # Lint estático (JS, Bash, Python, YAML) y suite node:test
│   ├── deploy.yml                          # Auto-versionado SemVer 2.0.0, Tailscale OAuth y deploy Blue-Green
│   └── rollback.yml                        # Rollback 1-clic (instant-switch o tag SemVer vX.Y.Z)
├── docs/                                   # Documentación de conceptos técnicos y recreación paso a paso
│   ├── CONCEPTOS_Y_ARQUITECTURA.md         # Fundamentos técnicos, criptografía pdh-j2, SSE, locks y Maps/ntfy
│   └── RECREAR_DESDE_CERO.md               # Guía cronológica desde 0 (dev, MySQL, rclone, ntfy, prod Ubuntu)
├── guides/                                 # Guías operativas detalladas (fuera del build Docker)
│   ├── GUIA_TECNICA_UNIFICADA.md           # Arquitectura, esquema de 15 tablas, catálogo API y costos
│   ├── GUIA_COMANDOS.md                    # Referencia de comandos Git Bash y Linux/Ubuntu con flags
│   ├── GUIA_COMANDOS_RAPIDOS.md            # Cheatsheet copy-paste operativo
│   ├── GUIA_INSTALACION_UBUNTU_SERVER_26.md# Preparación mínima Ubuntu Server y hardening automático
│   └── MANUAL_DE_USUARIO.md                # Uso diario de vistas, Diario, Agenda, Horario y atajos
├── lib/                                    # Módulos backend Node.js y motor OOXML Python
│   ├── distributed-lock.js                 # Mutex MySQL GET_LOCK/RELEASE_LOCK (pdh_docx_journal/english)
│   ├── docx_writer.py                      # Manipulación OOXML, cifrado MS-OFFCRYPTO y export en RAM
│   ├── external-lyrics-and-meta.js         # Consulta allowlisted anti-SSRF (LRCLIB, Lyrics.ovh, Watch)
│   ├── language-studio.js                  # Estudio EN/KO/JA, Hangul, Gemini API y lector Notebook
│   ├── server-i18n.js                      # Diccionarios EN/ES para API, #reminderTray y botones ntfy
│   ├── server-logger.js                    # Logs rotativos sanitizados en ./logs/{blue,green}
│   ├── server-notes-service.js             # Envoltura Node de docx_writer.py + cifrado pdh-j2
│   ├── transport-crypto.js                 # Túnel X25519 + HKDF-SHA256 + AES-256-CTR + HMAC + anti-replay
│   ├── youtube-metadata.js                 # Limpieza de títulos YT/Topic, álbumes y subtítulos VTT/SRT/LRC
│   ├── ytdlp-service.js                    # Extractor yt-dlp con lock FIFO y streaming Range 206 seguro
│   └── ytmusic-lyrics.js                   # Cliente InnerTube y scoring de coincidencia de canciones
├── public/                                 # SPA estática protegida por CSP (script-src 'self')
│   ├── vendor/crypto-js.min.js             # CryptoJS local sin CDN externos
│   ├── dashboard.html / dashboard.js       # Redirección bilingüe compatible hacia index.html#resumen
│   ├── frontend.js                         # Controlador SPA, E2EE pdh-j2, DnD tarjeta completa, SSE y Planner
│   ├── guia-visual.html / guia-visual.js   # Guía visual interactiva CSP-safe
│   ├── i18n.js                             # Diccionario UI EN <-> ES y sincronía de calendario/selectores
│   ├── index.html                          # Interfaz principal, vistas (#view-*) y modales
│   ├── style.css                           # Tema oscuro (--brand-primary), grab/grabbing y responsive UI
│   ├── theme-init.js                       # Aplicación temprana de tema oscuro e idioma inicial
│   ├── translator-popup.html / .js         # Ventana emergente Alt+T con sync uiLanguage
│   ├── translator-widget.js                # Widget traductor reutilizable flotante
│   └── transport-crypto.js                 # Cliente Curve25519 + AES-256-CTR + HMAC-SHA256
├── scripts/
│   ├── backup.sh                           # Dump MySQL + JSON histórico + Drive + rotación local SQL/Word
│   ├── blue-green.sh                       # init-state, status, switch atómico Caddy y rollback
│   ├── env-vault.sh                        # Bóveda OpenSSL PBKDF2 600k en Linux (/dev/shm)
│   ├── local-vault.js                      # Bóveda Node local (encrypt, decrypt, lock, run, status)
│   ├── release-version.js                  # SemVer 2.0.0 automático + CHANGELOG.md
│   ├── restore.sh                          # Restauración automática desde Drive o init.sql
│   └── verify-ubuntu-local.sh              # Verificación en vivo [1/10]-[10/10] de red, seguridad y slots
├── sincronitation/                         # Cliente Windows opcional (Word COM / DPAPI; fuera de Docker)
│   ├── README.md                           # Uso, DPAPI autoinicio y variables PC
│   ├── requirements.txt                    # requests, pycryptodome, pywin32 (Windows)
│   ├── sincronizador.env.example           # Plantilla de entorno para sincronizador PC
│   ├── sincronizador.py                    # Worker PC para Word COM y extracción local
│   └── yt_lyrics_helper.py                 # Helper local de subtítulos yt-dlp y portapapeles UTF-8
├── tests/                                  # Suite completa node:test (100% ejecutable sin BD activa)
├── Caddyfile                               # Configuración proxy Caddy v2 (/etc/caddy/state/upstream.caddy)
├── Dockerfile                              # Node 20 Alpine + Python 3 + msoffcrypto-tool + yt-dlp + ffmpeg
├── docker-compose.yml                      # mood_db + mood_app_blue + mood_app_green + mood_proxy
├── init.sql                                # Esquema MySQL completo (15 tablas)
├── .env.example                            # Plantilla completa de variables de entorno sin secretos
└── server.js                               # API Express 5, RBAC, SSE, schedulers y seguridad
```

---

## 📚 Documentación y Guías Detalladas

| Documento | Qué encontrarás dentro | Enlace |
| :--- | :--- | :--- |
| **Conceptos Técnicos y Arquitectura** | Diagramas de flujo, RBAC, túnel `X25519`, cifrado `pdh-j2` con salt en envío/descarga RAM, locks MySQL `GET_LOCK`, SSE, Alertas Smart Commute, `en_progreso` 1h, DnD Jira y OOXML. | [docs/CONCEPTOS_Y_ARQUITECTURA.md](docs/CONCEPTOS_Y_ARQUITECTURA.md) |
| **Recrear Todo desde Cero** | Manual cronológico en 7 fases con cada comando para reconstruir código, esquema SQL, `.env` completo, MySQL, `rclone`, `ntfy`, pruebas, Docker Blue-Green, Tailscale y CI/CD. | [docs/RECREAR_DESDE_CERO.md](docs/RECREAR_DESDE_CERO.md) |
| **Guía Técnica Unificada** | Esquema detallado de las 15 tablas MySQL, catálogo completo de endpoints API, análisis de costos (**Gratuito** vs **Pago**), Dual Drive y migración cloud-agnostic. | [guides/GUIA_TECNICA_UNIFICADA.md](guides/GUIA_TECNICA_UNIFICADA.md) |
| **Guía Completa de Comandos** | Referencia por entorno (**Git Bash** y **Ubuntu Server**) con descripción, casos de uso y tabla de banderas/parámetros. | [guides/GUIA_COMANDOS.md](guides/GUIA_COMANDOS.md) |
| **Guía de Comandos Rápidos** | Cheatsheet copy-paste para Git, Blue-Green, Tailscale, MySQL/`rclone`, bóveda y Windows. | [guides/GUIA_COMANDOS_RAPIDOS.md](guides/GUIA_COMANDOS_RAPIDOS.md) |
| **Instalación Ubuntu Server** | Instalación mínima Ubuntu Server, llaves SSH, Docker, Tailscale OAuth, variables GitHub y verificación `[1/10]`–`[10/10]`. | [guides/GUIA_INSTALACION_UBUNTU_SERVER_26.md](guides/GUIA_INSTALACION_UBUNTU_SERVER_26.md) |
| **Manual de Usuario** | Uso diario paso a paso de cada pantalla, descarga `.docx` cifrada, pausa/promedio de materias, arrastre de tarjetas, `ntfy` y atajos de teclado. | [guides/MANUAL_DE_USUARIO.md](guides/MANUAL_DE_USUARIO.md) |

---

## 🚀 Inicio Rápido, Despliegue Blue-Green y Rollback

### Entorno Local (Desarrollo y Pruebas)
```bash
npm ci
cp .env.example .env
# Completa tus variables locales en .env y sella secretos en .env.enc:
node scripts/local-vault.js encrypt

# Arrancar servidor sin dejar .env plano en disco y correr suite completa:
node scripts/local-vault.js run node server.js
npm test        # Linux / macOS / Git Bash
npm.cmd test    # Windows PowerShell
```

### Despliegue Blue-Green y Rollback en 1 Clic
1. Fusiona tus cambios a `main`: `.github/workflows/deploy.yml` calcula la versión SemVer 2.0.0 (`vX.Y.Z` sin empujar commits directos a `main`), compila y prueba el slot standby (`blue` ↔ `green`), conmuta Caddy con `./scripts/blue-green.sh switch`, limpia temporales en `/dev/shm` y ejecuta `./scripts/verify-ubuntu-local.sh`.
2. **Rollback instantáneo:** desde GitHub Actions → **Rollback Blue-Green (`rollback.yml`) → Run workflow**, elige `instant-switch` (~5 s sin recompilar) o `specific-tag` (`vX.Y.Z`), o ejecuta en el servidor `./scripts/blue-green.sh rollback`.

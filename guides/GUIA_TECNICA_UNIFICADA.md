# 🏛️ Guía Técnica Unificada y Blueprint de Recreación — Personal Daily Hub

> Documento técnico maestro, versionado en `guides/` y excluido del contexto Docker en `.dockerignore`. Consolida la arquitectura real vigente (**Blue-Green con Caddy**, **Ubuntu Server 8 GB RAM**, **Tailscale Serve HTTPS**, **Sync SSE en tiempo real**, **descarga cifrada `pdh-j2` en RAM de `Diario.docx`**, **Dual Drive**, **auto-versionado SemVer 2.0.0** y **recreación completa desde cero**). Para explicaciones conceptuales detalladas consulta [docs/CONCEPTOS_Y_ARQUITECTURA.md](../docs/CONCEPTOS_Y_ARQUITECTURA.md) y para reconstrucción guiada por fases [docs/RECREAR_DESDE_CERO.md](../docs/RECREAR_DESDE_CERO.md).

---

## 📑 Índice de Contenidos

* [1. Visión General y Diagrama de Arquitectura Actual](#1-visión-general-y-diagrama-de-arquitectura-actual)
* [2. Estructura Completa del Repositorio y Responsabilidad de Cada Archivo](#2-estructura-completa-del-repositorio-y-responsabilidad-de-cada-archivo)
* [3. Modelo de Datos y Esquema MySQL (`init.sql` y Auto-Migraciones)](#3-modelo-de-datos-y-esquema-mysql-initsql-y-auto-migraciones)
* [4. Catálogo Completo de Endpoints API](#4-catálogo-completo-de-endpoints-api)
* [5. Lógica de Negocio Crítica](#5-lógica-de-negocio-crítica)
* [6. Infraestructura, CI/CD Blue-Green, Costos, Dual Drive, Migración y Recreación desde Cero](#6-infraestructura-cicd-blue-green-costos-dual-drive-migración-y-recreación-desde-cero)

---

## 1. Visión General y Diagrama de Arquitectura Actual

**Personal Daily Hub** (`personal-daily-hub` / paquete `mood-tracker`) implementa una arquitectura monolítica modular sobre **Docker Compose Blue-Green**, optimizada para una estación dedicada **Ubuntu Server 24.04/26.04 LTS (8 GB RAM, 2 GB Swap, HDD/SSD)** o instancia cloud equivalente, con **cero exposición en `0.0.0.0`** y **cero archivos de secretos en texto plano sobre disco**.

### 1.1 Topología de Tráfico y Servicios

```text
[Navegador: PC / OPPO A79 / Tablet]
       │  HTTPS TLS 1.3 (*.ts.net:443 o puerto dedicado) + Túnel interno opcional X25519
       ▼
[Tailscale Serve (WireGuard en host Ubuntu, 0 puertos abiertos en router)]
       │  HTTP loopback (127.0.0.1:8080, TRUST_PROXY=2)
       ▼
[mood_proxy (Caddy 2 Alpine, 64 MB RAM, /etc/caddy/Caddyfile)]
       │  import /etc/caddy/state/upstream.caddy (cambio atómico sin downtime)
       ├──────────────────────────────────────────┐
       ▼ (Slot activo: ej. blue)                  ▼ (Warm Standby / Rollback: ej. green)
[mood_app_blue (Node 20 Alpine, :3001)]    [mood_app_green (Node 20 Alpine, :3002)]
  • Heap V8 max 768 MB | Limit 1024 MB       • Misma imagen vX.Y.Z previa o nueva
  • Schedulers ACTIVOS (isActiveBlueGreenSlot)• Schedulers EN PAUSA en standby
  • Python 3 + msoffcrypto-tool + yt-dlp     • Healthcheck /healthz interno
       │                                          │
       └──────────────────┬───────────────────────┘
                          ▼
       [mood_db (MySQL 8.0, 127.0.0.1:3306, Limit 1024 MB, InnoDB 384M)]
         ├──► Volúmenes locales host (exentos de Git):
         │      • ./data/journal/Diario.docx        (cifrado OOXML WORD_PASSWORD, NUNCA en Drive)
         │      • ./english-notes/*.docx            (cuaderno de estudio sin clave)
         │      • ./data/deploy-state/              (active-slot, upstream.caddy, state.json)
         │      • ./data/ytdlp/ & ./logs/{blue,green}/
         ├──► Push móvil HTTPS: ntfy (https://ntfy.sh o propio + botones HMAC /api/reminders/action)
         ├──► Dual Drive rclone:
         │      • Drive 1 (gdrive): MySQL .sql.gz + historico_completo.json.gz + historico_sql/
         │      • Drive 2 (STUDY_RCLONE_REMOTE): copia opcional exclusiva de English_Learning_Notebook.docx
         └──► Puente PC opcional (sincronitation/sincronizador.py): Word COM local + .env.enc + DPAPI
```

### 1.2 Convivencia y Aislamiento Multiproducto en el Mismo Servidor (p. ej. `proyecto-clara`)

Cuando Ubuntu Server aloja más de un sistema en paralelo:
1. **Red y puertos aislados en loopback:** Todos los bindings del proyecto escuchan exclusivamente en `127.0.0.1` (`3306` MySQL, `3001` Blue, `3002` Green, `8080`/`8443` Caddy). Si otro proyecto usa alguno de esos puertos en host, basta sobrescribir `PROXY_HTTP_PORT`, `PROXY_HTTPS_PORT`, `BLUE_PORT` y `GREEN_PORT` en variables sin tocar código.
2. **Red Docker propia y nombres únicos:** Docker Compose aisla la red interna del proyecto y usa nombres explícitos (`mood_db`, `mood_app_blue`, `mood_app_green`, `mood_proxy`).
3. **Regla crítica de Tailscale Serve:** Si otro proyecto como `proyecto-clara` usa otro puerto HTTPS en la misma máquina Tailscale, **jamás ejecutes `tailscale serve reset`**, ya que elimina todas las asignaciones de todos los proyectos. Configura siempre puertos dedicados por proyecto con `sudo tailscale serve --bg --https=<puerto> http://127.0.0.1:<puerto>`.

---

## 2. Estructura Completa del Repositorio y Responsabilidad de Cada Archivo

```text
personal-daily-hub/
├── .github/workflows/
│   ├── ci.yml                     # Lint (node --check, bash -n, python ast, yaml), tests/*.test.js y resumen
│   ├── deploy.yml                 # Auto-versionado SemVer, Tailscale OAuth, build Blue-Green, smoke test y hardening
│   └── rollback.yml               # Rollback 1-clic (instant-switch a slot standby o rebuild de tag vX.Y.Z)
├── lib/                           # Lógica backend modular
│   ├── distributed-lock.js        # Mutex MySQL GET_LOCK/RELEASE_LOCK (`pdh_docx_journal`) con fallback local
│   ├── docx_writer.py             # Motor Python OOXML + msoffcrypto-tool (diario cifrado, cuaderno y export en RAM)
│   ├── external-lyrics-and-meta.js# Consulta segura de metadatos/letras externas con guardrails SSRF
│   ├── language-studio.js         # Tutor EN/KO/K-Pop, Romanización Hangul, Gemini API y almacenamiento Study Notebook
│   ├── server-logger.js           # Logger rotativo persistente en ./logs/{blue,green} sanitizando secretos
│   ├── server-notes-service.js    # Lock + docx_writer.py + cifrado binario `pdh-j2` en RAM y respaldo local Word
│   ├── transport-crypto.js        # Túnel híbrido X25519 + HKDF-SHA256 + AES-256-CTR + HMAC-SHA256 + anti-replay
│   ├── youtube-metadata.js        # Normalización YouTube/YT Music, auto-fill de álbum/pista/año y limpiador .vtt/.lrc
│   ├── ytdlp-service.js           # Extractor local/servidor con `--js-runtimes node` sin persistir audio en disco
│   └── ytmusic-lyrics.js          # Cliente Innertube y utilidades de letras sincronizadas
├── public/                        # SPA estática protegida por CSP estricta (`script-src 'self'`)
│   ├── vendor/crypto-js.min.js    # CryptoJS local servido desde 'self' (0 dependencias CDN externas)
│   ├── theme-init.js              # Enfuerza Modo Oscuro (`data-theme="dark"`) e idioma inicial sin parpadeo
│   ├── i18n.js                    # Diccionario completo EN ↔ ES (`pdh_ui_lang_v1`) y cabecera `X-UI-Lang`
│   ├── transport-crypto.js        # Escalera Montgomery Curve25519 en BigInt + AES-256-CTR + HMAC en navegador
│   ├── index.html                 # Shell SPA, vistas (`#view-*`), modales E2EE, Agenda Jira, Maps y Settings
│   ├── frontend.js                # Controlador principal SPA, Sync SSE, E2EE Upload/Download, Planner, Música
│   ├── style.css                  # Tema oscuro unificado, diseño responsivo PC/tablet/móvil y modal scroll lock
│   ├── guia-visual.html / .js     # Guía visual interactiva CSP-safe (inline en `#view-guia` y standalone)
│   ├── translator-widget.js       # Traductor flotante movible (`Alt+T` / `⋮⋮`) reutilizado por el popup
│   ├── translator-popup.html / .js# Ventana independiente CSP-safe `/translator-popup.html`
│   └── dashboard.html             # Redirección compatible hacia `index.html#resumen`
├── scripts/
│   ├── blue-green.sh              # Gestión atómica `init-state`, `status`, `switch` (Caddy reload) y `rollback`
│   ├── backup.sh                  # Dump MySQL + `historico_completo.json.gz` + Drive + rotación local SQL/Word
│   ├── restore.sh                 # Auto-restauración `--if-empty` / `--force` desde Google Drive + `init.sql`
│   ├── env-vault.sh               # Bóveda AES-256-CBC (PBKDF2 600k) en Linux (`/dev/shm` para `up`/`backup`/`restore`)
│   ├── local-vault.js             # Bóveda Node nativa en PC (`status`, `encrypt`, `decrypt`, `lock`, `run`)
│   ├── release-version.js         # Auto-versionador SemVer 2.0.0 desde Conventional Commits + `CHANGELOG.md`
│   └── verify-ubuntu-local.sh     # Auditoría en vivo `[1/10]`–`[10/10]` de red, Blue-Green, crypto, Drive y host
├── sincronitation/                # Acompañante local opcional en Windows (ignorado en Git/Docker)
│   ├── sincronizador.py           # Polling HMAC/E2EE hacia Word COM local + autoinicio Windows DPAPI
│   └── yt_lyrics_helper.py        # Extractor local de subtítulos CC `yt-dlp` en Windows + portapapeles UTF-8
├── tests/                         # Suite completa con `node:test` (100% ejecutable sin BD activa)
│   ├── ci-summary.js              # Generador de tabla resumen en `$GITHUB_STEP_SUMMARY`
│   ├── distributed-lock.test.js   # Concurrencia de locks MySQL y fallback en memoria
│   ├── local-vault.test.js        # Interoperabilidad OpenSSL/Node/Python de `.env.enc`
│   ├── server-notes-service.test.js# Cifrado binario `pdh-j2` con salt + `journal-export-plain` en RAM
│   ├── server.integration.test.js # Endpoints HTTP, RBAC, Rate Limit, Sync SSE, Agenda, Planner, Journal download
│   ├── syntax-and-config.test.js  # Lint estático, SQL, CSP, anti-autofill, i18n, Docker y documentación
│   ├── youtube-metadata.test.js   # Parsers de URL YouTube/YT Music y timestamps `.srt/.vtt/.lrc`
│   ├── ytdlp-service.test.js      # Resolución multiplataforma y argumentos seguros de `yt-dlp`
│   ├── ytmusic-lyrics.test.js     # Limpieza y parsing de letras Innertube
│   └── py_study_notebook_check.py # Validaciones AST/XML de generación de cuaderno Python
├── guides/                        # Las 5 guías vigentes (versionadas en Git, fuera de Docker)
├── Caddyfile                      # Terminación proxy y carga dinámica `/etc/caddy/state/upstream.caddy`
├── Dockerfile                     # `node:20-alpine` + Python 3 + `msoffcrypto-tool` + `ffmpeg` + `yt-dlp` + `tzdata`
├── docker-compose.yml             # `db` (`mood_db`), `app_blue`, `app_green` y `proxy` (`mood_proxy`)
├── init.sql                       # Esquema completo de las 15 tablas MySQL
├── .env.example                   # Plantilla comentada de variables de entorno
└── server.js                      # Backend Express 5, middlewares de seguridad, schedulers y SSE
```

---

## 3. Modelo de Datos y Esquema MySQL (`init.sql` y Auto-Migraciones)

El archivo [`init.sql`](../init.sql) define **15 tablas**, y al iniciar el servidor, `inicializarTablasSeguridad()` en [`server.js`](../server.js) ejecuta migraciones idempotentes (`CREATE TABLE IF NOT EXISTS` y `SHOW COLUMNS` + `ALTER TABLE`) sobre bases existentes sin pérdida de datos.

| # | Tabla | Propósito | Columnas / Restricciones / Índices clave |
| :---: | :--- | :--- | :--- |
| 1 | `RegistrosMood` | Estados de ánimo por franja horaria | `fecha`, `momento_dia` (`Madrugada`, `Morning`, `Noon`, `Afternoon`, `Night`), `estado_animo`, `color_hex`, `UNIQUE(fecha, momento_dia)` |
| 2 | `RegistrosSleep` | Sueño nocturno, siestas y desvelos | `horas DECIMAL(4,2)`, `calidad`, `hora_dormir`, `hora_despertar`, `es_desvelo TINYINT(1)`, `tipo_registro` (`normal`, `siesta`, `desvelo_tarde`, `desvelo_total`), `motivo_desvelo`, `idx_sleep_fecha` |
| 3 | `RegistrosCrisis` | Bitácora clínica de episodios agudos | `fecha`, `hora`, `tipo_crisis VARCHAR(100)` (incluye `Otro` y tipos personalizados), `intensidad TINYINT (1-5)`, `motivo VARCHAR(1000)`, `idx_crisis_fecha` |
| 4 | `RegistrosAgenda` | Eventos y tareas (`universidad` / `personal`) | `bloque` (`manana`, `cole`, `tarde`, `noche`), `tipo` (`evento`, `tarea`), `categoria`, `materia_id`, `materia_nombre`, `estado` (`todo`, `in_progress`, `done`, `skipped`), `completada`, `recordatorio_min`, `en_progreso_desde` (`DATETIME NULL`) |
| 5 | `Usuarios` | Cuentas y roles del sistema | `nombre`, `email UNIQUE`, `password_hash`, `rol ENUM('admin','psiquiatra')`, `estado ENUM('activo','inactivo','suspendido')` |
| 6 | `SesionesAuth` | Tokens de sesión opacos hasheados | `usuario_id FK CASCADE`, `token_hash CHAR(64) UNIQUE`, `expira_en DATETIME`, máx. **3 sesiones activas** por usuario |
| 7 | `CodigosSeguridad` | OTP de registro, recuperación y MFA | `email`, `tipo ENUM('registro','reset','mfa')`, `token_hash CHAR(64)`, `expira_en`, `usado`, `idx_codigo_email_tipo` |
| 8 | `ConfiguracionUsuario` | Configuración por usuario (`JSON`) | `usuario_id PK FK CASCADE`, `config_json LONGTEXT` (ntfy, Gemini key `pdh-s1:`, descarga Journal `pdh-s1:`, Planner, campus) |
| 9 | `RecordatoriosEstado` | Estado de entrega, snooze y `ack` | `UNIQUE(usuario_id, clave_unica)`, `estado ENUM('active','snoozed','sent','dismissed')`, `snooze_hasta`, `enviado_push_en` |
| 10 | `MusicaArtistas` | Artistas y agrupaciones musicales | `UNIQUE(usuario_id, nombre_normalizado)`, `tipo_artista ENUM('solo','group','duo','collab_project')` |
| 11 | `MusicaAlbumes` | Álbumes, mini álbumes, EPs y singles | `artista_principal_id FK SET NULL`, `tipo_lanzamiento` (`album`,`mini_album`,`ep`,`single`,`ost`,`collab_single`), `anio`, `fecha_lanzamiento` |
| 12 | `MusicaCanciones` | Metadatos de canciones (0 KB letras en BD) | `album_id FK SET NULL`, `numero_pista`, `yt_music_url`, `yt_video_id`, `estado_estudio` (`to_study`,`in_progress`,`mastered`), `enfoque_corto <= 255` |
| 13 | `MusicaCancionArtistas` | Relación M:N para `feat` y colaboraciones | `PRIMARY KEY(cancion_id, artista_id)`, `rol ENUM('main','feat','collab','producer')`, `orden` |
| 14 | `EstudioLecciones` | Progreso secuencial EN/KO (zero-bloat) | `idioma ENUM('en','ko')`, `codigo_leccion`, `nombre_practica`, `orden_secuencia`, `completada`, `UNIQUE(usuario_id, codigo_leccion)` |
| 15 | `SyncRevisions` | Contadores de revisión para SSE | `scope VARCHAR(40) PK` (`mood`, `sleep`, `crisis`, `agenda`, `planner`, `settings`, `music`, `journal`), `revision BIGINT`, `updated_at` |

---

## 4. Catálogo Completo de Endpoints API

> Salvo `/healthz`, `/api/transport/*` y endpoints públicos de autenticación/webhook firmado, todas las rutas aplican rate limiting por ventana, verificación de payload JSON (`limit: '512kb'`) y túnel cifrado opcional `X25519`.

| Módulo | Método y Ruta | Auth / Rol | Comportamiento principal |
| :--- | :--- | :--- | :--- |
| **Sistema / Sync** | `GET /healthz` | Público | Devuelve `200` JSON + headers `X-Replica-Id`, `X-App-Version` para Docker/Caddy. |
| | `GET /api/version` | `requireAuth` | Devuelve versión SemVer actual e historial reciente (`version-history.json`). |
| | `POST /api/transport/handshake` · `GET /api/transport/status` · `POST /api/transport/benchmark` | Público / `requireAuth` | Negocia clave efímera Curve25519 + HKDF y valida carga pesada sobre HTTP. |
| | `GET /api/sync/revisions` · `GET /api/sync/stream` | `requireAuth` | Instantánea de revisiones o flujo **SSE** en tiempo real (filtrado a 3 scopes si es `psiquiatra`). |
| | `GET /api/system/logs` | `requireAdmin` | Lista logs rotativos sanitizados recientes del servidor. |
| **Auth / RBAC** | `GET /api/auth/me` · `POST /api/auth/logout` | `requireAuth` / Cookie | Identidad activa (`rol`, `estado`) o cierre inmediato destruyendo token en `SesionesAuth`. |
| | `POST /api/auth/send-register-code` · `POST /api/auth/register` | Público + Verif. Admin | Registra usuario (`admin` solo si coincide con `ADMIN_EMAIL` verificando OTP o clave secreta). |
| | `POST /api/auth/login` · `POST /api/auth/verify-login-mfa` | Público | Verifica `bcryptjs` (12 rondas), estado activo, emite cookie `HttpOnly` (máx. 3 activas). |
| | `POST /api/auth/forgot-password` · `POST /api/auth/reset-password` | Público | Envía token temporal por Gmail SMTP y restablece contraseña. |
| | `GET /api/auth/medicos` · `POST /api/auth/create-medico` · `PATCH /api/auth/medicos/:id/estado` · `DELETE /api/auth/medicos/:id` | `requireAdmin` | CRUD y activación/suspensión inmediata de cuentas `psiquiatra`. |
| **Clínico (Mood / Sleep / Crisis)** | `POST /api/insert-mood` · `GET /api/get-moods` | `requireAdmin` / `requireAuth` | Registra o consulta estados de ánimo; `psiquiatra` solo lectura. |
| | `POST /api/insert-sleep` · `PATCH /api/update-sleep/:id` · `DELETE /api/delete-sleep/:id` · `GET /api/get-sleep` | `requireAdmin` / `requireAuth` | Sueño nocturno con despertar pendiente, `siesta`, auto-desvelo (`<7h` o `>=01:00`) y `desvelo_total`. |
| | `POST /api/insert-crisis` · `GET /api/get-crisis` · `DELETE /api/delete-crisis/:id` | `requireAdmin` / `requireAuth` | Registra crisis (soporta `Otro` con texto libre sin corchetes, máx. 250 chars en motivo). |
| | `GET /api/archive/drive-range` | `requireAuth` | Descarga temporalmente en RAM `historico_completo.json.gz` (3, 6 o 12 meses) y lo fusiona con MySQL. |
| **Diario E2EE y Word** | `POST /api/send-to-pc` · `GET /api/pull-text` | `requireAdmin` / `verifyPcBridgeAuth` | Encola/extrae texto cifrado `pdh-j2`; con `SERVER_AUTONOMOUS_NOTES=true` escribe en `Diario.docx` bajo lock `pdh_docx_journal`. |
| | `GET /api/journal/local-status` · `GET /api/journal/download` | `requireAdmin` | Reporta existencia/cifrado de `Diario.docx` o descarga copia cifrada OLE2 en crudo. |
| | `GET` / `POST /api/journal/download-encrypted` | `requireAdmin` | Descifra `Diario.docx` **solo en RAM** (`--mode journal-export-plain`), lo re-cifra con `pdh-j2` binario con salt (contraseña propia) y devuelve sobre para descifrar en navegador. |
| | `GET /api/journal/daily-status` · `POST /api/journal/verify-days` · `POST /api/journal/nothing-to-report` | `requireAdmin` | Verifica días escritos en `Diario.docx` (`--mode journal-inspect`) o registra días sin novedad. |
| **Agenda y Recordatorios** | `GET /api/get-agenda` · `POST /api/insert-agenda` · `PUT /api/update-agenda/:id` · `PATCH /api/toggle-agenda/:id` · `PATCH /api/postpone-agenda/:id` · `DELETE /api/delete-agenda/:id` | `requireAdmin` | Flujo tipo Jira (`todo`/`in_progress`/`done`/`skipped`), `en_progreso_desde` (silencio 1h), categorías `universidad`/`personal` y posposición por minutos/horas/días sin cambiar de vista. |
| | `GET /api/reminders/active` · `/api/reminders/pending` · `POST /api/reminders/snooze` · `POST /api/reminders/ack` · `POST /api/reminders/test-push` | `requireAdmin` | Bandeja activa/pendiente localizada al idioma (`EN`/`ES`), posposición, confirmación `OK` en app y push de prueba vía `lib/server-i18n.js`. |
| | `GET` / `POST /api/reminders/action` | HMAC SHA-256 o Cookie Admin | Ejecuta acciones desde botones `ntfy` móvil (`snooze`, `dismiss`, `skip`, `complete_agenda` y `ack` = **OK**). |
| **Planner ITS y GPS** | `GET` / `PUT /api/planner` · `POST /api/planner/sync-agenda` | `requireAdmin` | Horario ITS, campus/salones personalizados (CRUD en settings de planner), vacaciones, residencias/trabajo y sincronía a Agenda. |
| | `POST /api/planner/location` · `POST /api/planner/resolve-room` | `requireAdmin` | Guarda casa/ubicación origen o resuelve salón (`R11`, `N21`, `A10`, etc.) a campus exacto. |
| | `GET /api/planner/phone-gps-token` · `POST /api/planner/phone-gps-token/rotate` · `GET/POST /api/planner/phone-location` · `POST /api/planner/request-phone-gps` | `requireAdmin` / Token HMAC | Captura GPS móvil mediante token rotativo HMAC-SHA256 o ping profundo `ntfy`. |
| | `GET /api/planner/geocode-search` · `reverse-geocode` · `map-tile/:z/:x/:y.png` | `requireAdmin` | Búsqueda Nominatim y proxy seguro de mosaicos de mapa sin exponer origen. |
| **Idiomas, IA y Música** | `GET /api/english/study-notebook` · `POST /api/send-english` · `GET /api/pull-english` | `requireAdmin` / `verifyPcBridgeAuth` | Lee secciones/lecciones del cuaderno Word (`English_Learning_Notebook.docx`) o escribe entradas cifradas. |
| | `GET/POST /api/language/memory` · `GET/POST /api/language/alphabet-guide` · `GET /api/language/korean-practice-drive` · `POST /api/language/korean-symbol-compare` · `POST /api/language/romanize` | `requireAdmin` | Banco de memoria lingüística, guía Hangul y práctica interactiva. |
| | `GET /api/language/registry` · `POST /api/language/analyze` · `POST /api/language/test-gemini` · `POST /api/language/translate` · `POST /api/language/pronunciation` | `requireAdmin` | Motor dual Gemini API + fallback local determinista para EN/KO/K-Pop. |
| | `GET /api/language/lessons` · `PATCH /api/language/learning-toggle` · `POST /api/language/word-activity` · `POST /api/language/lessons/:id/generate-practice` · `PATCH /api/language/lessons/:id/complete` | `requireAdmin` | Gestión secuencial de lecciones (`EstudioLecciones`). |
| | `GET /api/english/music/catalog` · `search` · `POST /resolve` · `CRUD /songs/:id` · `CRUD /albums/:id` · `PATCH /artists/:id` | `requireAdmin` | Catálogo musical, resolución YouTube/YT Music y organización por Álbum/Pista. |
| | `POST /api/english/music/songs/:id/resolve-lyrics` · `extract` · `GET .../media` · `POST /translate-lyrics` | `requireAdmin` | Extracción de subtítulos `yt-dlp`, traducción completa y streaming `206` con validación SSRF. |
| | `GET /api/english/music/ytdlp-status` · `POST /pc-jobs` · `GET /pc-jobs/poll` · `POST /pc-jobs/:jobId/result` · `GET /pc-jobs/:jobId` · `pc-word-drive-*` | `requireAdmin` / `verifyPcBridgeAuth` | Puente HMAC síncrono en RAM hacia PC Windows (`sincronizador.py`). |
| **Ajustes** | `GET /api/settings` · `PUT /api/settings` · `PATCH /api/settings/language` · `POST /api/settings/test-notification` | `requireAdmin` | Guarda preferencias (`uiLanguage`, reglas Smart Commute, `geminiApiKey` y `journalDownloadPassword` cifrados `pdh-s1:` en reposo) y sincroniza idioma SSE entre dispositivos. |

---

## 5. Lógica de Negocio Crítica

### 5.1 Seguridad, Criptografía y Control de Secretos

1. **Autenticación y RBAC (`server.js`):**
   * Contraseñas con `bcryptjs` (`12` rondas); cookie de sesión `mt_session` (`HttpOnly; SameSite=Lax`, `Secure` bajo HTTPS) cuyo token crudo jamás se almacena en MySQL, solo su `sha256Hex` en `SesionesAuth`.
   * Expiración automática cada **domingo a las `00:00:00`**, límite estricto de **3 sesiones activas** por usuario (`pruneExcessUserSessions`), control de **pestaña única** en navegador (`BroadcastChannel('pdh_active_tab_channel_v1')` + handover automático cuando el usuario abre notificaciones `ntfy` con `fromNtfy=1`), y bloqueo RBAC (`requireAdmin`) que restringe al rol `psiquiatra` exclusivamente a lectura clínica (`get-moods`, `get-sleep`, `get-crisis`, `archive/drive-range`).
2. **Cabeceras HTTP, Anti-Autofill y Cero CDN:**
   * CSP estricto `script-src 'self'` (CryptoJS en `/vendor/crypto-js.min.js`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `REQUIRE_HTTPS=true` (responde HTTP `426` ante API sin TLS cuando está activo) y HSTS bajo proxy TLS.
   * **Bloqueo global anti-autofill:** Todos los inputs sensibles (llaves E2EE, contraseñas de descarga de Word, Gemini API Key) usan la clase `.secret-input-masked` (`type="text"` con `WebkitTextSecurity: disc`, `autocomplete="off"`, atributos `readonly` iniciales desbloqueados al foco), impidiendo que administradores de contraseñas del navegador capturen o sobrescriban llaves privadas.
3. **Túnel de Transporte Híbrido (`X25519 + HKDF-SHA256 + AES-256-CTR + HMAC-SHA256`):**
   * Implementado simétricamente entre [`public/transport-crypto.js`](../public/transport-crypto.js) y [`lib/transport-crypto.js`](../lib/transport-crypto.js) (`__enc: "x25519-aes256ctr-hmac-v1"`). Verifica HMAC con `crypto.timingSafeEqual` antes de descifrar y mantiene LRU anti-replay por sesión (`512` IVs).
4. **Cifrado E2EE `pdh-j2` con Salt (Escritura a Word y Descarga Segura en RAM):**
   * **Formato `pdh-j2`:** `pdh-j2:<iterations>:<saltHex32>:<ivHex32>:<macHex64>:<cipherB64>` utilizando `PBKDF2-HMAC-SHA256` (`120,000` iteraciones) → `64` bytes divididos en `encKey` (32 bytes AES-256-CBC) + `macKey` (32 bytes HMAC-SHA256 Encrypt-then-MAC).
   * **Escritura segura en `Diario.docx` ([`lib/server-notes-service.js`](../lib/server-notes-service.js) + [`lib/docx_writer.py`](../lib/docx_writer.py)):** La escritura en servidor coordina concurrencia entre contenedores/procesos mediante el lock distribuido MySQL `pdh_docx_journal` ([`lib/distributed-lock.js`](../lib/distributed-lock.js)) y descifra/re-cifra OLE2 con `msoffcrypto-tool`.
   * **Descarga cifrada en tránsito de `Diario.docx` (`GET`/`POST /api/journal/download-encrypted`):**
     * Jamás escribe copias sin cifrar de `Diario.docx` en disco. El subproceso Python `--mode journal-export-plain` (`export_decrypted_journal_docx`) descifra el OLE2 **exclusivamente en `io.BytesIO()` en RAM**, valida firma ZIP `PK\x03\x04` + `word/document.xml` y entrega Base64 por stdout a Node.js.
     * Node.js cifra el `Buffer` binario en RAM con `encryptJournalSaltedBytesE2ee(docxBuf, downloadPassword)` usando la **contraseña elegida por el usuario (8–128 caracteres)** (guardada opcionalmente en `ConfiguracionUsuario` bajo `pdh-s1:` AES-256-GCM o provista al vuelo en el modal `#journalDownloadPasswordModal`), limpia el buffer plano (`docxBuf.fill(0)`), y el navegador (`desencriptarDiarioBytesSaltedE2EE` en WebCrypto o fallback CryptoJS) descifra los bytes en el dispositivo y dispara la descarga como `.docx` estándar listo para abrir en Word en PC o celular.
   * **Cero secretos planos en servidor:** En producción (`SEAL_ENV_AFTER_DEPLOY=true`), `deploy.yml` inyecta variables únicamente desde RAM (`/dev/shm`), usa `SUDO_ASKPASS` temporal y destruye todo con `shred` al concluir.

### 5.2 Sincronización en Tiempo Real SSE (`SyncRevisions`)

* Mantiene **8 scopes** en `SyncRevisions` (`mood`, `sleep`, `crisis`, `agenda`, `planner`, `settings`, `music`, `journal`); las sesiones con rol `psiquiatra` solo reciben los 3 scopes clínicos (`mood`, `sleep`, `crisis`).
* **Cero carga en reposo (`0 queries/seg`):** Cuando no hay clientes SSE conectados (`sseClients.size === 0`), `stopSyncTimersIfIdle()` detiene por completo los temporizadores de polling (`3s`) y heartbeat (`25s`).
* En el navegador (`public/frontend.js`), al cambiar a segundo plano (`visibilitychange` oculta la pestaña), el cliente pausa/cierra la conexión SSE activa y re-sincroniza inmediatamente vía `/api/sync/revisions` al volver a primer plano.

### 5.3 Planner ITS, Maps, CRUD Campus/Salones, Materias (`pausa`/`promedio`) y Alertas Inteligentes `ntfy`

* **Gestión manual de campus y materias:** Alta, edición y eliminación dinámica de **campus y salones** desde UI (`#itsCroquisDirectoryCards`), conservando compatibilidad backend de ubicaciones previas en `/api/planner/location` (sin bloque fijo de 3 botones en `#view-horario`). Cada materia soporta `remindersPaused` (pausa avisos de clase/traslado), `completed` (pausa automática al aprobar) y `finalGrade` (`0–100`) con cálculo del promedio semestral en `#plannerSemesterAverageBadge`.
* **Regla de 1 hora en tareas `en_progreso` (`en_progreso_desde`):** Al pasar a `in_progress`, silencia avisos normales previos/puntuales y envía 1 seguimiento al cumplirse `>= 60 min`.
* **Protección Anti-Null-Island `(0,0)` y GPS Móvil:** Rechaza coordenadas inválidas o `(0,0)`, prioriza pines exactos `!3d...!4d...` en enlaces de Google Maps y soporta captura GPS desde el celular incluso fuera de contexto seguro mediante webhook firmado HMAC (`GET`/`POST /api/planner/phone-location`) y ping profundo `ntfy`.
* **Hitos adaptativos por zona (`computeSmartCommuteAlertSchedule` configurables en `#view-settings`):** Dado el tiempo estimado de traslado `T` (minutos):
  * **En Casa o Lejos (`zone: 'home' | 'away'`):** inicia en `T + commuteExtraBufferMinutes` (`T + 30 min` por defecto) y repite cada `commuteRepeatEveryMinutes` (`5 min` por defecto: ej. `41, 36, 31, ..., 1 min` antes) hasta confirmar `OK` o iniciar la clase/turno.
  * **Cerca del destino (`zone: 'near'`, radio `<= commuteNearRadiusKm`, def. `0.5 km`):** dispara recordatorios cortos configurados en `commuteNearAlertMinutes` (por defecto `20, 15, 10` min antes) hasta confirmar `OK` o iniciar.
* **Confirmación `OK` en `ntfy` (`action=ack`) y localización `EN/ES`:** Cada notificación se genera en el idioma activo (`uiLanguage` vía `lib/server-i18n.js`) e incluye botones traducidos (`OK`, `Mark done` / `Marcar hecha`, `Snooze 15m` / `Posponer 15m`, etc.). Al confirmar **`OK`**, el servidor detiene avisos restantes de ese turno hoy y reemplaza alertas previas equivalentes.

### 5.4 Sueño, Crisis y Resumen Semanal

* **Sueño (`RegistrosSleep`):**
  * Soporta **despertar pendiente**: registrar la hora al acostarse (`hora_dormir`) y completar al levantarse mediante `PATCH /api/update-sleep/:id`.
  * Clasificación automática de **desvelo (`desvelo_tarde`)** cuando las horas dormidas son menores a `sleepMinNormalHours` (`7` h por defecto) o la hora de dormir es `>= sleepDesveloBedtimeTime` (`01:00` AM hasta las `05:59` AM), además de **`desvelo_total`** (`0` horas) y **`siesta`** (siesta diurna que no sobreescribe ni distorsiona el sueño nocturno principal).
* **Crisis (`RegistrosCrisis`):** Selección rápida de intensidad `1–5`, botón `⏱️ Now`, y al elegir **`Otro`**, el campo específico reemplaza directamente el tipo en BD **sin encerrarlo entre corchetes** (ej. `"Saturación sensorial"` en lugar de `"Otro [Saturación sensorial]"`).
* **Resumen Semanal (`#view-resumen`):** Ventana semanal fija **Lunes a Domingo**, selector de calendario diario/semanal y consulta temporal en RAM de 3/6/12 meses desde Drive.

### 5.5 UX del Frontend (`public/`)

* **Modo Oscuro Permanente (`data-theme="dark"`)** e internacionalización completa **EN ↔ ES** (`i18n.js` + `X-UI-Lang`).
* **Navegación nativa sin perder flujo:** Uso de `history.pushState` / `popstate` (botón Atrás del navegador/Android funcional entre vistas) con regreso limpio a **Inicio** al recargar página, **swipe-to-close** táctil en el menú lateral móvil (`initSidebarSwipeGesture`) e íconos adaptativos en barra inferior/cabecera móvil.
* **Scroll lock global en modales y traductor:** Clase `.modal-scroll-locked` combinada con `overscroll-behavior: contain` impide que el fondo se desplace mientras interactúas con modales o el cajón traductor (`Alt+T`).
* **Visor simplificado del Cuaderno (`#view-english`):** Búsqueda directa de texto (`#studyViewerSearchInput`), filtro único por sección (`#studyViewerSectionFilter`), actualización con ícono SVG (`#btnRefreshStudyViewer`) y acceso directo desde Learn with Music (`#btnOpenStudyViewerFromMusic`).

---

## 6. Infraestructura, CI/CD Blue-Green, Costos, Dual Drive, Migración y Recreación desde Cero

### 6.1 Host Ubuntu Server y Seguridad Automatizada

* **Sistema objetivo:** Ubuntu Server 24.04 / 26.04 LTS (`8 GB RAM`, disco amplio para retención `DB_RETENTION_DAYS=0`), **2 GB de Swap (`/swapfile`)** con `vm.swappiness=10` para evitar thrashing.
* **Red y túnel:** Tailscale OAuth (`tag:ci` para runner de GitHub Actions y `tag:server` en servidor) + `tailscale serve --bg --https=443 http://127.0.0.1:8080`, UFW en `default deny incoming`, OpenSSH sin contraseñas (`PasswordAuthentication no`, `AllowUsers`), `fail2ban` en `sshd`, `unattended-upgrades`, `net.ipv4.tcp_syncookies=1`, `/proc` con `hidepid=2` y monitoreo `auditd` sobre archivos críticos (`Diario.docx`, `rclone.conf`, `authorized_keys`, `sudoers.d`).

### 6.2 Matriz Completa de Variables de Entorno, Secrets y Variables GitHub

| Nombre | Ubicación | Default | Propósito |
| :--- | :--- | :--- | :--- |
| `SERVER_HOST` / `EC2_HOST` | Variable / Env | *(requerido)* | Dominio MagicDNS (`*.ts.net`) o IP del servidor destino SSH. |
| `SERVER_USER` / `EC2_USER` | Variable / Env | *(requerido)* | Usuario SSH en Ubuntu Server (ej. tu resultado de `whoami`). |
| `SERVER_SSH_PORT` | Variable | `22` | Puerto SSH del servidor remoto. |
| `SERVER_SSH_KEY` / `EC2_SSH_KEY` | **Secret** | *(requerido)* | Llave privada SSH Ed25519/PEM autorizada para GitHub Actions. |
| `SERVER_SUDO_PASS` / `SUDO_PASS` | **Secret** | *(si no hay NOPASSWD)* | Contraseña `sudo` usada solo en RAM vía `SUDO_ASKPASS` (`shred` al salir). |
| `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET` | Variable / **Secret** | *(opcional OAuth)* | Autenticación efímera del runner CI dentro de la tailnet (`TS_TAGS=tag:ci`). |
| `TS_AUTHKEY` | **Secret** *(opcional)* | *(vacío)* | Alternativa a OAuth para registrar runner en Tailscale. |
| `DB_HOST` · `DB_USER` · `DB_NAME` · `DB_PASS` | Vars + **Secret** | `db` / `root` / `MoodTrackerLocal` | Conexión de Node a `mood_db`; `DB_PASS` solo en Secrets. |
| `PORT` · `BLUE_PORT` · `GREEN_PORT` | Variable / Env | `3000` / `3001` / `3002` | Puerto interno Node y puertos loopback del slot Blue y Green. |
| `PROXY_HTTP_PORT` · `PROXY_HTTPS_PORT` · `SITE_ADDRESS` | Variable / Env | `8080` / `8443` / `:80` | Puertos loopback de Caddy (`mood_proxy`) y dirección escuchada. |
| `APP_BASE_URL` · `TRUST_PROXY` · `REQUIRE_HTTPS` · `CORS_ALLOWED_ORIGINS` | Variable / Env | `https://*.ts.net` / `2` / `true` | Seguridad TLS detrás de Tailscale Serve → Caddy (`trust proxy 2`). |
| `ADMIN_EMAIL` · `ADMIN_SECRET` | Var + **Secret** | *(requerido)* | Correo único del propietario (`admin`) y secreto de primer registro. |
| `SMTP_USER` · `SMTP_PASS` | Var + **Secret** | *(requerido)* | Cuenta Gmail emisora y App Password de 16 caracteres (OTP/reset/MFA). |
| `ENABLE_LOGIN_MFA` | Variable / Env | `false` | Activa segundo factor OTP por correo al iniciar sesión. |
| `WORD_PASSWORD` · `JOURNAL_SECRET_KEY` | **Secret** | *(requerido)* | Contraseña OLE2 de `Diario.docx` y llave E2EE de 32 bytes. |
| `REQUIRE_PC_BRIDGE_AUTH` · `SERVER_AUTONOMOUS_NOTES` | Variable / Env | `true` / `true` | Firma HMAC en puente PC y escritura autónoma de `.docx` en servidor. |
| `GEMINI_API_KEY` · `YOUTUBE_API_KEY` | **Secret** *(opc.)* | *(vacío)* | Clave de Google Gemini API (override/respaldo env) y API pública YT opcional. |
| `RCLONE_REMOTE` · `RCLONE_BACKUP_DIR` · `RCLONE_CONF_B64` | Vars + **Secret** | `gdrive` / `RespaldosApp` | Drive 1 (BD SQL + `historico_completo.json.gz`). |
| `STUDY_RCLONE_REMOTE` · `STUDY_RCLONE_DIR` · `STUDY_RCLONE_CONF_B64` | Vars + **Secret** | *(vacío)* / `NotasIdiomas` | Drive 2 opcional exclusivo para `English_Learning_Notebook.docx`. |
| `DB_RETENTION_DAYS` · `LOCAL_SQL_DAILY_BACKUP_DAYS` · `LOCAL_WORD_BACKUP_DAYS` | Variable / Env | `0` / `180` / `365` | `0` = retención ilimitada en MySQL; retención de respaldos locales en días. |
| `BACKUP_CRON_SCHEDULE` · `TZ` · `YT_DLP_PATH` | Variable / Env | `30 3 * * *` / `America/Monterrey` | Horario cron de respaldo nocturno, zona horaria y ruta `yt-dlp`. |
| `AUTO_CONFIGURE_SERVER` · `UFW_CLOSE_LAN_SSH` · `ENABLE_TAILSCALE_SERVE` | Variable | `true` / `false` / `true` | Activa hardening completo Ubuntu, firewall UFW y `tailscale serve`. |
| `DISABLE_SYSTEM_SLEEP` · `IGNORE_LID_SWITCH` · `ENABLE_UFW` · `ENABLE_SSH_HARDENING` · `ENABLE_FAIL2BAN` · `ENABLE_UNATTENDED_UPGRADES` · `ENABLE_KERNEL_DOS_HARDENING` · `ENABLE_PROC_HIDEPID` · `ENABLE_AUDITD` | Variables | Heredan `AUTO_CONFIGURE_SERVER` (`auto` en tapa) | Permiten encender/apagar de forma granular cada medida en `deploy.yml`. |
| `RELEASE_PUSH_TO_MAIN` · `SEAL_ENV_AFTER_DEPLOY` · `RUN_POST_DEPLOY_VERIFY` | Variables | `false` / `true` / `true` | `false` evita error `GH013` en `main` protegida (solo etiqueta tag); destruye `/dev/shm` env y corre `[1/10]`–`[10/10]`. |

### 6.3 Flujo CI/CD, Blue-Green, Auto-Versionado SemVer y Rollback en 1 Clic

1. **Integración Continua ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)):** En cada `push` fuera de `main` y en PR hacia `main`, valida sintaxis (`node --check`, `bash -n`, `python3 ast.parse`, `ruby -ryaml`), ejecuta `tests/*.test.js` y genera tabla resumen en `$GITHUB_STEP_SUMMARY` (`tests/ci-summary.js`).
2. **Despliegue Blue-Green Cero-Caída ([`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)):**
   * **Job `release`:** Ejecuta `node scripts/release-version.js --apply --github-output`. Con `RELEASE_PUSH_TO_MAIN=false` (predeterminado en `main` protegida contra pushes directos), evita el bloqueo `GH013` creando directamente el **tag Git `vX.Y.Z`** y GitHub Release sobre el commit fusionado y enviando `APP_VERSION` y `RELEASE_HISTORY_B64` al despliegue.
   * **Job `deploy`:** Conecta por Tailscale OAuth + SSH, configura Swap 2 GB / dependencias, actualiza repo preservando `./data/` y `./english-notes/`, genera env temporal exclusivamente en `/dev/shm`, compila 1 sola imagen (`BLUE_IMAGE_TAG="v${APP_VERSION}" docker compose build app_blue`), etiqueta el slot standby (`blue` o `green`), levanta `db` + `./scripts/restore.sh --if-empty`, arranca el slot inactivo, corre **smoke test estricto** sobre `/healthz`, `/` y `/vendor/crypto-js.min.js`, ejecuta el corte atómico `./scripts/blue-green.sh switch <standby> "v${APP_VERSION}"` (recargando Caddy), conserva las últimas **3 imágenes `v*`** para rollback offline, configura crons (`backup.sh`, `yt-dlp -U` y `apt-get upgrade` semanal), aplica hardening del host, destruye temporales `/dev/shm` con `shred` y valida `[1/10]`–`[10/10]` con `./scripts/verify-ubuntu-local.sh`.
3. **Rollback en 1 Clic ([`.github/workflows/rollback.yml`](../.github/workflows/rollback.yml)):**
   * **`instant-switch`:** Ejecuta `./scripts/blue-green.sh rollback` en ~5 segundos devolviendo todo el tráfico de Caddy al otro slot que permaneció en *warm standby*.
   * **`specific-tag`:** Indica cualquier tag `vX.Y.Z`, compila desde un `git worktree` temporal sobre el slot inactivo, corre smoke test y realiza el switch atómico.

### 6.4 Dependencias, Licencias y Costos (**Gratuito** vs **Pago**)

| Componente / Servicio | Uso en el proyecto | Clasificación | Costo real estimado |
| :--- | :--- | :--- | :--- |
| **Node.js 20 + Express 5 + `mysql2` + `bcryptjs` + `nodemailer`** | Backend API, SSE, autenticación y seguridad | **Gratuito** (Open Source MIT) | \$0 USD permanente. |
| **MySQL 8.0 + Caddy v2 + Docker Engine/Compose** | Base de datos, proxy inverso Blue-Green y contenedores | **Gratuito** (GPL / Apache-2.0) | \$0 USD autohospedado. |
| **Python 3 + `msoffcrypto-tool` + `yt-dlp` + `ffmpeg` + `rclone`** | Cifrado OLE2 Word en RAM, extractor CC y backups Drive | **Gratuito** (MIT / Unlicense / GPL) | \$0 USD. |
| **Tailscale (Plan Personal) + `ntfy.sh` + Gmail SMTP** | Túnel HTTPS WireGuard privado, push móvil y correos OTP | **Gratuito** (capas personales) | \$0 USD dentro de cuota personal (planes **Pago** solo empresariales). |
| **Google Gemini API (`GEMINI_API_KEY`)** | Análisis lingüístico y traducción asistida | **Gratuito** (tier free AI Studio) / **Pago** | \$0 USD en tier gratuito; **Pago** por token solo si activas facturación. |
| **Hardware / Alojamiento Cloud (PC Ubuntu vs AWS/GCP VPS)** | Servidor donde corren Docker y MySQL 24/7 | **Gratuito** (PC local o GCP `e2-micro` Free Tier) / **Pago** | \$0 USD en PC propia o `e2-micro` Always Free; **Pago** (\~\$5–\$12 USD/mes) en VPS comercial o instancias superiores. |
| **Dominio propio (`.com` / `.dev`)** | Opcional si reemplazas `*.ts.net` en internet pública | **Gratuito** (MagicDNS / DuckDNS) / **Pago** | \$0 USD con Tailscale MagicDNS; **Pago** (\~\$10–\$15 USD/año) por dominio propio. |

### 6.5 Arquitectura Dual Drive Independiente (`rclone`)

| Canal | Variables | Contenido | Aislamiento estricto |
| :--- | :--- | :--- | :--- |
| **Drive 1 (Sistema / BD)** | `RCLONE_REMOTE`, `RCLONE_BACKUP_DIR`, `RCLONE_CONF_B64` | `respaldo_mood_tracker.sql.gz`, `historico_completo.json.gz`, `historico_sql/respaldo_YYYY-MM.sql.gz` | Permite consulta histórica bajo demanda en RAM (`/api/archive/drive-range`). **Nunca** incluye `Diario.docx`. |
| **Drive 2 (Estudio de Idiomas)** | `STUDY_RCLONE_REMOTE`, `STUDY_RCLONE_DIR`, `STUDY_RCLONE_CONF_B64` | Exclusivamente `English_Learning_Notebook.docx` | Código con bloqueo explícito: **jamás** sube `Diario.docx` bajo ningún parámetro. |

### 6.6 Migración Cloud-Agnostic (Ubuntu Local, Google Cloud Platform / GCP, AWS, VPS)

El código no contiene IPs, contraseñas ni rutas personales fijas:
1. Antes de apagar el servidor anterior, ejecuta `./scripts/backup.sh --require-drive` y respalda localmente `./data/journal/Diario.docx`.
2. Prepara cualquier host **Ubuntu 24.04/26.04 LTS** nuevo —sea PC física local, VM **Google Cloud Platform (`GCP` `e2-micro` / `e2-small`)**, AWS EC2 o VPS— instalando **Docker + Compose v2**, **Tailscale** y copiando tu llave SSH pública + `./data/journal/Diario.docx`.
3. Actualiza únicamente `SERVER_HOST` (o `EC2_HOST`), `SERVER_USER` (si cambió el usuario) y opcionalmente `TS_OAUTH_CLIENT_ID` en GitHub Repository Variables.
4. Ejecuta el workflow **Deploy (`deploy.yml`)**: el nuevo servidor levantará `mood_db`, descargará automáticamente el respaldo desde Drive (`./scripts/restore.sh --if-empty`), restaurará las **15 tablas** y quedará operativo en Blue-Green sin tocar código.

### 6.7 Guía Paso a Paso para Recrear Todo el Proyecto desde Cero

1. **Clonar e instalar localmente:**
   ```bash
   git clone https://github.com/<usuario>/<repo>.git
   cd <repo>
   npm ci
   cp .env.example .env
   ```
2. **Generar llaves y secretos locales (`npm test` antes de tocar producción):**
   * Genera `JOURNAL_SECRET_KEY` (32 caracteres exactos), `WORD_PASSWORD`, `DB_PASS`, `ADMIN_SECRET`, `ADMIN_EMAIL`, `SMTP_USER` y `SMTP_PASS` (Google App Password).
   * Sella tu `.env` en bóveda local: `node scripts/local-vault.js encrypt` y valida con `npm test` (o `npm.cmd test` en PowerShell).
3. **Configurar `rclone` y cuentas externas:**
   * Ejecuta `rclone config` para crear el remoto `gdrive` (Drive 1), valida `rclone lsf gdrive:RespaldosApp` y exporta `base64 -w 0 ~/.config/rclone/rclone.conf` al Secret `RCLONE_CONF_B64`. Opcionalmente crea un segundo remoto para `STUDY_RCLONE_CONF_B64`.
4. **Preparar el servidor Ubuntu (o VM en GCP):**
   * Instala Docker oficial y Tailscale (`curl -fsSL https://get.docker.com | sudo sh` y `curl -fsSL https://tailscale.com/install.sh | sh`), habilita MagicDNS + HTTPS Certificates + cliente OAuth (`tag:ci`) en Tailscale Admin Console.
   * Copia tu archivo inicial `Diario.docx` (cifrado con `WORD_PASSWORD`) a `~/projects/mood-tracker/data/journal/Diario.docx` (`chmod 600`) y tu `English_Learning_Notebook.docx` (si ya tienes historial previo) a `~/projects/mood-tracker/english-notes/`.
5. **Cargar GitHub Variables y Secrets → Merge / Run workflow `deploy.yml`:**
   * Carga las variables y secrets de la Sección 6.2 en GitHub Settings → Actions.
   * Lanza el despliegue a `main` y verifica que termine con éxito el resumen `[1/10]`–`[10/10]` de `./scripts/verify-ubuntu-local.sh`.
6. **Verificación final en producción:**
   * Accede por `https://<servidor>.<tailnet>.ts.net`, registra la cuenta única de Administrador (`ADMIN_EMAIL` + `ADMIN_SECRET` / OTP), activa `ntfy` en Settings, configura opcionalmente la contraseña de descarga cifrada de tu `Diario.docx` y confirma `./scripts/blue-green.sh status`.

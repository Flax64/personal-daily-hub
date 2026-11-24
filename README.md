# Personal Daily Hub

Plataforma web full-stack responsiva (**PC, Tablet y Móvil**) en **Modo Oscuro Permanente** e idioma **Bilingüe (`EN` ↔ `ES`)**, optimizada para **Ubuntu Server (8 GB RAM) + Tailscale Serve HTTPS + Caddy Blue-Green (`mood_app_blue` / `mood_app_green`) + MySQL 8**, para control diario de estado de ánimo, sueño y siestas, bitácora de crisis, diario privado E2EE con descarga cifrada en `.docx`, estudio de idiomas con IA, agenda semanal tipo Jira y planificador ITS con alertas inteligentes en `ntfy`.

---

## 📑 Índice de Contenidos

* [✨ Funcionalidades Actuales](#-funcionalidades-actuales)
* [🛠️ Arquitectura y Stack Tecnológico](#️-arquitectura-y-stack-tecnológico)
* [📁 Estructura Real del Repositorio](#-estructura-real-del-repositorio)
* [📚 Guías del Proyecto](#-guías-del-proyecto)
* [🚀 Inicio Rápido, Despliegue Blue-Green y Rollback](#-inicio-rápido-despliegue-blue-green-y-rollback)
* [🗄️ Base de Datos, API y Seguridad](#-base-de-datos-api-y-seguridad)

---

## ✨ Funcionalidades Actuales

1. **🧭 Inicio y Sync en Tiempo Real (`SyncRevisions` SSE):** Resumen del día, bandeja de recordatorios activos y sincronización instantánea entre sesiones PC y celular vía **Server-Sent Events (`GET /api/sync/stream`)** con pausa automática cuando la pestaña pasa a segundo plano (`0` queries en reposo), navegación con historial (`pushState`/`popstate`) con retorno a Inicio al recargar y *swipe-to-close* en el menú lateral móvil.
2. **🧠 Mood Tracker (`#view-mood`):** Registro por franja (`Madrugada`, `Morning`, `Noon`, `Afternoon`, `Night`) con 16 emociones/colores y recordatorios automáticos configurables.
3. **🌙 Sueño Nocturno, Siestas y Desvelos (`#view-sueno`):** Registro nocturno con despertar pendiente (`PATCH /api/update-sleep/:id`), soporte separado para **Siestas (`siesta`)**, clasificación automática de desvelo (`<7h` o `>=01:00`) y **Desvelo Total (`0 hrs`)**.
4. **⚠️ Bitácora Clínica de Crisis (`#view-crisis`):** Registro rápido (`⏱️ Now`), intensidad `1–5`, categoría **`Otro`** libre **sin corchetes**, motivo opcional (`250` caracteres) y visibilidad en **solo lectura** para cuenta médica (`psiquiatra`).
5. **🖋️ Diario Privado E2EE + Descarga Segura `.docx` (`#view-journal`):** Redacción en inglés cifrada con esquema **`pdh-j2`** (PBKDF2-HMAC-SHA256 `120,000` iter + AES-256-CBC + HMAC-SHA256) hacia `Diario.docx` (protegido con `WORD_PASSWORD`, coordinado bajo lock distribuido `pdh_docx_journal` y jamás guardado en MySQL ni Google Drive). Incluye botón de **descarga cifrada en tránsito** (`GET`/`POST /api/journal/download-encrypted`) descifrado estrictamente en **memoria RAM** (`--mode journal-export-plain`) con contraseña propia configurable (`8–128` caracteres) y guardado en el dispositivo como `.docx` listo para Microsoft Word.
6. **📖 Language Studio, Visor Simplificado y Learn with Music (`#view-english`):** Estudio **EN → ES** y **KO → EN** (Romanización Hangul), traductor flotante movible (`Alt + T`) + popup `/translator-popup.html` con bloqueo global de scroll de fondo, **visor simplificado del Cuaderno Word** (búsqueda + filtro por sección + ícono SVG de recarga), motor dual Gemini API / local y catálogo musical en carpetas estilo Windows 11.
7. **🗓️ Agenda Semanal (`#view-agenda`) y 🎓 Planner ITS + Maps (`#view-horario`):** Eventos/tareas (`universidad` / `personal`) con workflow Jira (**To Do / In Progress / Done / Skipped**), **CRUD dinámico de campus y salones ITS**, coordenadas oficiales sobre bulevares, captura GPS móvil HMAC, hitos de alerta inteligentes por zona (`Casa`, `Lejos`, `Cerca`) y botón **`OK`** en `ntfy` que confirma y silencia avisos del turno actual.
8. **📈 Resumen Semanal (Lunes–Domingo) y Settings (`#view-resumen`, `#view-settings`):** Semana fija **Lunes a Domingo**, consulta histórica en RAM desde Drive (`3/6/12` meses), control anti-autofill global (`.secret-input-masked`), gestión de cuenta `psiquiatra` (`#view-medico`) y historial automático SemVer `vX.Y.Z` (`GET /api/version`).

---

## 🛠️ Arquitectura y Stack Tecnológico

* **Red Privada y Proxy Blue-Green:** **Tailscale Serve (TLS 1.3)** → **Caddy (`mood_proxy`)** en `127.0.0.1:8080` con conmutación atómica hacia **`mood_app_blue` (`127.0.0.1:3001`)** o **`mood_app_green` (`127.0.0.1:3002`)** (solo el slot activo ejecuta schedulers).
* **Backend y Criptografía:** **Node.js 20**, **Express 5**, `mysql2`, `bcryptjs`, `nodemailer`, túnel **`X25519 + AES-256-CTR + HMAC-SHA256`**, locking MySQL (`GET_LOCK`) y motor **Python 3 + `msoffcrypto-tool`** en RAM.
* **Frontend:** HTML5, CSS3 (Modo Oscuro Permanente, móvil/tablet/PC), Vanilla JS CSP-safe (`script-src 'self'`), `/vendor/crypto-js.min.js` local (0 CDN externos) y diccionario `i18n.js` (`EN` ↔ `ES`).
* **Base de Datos y Respaldos:** **MySQL 8.0** (`mood_db`, 15 tablas en `init.sql`) + **Dual Drive** (`rclone` para SQL/archivo histórico en `gdrive` y cuaderno de estudio opcional en `STUDY_RCLONE_REMOTE`).

---

## 📁 Estructura Real del Repositorio

```text
personal-daily-hub/
├── .github/workflows/
│   ├── ci.yml                     # Lint y pruebas automatizadas en ramas y PRs hacia main
│   ├── deploy.yml                 # SemVer 2.0.0, Tailscale OAuth, build Blue-Green y hardening Ubuntu
│   └── rollback.yml               # Rollback 1-clic (instant-switch o tag SemVer vX.Y.Z)
├── guides/                        # 5 guías vigentes (versionadas en Git, fuera de Docker)
│   ├── GUIA_TECNICA_UNIFICADA.md
│   ├── GUIA_COMANDOS.md
│   ├── GUIA_COMANDOS_RAPIDOS.md
│   ├── GUIA_INSTALACION_UBUNTU_SERVER_26.md
│   └── MANUAL_DE_USUARIO.md
├── lib/                           # Módulos Node y Python (locks, crypto, docx_writer, IA, yt-dlp)
├── public/                        # SPA estática CSP-safe + /vendor/crypto-js.min.js
├── scripts/                       # blue-green.sh, backup.sh, restore.sh, env-vault.sh, local-vault.js, verify-ubuntu-local.sh
├── sincronitation/                # Cliente Windows DPAPI opcional (sincronizador.py, yt_lyrics_helper.py)
├── tests/                         # Suite node:test (integración, notas, locks, sintaxis y docs)
├── Caddyfile
├── Dockerfile
├── docker-compose.yml
├── init.sql
└── server.js
```

---

## 📚 Guías del Proyecto

| Guía | Contenido principal | Enlace |
| :--- | :--- | :--- |
| **Guía Técnica Unificada** | Arquitectura Blue-Green, 15 tablas MySQL, catálogo API, lógica de negocio, costos (**Gratuito** vs **Pago**), Dual Drive y recreación desde cero | [guides/GUIA_TECNICA_UNIFICADA.md](guides/GUIA_TECNICA_UNIFICADA.md) |
| **Guía Completa de Comandos** | Manual por entorno (**Git Bash** y **Linux/Ubuntu Server**) con descripción, casos de uso y tablas de parámetros/banderas | [guides/GUIA_COMANDOS.md](guides/GUIA_COMANDOS.md) |
| **Guía de Comandos Rápidos** | Cheatsheet copy-paste con puros comandos para Git, Blue-Green, Tailscale, MySQL/`rclone`, bóveda, diagnóstico y Windows | [guides/GUIA_COMANDOS_RAPIDOS.md](guides/GUIA_COMANDOS_RAPIDOS.md) |
| **Instalación Ubuntu Server** | Instalación mínima Ubuntu Server, llaves SSH, Docker, Tailscale OAuth, variables GitHub y verificación `[1/10]`–`[10/10]` | [guides/GUIA_INSTALACION_UBUNTU_SERVER_26.md](guides/GUIA_INSTALACION_UBUNTU_SERVER_26.md) |
| **Manual de Usuario** | Uso paso a paso de todas las pantallas, descarga cifrada del Diario, Sueño/Siestas, Planner ITS, `ntfy` y atajos | [guides/MANUAL_DE_USUARIO.md](guides/MANUAL_DE_USUARIO.md) |

---

## 🚀 Inicio Rápido, Despliegue Blue-Green y Rollback

### Entorno Local (Desarrollo y Pruebas)
```bash
npm ci
cp .env.example .env
# Completa .env y sella secretos en .env.enc:
node scripts/local-vault.js encrypt

# Arrancar servidor sin dejar .env en disco y correr suite de pruebas:
node scripts/local-vault.js run node server.js
npm test   # En Windows PowerShell usar: npm.cmd test
```

### Despliegue Blue-Green y Rollback en 1 Clic
1. Fusiona tus cambios a `main`: `.github/workflows/deploy.yml` calcula la versión SemVer 2.0.0 (`vX.Y.Z` sin empujar commits sobre `main` protegida), compila y prueba el slot standby (`blue` ↔ `green`), cambia `Caddy` con `./scripts/blue-green.sh switch`, destruye archivos temporales `/dev/shm` y ejecuta `./scripts/verify-ubuntu-local.sh`.
2. **Rollback instantáneo:** desde GitHub Actions → **Rollback Blue-Green (`rollback.yml`) → Run workflow**, elige `instant-switch` (~5 s sin recompilar) o `specific-tag` (`vX.Y.Z`), o ejecuta en el servidor `./scripts/blue-green.sh rollback`.

---

## 🗄️ Base de Datos, API y Seguridad

* **15 Tablas en `init.sql`:** `RegistrosMood`, `RegistrosSleep`, `RegistrosCrisis`, `RegistrosAgenda`, `Usuarios`, `SesionesAuth`, `CodigosSeguridad`, `ConfiguracionUsuario`, `RecordatoriosEstado`, `MusicaArtistas`, `MusicaAlbumes`, `MusicaCanciones`, `MusicaCancionArtistas`, `EstudioLecciones` y `SyncRevisions` (+ migraciones automáticas idempotentes al iniciar `server.js`).
* **Seguridad Multicapa:** `bcryptjs` (12 rondas), cookies `HttpOnly` hasheadas SHA-256 (máx. 3 sesiones activas, expiración domingo `00:00`), RBAC (`admin` vs `psiquiatra` solo lectura), CSP estricta `script-src 'self'`, `REQUIRE_HTTPS=true`, protección anti-autofill (`.secret-input-masked`), cifrado `pdh-j2` en notas y descargas `.docx` en RAM, lock distribuido MySQL `pdh_docx_journal` y puertos enlazados exclusivamente a `127.0.0.1`.
* **Catálogo completo de endpoints y variables:** Ver [guides/GUIA_TECNICA_UNIFICADA.md](guides/GUIA_TECNICA_UNIFICADA.md#4-catálogo-completo-de-endpoints-api).

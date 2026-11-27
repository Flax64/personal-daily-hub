require('dotenv').config();
const dns = require('node:dns');
if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
}
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { EventEmitter } = require('node:events');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const {
    TRANSPORT_PROTOCOL,
    createTransportManager
} = require('./lib/transport-crypto');
const {
    RECOMMENDED_GEMINI_MODELS,
    DEFAULT_CURRICULUM_LESSONS,
    ALPHABET_COMPOSITION_GUIDES,
    KOREAN_PRACTICE_DRIVE_FOLDER_ID,
    KOREAN_PRACTICE_DRIVE_URL,
    KOREAN_PRACTICE_DRIVE_DOC_NAME,
    KOREAN_PRACTICE_DRIVE_NOTES,
    compareAndAnalyzeKoreanSymbols,
    extractKoreanPracticeParagraphsFromDocx,
    getLanguageRegistry,
    getLanguageSectionMeta,
    normalizeStudyLanguage,
    validateGeminiModelId,
    hangulToRomanization,
    hasJapaneseScript,
    kanaToRomaji,
    detectScriptKind,
    isPoisonedMemoryMeaning,
    sanitizeLanguageMemory,
    mergeLanguageMemory,
    normalizeTranslationDirection,
    analyzeTextOffline,
    analyzeWithGemini,
    translateOffline,
    translateWithGemini,
    translateLyricsToSpanishOffline,
    translateLyricsToSpanishWithGemini,
    getAvailableGeminiModelsForUser,
    generatePracticalLessonForWord,
    generateAlphabetGuideWithAi,
    evaluatePronunciation,
    testGeminiConnection,
    stripAiSpanishLyricsSection,
    extractSpanishBlockFromLyrics,
    parseStudyNotebookDocxBuffer,
    filterStudyNotebookData,
    findNotebookTranslationMatch,
    findNotebookSongEntry,
    computeLyricsFingerprint,
    computeLyricsOverlap,
    validateLyricsUniquenessAgainstNotebook,
    checkLyricsSectionConsistency,
    resolveLyricsSectionMismatch,
    classifySongLanguageOrigin,
    resolveAllowedLyricsSections,
    compareExistingVsFreshLyrics,
    guardMusicEntryLyricsBeforeSave
} = require('./lib/language-studio');
const {
    extractYouTubeWatchPageMetadata,
    mergeResolvedTrackMetadata
} = require('./lib/youtube-metadata');
const ytmusicLyrics = require('./lib/ytmusic-lyrics');
const externalLyricsAndMeta = require('./lib/external-lyrics-and-meta');
const ytdlpService = require('./lib/ytdlp-service');
const serverNotesService = require('./lib/server-notes-service');
const { withMySqlAdvisoryLock } = require('./lib/distributed-lock');
const { buildSafeRcloneExecEnv } = serverNotesService;
const { createServerLogger, isAutomatedTestEnv } = require('./lib/server-logger');
const {
    isValidStrictUiLang,
    normalizeUiLang,
    resolveRequestUiLang,
    tServer,
    getReminderCategoryLabel,
    localizeTrafficLabel,
    localizeOriginLabel,
    localizeItsBuildingLabel
} = require('./lib/server-i18n');

const REPLICA_ID = String(process.env.REPLICA_ID || os.hostname() || 'app').trim().slice(0, 64) || 'app';
const APP_SLOT_NAME = String(process.env.APP_SLOT || '').trim().toLowerCase();
const APP_SLOT_STATE_FILE = String(process.env.APP_SLOT_STATE_FILE || '/app/deploy-state/active-slot').trim();

function isActiveBlueGreenSlot() {
    if (!APP_SLOT_NAME || (APP_SLOT_NAME !== 'blue' && APP_SLOT_NAME !== 'green')) {
        return true;
    }
    if (!APP_SLOT_STATE_FILE) {
        return true;
    }
    try {
        if (!fs.existsSync(APP_SLOT_STATE_FILE)) {
            return true;
        }
        const activeSlot = fs.readFileSync(APP_SLOT_STATE_FILE, 'utf8').trim().toLowerCase();
        if (!activeSlot) {
            return true;
        }
        return activeSlot === APP_SLOT_NAME;
    } catch (_) {
        return true;
    }
}

function resolveRuntimeAppVersion() {
    const rawEnvVersion = String(process.env.APP_VERSION || '').trim().replace(/^v/i, '');
    if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(rawEnvVersion)) {
        return rawEnvVersion;
    }
    try {
        if (typeof loadVersionMetadata === 'function') {
            return loadVersionMetadata().currentVersion || '1.0.0';
        }
    } catch (_) {}
    return '1.0.0';
}

const serverLogger = createServerLogger({ rootDir: __dirname });
serverLogger.installConsoleTee();

const transportManager = createTransportManager();

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === 'loopback') {
    app.set('trust proxy', 'loopback');
} else if (/^[1-9]\d*$/.test(String(process.env.TRUST_PROXY || '').trim())) {
    app.set('trust proxy', Number.parseInt(process.env.TRUST_PROXY, 10));
}
app.use(serverLogger.createHttpLoggerMiddleware());

function isRequestHttps(req) {
    if (!req) return false;
    if (req.secure) return true;
    const xfProto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    return xfProto === 'https';
}

function isAllowedCorsOrigin(rawOrigin, req) {
    if (!rawOrigin) return false;
    let parsed;
    try {
        parsed = new URL(String(rawOrigin));
    } catch (_) {
        return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return false;
    }
    const originNorm = parsed.origin.toLowerCase();
    const baseUrl = String(process.env.APP_BASE_URL || '').trim();
    if (baseUrl) {
        try {
            if (new URL(baseUrl).origin.toLowerCase() === originNorm) return true;
        } catch (_) {}
    }
    const hostHeader = String(req?.headers?.host || '').split(',')[0].trim().toLowerCase();
    if (hostHeader && parsed.host.toLowerCase() === hostHeader) {
        return true;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1') {
        return true;
    }
    if (hostname.endsWith('.ts.net')) {
        return true;
    }
    const extraList = String(process.env.CORS_ALLOWED_ORIGINS || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    if (extraList.some((entry) => entry === originNorm || entry === hostname)) {
        return true;
    }
    return false;
}

// Cabeceras de seguridad HTTP + refuerzo HTTPS
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(self), microphone=(self), camera=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    const isHttps = isRequestHttps(req);
    const baseCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://i.ytimg.com https://tile.openstreetmap.org https://*.tile.openstreetmap.org; media-src 'self'; frame-src 'self' https://www.youtube-nocookie.com https://www.youtube.com; connect-src 'self'; form-action 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'";
    res.setHeader(
        'Content-Security-Policy',
        isHttps ? `${baseCsp}; upgrade-insecure-requests` : baseCsp
    );
    if (isHttps) {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    if (
        String(process.env.REQUIRE_HTTPS || '').trim().toLowerCase() === 'true'
        && !isHttps
        && req.path !== '/healthz'
    ) {
        if (req.path.startsWith('/api')) {
            return res.status(426).send('HTTPS is required for all API requests.');
        }
        const rawBaseUrl = String(process.env.APP_BASE_URL || '').trim();
        if (rawBaseUrl) {
            try {
                const parsedBase = new URL(rawBaseUrl);
                if (parsedBase.protocol === 'https:') {
                    return res.redirect(308, `${parsedBase.origin}${req.originalUrl || '/'}`);
                }
            } catch (_) {}
        }
        const hostHdr = String(req.headers.host || '').split(',')[0].trim();
        if (/^[a-zA-Z0-9.-]+(?::\d{1,5})?$/.test(hostHdr)) {
            return res.redirect(308, `https://${hostHdr}${req.originalUrl || '/'}`);
        }
        return res.status(426).send('HTTPS is required.');
    }
    next();
});

app.get('/healthz', (_req, res) => {
    const version = resolveRuntimeAppVersion();
    const slot = APP_SLOT_NAME || REPLICA_ID;
    res.setHeader('X-Replica-Id', REPLICA_ID);
    res.setHeader('X-App-Version', version);
    res.status(200).json({
        ok: true,
        slot,
        replicaId: REPLICA_ID,
        version
    });
});

app.use(cors((req, callback) => {
    const origin = String(req.headers.origin || '').trim();
    const allowed = origin ? isAllowedCorsOrigin(origin, req) : false;
    callback(null, {
        origin: allowed ? origin : false,
        credentials: Boolean(allowed),
        allowedHeaders: ['Content-Type', 'X-Idempotency-Key', 'X-Transport-Session', 'X-Transport-Accept-Enc'],
        exposedHeaders: ['X-Transport-Encrypted', 'X-Transport-Inner-Type', 'X-Transport-Rehandshake', 'X-Transport-Server-Ms']
    });
}));
const wordDriveSyncJsonParser = express.json({ limit: '15mb' });
const defaultApiJsonParser = express.json({ limit: '512kb' });
app.use((req, res, next) => {
    if (req.path === '/api/english/music/pc-word-drive-sync') {
        return wordDriveSyncJsonParser(req, res, next);
    }
    return defaultApiJsonParser(req, res, next);
});
app.use(express.text({ type: ['text/plain', 'text/*'], limit: '64kb' }));
app.use((req, _res, next) => {
    if (typeof req.body === 'string') {
        const trimmed = req.body.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            try {
                req.body = JSON.parse(trimmed);
            } catch (_) {
                req.body = {};
            }
        } else {
            req.body = {};
        }
    }
    next();
});
app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
        return res.status(400).send('Invalid JSON payload.');
    }
    if (err && err.type === 'entity.too.large') {
        return res.status(413).send('Request payload exceeds maximum allowed size.');
    }
    return next(err);
});
app.use('/api', (req, res, next) => {
    if (req.path === '/transport/handshake' || req.path === '/sync/stream') {
        return next();
    }

    const headerKid = typeof req.headers['x-transport-session'] === 'string'
        ? req.headers['x-transport-session'].trim()
        : '';
    const wantsEncryptedRes = req.headers['x-transport-accept-enc'] === '1';

    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body) && req.body.__enc) {
        try {
            const t0 = performance.now();
            const dec = transportManager.decryptEnvelope(req.body, 'c2s');
            req.transportDecryptMs = Number((performance.now() - t0).toFixed(3));
            req.transportSession = dec.session;
            req.transportSeq = dec.seq;
            req.transportEncryptedIn = true;

            if (dec.plaintext === '') {
                req.body = {};
            } else {
                const parsed = JSON.parse(dec.plaintext);
                req.body = parsed;
            }
        } catch (err) {
            if (err && err.code === 'TRANSPORT_SESSION_EXPIRED') {
                res.setHeader('X-Transport-Rehandshake', '1');
            }
            return res.status(err.status || 400).json({
                error: err.message || 'Encrypted transport decryption failed.',
                code: err.code || 'TRANSPORT_ERROR'
            });
        }
    } else if (headerKid) {
        try {
            req.transportSession = transportManager.getActiveSession(headerKid, { touch: true });
        } catch (err) {
            res.setHeader('X-Transport-Rehandshake', '1');
            return res.status(428).json({
                error: err.message || 'Transport session expired.',
                code: 'TRANSPORT_SESSION_EXPIRED'
            });
        }
    }

    if (req.transportSession && wantsEncryptedRes && !res.locals._transportWrapped) {
        res.locals._transportWrapped = true;
        const rawJson = res.json.bind(res);
        const rawSend = res.send.bind(res);
        let encryptingOut = false;

        const sendEncrypted = (plaintextStr, innerType) => {
            if (encryptingOut) return rawSend(plaintextStr);
            encryptingOut = true;
            try {
                const tEnc0 = performance.now();
                const envelope = transportManager.encryptPayload(
                    req.transportSession.kid,
                    plaintextStr,
                    's2c',
                    req.transportSeq || 0
                );
                res.setHeader('X-Transport-Encrypted', TRANSPORT_PROTOCOL);
                res.setHeader('X-Transport-Inner-Type', innerType);
                res.setHeader('X-Transport-Server-Ms', String(Number((performance.now() - tEnc0).toFixed(3))));
                return rawJson(envelope);
            } finally {
                encryptingOut = false;
            }
        };

        res.json = (body) => {
            if (encryptingOut) return rawJson(body);
            return sendEncrypted(JSON.stringify(body === undefined ? null : body), 'application/json; charset=utf-8');
        };

        res.send = (body) => {
            if (encryptingOut) return rawSend(body);
            if (body === undefined || body === null) {
                return sendEncrypted('', 'text/plain; charset=utf-8');
            }
            if (Buffer.isBuffer(body)) {
                return rawSend(body);
            }
            if (typeof body === 'object') {
                return sendEncrypted(JSON.stringify(body), 'application/json; charset=utf-8');
            }
            const currentType = String(res.getHeader('Content-Type') || 'text/plain; charset=utf-8');
            return sendEncrypted(String(body), currentType);
        };
    }

    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        if (req.body === undefined) {
            req.body = {};
        } else if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) {
            return res.status(400).send('Request body must be a valid JSON object.');
        }
    }
    return next();
});
app.use((req, res, next) => {
    if (req.path === '/healthz' || req.path.startsWith('/api')) return next();
    return staticGlobalLimiter.middleware(req, res, next);
});
app.use(express.static(path.join(__dirname, 'public'), {
    etag: true,
    maxAge: '10m',
    setHeaders(res, filePath) {
        if (/\.(js|css)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
        }
    }
}));

// Configuración de MySQL optimizada para poca RAM (t3.micro)
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 4,
    maxIdle: 2,
    idleTimeout: 60000,
    enableKeepAlive: false
});

function inicializarTablasSeguridad() {
    const tablasSql = [
        `CREATE TABLE IF NOT EXISTS RegistrosAgenda (
            id INT AUTO_INCREMENT PRIMARY KEY,
            fecha DATE NOT NULL,
            bloque VARCHAR(30) NOT NULL,
            hora TIME NOT NULL,
            actividad VARCHAR(255) NOT NULL,
            tipo ENUM('evento', 'tarea') NOT NULL DEFAULT 'evento',
            categoria ENUM('universidad', 'personal') NOT NULL DEFAULT 'personal',
            materia_id VARCHAR(60) NULL DEFAULT NULL,
            materia_nombre VARCHAR(120) NULL DEFAULT NULL,
            estado ENUM('todo', 'in_progress', 'done', 'skipped') NOT NULL DEFAULT 'todo',
            completada TINYINT(1) NOT NULL DEFAULT 0,
            recordatorio_min SMALLINT NULL DEFAULT NULL,
            en_progreso_desde DATETIME NULL DEFAULT NULL,
            fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_agenda_fecha (fecha),
            INDEX idx_agenda_categoria_estado (categoria, estado),
            INDEX idx_agenda_materia (materia_id)
        )`,
        `CREATE TABLE IF NOT EXISTS Usuarios (
            id INT AUTO_INCREMENT PRIMARY KEY,
            nombre VARCHAR(80) NOT NULL,
            email VARCHAR(150) NOT NULL UNIQUE,
            password_hash VARCHAR(255) NOT NULL,
            rol ENUM('admin', 'psiquiatra') NOT NULL DEFAULT 'psiquiatra',
            estado ENUM('activo', 'inactivo', 'suspendido') NOT NULL DEFAULT 'activo',
            fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS SesionesAuth (
            id INT AUTO_INCREMENT PRIMARY KEY,
            usuario_id INT NOT NULL,
            token_hash CHAR(64) NOT NULL UNIQUE,
            expira_en DATETIME NOT NULL,
            creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_sesion_token (token_hash),
            INDEX idx_sesion_expira (expira_en),
            FOREIGN KEY (usuario_id) REFERENCES Usuarios(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE IF NOT EXISTS CodigosSeguridad (
            id INT AUTO_INCREMENT PRIMARY KEY,
            email VARCHAR(150) NOT NULL,
            tipo ENUM('registro', 'reset', 'mfa') NOT NULL,
            token_hash CHAR(64) NOT NULL,
            expira_en DATETIME NOT NULL,
            usado TINYINT(1) NOT NULL DEFAULT 0,
            creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_codigo_email_tipo (email, tipo)
        )`,
        `CREATE TABLE IF NOT EXISTS ConfiguracionUsuario (
            usuario_id INT PRIMARY KEY,
            config_json LONGTEXT NOT NULL,
            actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (usuario_id) REFERENCES Usuarios(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE IF NOT EXISTS RecordatoriosEstado (
            id INT AUTO_INCREMENT PRIMARY KEY,
            usuario_id INT NOT NULL,
            clave_unica VARCHAR(120) NOT NULL,
            tipo VARCHAR(30) NOT NULL,
            ref_id INT NULL,
            titulo VARCHAR(140) NOT NULL,
            mensaje VARCHAR(320) NOT NULL,
            estado ENUM('active', 'snoozed', 'sent', 'dismissed') NOT NULL DEFAULT 'active',
            snooze_hasta DATETIME NULL,
            enviado_push_en DATETIME NULL,
            actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_usuario_clave (usuario_id, clave_unica),
            INDEX idx_rec_estado (usuario_id, estado),
            FOREIGN KEY (usuario_id) REFERENCES Usuarios(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE IF NOT EXISTS RegistrosSleep (
            id INT AUTO_INCREMENT PRIMARY KEY,
            fecha DATE NOT NULL,
            horas DECIMAL(4, 2) NOT NULL,
            calidad VARCHAR(20) NOT NULL,
            hora_dormir VARCHAR(5) NULL DEFAULT NULL,
            hora_despertar VARCHAR(5) NULL DEFAULT NULL,
            es_desvelo TINYINT(1) NOT NULL DEFAULT 0,
            tipo_registro VARCHAR(30) NOT NULL DEFAULT 'normal',
            motivo_desvelo VARCHAR(500) NULL DEFAULT NULL,
            fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_sleep_fecha (fecha)
        )`,
        `CREATE TABLE IF NOT EXISTS RegistrosCrisis (
            id INT AUTO_INCREMENT PRIMARY KEY,
            fecha DATE NOT NULL,
            hora VARCHAR(5) NOT NULL,
            tipo_crisis VARCHAR(100) NOT NULL,
            intensidad TINYINT NOT NULL DEFAULT 3,
            motivo VARCHAR(1000) NOT NULL,
            fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_crisis_fecha (fecha, hora)
        )`,
        `CREATE TABLE IF NOT EXISTS EstudioLecciones (
            id INT AUTO_INCREMENT PRIMARY KEY,
            usuario_id INT NOT NULL,
            idioma ENUM('en', 'ko') NOT NULL DEFAULT 'en',
            codigo_leccion VARCHAR(60) NOT NULL,
            nombre_practica VARCHAR(180) NOT NULL,
            orden_secuencia SMALLINT NOT NULL DEFAULT 1,
            completada TINYINT(1) NOT NULL DEFAULT 0,
            word_leido_en DATETIME NULL DEFAULT NULL,
            completada_en DATETIME NULL DEFAULT NULL,
            actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_usuario_leccion (usuario_id, codigo_leccion),
            INDEX idx_leccion_orden (usuario_id, idioma, orden_secuencia),
            FOREIGN KEY (usuario_id) REFERENCES Usuarios(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE IF NOT EXISTS SyncRevisions (
            scope VARCHAR(40) PRIMARY KEY,
            revision BIGINT NOT NULL DEFAULT 1,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )`
    ];
    tablasSql.forEach(sql => {
        db.query(sql, err => {
            if (err) console.error('Error asegurando tabla:', err.message);
        });
    });

    const musicaTablasSql = [
        `CREATE TABLE IF NOT EXISTS MusicaArtistas (
            id INT AUTO_INCREMENT PRIMARY KEY,
            usuario_id INT NOT NULL,
            nombre VARCHAR(140) NOT NULL,
            nombre_normalizado VARCHAR(140) NOT NULL,
            tipo_artista ENUM('solo','group','duo','collab_project') NOT NULL DEFAULT 'solo',
            notas_cortas VARCHAR(255) NULL,
            creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_usuario_artista (usuario_id, nombre_normalizado),
            FOREIGN KEY (usuario_id) REFERENCES Usuarios(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE IF NOT EXISTS MusicaAlbumes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            usuario_id INT NOT NULL,
            artista_principal_id INT NULL,
            titulo VARCHAR(180) NOT NULL,
            titulo_normalizado VARCHAR(180) NOT NULL,
            tipo_lanzamiento ENUM('album','mini_album','ep','single','ost','collab_single') NOT NULL DEFAULT 'album',
            anio SMALLINT NULL,
            fecha_lanzamiento DATE NULL DEFAULT NULL,
            notas_cortas VARCHAR(255) NULL,
            creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_album_usuario (usuario_id, artista_principal_id),
            FOREIGN KEY (usuario_id) REFERENCES Usuarios(id) ON DELETE CASCADE,
            FOREIGN KEY (artista_principal_id) REFERENCES MusicaArtistas(id) ON DELETE SET NULL
        )`,
        `CREATE TABLE IF NOT EXISTS MusicaCanciones (
            id INT AUTO_INCREMENT PRIMARY KEY,
            usuario_id INT NOT NULL,
            album_id INT NULL,
            titulo VARCHAR(180) NOT NULL,
            numero_pista SMALLINT NULL,
            idioma VARCHAR(40) NOT NULL DEFAULT 'English',
            anio SMALLINT NULL,
            yt_music_url VARCHAR(500) NULL,
            yt_video_id VARCHAR(32) NULL,
            thumbnail_url VARCHAR(500) NULL,
            estado_estudio ENUM('to_study','in_progress','mastered') NOT NULL DEFAULT 'to_study',
            enfoque_corto VARCHAR(255) NULL,
            word_sincronizado BOOLEAN NOT NULL DEFAULT FALSE,
            ultimo_estudio_en DATETIME NULL,
            creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_cancion_usuario (usuario_id, album_id, estado_estudio),
            FOREIGN KEY (usuario_id) REFERENCES Usuarios(id) ON DELETE CASCADE,
            FOREIGN KEY (album_id) REFERENCES MusicaAlbumes(id) ON DELETE SET NULL
        )`,
        `CREATE TABLE IF NOT EXISTS MusicaCancionArtistas (
            cancion_id INT NOT NULL,
            artista_id INT NOT NULL,
            rol ENUM('main','feat','collab','producer') NOT NULL DEFAULT 'main',
            orden SMALLINT NOT NULL DEFAULT 1,
            PRIMARY KEY (cancion_id, artista_id),
            INDEX idx_mca_artista (artista_id, rol),
            FOREIGN KEY (cancion_id) REFERENCES MusicaCanciones(id) ON DELETE CASCADE,
            FOREIGN KEY (artista_id) REFERENCES MusicaArtistas(id) ON DELETE CASCADE
        )`
    ];
    const ejecutarTablasMusicaSecuencial = idx => {
        if (idx >= musicaTablasSql.length) {
            db.query("SHOW COLUMNS FROM MusicaAlbumes LIKE 'fecha_lanzamiento'", (errCol, cols) => {
                if (!errCol && Array.isArray(cols) && cols.length === 0) {
                    db.query(
                        'ALTER TABLE MusicaAlbumes ADD COLUMN fecha_lanzamiento DATE NULL DEFAULT NULL AFTER anio',
                        errAlt => {
                            if (errAlt && !/Duplicate column/i.test(errAlt.message || '')) {
                                console.error('Error migrando fecha_lanzamiento en MusicaAlbumes:', errAlt.message);
                            }
                        }
                    );
                }
            });
            db.query("SHOW COLUMNS FROM MusicaCanciones LIKE 'anio'", (errCol, cols) => {
                if (!errCol && Array.isArray(cols) && cols.length === 0) {
                    db.query(
                        'ALTER TABLE MusicaCanciones ADD COLUMN anio SMALLINT NULL AFTER idioma',
                        errAlt => {
                            if (errAlt && !/Duplicate column/i.test(errAlt.message || '')) {
                                console.error('Error migrando anio en MusicaCanciones:', errAlt.message);
                            }
                        }
                    );
                }
            });
            return;
        }
        db.query(musicaTablasSql[idx], err => {
            if (err) console.error('Error asegurando tabla musical:', err.message);
            ejecutarTablasMusicaSecuencial(idx + 1);
        });
    };
    ejecutarTablasMusicaSecuencial(0);

    // Migración automática idempotente para bases de datos ya existentes
    const agendaCols = [
        {
            name: 'tipo',
            sql: "ALTER TABLE RegistrosAgenda ADD COLUMN tipo ENUM('evento', 'tarea') NOT NULL DEFAULT 'evento' AFTER actividad"
        },
        {
            name: 'categoria',
            sql: "ALTER TABLE RegistrosAgenda ADD COLUMN categoria ENUM('universidad', 'personal') NOT NULL DEFAULT 'personal' AFTER tipo"
        },
        {
            name: 'materia_id',
            sql: 'ALTER TABLE RegistrosAgenda ADD COLUMN materia_id VARCHAR(60) NULL DEFAULT NULL AFTER categoria'
        },
        {
            name: 'materia_nombre',
            sql: 'ALTER TABLE RegistrosAgenda ADD COLUMN materia_nombre VARCHAR(120) NULL DEFAULT NULL AFTER materia_id'
        },
        {
            name: 'estado',
            sql: "ALTER TABLE RegistrosAgenda ADD COLUMN estado ENUM('todo', 'in_progress', 'done', 'skipped') NOT NULL DEFAULT 'todo' AFTER categoria",
            afterMigrate: "UPDATE RegistrosAgenda SET estado = 'done' WHERE completada = 1"
        },
        {
            name: 'recordatorio_min',
            sql: 'ALTER TABLE RegistrosAgenda ADD COLUMN recordatorio_min SMALLINT NULL DEFAULT NULL AFTER completada'
        },
        {
            name: 'en_progreso_desde',
            sql: 'ALTER TABLE RegistrosAgenda ADD COLUMN en_progreso_desde DATETIME NULL DEFAULT NULL AFTER recordatorio_min'
        }
    ];
    agendaCols.forEach(col => {
        db.query('SHOW COLUMNS FROM RegistrosAgenda LIKE ?', [col.name], (errCol, cols) => {
            if (!errCol && Array.isArray(cols) && cols.length === 0) {
                db.query(col.sql, (errAlt) => {
                    if (errAlt && !/Duplicate column/i.test(errAlt.message || '')) {
                        console.error(`Error migrando columna ${col.name} en RegistrosAgenda:`, errAlt.message);
                    } else if (!errAlt && col.afterMigrate) {
                        db.query(col.afterMigrate, () => {});
                    }
                });
            } else if (!errCol && col.name === 'estado' && Array.isArray(cols) && cols[0] && cols[0].Type && !String(cols[0].Type).includes('skipped')) {
                db.query(
                    "ALTER TABLE RegistrosAgenda MODIFY COLUMN estado ENUM('todo', 'in_progress', 'done', 'skipped') NOT NULL DEFAULT 'todo'",
                    (errMod) => {
                        if (errMod) console.error('Error ampliando ENUM estado en RegistrosAgenda:', errMod.message);
                    }
                );
            }
        });
    });

    db.query(
        'ALTER TABLE RegistrosCrisis MODIFY COLUMN tipo_crisis VARCHAR(100) NOT NULL',
        (errModCrisis) => {
            if (errModCrisis && !/ER_NO_SUCH_TABLE/i.test(errModCrisis.message || '')) {
                console.error('Error ampliando columna tipo_crisis en RegistrosCrisis:', errModCrisis.message);
            }
        }
    );

    const sleepCols = [
        {
            name: 'hora_dormir',
            sql: 'ALTER TABLE RegistrosSleep ADD COLUMN hora_dormir VARCHAR(5) NULL DEFAULT NULL AFTER calidad'
        },
        {
            name: 'hora_despertar',
            sql: 'ALTER TABLE RegistrosSleep ADD COLUMN hora_despertar VARCHAR(5) NULL DEFAULT NULL AFTER hora_dormir'
        },
        {
            name: 'es_desvelo',
            sql: 'ALTER TABLE RegistrosSleep ADD COLUMN es_desvelo TINYINT(1) NOT NULL DEFAULT 0 AFTER hora_despertar'
        },
        {
            name: 'tipo_registro',
            sql: "ALTER TABLE RegistrosSleep ADD COLUMN tipo_registro VARCHAR(30) NOT NULL DEFAULT 'normal' AFTER es_desvelo"
        },
        {
            name: 'motivo_desvelo',
            sql: 'ALTER TABLE RegistrosSleep ADD COLUMN motivo_desvelo VARCHAR(500) NULL DEFAULT NULL AFTER tipo_registro'
        }
    ];
    const ejecutarMigracionSleepSecuencial = (idx = 0) => {
        if (idx >= sleepCols.length) return;
        const col = sleepCols[idx];
        db.query('SHOW COLUMNS FROM RegistrosSleep LIKE ?', [col.name], (errCol, cols) => {
            if (!errCol && Array.isArray(cols) && cols.length === 0) {
                db.query(col.sql, (errAlt) => {
                    if (errAlt) {
                        console.error(`Error migrando columna ${col.name} en RegistrosSleep:`, errAlt.message);
                    }
                    ejecutarMigracionSleepSecuencial(idx + 1);
                });
            } else {
                ejecutarMigracionSleepSecuencial(idx + 1);
            }
        });
    };
    ejecutarMigracionSleepSecuencial(0);
    db.query("SHOW COLUMNS FROM Usuarios LIKE 'estado'", (errCol, cols) => {
        if (!errCol && Array.isArray(cols) && cols.length === 0) {
            db.query(
                "ALTER TABLE Usuarios ADD COLUMN estado ENUM('activo', 'inactivo', 'suspendido') NOT NULL DEFAULT 'activo' AFTER rol",
                (errAlt) => {
                    if (errAlt) console.error('Error migrando columna estado en Usuarios:', errAlt.message);
                }
            );
        }
    });

    db.query("SHOW COLUMNS FROM CodigosSeguridad LIKE 'tipo'", (errCol, cols) => {
        if (!errCol && Array.isArray(cols) && cols.length > 0 && !String(cols[0].Type || '').includes("'mfa'")) {
            db.query(
                "ALTER TABLE CodigosSeguridad MODIFY COLUMN tipo ENUM('registro', 'reset', 'mfa') NOT NULL",
                (errAlt) => {
                    if (errAlt) console.error('Error migrando enum tipo en CodigosSeguridad:', errAlt.message);
                }
            );
        }
    });
}

db.getConnection((err, connection) => {
    if (err) throw err;
    console.log('Conectado a la Base de Datos');
    connection.release();
    inicializarTablasSeguridad();
});

// ==========================================
// UTILIDADES DE SEGURIDAD, SESIONES Y CORREO
// ==========================================
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const BCRYPT_ROUNDS = 12;
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const ESTADOS_CUENTA_VALIDOS = new Set(['activo', 'inactivo', 'suspendido']);
const DUMMY_BCRYPT_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_ROUNDS);
const ENABLE_LOGIN_MFA = String(process.env.ENABLE_LOGIN_MFA || 'false').trim().toLowerCase() === 'true';
const MFA_HMAC_SECRET = String(
    process.env.MFA_CHALLENGE_SECRET ||
    process.env.ADMIN_SECRET ||
    process.env.JOURNAL_SECRET_KEY ||
    process.env.DB_PASS ||
    crypto.randomBytes(32).toString('hex')
);

function parsePositiveInt(rawVal, fallback) {
    const num = Number(rawVal);
    return Number.isInteger(num) && num > 0 ? num : fallback;
}

function normalizeEmail(raw) {
    if (typeof raw !== 'string') return '';
    if (/[\r\n\0]/.test(raw)) return '';
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed || trimmed.length > 150 || trimmed.includes('..') || !EMAIL_REGEX.test(trimmed)) {
        return '';
    }
    return trimmed;
}

function validatePasswordFormat(password) {
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
        return 'Password must be between 8 and 128 characters long.';
    }
    if (/[\x00-\x1f\x7f]/.test(password)) {
        return 'Password cannot contain control characters.';
    }
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
        return 'Password must be 8–128 characters long and include at least one letter and one number.';
    }
    return null;
}

function requireNonEmptyBody(req, res, next) {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length === 0) {
        return res.status(400).send('Request body cannot be empty.');
    }
    return next();
}

function signMfaChallenge(payload) {
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', MFA_HMAC_SECRET).update(encoded).digest('base64url');
    return `${encoded}.${sig}`;
}

function verifyMfaChallenge(token) {
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const [encoded, sig] = parts;
    const expectedSig = crypto.createHmac('sha256', MFA_HMAC_SECRET).update(encoded).digest('base64url');
    if (!safeCompareStrings(sig, expectedSig)) return null;
    try {
        const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        if (!parsed || typeof parsed.userId !== 'number' || !parsed.email || Date.now() > Number(parsed.exp)) {
            return null;
        }
        return parsed;
    } catch (_) {
        return null;
    }
}

function sha256Hex(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeCompareStrings(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const hashA = crypto.createHash('sha256').update(a).digest();
    const hashB = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(hashA, hashB);
}

function formatMySqlDateTime(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

// Calcula el próximo domingo a las 00:00:00
function getNextSundayMidnight(fromDate = new Date()) {
    const d = new Date(fromDate);
    const day = d.getDay(); // 0 = Domingo
    const daysUntilSunday = day === 0 ? 7 : (7 - day);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + daysUntilSunday, 0, 0, 0, 0);
}

function parseCookies(req) {
    const raw = req.headers.cookie || '';
    const out = {};
    raw.split(';').forEach(part => {
        const idx = part.indexOf('=');
        if (idx > 0) {
            const k = part.slice(0, idx).trim();
            const v = part.slice(idx + 1).trim();
            out[k] = decodeURIComponent(v);
        }
    });
    return out;
}

function setSessionCookie(res, rawToken, expiresAt, req = null) {
    const maxAgeSec = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    const secureAttr = isRequestHttps(req) ? '; Secure' : '';
    res.setHeader(
        'Set-Cookie',
        `mt_session=${encodeURIComponent(rawToken)}; HttpOnly; Path=/; Max-Age=${maxAgeSec}; Expires=${expiresAt.toUTCString()}; SameSite=Lax${secureAttr}`
    );
}

function clearSessionCookie(res, req = null) {
    const secureAttr = isRequestHttps(req) ? '; Secure' : '';
    res.setHeader(
        'Set-Cookie',
        `mt_session=; HttpOnly; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax${secureAttr}`
    );
}

// Rate limiters en memoria con expiración, cabeceras estándar y limpieza automática (sin saturar RAM)
const MAX_RATE_LIMIT_ENTRIES = 1000;
const rateLimiterStores = [];

function getClientIp(req) {
    const raw = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    return String(raw).replace(/^::ffff:/, '') || 'unknown';
}

function pruneMapExpired(store, now = Date.now()) {
    for (const [k, rec] of store.entries()) {
        if (now > rec.resetAt) {
            store.delete(k);
        }
    }
}

setInterval(() => {
    const now = Date.now();
    rateLimiterStores.forEach(store => pruneMapExpired(store, now));
}, 5 * 60 * 1000).unref();

function createRateLimiter({
    maxAttempts = 60,
    windowMs = 60 * 1000,
    message = 'Too many requests. Please slow down and try again later.',
    keyGenerator = (req) => getClientIp(req)
} = {}) {
    const store = new Map();
    rateLimiterStores.push(store);

    function consume(key) {
        const now = Date.now();
        if (store.size >= MAX_RATE_LIMIT_ENTRIES && !store.has(key)) {
            pruneMapExpired(store, now);
            while (store.size >= MAX_RATE_LIMIT_ENTRIES) {
                const oldestKey = store.keys().next().value;
                if (oldestKey === undefined) break;
                store.delete(oldestKey);
            }
        }

        const record = store.get(key);
        if (!record || now > record.resetAt) {
            const resetAt = now + windowMs;
            store.set(key, { count: 1, resetAt });
            return {
                allowed: true,
                remaining: Math.max(0, maxAttempts - 1),
                resetAt,
                retryAfterSec: 0
            };
        }

        if (record.count >= maxAttempts) {
            return {
                allowed: false,
                remaining: 0,
                resetAt: record.resetAt,
                retryAfterSec: Math.max(1, Math.ceil((record.resetAt - now) / 1000))
            };
        }

        record.count += 1;
        return {
            allowed: true,
            remaining: Math.max(0, maxAttempts - record.count),
            resetAt: record.resetAt,
            retryAfterSec: 0
        };
    }

    function applyHeaders(res, result) {
        res.setHeader('X-RateLimit-Limit', String(maxAttempts));
        res.setHeader('X-RateLimit-Remaining', String(result.remaining));
        res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
        if (!result.allowed) {
            res.setHeader('Retry-After', String(result.retryAfterSec));
        }
    }

    function middleware(req, res, next) {
        const key = String(keyGenerator(req) || getClientIp(req));
        const result = consume(key);
        applyHeaders(res, result);
        if (!result.allowed) {
            return res.status(429).send(message);
        }
        return next();
    }

    function reset(key) {
        store.delete(key);
    }

    return { consume, applyHeaders, middleware, reset };
}

const apiGlobalLimiter = createRateLimiter({
    maxAttempts: parsePositiveInt(process.env.RATE_LIMIT_API_MAX, 500),
    windowMs: parsePositiveInt(process.env.RATE_LIMIT_API_WINDOW_MS, 60 * 1000),
    message: 'Too many requests to the server. Please wait a moment and try again.'
});

const loginIpLimiter = createRateLimiter({
    maxAttempts: parsePositiveInt(process.env.RATE_LIMIT_LOGIN_IP_MAX, 30),
    windowMs: 15 * 60 * 1000,
    message: 'Too many login attempts from this IP. Please wait 15 minutes.'
});

const loginAccountLimiter = createRateLimiter({
    maxAttempts: parsePositiveInt(process.env.RATE_LIMIT_LOGIN_MAX, 10),
    windowMs: 15 * 60 * 1000,
    message: 'Too many failed attempts. Please wait 15 minutes.'
});

const regCodeLimiter = createRateLimiter({
    maxAttempts: parsePositiveInt(process.env.RATE_LIMIT_REGCODE_MAX, 6),
    windowMs: 15 * 60 * 1000,
    message: 'Too many verification code requests. Please wait a few minutes.'
});

const registerLimiter = createRateLimiter({
    maxAttempts: parsePositiveInt(process.env.RATE_LIMIT_REGISTER_MAX, 8),
    windowMs: 15 * 60 * 1000,
    message: 'Too many registration attempts. Please wait 15 minutes.'
});

const forgotPasswordLimiter = createRateLimiter({
    maxAttempts: parsePositiveInt(process.env.RATE_LIMIT_FORGOT_MAX, 5),
    windowMs: 15 * 60 * 1000,
    message: 'Too many password recovery requests. Please wait 15 minutes.'
});

const resetPasswordLimiter = createRateLimiter({
    maxAttempts: parsePositiveInt(process.env.RATE_LIMIT_RESET_MAX, 8),
    windowMs: 15 * 60 * 1000,
    message: 'Too many password reset attempts. Please wait 15 minutes.'
});

const mfaVerifyLimiter = createRateLimiter({
    maxAttempts: parsePositiveInt(process.env.RATE_LIMIT_MFA_MAX, 8),
    windowMs: 15 * 60 * 1000,
    message: 'Too many verification attempts. Please wait 15 minutes.'
});

const apiReadLimiter = createRateLimiter({
    maxAttempts: parsePositiveInt(process.env.RATE_LIMIT_READ_MAX, 120),
    windowMs: 60 * 1000,
    message: 'Too many read requests. Please slow down briefly.'
});

const apiWriteLimiter = createRateLimiter({
    maxAttempts: parsePositiveInt(process.env.RATE_LIMIT_WRITE_MAX, 60),
    windowMs: 60 * 1000,
    message: 'Too many write requests. Please slow down briefly.'
});

const pcQueueWriteLimiter = createRateLimiter({
    maxAttempts: parsePositiveInt(process.env.RATE_LIMIT_PC_WRITE_MAX, 120),
    windowMs: 60 * 1000,
    message: 'Too many PC sync enqueue requests. Please wait a moment.',
    keyGenerator: (req) => `${getClientIp(req)}:${req.path}`
});

const pcPullLimiter = createRateLimiter({
    maxAttempts: parsePositiveInt(process.env.RATE_LIMIT_PC_PULL_MAX, 60),
    windowMs: 60 * 1000,
    message: 'Too many PC sync polling requests. Please wait a moment.',
    keyGenerator: (req) => `${getClientIp(req)}:${req.path}`
});

const reminderActionLimiter = createRateLimiter({
    maxAttempts: parsePositiveInt(process.env.RATE_LIMIT_REMINDER_ACTION_MAX, 30),
    windowMs: 15 * 60 * 1000,
    message: 'Too many reminder actions. Please wait a moment.'
});

const transportHandshakeLimiter = createRateLimiter({
    maxAttempts: parsePositiveInt(process.env.RATE_LIMIT_HANDSHAKE_MAX, 120),
    windowMs: 60 * 1000,
    message: 'Too many transport handshake attempts. Please wait a moment.'
});

const staticGlobalLimiter = createRateLimiter({
    maxAttempts: parsePositiveInt(process.env.RATE_LIMIT_STATIC_MAX, 600),
    windowMs: 60 * 1000,
    message: 'Too many requests to the server. Please slow down briefly.'
});

const mapTileLimiter = createRateLimiter({
    maxAttempts: parsePositiveInt(process.env.RATE_LIMIT_MAP_TILE_MAX, 400),
    windowMs: 60 * 1000,
    message: 'Too many map tile requests. Please pause panning or zooming briefly.'
});

function requirePcBridgeAuthIfConfigured(req, res, next) {
    if (String(process.env.REQUIRE_PC_BRIDGE_AUTH || '').trim().toLowerCase() === 'true') {
        return verifyPcBridgeAuth(req, res, next);
    }
    return next();
}

// Middleware global anti-DoS sobre /api/*
app.use('/api', apiGlobalLimiter.middleware);

// Limpieza periódica de sesiones y códigos vencidos para ahorrar espacio en MySQL
function limpiarRegistrosExpirados() {
    if (!isActiveBlueGreenSlot()) return;
    const nowSql = formatMySqlDateTime(new Date());
    const cutoff90Days = formatMySqlDateTime(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
    db.query('DELETE FROM SesionesAuth WHERE expira_en <= ?', [nowSql], () => {});
    db.query('DELETE FROM CodigosSeguridad WHERE usado = 1 OR expira_en <= ?', [nowSql], () => {});
    db.query('DELETE FROM RecordatoriosEstado WHERE actualizado_en < ?', [cutoff90Days], () => {});
}

if (process.env.DISABLE_CLEANUP_SCHEDULER !== 'true') {
    setInterval(limpiarRegistrosExpirados, 6 * 60 * 60 * 1000).unref();
}

// Transporte de correo (Gmail SMTP)
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getResetBaseUrl(req) {
    const envBase = (process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
    if (envBase && /^https?:\/\/[a-zA-Z0-9.-]+(:\d{1,5})?$/.test(envBase)) {
        return envBase;
    }

    const rawProto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http')
        .split(',')[0]
        .trim()
        .toLowerCase();
    const proto = rawProto === 'https' ? 'https' : 'http';
    const rawHost = String(req.headers.host || '').trim();
    if (!/^[a-zA-Z0-9.-]+(:\d{1,5})?$/.test(rawHost)) {
        return `${proto}://localhost:${process.env.PORT || 3000}`;
    }
    return `${proto}://${rawHost}`;
}

function crearTransporterCorreo() {
    const smtpUser = (process.env.SMTP_USER || ADMIN_EMAIL).trim();
    const smtpPass = (process.env.SMTP_PASS || '').replace(/\s+/g, '');
    if (!smtpUser || !smtpPass) return null;

    return nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: smtpUser,
            pass: smtpPass
        }
    });
}

async function enviarCorreo({ to, subject, html }) {
    const transporter = crearTransporterCorreo();
    if (!transporter) {
        throw new Error('SMTP_USER and SMTP_PASS (Gmail App Password) are missing in .env or GitHub Secrets.');
    }
    const fromUser = (process.env.SMTP_USER || ADMIN_EMAIL).trim();
    try {
        await transporter.sendMail({
            from: `"Personal Daily Hub" <${fromUser}>`,
            to,
            subject,
            html
        });
    } catch (err) {
        if (err && (err.code === 'EAUTH' || err.responseCode === 535)) {
            throw new Error('Gmail rejected the SMTP credentials. Check that SMTP_USER and the 16-character App Password (SMTP_PASS) match.');
        }
        throw err;
    }
}

// Middleware de autenticación (incluye validación de estado de cuenta)
function requireAuth(req, res, next) {
    const cookies = parseCookies(req);
    const rawToken = cookies.mt_session;
    if (!rawToken || rawToken.length < 32) {
        return res.status(401).send('Session not started or expired.');
    }

    const tokenHash = sha256Hex(rawToken);
    const nowSql = formatMySqlDateTime(new Date());

    const sql = `
        SELECT s.id AS sesion_id, s.expira_en, u.id, u.nombre, u.email, u.rol, u.estado
        FROM SesionesAuth s
        INNER JOIN Usuarios u ON u.id = s.usuario_id
        WHERE s.token_hash = ? AND s.expira_en > ?
        LIMIT 1
    `;

    db.query(sql, [tokenHash, nowSql], (err, rows) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error verifying session.');
        }
        if (!rows || rows.length === 0) {
            clearSessionCookie(res, req);
            return res.status(401).send('Your session has expired. Please sign in again.');
        }

        const estadoCuenta = rows[0].estado || 'activo';
        if (estadoCuenta !== 'activo') {
            clearSessionCookie(res, req);
            db.query('DELETE FROM SesionesAuth WHERE token_hash = ?', [tokenHash], () => {});
            return res.status(403).send('Your account is inactive or suspended. Contact the administrator.');
        }

        req.user = {
            id: rows[0].id,
            nombre: rows[0].nombre,
            email: rows[0].email,
            rol: rows[0].rol,
            estado: estadoCuenta,
            expira_en: rows[0].expira_en
        };
        req.sessionTokenHash = tokenHash;
        next();
    });
}

function requireAdmin(req, res, next) {
    requireAuth(req, res, () => {
        if (req.user.rol !== 'admin') {
            return res.status(403).send('Read-only access: this account can only view the weekly summary.');
        }
        next();
    });
}

// ==========================================
// PROTECCIÓN CONTRA DOBLE ENVÍO, CONCURRENCIA E IDEMPOTENCIA
// ==========================================
const MAX_IDEMPOTENCY_ENTRIES = 300;
const IN_FLIGHT_MAX_AGE_MS = 60 * 1000;
const DEFAULT_IDEMPOTENCY_TTL_MS = 2 * 60 * 1000;
const IDEMPOTENCY_KEY_REGEX = /^[a-zA-Z0-9._:-]{1,128}$/;

const inFlightMutations = new Map();
const idempotencyReplayCache = new Map();
const recentSubmissionCache = new Map();

function pruneTimedMap(map, now = Date.now(), maxAgeMs = 0) {
    for (const [key, entry] of map.entries()) {
        if (maxAgeMs > 0) {
            if (now - entry > maxAgeMs) map.delete(key);
        } else if (now > entry.expiresAt) {
            map.delete(key);
        }
    }
}

function setBoundedMapEntry(map, key, value, maxEntries = MAX_IDEMPOTENCY_ENTRIES) {
    if (map.size >= maxEntries && !map.has(key)) {
        const now = Date.now();
        pruneTimedMap(map, now);
        while (map.size >= maxEntries) {
            const oldestKey = map.keys().next().value;
            if (oldestKey === undefined) break;
            map.delete(oldestKey);
        }
    }
    map.set(key, value);
}

setInterval(() => {
    const now = Date.now();
    pruneTimedMap(inFlightMutations, now, IN_FLIGHT_MAX_AGE_MS);
    pruneTimedMap(idempotencyReplayCache, now);
    pruneTimedMap(recentSubmissionCache, now);
}, 5 * 60 * 1000).unref();

function canonicalPayloadString(val) {
    if (val === null || val === undefined) return '';
    if (Array.isArray(val)) {
        return `[${val.map(canonicalPayloadString).join(',')}]`;
    }
    if (typeof val === 'object') {
        const keys = Object.keys(val).sort();
        return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalPayloadString(val[k])}`).join(',')}}`;
    }
    return JSON.stringify(val);
}

function preventDuplicateSubmit(options = {}) {
    const {
        dedupeWindowMs = 0,
        ttlMs = DEFAULT_IDEMPOTENCY_TTL_MS,
        cacheReplay = true
    } = options;

    return (req, res, next) => {
        const rawKey = req.get('x-idempotency-key');
        const idemKey = typeof rawKey === 'string' ? rawKey.trim() : '';
        if (idemKey && !IDEMPOTENCY_KEY_REGEX.test(idemKey)) {
            return res.status(400).send('Invalid X-Idempotency-Key header.');
        }

        const now = Date.now();
        const actorId = req.user && req.user.id ? `u:${req.user.id}` : `ip:${req.ip || 'unknown'}`;
        const routePath = (req.originalUrl || req.url || '').split('?')[0];
        const routeKey = `${req.method}:${routePath}`;
        const payloadHash = sha256Hex(canonicalPayloadString(req.body || {}));
        const payloadKey = `${actorId}|${routeKey}|${payloadHash}`;
        const scopedIdemKey = idemKey ? `${actorId}|${routeKey}|k:${idemKey}` : '';

        if (cacheReplay && scopedIdemKey) {
            const cached = idempotencyReplayCache.get(scopedIdemKey);
            if (cached) {
                if (now <= cached.expiresAt) {
                    if (cached.payloadHash !== payloadHash) {
                        return res.status(409).send('Idempotency key cannot be reused with different data.');
                    }
                    res.setHeader('X-Idempotent-Replay', 'true');
                    if (cached.contentType) {
                        res.setHeader('Content-Type', cached.contentType);
                    }
                    return res.status(cached.status).send(cached.body);
                }
                idempotencyReplayCache.delete(scopedIdemKey);
            }
        }

        const existingPayloadFlight = inFlightMutations.get(payloadKey);
        const existingKeyFlight = scopedIdemKey ? inFlightMutations.get(scopedIdemKey) : undefined;
        if (
            (existingPayloadFlight && now - existingPayloadFlight < IN_FLIGHT_MAX_AGE_MS) ||
            (existingKeyFlight && now - existingKeyFlight < IN_FLIGHT_MAX_AGE_MS)
        ) {
            return res.status(409).send('Request is already being processed. Please wait.');
        }

        if (dedupeWindowMs > 0) {
            const recent = recentSubmissionCache.get(payloadKey);
            if (recent) {
                if (now <= recent.expiresAt) {
                    return res.status(409).send('Duplicate submission detected. Avoid sending identical data repeatedly.');
                }
                recentSubmissionCache.delete(payloadKey);
            }
        }

        inFlightMutations.set(payloadKey, now);
        if (scopedIdemKey) {
            inFlightMutations.set(scopedIdemKey, now);
        }

        let released = false;
        const releaseInFlight = () => {
            if (released) return;
            released = true;
            inFlightMutations.delete(payloadKey);
            if (scopedIdemKey) inFlightMutations.delete(scopedIdemKey);
        };
        res.on('finish', releaseInFlight);
        res.on('close', releaseInFlight);

        const originalSend = res.send.bind(res);
        let captured = false;
        res.send = function patchedSend(body) {
            if (!captured && res.statusCode >= 200 && res.statusCode < 300) {
                captured = true;
                const completedAt = Date.now();
                if (dedupeWindowMs > 0) {
                    setBoundedMapEntry(recentSubmissionCache, payloadKey, {
                        expiresAt: completedAt + dedupeWindowMs
                    });
                }
                if (cacheReplay && scopedIdemKey) {
                    const isObjBody = typeof body === 'object' && body !== null && !Buffer.isBuffer(body);
                    const serializedBody = Buffer.isBuffer(body)
                        ? body
                        : (typeof body === 'string' ? body : JSON.stringify(body));
                    const contentType = res.getHeader('content-type') || (isObjBody ? 'application/json; charset=utf-8' : '');
                    setBoundedMapEntry(idempotencyReplayCache, scopedIdemKey, {
                        status: res.statusCode,
                        body: serializedBody,
                        contentType,
                        payloadHash,
                        expiresAt: completedAt + ttlMs
                    });
                }
            }
            res.send = originalSend;
            return originalSend(body);
        };

        return next();
    };
}

const MAX_ACTIVE_SESSIONS_PER_USER = 3;

function pruneExcessUserSessions(userId) {
    db.query(
        'DELETE FROM SesionesAuth WHERE expira_en <= NOW() OR (usuario_id = ? AND id NOT IN (SELECT id FROM (SELECT id FROM SesionesAuth WHERE usuario_id = ? ORDER BY id DESC LIMIT ?) AS recientes))',
        [userId, userId, MAX_ACTIVE_SESSIONS_PER_USER],
        () => {}
    );
}

function issueUserSession(res, user, { statusCode = 200, message, errorMessage = 'Error creating session.', req = null }) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = sha256Hex(rawToken);
    const expiresAt = getNextSundayMidnight();
    const expiresSql = formatMySqlDateTime(expiresAt);

    db.query(
        'INSERT INTO SesionesAuth (usuario_id, token_hash, expira_en) VALUES (?, ?, ?)',
        [user.id, tokenHash, expiresSql],
        (errSes) => {
            if (errSes) {
                console.error(errSes);
                return res.status(500).send(errorMessage);
            }
            pruneExcessUserSessions(user.id);
            setSessionCookie(res, rawToken, expiresAt, req);
            return res.status(statusCode).json({
                message,
                user: {
                    id: user.id,
                    nombre: user.nombre,
                    email: user.email,
                    rol: user.rol,
                    estado: user.estado || 'activo',
                    expira_en: expiresAt.toISOString()
                }
            });
        }
    );
}

// ==========================================
// RUTAS DE AUTENTICACIÓN Y SEGURIDAD
// ==========================================

// Consultar sesión activa
app.get('/api/auth/me', apiReadLimiter.middleware, requireAuth, (req, res) => {
    res.json({ authenticated: true, user: req.user });
});

// Enviar código de verificación al correo propietario
app.post('/api/auth/send-register-code', regCodeLimiter.middleware, requireNonEmptyBody, preventDuplicateSubmit({ dedupeWindowMs: 15000 }), async (req, res) => {
    const emailSolicitante = normalizeEmail(req.body.email);
    if (!emailSolicitante) {
        return res.status(400).send('Please enter a valid email address.');
    }

    const codigo = String(crypto.randomInt(100000, 999999));
    const codigoHash = sha256Hex(codigo);
    const expira = new Date(Date.now() + 15 * 60 * 1000); // 15 min
    const expiraSql = formatMySqlDateTime(expira);

    db.query(
        'INSERT INTO CodigosSeguridad (email, tipo, token_hash, expira_en, usado) VALUES (?, "registro", ?, ?, 0)',
        [emailSolicitante, codigoHash, expiraSql],
        async (err) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error generating verification code.');
            }

            try {
                const rolSolicitado = emailSolicitante === ADMIN_EMAIL ? 'Administrator (Owner)' : 'Psychiatrist (Read-only)';
                await enviarCorreo({
                    to: ADMIN_EMAIL,
                    subject: 'Verification Code - Personal Daily Hub',
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 12px;">
                            <h2 style="color: #1e2430; margin-top: 0;">Registration Verification</h2>
                            <p>A registration request was submitted for <strong>${escapeHtml(emailSolicitante)}</strong> with role <strong>${rolSolicitado}</strong>.</p>
                            <p>Your authorization code (valid for 15 minutes) is:</p>
                            <div style="font-size: 28px; font-weight: bold; letter-spacing: 6px; text-align: center; padding: 14px; background: #f3f4f6; border-radius: 8px; color: #111827;">
                                ${codigo}
                            </div>
                        </div>
                    `
                });
                res.json({ message: 'Verification code sent to the owner email configured on the server.' });
            } catch (mailErr) {
                console.error('[AUTH_MAIL_ERROR]', mailErr.message);
                res.status(500).send(
                    'Could not send the verification email. You can register using your personal secret key in the validation field.'
                );
            }
        }
    );
});

// Registro de usuario por primera vez (valida correo o clave secreta personal)
app.post('/api/auth/register', registerLimiter.middleware, requireNonEmptyBody, preventDuplicateSubmit({ dedupeWindowMs: 0, cacheReplay: false }), (req, res) => {
    const nombre = typeof req.body.nombre === 'string' ? req.body.nombre.trim() : '';
    const email = normalizeEmail(req.body.email);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const codigoValidacion = typeof req.body.codigoValidacion === 'string' ? req.body.codigoValidacion.trim() : '';

    if (!nombre || nombre.length < 2 || nombre.length > 80) {
        return res.status(400).send('Name must be between 2 and 80 characters.');
    }
    if (!email) {
        return res.status(400).send('Invalid email address.');
    }
    const passwordError = validatePasswordFormat(password);
    if (passwordError) {
        return res.status(400).send(passwordError);
    }
    if (!codigoValidacion) {
        return res.status(400).send('Enter the verification code or your personal secret key.');
    }

    // Asignación estricta de rol: únicamente ADMIN_EMAIL puede ser admin
    const rolAsignado = email === ADMIN_EMAIL ? 'admin' : 'psiquiatra';

    // Verificar si coincide con clave secreta personal del propietario (.env)
    const clavesPropietario = [
        process.env.ADMIN_SECRET,
        process.env.WORD_PASSWORD,
        process.env.JOURNAL_SECRET_KEY
    ].filter(Boolean);

    const validoPorClaveSecreta = clavesPropietario.some(clave => safeCompareStrings(codigoValidacion, String(clave).trim()));

    const procederConCreacion = () => {
        db.query('SELECT id FROM Usuarios WHERE email = ? LIMIT 1', [email], async (errExist, rowsExist) => {
            if (errExist) {
                console.error(errExist);
                return res.status(500).send('Error querying users.');
            }
            if (rowsExist && rowsExist.length > 0) {
                return res.status(400).send('This email is already registered. Sign in or reset your password.');
            }

            try {
                const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
                db.query(
                    'INSERT INTO Usuarios (nombre, email, password_hash, rol) VALUES (?, ?, ?, ?)',
                    [nombre, email, passwordHash, rolAsignado],
                    (errIns, result) => {
                        if (errIns) {
                            console.error(errIns);
                            return res.status(500).send('Error registering user.');
                        }

                        issueUserSession(
                            res,
                            { id: result.insertId, nombre, email, rol: rolAsignado, estado: 'activo' },
                            {
                                statusCode: 201,
                                message: 'Account verified and created successfully.',
                                errorMessage: 'Account created, but an error occurred while signing in.',
                                req
                            }
                        );
                    }
                );
            } catch (hashErr) {
                console.error(hashErr);
                res.status(500).send('Error processing password.');
            }
        });
    };

    if (validoPorClaveSecreta) {
        return procederConCreacion();
    }

    // Si no fue clave secreta, validar código OTP enviado por correo
    const codigoHash = sha256Hex(codigoValidacion);
    const nowSql = formatMySqlDateTime(new Date());
    const sqlCodigo = `
        SELECT id FROM CodigosSeguridad
        WHERE email = ? AND tipo = 'registro' AND token_hash = ? AND usado = 0 AND expira_en > ?
        ORDER BY id DESC LIMIT 1
    `;

    db.query(sqlCodigo, [email, codigoHash, nowSql], (errCod, rowsCod) => {
        if (errCod) {
            console.error(errCod);
            return res.status(500).send('Error validating security code.');
        }
        if (!rowsCod || rowsCod.length === 0) {
            return res.status(400).send('Incorrect or expired verification code / secret key.');
        }

        db.query('UPDATE CodigosSeguridad SET usado = 1 WHERE id = ?', [rowsCod[0].id], () => {
            procederConCreacion();
        });
    });
});

// Inicio de sesión (con anti-enumeración, timing parity, estado de cuenta y MFA opcional)
app.post('/api/auth/login', loginIpLimiter.middleware, requireNonEmptyBody, preventDuplicateSubmit({ dedupeWindowMs: 0, cacheReplay: false }), async (req, res) => {
    const ip = getClientIp(req);
    const email = normalizeEmail(req.body.email);
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    if (!email || !password) {
        return res.status(400).send('Enter a valid email and password.');
    }

    const accountLimitKey = `${ip}:${email}`;
    const accountQuota = loginAccountLimiter.consume(accountLimitKey);
    loginAccountLimiter.applyHeaders(res, accountQuota);
    if (!accountQuota.allowed) {
        return res.status(429).send('Too many failed attempts. Please wait 15 minutes.');
    }

    db.query('SELECT id, nombre, email, password_hash, rol, estado FROM Usuarios WHERE email = ? LIMIT 1', [email], async (err, rows) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Database query error.');
        }
        if (!rows || rows.length === 0) {
            await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
            return res.status(401).send('Incorrect email or password.');
        }

        const user = rows[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) {
            return res.status(401).send('Incorrect email or password.');
        }

        if ((user.estado || 'activo') !== 'activo') {
            return res.status(403).send('Your account is inactive or suspended. Contact the administrator.');
        }

        loginAccountLimiter.reset(accountLimitKey);

        // Limpiar sesiones/códigos vencidos
        limpiarRegistrosExpirados();

        // MFA opcional por correo si ENABLE_LOGIN_MFA=true y SMTP está configurado
        if (ENABLE_LOGIN_MFA && crearTransporterCorreo()) {
            const mfaCode = String(crypto.randomInt(100000, 999999));
            const mfaHash = sha256Hex(mfaCode);
            const mfaExpires = new Date(Date.now() + 10 * 60 * 1000);
            const mfaExpiresSql = formatMySqlDateTime(mfaExpires);
            const mfaToken = signMfaChallenge({
                userId: user.id,
                email: user.email,
                nonce: crypto.randomBytes(12).toString('hex'),
                exp: mfaExpires.getTime()
            });

            return db.query(
                'INSERT INTO CodigosSeguridad (email, tipo, token_hash, expira_en, usado) VALUES (?, "mfa", ?, ?, 0)',
                [user.email, mfaHash, mfaExpiresSql],
                async (errMfa) => {
                    if (errMfa) {
                        console.error(errMfa);
                        return res.status(500).send('Error generating verification challenge.');
                    }
                    try {
                        await enviarCorreo({
                            to: user.email,
                            subject: 'Login Verification Code - Personal Daily Hub',
                            html: `
                                <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 12px;">
                                    <h2 style="color: #1e2430; margin-top: 0;">Two-Step Sign-In Verification</h2>
                                    <p>Hello <strong>${escapeHtml(user.nombre)}</strong>, enter this 6-digit code to finish signing in (valid for 10 minutes):</p>
                                    <div style="font-size: 28px; font-weight: bold; letter-spacing: 6px; text-align: center; padding: 14px; background: #f3f4f6; border-radius: 8px; color: #111827;">
                                        ${mfaCode}
                                    </div>
                                </div>
                            `
                        });
                        return res.json({
                            mfaRequired: true,
                            email: user.email,
                            mfaToken,
                            message: 'Enter the 6-digit verification code sent to your email.'
                        });
                    } catch (mailErr) {
                        console.error('[MFA_MAIL_ERROR]', mailErr.message);
                        return res.status(500).send('Verification email service is temporarily unavailable.');
                    }
                }
            );
        }

        issueUserSession(res, user, {
            statusCode: 200,
            message: 'Signed in successfully.',
            errorMessage: 'Error creating session.',
            req
        });
    });
});

// Verificación de segundo factor por correo (MFA opcional al iniciar sesión)
app.post('/api/auth/verify-login-mfa', mfaVerifyLimiter.middleware, requireNonEmptyBody, preventDuplicateSubmit({ dedupeWindowMs: 0, cacheReplay: false }), (req, res) => {
    const mfaToken = typeof req.body.mfaToken === 'string' ? req.body.mfaToken.trim() : '';
    const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';

    const challenge = verifyMfaChallenge(mfaToken);
    if (!challenge || !/^\d{6}$/.test(code)) {
        return res.status(400).send('Invalid or expired verification code.');
    }

    const codeHash = sha256Hex(code);
    const nowSql = formatMySqlDateTime(new Date());
    const sqlCode = `
        SELECT id FROM CodigosSeguridad
        WHERE email = ? AND tipo = 'mfa' AND token_hash = ? AND usado = 0 AND expira_en > ?
        ORDER BY id DESC LIMIT 1
    `;

    db.query(sqlCode, [challenge.email, codeHash, nowSql], (err, rowsCod) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error validating verification code.');
        }
        if (!rowsCod || rowsCod.length === 0) {
            return res.status(400).send('Invalid or expired verification code.');
        }

        db.query('SELECT id, nombre, email, rol, estado FROM Usuarios WHERE id = ? AND email = ? LIMIT 1', [challenge.userId, challenge.email], (errUsr, userRows) => {
            if (errUsr || !userRows || userRows.length === 0) {
                return res.status(401).send('Account could not be verified.');
            }
            const user = userRows[0];
            if ((user.estado || 'activo') !== 'activo') {
                return res.status(403).send('Your account is inactive or suspended. Contact the administrator.');
            }

            db.query('UPDATE CodigosSeguridad SET usado = 1 WHERE id = ?', [rowsCod[0].id], () => {
                issueUserSession(res, user, {
                    statusCode: 200,
                    message: 'Signed in successfully.',
                    errorMessage: 'Error creating session.',
                    req
                });
            });
        });
    });
});

// Cerrar sesión manualmente
app.post('/api/auth/logout', preventDuplicateSubmit({ dedupeWindowMs: 0, cacheReplay: false }), (req, res) => {
    const cookies = parseCookies(req);
    const rawToken = cookies.mt_session;
    clearSessionCookie(res, req);

    if (!rawToken) {
        return res.json({ message: 'Signed out.' });
    }

    const tokenHash = sha256Hex(rawToken);
    db.query('DELETE FROM SesionesAuth WHERE token_hash = ?', [tokenHash], () => {
        res.json({ message: 'Signed out successfully.' });
    });
});

// Solicitar enlace de recuperación de contraseña por correo (respuesta uniforme anti-enumeración)
app.post('/api/auth/forgot-password', forgotPasswordLimiter.middleware, requireNonEmptyBody, preventDuplicateSubmit({ dedupeWindowMs: 15000 }), (req, res) => {
    const email = normalizeEmail(req.body.email);
    if (!email) {
        return res.status(400).send('Please enter a valid email address.');
    }

    const genericSuccessMsg = 'If this email is registered, you will receive a password reset link.';

    db.query('SELECT id, nombre, email, estado FROM Usuarios WHERE email = ? LIMIT 1', [email], (err, rows) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error processing request.');
        }
        if (!rows || rows.length === 0 || (rows[0].estado || 'activo') !== 'activo') {
            return res.json({ message: genericSuccessMsg });
        }

        const user = rows[0];
        const rawResetToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = sha256Hex(rawResetToken);
        const expira = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
        const expiraSql = formatMySqlDateTime(expira);

        db.query(
            'INSERT INTO CodigosSeguridad (email, tipo, token_hash, expira_en, usado) VALUES (?, "reset", ?, ?, 0)',
            [user.email, tokenHash, expiraSql],
            async (errIns) => {
                if (errIns) {
                    console.error(errIns);
                    return res.status(500).send('Error generating recovery link.');
                }

                const baseUrl = getResetBaseUrl(req);
                const resetUrl = `${baseUrl}/?resetToken=${rawResetToken}&email=${encodeURIComponent(user.email)}`;

                try {
                    await enviarCorreo({
                        to: user.email,
                        subject: 'Password Recovery - Personal Daily Hub',
                        html: `
                            <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 22px; border: 1px solid #e5e7eb; border-radius: 12px;">
                                <h2 style="color: #1e2430; margin-top: 0;">Reset Password</h2>
                                <p>Hello <strong>${escapeHtml(user.nombre)}</strong>,</p>
                                <p>You requested a password reset on Personal Daily Hub. Click the button below (valid for 30 minutes):</p>
                                <p style="text-align: center; margin: 26px 0;">
                                    <a href="${resetUrl}" style="background: #1e2430; color: #ffffff; text-decoration: none; padding: 12px 22px; border-radius: 8px; font-weight: bold; display: inline-block;">
                                        Reset My Password
                                    </a>
                                </p>
                                <p style="font-size: 12px; color: #6b7280;">If you did not request this change, you can safely ignore this message.</p>
                            </div>
                        `
                    });
                    res.json({ message: genericSuccessMsg });
                } catch (mailErr) {
                    console.error('[RECOVERY_MAIL_ERROR]', mailErr.message);
                    res.status(500).send('Recovery email service is temporarily unavailable.');
                }
            }
        );
    });
});

// Restablecer contraseña con el token enviado por correo
app.post('/api/auth/reset-password', resetPasswordLimiter.middleware, requireNonEmptyBody, preventDuplicateSubmit({ dedupeWindowMs: 0, cacheReplay: false }), (req, res) => {
    const email = normalizeEmail(req.body.email);
    const token = typeof req.body.token === 'string' ? req.body.token.trim() : '';
    const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';

    if (!email || !token || token.length < 32) {
        return res.status(400).send('Invalid recovery link.');
    }
    const passwordError = validatePasswordFormat(newPassword);
    if (passwordError) {
        return res.status(400).send(passwordError);
    }

    const tokenHash = sha256Hex(token);
    const nowSql = formatMySqlDateTime(new Date());
    const sqlCheck = `
        SELECT id FROM CodigosSeguridad
        WHERE email = ? AND tipo = 'reset' AND token_hash = ? AND usado = 0 AND expira_en > ?
        ORDER BY id DESC LIMIT 1
    `;

    db.query(sqlCheck, [email, tokenHash, nowSql], async (err, rows) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error verifying recovery link.');
        }
        if (!rows || rows.length === 0) {
            return res.status(400).send('The recovery link is invalid or has expired.');
        }

        const codigoId = rows[0].id;
        db.query('SELECT id, estado FROM Usuarios WHERE email = ? LIMIT 1', [email], async (errUsr, userRows) => {
            if (errUsr || !userRows || userRows.length === 0) {
                return res.status(400).send('The recovery link is invalid or has expired.');
            }
            if ((userRows[0].estado || 'activo') !== 'activo') {
                return res.status(403).send('Your account is inactive or suspended. Contact the administrator.');
            }

            try {
                const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
                db.query('UPDATE Usuarios SET password_hash = ? WHERE email = ?', [passwordHash, email], (errUpd, resultUpd) => {
                    if (errUpd || resultUpd.affectedRows === 0) {
                        return res.status(500).send('Could not update password.');
                    }

                    db.query('UPDATE CodigosSeguridad SET usado = 1 WHERE id = ?', [codigoId], () => {});
                    db.query(
                        'DELETE FROM SesionesAuth WHERE usuario_id = (SELECT id FROM Usuarios WHERE email = ? LIMIT 1)',
                        [email],
                        () => {}
                    );

                    res.json({ message: 'Password updated successfully. You can now sign in.' });
                });
            } catch (e) {
                console.error(e);
                res.status(500).send('Error hashing the new password.');
            }
        });
    });
});

// Gestión de cuenta del Psiquiatra desde la cuenta de administrador
app.get('/api/auth/medicos', apiReadLimiter.middleware, requireAdmin, (req, res) => {
    db.query("SELECT id, nombre, email, COALESCE(estado, 'activo') AS estado, fecha_registro FROM Usuarios WHERE rol = \"psiquiatra\" ORDER BY id DESC", (err, rows) => {
        if (err) return res.status(500).send('Error loading psychiatrist accounts.');
        res.json(rows);
    });
});

app.post('/api/auth/create-medico', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, preventDuplicateSubmit({ dedupeWindowMs: 10000 }), async (req, res) => {
    const nombre = typeof req.body.nombre === 'string' ? req.body.nombre.trim() : '';
    const email = normalizeEmail(req.body.email);
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    if (!nombre || nombre.length < 2 || nombre.length > 80) {
        return res.status(400).send('Doctor name must be between 2 and 80 characters.');
    }
    if (!email || email === ADMIN_EMAIL) {
        return res.status(400).send('Enter a valid psychiatrist email (different from owner email).');
    }
    const passwordError = validatePasswordFormat(password);
    if (passwordError) {
        return res.status(400).send(passwordError);
    }

    try {
        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const sql = `
            INSERT INTO Usuarios (nombre, email, password_hash, rol, estado)
            VALUES (?, ?, ?, 'psiquiatra', 'activo')
            ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), password_hash = VALUES(password_hash), rol = 'psiquiatra', estado = 'activo'
        `;
        db.query(sql, [nombre, email, passwordHash], (err) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error saving psychiatrist account.');
            }
            res.json({ message: 'Psychiatrist account (read-only) saved successfully.' });
        });
    } catch (e) {
        res.status(500).send('Error hashing password.');
    }
});

app.patch('/api/auth/medicos/:id/estado', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, preventDuplicateSubmit({ dedupeWindowMs: 0 }), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).send('Invalid ID.');

    const estado = typeof req.body.estado === 'string' ? req.body.estado.trim().toLowerCase() : '';
    if (!ESTADOS_CUENTA_VALIDOS.has(estado)) {
        return res.status(400).send('Invalid account status. Allowed: activo, inactivo, suspendido.');
    }

    db.query('UPDATE Usuarios SET estado = ? WHERE id = ? AND rol = "psiquiatra"', [estado, id], (err, result) => {
        if (err) return res.status(500).send('Error updating account status.');
        if (result.affectedRows === 0) return res.status(404).send('Account not found.');

        if (estado !== 'activo') {
            db.query('DELETE FROM SesionesAuth WHERE usuario_id = ?', [id], () => {});
        }
        res.json({ message: 'Psychiatrist account status updated.', id, estado });
    });
});

app.delete('/api/auth/medicos/:id', apiWriteLimiter.middleware, requireAdmin, preventDuplicateSubmit({ dedupeWindowMs: 0 }), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).send('Invalid ID.');

    db.query('DELETE FROM Usuarios WHERE id = ? AND rol = "psiquiatra"', [id], (err, result) => {
        if (err) return res.status(500).send('Error deleting account.');
        if (result.affectedRows === 0) return res.status(404).send('Account not found.');
        res.json({ message: 'Psychiatrist access revoked successfully.' });
    });
});

// ==========================================
// RUTAS DE MOOD Y SUEÑO (PROTEGIDAS POR ROL)
// ==========================================
const MOMENTOS_VALIDOS = new Set(['Madrugada', 'Morning', 'Noon', 'Afternoon', 'Night']);
const CALIDADES_SUENO_VALIDAS = new Set(['Good', 'Regular', 'Bad']);
const SLEEP_TIPOS_VALIDOS = new Set(['normal', 'siesta', 'desvelo_tarde', 'desvelo_total']);
const FECHA_ISO_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const HEX_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/;
const HORA_24H_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

function isLateBedtimeHHMM(hhmm = '', cutoffHHMM = '01:00') {
    if (!HORA_24H_REGEX.test(hhmm)) return false;
    const [h, m] = hhmm.split(':').map(Number);
    const totalMin = h * 60 + m;
    const safeCutoff = HORA_24H_REGEX.test(String(cutoffHHMM || '').trim())
        ? String(cutoffHHMM).trim()
        : '01:00';
    const [ch, cm] = safeCutoff.split(':').map(Number);
    const cutoffMin = ch * 60 + cm;

    if (cutoffMin >= 18 * 60) {
        return totalMin >= cutoffMin || totalMin < 360;
    }
    if (cutoffMin < 360) {
        return totalMin >= cutoffMin && totalMin < 360;
    }
    return totalMin >= 60 && totalMin < 360;
}

function evaluateSleepClassification({
    tipoRegistro = 'normal',
    horaDormir = '',
    horas = 0,
    isPendingWakeup = false,
    explicitEsDesvelo = false,
    hasExplicitDesvelo = false,
    settings = {}
} = {}) {
    if (tipoRegistro === 'siesta') {
        return {
            tipoRegistro: 'siesta',
            esDesvelo: false,
            horas: Number(horas) || 0,
            lateBedtime: false,
            shortSleep: false
        };
    }

    if (tipoRegistro === 'desvelo_total') {
        return {
            tipoRegistro: 'desvelo_total',
            esDesvelo: true,
            horas: 0,
            lateBedtime: false,
            shortSleep: false
        };
    }

    const cutoffHHMM = HORA_24H_REGEX.test(String(settings?.sleepDesveloBedtimeTime || '').trim())
        ? String(settings.sleepDesveloBedtimeTime).trim()
        : '01:00';
    const rawMinHours = Number(settings?.sleepMinNormalHours);
    const minNormalHours = Number.isFinite(rawMinHours) && rawMinHours >= 3 && rawMinHours <= 12
        ? rawMinHours
        : 7;

    const lateBedtime = horaDormir ? isLateBedtimeHHMM(horaDormir, cutoffHHMM) : false;

    if (isPendingWakeup) {
        const esDesvelo = tipoRegistro === 'desvelo_tarde'
            || lateBedtime
            || (hasExplicitDesvelo && Boolean(explicitEsDesvelo));
        return {
            tipoRegistro: esDesvelo ? 'desvelo_tarde' : 'normal',
            esDesvelo,
            horas: 0,
            lateBedtime,
            shortSleep: false
        };
    }

    const horasNum = Number(horas);
    const shortSleep = Number.isFinite(horasNum) && horasNum > 0 ? horasNum < minNormalHours : false;
    const autoDesvelo = lateBedtime || shortSleep;

    let esDesvelo;
    if (hasExplicitDesvelo) {
        esDesvelo = Boolean(explicitEsDesvelo);
    } else if (tipoRegistro === 'desvelo_tarde') {
        esDesvelo = true;
    } else {
        esDesvelo = autoDesvelo;
    }

    return {
        tipoRegistro: esDesvelo ? 'desvelo_tarde' : 'normal',
        esDesvelo,
        horas: Number.isFinite(horasNum) ? horasNum : 0,
        lateBedtime,
        shortSleep
    };
}

// Guardar el estado de ánimo (SOLO ADMIN)
app.post('/api/insert-mood', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, preventDuplicateSubmit({ dedupeWindowMs: 10000 }), (req, res) => {
    const { fecha, momento_dia, estado_animo, color_hex } = req.body;

    if (!fecha || !FECHA_ISO_REGEX.test(fecha)) {
        return res.status(400).send('Invalid date (expected YYYY-MM-DD).');
    }
    if (!momento_dia || !MOMENTOS_VALIDOS.has(momento_dia)) {
        return res.status(400).send('Invalid time of day.');
    }
    if (typeof estado_animo !== 'string' || !estado_animo.trim() || estado_animo.trim().length > 50) {
        return res.status(400).send('Invalid mood value.');
    }
    if (typeof color_hex !== 'string' || !HEX_COLOR_REGEX.test(color_hex)) {
        return res.status(400).send('Invalid hex color.');
    }

    const checkSql = 'SELECT * FROM RegistrosMood WHERE fecha = ? AND momento_dia = ?';

    db.query(checkSql, [fecha, momento_dia], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Database query error.');
        }

        if (result.length > 0) {
            if (puedeModificar(fecha, momento_dia)) {
                const sqlUpdate = 'UPDATE RegistrosMood SET estado_animo = ?, color_hex = ? WHERE fecha = ? AND momento_dia = ?';
                db.query(sqlUpdate, [estado_animo.trim(), color_hex, fecha, momento_dia], (errUpdate) => {
                    if (errUpdate) {
                        console.error(errUpdate);
                        return res.status(500).send('Error updating record.');
                    }
                    res.send('Record updated successfully\nYou were still within the edit window.');
                    bumpSyncRevision('mood');
                });
            } else {
                res.status(400).send('The time window to edit this time of day has already expired.');
            }
        } else {
            const sqlInsert = 'INSERT INTO RegistrosMood (fecha, momento_dia, estado_animo, color_hex) VALUES (?, ?, ?, ?)';
            db.query(sqlInsert, [fecha, momento_dia, estado_animo.trim(), color_hex], (errInsert) => {
                if (errInsert) {
                    console.error(errInsert);
                    return res.status(500).send('Error saving to database.');
                }

                bumpSyncRevision('mood');
                res.send('Mood saved successfully.');
            });
        }
    });
});

// Dar de alta un nuevo registro de sueño o desvelo (SOLO ADMIN)
app.post('/api/insert-sleep', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, preventDuplicateSubmit({ dedupeWindowMs: 15000 }), async (req, res) => {
    const fecha = String(req.body.fecha || '').trim();
    const rawHoraDormir = String(req.body.horaDormir ?? req.body.hora_dormir ?? '').trim();
    const rawHoraDespertar = String(req.body.horaDespertar ?? req.body.hora_despertar ?? '').trim();
    const rawTipo = String(req.body.tipoRegistro ?? req.body.tipo_registro ?? 'normal').trim();
    const rawMotivo = String(req.body.motivoDesvelo ?? req.body.motivo_desvelo ?? '').trim();
    const hasExplicitDesvelo = req.body.esDesvelo !== undefined || req.body.es_desvelo !== undefined;
    const rawEsDesvelo = Boolean(req.body.esDesvelo ?? req.body.es_desvelo ?? false);
    const rawCalidad = String(req.body.calidad || (rawTipo === 'desvelo_total' ? 'Bad' : '')).trim();
    const rawHoras = req.body.horas;

    if (!fecha || !FECHA_ISO_REGEX.test(fecha)) {
        return res.status(400).send('Invalid date (expected YYYY-MM-DD).');
    }
    if (!SLEEP_TIPOS_VALIDOS.has(rawTipo)) {
        return res.status(400).send('Invalid sleep entry type.');
    }
    if (rawHoraDormir && !HORA_24H_REGEX.test(rawHoraDormir)) {
        return res.status(400).send('Invalid bedtime format (expected HH:MM).');
    }
    if (rawHoraDespertar && !HORA_24H_REGEX.test(rawHoraDespertar)) {
        return res.status(400).send('Invalid wake-up time format (expected HH:MM).');
    }
    if (rawMotivo.length > 500) {
        return res.status(400).send('Desvelo reason note cannot exceed 500 characters.');
    }
    if (!rawCalidad || !CALIDADES_SUENO_VALIDAS.has(rawCalidad)) {
        return res.status(400).send('Invalid sleep quality.');
    }

    const isAllNighter = rawTipo === 'desvelo_total';
    const isPendingWakeup = (rawTipo === 'normal' || rawTipo === 'desvelo_tarde')
        && Boolean(rawHoraDormir)
        && !rawHoraDespertar
        && (rawHoras === undefined || rawHoras === '' || Number(rawHoras) === 0);

    let horasNum = rawHoras === undefined || rawHoras === '' ? 0 : Number(rawHoras);
    if (isAllNighter) {
        if (!Number.isFinite(horasNum) || horasNum < 0 || horasNum > 24) {
            return res.status(400).send('Sleep hours must be between 0 and 24 for an all-nighter.');
        }
        horasNum = 0;
    } else if (isPendingWakeup) {
        horasNum = 0;
    } else if (!Number.isFinite(horasNum) || horasNum <= 0 || horasNum > 24) {
        return res.status(400).send('Sleep hours must be a number between 0.1 and 24.');
    }

    const settings = await loadUserSettings(req.user.id).catch(() => getDefaultUserSettings());
    const classified = evaluateSleepClassification({
        tipoRegistro: rawTipo,
        horaDormir: rawHoraDormir,
        horas: horasNum,
        isPendingWakeup,
        explicitEsDesvelo: rawEsDesvelo,
        hasExplicitDesvelo,
        settings
    });

    const sql = `
        INSERT INTO RegistrosSleep
            (fecha, horas, calidad, hora_dormir, hora_despertar, es_desvelo, tipo_registro, motivo_desvelo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
        fecha,
        classified.horas,
        rawCalidad,
        rawHoraDormir || null,
        rawHoraDespertar || null,
        classified.esDesvelo ? 1 : 0,
        classified.tipoRegistro,
        rawMotivo || null
    ];

    db.query(sql, params, (err) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error saving sleep record.');
        }
        bumpSyncRevision('sleep');
        if (isAllNighter) {
            return res.send('All-nighter / desvelo log saved successfully (0 hrs · visible to psychiatrist).');
        }
        if (classified.tipoRegistro === 'siesta') {
            return res.send('Nap / siesta saved successfully.');
        }
        if (isPendingWakeup) {
            const reminderTime = settings.sleepReminderTime || '08:30';
            if (classified.esDesvelo) {
                return res.send(`Late bedtime (${rawHoraDormir}) saved! We will remind you at ${reminderTime} to log your wake-up time.`);
            }
            return res.send(`Bedtime (${rawHoraDormir}) saved! We will remind you at ${reminderTime} to log your wake-up time.`);
        }
        if (classified.esDesvelo) {
            return res.send('Sleep & desvelo record saved successfully (visible to psychiatrist).');
        }
        return res.send('Sleep record saved successfully.');
    });
});

// Completar hora de despertar o actualizar registro de sueño (SOLO ADMIN)
app.patch('/api/update-sleep/:id', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, preventDuplicateSubmit({ dedupeWindowMs: 0 }), async (req, res) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
        return res.status(400).send('Invalid sleep record ID.');
    }

    try {
        const rows = await dbQueryAsync(
            'SELECT id, fecha, horas, calidad, hora_dormir, hora_despertar, es_desvelo, tipo_registro, motivo_desvelo FROM RegistrosSleep WHERE id = ? LIMIT 1',
            [id]
        );
        if (!Array.isArray(rows) || rows.length === 0) {
            return res.status(404).send('Sleep record not found.');
        }

        const existing = rows[0];
        const horaDormir = req.body.horaDormir !== undefined || req.body.hora_dormir !== undefined
            ? String(req.body.horaDormir ?? req.body.hora_dormir ?? '').trim()
            : String(existing.hora_dormir || '').trim();
        const horaDespertar = req.body.horaDespertar !== undefined || req.body.hora_despertar !== undefined
            ? String(req.body.horaDespertar ?? req.body.hora_despertar ?? '').trim()
            : String(existing.hora_despertar || '').trim();
        const calidad = String(req.body.calidad ?? existing.calidad ?? 'Regular').trim();
        const rawTipo = String(req.body.tipoRegistro ?? req.body.tipo_registro ?? existing.tipo_registro ?? 'normal').trim();
        const motivoRaw = req.body.motivoDesvelo !== undefined || req.body.motivo_desvelo !== undefined
            ? String(req.body.motivoDesvelo ?? req.body.motivo_desvelo ?? '').trim()
            : String(existing.motivo_desvelo || '').trim();
        const horasNum = Number(req.body.horas ?? existing.horas ?? 0);

        if (horaDormir && !HORA_24H_REGEX.test(horaDormir)) {
            return res.status(400).send('Invalid bedtime format (expected HH:MM).');
        }
        if (horaDespertar && !HORA_24H_REGEX.test(horaDespertar)) {
            return res.status(400).send('Invalid wake-up time format (expected HH:MM).');
        }
        if (!CALIDADES_SUENO_VALIDAS.has(calidad) || !SLEEP_TIPOS_VALIDOS.has(rawTipo)) {
            return res.status(400).send('Invalid sleep quality or entry type.');
        }
        if (motivoRaw.length > 500) {
            return res.status(400).send('Desvelo reason note cannot exceed 500 characters.');
        }
        if (!Number.isFinite(horasNum) || horasNum <= 0 || horasNum > 24) {
            if (rawTipo !== 'desvelo_total') {
                return res.status(400).send('Sleep hours must be a number between 0.1 and 24.');
            }
        }

        const hasExplicitDesvelo = req.body.esDesvelo !== undefined || req.body.es_desvelo !== undefined;
        const explicitEsDesvelo = Boolean(req.body.esDesvelo ?? req.body.es_desvelo);
        const settings = await loadUserSettings(req.user.id).catch(() => getDefaultUserSettings());
        const classified = evaluateSleepClassification({
            tipoRegistro: rawTipo,
            horaDormir,
            horas: rawTipo === 'desvelo_total' ? 0 : horasNum,
            isPendingWakeup: false,
            explicitEsDesvelo,
            hasExplicitDesvelo,
            settings
        });

        const sqlUpdate = `
            UPDATE RegistrosSleep
            SET hora_dormir = ?, hora_despertar = ?, horas = ?, calidad = ?, es_desvelo = ?, tipo_registro = ?, motivo_desvelo = ?
            WHERE id = ?
        `;
        await dbQueryAsync(sqlUpdate, [
            horaDormir || null,
            horaDespertar || null,
            classified.horas,
            calidad,
            classified.esDesvelo ? 1 : 0,
            classified.tipoRegistro,
            motivoRaw || null,
            id
        ]);

        bumpSyncRevision('sleep');
        res.json({
            ok: true,
            id,
            esDesvelo: classified.esDesvelo,
            tipoRegistro: classified.tipoRegistro,
            message: 'Sleep session updated successfully.'
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error updating sleep record.');
    }
});

// Eliminar un registro de sueño (SOLO ADMIN)
app.delete('/api/delete-sleep/:id', apiWriteLimiter.middleware, requireAdmin, preventDuplicateSubmit({ dedupeWindowMs: 0 }), (req, res) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
        return res.status(400).send('Invalid sleep record ID.');
    }
    db.query('DELETE FROM RegistrosSleep WHERE id = ?', [id], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error deleting sleep record.');
        }
        if (!result || Number(result.affectedRows) === 0) {
            return res.status(404).send('Sleep record not found.');
        }
        bumpSyncRevision('sleep');
        res.json({ ok: true, id, message: 'Sleep record removed.' });
    });
});

// =========================================================================
// EXTRACTOR TEMPORAL EN MEMORIA RAM DESDE GOOGLE DRIVE (ZERO-DISK BLOAT)
// =========================================================================
let _driveArchiveRamCache = {
    loadedAt: 0,
    data: null
};
const DRIVE_RAM_CACHE_TTL_MS = 90 * 1000; // Vive solo 90 segundos en RAM durante la consulta

function getEffectiveDbRetentionDays() {
    const raw = process.env.DB_RETENTION_DAYS;
    if (raw === undefined || raw === null || String(raw).trim() === '') return 0;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return Math.floor(parsed);
}

function isDateOlderThanLocalWindow(dateStr, retentionDays = getEffectiveDbRetentionDays()) {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return false;
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
    const targetMs = Date.parse(`${dateStr}T00:00:00Z`);
    if (!Number.isFinite(targetMs)) return false;
    const cutoffMs = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    return targetMs < cutoffMs;
}

let _rcloneConfSeq = 0;

function resolveRcloneConfigPath({ preferStudy = false } = {}) {
    if (preferStudy && process.env.STUDY_RCLONE_CONF_B64) {
        try {
            const shmDir = fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir();
            const studyConfPath = path.join(shmDir, `.rclone_study_${process.pid}_${Date.now()}_${++_rcloneConfSeq}.conf`);
            fs.writeFileSync(
                studyConfPath,
                Buffer.from(String(process.env.STUDY_RCLONE_CONF_B64).replace(/\s+/g, ''), 'base64'),
                { mode: 0o600 }
            );
            return { confPath: studyConfPath, cleanup: true, usingStudyConfig: true };
        } catch (_) {}
    }

    const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir() || '/tmp';
    const defaultConf = process.env.RCLONE_CONFIG || path.join(homeDir, '.config', 'rclone', 'rclone.conf');
    if (fs.existsSync(defaultConf)) {
        return { confPath: defaultConf, cleanup: false, usingStudyConfig: false };
    }

    if (process.env.RCLONE_CONF_B64) {
        try {
            const shmDir = fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir();
            const ramConfPath = path.join(shmDir, `.rclone_main_${process.pid}_${Date.now()}_${++_rcloneConfSeq}.conf`);
            fs.writeFileSync(
                ramConfPath,
                Buffer.from(String(process.env.RCLONE_CONF_B64).replace(/\s+/g, ''), 'base64'),
                { mode: 0o600 }
            );
            return { confPath: ramConfPath, cleanup: true, usingStudyConfig: false };
        } catch (_) {}
    }
    return { confPath: defaultConf, cleanup: false, usingStudyConfig: false };
}

function loadDriveHistoricalArchiveInRam() {
    return new Promise((resolve) => {
        const now = Date.now();
        if (_driveArchiveRamCache.data && (now - _driveArchiveRamCache.loadedAt) < DRIVE_RAM_CACHE_TTL_MS) {
            return resolve(_driveArchiveRamCache.data);
        }

        const remoteName = String(process.env.RCLONE_REMOTE || 'gdrive').trim();
        const remoteDir = String(process.env.RCLONE_BACKUP_DIR || 'RespaldosApp').trim();
        const { confPath: rcloneConf, cleanup: cleanupConf } = resolveRcloneConfigPath({ preferStudy: false });

        if (!fs.existsSync(rcloneConf)) {
            return resolve(null);
        }

        const zlib = require('node:zlib');
        serverNotesService.runRcloneCommand({
            rcloneConf,
            args: ['cat', `${remoteName}:${remoteDir}/historico_completo.json.gz`],
            timeout: 22000,
            encoding: 'buffer',
            maxBuffer: 32 * 1024 * 1024
        }).then((stdoutBuf) => {
            if (!stdoutBuf || stdoutBuf.length === 0) return resolve(null);
            const unzipped = zlib.gunzipSync(stdoutBuf).toString('utf8');
            const parsed = JSON.parse(unzipped);
            _driveArchiveRamCache = { loadedAt: Date.now(), data: parsed };
            setTimeout(() => {
                if (Date.now() - _driveArchiveRamCache.loadedAt >= DRIVE_RAM_CACHE_TTL_MS) {
                    _driveArchiveRamCache = { loadedAt: 0, data: null };
                }
            }, DRIVE_RAM_CACHE_TTL_MS + 1000).unref?.();
            return resolve(parsed);
        }).catch(() => resolve(null)).finally(() => {
            if (cleanupConf) {
                try {
                    if (fs.existsSync(rcloneConf)) fs.unlinkSync(rcloneConf);
                } catch (_) {}
            }
        });
    });
}

async function mergeLocalRowsWithDriveRam(kind, localRows, begin, end, forceDrive = false) {
    const listLocal = Array.isArray(localRows) ? localRows : [];
    if (!forceDrive && !isDateOlderThanLocalWindow(begin)) {
        return listLocal;
    }
    const archive = await loadDriveHistoricalArchiveInRam();
    if (!archive || !archive[kind] || typeof archive[kind] !== 'object') {
        return listLocal;
    }

    const archivedItems = Object.values(archive[kind]).filter(item => {
        const f = String(item?.fecha || '').slice(0, 10);
        if (!f) return false;
        if (begin && f < begin) return false;
        if (end && f > end) return false;
        return true;
    });

    if (archivedItems.length === 0) return listLocal;

    const mergedMap = new Map();
    for (const row of archivedItems) {
        const key = kind === 'mood'
            ? `${String(row.fecha).slice(0, 10)}_${row.momento_dia}`
            : String(row.id || `${row.fecha}_${row.hora || ''}`);
        mergedMap.set(key, row);
    }
    for (const row of listLocal) {
        const fStr = row.fecha instanceof Date
            ? row.fecha.toISOString().slice(0, 10)
            : String(row.fecha || '').slice(0, 10);
        const key = kind === 'mood'
            ? `${fStr}_${row.momento_dia}`
            : String(row.id || `${fStr}_${row.hora || ''}`);
        mergedMap.set(key, row);
    }
    return Array.from(mergedMap.values());
}

// Consultar estados de ánimo (PERMITIDO A ADMIN Y PSIQUIATRA; extrae de Drive en RAM si supera 1 mes)
app.get('/api/get-moods', apiReadLimiter.middleware, requireAuth, (req, res) => {
    const { begin, end, includeDrive } = req.query;
    if (!begin || !end || !FECHA_ISO_REGEX.test(begin) || !FECHA_ISO_REGEX.test(end)) {
        return res.status(400).send('Parameters begin and end are required (YYYY-MM-DD).');
    }

    const sql = 'SELECT fecha, momento_dia, color_hex FROM RegistrosMood WHERE fecha BETWEEN ? AND ?';

    db.query(sql, [begin, end], async (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Database query error.');
        }
        const merged = await mergeLocalRowsWithDriveRam('mood', result, begin, end, includeDrive === '1');
        res.json(merged);
    });
});

// Consultar horas de sueño y desvelos (PERMITIDO A ADMIN Y PSIQUIATRA; extrae de Drive en RAM si supera 1 mes)
app.get('/api/get-sleep', apiReadLimiter.middleware, requireAuth, (req, res) => {
    const { begin, end, includeDrive } = req.query;
    if (!begin || !end || !FECHA_ISO_REGEX.test(begin) || !FECHA_ISO_REGEX.test(end)) {
        return res.status(400).send('Parameters begin and end are required (YYYY-MM-DD).');
    }

    const sql = `
        SELECT id, fecha, horas, calidad, hora_dormir, hora_despertar, es_desvelo, tipo_registro, motivo_desvelo, fecha_registro
        FROM RegistrosSleep
        WHERE fecha BETWEEN ? AND ?
        ORDER BY fecha ASC, id ASC
    `;

    db.query(sql, [begin, end], async (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Database query error.');
        }
        const merged = await mergeLocalRowsWithDriveRam('sleep', result, begin, end, includeDrive === '1');
        res.json(merged);
    });
});

// =======================================================
// REGISTRO DE CRISIS (SOLO ADMIN ESCRIBE; PSIQUIATRA SOLO LECTURA)
// =======================================================
const DEFAULT_CRISIS_EPISODE_TYPES = [
    { id: 'estres', label: 'Estrés', icon: '😣' },
    { id: 'ira_rabia', label: 'Ira / Rabia', icon: '😠' },
    { id: 'ansiedad', label: 'Ansiedad', icon: '😰' },
    { id: 'panico', label: 'Pánico', icon: '🫨' },
    { id: 'llanto_sobrecarga', label: 'Llanto / Sobrecarga', icon: '😢' },
    { id: 'bloqueo_saturacion', label: 'Bloqueo / Saturación', icon: '🧱' },
    { id: 'insomnio_agitacion', label: 'Insomnio / Agitación', icon: '🌘' },
    { id: 'tristeza_desanimo', label: 'Tristeza / Desánimo', icon: '😔' },
    { id: 'frustracion_impotencia', label: 'Frustración / Impotencia', icon: '😤' },
    { id: 'agotamiento_mental', label: 'Agotamiento Mental', icon: '🪫' }
];

function getDefaultCrisisEpisodeTypes() {
    return DEFAULT_CRISIS_EPISODE_TYPES.map((item) => ({ ...item }));
}

function sanitizeCrisisEpisodeTypes(rawList, fallbackList = getDefaultCrisisEpisodeTypes()) {
    if (!Array.isArray(rawList)) {
        return Array.isArray(fallbackList) ? fallbackList.map((item) => ({ ...item })) : [];
    }
    const out = [];
    const seenLabels = new Set();
    const seenIds = new Set();
    for (let idx = 0; idx < rawList.length; idx += 1) {
        if (out.length >= 25) break;
        const entry = rawList[idx];
        const rawLabel = typeof entry === 'string' ? entry : entry?.label;
        const cleanLabel = String(rawLabel || '')
            .replace(/[\x00-\x1F\x7F<>]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        if (cleanLabel.length < 2 || cleanLabel.length > 60) continue;
        if (/^(otro|other)$/i.test(cleanLabel)) continue;
        const dedupeKey = cleanLabel.toLowerCase();
        if (seenLabels.has(dedupeKey)) continue;
        seenLabels.add(dedupeKey);

        const cleanIcon = typeof entry === 'object' && entry !== null
            ? String(entry.icon ?? '').replace(/[\x00-\x1F\x7F<>]/g, '').trim().slice(0, 12)
            : '';

        let cleanId = typeof entry === 'object' && entry !== null
            ? String(entry.id || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48)
            : '';
        if (!cleanId) {
            cleanId = cleanLabel
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/[^a-z0-9]+/g, '_')
                .replace(/^_+|_+$/g, '')
                .slice(0, 36) || `tipo_${out.length + 1}`;
        }
        let finalId = cleanId;
        let suffix = 2;
        while (seenIds.has(finalId)) {
            finalId = `${cleanId.slice(0, 42)}_${suffix++}`;
        }
        seenIds.add(finalId);
        out.push({ id: finalId, label: cleanLabel, icon: cleanIcon });
    }
    if (out.length === 0) {
        return Array.isArray(fallbackList) ? fallbackList.map((item) => ({ ...item })) : [];
    }
    return out;
}

const CRISIS_TIPOS_VALIDOS = new Set([
    ...DEFAULT_CRISIS_EPISODE_TYPES.map((item) => item.label),
    'Otro'
]);

app.post('/api/insert-crisis', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, preventDuplicateSubmit({ dedupeWindowMs: 8000 }), async (req, res) => {
    const fecha = String(req.body.fecha || '').trim();
    const hora = String(req.body.hora || '').trim();
    const tipoCrisis = String(req.body.tipoCrisis || req.body.tipo_crisis || '').trim();
    const intensidadNum = Number(req.body.intensidad ?? 3);
    const detalleOtro = String(req.body.detalleOtro || '').trim().slice(0, 80);
    const rawMotivo = String(req.body.motivo || '').trim();
    const allowOptional = Boolean(req.body.allowOptionalMotivo);

    if (!fecha || !FECHA_ISO_REGEX.test(fecha)) {
        return res.status(400).send('Fecha inválida (formato esperado YYYY-MM-DD).');
    }
    if (!hora || !HORA_24H_REGEX.test(hora)) {
        return res.status(400).send('Hora inválida (formato HH:MM 24h).');
    }

    const userSettings = await loadUserSettings(req.user.id).catch(() => getDefaultUserSettings());
    const allowedTypes = new Set(CRISIS_TIPOS_VALIDOS);
    if (Array.isArray(userSettings?.crisisEpisodeTypes)) {
        for (const item of userSettings.crisisEpisodeTypes) {
            const lbl = String(item?.label || '').trim();
            if (lbl) allowedTypes.add(lbl);
        }
    }
    allowedTypes.add('Otro');

    if (!allowedTypes.has(tipoCrisis)) {
        return res.status(400).send('Tipo de crisis inválido.');
    }
    if (!Number.isInteger(intensidadNum) || intensidadNum < 1 || intensidadNum > 5) {
        return res.status(400).send('La intensidad debe ser un entero entre 1 y 5.');
    }

    let tipoCrisisFinal = tipoCrisis;
    let motivoFinal = rawMotivo;
    if (tipoCrisis === 'Otro' && detalleOtro) {
        tipoCrisisFinal = detalleOtro;
        motivoFinal = rawMotivo || 'Sin descripción adicional.';
    } else if (!motivoFinal && allowOptional && tipoCrisis !== 'Otro') {
        motivoFinal = `Episodio de ${tipoCrisis} (sin descripción adicional).`;
    }

    const maxAllowedChars = 250;
    if (rawMotivo.length > maxAllowedChars || !motivoFinal || motivoFinal.length > maxAllowedChars) {
        return res.status(400).send(`Escribe el motivo o detonante de la crisis (máx. ${maxAllowedChars} caracteres).`);
    }

    const sql = 'INSERT INTO RegistrosCrisis (fecha, hora, tipo_crisis, intensidad, motivo) VALUES (?, ?, ?, ?, ?)';
    db.query(sql, [fecha, hora, tipoCrisisFinal, intensidadNum, motivoFinal], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error saving crisis record.');
        }
        bumpSyncRevision('crisis');
        res.json({
            ok: true,
            id: result?.insertId || null,
            fecha,
            hora,
            tipo_crisis: tipoCrisisFinal,
            intensidad: intensidadNum,
            motivo: motivoFinal
        });
    });
});

// Consultar crisis registradas (PERMITIDO A ADMIN Y PSIQUIATRA; extrae de Drive en RAM si supera 1 mes)
app.get('/api/get-crisis', apiReadLimiter.middleware, requireAuth, (req, res) => {
    const { begin, end, includeDrive } = req.query;
    if ((begin || end) && (!begin || !end || !FECHA_ISO_REGEX.test(begin) || !FECHA_ISO_REGEX.test(end))) {
        return res.status(400).send('Parameters begin and end must both be YYYY-MM-DD.');
    }

    const sql = begin && end
        ? 'SELECT id, fecha, hora, tipo_crisis, intensidad, motivo, fecha_registro FROM RegistrosCrisis WHERE fecha BETWEEN ? AND ? ORDER BY fecha DESC, hora DESC, id DESC'
        : 'SELECT id, fecha, hora, tipo_crisis, intensidad, motivo, fecha_registro FROM RegistrosCrisis ORDER BY fecha DESC, hora DESC, id DESC LIMIT 500';
    const params = begin && end ? [begin, end] : [];

    db.query(sql, params, async (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Database query error.');
        }
        const merged = (begin && end)
            ? await mergeLocalRowsWithDriveRam('crisis', result, begin, end, includeDrive === '1')
            : (Array.isArray(result) ? result : []);
        res.json(merged);
    });
});

// Endpoint para extraer temporalmente de Google Drive hasta 120 meses (10 años) combinados con MySQL local
app.get('/api/archive/drive-range', apiReadLimiter.middleware, requireAuth, async (req, res) => {
    try {
        const months = Math.max(1, Math.min(120, Number.parseInt(String(req.query.months || '6'), 10) || 6));
        const endDt = new Date();
        const beginDt = new Date(endDt.getFullYear(), endDt.getMonth() - months, endDt.getDate());
        const begin = String(req.query.begin || beginDt.toISOString().slice(0, 10)).slice(0, 10);
        const end = String(req.query.end || endDt.toISOString().slice(0, 10)).slice(0, 10);

        if (!FECHA_ISO_REGEX.test(begin) || !FECHA_ISO_REGEX.test(end)) {
            return res.status(400).send('Invalid date range.');
        }

        const [localMoods, localSleeps, localCrises] = await Promise.all([
            dbQueryAsync('SELECT fecha, momento_dia, color_hex FROM RegistrosMood WHERE fecha BETWEEN ? AND ?', [begin, end]),
            dbQueryAsync('SELECT id, fecha, horas, calidad, hora_dormir, hora_despertar, es_desvelo, tipo_registro, motivo_desvelo FROM RegistrosSleep WHERE fecha BETWEEN ? AND ? ORDER BY fecha DESC', [begin, end]),
            dbQueryAsync('SELECT id, fecha, hora, tipo_crisis, intensidad, motivo FROM RegistrosCrisis WHERE fecha BETWEEN ? AND ? ORDER BY fecha DESC, hora DESC', [begin, end])
        ]);

        const [moods, sleeps, crises] = await Promise.all([
            mergeLocalRowsWithDriveRam('mood', localMoods, begin, end, true),
            mergeLocalRowsWithDriveRam('sleep', localSleeps, begin, end, true),
            mergeLocalRowsWithDriveRam('crisis', localCrises, begin, end, true)
        ]);

        const localRetentionDays = getEffectiveDbRetentionDays();
        const localSourceTag = localRetentionDays === 0 ? 'mysql_local_full' : `mysql_local_${localRetentionDays}d`;

        res.json({
            ok: true,
            source: _driveArchiveRamCache.data ? `google_drive_ram + ${localSourceTag}` : localSourceTag,
            localRetentionDays,
            monthsRequested: months,
            begin,
            end,
            counts: {
                moods: moods.length,
                sleeps: sleeps.length,
                crises: crises.length
            },
            moods,
            sleeps,
            crises
        });
    } catch (err) {
        console.error('[DRIVE_RANGE_RAM_ERROR]', err.message);
        res.status(500).send('Error loading historical range from Google Drive.');
    }
});

app.delete('/api/delete-crisis/:id', apiWriteLimiter.middleware, requireAdmin, preventDuplicateSubmit({ dedupeWindowMs: 0 }), (req, res) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
        return res.status(400).send('Invalid crisis record ID.');
    }
    db.query('DELETE FROM RegistrosCrisis WHERE id = ?', [id], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error deleting crisis record.');
        }
        if (!result || result.affectedRows === 0) {
            return res.status(404).send('Crisis record not found.');
        }
        bumpSyncRevision('crisis');
        res.json({ ok: true, id });
    });
});

// Verifica si aún es tiempo de modificar un estado de ánimo (incluye Madrugada 00:00 - 05:59)
function puedeModificar(fecha, momento_dia) {
    const now = new Date();

    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const currentDate = `${year}-${month}-${day}`;

    // 1. Si la fecha que intentas modificar no es hoy, se bloquea automáticamente
    if (fecha !== currentDate) {
        return false;
    }

    // 2. Si es hoy, validamos el rango de horas (formato 24h)
    const hour = now.getHours();
    switch (momento_dia) {
        case 'Madrugada':
            return hour >= 0 && hour < 6;
        case 'Morning':
            return hour >= 6 && hour < 12;
        case 'Noon':
            return hour >= 12 && hour < 14;
        case 'Afternoon':
            return hour >= 14 && hour < 20;
        case 'Night':
            return hour >= 20 && hour <= 23;
        default:
            return false;
    }
}

// Colas temporales acotadas en RAM hacia Word PC (Journal privado + English Notebook)
const MAX_COLA_TEXTOS = 100;

function createEncryptedPcQueue({ maxSize = MAX_COLA_TEXTOS, okMessage, emptyMessage, fullMessage }) {
    let queue = [];
    const waiters = new Set();

    function notifyWaiters() {
        if (waiters.size === 0 || queue.length === 0) return;
        const snapshot = Array.from(waiters);
        waiters.clear();
        let delivered = false;
        // Prefer the most recent waiter so stale/closing sockets don't swallow items
        for (let idx = snapshot.length - 1; idx >= 0; idx -= 1) {
            const waiter = snapshot[idx];
            if (!delivered && waiter.canRespond()) {
                const items = queue;
                queue = [];
                delivered = true;
                waiter.resolve(items);
            } else {
                waiter.resolve([]);
            }
        }
    }

    return {
        enqueue(req, res) {
            const { texto } = req.body || {};
            if (typeof texto !== 'string' || !texto.trim()) {
                return res.status(400).send(emptyMessage);
            }
            if (texto.length > 48000) {
                return res.status(400).send('Encrypted payload exceeds maximum allowed length.');
            }
            if (queue.includes(texto)) {
                return res.status(409).send('This encrypted entry is already queued for your PC.');
            }
            if (queue.length >= maxSize) {
                return res.status(429).send(fullMessage);
            }
            queue.push(texto);
            notifyWaiters();
            return res.send(okMessage);
        },
        pull(req, res) {
            if (queue.length > 0) {
                const items = queue;
                queue = [];
                return res.json(items);
            }

            const rawWaitMs = Number.parseInt(String(req.query?.waitMs || '0'), 10);
            const waitMs = Number.isFinite(rawWaitMs) ? Math.max(0, Math.min(25000, rawWaitMs)) : 0;
            if (waitMs <= 0) {
                return res.json([]);
            }

            let settled = false;
            const waiter = {
                timer: null,
                canRespond() {
                    return !settled && !res.headersSent && !res.writableEnded;
                },
                resolve(items) {
                    if (settled) return;
                    settled = true;
                    clearTimeout(waiter.timer);
                    waiters.delete(waiter);
                    if (!res.headersSent && !res.writableEnded) {
                        res.json(Array.isArray(items) ? items : []);
                    }
                },
            };

            waiter.timer = setTimeout(() => {
                waiter.resolve([]);
            }, waitMs);
            if (typeof waiter.timer.unref === 'function') waiter.timer.unref();

            waiters.add(waiter);
            req.on('close', () => {
                if (settled) return;
                settled = true;
                clearTimeout(waiter.timer);
                waiters.delete(waiter);
            });
        },
        size() {
            return queue.length;
        }
    };
}

const journalQueue = createEncryptedPcQueue({
    maxSize: MAX_COLA_TEXTOS,
    okMessage: 'Text queued for your PC.',
    emptyMessage: 'Text cannot be empty.',
    fullMessage: 'Sync queue is full; please wait for your PC to pull pending entries.'
});

const englishQueue = createEncryptedPcQueue({
    maxSize: MAX_COLA_TEXTOS,
    okMessage: 'English entry queued for your PC Word notebook.',
    emptyMessage: 'Entry payload cannot be empty.',
    fullMessage: 'English sync queue is full; please wait for your PC to pull pending entries.'
});

async function runWithDocxLock(lockName, taskFn) {
    return ytdlpService.runWithHeavyTaskLock(() =>
        withMySqlAdvisoryLock({
            pool: db,
            lockName,
            timeoutSec: 40,
            taskFn,
            onWarn: (msg) => serverLogger.warn('DOCX_LOCK', msg, { replicaId: REPLICA_ID, lockName })
        })
    );
}

function createEnglishLyricsGuard({
    mode = 'save',
    freshLyrics = '',
    songTitle = '',
    artistName = '',
    language = '',
    onComparison = null
} = {}) {
    return async ({ entry, docxBuffer }) => {
        const parsedNotebook = Buffer.isBuffer(docxBuffer) && docxBuffer.length >= 64
            ? parseStudyNotebookDocxBuffer(docxBuffer, { includeAllEntries: true, includeAll: true })
            : null;

        if (mode === 'save') {
            if (!parsedNotebook || !parsedNotebook.ok) {
                return { ok: true, entry };
            }
            const guardRes = guardMusicEntryLyricsBeforeSave(parsedNotebook, entry);
            if (guardRes.sectionFixed) {
                serverLogger.warn('DRIVE_NOTES', 'Sección de letra inconsistente descartada antes de guardar', {
                    songTitle: entry?.song_title || '',
                    droppedSection: guardRes.droppedSection || ''
                });
            }
            return guardRes;
        }

        if (!parsedNotebook || !parsedNotebook.ok) {
            return {
                ok: false,
                reason: 'SONG_NOT_FOUND',
                error: 'No se pudo leer English_Learning_Notebook.docx.'
            };
        }

        const existing = findNotebookSongEntry(parsedNotebook, {
            songTitle: songTitle || entry?.song_title || '',
            artistName: artistName || entry?.artists_display || ''
        });
        if (!existing) {
            return {
                ok: false,
                reason: 'SONG_NOT_FOUND',
                error: 'La canción no se encontró en English_Learning_Notebook.docx.'
            };
        }

        const resolvedTitle = existing.songTitle || songTitle || entry?.song_title || '';
        const resolvedArtist = existing.artist || artistName || entry?.artists_display || '';
        const resolvedLanguage = existing.fields?.language || language || entry?.language || '';
        const cmp = compareExistingVsFreshLyrics(existing, freshLyrics, {
            notebookData: parsedNotebook,
            songTitle: resolvedTitle,
            artistName: resolvedArtist,
            language: resolvedLanguage
        });
        if (typeof onComparison === 'function') {
            onComparison(cmp);
        }

        if (cmp.status === 'match') {
            return {
                ok: false,
                reason: 'UNCHANGED',
                similarity: cmp.similarity,
                error: 'La letra guardada ya coincide y está verificada.'
            };
        }

        if (!cmp.freshValid) {
            let errMsg = 'No se obtuvo una letra fiable para reemplazar; el archivo Word no fue modificado.';
            if (cmp.freshReason === 'DUPLICATE_OTHER_SONG') {
                errMsg = `La letra extraída coincide con otra canción existente ("${cmp.matchedSong || 'otra pista'}"). El archivo Word no fue modificado.`;
            } else if (cmp.freshReason === 'SECTION_MISMATCH') {
                errMsg = 'La letra extraída contiene secciones contradictorias de canciones distintas; el archivo Word no fue modificado.';
            }
            return {
                ok: false,
                reason: cmp.freshReason || 'NO_RELIABLE_LYRICS',
                matchedSong: cmp.matchedSong || '',
                similarity: cmp.similarity,
                error: errMsg
            };
        }

        return {
            ok: true,
            entry: {
                ...entry,
                song_title: resolvedTitle,
                artists_display: resolvedArtist,
                replace_lyrics: true
            }
        };
    };
}

let _englishDriveRetryTimer = null;
let _englishDriveRetryCount = 0;

function scheduleStudyDriveRetry() {
    if (_englishDriveRetryTimer) return;
    _englishDriveRetryCount += 1;
    const expFactor = Math.pow(2, Math.min(_englishDriveRetryCount - 1, 4));
    const delayMs = Math.min(600000, 30000 * expFactor);
    _englishDriveRetryTimer = setTimeout(async () => {
        _englishDriveRetryTimer = null;
        try {
            const flushRes = await runWithDocxLock('pdh_docx_english', () =>
                serverNotesService.flushPendingEnglishDriveUpload({
                    resolveRcloneFn: resolveRcloneConfigPath,
                    resolveStudyTargetFn: resolveStudyDriveRemoteTarget,
                    updateCacheFn: updateStudyNotebookCacheFromBuffer,
                    rootDir: __dirname
                })
            );
            if (!flushRes || !flushRes.pending || flushRes.flushed) {
                _englishDriveRetryCount = 0;
                if (flushRes && flushRes.flushed) {
                    serverLogger.info('DRIVE_NOTES', 'Reintento completado: cuaderno pendiente subido a Google Drive', {
                        localSize: flushRes.localSize,
                        remoteSize: flushRes.remoteSize
                    });
                }
            } else {
                console.warn('[STUDY_DRIVE_RETRY_WARN]', flushRes.error || 'Pending Drive sync not verified yet');
                scheduleStudyDriveRetry();
            }
        } catch (err) {
            console.warn('[STUDY_DRIVE_RETRY_WARN]', err.message);
            scheduleStudyDriveRetry();
        }
    }, delayMs);
    _englishDriveRetryTimer.unref?.();
}

function shiftIsoDate(isoDateStr, deltaDays) {
    const dt = new Date(`${isoDateStr}T12:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + deltaDays);
    return dt.toISOString().slice(0, 10);
}

async function resolveAdminJournalLocalNow(userId = null) {
    let tz = process.env.TZ || 'America/Monterrey';
    if (userId) {
        try {
            const settings = await loadUserSettings(userId);
            if (settings && settings.timezone) {
                tz = settings.timezone;
            }
        } catch (_) {}
    }
    return getLocalNowParts(tz);
}

function buildEmptyJournalCoverage(todayIso) {
    const yesterdayIso = shiftIsoDate(todayIso, -1);
    const todayHeading = serverNotesService.computeJournalHeadingForDateIso(todayIso);
    const yesterdayHeading = serverNotesService.computeJournalHeadingForDateIso(yesterdayIso);
    return {
        todayIso,
        todayHeading,
        todayStatus: 'missing',
        yesterdayIso,
        yesterdayHeading,
        yesterdayStatus: 'missing',
        firstDateIso: null,
        lastDateIso: null,
        totalDaysRecorded: 0,
        filledCount: 0,
        nothingToReportCount: 0,
        emptyHeadingCount: 0,
        missingPastDates: [],
        missingPastHeadings: [],
        allPastDaysFilled: true,
        recentDays: [{
            dateIso: todayIso,
            heading: todayHeading,
            status: 'missing',
            isToday: true
        }]
    };
}

// Enviar nota de Journal cifrada al servidor local (o cola PC si aplica) (SOLO ADMIN)
app.post('/api/send-to-pc', pcQueueWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, preventDuplicateSubmit({ dedupeWindowMs: 10000 }), async (req, res) => {
    const { texto } = req.body || {};
    if (typeof texto !== 'string' || !texto.trim()) {
        return res.status(400).send('Text cannot be empty.');
    }
    if (texto.length > 48000) {
        return res.status(400).send('Encrypted payload exceeds maximum allowed length.');
    }

    const secretKey = String(process.env.JOURNAL_SECRET_KEY || '');
    const wordPassword = String(process.env.WORD_PASSWORD || '');
    const trimmedTexto = texto.trim();
    const isSaltedCandidate = trimmedTexto.startsWith(`${serverNotesService.JOURNAL_SALTED_E2EE_PREFIX}:`);
    const isSalted = serverNotesService.isValidJournalSaltedEnvelope(trimmedTexto);
    if (
        serverNotesService.isServerAutonomousNotesEnabled()
        && serverNotesService.normalizeE2eeKeyBuffer(secretKey)
        && (isSaltedCandidate || serverNotesService.isValidE2eeEnvelope(trimmedTexto))
    ) {
        const dec = isSaltedCandidate
            ? serverNotesService.decryptJournalSaltedE2ee(trimmedTexto, secretKey)
            : serverNotesService.decryptClientE2ee(trimmedTexto, secretKey);
        if (!dec.ok) {
            return res.status(400).send(
                isSaltedCandidate
                    ? 'E2EE key mismatch or integrity check failed for journal entry.'
                    : 'E2EE key mismatch: server JOURNAL_SECRET_KEY could not decrypt entry.'
            );
        }
        if (wordPassword) {
            try {
                const localNow = await resolveAdminJournalLocalNow(req.user.id);
                const writeRes = await runWithDocxLock('pdh_docx_journal', () =>
                    serverNotesService.saveJournalNoteLocalEncrypted({
                        plainText: dec.plainText,
                        wordPassword,
                        targetDateIso: localNow.dateStr,
                        backfillMissingBefore: true,
                        rootDir: __dirname
                    })
                );
                if (writeRes && writeRes.ok) {
                    serverLogger.info('JOURNAL', 'Nota local cifrada guardada en Diario.docx', {
                        heading: writeRes.heading,
                        bytes: writeRes.bytes,
                        skipped: writeRes.skipped,
                        replacedPlaceholder: Boolean(writeRes.replacedPlaceholder),
                        backfilledCount: Array.isArray(writeRes.backfilledDates) ? writeRes.backfilledDates.length : 0,
                        encryptionScheme: isSalted ? 'pdh-j2-pbkdf2-hmac' : 'legacy-aes-cbc'
                    });
                    if (writeRes.skipped) {
                        return res.send(`Today already has a journal entry (${writeRes.heading}); "Nothing to report." was skipped.`);
                    }
                    bumpSyncRevision('journal');
                    return res.send(`Note encrypted with password and saved locally (${writeRes.heading}).`);
                }
                if (writeRes && writeRes.reason === 'WRONG_PASSWORD') {
                    return res.status(500).send('WORD_PASSWORD rejected by existing local Diario.docx; note was not written.');
                }
                if (writeRes && writeRes.reason !== 'MSOFFCRYPTO_MISSING') {
                    return res.status(500).send(writeRes.error || 'Could not write encrypted local Diario.docx.');
                }
            } catch (err) {
                console.error('[JOURNAL_LOCAL_WRITE_ERROR]', err.message);
                if (err && err.code === 'LOCK_TIMEOUT') {
                    return res.status(503).send('Concurrent journal file write busy; please retry shortly.');
                }
                return res.status(500).send('Error saving encrypted local Journal.');
            }
        }
    }

    bumpSyncRevision('journal');
    return journalQueue.enqueue(req, res);
});

// Ruta para que tu PC consulte notas de Journal pendientes (compatibilidad puente PC)
app.get('/api/pull-text', pcPullLimiter.middleware, requirePcBridgeAuthIfConfigured, journalQueue.pull);

// Estado e descarga segura (solo Admin) del Journal local cifrado con contraseña
app.get('/api/journal/local-status', apiReadLimiter.middleware, requireAdmin, (_req, res) => {
    const status = serverNotesService.getLocalJournalStatus({ rootDir: __dirname });
    return res.json({
        ok: true,
        autonomousEnabled: serverNotesService.isServerAutonomousNotesEnabled(),
        exists: status.exists,
        encrypted: status.encrypted,
        sizeBytes: status.sizeBytes,
        updatedAt: status.updatedAt,
        passwordConfigured: status.passwordConfigured,
        lastAutoVerifiedDate: _lastMidnightJournalDate || null
    });
});

app.get('/api/journal/download', apiReadLimiter.middleware, requireAdmin, (_req, res) => {
    const status = serverNotesService.getLocalJournalStatus({ rootDir: __dirname });
    if (!status.exists) {
        return res.status(404).send('Local encrypted Diario.docx has not been created yet.');
    }
    if (!status.encrypted) {
        return res.status(403).send('Refusing to download unencrypted Journal file.');
    }
    return res.download(status.path, 'Diario.docx');
});

async function handleEncryptedJournalDownload(req, res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');

    const autonomousEnabled = serverNotesService.isServerAutonomousNotesEnabled();
    const wordPassword = String(process.env.WORD_PASSWORD || '').trim();
    if (!autonomousEnabled || !wordPassword) {
        return res.status(409).json({
            ok: false,
            reason: !autonomousEnabled ? 'AUTONOMOUS_DISABLED' : 'PASSWORD_MISSING',
            error: !autonomousEnabled
                ? 'Autonomous local journal is not active on this server.'
                : 'WORD_PASSWORD is not configured on this server.'
        });
    }

    const status = serverNotesService.getLocalJournalStatus({ rootDir: __dirname });
    if (!status.exists) {
        return res.status(404).json({
            ok: false,
            reason: 'MISSING_FILE',
            error: 'Local encrypted Diario.docx has not been created yet.'
        });
    }
    if (!status.encrypted) {
        return res.status(403).json({
            ok: false,
            reason: 'UNENCRYPTED_FILE',
            error: 'Refusing to download unencrypted Journal file.'
        });
    }

    let downloadPassword = '';
    if (req.method === 'POST' && req.body && req.body.password !== undefined && req.body.password !== null) {
        if (typeof req.body.password !== 'string' || !serverNotesService.isValidJournalDownloadPassword(req.body.password)) {
            return res.status(400).json({
                ok: false,
                reason: 'INVALID_DOWNLOAD_PASSWORD',
                error: 'Download password must be between 8 and 128 characters.'
            });
        }
        downloadPassword = req.body.password;
    } else {
        try {
            const settings = await loadUserSettings(req.user.id);
            downloadPassword = resolveJournalDownloadPasswordFromSettings(settings);
        } catch (err) {
            console.error('[JOURNAL_DOWNLOAD_SETTINGS_ERROR]', err.message);
            return res.status(500).json({
                ok: false,
                reason: 'SETTINGS_LOAD_ERROR',
                error: 'Could not load journal download settings.'
            });
        }
        if (!downloadPassword) {
            return res.status(409).json({
                ok: false,
                reason: 'DOWNLOAD_PASSWORD_NOT_CONFIGURED',
                error: 'Configure or enter a download password first.'
            });
        }
    }

    try {
        const localNow = await resolveAdminJournalLocalNow(req.user.id);
        const exportRes = await runWithDocxLock('pdh_docx_journal', () =>
            serverNotesService.exportJournalDocxEncryptedForClient({
                wordPassword,
                downloadPassword,
                rootDir: __dirname
            })
        );
        downloadPassword = '';

        if (exportRes && exportRes.ok) {
            serverLogger.info('JOURNAL', 'Exportación cifrada E2EE del Diario descargada', {
                sizeBytes: exportRes.sizeBytes
            });
            return res.json({
                ok: true,
                filename: `Diario_${localNow.dateStr}.docx`,
                scheme: 'pdh-j2-pbkdf2-hmac-binary',
                encryptedDocx: exportRes.encryptedDocx,
                sizeBytes: exportRes.sizeBytes,
                updatedAt: exportRes.updatedAt
            });
        }

        const reason = exportRes?.reason || 'EXPORT_FAILED';
        const statusMap = {
            MISSING_FILE: 404,
            UNENCRYPTED_FILE: 403,
            INVALID_DOWNLOAD_PASSWORD: 400,
            MSOFFCRYPTO_MISSING: 409,
            PASSWORD_MISSING: 409
        };
        return res.status(statusMap[reason] || 500).json({
            ok: false,
            reason,
            error: exportRes?.error || 'Could not export local encrypted Diario.docx.'
        });
    } catch (err) {
        downloadPassword = '';
        if (err && err.code === 'LOCK_TIMEOUT') {
            return res.status(503).json({
                ok: false,
                reason: 'LOCK_TIMEOUT',
                error: 'Concurrent journal file write busy; please retry shortly.'
            });
        }
        console.error('[JOURNAL_ENCRYPTED_DOWNLOAD_ERROR]', err.message);
        return res.status(500).json({
            ok: false,
            reason: 'EXPORT_ERROR',
            error: 'Error exporting encrypted local Journal.'
        });
    }
}

app.get('/api/journal/download-encrypted', apiReadLimiter.middleware, requireAdmin, handleEncryptedJournalDownload);
app.post('/api/journal/download-encrypted', apiReadLimiter.middleware, requireAdmin, handleEncryptedJournalDownload);

// Estado de cobertura diaria del Diario (solo metadatos, nunca texto privado)
app.get('/api/journal/daily-status', apiReadLimiter.middleware, requireAdmin, async (req, res) => {
    const localNow = await resolveAdminJournalLocalNow(req.user.id);
    const yesterdayIso = shiftIsoDate(localNow.dateStr, -1);
    const todayHeading = serverNotesService.computeJournalHeadingForDateIso(localNow.dateStr);
    const status = serverNotesService.getLocalJournalStatus({ rootDir: __dirname });
    const autonomousEnabled = serverNotesService.isServerAutonomousNotesEnabled();
    const wordPassword = String(process.env.WORD_PASSWORD || '').trim();

    if (!autonomousEnabled || !wordPassword) {
        return res.json({
            ok: true,
            autonomousEnabled,
            passwordConfigured: Boolean(wordPassword),
            exists: status.exists,
            encrypted: status.encrypted,
            todayIso: localNow.dateStr,
            todayHeading,
            yesterdayIso,
            coverageAvailable: false,
            reason: !autonomousEnabled ? 'AUTONOMOUS_DISABLED' : 'PASSWORD_MISSING',
            lastAutoVerifiedDate: _lastMidnightJournalDate || null,
            coverage: null
        });
    }

    if (!status.exists) {
        return res.json({
            ok: true,
            autonomousEnabled: true,
            passwordConfigured: true,
            exists: false,
            encrypted: false,
            todayIso: localNow.dateStr,
            todayHeading,
            yesterdayIso,
            coverageAvailable: true,
            reason: null,
            lastAutoVerifiedDate: _lastMidnightJournalDate || null,
            coverage: buildEmptyJournalCoverage(localNow.dateStr)
        });
    }

    try {
        const inspectRes = await runWithDocxLock('pdh_docx_journal', () =>
            serverNotesService.inspectJournalDailyCoverage({
                wordPassword,
                todayIso: localNow.dateStr,
                rootDir: __dirname
            })
        );
        if (inspectRes && inspectRes.ok) {
            return res.json({
                ok: true,
                autonomousEnabled: true,
                passwordConfigured: true,
                exists: Boolean(inspectRes.exists),
                encrypted: Boolean(inspectRes.encrypted),
                todayIso: localNow.dateStr,
                todayHeading: inspectRes.coverage?.todayHeading || todayHeading,
                yesterdayIso,
                coverageAvailable: true,
                reason: null,
                lastAutoVerifiedDate: _lastMidnightJournalDate || null,
                coverage: inspectRes.coverage || buildEmptyJournalCoverage(localNow.dateStr)
            });
        }
        if (inspectRes && inspectRes.reason === 'MSOFFCRYPTO_MISSING') {
            return res.json({
                ok: true,
                autonomousEnabled: true,
                passwordConfigured: true,
                exists: status.exists,
                encrypted: status.encrypted,
                todayIso: localNow.dateStr,
                todayHeading,
                yesterdayIso,
                coverageAvailable: false,
                reason: 'MSOFFCRYPTO_MISSING',
                lastAutoVerifiedDate: _lastMidnightJournalDate || null,
                coverage: null
            });
        }
        if (inspectRes && inspectRes.reason === 'WRONG_PASSWORD') {
            return res.status(500).send('WORD_PASSWORD rejected by existing local Diario.docx; note was not written.');
        }
        return res.status(500).send(inspectRes?.error || 'Could not inspect local Diario.docx.');
    } catch (err) {
        if (err && err.code === 'LOCK_TIMEOUT') {
            return res.status(503).send('Concurrent journal file write busy; please retry shortly.');
        }
        console.error('[JOURNAL_DAILY_STATUS_ERROR]', err.message);
        return res.status(500).send('Error inspecting local Journal daily status.');
    }
});

// Verificar y rellenar días faltantes del Diario con "Nothing to report." (SOLO ADMIN)
app.post('/api/journal/verify-days', apiWriteLimiter.middleware, requireAdmin, preventDuplicateSubmit({ dedupeWindowMs: 3000 }), async (req, res) => {
    const localNow = await resolveAdminJournalLocalNow(req.user.id);
    const yesterdayIso = shiftIsoDate(localNow.dateStr, -1);
    const autonomousEnabled = serverNotesService.isServerAutonomousNotesEnabled();
    const wordPassword = String(process.env.WORD_PASSWORD || '').trim();

    if (!autonomousEnabled || !wordPassword) {
        return res.status(409).json({
            ok: false,
            reason: !autonomousEnabled ? 'AUTONOMOUS_DISABLED' : 'PASSWORD_MISSING',
            error: 'Autonomous local journal is not active on this server.'
        });
    }

    const status = serverNotesService.getLocalJournalStatus({ rootDir: __dirname });
    if (!status.exists) {
        return res.json({
            ok: true,
            exists: false,
            modified: false,
            filledDates: [],
            filledHeadings: [],
            coverage: buildEmptyJournalCoverage(localNow.dateStr),
            message: 'No journal file exists yet. Save your first entry or mark today as "Nothing to report." to start tracking.'
        });
    }

    try {
        const verifyRes = await runWithDocxLock('pdh_docx_journal', () =>
            serverNotesService.verifyJournalDailyCoverage({
                wordPassword,
                todayIso: localNow.dateStr,
                throughDateIso: yesterdayIso,
                createIfMissing: false,
                fillIfEmptyDoc: true,
                rootDir: __dirname
            })
        );
        if (verifyRes && verifyRes.ok) {
            _lastMidnightJournalDate = localNow.dateStr;
            const filledDates = Array.isArray(verifyRes.filledDates) ? verifyRes.filledDates : [];
            const filledCount = filledDates.length;
            if (filledCount > 0) {
                serverLogger.info('JOURNAL', 'Días faltantes completados en Diario.docx', {
                    filledCount,
                    filledDates
                });
            }
            const message = filledCount > 0
                ? `Filled ${filledCount} missing day(s) with "Nothing to report.".`
                : 'All past days are already filled.';
            if (filledCount > 0 || verifyRes.modified) {
                bumpSyncRevision('journal');
            }
            return res.json({
                ok: true,
                exists: true,
                modified: Boolean(verifyRes.modified),
                filledDates,
                filledHeadings: Array.isArray(verifyRes.filledHeadings) ? verifyRes.filledHeadings : [],
                coverage: verifyRes.coverage || null,
                message
            });
        }
        if (verifyRes && verifyRes.reason === 'MSOFFCRYPTO_MISSING') {
            return res.status(409).json({
                ok: false,
                reason: 'MSOFFCRYPTO_MISSING',
                error: verifyRes.error || 'msoffcrypto-tool is not installed on this server.'
            });
        }
        if (verifyRes && verifyRes.reason === 'WRONG_PASSWORD') {
            return res.status(500).send('WORD_PASSWORD rejected by existing local Diario.docx; note was not written.');
        }
        return res.status(500).send(verifyRes?.error || 'Could not write encrypted local Diario.docx.');
    } catch (err) {
        if (err && err.code === 'LOCK_TIMEOUT') {
            return res.status(503).send('Concurrent journal file write busy; please retry shortly.');
        }
        console.error('[JOURNAL_VERIFY_DAYS_ERROR]', err.message);
        return res.status(500).send('Error verifying local Journal days.');
    }
});

// Marcar explícitamente el día actual (u otra fecha <= hoy) como "Nothing to report." (SOLO ADMIN)
app.post('/api/journal/nothing-to-report', apiWriteLimiter.middleware, requireAdmin, preventDuplicateSubmit({ dedupeWindowMs: 5000 }), async (req, res) => {
    const localNow = await resolveAdminJournalLocalNow(req.user.id);
    const rawTarget = typeof req.body?.targetDateIso === 'string' ? req.body.targetDateIso.trim() : '';
    let targetDateIso = localNow.dateStr;
    if (rawTarget) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(rawTarget)) {
            return res.status(400).send('Invalid date format (expected YYYY-MM-DD).');
        }
        const parsedDt = new Date(`${rawTarget}T12:00:00Z`);
        if (Number.isNaN(parsedDt.getTime()) || parsedDt.toISOString().slice(0, 10) !== rawTarget) {
            return res.status(400).send('Invalid date format (expected YYYY-MM-DD).');
        }
        if (rawTarget > localNow.dateStr) {
            return res.status(400).send('Cannot mark a future journal date.');
        }
        targetDateIso = rawTarget;
    }

    const autonomousEnabled = serverNotesService.isServerAutonomousNotesEnabled();
    const wordPassword = String(process.env.WORD_PASSWORD || '').trim();
    if (!autonomousEnabled || !wordPassword) {
        return res.status(409).json({
            ok: false,
            reason: !autonomousEnabled ? 'AUTONOMOUS_DISABLED' : 'PASSWORD_MISSING',
            fallbackToPcQueue: true,
            error: 'Autonomous local journal is not active; use encrypted PC sync queue.'
        });
    }

    try {
        const writeRes = await runWithDocxLock('pdh_docx_journal', () =>
            serverNotesService.saveJournalNoteLocalEncrypted({
                plainText: 'Nothing to report.',
                wordPassword,
                targetDateIso,
                backfillMissingBefore: true,
                rootDir: __dirname
            })
        );
        if (writeRes && writeRes.ok) {
            _lastMidnightJournalDate = localNow.dateStr;
            serverLogger.info('JOURNAL', 'Día marcado en Diario.docx', {
                heading: writeRes.heading,
                skipped: Boolean(writeRes.skipped),
                backfilledCount: Array.isArray(writeRes.backfilledDates) ? writeRes.backfilledDates.length : 0
            });
            const message = writeRes.skipped
                ? `Today already has a journal entry (${writeRes.heading}); "Nothing to report." was skipped.`
                : `Marked "${writeRes.heading}" as "Nothing to report.".`;
            if (!writeRes.skipped) {
                bumpSyncRevision('journal');
            }
            return res.json({
                ok: true,
                skipped: Boolean(writeRes.skipped),
                heading: writeRes.heading,
                backfilledDates: Array.isArray(writeRes.backfilledDates) ? writeRes.backfilledDates : [],
                backfilledHeadings: Array.isArray(writeRes.backfilledHeadings) ? writeRes.backfilledHeadings : [],
                coverage: writeRes.coverage || null,
                message
            });
        }
        if (writeRes && writeRes.reason === 'MSOFFCRYPTO_MISSING') {
            return res.status(409).json({
                ok: false,
                reason: 'MSOFFCRYPTO_MISSING',
                fallbackToPcQueue: true,
                error: writeRes.error || 'msoffcrypto-tool is not installed on this server.'
            });
        }
        if (writeRes && writeRes.reason === 'WRONG_PASSWORD') {
            return res.status(500).send('WORD_PASSWORD rejected by existing local Diario.docx; note was not written.');
        }
        return res.status(500).send(writeRes?.error || 'Could not write encrypted local Diario.docx.');
    } catch (err) {
        if (err && err.code === 'LOCK_TIMEOUT') {
            return res.status(503).send('Concurrent journal file write busy; please retry shortly.');
        }
        console.error('[JOURNAL_NTR_ERROR]', err.message);
        return res.status(500).send('Error saving encrypted local Journal.');
    }
});

// Enviar entrada cifrada de English Learning Notebook directo a Google Drive (o cola PC si aplica) (SOLO ADMIN)
app.post('/api/send-english', pcQueueWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, preventDuplicateSubmit({ dedupeWindowMs: 10000 }), async (req, res) => {
    const { texto } = req.body || {};
    if (typeof texto !== 'string' || !texto.trim()) {
        return res.status(400).send('Entry payload cannot be empty.');
    }
    if (texto.length > 48000) {
        return res.status(400).send('Encrypted payload exceeds maximum allowed length.');
    }

    const secretKey = String(process.env.JOURNAL_SECRET_KEY || '');
    if (
        serverNotesService.isServerAutonomousNotesEnabled()
        && serverNotesService.normalizeE2eeKeyBuffer(secretKey)
        && serverNotesService.isValidE2eeEnvelope(texto)
    ) {
        const dec = serverNotesService.decryptClientE2ee(texto, secretKey);
        if (!dec.ok) {
            return res.status(400).send('E2EE key mismatch: server JOURNAL_SECRET_KEY could not decrypt entry.');
        }
        let parsedEntry = dec.plainText;
        try {
            parsedEntry = JSON.parse(dec.plainText);
        } catch (_) {}

        try {
            const saveRes = await runWithDocxLock('pdh_docx_english', () =>
                serverNotesService.saveEnglishEntryToCloudAndLocal({
                    entry: parsedEntry,
                    resolveRcloneFn: resolveRcloneConfigPath,
                    resolveStudyTargetFn: resolveStudyDriveRemoteTarget,
                    updateCacheFn: updateStudyNotebookCacheFromBuffer,
                    lyricsGuardFn: createEnglishLyricsGuard({ mode: 'save' }),
                    rootDir: __dirname
                })
            );
            if (saveRes && saveRes.ok) {
                if (saveRes.needsRetry) {
                    serverLogger.warn('DRIVE_NOTES', 'Nota guardada en caché local; reintento pendiente hacia Google Drive', {
                        heading: saveRes.heading,
                        error: saveRes.error
                    });
                    scheduleStudyDriveRetry();
                    bumpSyncRevision('music');
                    return res.send('Saved to local mirror; Google Drive upload scheduled for retry.');
                }
                _englishDriveRetryCount = 0;
                serverLogger.info('DRIVE_NOTES', 'Cuaderno de idiomas actualizado', {
                    mode: saveRes.mode,
                    heading: saveRes.heading,
                    deduplicated: saveRes.deduplicated,
                    verified: saveRes.verified
                });
                bumpSyncRevision('music');
                return res.send(
                    saveRes.mode === 'cloud_drive'
                        ? 'Saved directly to English Notebook on Google Drive.'
                        : 'Saved directly to local English Notebook volume.'
                );
            }
            if (saveRes && saveRes.reason === 'DUPLICATE_OTHER_SONG') {
                serverLogger.warn('DRIVE_NOTES', 'Letra rechazada por duplicar otra canción en Word', {
                    matchedSong: saveRes.matchedSong,
                    similarity: saveRes.similarity
                });
                return res.status(409).send(
                    `Lyrics rejected: they match another song already saved ("${saveRes.matchedSong || 'other track'}"). The Word notebook was not modified.`
                );
            }
            console.error('[ENGLISH_SERVER_SAVE_ERROR]', saveRes?.error || saveRes);
            return res.status(500).send(saveRes?.error || 'Could not save English Notebook entry.');
        } catch (err) {
            console.error('[ENGLISH_SERVER_SAVE_EXC]', err.message);
            if (err && err.code === 'LOCK_TIMEOUT') {
                return res.status(503).send('Concurrent English Notebook file write busy; please retry shortly.');
            }
            return res.status(500).send('Error saving English Notebook entry on server.');
        }
    }

    bumpSyncRevision('music');
    return englishQueue.enqueue(req, res);
});

// Ruta para que tu PC consulte entradas de inglés pendientes (compatibilidad puente PC)
app.get('/api/pull-english', pcPullLimiter.middleware, requirePcBridgeAuthIfConfigured, englishQueue.pull);

// ==========================================
// RUTAS PARA LA AGENDA PERSONAL SEMANAL (SOLO ADMIN)
// ==========================================
const BLOQUES_VALIDOS = new Set(['manana', 'cole', 'escuela', 'tarde', 'noche']);
const AGENDA_TIPOS_VALIDOS = new Set(['evento', 'tarea']);
const AGENDA_CATEGORIAS_VALIDAS = new Set(['universidad', 'personal']);
const AGENDA_ESTADOS_VALIDOS = new Set(['todo', 'in_progress', 'done', 'skipped']);
const HHMM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

function normalizeAgendaStatusInput(rawStatus) {
    if (rawStatus === undefined || rawStatus === null || rawStatus === '') return '';
    const clean = String(rawStatus).trim().toLowerCase();
    if (clean === 'en_progreso') return 'in_progress';
    if (clean === 'pendiente') return 'todo';
    if (clean === 'completada' || clean === 'completado') return 'done';
    if (clean === 'omitida' || clean === 'omitido') return 'skipped';
    return clean;
}

function parseServerDateTimeMs(val) {
    if (val === undefined || val === null || val === '') return NaN;
    if (val instanceof Date) return val.getTime();
    if (typeof val === 'number') return Number.isFinite(val) ? val : NaN;
    const raw = String(val).trim();
    if (!raw) return NaN;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(raw)) {
        return new Date(raw.replace(' ', 'T')).getTime();
    }
    return new Date(raw).getTime();
}

function serializeAgendaDateTime(val) {
    if (val === undefined || val === null || val === '') return null;
    if (val instanceof Date) return formatMySqlDateTime(val);
    return String(val);
}

function inferAgendaBlockFromTimeServer(horaStr, categoria = 'personal') {
    const match = String(horaStr || '').match(/^([01]\d|2[0-3]):([0-5]\d)/);
    if (!match) return 'manana';
    const hour = Number(match[1]);
    if (hour >= 20 || hour < 5) return 'noche';
    if (categoria === 'universidad' && hour >= 7 && hour < 19) return 'cole';
    if (hour >= 5 && hour < 12) return 'manana';
    return 'tarde';
}

function computePostponedAgendaBlock(horaStr, categoria = 'personal') {
    if (String(categoria || '').trim().toLowerCase() === 'universidad') {
        return 'escuela';
    }
    const match = /^([01]\d|2[0-3]):([0-5]\d)/.exec(String(horaStr || '').trim());
    const hour = match ? Number(match[1]) : 9;
    if (hour < 12) return 'manana';
    if (hour < 19) return 'tarde';
    return 'noche';
}

function computePostponedAgendaDateTime({
    currentFecha = '',
    currentHora = '09:00',
    offsetMinutes = 15,
    nowDate = new Date(),
    timeZone = '',
    categoria = 'personal',
    fromNow = false
} = {}) {
    const nowDt = nowDate instanceof Date ? nowDate : new Date(nowDate ?? Date.now());
    let todayIso = '';
    let nowMinutesOfDay = 0;

    const cleanTz = typeof timeZone === 'string' ? timeZone.trim() : '';
    if (cleanTz) {
        try {
            const parts = new Intl.DateTimeFormat('en-US', {
                timeZone: cleanTz,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            }).formatToParts(nowDt);
            const map = {};
            parts.forEach((p) => { map[p.type] = p.value; });
            const h = Number(map.hour) % 24;
            const m = Number(map.minute) || 0;
            todayIso = `${map.year}-${map.month}-${map.day}`;
            nowMinutesOfDay = h * 60 + m;
        } catch (_) {
            todayIso = '';
        }
    }
    if (!todayIso) {
        const y = nowDt.getFullYear();
        const mo = String(nowDt.getMonth() + 1).padStart(2, '0');
        const d = String(nowDt.getDate()).padStart(2, '0');
        todayIso = `${y}-${mo}-${d}`;
        nowMinutesOfDay = nowDt.getHours() * 60 + nowDt.getMinutes();
    }

    const cleanFecha = /^\d{4}-\d{2}-\d{2}$/.test(String(currentFecha || '').trim())
        ? String(currentFecha).trim()
        : todayIso;
    const hMatch = /^([01]\d|2[0-3]):([0-5]\d)/.exec(String(currentHora || '').trim());
    const scheduledMinutes = hMatch ? (Number(hMatch[1]) * 60 + Number(hMatch[2])) : (9 * 60);

    const usedNowBase = Boolean(fromNow) || cleanFecha <= todayIso;
    const baseFecha = usedNowBase ? todayIso : cleanFecha;
    const baseMinutes = usedNowBase ? nowMinutesOfDay : scheduledMinutes;

    const deltaMin = Math.round(Number(offsetMinutes) || 0);
    const totalMinutes = baseMinutes + deltaMin;
    const dayCarry = Math.floor(totalMinutes / 1440);
    const remMinutes = ((totalMinutes % 1440) + 1440) % 1440;
    const newHour = Math.floor(remMinutes / 60);
    const newMin = remMinutes % 60;
    const hora = `${String(newHour).padStart(2, '0')}:${String(newMin).padStart(2, '0')}`;

    const [by, bm, bd] = baseFecha.split('-').map(Number);
    const fecha = new Date(Date.UTC(by, bm - 1, bd + dayCarry)).toISOString().slice(0, 10);
    const bloque = computePostponedAgendaBlock(hora, categoria);

    return {
        fecha,
        hora,
        bloque,
        crossedMidnight: fecha !== cleanFecha,
        dayCarry,
        usedNowBase
    };
}

function splitAgendaTitleAndDescription(rawActividad = '', rawTitulo = '', rawDescripcion = '') {
    const explicitTitle = typeof rawTitulo === 'string' ? rawTitulo.replace(/\s+/g, ' ').trim() : '';
    const explicitDesc = typeof rawDescripcion === 'string' ? rawDescripcion.replace(/\s+/g, ' ').trim() : '';
    if (explicitTitle) {
        return {
            titulo: explicitTitle.slice(0, 120),
            descripcion: explicitDesc.slice(0, 200)
        };
    }
    const cleanAct = typeof rawActividad === 'string' ? rawActividad.replace(/\s+/g, ' ').trim() : '';
    const sepMatch = cleanAct.match(/^(.+?)\s+(?:—|::|\|)\s+(.+)$/);
    if (sepMatch) {
        return {
            titulo: sepMatch[1].trim().slice(0, 120),
            descripcion: sepMatch[2].trim().slice(0, 200)
        };
    }
    return {
        titulo: cleanAct.slice(0, 120),
        descripcion: explicitDesc.slice(0, 200)
    };
}

function composeAgendaActividad(body = {}) {
    const rawAct = typeof body.actividad === 'string' ? body.actividad.replace(/\s+/g, ' ').trim() : '';
    const rawTit = typeof body.titulo === 'string' ? body.titulo.replace(/\s+/g, ' ').trim() : '';
    const rawDesc = typeof body.descripcion === 'string' ? body.descripcion.replace(/\s+/g, ' ').trim() : '';
    if (rawTit && rawDesc) {
        return `${rawTit} — ${rawDesc}`.slice(0, 255);
    }
    if (rawTit && !rawAct) {
        return rawTit.slice(0, 255);
    }
    if (rawAct && rawDesc && !rawAct.includes(rawDesc)) {
        return `${rawAct} — ${rawDesc}`.slice(0, 255);
    }
    return rawAct;
}

function enrichAgendaRow(row) {
    if (!row || typeof row !== 'object') return row;
    const { titulo, descripcion } = splitAgendaTitleAndDescription(row.actividad, row.titulo, row.descripcion);
    const isUni = (row.categoria || 'personal') === 'universidad';
    return {
        ...row,
        en_progreso_desde: serializeAgendaDateTime(row.en_progreso_desde),
        materia_id: isUni && row.materia_id ? String(row.materia_id).trim() : null,
        materia_nombre: isUni && row.materia_nombre ? String(row.materia_nombre).trim() : null,
        titulo,
        descripcion
    };
}

function normalizeAgendaItemFields(body = {}) {
    const tipo = body.tipo === undefined || body.tipo === null || body.tipo === ''
        ? 'evento'
        : String(body.tipo).trim().toLowerCase();
    const categoria = body.categoria === undefined || body.categoria === null || body.categoria === ''
        ? 'personal'
        : String(body.categoria).trim().toLowerCase();
    const normalizedEstado = normalizeAgendaStatusInput(body.estado);
    const estado = normalizedEstado || 'todo';
    let recordatorioMin = null;
    if (body.recordatorio_min !== undefined && body.recordatorio_min !== null && body.recordatorio_min !== '') {
        recordatorioMin = Number(body.recordatorio_min);
    }
    const rawMatId = categoria === 'universidad' && body.materia_id !== undefined && body.materia_id !== null
        ? String(body.materia_id).trim()
        : '';
    const rawMatNombre = categoria === 'universidad' && body.materia_nombre !== undefined && body.materia_nombre !== null
        ? String(body.materia_nombre).replace(/\s+/g, ' ').trim()
        : '';
    return {
        tipo,
        categoria,
        estado,
        recordatorioMin,
        materiaId: rawMatId || null,
        materiaNombre: rawMatNombre || null
    };
}

function resolveAgendaCourseLink(body = {}, categoria = 'personal', settings = null) {
    if (categoria !== 'universidad') {
        return { error: null, materia_id: null, materia_nombre: null };
    }
    const rawId = body.materia_id === undefined || body.materia_id === null
        ? ''
        : String(body.materia_id).trim();
    const rawName = body.materia_nombre === undefined || body.materia_nombre === null
        ? ''
        : String(body.materia_nombre).replace(/\s+/g, ' ').trim();
    if (!rawId && !rawName) {
        return { error: null, materia_id: null, materia_nombre: null };
    }
    if (rawId.length > 60) {
        return { error: 'Class ID cannot exceed 60 characters.', materia_id: null, materia_nombre: null };
    }
    if (rawName.length > 120) {
        return { error: 'Class name cannot exceed 120 characters.', materia_id: null, materia_nombre: null };
    }

    const planner = sanitizeAcademicPlanner(settings?.academicPlanner);
    const semesters = Array.isArray(planner.semesters) ? planner.semesters : [];
    const activeSem = semesters.find(s => s.id === planner.activeSemesterId) || semesters.find(s => s.active) || semesters[0];
    const orderedSemesters = activeSem
        ? [activeSem, ...semesters.filter(s => s.id !== activeSem.id)]
        : semesters;
    const allCourses = [];
    orderedSemesters.forEach(sem => {
        (Array.isArray(sem?.courses) ? sem.courses : []).forEach(c => allCourses.push(c));
    });

    if (rawId) {
        const matched = allCourses.find(c => String(c.id || '').trim() === rawId);
        if (!matched) {
            return { error: 'Selected class was not found in your semester schedule.', materia_id: null, materia_nombre: null };
        }
        return {
            error: null,
            materia_id: matched.id,
            materia_nombre: String(matched.name || rawName || '').trim().slice(0, 120) || null
        };
    }

    const lowerName = rawName.toLowerCase();
    const byName = allCourses.find(c => String(c.name || '').trim().toLowerCase() === lowerName);
    if (byName) {
        return {
            error: null,
            materia_id: byName.id,
            materia_nombre: String(byName.name || rawName).trim().slice(0, 120)
        };
    }
    return {
        error: null,
        materia_id: null,
        materia_nombre: rawName.slice(0, 120)
    };
}

function validarDatosAgenda(body = {}) {
    const { fecha, hora } = body;
    const { tipo, categoria, estado, recordatorioMin, materiaId, materiaNombre } = normalizeAgendaItemFields(body);
    const bloque = body.bloque && BLOQUES_VALIDOS.has(body.bloque)
        ? body.bloque
        : (body.bloque === undefined || body.bloque === null || body.bloque === ''
            ? inferAgendaBlockFromTimeServer(hora, categoria)
            : body.bloque);
    const actividadCompuesta = composeAgendaActividad(body);

    if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
        return 'Date must use YYYY-MM-DD format.';
    }
    if (!bloque || !BLOQUES_VALIDOS.has(bloque)) {
        return 'Invalid day block.';
    }
    if (!hora || !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(hora)) {
        return 'Time must use HH:MM format.';
    }
    if (typeof actividadCompuesta !== 'string' || !actividadCompuesta.trim()) {
        return 'Activity description is required.';
    }
    if (actividadCompuesta.trim().length > 255) {
        return 'Activity cannot exceed 255 characters.';
    }
    if (!AGENDA_TIPOS_VALIDOS.has(tipo)) {
        return 'Invalid activity type (allowed: evento, tarea).';
    }
    if (!AGENDA_CATEGORIAS_VALIDAS.has(categoria)) {
        return 'Invalid category (allowed: universidad, personal).';
    }
    if (!AGENDA_ESTADOS_VALIDOS.has(estado)) {
        return 'Invalid status (allowed: todo, in_progress, done, skipped).';
    }
    if (materiaId && materiaId.length > 60) {
        return 'Class ID cannot exceed 60 characters.';
    }
    if (materiaNombre && materiaNombre.length > 120) {
        return 'Class name cannot exceed 120 characters.';
    }
    const MARGENES_AMPLIOS_TAREA_LARGA = new Set([360, 720, 1440, 2880, 4320, 10080]);
    if (
        recordatorioMin !== null &&
        (!Number.isInteger(recordatorioMin) ||
            recordatorioMin < -1 ||
            (recordatorioMin > 180 && !MARGENES_AMPLIOS_TAREA_LARGA.has(recordatorioMin)))
    ) {
        return 'Reminder lead minutes must be -1 (disabled), between 0 and 180, or a long-project preset (360..10080).';
    }
    return null;
}

function parseAgendaId(rawId) {
    const id = Number(rawId);
    return Number.isInteger(id) && id > 0 ? id : null;
}

app.get('/api/get-agenda', apiReadLimiter.middleware, requireAdmin, (req, res) => {
    const { begin, end } = req.query;
    if (!begin || !end || !/^\d{4}-\d{2}-\d{2}$/.test(begin) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
        return res.status(400).send('Parameters begin and end are required (YYYY-MM-DD).');
    }

    const sql = `
        SELECT id, DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, bloque,
               TIME_FORMAT(hora, '%H:%i') AS hora, actividad,
               COALESCE(tipo, 'evento') AS tipo,
               COALESCE(categoria, 'personal') AS categoria,
               materia_id,
               materia_nombre,
               COALESCE(estado, CASE WHEN completada = 1 THEN 'done' ELSE 'todo' END) AS estado,
               completada,
               recordatorio_min,
               en_progreso_desde
        FROM RegistrosAgenda
        WHERE fecha BETWEEN ? AND ?
        ORDER BY fecha ASC, hora ASC, id ASC
    `;

    db.query(sql, [begin, end], async (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error querying agenda from database.');
        }
        const localMapped = Array.isArray(result) ? result.map(enrichAgendaRow) : [];
        const merged = await mergeLocalRowsWithDriveRam(
            'agenda',
            localMapped,
            begin,
            end,
            req.query.includeDrive === '1'
        );
        res.json(merged.map(enrichAgendaRow));
    });
});

app.post('/api/insert-agenda', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, preventDuplicateSubmit({ dedupeWindowMs: 15000 }), async (req, res) => {
    const subcategoria = String(req.body.subcategoria || 'normal').trim().toLowerCase();
    if (subcategoria === 'leccion_idiomas') {
        req.body.categoria = 'personal';
        req.body.tipo = 'tarea';
        if (req.body.recordatorio_min === undefined || req.body.recordatorio_min === null || req.body.recordatorio_min === '') {
            req.body.recordatorio_min = 15;
        }
    } else if (subcategoria === 'tarea_larga') {
        req.body.categoria = 'universidad';
        req.body.tipo = 'tarea';
        if (req.body.recordatorio_min === undefined || req.body.recordatorio_min === null || req.body.recordatorio_min === '') {
            req.body.recordatorio_min = 1440;
        }
    }

    const errorValidacion = validarDatosAgenda(req.body);
    if (errorValidacion) {
        return res.status(400).send(errorValidacion);
    }

    try {
        const { fecha, hora } = req.body;
        const { tipo, categoria, estado, recordatorioMin } = normalizeAgendaItemFields(req.body);
        let courseLink = { error: null, materia_id: null, materia_nombre: null };
        if (categoria === 'universidad' && (req.body.materia_id || req.body.materia_nombre)) {
            const settings = await loadUserSettings(req.user.id);
            courseLink = resolveAgendaCourseLink(req.body, categoria, settings);
            if (courseLink.error) {
                return res.status(400).send(courseLink.error);
            }
        }

        const bloque = req.body.bloque && BLOQUES_VALIDOS.has(req.body.bloque)
            ? req.body.bloque
            : inferAgendaBlockFromTimeServer(hora, categoria);
        let actividad = composeAgendaActividad(req.body);
        if (subcategoria === 'tarea_larga' && !actividad.startsWith('[Proyecto/Tarea Larga]')) {
            actividad = `[Proyecto/Tarea Larga] ${actividad}`.slice(0, 255);
        } else if (subcategoria === 'leccion_idiomas' && !actividad.startsWith('[Lección de Idiomas]')) {
            actividad = `[Lección de Idiomas] ${actividad}`.slice(0, 255);
        }

        const { titulo, descripcion } = splitAgendaTitleAndDescription(actividad, req.body.titulo, req.body.descripcion);
        const horaNormalizada = hora.slice(0, 5);
        const completada = estado === 'done' ? 1 : 0;
        const enProgresoDesde = estado === 'in_progress' ? formatMySqlDateTime(new Date()) : null;

        const repetirCadaDias = Math.max(0, Math.min(90, Number.parseInt(req.body.repetir_cada_dias, 10) || 0));
        const repetirVeces = repetirCadaDias > 0
            ? Math.max(1, Math.min(30, Number.parseInt(req.body.repetir_veces, 10) || 1))
            : 1;

        const targetDates = [];
        if (Array.isArray(req.body.fechas_repeticion) && req.body.fechas_repeticion.length > 0) {
            const seenDates = new Set();
            for (const rawD of req.body.fechas_repeticion) {
                const candidateDate = String(rawD || '').trim();
                if (!/^\d{4}-\d{2}-\d{2}$/.test(candidateDate)) continue;
                const [cy, cm, cd] = candidateDate.split('-').map(Number);
                const probe = new Date(Date.UTC(cy, cm - 1, cd));
                if (probe.toISOString().slice(0, 10) !== candidateDate) continue;
                if (!seenDates.has(candidateDate)) {
                    seenDates.add(candidateDate);
                    targetDates.push(candidateDate);
                }
                if (targetDates.length >= 30) break;
            }
        }
        if (targetDates.length === 0) {
            const [y, m, d] = fecha.split('-').map(Number);
            for (let occ = 0; occ < repetirVeces; occ += 1) {
                const occDateObj = new Date(Date.UTC(y, m - 1, d + (occ * repetirCadaDias)));
                targetDates.push(occDateObj.toISOString().slice(0, 10));
            }
        } else {
            targetDates.sort();
        }

        const sql = `
            INSERT INTO RegistrosAgenda (fecha, bloque, hora, actividad, tipo, categoria, estado, completada, recordatorio_min, en_progreso_desde, materia_id, materia_nombre)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        let firstInsertId = null;
        for (let occ = 0; occ < targetDates.length; occ += 1) {
            const occFecha = targetDates[occ];
            const result = await dbQueryAsync(sql, [
                occFecha,
                bloque,
                horaNormalizada,
                actividad,
                tipo,
                categoria,
                estado,
                completada,
                recordatorioMin,
                enProgresoDesde,
                courseLink.materia_id,
                courseLink.materia_nombre
            ]);
            if (occ === 0 || occFecha === fecha) {
                if (firstInsertId === null || occFecha === fecha) firstInsertId = result.insertId;
            }
        }

        bumpSyncRevision('agenda');
        res.status(201).json({
            message: targetDates.length > 1
                ? `Activity saved and scheduled for ${targetDates.length} dates.`
                : 'Activity saved successfully.',
            repeatedCount: targetDates.length,
            createdDates: targetDates,
            item: {
                id: firstInsertId,
                fecha,
                bloque,
                hora: horaNormalizada,
                actividad,
                titulo,
                descripcion,
                tipo,
                categoria,
                materia_id: courseLink.materia_id,
                materia_nombre: courseLink.materia_nombre,
                estado,
                completada,
                recordatorio_min: recordatorioMin,
                en_progreso_desde: enProgresoDesde
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error saving agenda activity.');
    }
});

app.put('/api/update-agenda/:id', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, preventDuplicateSubmit({ dedupeWindowMs: 0 }), async (req, res) => {
    const id = parseAgendaId(req.params.id);
    if (!id) return res.status(400).send('Invalid activity ID.');

    const errorValidacion = validarDatosAgenda(req.body);
    if (errorValidacion) {
        return res.status(400).send(errorValidacion);
    }

    try {
        const { fecha, hora } = req.body;
        const { tipo, categoria, estado, recordatorioMin } = normalizeAgendaItemFields(req.body);
        const enforcePreventBackdate = req.body.preventBackdate === true || req.body.preventBackdate === 'true';
        let cachedSettings = null;

        const existingRows = await dbQueryAsync(
            `SELECT id, DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, TIME_FORMAT(hora, '%H:%i') AS hora,
                    bloque, recordatorio_min, materia_id, materia_nombre,
                    COALESCE(estado, CASE WHEN completada = 1 THEN 'done' ELSE 'todo' END) AS estado,
                    completada, en_progreso_desde
             FROM RegistrosAgenda
             WHERE id = ?
             LIMIT 1`,
            [id]
        );
        if (!Array.isArray(existingRows) || existingRows.length === 0) {
            return res.status(404).send('Activity not found.');
        }
        const existingRow = existingRows[0];
        const sourceFecha = existingRow.fecha instanceof Date
            ? existingRow.fecha.toISOString().slice(0, 10)
            : String(existingRow.fecha || '').slice(0, 10);
        const existingHora = String(existingRow.hora || '').trim().slice(0, 5);

        if (enforcePreventBackdate) {
            cachedSettings = await loadUserSettings(req.user.id);
            const todayIso = getLocalNowParts(cachedSettings?.timezone).dateStr;
            if (
                (/^\d{4}-\d{2}-\d{2}$/.test(sourceFecha) && fecha < sourceFecha) ||
                (/^\d{4}-\d{2}-\d{2}$/.test(todayIso) && fecha < todayIso && fecha !== sourceFecha)
            ) {
                return res.status(400).send('Cannot move an activity to an earlier date.');
            }
        }

        let courseLink = { error: null, materia_id: null, materia_nombre: null };
        if (categoria === 'universidad' && (req.body.materia_id || req.body.materia_nombre)) {
            const settings = cachedSettings || await loadUserSettings(req.user.id);
            courseLink = resolveAgendaCourseLink(req.body, categoria, settings);
            if (courseLink.error) {
                if (
                    enforcePreventBackdate &&
                    existingRow &&
                    req.body.materia_id &&
                    String(existingRow.materia_id || '') === String(req.body.materia_id || '').trim()
                ) {
                    courseLink = {
                        error: null,
                        materia_id: existingRow.materia_id,
                        materia_nombre: existingRow.materia_nombre || (req.body.materia_nombre ? String(req.body.materia_nombre).trim().slice(0, 120) : null)
                    };
                } else {
                    return res.status(400).send(courseLink.error);
                }
            }
        }

        const bloque = req.body.bloque && BLOQUES_VALIDOS.has(req.body.bloque)
            ? req.body.bloque
            : inferAgendaBlockFromTimeServer(hora, categoria);
        const actividad = composeAgendaActividad(req.body);
        const { titulo, descripcion } = splitAgendaTitleAndDescription(actividad, req.body.titulo, req.body.descripcion);
        const horaNormalizada = hora.slice(0, 5);
        const completada = estado === 'done' ? 1 : 0;
        const prevEstado = String(existingRow.estado || (Number(existingRow.completada) === 1 ? 'done' : 'todo')).toLowerCase();
        const existingInProgressSince = serializeAgendaDateTime(existingRow.en_progreso_desde);
        const nextEnProgresoDesde = estado === 'in_progress'
            ? (prevEstado === 'in_progress' && existingInProgressSince
                ? existingInProgressSince
                : formatMySqlDateTime(new Date()))
            : null;

        const sql = `
            UPDATE RegistrosAgenda
            SET fecha = ?, bloque = ?, hora = ?, actividad = ?, tipo = ?, categoria = ?, estado = ?, completada = ?, recordatorio_min = ?, en_progreso_desde = ?, materia_id = ?, materia_nombre = ?
            WHERE id = ?
        `;
        const result = await dbQueryAsync(sql, [
            fecha,
            bloque,
            horaNormalizada,
            actividad,
            tipo,
            categoria,
            estado,
            completada,
            recordatorioMin,
            nextEnProgresoDesde,
            courseLink.materia_id,
            courseLink.materia_nombre,
            id
        ]);
        if (result.affectedRows === 0) {
            return res.status(404).send('Activity not found.');
        }
        if (estado === 'done' || estado === 'skipped') {
            await dbQueryAsync("UPDATE RecordatoriosEstado SET estado = 'dismissed' WHERE ref_id = ? AND tipo = 'agenda'", [id]);
        } else if (
            estado === 'in_progress' && prevEstado !== 'in_progress'
        ) {
            await dbQueryAsync("DELETE FROM RecordatoriosEstado WHERE ref_id = ? AND tipo = 'agenda'", [id]);
        } else if (
            prevEstado !== estado ||
            sourceFecha !== fecha ||
            existingHora !== horaNormalizada ||
            Number(existingRow.recordatorio_min ?? -999) !== Number(recordatorioMin ?? -999)
        ) {
            await dbQueryAsync("DELETE FROM RecordatoriosEstado WHERE ref_id = ? AND tipo = 'agenda'", [id]);
        }
        bumpSyncRevision('agenda');
        res.json({
            message: 'Activity updated successfully.',
            item: {
                id,
                fecha,
                bloque,
                hora: horaNormalizada,
                actividad,
                titulo,
                descripcion,
                tipo,
                categoria,
                materia_id: courseLink.materia_id,
                materia_nombre: courseLink.materia_nombre,
                estado,
                completada,
                recordatorio_min: recordatorioMin,
                en_progreso_desde: nextEnProgresoDesde
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error updating activity.');
    }
});

app.patch('/api/toggle-agenda/:id', apiWriteLimiter.middleware, requireAdmin, preventDuplicateSubmit({ dedupeWindowMs: 0 }), async (req, res) => {
    const id = parseAgendaId(req.params.id);
    if (!id) return res.status(400).send('Invalid activity ID.');

    const body = req.body || {};
    let requestedEstado = null;
    let requestedCompletada = null;

    if (body.estado !== undefined && body.estado !== null && body.estado !== '') {
        const candidate = normalizeAgendaStatusInput(body.estado);
        if (!AGENDA_ESTADOS_VALIDOS.has(candidate)) {
            return res.status(400).send('Invalid status (allowed: todo, in_progress, done, skipped).');
        }
        requestedEstado = candidate;
        requestedCompletada = candidate === 'done' ? 1 : 0;
    } else if (body.completada !== undefined) {
        requestedCompletada = body.completada ? 1 : 0;
        requestedEstado = requestedCompletada === 1 ? 'done' : 'todo';
    }

    try {
        const prevRows = await dbQueryAsync(
            `SELECT id, completada,
                    COALESCE(estado, CASE WHEN completada = 1 THEN 'done' ELSE 'todo' END) AS estado,
                    en_progreso_desde
             FROM RegistrosAgenda
             WHERE id = ?
             LIMIT 1`,
            [id]
        );
        if (!Array.isArray(prevRows) || prevRows.length === 0) {
            return res.status(404).send('Activity not found.');
        }

        const prevRow = prevRows[0];
        const prevCompletada = prevRow.completada ? 1 : 0;
        const prevEstado = String(prevRow.estado || (prevCompletada === 1 ? 'done' : 'todo')).toLowerCase();
        const nextEstado = requestedEstado !== null ? requestedEstado : (prevCompletada === 1 ? 'todo' : 'done');
        const nextCompletada = requestedCompletada !== null ? requestedCompletada : (nextEstado === 'done' ? 1 : 0);

        const prevSince = serializeAgendaDateTime(prevRow.en_progreso_desde);
        const nextEnProgresoDesde = nextEstado === 'in_progress'
            ? (prevEstado === 'in_progress' && prevSince ? prevSince : formatMySqlDateTime(new Date()))
            : null;

        await dbQueryAsync(
            'UPDATE RegistrosAgenda SET estado = ?, completada = ?, en_progreso_desde = ? WHERE id = ?',
            [nextEstado, nextCompletada, nextEnProgresoDesde, id]
        );

        if (nextEstado === 'done' || nextEstado === 'skipped') {
            await dbQueryAsync("UPDATE RecordatoriosEstado SET estado = 'dismissed' WHERE ref_id = ? AND tipo = 'agenda'", [id]);
        } else if (nextEstado === 'in_progress' && (prevEstado !== 'in_progress' || !prevSince)) {
            await dbQueryAsync("DELETE FROM RecordatoriosEstado WHERE ref_id = ? AND tipo = 'agenda'", [id]);
        } else if (nextEstado === 'todo' && prevEstado !== 'todo') {
            await dbQueryAsync("DELETE FROM RecordatoriosEstado WHERE ref_id = ? AND tipo = 'agenda'", [id]);
        }

        bumpSyncRevision('agenda');
        return res.json({
            message: 'Status updated.',
            id,
            completada: nextCompletada,
            estado: nextEstado,
            en_progreso_desde: nextEnProgresoDesde
        });
    } catch (err) {
        console.error(err);
        return res.status(500).send('Error updating activity status.');
    }
});

app.patch('/api/postpone-agenda/:id', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, preventDuplicateSubmit({ dedupeWindowMs: 0 }), async (req, res) => {
    const id = parseAgendaId(req.params.id);
    if (!id) return res.status(400).send('Invalid activity ID.');

    const body = req.body || {};
    const hasOffsetMinutes = body.offsetMinutes !== undefined && body.offsetMinutes !== null && body.offsetMinutes !== '';
    const offsetMinutesNum = hasOffsetMinutes ? Number.parseInt(body.offsetMinutes, 10) : null;
    const hasDays = body.days !== undefined && body.days !== null && body.days !== '';
    const daysNum = hasDays ? Number.parseInt(body.days, 10) : null;
    const rawTargetDate = body.targetDate !== undefined && body.targetDate !== null
        ? String(body.targetDate).trim()
        : '';

    let validTargetDate = '';
    if (hasOffsetMinutes) {
        if (!Number.isInteger(offsetMinutesNum) || offsetMinutesNum < 1 || offsetMinutesNum > 4320) {
            return res.status(400).send('offsetMinutes must be an integer between 1 and 4320.');
        }
    } else if (rawTargetDate) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(rawTargetDate)) {
            return res.status(400).send('targetDate must use YYYY-MM-DD format.');
        }
        const [ty, tm, td] = rawTargetDate.split('-').map(Number);
        const probe = new Date(Date.UTC(ty, tm - 1, td));
        if (probe.toISOString().slice(0, 10) !== rawTargetDate) {
            return res.status(400).send('Invalid calendar targetDate.');
        }
        validTargetDate = rawTargetDate;
    } else if (!Number.isInteger(daysNum) || daysNum === 0 || Math.abs(daysNum) > 365) {
        return res.status(400).send('Specify postponement days (non-zero integer -365..365), offsetMinutes (1..4320), or targetDate (YYYY-MM-DD).');
    }

    try {
        const rows = await dbQueryAsync(
            `SELECT id, DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, bloque,
                    TIME_FORMAT(hora, '%H:%i') AS hora, actividad,
                    COALESCE(tipo, 'evento') AS tipo,
                    COALESCE(categoria, 'personal') AS categoria,
                    materia_id, materia_nombre,
                    COALESCE(estado, CASE WHEN completada = 1 THEN 'done' ELSE 'todo' END) AS estado,
                    completada, recordatorio_min, en_progreso_desde
             FROM RegistrosAgenda
             WHERE id = ?
             LIMIT 1`,
            [id]
        );
        if (!Array.isArray(rows) || rows.length === 0) {
            return res.status(404).send('Activity not found.');
        }

        const currentRow = rows[0];
        const prevEstado = String(currentRow.estado || 'todo').toLowerCase();
        const nextEstado = (prevEstado === 'skipped' || prevEstado === 'done') ? 'todo' : prevEstado;
        const nextCompletada = 0;
        const nextEnProgresoDesde = nextEstado === 'in_progress'
            ? serializeAgendaDateTime(currentRow.en_progreso_desde)
            : null;

        let newFecha = validTargetDate;
        let newHora = currentRow.hora;
        let newBloque = currentRow.bloque;

        if (hasOffsetMinutes) {
            const settings = await loadUserSettings(req.user.id);
            const computed = computePostponedAgendaDateTime({
                currentFecha: currentRow.fecha,
                currentHora: currentRow.hora,
                offsetMinutes: offsetMinutesNum,
                nowDate: new Date(),
                timeZone: settings.timezone,
                categoria: currentRow.categoria,
                fromNow: Boolean(body.fromNow)
            });
            newFecha = computed.fecha;
            newHora = computed.hora;
            newBloque = computed.bloque;

            await dbQueryAsync(
                'UPDATE RegistrosAgenda SET fecha = ?, bloque = ?, hora = ?, estado = ?, completada = ?, en_progreso_desde = ? WHERE id = ?',
                [newFecha, newBloque, newHora, nextEstado, nextCompletada, nextEnProgresoDesde, id]
            );
            await dbQueryAsync("DELETE FROM RecordatoriosEstado WHERE ref_id = ? AND tipo = 'agenda'", [id]);

            if (computed.usedNowBase) {
                const snoozeUntil = new Date(Date.now() + offsetMinutesNum * 60 * 1000);
                const snoozeSql = formatMySqlDateTime(snoozeUntil);
                const nextAgendaKey = `agenda:${id}:${newFecha}`;
                await dbQueryAsync(
                    `INSERT INTO RecordatoriosEstado (usuario_id, clave_unica, tipo, ref_id, titulo, mensaje, estado, snooze_hasta, enviado_push_en)
                     VALUES (?, ?, 'agenda', ?, ?, ?, 'snoozed', ?, NULL)
                     ON DUPLICATE KEY UPDATE estado = 'snoozed', snooze_hasta = VALUES(snooze_hasta), enviado_push_en = NULL`,
                    [
                        req.user.id,
                        nextAgendaKey,
                        id,
                        String(currentRow.actividad || 'Agenda').slice(0, 140),
                        '',
                        snoozeSql
                    ]
                );
            }
        } else {
            if (!newFecha) {
                const [cy, cm, cd] = String(currentRow.fecha || '').split('-').map(Number);
                const movedObj = new Date(Date.UTC(cy, cm - 1, cd + daysNum));
                newFecha = movedObj.toISOString().slice(0, 10);
            }
            await dbQueryAsync(
                'UPDATE RegistrosAgenda SET fecha = ?, estado = ?, completada = ?, en_progreso_desde = ? WHERE id = ?',
                [newFecha, nextEstado, nextCompletada, nextEnProgresoDesde, id]
            );
            await dbQueryAsync("DELETE FROM RecordatoriosEstado WHERE ref_id = ? AND tipo = 'agenda'", [id]);
        }

        const updatedItem = enrichAgendaRow({
            ...currentRow,
            fecha: newFecha,
            hora: newHora,
            bloque: newBloque,
            estado: nextEstado,
            completada: nextCompletada,
            en_progreso_desde: nextEnProgresoDesde
        });
        bumpSyncRevision('agenda');
        res.json({
            message: 'Activity postponed successfully.',
            id,
            previousFecha: currentRow.fecha,
            previousHora: currentRow.hora,
            fecha: newFecha,
            hora: newHora,
            bloque: newBloque,
            estado: nextEstado,
            completada: nextCompletada,
            item: updatedItem
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error postponing activity.');
    }
});

app.delete('/api/delete-agenda/:id', apiWriteLimiter.middleware, requireAdmin, preventDuplicateSubmit({ dedupeWindowMs: 0 }), (req, res) => {
    const id = parseAgendaId(req.params.id);
    if (!id) return res.status(400).send('Invalid activity ID.');

    const sql = 'DELETE FROM RegistrosAgenda WHERE id = ?';
    db.query(sql, [id], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error deleting activity.');
        }
        if (result.affectedRows === 0) {
            return res.status(404).send('Activity not found.');
        }
        db.query("DELETE FROM RecordatoriosEstado WHERE ref_id = ? AND tipo = 'agenda'", [id], () => {});
        bumpSyncRevision('agenda');
        res.json({ message: 'Activity deleted successfully.', id });
    });
});

// ==========================================
// CONFIGURACIÓN PERSONAL, RECORDATORIOS Y NOTIFICACIONES MÓVILES
// ==========================================
function dbQueryAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.query(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// ==========================================
// DIRECTORIO DE CROQUIS TEC DE SALTILLO (ITS), UBICACIONES Y TRÁFICO
// ==========================================
const ITS_CAMPUS_DIRECTORY = {
    principal: {
        id: 'principal',
        name: 'ITS Campus Principal',
        plano: 'CTO-002',
        address: 'Blvd. Venustiano Carranza #2400, Col. Tecnológico, Saltillo, Coahuila.',
        lat: 25.4414,
        lng: -100.9922,
        buildings: 'Aulas A-3..A-24 (Piso 1), B-2..B-21 (Piso 2), C-2..C-13 (Piso 3), CR-01..CR-15, AM-1..AM-5, TM1..TM3, LAC-L2A, SM1, LF1, SJMM'
    },
    miravalle: {
        id: 'miravalle',
        name: 'ITS Campus Miravalle',
        plano: 'CTO-003',
        address: 'Blvd. Vito Alessio Robles, Col. Miravalle, Saltillo, Coahuila.',
        lat: 25.4194,
        lng: -101.0232,
        buildings: 'Aulas N-1..N-42 (Edif. 60-65), LMA, LE2..LE4, PLC, LM1..LM2, LEL, LIN, LS1..LS5, LC1..LC3, AP1'
    },
    boillot: {
        id: 'boillot',
        name: 'ITS Campus Blvd (Glorieta)',
        plano: 'CTO-004',
        address: 'Blvd. Venustiano Carranza esq. Av. Universidad (Glorieta), Saltillo, Coahuila.',
        lat: 25.4385,
        lng: -100.9940,
        buildings: 'Edif. 78 Sistemas (Aulas R-1..R-14), Edif. 79 Mecatrónica (S-13..S-20, LC3, CLO), Edif. 80 Ed. Distancia (ED1..ED4), Edif. 81 Vinculación (AV1..AV2)'
    }
};

function withRoomAliases(obj) {
    return {
        ...obj,
        campusKey: obj.campusId,
        croquisCode: obj.plano,
        buildingName: obj.building
    };
}

function normalizeCampusId(rawId = '') {
    const clean = String(rawId || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    return /^[a-z0-9_-]{2,48}$/.test(clean) ? clean : '';
}

function normalizeCampusRoomCode(rawRoom = '') {
    return String(rawRoom || '').trim().toUpperCase().replace(/\s+/g, '').slice(0, 24);
}

function normalizeCampusRooms(rawRooms = []) {
    const rawList = Array.isArray(rawRooms)
        ? rawRooms
        : (typeof rawRooms === 'string' ? rawRooms.split(/[,;\n]+/) : []);
    const seen = new Set();
    const rooms = [];
    for (const item of rawList) {
        const clean = normalizeCampusRoomCode(item);
        if (!clean || seen.has(clean)) continue;
        seen.add(clean);
        rooms.push(clean);
        if (rooms.length >= 100) break;
    }
    return rooms;
}

function sanitizeCampusEntry(campusId, rawEntry = {}, fallbackEntry = null) {
    const id = normalizeCampusId(campusId) || 'principal';
    const baseDefault = ITS_CAMPUS_DIRECTORY[id] || null;
    const fb = fallbackEntry && typeof fallbackEntry === 'object' ? fallbackEntry : (baseDefault || {});
    const src = rawEntry && typeof rawEntry === 'object' ? rawEntry : {};

    const rawName = typeof src.name === 'string' && src.name.trim()
        ? src.name.trim().slice(0, 120)
        : (typeof src.label === 'string' && src.label.trim()
            ? src.label.trim().slice(0, 120)
            : String(fb.name || fb.label || baseDefault?.name || id).trim().slice(0, 120));
    const name = rawName || id;

    const plano = typeof src.plano === 'string'
        ? src.plano.trim().slice(0, 30)
        : String(fb.plano ?? baseDefault?.plano ?? '').trim().slice(0, 30);

    const address = typeof src.address === 'string'
        ? src.address.trim().slice(0, 220)
        : String(fb.address ?? baseDefault?.address ?? '').trim().slice(0, 220);

    const buildings = typeof src.buildings === 'string'
        ? src.buildings.trim().slice(0, 300)
        : String(fb.buildings ?? baseDefault?.buildings ?? '').trim().slice(0, 300);

    const rooms = Object.prototype.hasOwnProperty.call(src, 'rooms')
        ? normalizeCampusRooms(src.rooms)
        : normalizeCampusRooms(fb.rooms || []);

    const directCoords = parseCoordinatesFromInput(src);
    const fbCoords = parseCoordinatesFromInput(fb);
    const baseCoords = baseDefault ? { lat: baseDefault.lat, lng: baseDefault.lng } : { lat: 25.4414, lng: -100.9922 };
    const chosenCoords = directCoords || fbCoords || baseCoords;
    const lat = chosenCoords.lat;
    const lng = chosenCoords.lng;

    const mapsUrl = typeof src.mapsUrl === 'string' && /^https?:\/\//i.test(src.mapsUrl.trim())
        ? src.mapsUrl.trim().slice(0, 500)
        : (typeof fb.mapsUrl === 'string' && /^https?:\/\//i.test(fb.mapsUrl.trim()) && !directCoords
            ? fb.mapsUrl.trim().slice(0, 500)
            : `https://www.google.com/maps?q=${lat},${lng}`);

    return {
        id,
        name,
        label: name,
        plano,
        address,
        mapsUrl,
        lat,
        lng,
        rooms,
        buildings
    };
}

function getEffectiveCampusDirectory(planner = null) {
    const hasExplicitCampusesObj = Boolean(
        planner && typeof planner === 'object'
        && planner.locations && typeof planner.locations === 'object'
        && planner.locations.campuses && typeof planner.locations.campuses === 'object'
        && !Array.isArray(planner.locations.campuses)
    );
    const campusesSrc = hasExplicitCampusesObj ? planner.locations.campuses : ITS_CAMPUS_DIRECTORY;
    const uniFallback = planner && typeof planner === 'object' && planner.locations && planner.locations.university && typeof planner.locations.university === 'object'
        ? planner.locations.university
        : null;
    const out = {};
    const entries = Object.entries(campusesSrc).slice(0, 25);

    for (const [rawKey, rawVal] of entries) {
        const key = normalizeCampusId(rawVal?.id || rawKey);
        if (!key) continue;
        const base = ITS_CAMPUS_DIRECTORY[key] || null;
        let entry = sanitizeCampusEntry(key, rawVal || {}, base || {});

        if (key === 'principal' && uniFallback) {
            const uniCoords = parseCoordinatesFromInput(uniFallback);
            if (uniCoords && base) {
                const directDiffers = Math.abs(entry.lat - base.lat) > 0.00001 || Math.abs(entry.lng - base.lng) > 0.00001;
                const uniDiffers = Math.abs(uniCoords.lat - base.lat) > 0.00001 || Math.abs(uniCoords.lng - base.lng) > 0.00001;
                if (!directDiffers && uniDiffers) {
                    entry = sanitizeCampusEntry(key, { ...entry, lat: uniCoords.lat, lng: uniCoords.lng, mapsUrl: `https://www.google.com/maps?q=${uniCoords.lat},${uniCoords.lng}` }, entry);
                }
            }
        }

        const isDefaultCampus = Boolean(base);
        const isCustom = isDefaultCampus
            ? Boolean(
                Math.abs(entry.lat - base.lat) > 0.00001 ||
                Math.abs(entry.lng - base.lng) > 0.00001 ||
                entry.name !== base.name ||
                entry.plano !== base.plano ||
                entry.rooms.length > 0
            )
            : true;

        out[key] = {
            ...entry,
            defaultLat: base ? base.lat : entry.lat,
            defaultLng: base ? base.lng : entry.lng,
            defaultAddress: base ? base.address : entry.address,
            isDefaultCampus,
            isCustom
        };
    }
    return out;
}

function resolveItsClassroom(rawRoom = '', campusDirectoryOrPlanner = null) {
    let dir = ITS_CAMPUS_DIRECTORY;
    if (campusDirectoryOrPlanner && typeof campusDirectoryOrPlanner === 'object') {
        if (campusDirectoryOrPlanner.locations) {
            dir = getEffectiveCampusDirectory(campusDirectoryOrPlanner);
        } else {
            const vals = Object.values(campusDirectoryOrPlanner);
            if (vals.length > 0 && vals.every(v => v && typeof v === 'object' && Number.isFinite(Number(v.lat)))) {
                dir = campusDirectoryOrPlanner;
            } else if (Object.keys(campusDirectoryOrPlanner).length === 0) {
                dir = {};
            }
        }
    }

    const pickDirCampus = (preferredKey) => {
        const firstEntry = Object.entries(dir)[0];
        if (dir[preferredKey]) {
            return { key: dir[preferredKey].id || preferredKey, campus: dir[preferredKey] };
        }
        if (firstEntry) {
            return { key: firstEntry[1].id || firstEntry[0], campus: firstEntry[1] };
        }
        const fb = ITS_CAMPUS_DIRECTORY[preferredKey] || ITS_CAMPUS_DIRECTORY.principal;
        return { key: fb.id, campus: fb };
    };

    const clean = String(rawRoom || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!clean) {
        const picked = pickDirCampus('principal');
        return withRoomAliases({
            room: 'S/A',
            campusId: picked.key,
            campusName: picked.campus.name,
            plano: picked.campus.plano || '',
            building: picked.campus.buildings || picked.campus.name || 'Campus General ITS',
            lat: picked.campus.lat,
            lng: picked.campus.lng
        });
    }

    const normalized = clean.replace(/^(AULA|SALON|LAB)/, '').replace(/^-+/, '');
    const cleanCompact = clean.replace(/-/g, '');
    const normalizedCompact = normalized.replace(/-/g, '');

    // Prioridad 1: Buscar coincidencia exacta en salones personalizados (campus.rooms)
    for (const [cKey, camp] of Object.entries(dir)) {
        const customRooms = normalizeCampusRooms(camp?.rooms || []);
        const matched = customRooms.find(r => {
            const rCompact = r.replace(/-/g, '');
            return r === clean || r === normalized || rCompact === cleanCompact || rCompact === normalizedCompact;
        });
        if (matched) {
            return withRoomAliases({
                room: clean || matched,
                campusId: camp.id || cKey,
                campusName: camp.name || camp.label || cKey,
                plano: camp.plano || '',
                building: camp.buildings || camp.name || 'Salón personalizado',
                lat: camp.lat,
                lng: camp.lng,
                matchedCustomRoom: true
            });
        }
    }

    // Prioridad 2: Fallback a reglas regex del Croquis Oficial ITS
    if (/^R-?0?\d+$/.test(normalized)) {
        const num = parseInt(normalized.replace(/\D/g, ''), 10) || 1;
        const picked = pickDirCampus('boillot');
        return withRoomAliases({
            room: `R${String(num).padStart(2, '0')}`,
            campusId: picked.key,
            campusName: picked.campus.name,
            plano: picked.campus.plano || 'CTO-004',
            building: 'Edif. 78 Sistemas y Computación (Aulas R-1 a R-14)',
            lat: picked.campus.lat,
            lng: picked.campus.lng
        });
    }

    if (/^(S-?\d+|CLO)$/.test(normalized)) {
        const picked = pickDirCampus('boillot');
        return withRoomAliases({
            room: normalized,
            campusId: picked.key,
            campusName: picked.campus.name,
            plano: picked.campus.plano || 'CTO-004',
            building: 'Edif. 79 Ingeniería Mecatrónica (Aulas S-13 a S-20 / CLO)',
            lat: picked.campus.lat,
            lng: picked.campus.lng
        });
    }

    if (/^ED-?\d+$/.test(normalized)) {
        const picked = pickDirCampus('boillot');
        return withRoomAliases({
            room: normalized,
            campusId: picked.key,
            campusName: picked.campus.name,
            plano: picked.campus.plano || 'CTO-004',
            building: 'Edif. 80 Educación a Distancia (Aulas ED1 a ED4)',
            lat: picked.campus.lat,
            lng: picked.campus.lng
        });
    }

    if (/^AV-?\d+$/.test(normalized)) {
        const picked = pickDirCampus('boillot');
        return withRoomAliases({
            room: normalized,
            campusId: picked.key,
            campusName: picked.campus.name,
            plano: picked.campus.plano || 'CTO-004',
            building: 'Edif. 81 Gestión Tecnológica y Vinculación (AV1 - AV2)',
            lat: picked.campus.lat,
            lng: picked.campus.lng
        });
    }

    if (/^N-?0?\d+$/.test(normalized)) {
        const num = parseInt(normalized.replace(/\D/g, ''), 10) || 1;
        let edif = 'Edif. 60-65 (Aulas N-1 a N-42)';
        if (num >= 1 && num <= 8) edif = 'Edif. 60 (Aulas N-1 a N-8)';
        else if (num >= 9 && num <= 16) edif = 'Edif. 61 (Aulas N-9 a N-16)';
        else if (num >= 17 && num <= 24) edif = 'Edif. 62 (Aulas N-17 a N-24)';
        else if (num >= 25 && num <= 26) edif = 'Edif. 63 (Aulas N-25 a N-26)';
        else if (num >= 27 && num <= 28) edif = 'Edif. 64 (Aulas N-27 a N-28)';
        else if (num >= 29) edif = 'Edif. 65 (Aulas N-29 a N-42)';
        const picked = pickDirCampus('miravalle');
        return withRoomAliases({
            room: `N${String(num).padStart(2, '0')}`,
            campusId: picked.key,
            campusName: picked.campus.name,
            plano: picked.campus.plano || 'CTO-003',
            building: edif,
            lat: picked.campus.lat,
            lng: picked.campus.lng
        });
    }

    if (/^(LMA|LE[234]|PLC|LM[12]|LEL|LIN|LS[1-5]|LC[123]|AP1)$/.test(normalized)) {
        const picked = pickDirCampus('miravalle');
        return withRoomAliases({
            room: normalized,
            campusId: picked.key,
            campusName: picked.campus.name,
            plano: picked.campus.plano || 'CTO-003',
            building: 'Laboratorios y Aulas Especializadas Campus Miravalle (Edif. 50-66)',
            lat: picked.campus.lat,
            lng: picked.campus.lng
        });
    }

    if (/^[ABC]-?0?\d+$/.test(normalized)) {
        const letter = normalized[0];
        const piso = letter === 'A' ? 'Piso 1 (Edif. 22)' : (letter === 'B' ? 'Piso 2 (Edif. 23)' : 'Piso 3 (Edif. 24)');
        const picked = pickDirCampus('principal');
        return withRoomAliases({
            room: normalized,
            campusId: picked.key,
            campusName: picked.campus.name,
            plano: picked.campus.plano || 'CTO-002',
            building: `Aulas ${letter} · ${piso}`,
            lat: picked.campus.lat,
            lng: picked.campus.lng
        });
    }

    const pickedDefault = pickDirCampus('principal');
    return withRoomAliases({
        room: normalized,
        campusId: pickedDefault.key,
        campusName: pickedDefault.campus.name,
        plano: pickedDefault.campus.plano || 'CTO-002',
        building: pickedDefault.campus.buildings || 'Campus Principal ITS (CR / AM / TM / SM / LAC)',
        lat: pickedDefault.campus.lat,
        lng: pickedDefault.campus.lng
    });
}

function isValidNonZeroCoords(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
    // Evitar "Null Island" (0, 0) generado por inputs vacíos o errores de mapa
    if (Math.abs(lat) < 0.001 && Math.abs(lng) < 0.001) return false;
    return true;
}

function parseCoordinatesFromInput(input = {}) {
    if (!input || typeof input !== 'object') return null;
    const rawLat = input.lat !== undefined && input.lat !== null && input.lat !== '' ? input.lat : input.latitude;
    const rawLng = input.lng !== undefined && input.lng !== null && input.lng !== '' ? input.lng : input.longitude;
    let lat = rawLat !== undefined && rawLat !== null && rawLat !== '' ? Number(rawLat) : NaN;
    let lng = rawLng !== undefined && rawLng !== null && rawLng !== '' ? Number(rawLng) : NaN;

    if (!isValidNonZeroCoords(lat, lng)) {
        lat = NaN;
        lng = NaN;
    }

    const urlOrText = [input.mapsUrl, input.url, input.coords, input.query, input.input]
        .find(v => typeof v === 'string' && v.trim());

    if ((!Number.isFinite(lat) || !Number.isFinite(lng)) && urlOrText) {
        const rawUrl = urlOrText.trim();
        let decodedUrl = rawUrl;
        try {
            decodedUrl = decodeURIComponent(rawUrl);
        } catch (_) {
            decodedUrl = rawUrl;
        }
        const candidateStr = `${rawUrl}\n${decodedUrl}`;
        const pinMatch = candidateStr.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/) ||
                         candidateStr.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/) ||
                         candidateStr.match(/[?&](?:q|query|ll|center|destination|origin)=(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i) ||
                         candidateStr.match(/(?:^|[\s:/=])(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/);
        if (pinMatch) {
            const pLat = Number(pinMatch[1]);
            const pLng = Number(pinMatch[2]);
            if (isValidNonZeroCoords(pLat, pLng)) {
                lat = pLat;
                lng = pLng;
            }
        }
    }

    if (!isValidNonZeroCoords(lat, lng)) {
        return null;
    }
    return {
        lat: Number(lat.toFixed(6)),
        lng: Number(lng.toFixed(6))
    };
}

function calculateHaversineKm(lat1, lng1, lat2, lng2) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getSaltilloTrafficFactor(minutesOfDay, weekday = 1) {
    const isWeekend = weekday === 0 || weekday === 6;
    if (isWeekend) {
        return { level: 'low', label: 'Tráfico ligero', factor: 1.1 };
    }
    // Horas pico en Saltillo (Blvd. V. Carranza / Reynosa / Blvd. Saltillo)
    if (
        (minutesOfDay >= 7 * 60 && minutesOfDay <= 9 * 60 + 15) ||
        (minutesOfDay >= 13 * 60 && minutesOfDay <= 15 * 60 + 15) ||
        (minutesOfDay >= 17 * 60 + 30 && minutesOfDay <= 20 * 60)
    ) {
        return { level: 'high', label: 'Tráfico hora pico', factor: 1.48 };
    }
    if (minutesOfDay >= 6 * 60 + 30 && minutesOfDay <= 21 * 60) {
        return { level: 'moderate', label: 'Tráfico moderado', factor: 1.24 };
    }
    return { level: 'low', label: 'Tráfico fluido', factor: 1.05 };
}

function buildGoogleMapsDirectionsUrl(originCoords, destCoords, mode = 'driving') {
    if (!destCoords || !isValidNonZeroCoords(Number(destCoords.lat), Number(destCoords.lng))) return '';
    const destParam = `${destCoords.lat},${destCoords.lng}`;
    const travelMode = mode === 'walking' ? 'walking' : 'driving';
    if (originCoords && isValidNonZeroCoords(Number(originCoords.lat), Number(originCoords.lng))) {
        const origParam = `${originCoords.lat},${originCoords.lng}`;
        return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origParam)}&destination=${encodeURIComponent(destParam)}&travelmode=${travelMode}`;
    }
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destParam)}&travelmode=${travelMode}`;
}

const _liveDrivingRouteCache = new Map();
const LIVE_DRIVING_CACHE_TTL_MS = 5 * 60 * 1000;

function _buildDrivingCacheKey(originCoords, destCoords) {
    if (!originCoords || !destCoords) return '';
    const oLat = Number(originCoords.lat);
    const oLng = Number(originCoords.lng);
    const dLat = Number(destCoords.lat);
    const dLng = Number(destCoords.lng);
    if (!isValidNonZeroCoords(oLat, oLng) || !isValidNonZeroCoords(dLat, dLng)) return '';
    return `${oLat.toFixed(4)},${oLng.toFixed(4)}->${dLat.toFixed(4)},${dLng.toFixed(4)}`;
}

function getCachedLiveDrivingMinutes(originCoords, destCoords) {
    const key = _buildDrivingCacheKey(originCoords, destCoords);
    if (!key) return null;
    const hit = _liveDrivingRouteCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.savedAt > LIVE_DRIVING_CACHE_TTL_MS) {
        _liveDrivingRouteCache.delete(key);
        return null;
    }
    return hit.driveMinutes;
}

async function resolveLiveDrivingMinutes(originCoords, destCoords, fallbackDriveMin, { minutesOfDay = 9 * 60, weekday = 1 } = {}) {
    const safeFallback = Math.max(1, Math.round(Number(fallbackDriveMin) || 20));
    if (isAutomatedTestEnv()) return safeFallback;
    const cacheKey = _buildDrivingCacheKey(originCoords, destCoords);
    if (!cacheKey) return safeFallback;

    const cached = getCachedLiveDrivingMinutes(originCoords, destCoords);
    if (cached !== null) return cached;

    const oLat = Number(originCoords.lat);
    const oLng = Number(originCoords.lng);
    const dLat = Number(destCoords.lat);
    const dLng = Number(destCoords.lng);

    try {
        let resolvedMinutes = null;
        const gmapsKey = String(process.env.GOOGLE_MAPS_API_KEY || '').trim();
        if (gmapsKey) {
            const gUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(`${oLat},${oLng}`)}&destinations=${encodeURIComponent(`${dLat},${dLng}`)}&mode=driving&departure_time=now&key=${encodeURIComponent(gmapsKey)}`;
            const resp = await fetch(gUrl, { signal: AbortSignal.timeout(2500) });
            if (resp.ok) {
                const data = await resp.json();
                const elem = data?.rows?.[0]?.elements?.[0];
                const secs = Number(elem?.duration_in_traffic?.value ?? elem?.duration?.value);
                if (elem?.status === 'OK' && Number.isFinite(secs) && secs > 0) {
                    resolvedMinutes = Math.max(1, Math.ceil(secs / 60));
                }
            }
        } else {
            const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${oLng},${oLat};${dLng},${dLat}?overview=false`;
            const resp = await fetch(osrmUrl, { signal: AbortSignal.timeout(2500) });
            if (resp.ok) {
                const data = await resp.json();
                const secs = Number(data?.routes?.[0]?.duration);
                if (Number.isFinite(secs) && secs > 0) {
                    const traffic = getSaltilloTrafficFactor(minutesOfDay, weekday);
                    resolvedMinutes = Math.max(1, Math.ceil((secs / 60) * traffic.factor));
                }
            }
        }

        if (resolvedMinutes !== null) {
            if (_liveDrivingRouteCache.size >= 250) {
                const oldestKey = _liveDrivingRouteCache.keys().next().value;
                if (oldestKey) _liveDrivingRouteCache.delete(oldestKey);
            }
            _liveDrivingRouteCache.set(cacheKey, { driveMinutes: resolvedMinutes, savedAt: Date.now() });
            return resolvedMinutes;
        }
    } catch (_) {
        // Fallback inmediato a estimación local determinista ante timeout o red inestable
    }
    return safeFallback;
}

function normalizeNearAlertMinutes(rawInput, fallback = [20, 15, 10]) {
    const cleanFallback = Array.isArray(fallback) && fallback.length
        ? Array.from(new Set(fallback.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 180))).sort((a, b) => b - a)
        : [20, 15, 10];

    let tokens = null;
    if (Array.isArray(rawInput)) {
        tokens = rawInput;
    } else if (typeof rawInput === 'string') {
        const trimmed = rawInput.trim();
        if (!trimmed) return { valid: false, values: cleanFallback };
        tokens = trimmed.split(/[\s,;]+/).filter(Boolean);
    } else if (rawInput === undefined || rawInput === null) {
        return { valid: true, values: cleanFallback };
    } else {
        return { valid: false, values: cleanFallback };
    }

    if (!tokens || tokens.length === 0 || tokens.length > 12) {
        return { valid: false, values: cleanFallback };
    }
    const parsed = [];
    for (const tok of tokens) {
        const num = typeof tok === 'boolean' || tok === null || String(tok).trim() === '' ? NaN : Number(tok);
        if (!Number.isInteger(num) || num < 1 || num > 180) {
            return { valid: false, values: cleanFallback };
        }
        parsed.push(num);
    }
    const uniqueSorted = Array.from(new Set(parsed)).sort((a, b) => b - a);
    return { valid: uniqueSorted.length > 0, values: uniqueSorted.length > 0 ? uniqueSorted : cleanFallback };
}

function computeSmartCommuteAlertSchedule({
    zone = null,
    originCoords = null,
    homeCoords = null,
    destCoords = null,
    routeMinutes = undefined,
    driveMinutes = undefined,
    extraBufferMinutes = 30,
    buffer = undefined,
    repeatEveryMinutes = 5,
    step = undefined,
    nearAlertMinutes = [20, 15, 10],
    nearRadiusKm = 0.5,
    homeRadiusKm = null,
    hasLiveGps = null,
    acknowledged = false
} = {}) {
    const effNearRadius = Number.isFinite(Number(nearRadiusKm)) && Number(nearRadiusKm) >= 0.05 && Number(nearRadiusKm) <= 10
        ? Number(nearRadiusKm)
        : 0.5;
    const effHomeRadius = Number.isFinite(Number(homeRadiusKm)) && Number(homeRadiusKm) > 0
        ? Number(homeRadiusKm)
        : effNearRadius;

    const rawBuffer = buffer !== undefined ? buffer : extraBufferMinutes;
    const effBuffer = Number.isFinite(Number(rawBuffer))
        ? Math.max(5, Math.min(120, Math.round(Number(rawBuffer))))
        : 30;
    const rawStep = step !== undefined ? step : repeatEveryMinutes;
    const effStep = Number.isFinite(Number(rawStep))
        ? Math.max(1, Math.min(30, Math.round(Number(rawStep))))
        : 5;
    const nearParsed = normalizeNearAlertMinutes(nearAlertMinutes, [20, 15, 10]);
    const nearMilestones = nearParsed.valid ? nearParsed.values : [20, 15, 10];

    const rawRoute = routeMinutes !== undefined ? routeMinutes : driveMinutes;
    const T = Math.max(1, Math.ceil(Number(rawRoute) || 20));

    let resolvedZone = null;
    if (typeof zone === 'string' && zone.trim()) {
        const z = zone.trim().toLowerCase();
        if (z === 'near' || z === 'near_destination') resolvedZone = 'near';
        else if (z === 'home') resolvedZone = 'home';
        else if (z === 'away' || z === 'away_far') resolvedZone = 'away';
    }

    if (!resolvedZone) {
        const validOrigin = Boolean(originCoords && isValidNonZeroCoords(Number(originCoords.lat), Number(originCoords.lng)));
        const validDest = Boolean(destCoords && isValidNonZeroCoords(Number(destCoords.lat), Number(destCoords.lng)));
        const validHome = Boolean(homeCoords && isValidNonZeroCoords(Number(homeCoords.lat), Number(homeCoords.lng)));

        const isNear = Boolean(
            validOrigin && validDest &&
            calculateHaversineKm(Number(originCoords.lat), Number(originCoords.lng), Number(destCoords.lat), Number(destCoords.lng)) <= effNearRadius
        );
        if (isNear) {
            resolvedZone = 'near';
        } else {
            let isAtHome = false;
            if (validOrigin && validHome) {
                const distHomeKm = calculateHaversineKm(
                    Number(originCoords.lat),
                    Number(originCoords.lng),
                    Number(homeCoords.lat),
                    Number(homeCoords.lng)
                );
                isAtHome = distHomeKm <= effHomeRadius;
            } else if (hasLiveGps === false) {
                isAtHome = true;
            } else if (!validOrigin && !validHome) {
                isAtHome = true;
            }
            resolvedZone = isAtHome ? 'home' : 'away';
        }
    }

    if (resolvedZone === 'near') {
        const milestones = acknowledged ? [] : [...nearMilestones];
        return {
            zone: 'near',
            legacyZone: 'near_destination',
            isNear: true,
            isAtHome: false,
            routeMinutes: T,
            extraBufferMinutes: effBuffer,
            repeatEveryMinutes: effStep,
            nearAlertMinutes: nearMilestones,
            milestones,
            schedule: milestones,
            recommendedLeadMinutes: nearMilestones[0] || 20
        };
    }

    const startLead = T + effBuffer;
    const seq = [];
    if (!acknowledged) {
        for (let m = startLead; m > 0; m -= effStep) {
            seq.push(m);
        }
    }

    return {
        zone: resolvedZone,
        legacyZone: resolvedZone === 'home' ? 'home' : 'away_far',
        isNear: false,
        isAtHome: resolvedZone === 'home',
        routeMinutes: T,
        extraBufferMinutes: effBuffer,
        repeatEveryMinutes: effStep,
        nearAlertMinutes: nearMilestones,
        milestones: seq,
        schedule: seq,
        recommendedLeadMinutes: startLead
    };
}

function computeCommuteAlertMilestones(options = {}) {
    return computeSmartCommuteAlertSchedule(options);
}

function pickActiveCommuteMilestone(startMin, minutesOfDay, milestones = [], postStartGraceMin = 0) {
    if (!Array.isArray(milestones) || milestones.length === 0) return null;
    const grace = Number.isFinite(Number(postStartGraceMin)) ? Number(postStartGraceMin) : 0;
    if (grace <= 0 ? (minutesOfDay >= startMin) : (minutesOfDay > startMin + grace)) {
        return null;
    }
    const triggered = milestones
        .map((m) => Number(m))
        .filter((m) => Number.isFinite(m) && m > 0 && minutesOfDay >= Math.max(0, startMin - m))
        .sort((a, b) => a - b);
    return triggered.length > 0 ? triggered[0] : null;
}

function estimateCommuteDetails({
    originCoords,
    homeCoords = null,
    destCoords,
    targetMinutesOfDay = 9 * 60,
    weekday = 1,
    isFirstOfDay = true,
    nearRadiusKm = 0.5,
    extraBufferMinutes = 30,
    repeatEveryMinutes = 5,
    nearAlertMinutes = [20, 15, 10],
    hasLiveGps = null
}) {
    const nearParsed = normalizeNearAlertMinutes(nearAlertMinutes, [20, 15, 10]);
    const effNearList = nearParsed.valid ? nearParsed.values : [20, 15, 10];
    const effBuffer = Number.isFinite(Number(extraBufferMinutes))
        ? Math.max(5, Math.min(120, Math.round(Number(extraBufferMinutes))))
        : 30;
    const effStep = Number.isFinite(Number(repeatEveryMinutes))
        ? Math.max(1, Math.min(30, Math.round(Number(repeatEveryMinutes))))
        : 5;

    if (!destCoords || !isValidNonZeroCoords(Number(destCoords.lat), Number(destCoords.lng))) {
        const fallbackDrive = isFirstOfDay ? 20 : 0;
        if (!isFirstOfDay) {
            return {
                hasOrigin: false,
                isNear: true,
                isAtHome: false,
                commuteZone: 'near',
                alertMilestones: effNearList,
                distanceKm: 0,
                roadDistanceKm: 0,
                driveMinutes: 0,
                walkMinutes: 6,
                extraBufferMinutes: effBuffer,
                repeatEveryMinutes: effStep,
                nearAlertMinutes: effNearList,
                trafficLabel: 'Ruta estándar',
                recommendedLeadMinutes: effNearList[0] || 20,
                mapsUrl: ''
            };
        }
        const zoneMeta = computeSmartCommuteAlertSchedule({
            originCoords: null,
            homeCoords,
            destCoords: null,
            routeMinutes: fallbackDrive,
            extraBufferMinutes: effBuffer,
            repeatEveryMinutes: effStep,
            nearAlertMinutes: effNearList,
            nearRadiusKm,
            hasLiveGps: hasLiveGps ?? false
        });
        return {
            hasOrigin: false,
            isNear: false,
            isAtHome: zoneMeta.isAtHome,
            commuteZone: zoneMeta.zone,
            alertMilestones: zoneMeta.milestones,
            distanceKm: 0,
            roadDistanceKm: 0,
            driveMinutes: fallbackDrive,
            walkMinutes: 6,
            extraBufferMinutes: zoneMeta.extraBufferMinutes,
            repeatEveryMinutes: zoneMeta.repeatEveryMinutes,
            nearAlertMinutes: zoneMeta.nearAlertMinutes,
            trafficLabel: 'Ruta estándar',
            recommendedLeadMinutes: zoneMeta.recommendedLeadMinutes,
            mapsUrl: ''
        };
    }

    if (!originCoords || !isValidNonZeroCoords(Number(originCoords.lat), Number(originCoords.lng))) {
        if (!isFirstOfDay) {
            return {
                hasOrigin: false,
                isNear: true,
                isAtHome: false,
                commuteZone: 'near',
                alertMilestones: effNearList,
                distanceKm: 0,
                roadDistanceKm: 0,
                driveMinutes: 0,
                walkMinutes: 5,
                extraBufferMinutes: effBuffer,
                repeatEveryMinutes: effStep,
                nearAlertMinutes: effNearList,
                trafficLabel: 'En campus / cerca',
                recommendedLeadMinutes: effNearList[0] || 20,
                mapsUrl: buildGoogleMapsDirectionsUrl(null, destCoords, 'walking')
            };
        }
        const fallbackDrive = 20;
        const zoneMeta = computeSmartCommuteAlertSchedule({
            originCoords: null,
            homeCoords,
            destCoords,
            routeMinutes: fallbackDrive,
            extraBufferMinutes: effBuffer,
            repeatEveryMinutes: effStep,
            nearAlertMinutes: effNearList,
            nearRadiusKm,
            hasLiveGps: false
        });
        return {
            hasOrigin: false,
            isNear: false,
            isAtHome: zoneMeta.isAtHome,
            commuteZone: zoneMeta.zone,
            alertMilestones: zoneMeta.milestones,
            distanceKm: 0,
            roadDistanceKm: 0,
            driveMinutes: fallbackDrive,
            walkMinutes: 5,
            extraBufferMinutes: zoneMeta.extraBufferMinutes,
            repeatEveryMinutes: zoneMeta.repeatEveryMinutes,
            nearAlertMinutes: zoneMeta.nearAlertMinutes,
            trafficLabel: 'Estimado desde casa (sin GPS activo)',
            recommendedLeadMinutes: zoneMeta.recommendedLeadMinutes,
            mapsUrl: buildGoogleMapsDirectionsUrl(null, destCoords, 'driving')
        };
    }

    const straightKm = calculateHaversineKm(originCoords.lat, originCoords.lng, destCoords.lat, destCoords.lng);
    const roadKm = Number((straightKm * 1.32).toFixed(2));
    const traffic = getSaltilloTrafficFactor(targetMinutesOfDay, weekday);
    // Velocidad base urbana en Saltillo ~30 km/h ajustada por factor de tráfico (o ruta real Maps cacheada)
    const baseDriveMin = Math.max(3, Math.ceil((roadKm / 30) * 60 * traffic.factor));
    const cachedLiveMin = getCachedLiveDrivingMinutes(originCoords, destCoords);
    const driveMinutes = Math.max(1, Math.ceil(cachedLiveMin !== null ? cachedLiveMin : baseDriveMin));
    const walkMinutes = Math.max(2, Math.round((straightKm * 1.25 / 4.6) * 60));

    const zoneMeta = computeSmartCommuteAlertSchedule({
        originCoords,
        homeCoords,
        destCoords,
        routeMinutes: driveMinutes,
        extraBufferMinutes: effBuffer,
        repeatEveryMinutes: effStep,
        nearAlertMinutes: effNearList,
        nearRadiusKm,
        hasLiveGps
    });

    return {
        hasOrigin: true,
        isNear: zoneMeta.isNear,
        isAtHome: zoneMeta.isAtHome,
        commuteZone: zoneMeta.zone,
        alertMilestones: zoneMeta.milestones,
        distanceKm: Number(straightKm.toFixed(2)),
        roadDistanceKm: roadKm,
        driveMinutes,
        walkMinutes,
        extraBufferMinutes: zoneMeta.extraBufferMinutes,
        repeatEveryMinutes: zoneMeta.repeatEveryMinutes,
        nearAlertMinutes: zoneMeta.nearAlertMinutes,
        trafficLevel: traffic.level,
        trafficLabel: traffic.label,
        recommendedLeadMinutes: zoneMeta.recommendedLeadMinutes,
        mapsUrl: buildGoogleMapsDirectionsUrl(originCoords, destCoords, zoneMeta.isNear ? 'walking' : 'driving')
    };
}

async function warmLiveDrivingRoutesForPlanner(planner, localNow) {
    if (isAutomatedTestEnv() || !planner || typeof planner !== 'object') return;
    const originInfo = resolveUserOriginCoords(planner, true);
    const originCoords = originInfo.coords;
    if (!originCoords || !isValidNonZeroCoords(Number(originCoords.lat), Number(originCoords.lng))) return;

    const effNear = planner.nearRadiusKm || planner.commuteNearRadiusKm || 0.5;
    const targets = [];
    const campusDir = getEffectiveCampusDirectory(planner);
    for (const campus of Object.values(campusDir)) {
        if (campus && isValidNonZeroCoords(Number(campus.lat), Number(campus.lng))) {
            targets.push({ lat: Number(campus.lat), lng: Number(campus.lng) });
        }
    }
    const resCoords = parseCoordinatesFromInput(planner.residencias?.location || {});
    if (resCoords) targets.push(resCoords);
    const workCoords = parseCoordinatesFromInput(planner.work?.location || {});
    if (workCoords) targets.push(workCoords);

    await Promise.all(targets.map(async (dest) => {
        const km = calculateHaversineKm(originCoords.lat, originCoords.lng, dest.lat, dest.lng);
        if (km <= effNear) return;
        const traffic = getSaltilloTrafficFactor(localNow?.minutesOfDay ?? 540, localNow?.weekday ?? 1);
        const fallbackMin = Math.max(3, Math.ceil(((km * 1.32) / 30) * 60 * traffic.factor));
        await resolveLiveDrivingMinutes(originCoords, dest, fallbackMin, {
            minutesOfDay: localNow?.minutesOfDay ?? 540,
            weekday: localNow?.weekday ?? 1
        });
    }));
}

function getDefaultAcademicPlanner() {
    return {
        universityName: 'Instituto Tecnológico de Saltillo (TecNM)',
        activeSemesterId: 'sem-9no-2026',
        classRemindersEnabled: true,
        commuteExtraBufferMinutes: 30,
        commuteRepeatEveryMinutes: 5,
        commuteNearAlertMinutes: [20, 15, 10],
        commuteNearRadiusKm: 0.5,
        farLeadMinutesMin: 30,
        nearLeadMinutes: 10,
        nearRadiusKm: 0.5,
        parkingBufferMinutes: 8,
        locations: {
            home: {
                label: 'Mi Casa',
                address: 'Saltillo, Coahuila',
                mapsUrl: '',
                lat: null,
                lng: null
            },
            university: {
                label: 'Instituto Tecnológico de Saltillo (Blvd. V. Carranza #2400)',
                address: 'Blvd. Venustiano Carranza #2400, Col. Tecnológico, Saltillo, Coahuila',
                mapsUrl: 'https://www.google.com/maps?q=25.4414,-100.9922',
                lat: 25.4414,
                lng: -100.9922
            },
            campuses: {
                principal: {
                    id: 'principal',
                    name: ITS_CAMPUS_DIRECTORY.principal.name,
                    label: ITS_CAMPUS_DIRECTORY.principal.name,
                    plano: ITS_CAMPUS_DIRECTORY.principal.plano,
                    address: ITS_CAMPUS_DIRECTORY.principal.address,
                    mapsUrl: `https://www.google.com/maps?q=${ITS_CAMPUS_DIRECTORY.principal.lat},${ITS_CAMPUS_DIRECTORY.principal.lng}`,
                    lat: ITS_CAMPUS_DIRECTORY.principal.lat,
                    lng: ITS_CAMPUS_DIRECTORY.principal.lng,
                    rooms: [],
                    buildings: ITS_CAMPUS_DIRECTORY.principal.buildings
                },
                miravalle: {
                    id: 'miravalle',
                    name: ITS_CAMPUS_DIRECTORY.miravalle.name,
                    label: ITS_CAMPUS_DIRECTORY.miravalle.name,
                    plano: ITS_CAMPUS_DIRECTORY.miravalle.plano,
                    address: ITS_CAMPUS_DIRECTORY.miravalle.address,
                    mapsUrl: `https://www.google.com/maps?q=${ITS_CAMPUS_DIRECTORY.miravalle.lat},${ITS_CAMPUS_DIRECTORY.miravalle.lng}`,
                    lat: ITS_CAMPUS_DIRECTORY.miravalle.lat,
                    lng: ITS_CAMPUS_DIRECTORY.miravalle.lng,
                    rooms: [],
                    buildings: ITS_CAMPUS_DIRECTORY.miravalle.buildings
                },
                boillot: {
                    id: 'boillot',
                    name: ITS_CAMPUS_DIRECTORY.boillot.name,
                    label: ITS_CAMPUS_DIRECTORY.boillot.name,
                    plano: ITS_CAMPUS_DIRECTORY.boillot.plano,
                    address: ITS_CAMPUS_DIRECTORY.boillot.address,
                    mapsUrl: `https://www.google.com/maps?q=${ITS_CAMPUS_DIRECTORY.boillot.lat},${ITS_CAMPUS_DIRECTORY.boillot.lng}`,
                    lat: ITS_CAMPUS_DIRECTORY.boillot.lat,
                    lng: ITS_CAMPUS_DIRECTORY.boillot.lng,
                    rooms: [],
                    buildings: ITS_CAMPUS_DIRECTORY.boillot.buildings
                }
            },
            current: {
                label: 'Ubicación actual',
                lat: null,
                lng: null,
                updatedAt: null,
                source: 'none'
            }
        },
        semesters: [
            {
                id: 'sem-9no-2026',
                name: '9no Semestre · Ing. en Sistemas Computacionales',
                termCode: '2026-2',
                startDate: '2026-08-17',
                endDate: '2026-12-18',
                active: true,
                courses: []
            }
        ],
        vacations: [
            {
                id: 'vac-semana-santa-2026',
                name: 'Vacaciones de Semana Santa TecNM',
                nombre: 'Vacaciones de Semana Santa TecNM',
                startDate: '2026-03-30',
                endDate: '2026-04-10',
                fechaInicio: '2026-03-30',
                fechaFin: '2026-04-10'
            },
            {
                id: 'vac-invierno-2026',
                name: 'Vacaciones de Invierno TecNM',
                nombre: 'Vacaciones de Invierno TecNM',
                startDate: '2026-12-19',
                endDate: '2027-01-17',
                fechaInicio: '2026-12-19',
                fechaFin: '2027-01-17'
            }
        ],
        residencias: {
            enabled: false,
            projectName: '',
            companyName: '',
            advisorName: '',
            modality: 'presencial',
            totalHoursGoal: 500,
            loggedHours: 0,
            days: [1, 2, 3, 4, 5],
            startTime: '08:00',
            endTime: '13:00',
            location: {
                label: 'Empresa de Residencias',
                address: '',
                mapsUrl: '',
                lat: null,
                lng: null
            }
        },
        work: {
            enabled: false,
            scheduleType: 'medio_tiempo',
            companyName: '',
            roleTitle: '',
            modality: 'presencial',
            days: [1, 2, 3, 4, 5],
            startTime: '08:00',
            endTime: '16:00',
            location: {
                label: 'Lugar de Trabajo',
                address: '',
                mapsUrl: '',
                lat: null,
                lng: null
            }
        }
    };
}

function sanitizeLocationObject(rawLoc = {}, fallback = {}) {
    const base = {
        label: String(fallback.label || 'Ubicación').slice(0, 120),
        address: String(fallback.address || '').slice(0, 200),
        mapsUrl: String(fallback.mapsUrl || '').slice(0, 500),
        lat: fallback.lat ?? null,
        lng: fallback.lng ?? null
    };
    if (!rawLoc || typeof rawLoc !== 'object') return base;
    if (typeof rawLoc.label === 'string') base.label = rawLoc.label.trim().slice(0, 120) || base.label;
    if (typeof rawLoc.address === 'string') base.address = rawLoc.address.trim().slice(0, 200);
    if (typeof rawLoc.mapsUrl === 'string') base.mapsUrl = rawLoc.mapsUrl.trim().slice(0, 500);

    const parsedCoords = parseCoordinatesFromInput({
        lat: rawLoc.lat,
        lng: rawLoc.lng,
        mapsUrl: base.mapsUrl
    });
    if (parsedCoords) {
        base.lat = parsedCoords.lat;
        base.lng = parsedCoords.lng;
    } else if (
        rawLoc.lat === null || rawLoc.lat === '' ||
        rawLoc.lng === null || rawLoc.lng === '' ||
        (rawLoc.lat !== undefined && Number.isFinite(Number(rawLoc.lat)) && Math.abs(Number(rawLoc.lat)) < 0.001) ||
        (rawLoc.lng !== undefined && Number.isFinite(Number(rawLoc.lng)) && Math.abs(Number(rawLoc.lng)) < 0.001)
    ) {
        base.lat = null;
        base.lng = null;
    }
    if (!isValidNonZeroCoords(Number(base.lat), Number(base.lng))) {
        base.lat = null;
        base.lng = null;
    }
    return base;
}

function sanitizeCourseFinalGrade(rawVal) {
    if (rawVal === undefined || rawVal === null || rawVal === '' || typeof rawVal === 'boolean') {
        return null;
    }
    const num = Number(rawVal);
    if (!Number.isFinite(num)) return null;
    const clamped = Math.max(0, Math.min(100, num));
    return Number(clamped.toFixed(2));
}

function sanitizeAcademicPlanner(rawPlanner = {}, basePlanner = getDefaultAcademicPlanner()) {
    const def = getDefaultAcademicPlanner();
    const src = rawPlanner && typeof rawPlanner === 'object' ? rawPlanner : {};
    const prev = basePlanner && typeof basePlanner === 'object' ? basePlanner : def;

    const rawExtraBuffer = src.commuteExtraBufferMinutes !== undefined
        ? src.commuteExtraBufferMinutes
        : (src.farLeadMinutesMin !== undefined ? src.farLeadMinutesMin : (prev.commuteExtraBufferMinutes ?? prev.farLeadMinutesMin ?? 30));
    const sanitizedExtraBuffer = Number.isFinite(Number(rawExtraBuffer))
        ? Math.max(5, Math.min(120, Math.round(Number(rawExtraBuffer))))
        : 30;
    const rawRepeatEvery = src.commuteRepeatEveryMinutes !== undefined
        ? src.commuteRepeatEveryMinutes
        : (prev.commuteRepeatEveryMinutes ?? 5);
    const sanitizedRepeatEvery = Number.isFinite(Number(rawRepeatEvery))
        ? Math.max(1, Math.min(30, Math.round(Number(rawRepeatEvery))))
        : 5;
    const nearAlertRes = normalizeNearAlertMinutes(
        src.commuteNearAlertMinutes !== undefined ? src.commuteNearAlertMinutes : prev.commuteNearAlertMinutes,
        [20, 15, 10]
    );
    const rawNearRadius = src.commuteNearRadiusKm !== undefined
        ? src.commuteNearRadiusKm
        : (src.nearRadiusKm !== undefined ? src.nearRadiusKm : (prev.commuteNearRadiusKm ?? prev.nearRadiusKm ?? 0.5));
    const sanitizedNearRadius = Number.isFinite(Number(rawNearRadius))
        ? Math.max(0.05, Math.min(10, Number(Number(rawNearRadius).toFixed(2))))
        : 0.5;

    const out = {
        universityName: typeof src.universityName === 'string' && src.universityName.trim()
            ? src.universityName.trim().slice(0, 140)
            : (prev.universityName || def.universityName),
        activeSemesterId: typeof src.activeSemesterId === 'string' && src.activeSemesterId.trim()
            ? src.activeSemesterId.trim().slice(0, 60)
            : (prev.activeSemesterId || def.activeSemesterId),
        classRemindersEnabled: typeof src.classRemindersEnabled === 'boolean'
            ? src.classRemindersEnabled
            : (typeof src.commuteRemindersEnabled === 'boolean'
                ? src.commuteRemindersEnabled
                : (typeof prev.classRemindersEnabled === 'boolean' ? prev.classRemindersEnabled : true)),
        commuteExtraBufferMinutes: sanitizedExtraBuffer,
        commuteRepeatEveryMinutes: sanitizedRepeatEvery,
        commuteNearAlertMinutes: nearAlertRes.values,
        commuteNearRadiusKm: sanitizedNearRadius,
        farLeadMinutesMin: sanitizedExtraBuffer,
        nearLeadMinutes: Number.isFinite(Number(src.nearLeadMinutes))
            ? Math.max(5, Math.min(45, Math.round(Number(src.nearLeadMinutes))))
            : (prev.nearLeadMinutes || 10),
        nearRadiusKm: sanitizedNearRadius,
        parkingBufferMinutes: Number.isFinite(Number(src.parkingBufferMinutes))
            ? Math.max(0, Math.min(30, Math.round(Number(src.parkingBufferMinutes))))
            : (prev.parkingBufferMinutes ?? 8),
        locations: {
            home: sanitizeLocationObject(src.locations?.home, prev.locations?.home || def.locations.home),
            university: sanitizeLocationObject(src.locations?.university, prev.locations?.university || def.locations.university),
            campuses: {},
            current: {
                label: typeof src.locations?.current?.label === 'string' && src.locations.current.label.trim()
                    ? src.locations.current.label.trim().slice(0, 80)
                    : (prev.locations?.current?.label || 'Ubicación actual'),
                lat: null,
                lng: null,
                updatedAt: src.locations?.current?.updatedAt || prev.locations?.current?.updatedAt || null,
                source: String(src.locations?.current?.source || prev.locations?.current?.source || 'none').slice(0, 30)
            }
        },
        phoneGpsNonce: typeof src.phoneGpsNonce === 'string' && /^[a-f0-9]{16,64}$/i.test(src.phoneGpsNonce.trim())
            ? src.phoneGpsNonce.trim()
            : (typeof prev.phoneGpsNonce === 'string' && /^[a-f0-9]{16,64}$/i.test(prev.phoneGpsNonce.trim()) ? prev.phoneGpsNonce.trim() : ''),
        semesters: [],
        vacations: [],
        residencias: {},
        work: {}
    };

    const hasExplicitSrcCampuses = Boolean(
        src.locations
        && Object.prototype.hasOwnProperty.call(src.locations, 'campuses')
        && src.locations.campuses
        && typeof src.locations.campuses === 'object'
        && !Array.isArray(src.locations.campuses)
    );
    const prevCampuses = prev.locations?.campuses && typeof prev.locations.campuses === 'object' && !Array.isArray(prev.locations.campuses)
        ? prev.locations.campuses
        : def.locations.campuses;
    const rawCampusesSource = hasExplicitSrcCampuses ? src.locations.campuses : prevCampuses;
    for (const [rawKey, rawVal] of Object.entries(rawCampusesSource).slice(0, 25)) {
        const cleanId = normalizeCampusId(rawVal?.id || rawKey);
        if (!cleanId) continue;
        const fallbackCampus = prevCampuses[cleanId] || ITS_CAMPUS_DIRECTORY[cleanId] || null;
        out.locations.campuses[cleanId] = sanitizeCampusEntry(cleanId, rawVal || {}, fallbackCampus);
    }

    // Mantener sincronizado locations.university <-> locations.campuses.principal solo si principal existe
    if (Object.prototype.hasOwnProperty.call(out.locations.campuses, 'principal')) {
        const prevPrincipalCoords = parseCoordinatesFromInput(prev?.locations?.campuses?.principal || {});
        const prevUniCoords = parseCoordinatesFromInput(prev?.locations?.university || {});
        const rawCampusPrincipal = src.locations?.campuses?.principal;
        const rawUniLoc = src.locations?.university;
        const rawCampusPrincipalCoords = parseCoordinatesFromInput(rawCampusPrincipal || {});
        const rawUniCoords = parseCoordinatesFromInput(rawUniLoc || {});
        const campusPrincipalChanged = Boolean(rawCampusPrincipalCoords && (!prevPrincipalCoords || Math.abs(rawCampusPrincipalCoords.lat - prevPrincipalCoords.lat) > 0.00001 || Math.abs(rawCampusPrincipalCoords.lng - prevPrincipalCoords.lng) > 0.00001));
        const uniLocChanged = Boolean(rawUniCoords && (!prevUniCoords || Math.abs(rawUniCoords.lat - prevUniCoords.lat) > 0.00001 || Math.abs(rawUniCoords.lng - prevUniCoords.lng) > 0.00001));
        if (campusPrincipalChanged || (rawCampusPrincipalCoords && !uniLocChanged)) {
            out.locations.university = sanitizeLocationObject({
                ...out.locations.university,
                address: out.locations.campuses.principal.address || out.locations.university.address,
                mapsUrl: out.locations.campuses.principal.mapsUrl || `https://www.google.com/maps?q=${rawCampusPrincipalCoords.lat},${rawCampusPrincipalCoords.lng}`,
                lat: rawCampusPrincipalCoords.lat,
                lng: rawCampusPrincipalCoords.lng
            }, out.locations.university);
        } else if (uniLocChanged || rawUniCoords) {
            const chosenUni = rawUniCoords || parseCoordinatesFromInput(out.locations.university || {});
            if (chosenUni) {
                out.locations.campuses.principal = sanitizeCampusEntry('principal', {
                    ...out.locations.campuses.principal,
                    address: out.locations.university.address || out.locations.campuses.principal.address,
                    mapsUrl: out.locations.university.mapsUrl || `https://www.google.com/maps?q=${chosenUni.lat},${chosenUni.lng}`,
                    lat: chosenUni.lat,
                    lng: chosenUni.lng
                }, out.locations.campuses.principal);
            }
        }
    }

    const currCoords = parseCoordinatesFromInput(src.locations?.current || prev.locations?.current || {});
    if (currCoords) {
        out.locations.current.lat = currCoords.lat;
        out.locations.current.lng = currCoords.lng;
    } else {
        out.locations.current.lat = null;
        out.locations.current.lng = null;
        out.locations.current.updatedAt = null;
        out.locations.current.source = 'none';
    }

    const effectiveCampusDir = getEffectiveCampusDirectory(out);
    const activeCampusIds = Object.keys(effectiveCampusDir);
    const rawSemesters = Array.isArray(src.semesters) ? src.semesters : (Array.isArray(prev.semesters) ? prev.semesters : def.semesters);
    out.semesters = rawSemesters.slice(0, 16).map((sem, idx) => {
        const sId = typeof sem?.id === 'string' && sem.id.trim() ? sem.id.trim().slice(0, 60) : `sem-${idx + 1}`;
        const rawCourses = Array.isArray(sem?.courses) ? sem.courses : [];
        const courses = rawCourses.slice(0, 30).map((c, cIdx) => {
            const roomInfo = resolveItsClassroom(c?.room || '', effectiveCampusDir);
            const days = Array.isArray(c?.days)
                ? Array.from(new Set(c.days.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))).sort((a, b) => a - b)
                : [1, 2, 3, 4, 5];
            const cleanReqCampusId = normalizeCampusId(c?.campusId || '');
            const resolvedCourseCampusId = cleanReqCampusId && activeCampusIds.includes(cleanReqCampusId)
                ? cleanReqCampusId
                : (activeCampusIds.includes(roomInfo.campusId) ? roomInfo.campusId : (activeCampusIds[0] || roomInfo.campusId));
            const isCompleted = Boolean(c?.completed);
            const isPaused = isCompleted ? true : Boolean(c?.remindersPaused);
            return {
                id: typeof c?.id === 'string' && c.id.trim() ? c.id.trim().slice(0, 60) : `course-${idx + 1}-${cIdx + 1}`,
                code: String(c?.code || '').trim().slice(0, 30),
                name: String(c?.name || 'Materia').trim().slice(0, 120) || 'Materia',
                teacher: String(c?.teacher || '').trim().slice(0, 120),
                group: String(c?.group || '').trim().slice(0, 20),
                room: roomInfo.room,
                campusId: resolvedCourseCampusId,
                days: days.length ? days : [1, 2, 3, 4, 5],
                startTime: HHMM_REGEX.test(String(c?.startTime || '').trim()) ? String(c.startTime).trim() : '09:00',
                endTime: HHMM_REGEX.test(String(c?.endTime || '').trim()) ? String(c.endTime).trim() : '10:00',
                remindersPaused: isPaused,
                completed: isCompleted,
                finalGrade: sanitizeCourseFinalGrade(c?.finalGrade)
            };
        });
        return {
            id: sId,
            name: String(sem?.name || `Semestre ${idx + 1}`).trim().slice(0, 120),
            termCode: String(sem?.termCode || '').trim().slice(0, 30),
            startDate: /^\d{4}-\d{2}-\d{2}$/.test(String(sem?.startDate || '')) ? String(sem.startDate) : '2026-08-17',
            endDate: /^\d{4}-\d{2}-\d{2}$/.test(String(sem?.endDate || '')) ? String(sem.endDate) : '2026-12-18',
            active: Boolean(sem?.active),
            courses
        };
    });
    if (out.semesters.length === 0) {
        out.semesters = def.semesters;
    }
    if (!out.semesters.some(s => s.id === out.activeSemesterId)) {
        out.activeSemesterId = out.semesters[0].id;
    }

    const rawVacations = Array.isArray(src.vacations) ? src.vacations : (Array.isArray(prev.vacations) ? prev.vacations : def.vacations);
    out.vacations = rawVacations.slice(0, 30).filter(v =>
        v && /^\d{4}-\d{2}-\d{2}$/.test(String(v.startDate || '')) && /^\d{4}-\d{2}-\d{2}$/.test(String(v.endDate || ''))
    ).map((v, vIdx) => ({
        id: typeof v.id === 'string' && v.id.trim() ? v.id.trim().slice(0, 60) : `vac-${vIdx + 1}`,
        name: String(v.name || 'Periodo vacacional').trim().slice(0, 120),
        startDate: String(v.startDate),
        endDate: String(v.endDate)
    }));

    const rawRes = src.residencias && typeof src.residencias === 'object' ? src.residencias : (prev.residencias || def.residencias);
    const resDays = Array.isArray(rawRes.days)
        ? Array.from(new Set(rawRes.days.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))).sort((a, b) => a - b)
        : [1, 2, 3, 4, 5];
    out.residencias = {
        enabled: Boolean(rawRes.enabled),
        projectName: String(rawRes.projectName || '').trim().slice(0, 160),
        companyName: String(rawRes.companyName || '').trim().slice(0, 140),
        advisorName: String(rawRes.advisorName || '').trim().slice(0, 120),
        modality: ['presencial', 'hibrido', 'remoto'].includes(rawRes.modality) ? rawRes.modality : 'presencial',
        totalHoursGoal: Number.isFinite(Number(rawRes.totalHoursGoal)) ? Math.max(1, Math.min(2000, Math.round(Number(rawRes.totalHoursGoal)))) : 500,
        loggedHours: Number.isFinite(Number(rawRes.loggedHours)) ? Math.max(0, Math.min(2000, Number(Number(rawRes.loggedHours).toFixed(1)))) : 0,
        days: resDays.length ? resDays : [1, 2, 3, 4, 5],
        startTime: HHMM_REGEX.test(String(rawRes.startTime || '').trim()) ? String(rawRes.startTime).trim() : '08:00',
        endTime: HHMM_REGEX.test(String(rawRes.endTime || '').trim()) ? String(rawRes.endTime).trim() : '13:00',
        location: sanitizeLocationObject(rawRes.location, prev.residencias?.location || def.residencias.location)
    };

    const rawWork = src.work && typeof src.work === 'object' ? src.work : (prev.work || def.work);
    const workDays = Array.isArray(rawWork.days)
        ? Array.from(new Set(rawWork.days.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))).sort((a, b) => a - b)
        : [1, 2, 3, 4, 5];
    out.work = {
        enabled: Boolean(rawWork.enabled),
        scheduleType: ['tiempo_completo', 'medio_tiempo', 'por_turnos'].includes(rawWork.scheduleType) ? rawWork.scheduleType : 'medio_tiempo',
        companyName: String(rawWork.companyName || '').trim().slice(0, 140),
        roleTitle: String(rawWork.roleTitle || '').trim().slice(0, 120),
        modality: ['presencial', 'hibrido', 'remoto'].includes(rawWork.modality) ? rawWork.modality : 'presencial',
        days: workDays.length ? workDays : [1, 2, 3, 4, 5],
        startTime: HHMM_REGEX.test(String(rawWork.startTime || '').trim()) ? String(rawWork.startTime).trim() : '08:00',
        endTime: HHMM_REGEX.test(String(rawWork.endTime || '').trim()) ? String(rawWork.endTime).trim() : '16:00',
        location: sanitizeLocationObject(rawWork.location, prev.work?.location || def.work.location)
    };

    return out;
}

function getDefaultUserSettings() {
    return {
        uiLanguage: 'en',
        defaultAgendaCategory: 'all',
        defaultAgendaLayout: 'auto',
        agendaShowWeekend: true,
        timezone: process.env.TZ || 'America/Monterrey',
        publicBaseUrl: '',
        youtubePlatformMode: 'auto',
        phoneNotificationsEnabled: false,
        ntfyServerUrl: 'https://ntfy.sh',
        ntfyTopic: '',
        ntfyPriority: 4,
        desktopNotificationsEnabled: false,
        moodRemindersEnabled: true,
        moodNotifyPending: true,
        moodIncludeLateNight: false,
        sleepReminderEnabled: true,
        sleepReminderTime: '08:30',
        sleepDesveloBedtimeTime: '01:00',
        sleepMinNormalHours: 7,
        agendaRemindersEnabled: true,
        agendaNotifyEvents: true,
        agendaNotifyTasks: true,
        agendaNotifyPendingTasks: true,
        agendaLeadMinutes: 10,
        commuteRemindersEnabled: true,
        commuteExtraBufferMinutes: 30,
        commuteRepeatEveryMinutes: 5,
        commuteNearAlertMinutes: [20, 15, 10],
        commuteNearRadiusKm: 0.5,
        wordEodReminderEnabled: true,
        wordEodReminderTime: '21:30',
        englishReminderEnabled: false,
        englishReminderTime: '19:00',
        englishReminderDays: [1, 2, 3, 4, 5],
        englishReminderTopic: 'Practice vocabulary, grammar notes, and phrasal verbs',
        preferredStudyLanguage: 'en_ko',
        geminiModel: 'gemini-2.5-flash',
        geminiApiKey: '',
        journalDownloadPassword: '',
        studyDriveSyncEnabled: true,
        studyDriveFolder: String(process.env.STUDY_RCLONE_DIR || 'NotasIdiomas').trim(),
        crisisEpisodeTypes: getDefaultCrisisEpisodeTypes(),
        languageMemory: sanitizeLanguageMemory(),
        academicPlanner: getDefaultAcademicPlanner()
    };
}

const SETTINGS_SECRET_PREFIX = 'pdh-s1:';

function getSettingsVaultKey() {
    const seed = String(process.env.SETTINGS_ENCRYPTION_KEY || process.env.DB_PASS || process.env.ADMIN_SECRET || 'pdh-local-settings-vault');
    return crypto.createHash('sha256').update(`pdh-settings-vault-v1:${seed}`).digest();
}

function encryptSettingSecretAtRest(plainText) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getSettingsVaultKey(), iv);
    const enc = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${SETTINGS_SECRET_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('base64')}`;
}

function decryptSettingSecretAtRest(storedValue) {
    if (!storedValue || typeof storedValue !== 'string') return '';
    if (!storedValue.startsWith(SETTINGS_SECRET_PREFIX)) {
        return serverNotesService.isValidJournalDownloadPassword(storedValue) ? storedValue : '';
    }
    const parts = storedValue.slice(SETTINGS_SECRET_PREFIX.length).split(':');
    if (parts.length !== 3) return '';
    try {
        const iv = Buffer.from(parts[0], 'hex');
        const tag = Buffer.from(parts[1], 'hex');
        const ct = Buffer.from(parts[2], 'base64');
        if (iv.length !== 12 || tag.length !== 16 || ct.length === 0) return '';
        const decipher = crypto.createDecipheriv('aes-256-gcm', getSettingsVaultKey(), iv);
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
        return serverNotesService.isValidJournalDownloadPassword(plain) ? plain : '';
    } catch (_) {
        return '';
    }
}

function resolveJournalDownloadPasswordFromSettings(settings = {}) {
    return decryptSettingSecretAtRest(settings?.journalDownloadPassword || '');
}

function maskGeminiApiKey(key) {
    const clean = String(key || '').trim();
    if (!clean) return '';
    if (clean.length <= 8) return '••••••••';
    return `${clean.slice(0, 4)}••••${clean.slice(-4)}`;
}

function sanitizeSettingsForClient(settings = {}) {
    const { geminiApiKey, journalDownloadPassword, ...rest } = settings;
    const hasUserKey = Boolean(String(geminiApiKey || '').trim());
    const hasEnvKey = Boolean(String(process.env.GEMINI_API_KEY || '').trim());
    const hasJournalDownloadPwd = Boolean(resolveJournalDownloadPasswordFromSettings({ journalDownloadPassword }));
    return {
        ...rest,
        uiLanguage: normalizeUiLang(rest.uiLanguage, 'en'),
        geminiApiKeyConfigured: hasUserKey || hasEnvKey,
        geminiKeySource: hasUserKey ? 'user' : (hasEnvKey ? 'server_env' : 'none'),
        geminiApiKeyHint: hasUserKey
            ? maskGeminiApiKey(geminiApiKey)
            : (hasEnvKey ? 'Server GEMINI_API_KEY active' : ''),
        journalDownloadPasswordConfigured: hasJournalDownloadPwd
    };
}

const publicizeUserSettings = sanitizeSettingsForClient;

function isBlockedPrivateHostname(hostname) {
    const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (!host) return true;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
        return true;
    }
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) {
        return true;
    }
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) {
        return true;
    }
    if (host === '::1' || /^(fe80:|fc|fd)/i.test(host)) {
        return true;
    }
    return false;
}

function validatePushServerUrl(rawUrl) {
    const raw = typeof rawUrl === 'string' && rawUrl.trim() ? rawUrl.trim() : 'https://ntfy.sh';
    let parsed;
    try {
        parsed = new URL(raw);
    } catch (_) {
        return { error: 'Notification server URL must be a valid HTTPS URL (e.g. https://ntfy.sh).' };
    }
    if (parsed.protocol !== 'https:') {
        return { error: 'Notification server URL must use HTTPS.' };
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        return { error: 'Notification server URL cannot include credentials, query strings, or fragments.' };
    }
    if (isBlockedPrivateHostname(parsed.hostname)) {
        return { error: 'Private or local network hosts are not allowed for notification relays.' };
    }
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    return { url: `${parsed.origin}${cleanPath}` };
}

function validateTimeZoneName(rawTz, fallbackTz) {
    const tz = typeof rawTz === 'string' && rawTz.trim() ? rawTz.trim() : fallbackTz;
    if (tz.length > 80) return null;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
        return tz;
    } catch (_) {
        return null;
    }
}

function validateUserSettingsPayload(input = {}, base = getDefaultUserSettings()) {
    const next = { ...base };
    next.uiLanguage = normalizeUiLang(base.uiLanguage, 'en');

    if (input.uiLanguage !== undefined) {
        if (!isValidStrictUiLang(input.uiLanguage)) {
            return { error: tServer('en', 'error.invalid_ui_language') };
        }
        next.uiLanguage = normalizeUiLang(input.uiLanguage);
    }

    if (input.defaultAgendaCategory !== undefined) {
        const val = String(input.defaultAgendaCategory).trim().toLowerCase();
        if (!['all', 'universidad', 'personal'].includes(val)) {
            return { error: 'Invalid default agenda category.' };
        }
        next.defaultAgendaCategory = val;
    }

    if (input.defaultAgendaLayout !== undefined) {
        const val = String(input.defaultAgendaLayout).trim().toLowerCase();
        if (!['auto', 'grid', 'day'].includes(val)) {
            return { error: 'Invalid default agenda layout.' };
        }
        next.defaultAgendaLayout = val;
    }
    if (input.youtubePlatformMode !== undefined) {
        const val = String(input.youtubePlatformMode).trim().toLowerCase();
        if (!['auto', 'youtube', 'yt_music'].includes(val)) {
            return { error: 'Invalid YouTube platform mode.' };
        }
        next.youtubePlatformMode = val;
    }

    const boolKeys = [
        'agendaShowWeekend',
        'phoneNotificationsEnabled',
        'desktopNotificationsEnabled',
        'moodRemindersEnabled',
        'moodNotifyPending',
        'moodIncludeLateNight',
        'sleepReminderEnabled',
        'agendaRemindersEnabled',
        'agendaNotifyEvents',
        'agendaNotifyTasks',
        'agendaNotifyPendingTasks',
        'commuteRemindersEnabled',
        'wordEodReminderEnabled',
        'englishReminderEnabled'
    ];
    for (const key of boolKeys) {
        if (input[key] !== undefined) {
            if (typeof input[key] !== 'boolean') {
                return { error: `Field ${key} must be a boolean.` };
            }
            next[key] = input[key];
        }
    }

    if (input.timezone !== undefined) {
        const validTz = validateTimeZoneName(input.timezone, base.timezone);
        if (!validTz) {
            return { error: 'Invalid IANA timezone (e.g. America/Monterrey).' };
        }
        next.timezone = validTz;
    }

    if (input.publicBaseUrl !== undefined) {
        const rawBase = String(input.publicBaseUrl || '').trim().replace(/\/+$/, '');
        if (rawBase && !/^https?:\/\/[a-zA-Z0-9.-]+(:\d{1,5})?$/.test(rawBase)) {
            return { error: 'App public URL must look like http://host:3000 or https://example.com.' };
        }
        next.publicBaseUrl = rawBase;
    }

    if (input.ntfyServerUrl !== undefined) {
        const urlCheck = validatePushServerUrl(input.ntfyServerUrl);
        if (urlCheck.error) return { error: urlCheck.error };
        next.ntfyServerUrl = urlCheck.url;
    }

    if (input.ntfyTopic !== undefined) {
        const topic = String(input.ntfyTopic || '').trim();
        if (topic && !/^[a-zA-Z0-9_-]{8,80}$/.test(topic)) {
            return { error: 'Phone notification topic must be 8–80 characters (letters, numbers, "_" or "-").' };
        }
        next.ntfyTopic = topic;
    }

    if (next.phoneNotificationsEnabled && !next.ntfyTopic) {
        return { error: 'Enter or generate a private ntfy topic before enabling phone notifications.' };
    }

    if (input.ntfyPriority !== undefined) {
        const prio = Number(input.ntfyPriority);
        if (!Number.isInteger(prio) || prio < 1 || prio > 5) {
            return { error: 'Notification priority must be an integer between 1 and 5.' };
        }
        next.ntfyPriority = prio;
    }

    const timeKeys = ['sleepReminderTime', 'sleepDesveloBedtimeTime', 'wordEodReminderTime', 'englishReminderTime'];
    for (const tKey of timeKeys) {
        if (input[tKey] !== undefined) {
            const tVal = String(input[tKey] || '').trim();
            if (!HHMM_REGEX.test(tVal)) {
                return { error: `Field ${tKey} must use HH:MM format (00:00 - 23:59).` };
            }
            next[tKey] = tVal;
        }
    }

    if (input.sleepMinNormalHours !== undefined) {
        const rawMin = input.sleepMinNormalHours;
        const minHrs = typeof rawMin === 'boolean' || rawMin === null || String(rawMin).trim() === ''
            ? NaN
            : Number(rawMin);
        if (!Number.isFinite(minHrs) || minHrs < 3 || minHrs > 12) {
            return { error: 'Minimum normal sleep hours must be between 3 and 12.' };
        }
        next.sleepMinNormalHours = Math.round(minHrs * 2) / 2;
    }

    if (input.agendaLeadMinutes !== undefined) {
        const mins = Number(input.agendaLeadMinutes);
        if (!Number.isInteger(mins) || mins < 0 || mins > 120) {
            return { error: 'Agenda lead minutes must be between 0 and 120.' };
        }
        next.agendaLeadMinutes = mins;
    }

    if (input.commuteExtraBufferMinutes !== undefined) {
        const rawBuf = input.commuteExtraBufferMinutes;
        const buf = typeof rawBuf === 'boolean' || rawBuf === null || String(rawBuf).trim() === ''
            ? NaN
            : Number(rawBuf);
        if (!Number.isInteger(buf) || buf < 5 || buf > 120) {
            return { error: 'Smart commute extra buffer minutes must be an integer between 5 and 120.' };
        }
        next.commuteExtraBufferMinutes = buf;
    }

    if (input.commuteRepeatEveryMinutes !== undefined) {
        const rawStep = input.commuteRepeatEveryMinutes;
        const stepVal = typeof rawStep === 'boolean' || rawStep === null || String(rawStep).trim() === ''
            ? NaN
            : Number(rawStep);
        if (!Number.isInteger(stepVal) || stepVal < 1 || stepVal > 30) {
            return { error: 'Smart commute repeat interval must be an integer between 1 and 30 minutes.' };
        }
        next.commuteRepeatEveryMinutes = stepVal;
    }

    if (input.commuteNearAlertMinutes !== undefined) {
        const nearParsed = normalizeNearAlertMinutes(input.commuteNearAlertMinutes, [20, 15, 10]);
        if (!nearParsed.valid) {
            return { error: 'Near-campus alert minutes must be a list of positive integers between 1 and 180 (e.g. 20, 15, 10).' };
        }
        next.commuteNearAlertMinutes = nearParsed.values;
    }

    if (input.commuteNearRadiusKm !== undefined) {
        const rawRad = input.commuteNearRadiusKm;
        const rad = typeof rawRad === 'boolean' || rawRad === null || String(rawRad).trim() === ''
            ? NaN
            : Number(rawRad);
        if (!Number.isFinite(rad) || rad < 0.05 || rad > 10) {
            return { error: 'Proximity radius must be between 0.05 and 10 km.' };
        }
        next.commuteNearRadiusKm = Number(rad.toFixed(2));
    }

    if (input.englishReminderDays !== undefined) {
        if (!Array.isArray(input.englishReminderDays)) {
            return { error: 'English study days must be an array of weekday numbers (0-6).' };
        }
        const uniqueDays = Array.from(new Set(input.englishReminderDays.map(Number)));
        if (uniqueDays.some(d => !Number.isInteger(d) || d < 0 || d > 6)) {
            return { error: 'English study days must contain integers from 0 (Sun) to 6 (Sat).' };
        }
        next.englishReminderDays = uniqueDays.sort((a, b) => a - b);
    }

    if (input.englishReminderTopic !== undefined) {
        const topicText = String(input.englishReminderTopic || '').trim();
        if (topicText.length > 200) {
            return { error: 'English study reminder note cannot exceed 200 characters.' };
        }
        next.englishReminderTopic = topicText || getDefaultUserSettings().englishReminderTopic;
    }

    if (input.preferredStudyLanguage !== undefined) {
        next.preferredStudyLanguage = normalizeStudyLanguage(input.preferredStudyLanguage);
    }

    if (input.geminiModel !== undefined) {
        next.geminiModel = validateGeminiModelId(input.geminiModel);
    }

    if (input.clearGeminiApiKey === true) {
        next.geminiApiKey = '';
    } else if (input.geminiApiKey !== undefined) {
        const rawKey = String(input.geminiApiKey || '').trim();
        if (rawKey.length > 180) {
            return { error: 'Gemini API key exceeds maximum allowed length (180 characters).' };
        }
        next.geminiApiKey = rawKey;
    }

    if (input.clearJournalDownloadPassword === true) {
        next.journalDownloadPassword = '';
    } else if (input.journalDownloadPassword !== undefined) {
        if (typeof input.journalDownloadPassword !== 'string') {
            return { error: 'Journal download password must be a valid string (8–128 characters).' };
        }
        const rawDlPwd = input.journalDownloadPassword;
        if (rawDlPwd === '') {
            next.journalDownloadPassword = base.journalDownloadPassword || '';
        } else if (rawDlPwd.startsWith(SETTINGS_SECRET_PREFIX)) {
            next.journalDownloadPassword = decryptSettingSecretAtRest(rawDlPwd) ? rawDlPwd : '';
        } else {
            if (!serverNotesService.isValidJournalDownloadPassword(rawDlPwd)) {
                return { error: 'Journal download password must be 8–128 characters without control characters.' };
            }
            next.journalDownloadPassword = encryptSettingSecretAtRest(rawDlPwd);
        }
    }

    if (input.studyDriveSyncEnabled !== undefined) {
        next.studyDriveSyncEnabled = Boolean(input.studyDriveSyncEnabled);
    }
    if (typeof input.studyDriveFolder === 'string') {
        const cleanFolder = input.studyDriveFolder.trim().replace(/[\\:*?"<>|]/g, '').slice(0, 80);
        if (cleanFolder) next.studyDriveFolder = cleanFolder;
    }

    if (input.crisisEpisodeTypes !== undefined) {
        if (!Array.isArray(input.crisisEpisodeTypes)) {
            return { error: 'Crisis episode types must be an array.' };
        }
        if (input.crisisEpisodeTypes.length > 25) {
            return { error: 'Maximum 25 crisis episode types allowed.' };
        }
        const cleanedTypes = sanitizeCrisisEpisodeTypes(input.crisisEpisodeTypes, []);
        if (cleanedTypes.length === 0) {
            return { error: 'At least 1 valid crisis episode type (2-60 chars) is required.' };
        }
        next.crisisEpisodeTypes = cleanedTypes;
    } else {
        next.crisisEpisodeTypes = sanitizeCrisisEpisodeTypes(base.crisisEpisodeTypes, getDefaultCrisisEpisodeTypes());
    }

    if (input.languageMemory !== undefined) {
        next.languageMemory = sanitizeLanguageMemory(input.languageMemory);
    } else {
        next.languageMemory = sanitizeLanguageMemory(base.languageMemory);
    }

    if (input.academicPlanner !== undefined) {
        next.academicPlanner = sanitizeAcademicPlanner(input.academicPlanner, base.academicPlanner);
        if (input.commuteRemindersEnabled === undefined) {
            next.commuteRemindersEnabled = next.academicPlanner.classRemindersEnabled !== false;
        }
        if (input.commuteExtraBufferMinutes === undefined) {
            next.commuteExtraBufferMinutes = next.academicPlanner.commuteExtraBufferMinutes;
        }
        if (input.commuteRepeatEveryMinutes === undefined) {
            next.commuteRepeatEveryMinutes = next.academicPlanner.commuteRepeatEveryMinutes;
        }
        if (input.commuteNearAlertMinutes === undefined) {
            next.commuteNearAlertMinutes = next.academicPlanner.commuteNearAlertMinutes;
        }
        if (input.commuteNearRadiusKm === undefined) {
            next.commuteNearRadiusKm = next.academicPlanner.nearRadiusKm;
        }
    } else {
        next.academicPlanner = sanitizeAcademicPlanner(base.academicPlanner);
    }

    if (input.commuteRemindersEnabled !== undefined) {
        next.academicPlanner.classRemindersEnabled = next.commuteRemindersEnabled;
    } else {
        next.commuteRemindersEnabled = next.academicPlanner.classRemindersEnabled !== false;
    }
    if (input.commuteExtraBufferMinutes !== undefined) {
        next.academicPlanner.commuteExtraBufferMinutes = next.commuteExtraBufferMinutes;
        next.academicPlanner.farLeadMinutesMin = next.commuteExtraBufferMinutes;
    } else {
        next.commuteExtraBufferMinutes = next.academicPlanner.commuteExtraBufferMinutes ?? 30;
    }
    if (input.commuteRepeatEveryMinutes !== undefined) {
        next.academicPlanner.commuteRepeatEveryMinutes = next.commuteRepeatEveryMinutes;
    } else {
        next.commuteRepeatEveryMinutes = next.academicPlanner.commuteRepeatEveryMinutes ?? 5;
    }
    if (input.commuteNearAlertMinutes !== undefined) {
        next.academicPlanner.commuteNearAlertMinutes = [...next.commuteNearAlertMinutes];
    } else {
        next.commuteNearAlertMinutes = Array.isArray(next.academicPlanner.commuteNearAlertMinutes)
            ? [...next.academicPlanner.commuteNearAlertMinutes]
            : [20, 15, 10];
    }
    if (input.commuteNearRadiusKm !== undefined) {
        next.academicPlanner.nearRadiusKm = next.commuteNearRadiusKm;
        next.academicPlanner.commuteNearRadiusKm = next.commuteNearRadiusKm;
    } else {
        next.commuteNearRadiusKm = next.academicPlanner.nearRadiusKm ?? 0.5;
    }

    return { settings: next };
}

function sanitizeUserSettings(input = {}, base = getDefaultUserSettings()) {
    const res = validateUserSettingsPayload(input, base);
    return res.settings || { ...getDefaultUserSettings(), ...base };
}

async function loadUserSettings(userId) {
    const defaults = getDefaultUserSettings();
    const rows = await dbQueryAsync('SELECT config_json FROM ConfiguracionUsuario WHERE usuario_id = ? LIMIT 1', [userId]);
    if (!rows || rows.length === 0 || !rows[0].config_json) {
        return defaults;
    }
    try {
        const parsed = typeof rows[0].config_json === 'string'
            ? JSON.parse(rows[0].config_json)
            : rows[0].config_json;
        const validated = validateUserSettingsPayload(parsed, defaults);
        return validated.settings || defaults;
    } catch (_) {
        return defaults;
    }
}

async function saveUserSettings(userId, settings) {
    const jsonText = JSON.stringify(settings);
    await dbQueryAsync(
        `INSERT INTO ConfiguracionUsuario (usuario_id, config_json)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE config_json = VALUES(config_json)`,
        [userId, jsonText]
    );
}

function getLocalNowParts(timeZone) {
    const safeTz = validateTimeZoneName(timeZone, process.env.TZ || 'America/Monterrey') || 'UTC';
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: safeTz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).formatToParts(now);

    const map = {};
    parts.forEach(p => {
        map[p.type] = p.value;
    });
    const hourNum = Number(map.hour) % 24;
    const minNum = Number(map.minute) || 0;
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
        dateStr: `${map.year}-${map.month}-${map.day}`,
        weekday: dayMap[map.weekday] !== undefined ? dayMap[map.weekday] : now.getDay(),
        hhmm: `${String(hourNum).padStart(2, '0')}:${String(minNum).padStart(2, '0')}`,
        minutesOfDay: hourNum * 60 + minNum,
        timeZone: safeTz,
        nowMs: now.getTime()
    };
}

function hhmmToMinutes(hhmm) {
    const [h, m] = String(hhmm || '00:00').split(':').map(Number);
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

const MOOD_REMINDER_WINDOWS = [
    { key: 'Morning', label: 'Morning', triggerMin: 9 * 60, startMin: 6 * 60, endMin: 12 * 60, optional: false },
    { key: 'Noon', label: 'Noon', triggerMin: 13 * 60, startMin: 12 * 60, endMin: 14 * 60, optional: false },
    { key: 'Afternoon', label: 'Afternoon', triggerMin: 17 * 60, startMin: 14 * 60, endMin: 20 * 60, optional: false },
    { key: 'Night', label: 'Night', triggerMin: 22 * 60, startMin: 20 * 60, endMin: 24 * 60, optional: false },
    { key: 'Madrugada', label: 'Late Night', triggerMin: 3 * 60, startMin: 0, endMin: 6 * 60, optional: true }
];

function isDateInVacation(dateStr, vacations = []) {
    if (!Array.isArray(vacations)) return null;
    return vacations.find(v => v && v.startDate && v.endDate && dateStr >= v.startDate && dateStr <= v.endDate) || null;
}

function resolveUserOriginCoords(planner, isFirstClassOrShift = true) {
    const curr = parseCoordinatesFromInput(planner?.locations?.current || {});
    const home = parseCoordinatesFromInput(planner?.locations?.home || {});
    const campusDir = getEffectiveCampusDirectory(planner);
    const uni = parseCoordinatesFromInput(planner?.locations?.university || {}) || {
        lat: campusDir.principal.lat,
        lng: campusDir.principal.lng
    };

    if (curr) {
        return { coords: curr, sourceLabel: planner?.locations?.current?.label || 'tu ubicación GPS actual' };
    }
    if (isFirstClassOrShift && home) {
        return { coords: home, sourceLabel: planner?.locations?.home?.label || 'tu Casa' };
    }
    if (!isFirstClassOrShift) {
        return { coords: uni, sourceLabel: 'Campus ITS' };
    }
    return { coords: home || null, sourceLabel: home ? 'tu Casa' : 'tu ubicación' };
}

function computeCandidateReminders({
    settings,
    localNow,
    lang = null,
    moodLogsToday = [],
    sleepLogsToday = [],
    agendaItemsToday = [],
    pendingTasksWeek = [],
    inProgressItems = [],
    queueCounts = { journal: 0, english: 0 }
}) {
    const uiLang = normalizeUiLang(lang || settings?.uiLanguage, 'en');
    const candidates = [];
    const { dateStr, weekday, minutesOfDay } = localNow;
    const attachMeta = (item) => {
        const actions = [];
        if (item.ackKey || ['class', 'residencias', 'work'].includes(item.type)) {
            actions.push({ id: 'ack', label: tServer(uiLang, 'action.ok') });
        }
        if (item.canComplete && item.refId) {
            actions.push({ id: 'complete', label: tServer(uiLang, 'action.mark_done') });
        }
        if (item.canSnooze) {
            actions.push(
                { id: 'snooze_15', label: tServer(uiLang, 'action.snooze_15m'), minutes: 15 },
                { id: 'snooze_30', label: tServer(uiLang, 'action.snooze_30m'), minutes: 30 },
                { id: 'snooze_60', label: tServer(uiLang, 'action.snooze_1h'), minutes: 60 }
            );
        }
        actions.push({
            id: 'dismiss',
            label: String(item.key || '').startsWith('task-inprog:')
                ? tServer(uiLang, 'action.ok_dismiss')
                : tServer(uiLang, 'action.dismiss')
        });
        return {
            ...item,
            lang: uiLang,
            categoryLabel: getReminderCategoryLabel(uiLang, item.type),
            actions
        };
    };

    // 1. Automatic Mood Tracker mid-window reminders + Pending earlier mood check-ins
    if (settings.moodRemindersEnabled) {
        const loggedMoments = new Set(moodLogsToday.map(r => r.momento_dia));
        const activeWin = MOOD_REMINDER_WINDOWS.find(w =>
            minutesOfDay >= w.startMin &&
            minutesOfDay < w.endMin &&
            (!w.optional || settings.moodIncludeLateNight)
        );
        if (activeWin && minutesOfDay >= activeWin.triggerMin && !loggedMoments.has(activeWin.key)) {
            const locMoment = tServer(uiLang, `mood.moment.${activeWin.key}`);
            candidates.push(attachMeta({
                key: `mood:${dateStr}:${activeWin.key}`,
                type: 'mood',
                refId: null,
                title: tServer(uiLang, 'mood.mid_title', { moment: locMoment }),
                message: tServer(uiLang, 'mood.mid_message', { momentLower: locMoment.toLowerCase() }),
                targetView: 'mood',
                targetDate: dateStr,
                targetMoment: activeWin.key,
                pendingMoments: [activeWin.key],
                canSnooze: true,
                canComplete: false
            }));
        }

        if (settings.moodNotifyPending !== false) {
            const missedWindows = MOOD_REMINDER_WINDOWS.filter(w =>
                minutesOfDay >= w.endMin &&
                (!w.optional || settings.moodIncludeLateNight) &&
                !loggedMoments.has(w.key)
            );
            if (missedWindows.length > 0) {
                const missedLabels = missedWindows.map(w => tServer(uiLang, `mood.moment.${w.key}`)).join(', ');
                const firstMissed = missedWindows[0];
                const latestMissed = missedWindows[missedWindows.length - 1];
                candidates.push(attachMeta({
                    key: `mood-pending:${dateStr}:${latestMissed.key}`,
                    type: 'mood',
                    refId: null,
                    title: tServer(uiLang, 'mood.pending_title', { moments: missedLabels }),
                    message: tServer(uiLang, 'mood.pending_message', { moments: missedLabels }),
                    targetView: 'mood',
                    targetDate: dateStr,
                    targetMoment: firstMissed.key,
                    pendingMoments: missedWindows.map(w => w.key),
                    canSnooze: true,
                    canComplete: false
                }));
            }
        }
    }

    // 2. Sleep Tracker morning reminder (with Postpone/Snooze + Pending Wake-up support)
    if (settings.sleepReminderEnabled) {
        const sleepStartMin = hhmmToMinutes(settings.sleepReminderTime);
        const allSleepRows = Array.isArray(sleepLogsToday) ? sleepLogsToday : [];
        const todayRows = allSleepRows.filter(r => !r.fecha || String(r.fecha).slice(0, 10) === dateStr);
        const todayNonNapRows = todayRows.filter(r => r.tipo_registro !== 'siesta');

        const isPendingRow = (r) => Boolean(r && r.hora_dormir)
            && !r.hora_despertar
            && (Number(r.horas) || 0) === 0
            && r.tipo_registro !== 'desvelo_total'
            && r.tipo_registro !== 'siesta';

        const hasCompletedOrAllNighter = todayNonNapRows.some(r =>
            Number(r.horas) > 0 ||
            Boolean(r.hora_despertar) ||
            r.tipo_registro === 'desvelo_total' ||
            (r.id && r.horas === undefined && r.tipo_registro === undefined)
        );

        const sortedSleepRows = [...allSleepRows].sort((a, b) => {
            const fa = String(a?.fecha || dateStr).slice(0, 10);
            const fb = String(b?.fecha || dateStr).slice(0, 10);
            if (fa !== fb) return fb.localeCompare(fa);
            return (Number(b?.id) || 0) - (Number(a?.id) || 0);
        });

        const pendingBedtimeRow = !hasCompletedOrAllNighter
            ? sortedSleepRows.find(isPendingRow)
            : null;

        if (minutesOfDay >= sleepStartMin && minutesOfDay < 14 * 60) {
            if (pendingBedtimeRow) {
                const isDesveloPending = Number(pendingBedtimeRow.es_desvelo) === 1 || pendingBedtimeRow.tipo_registro === 'desvelo_tarde';
                const targetDateVal = pendingBedtimeRow.fecha ? String(pendingBedtimeRow.fecha).slice(0, 10) : dateStr;
                candidates.push(attachMeta({
                    key: `sleep-wakeup:${dateStr}`,
                    type: 'sleep',
                    refId: pendingBedtimeRow.id || null,
                    title: tServer(uiLang, 'sleep.wakeup_title'),
                    message: tServer(
                        uiLang,
                        isDesveloPending ? 'sleep.wakeup_desvelo_message' : 'sleep.wakeup_normal_message',
                        { bedtime: pendingBedtimeRow.hora_dormir }
                    ),
                    targetView: 'sueno',
                    targetDate: targetDateVal,
                    canSnooze: true,
                    canComplete: false
                }));
            } else if (todayNonNapRows.length === 0) {
                candidates.push(attachMeta({
                    key: `sleep:${dateStr}`,
                    type: 'sleep',
                    refId: null,
                    title: tServer(uiLang, 'sleep.morning_title'),
                    message: tServer(uiLang, 'sleep.morning_message'),
                    targetView: 'sueno',
                    targetDate: dateStr,
                    canSnooze: true,
                    canComplete: false
                }));
            }
        }
    }

    // 3. Weekly Agenda Events & Tasks reminders (University / Personal) + Pending Tasks
    if (settings.agendaRemindersEnabled) {
        const notifiedTaskIds = new Set();

        agendaItemsToday.forEach(item => {
            const estado = normalizeAgendaStatusInput(item.estado) || (Number(item.completada) === 1 ? 'done' : 'todo');
            if (estado === 'done' || estado === 'skipped' || estado === 'in_progress' || Number(item.completada) === 1) return;

            const tipo = item.tipo === 'tarea' ? 'tarea' : 'evento';
            if (tipo === 'evento' && !settings.agendaNotifyEvents) return;
            if (tipo === 'tarea' && !settings.agendaNotifyTasks) return;

            const itemLead = item.recordatorio_min !== null && item.recordatorio_min !== undefined
                ? Number(item.recordatorio_min)
                : Number(settings.agendaLeadMinutes || 10);
            if (itemLead < 0) return;

            const itemMin = hhmmToMinutes(item.hora);
            const triggerMin = Math.max(0, itemMin - itemLead);
            const windowEndMin = tipo === 'tarea' ? 1439 : Math.min(1439, itemMin + 120);

            if (minutesOfDay >= triggerMin && minutesOfDay <= windowEndMin) {
                const catLabel = item.categoria === 'universidad'
                    ? (item.materia_nombre ? String(item.materia_nombre).trim() : tServer(uiLang, 'agenda.cat.universidad'))
                    : tServer(uiLang, 'agenda.cat.personal');
                const isOverdueToday = tipo === 'tarea' && minutesOfDay > itemMin + 30;
                const typeLabel = tipo === 'tarea'
                    ? tServer(uiLang, isOverdueToday ? 'agenda.type.pending_task' : 'agenda.type.task')
                    : tServer(uiLang, 'agenda.type.event');
                if (tipo === 'tarea') notifiedTaskIds.add(Number(item.id));
                const suffix = itemLead > 0 && minutesOfDay < itemMin
                    ? tServer(uiLang, 'agenda.starts_at_suffix', { time: item.hora })
                    : (isOverdueToday ? tServer(uiLang, 'agenda.overdue_suffix') : '');
                candidates.push(attachMeta({
                    key: `agenda:${item.id}:${dateStr}`,
                    type: 'agenda',
                    refId: item.id,
                    title: tServer(uiLang, 'agenda.item_title', { category: catLabel, typeLabel, time: item.hora }),
                    message: `${item.actividad}${suffix}`,
                    targetView: 'agenda',
                    targetDate: item.fecha || dateStr,
                    targetTime: item.hora || '',
                    targetBlock: item.bloque || '',
                    canSnooze: true,
                    canComplete: true
                }));
            }
        });

        if (settings.agendaNotifyTasks && settings.agendaNotifyPendingTasks !== false && Array.isArray(pendingTasksWeek)) {
            pendingTasksWeek.forEach(task => {
                const estado = normalizeAgendaStatusInput(task.estado) || (Number(task.completada) === 1 ? 'done' : 'todo');
                if (estado === 'done' || estado === 'skipped' || estado === 'in_progress' || Number(task.completada) === 1) return;
                if ((task.tipo || 'evento') !== 'tarea') return;
                if (notifiedTaskIds.has(Number(task.id))) return;
                if (task.recordatorio_min !== null && task.recordatorio_min !== undefined && Number(task.recordatorio_min) < 0) return;

                const isPastDay = task.fecha && task.fecha < dateStr;
                const taskMin = hhmmToMinutes(task.hora || '09:00');
                if (!isPastDay && minutesOfDay < taskMin) return;

                const catLabel = task.categoria === 'universidad'
                    ? (task.materia_nombre ? String(task.materia_nombre).trim() : tServer(uiLang, 'agenda.cat.universidad'))
                    : tServer(uiLang, 'agenda.cat.personal');
                candidates.push(attachMeta({
                    key: `task-pending:${task.id}:${dateStr}`,
                    type: 'agenda',
                    refId: task.id,
                    title: tServer(uiLang, 'agenda.pending_title', { category: catLabel, when: task.fecha === dateStr ? task.hora : task.fecha }),
                    message: tServer(uiLang, 'agenda.pending_message', { activity: task.actividad }),
                    targetView: 'agenda',
                    targetDate: task.fecha || dateStr,
                    targetTime: task.hora || '',
                    targetBlock: task.bloque || '',
                    canSnooze: true,
                    canComplete: true
                }));
            });
        }

        // 3b. In-progress (En progreso) follow-up: silent for first 60 min, single follow-up at >= 1 hour
        const inProgressMap = new Map();
        [...(Array.isArray(inProgressItems) ? inProgressItems : []), ...agendaItemsToday, ...(Array.isArray(pendingTasksWeek) ? pendingTasksWeek : [])].forEach(it => {
            if (!it || !it.id) return;
            const st = normalizeAgendaStatusInput(it.estado) || (Number(it.completada) === 1 ? 'done' : 'todo');
            if (st !== 'in_progress' || Number(it.completada) === 1) return;
            if (!inProgressMap.has(Number(it.id))) {
                inProgressMap.set(Number(it.id), it);
            }
        });
        const evalNowMs = Number.isFinite(localNow?.nowMs) ? localNow.nowMs : Date.now();
        for (const item of inProgressMap.values()) {
            const tipo = item.tipo === 'tarea' ? 'tarea' : 'evento';
            if (tipo === 'evento' && !settings.agendaNotifyEvents) continue;
            if (tipo === 'tarea' && !settings.agendaNotifyTasks) continue;
            if (item.recordatorio_min !== null && item.recordatorio_min !== undefined && Number(item.recordatorio_min) < 0) continue;

            const enProgresoDesdeMs = parseServerDateTimeMs(item.en_progreso_desde);
            if (!Number.isFinite(enProgresoDesdeMs)) continue;
            if ((evalNowMs - enProgresoDesdeMs) < 60 * 60 * 1000) continue;

            const cycleSec = Math.floor(enProgresoDesdeMs / 1000);
            const followUpKey = `task-inprog:${item.id}:${cycleSec}`;
            const actText = String(item.actividad || tServer(uiLang, 'agenda.default_task_name')).trim();
            candidates.push(attachMeta({
                key: followUpKey,
                type: 'agenda',
                isInProgressFollowUp: true,
                refId: item.id,
                title: tServer(uiLang, 'agenda.in_progress_title', { activity: actText.slice(0, 95) }),
                message: tServer(uiLang, 'agenda.in_progress_message', { activity: actText }),
                targetView: 'agenda',
                targetDate: item.fecha || dateStr,
                targetTime: item.hora || '',
                targetBlock: item.bloque || '',
                canSnooze: true,
                canComplete: true
            }));
        }
    }

    // 4. Smart Academic Semester Classes (Tec de Saltillo), Residencias & Work Schedule Commute Alerts
    const planner = sanitizeAcademicPlanner(settings.academicPlanner);
    const effectiveCampusDir = getEffectiveCampusDirectory(planner);
    const activeVacation = isDateInVacation(dateStr, planner.vacations);
    const savedHomeCoords = parseCoordinatesFromInput(planner.locations?.home || {});
    const liveCurrCoords = parseCoordinatesFromInput(planner.locations?.current || {});
    const hasLiveGps = Boolean(liveCurrCoords);
    const commuteEnabled = settings.commuteRemindersEnabled !== undefined
        ? Boolean(settings.commuteRemindersEnabled)
        : (planner.classRemindersEnabled !== false);
    const effExtraBufferMin = settings.commuteExtraBufferMinutes ?? planner.commuteExtraBufferMinutes ?? 30;
    const effRepeatEveryMin = settings.commuteRepeatEveryMinutes ?? planner.commuteRepeatEveryMinutes ?? 5;
    const effNearAlertMins = settings.commuteNearAlertMinutes ?? planner.commuteNearAlertMinutes ?? [20, 15, 10];
    const effNearRadiusKm = settings.commuteNearRadiusKm ?? planner.nearRadiusKm ?? 0.5;

    if (commuteEnabled && !activeVacation) {
        const activeSem = planner.semesters.find(s => s.id === planner.activeSemesterId) ||
                          planner.semesters.find(s => s.active) ||
                          planner.semesters[0];

        if (activeSem && dateStr >= activeSem.startDate && dateStr <= activeSem.endDate) {
            const todaysCourses = (activeSem.courses || [])
                .filter(c => c && !c.remindersPaused && !c.completed && Array.isArray(c.days) && c.days.includes(weekday))
                .sort((a, b) => hhmmToMinutes(a.startTime) - hhmmToMinutes(b.startTime));

            todaysCourses.forEach((course, idx) => {
                const startMin = hhmmToMinutes(course.startTime);
                const prevCourse = idx > 0 ? todaysCourses[idx - 1] : null;
                const prevEndMin = prevCourse ? hhmmToMinutes(prevCourse.endTime) : -999;
                const isFirstOrAfterLongBreak = idx === 0 || (startMin - prevEndMin >= 120);

                const roomMeta = resolveItsClassroom(course.room, effectiveCampusDir);
                const prevRoomMeta = prevCourse ? resolveItsClassroom(prevCourse.room, effectiveCampusDir) : null;

                let originInfo;
                if (!isFirstOrAfterLongBreak && prevRoomMeta && !liveCurrCoords) {
                    originInfo = {
                        coords: { lat: prevRoomMeta.lat, lng: prevRoomMeta.lng },
                        sourceLabel: tServer(uiLang, 'commute.origin_room', { room: prevRoomMeta.room, campus: prevRoomMeta.campusName })
                    };
                } else {
                    const rawOrigin = resolveUserOriginCoords(planner, isFirstOrAfterLongBreak);
                    originInfo = {
                        coords: rawOrigin.coords,
                        sourceLabel: localizeOriginLabel(uiLang, rawOrigin.sourceLabel)
                    };
                }

                const commute = estimateCommuteDetails({
                    originCoords: originInfo.coords,
                    homeCoords: savedHomeCoords,
                    destCoords: { lat: roomMeta.lat, lng: roomMeta.lng },
                    targetMinutesOfDay: startMin,
                    weekday,
                    isFirstOfDay: isFirstOrAfterLongBreak,
                    nearRadiusKm: effNearRadiusKm,
                    extraBufferMinutes: effExtraBufferMin,
                    repeatEveryMinutes: effRepeatEveryMin,
                    nearAlertMinutes: effNearAlertMins,
                    hasLiveGps
                });

                const milestones = commute.alertMilestones || [commute.recommendedLeadMinutes];
                const activeStageMin = pickActiveCommuteMilestone(startMin, minutesOfDay, milestones, 0);

                if (activeStageMin !== null) {
                    const seriesKey = `class:${activeSem.id}:${course.id}:${dateStr}`;
                    const locTraffic = localizeTrafficLabel(uiLang, commute.trafficLabel);
                    const locBuilding = localizeItsBuildingLabel(uiLang, roomMeta.building);
                    const routeSummary = commute.isNear
                        ? tServer(uiLang, 'commute.route_near', { walkMin: commute.walkMinutes, origin: originInfo.sourceLabel })
                        : tServer(uiLang, 'commute.route_drive', {
                            origin: originInfo.sourceLabel,
                            driveMin: commute.driveMinutes,
                            traffic: locTraffic,
                            distanceKm: commute.roadDistanceKm || '--'
                        });

                    candidates.push(attachMeta({
                        key: `${seriesKey}:m${activeStageMin}`,
                        seriesKey,
                        ackKey: seriesKey,
                        stageMin: activeStageMin,
                        milestones,
                        commuteZone: commute.commuteZone,
                        type: 'class',
                        refId: null,
                        title: tServer(uiLang, 'commute.class_title', { time: course.startTime, course: course.name, room: roomMeta.room }),
                        message: tServer(uiLang, 'commute.class_message', {
                            campus: roomMeta.campusName,
                            plano: roomMeta.plano,
                            building: locBuilding,
                            route: routeSummary,
                            stageMin: activeStageMin
                        }),
                        targetView: 'horario',
                        targetTab: 'semesters',
                        targetDate: dateStr,
                        mapsUrl: commute.mapsUrl,
                        canSnooze: true,
                        canComplete: false
                    }));
                }
            });
        }
    }

    if (planner.residencias && planner.residencias.enabled && Array.isArray(planner.residencias.days) && planner.residencias.days.includes(weekday)) {
        const resStartMin = hhmmToMinutes(planner.residencias.startTime);
        const destCoords = parseCoordinatesFromInput(planner.residencias.location || {}) || {
            lat: effectiveCampusDir.principal.lat,
            lng: effectiveCampusDir.principal.lng
        };
        const originInfo = resolveUserOriginCoords(planner, true);
        const commute = estimateCommuteDetails({
            originCoords: originInfo.coords,
            homeCoords: savedHomeCoords,
            destCoords,
            targetMinutesOfDay: resStartMin,
            weekday,
            isFirstOfDay: true,
            nearRadiusKm: effNearRadiusKm,
            extraBufferMinutes: effExtraBufferMin,
            repeatEveryMinutes: effRepeatEveryMin,
            nearAlertMinutes: effNearAlertMins,
            hasLiveGps
        });
        const isRemoteRes = planner.residencias.modality === 'remoto';
        const milestones = isRemoteRes ? [10] : (commute.alertMilestones || [commute.recommendedLeadMinutes]);
        const activeStageMin = pickActiveCommuteMilestone(resStartMin, minutesOfDay, milestones, 0);

        if (activeStageMin !== null) {
            const seriesKey = `residencias:${dateStr}:${planner.residencias.startTime}`;
            const rawPlace = planner.residencias.companyName || planner.residencias.location?.label || '';
            const placeLabel = rawPlace && rawPlace !== 'Empresa de Residencias'
                ? rawPlace
                : tServer(uiLang, 'commute.residencias_default_place');
            const locTraffic = localizeTrafficLabel(uiLang, commute.trafficLabel);
            const transitText = isRemoteRes
                ? tServer(uiLang, 'commute.residencias_remote')
                : (commute.isNear
                    ? tServer(uiLang, 'commute.residencias_near', { place: placeLabel, walkMin: commute.walkMinutes, stageMin: activeStageMin })
                    : tServer(uiLang, 'commute.residencias_drive', {
                        driveMin: commute.driveMinutes,
                        traffic: locTraffic,
                        place: placeLabel,
                        stageMin: activeStageMin
                    }));
            candidates.push(attachMeta({
                key: `${seriesKey}:m${activeStageMin}`,
                seriesKey,
                ackKey: seriesKey,
                stageMin: activeStageMin,
                milestones,
                commuteZone: isRemoteRes ? 'remote' : commute.commuteZone,
                type: 'residencias',
                refId: null,
                title: tServer(uiLang, 'commute.residencias_title', { time: planner.residencias.startTime, place: placeLabel }),
                message: `${planner.residencias.projectName ? `${planner.residencias.projectName}. ` : ''}${transitText}`,
                targetView: 'horario',
                targetTab: 'residencias',
                targetDate: dateStr,
                mapsUrl: isRemoteRes ? '' : commute.mapsUrl,
                canSnooze: true,
                canComplete: false
            }));
        }
    }

    if (planner.work && planner.work.enabled && Array.isArray(planner.work.days) && planner.work.days.includes(weekday)) {
        const workStartMin = hhmmToMinutes(planner.work.startTime);
        const destCoords = parseCoordinatesFromInput(planner.work.location || {});
        const originInfo = resolveUserOriginCoords(planner, true);
        const commute = estimateCommuteDetails({
            originCoords: originInfo.coords,
            homeCoords: savedHomeCoords,
            destCoords,
            targetMinutesOfDay: workStartMin,
            weekday,
            isFirstOfDay: true,
            nearRadiusKm: effNearRadiusKm,
            extraBufferMinutes: effExtraBufferMin,
            repeatEveryMinutes: effRepeatEveryMin,
            nearAlertMinutes: effNearAlertMins,
            hasLiveGps
        });
        const isRemoteWork = planner.work.modality === 'remoto';
        const milestones = isRemoteWork ? [10] : (commute.alertMilestones || [commute.recommendedLeadMinutes]);
        const activeStageMin = pickActiveCommuteMilestone(workStartMin, minutesOfDay, milestones, 0);

        if (activeStageMin !== null) {
            const seriesKey = `work:${dateStr}:${planner.work.startTime}`;
            const shiftKey = planner.work.scheduleType === 'tiempo_completo'
                ? 'commute.work_shift_full'
                : (planner.work.scheduleType === 'por_turnos' ? 'commute.work_shift_rot' : 'commute.work_shift_part');
            const shiftTypeLabel = tServer(uiLang, shiftKey);
            const rawComp = planner.work.companyName || planner.work.location?.label || '';
            const companyLabel = rawComp && rawComp !== 'Lugar de Trabajo'
                ? rawComp
                : tServer(uiLang, 'commute.work_default_place');
            const locTraffic = localizeTrafficLabel(uiLang, commute.trafficLabel);
            const transitText = isRemoteWork
                ? tServer(uiLang, 'commute.work_remote')
                : (commute.isNear
                    ? tServer(uiLang, 'commute.work_near', { company: companyLabel, walkMin: commute.walkMinutes, stageMin: activeStageMin })
                    : tServer(uiLang, 'commute.work_drive', {
                        driveMin: commute.driveMinutes,
                        traffic: locTraffic,
                        company: companyLabel,
                        stageMin: activeStageMin
                    }));
            candidates.push(attachMeta({
                key: `${seriesKey}:m${activeStageMin}`,
                seriesKey,
                ackKey: seriesKey,
                stageMin: activeStageMin,
                milestones,
                commuteZone: isRemoteWork ? 'remote' : commute.commuteZone,
                type: 'work',
                refId: null,
                title: tServer(uiLang, 'commute.work_title', { shiftType: shiftTypeLabel, time: planner.work.startTime, company: companyLabel }),
                message: `${planner.work.roleTitle ? `${planner.work.roleTitle} — ` : ''}${transitText}`,
                targetView: 'horario',
                targetTab: 'work',
                targetDate: dateStr,
                mapsUrl: isRemoteWork ? '' : commute.mapsUrl,
                canSnooze: true,
                canComplete: false
            }));
        }
    }

    // 5. End-of-day Word Notes check reminder
    if (settings.wordEodReminderEnabled) {
        const wordMin = hhmmToMinutes(settings.wordEodReminderTime);
        if (minutesOfDay >= wordMin) {
            const jCnt = Number(queueCounts.journal || 0);
            const eCnt = Number(queueCounts.english || 0);
            const pendingTotal = jCnt + eCnt;
            const wordMsg = pendingTotal > 0
                ? tServer(uiLang, 'word.eod_pending_message', { journalCount: jCnt, englishCount: eCnt })
                : tServer(uiLang, 'word.eod_clear_message');
            candidates.push(attachMeta({
                key: `word:${dateStr}`,
                type: 'word',
                refId: null,
                title: tServer(uiLang, 'word.eod_title'),
                message: wordMsg,
                targetView: pendingTotal > 0 ? 'journal' : 'english',
                canSnooze: true,
                canComplete: false
            }));
        }
    }

    // 6. Configurable Language Study reminder (OFF by default!)
    if (settings.englishReminderEnabled) {
        const allowedDays = Array.isArray(settings.englishReminderDays) ? settings.englishReminderDays : [];
        const engMin = hhmmToMinutes(settings.englishReminderTime);
        if (allowedDays.includes(weekday) && minutesOfDay >= engMin && minutesOfDay <= Math.min(1439, engMin + 180)) {
            const rawTopic = String(settings.englishReminderTopic || '').trim();
            const isDefaultEnTopic = !rawTopic || rawTopic === 'Practice vocabulary, grammar notes, and phrasal verbs' || rawTopic === 'Practice vocabulary, grammar notes, and phrasal verbs.';
            candidates.push(attachMeta({
                key: `english:${dateStr}:${settings.englishReminderTime}`,
                type: 'english',
                refId: null,
                title: tServer(uiLang, 'english.study_title'),
                message: isDefaultEnTopic ? tServer(uiLang, 'english.default_topic') : rawTopic,
                targetView: 'english',
                canSnooze: true,
                canComplete: false
            }));
        }
    }

    return candidates;
}

let lastKnownPublicBaseUrl = '';

function recordPublicBaseUrlFromReq(req) {
    if (!req) return '';
    const candidate = getResetBaseUrl(req);
    if (candidate && !/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(candidate)) {
        lastKnownPublicBaseUrl = candidate;
    }
    return candidate;
}

function buildPublicBaseUrlForUser(settings, req = null) {
    if (settings && settings.publicBaseUrl) return settings.publicBaseUrl;
    if (req) return recordPublicBaseUrlFromReq(req);
    const envBase = (process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
    if (envBase && /^https?:\/\/[a-zA-Z0-9.-]+(:\d{1,5})?$/.test(envBase)) {
        return envBase;
    }
    if (lastKnownPublicBaseUrl) {
        return lastKnownPublicBaseUrl;
    }
    return '';
}

function getReminderActionSecrets() {
    const persistent = [
        process.env.ADMIN_SECRET,
        process.env.JOURNAL_SECRET_KEY,
        process.env.DB_PASS,
        'daily-hub-ntfy-reminder-action-v1'
    ].filter(Boolean).join('|');

    const secrets = [persistent];
    if (typeof MFA_HMAC_SECRET === 'string' && MFA_HMAC_SECRET && !secrets.includes(MFA_HMAC_SECRET)) {
        secrets.push(MFA_HMAC_SECRET);
    }
    if (typeof SESSION_SECRET === 'string' && SESSION_SECRET && !secrets.includes(SESSION_SECRET)) {
        secrets.push(SESSION_SECRET);
    }
    if (typeof MFA_SECRET === 'string' && MFA_SECRET && !secrets.includes(MFA_SECRET)) {
        secrets.push(MFA_SECRET);
    }
    return secrets;
}

function signReminderActionToken(userId, reminderKey) {
    const uid = String(userId ?? '').trim();
    const key = String(reminderKey ?? '').trim();
    const primarySecret = getReminderActionSecrets()[0];
    return crypto
        .createHmac('sha256', primarySecret)
        .update(`reminder-action:${uid}:${key}`)
        .digest('hex');
}

function verifyReminderActionToken(userId, reminderKey, token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token.trim())) {
        return false;
    }
    const cleanToken = token.trim().toLowerCase();
    const providedBuf = Buffer.from(cleanToken, 'hex');
    const uidCandidates = Array.from(new Set([String(userId ?? '').trim(), '1'])).filter(Boolean);
    const key = String(reminderKey ?? '').trim();
    if (!key) return false;

    for (const sec of getReminderActionSecrets()) {
        for (const uid of uidCandidates) {
            const expectedHex = crypto
                .createHmac('sha256', sec)
                .update(`reminder-action:${uid}:${key}`)
                .digest('hex');
            const expectedBuf = Buffer.from(expectedHex, 'hex');
            if (expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf)) {
                return true;
            }
        }
    }
    return false;
}

async function sendPhonePushViaNtfy({ settings, reminder, baseUrl = '', userId, lang = null }) {
    if (!settings || !settings.phoneNotificationsEnabled || !settings.ntfyTopic) {
        return { skipped: true };
    }
    const urlCheck = validatePushServerUrl(settings.ntfyServerUrl);
    if (urlCheck.error) {
        throw new Error(urlCheck.error);
    }

    const uiLang = normalizeUiLang(lang || reminder?.lang || settings?.uiLanguage, 'en');
    const endpoint = `${urlCheck.url}/`;
    const tagMap = {
        mood: 'brain',
        sleep: 'crescent_moon',
        agenda: 'calendar',
        class: 'mortar_board',
        residencias: 'office',
        work: 'briefcase',
        word: 'memo',
        english: 'books',
        test: 'white_check_mark'
    };

    const jsonPayload = {
        topic: settings.ntfyTopic,
        title: String(reminder.title || 'Personal Daily Hub').slice(0, 140),
        message: String(reminder.message || '').slice(0, 500),
        priority: Number(settings.ntfyPriority || 4),
        tags: [tagMap[reminder.type] || 'bell']
    };

    if (baseUrl) {
        const params = new URLSearchParams();
        if (reminder.targetDate) params.set('rDate', String(reminder.targetDate));
        if (reminder.targetMoment) params.set('rMoment', String(reminder.targetMoment));
        if (reminder.targetTime) params.set('rTime', String(reminder.targetTime));
        if (reminder.targetBlock) params.set('rBlock', String(reminder.targetBlock));
        if (reminder.targetTab) params.set('rTab', String(reminder.targetTab));
        if (reminder.refId) params.set('rRef', String(reminder.refId));
        if (reminder.extraQuery && typeof reminder.extraQuery === 'object') {
            for (const [k, v] of Object.entries(reminder.extraQuery)) {
                if (v !== undefined && v !== null && String(v) !== '') {
                    params.set(String(k), String(v));
                }
            }
        }
        if (reminder.type !== 'test') {
            params.set('fromNtfy', '1');
        }
        if (Array.from(params.keys()).length > 0 && reminder.targetView) {
            params.set('rView', String(reminder.targetView));
        }
        const qs = params.toString();
        const targetUrl = `${baseUrl}/${qs ? `?${qs}` : ''}#${reminder.targetView || 'inicio'}`;
        jsonPayload.click = targetUrl;
        const hasValidMapsUrl = Boolean(reminder.mapsUrl && /^https:\/\/www\.google\.com\/maps\//.test(reminder.mapsUrl));
        const openAppLabel = reminder.extraQuery?.captureGps === '1'
            ? tServer(uiLang, 'action.update_gps')
            : (reminder.targetView === 'agenda'
                ? tServer(uiLang, 'action.open_agenda')
                : tServer(uiLang, 'action.open_app'));
        const openAppAction = {
            action: 'view',
            label: openAppLabel,
            url: targetUrl
        };
        const actions = [];

        const commuteAckKey = String(reminder.ackKey || reminder.seriesKey || '').trim();
        const isCommuteAckReminder = Boolean(
            commuteAckKey && ['class', 'residencias', 'work'].includes(String(reminder.type || ''))
        );

        if (isCommuteAckReminder && userId) {
            jsonPayload.sequence_id = commuteAckKey;
            const ackToken = signReminderActionToken(userId, commuteAckKey);
            const ackPayload = {
                userId,
                key: commuteAckKey,
                action: 'ack',
                minutes: 0,
                type: reminder.type || 'class',
                refId: reminder.refId || null,
                title: reminder.title || '',
                message: reminder.message || '',
                token: ackToken
            };
            const ackQs = new URLSearchParams({
                userId: String(userId),
                key: commuteAckKey,
                action: 'ack',
                minutes: '0',
                type: String(reminder.type || 'class'),
                token: String(ackToken)
            }).toString();

            actions.push({
                action: 'http',
                label: tServer(uiLang, 'action.ok'),
                url: `${baseUrl}/api/reminders/action?${ackQs}`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(ackPayload),
                clear: true
            });
            if (hasValidMapsUrl) {
                actions.push({
                    action: 'view',
                    label: tServer(uiLang, 'action.maps_route'),
                    url: reminder.mapsUrl
                });
            }
            actions.push(openAppAction);
        } else if ((reminder.canSnooze || reminder.previewActions) && userId && reminder.key) {
            const actionToken = signReminderActionToken(userId, reminder.key);
            const buildNtfyHttpAction = ({ label, actionName, minutes = 0, clear = true }) => {
                const actionPayload = {
                    userId,
                    key: reminder.key,
                    action: actionName,
                    minutes,
                    type: reminder.type || 'general',
                    refId: reminder.refId || null,
                    title: reminder.title || '',
                    message: reminder.message || '',
                    token: actionToken
                };
                const actionQs = new URLSearchParams({
                    userId: String(userId),
                    key: String(reminder.key || ''),
                    action: String(actionName),
                    minutes: String(minutes),
                    type: String(reminder.type || 'general'),
                    ...(reminder.refId ? { refId: String(reminder.refId) } : {}),
                    token: String(actionToken)
                }).toString();

                return {
                    action: 'http',
                    label,
                    url: `${baseUrl}/api/reminders/action?${actionQs}`,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(actionPayload),
                    clear
                };
            };

            const snoozeAction = buildNtfyHttpAction({
                label: tServer(uiLang, 'action.snooze_15m'),
                actionName: 'snooze',
                minutes: 15,
                clear: true
            });
            const skipAction = buildNtfyHttpAction({
                label: tServer(uiLang, 'action.skip'),
                actionName: 'skip',
                minutes: 0,
                clear: true
            });

            if (hasValidMapsUrl) {
                actions.push(snoozeAction, skipAction, {
                    action: 'view',
                    label: tServer(uiLang, 'action.maps_route'),
                    url: reminder.mapsUrl
                });
            } else if (reminder.canComplete && reminder.refId) {
                actions.push(
                    buildNtfyHttpAction({
                        label: tServer(uiLang, 'action.mark_done'),
                        actionName: 'complete_agenda',
                        minutes: 0,
                        clear: true
                    }),
                    snoozeAction,
                    buildNtfyHttpAction({
                        label: tServer(uiLang, 'action.ok'),
                        actionName: 'dismiss',
                        minutes: 0,
                        clear: true
                    })
                );
            } else {
                actions.push(openAppAction, snoozeAction, skipAction);
            }
        } else {
            actions.push(openAppAction);
            if (hasValidMapsUrl) {
                actions.push({
                    action: 'view',
                    label: tServer(uiLang, 'action.maps_route'),
                    url: reminder.mapsUrl
                });
            }
        }

        jsonPayload.click = targetUrl;
        jsonPayload.actions = actions.slice(0, 3);
    }

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify(jsonPayload),
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined
    });

    if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(`Push relay returned HTTP ${response.status}${errBody ? `: ${errBody.slice(0, 120)}` : ''}`);
    }
    return { sent: true };
}

function getDateStrDaysAgo(dateStr, daysAgo = 7) {
    const [y, m, d] = String(dateStr || '2026-01-01').split('-').map(Number);
    const dt = new Date(Date.UTC(y || 2026, (m || 1) - 1, (d || 1) - daysAgo));
    return dt.toISOString().slice(0, 10);
}

async function evaluateAndDispatchUserReminders(user, { dispatchPush = true, req = null, langOverride = null } = {}) {
    const settings = await loadUserSettings(user.id);
    const uiLang = resolveRequestUiLang({ settings, req, explicitLang: langOverride });
    const localNow = getLocalNowParts(settings.timezone);
    const baseUrl = buildPublicBaseUrlForUser(settings, req);
    const sevenDaysAgoStr = getDateStrDaysAgo(localNow.dateStr, 7);
    const yesterdayStr = getDateStrDaysAgo(localNow.dateStr, 1);

    const [moodRows, sleepRows, agendaRows, weekAgendaRows, inProgressRows, stateRows] = await Promise.all([
        dbQueryAsync('SELECT momento_dia FROM RegistrosMood WHERE fecha = ?', [localNow.dateStr]),
        dbQueryAsync(
            `SELECT id, DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, horas, hora_dormir, hora_despertar, es_desvelo, tipo_registro
             FROM RegistrosSleep
             WHERE fecha IN (?, ?)`,
            [yesterdayStr, localNow.dateStr]
        ),
        dbQueryAsync(
            `SELECT id, TIME_FORMAT(hora, '%H:%i') AS hora, actividad,
                    COALESCE(tipo, 'evento') AS tipo,
                    COALESCE(categoria, 'personal') AS categoria,
                    materia_id, materia_nombre,
                    COALESCE(estado, CASE WHEN completada = 1 THEN 'done' ELSE 'todo' END) AS estado,
                    completada, recordatorio_min, en_progreso_desde
             FROM RegistrosAgenda
             WHERE fecha = ?
             ORDER BY hora ASC`,
            [localNow.dateStr]
        ),
        dbQueryAsync(
            `SELECT id, DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, bloque,
                    TIME_FORMAT(hora, '%H:%i') AS hora, actividad,
                    COALESCE(tipo, 'evento') AS tipo,
                    COALESCE(categoria, 'personal') AS categoria,
                    materia_id, materia_nombre,
                    COALESCE(estado, CASE WHEN completada = 1 THEN 'done' ELSE 'todo' END) AS estado,
                    completada, recordatorio_min, en_progreso_desde
             FROM RegistrosAgenda
             WHERE fecha BETWEEN ? AND ?
             ORDER BY fecha ASC, hora ASC`,
            [sevenDaysAgoStr, localNow.dateStr]
        ),
        dbQueryAsync(
            `SELECT id, DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, bloque,
                    TIME_FORMAT(hora, '%H:%i') AS hora, actividad,
                    COALESCE(tipo, 'evento') AS tipo,
                    COALESCE(categoria, 'personal') AS categoria,
                    materia_id, materia_nombre,
                    COALESCE(estado, CASE WHEN completada = 1 THEN 'done' ELSE 'todo' END) AS estado,
                    completada, recordatorio_min, en_progreso_desde
             FROM RegistrosAgenda
             WHERE estado = 'in_progress' AND completada = 0
             ORDER BY fecha ASC, hora ASC`
        ),
        dbQueryAsync(
            'SELECT clave_unica, tipo, titulo, mensaje, estado, snooze_hasta, enviado_push_en FROM RecordatoriosEstado WHERE usuario_id = ?',
            [user.id]
        )
    ]);

    await warmLiveDrivingRoutesForPlanner(settings.academicPlanner, localNow);

    const candidates = computeCandidateReminders({
        settings,
        localNow,
        lang: uiLang,
        moodLogsToday: Array.isArray(moodRows) ? moodRows : [],
        sleepLogsToday: Array.isArray(sleepRows) ? sleepRows : [],
        agendaItemsToday: Array.isArray(agendaRows) ? agendaRows : [],
        pendingTasksWeek: Array.isArray(weekAgendaRows) ? weekAgendaRows : [],
        inProgressItems: Array.isArray(inProgressRows) ? inProgressRows : [],
        queueCounts: { journal: journalQueue.size(), english: englishQueue.size() }
    });

    const stateMap = new Map((Array.isArray(stateRows) ? stateRows : []).map(r => [r.clave_unica, r]));
    const nowMs = Date.now();
    const active = [];
    const snoozed = [];

    for (const candidate of candidates) {
        if (candidate.ackKey) {
            const ackRow = stateMap.get(candidate.ackKey);
            if (ackRow && ackRow.estado === 'dismissed') {
                continue;
            }
            const stagePrefix = `${candidate.ackKey}:m`;
            const hasStaleStageRows = Array.from(stateMap.keys()).some(
                (k) => k.startsWith(stagePrefix) && k !== candidate.key
            );
            if (hasStaleStageRows) {
                await dbQueryAsync(
                    "DELETE FROM RecordatoriosEstado WHERE usuario_id = ? AND clave_unica LIKE CONCAT(?, ':m%') AND clave_unica <> ?",
                    [user.id, candidate.ackKey, candidate.key]
                );
                for (const k of Array.from(stateMap.keys())) {
                    if (k.startsWith(stagePrefix) && k !== candidate.key) {
                        stateMap.delete(k);
                    }
                }
            }
        }

        const existing = stateMap.get(candidate.key);
        if (existing && existing.estado === 'dismissed') {
            continue;
        }
        if (existing && existing.estado === 'snoozed' && existing.snooze_hasta) {
            const snoozeUntilMs = new Date(existing.snooze_hasta).getTime();
            if (Number.isFinite(snoozeUntilMs) && snoozeUntilMs > nowMs) {
                snoozed.push({
                    ...candidate,
                    snoozeUntil: new Date(snoozeUntilMs).toISOString()
                });
                continue;
            }
        }

        const shouldMarkPush = !existing || !existing.enviado_push_en || existing.estado === 'snoozed';
        let pushSentAtSql = existing && existing.enviado_push_en && existing.estado !== 'snoozed'
            ? existing.enviado_push_en
            : null;

        if (shouldMarkPush && dispatchPush && settings.phoneNotificationsEnabled && settings.ntfyTopic) {
            try {
                await sendPhonePushViaNtfy({ settings, reminder: candidate, baseUrl, userId: user.id, lang: uiLang });
                pushSentAtSql = formatMySqlDateTime(new Date());
            } catch (pushErr) {
                console.error('[PHONE_PUSH_ERROR]', pushErr.message);
            }
        }

        const titleChanged = existing && existing.titulo !== candidate.title.slice(0, 140);
        const msgChanged = existing && existing.mensaje !== candidate.message.slice(0, 320);
        if (!existing || existing.estado === 'snoozed' || pushSentAtSql !== existing.enviado_push_en || titleChanged || msgChanged) {
            await dbQueryAsync(
                `INSERT INTO RecordatoriosEstado (usuario_id, clave_unica, tipo, ref_id, titulo, mensaje, estado, snooze_hasta, enviado_push_en)
                 VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, ?)
                 ON DUPLICATE KEY UPDATE
                    titulo = VALUES(titulo),
                    mensaje = VALUES(mensaje),
                    estado = 'active',
                    snooze_hasta = NULL,
                    enviado_push_en = COALESCE(VALUES(enviado_push_en), enviado_push_en)`,
                [
                    user.id,
                    candidate.key,
                    candidate.type,
                    candidate.refId || null,
                    candidate.title.slice(0, 140),
                    candidate.message.slice(0, 320),
                    pushSentAtSql
                ]
            );
        }

        active.push(candidate);
    }

    return {
        localNow,
        uiLanguage: uiLang,
        settings,
        active,
        snoozed
    };
}

let _lastMidnightJournalDate = '';
let _lastMidnightJournalAttemptMs = 0;

async function runAutonomousJournalMidnightTick(adminTimeZone = null) {
    if (!isActiveBlueGreenSlot()) return;
    const wordPassword = String(process.env.WORD_PASSWORD || '').trim();
    if (!wordPassword || !serverNotesService.isServerAutonomousNotesEnabled()) return;

    const localNow = getLocalNowParts(adminTimeZone || process.env.TZ || 'America/Monterrey');
    if (_lastMidnightJournalDate === localNow.dateStr) return;

    const nowMs = Date.now();
    if (_lastMidnightJournalAttemptMs > 0 && (nowMs - _lastMidnightJournalAttemptMs) < 5 * 60 * 1000) {
        return;
    }

    const status = serverNotesService.getLocalJournalStatus({ rootDir: __dirname });
    if (!status.exists && localNow.minutesOfDay >= 60) {
        return;
    }

    _lastMidnightJournalAttemptMs = nowMs;
    const yesterdayIso = shiftIsoDate(localNow.dateStr, -1);

    try {
        const res = await runWithDocxLock('pdh_docx_journal', () =>
            serverNotesService.verifyJournalDailyCoverage({
                wordPassword,
                todayIso: localNow.dateStr,
                throughDateIso: yesterdayIso,
                createIfMissing: localNow.minutesOfDay < 60,
                fillIfEmptyDoc: true,
                rootDir: __dirname
            })
        );
        if (res && res.ok) {
            _lastMidnightJournalDate = localNow.dateStr;
            if (Array.isArray(res.filledDates) && res.filledDates.length > 0) {
                serverLogger.info('JOURNAL', 'Verificación diaria automática completada en Diario.docx', {
                    filledDates: res.filledDates,
                    todayIso: localNow.dateStr
                });
            }
        }
    } catch (err) {
        console.warn('[MIDNIGHT_JOURNAL_WARN]', err.message);
    }
}

let schedulerRunning = false;
async function runReminderSchedulerTick() {
    if (!isActiveBlueGreenSlot()) return;
    if (schedulerRunning) return;
    schedulerRunning = true;
    try {
        const admins = await dbQueryAsync(
            "SELECT id, nombre, email FROM Usuarios WHERE rol = 'admin' AND COALESCE(estado, 'activo') = 'activo'"
        );
        let adminTz = null;
        if (Array.isArray(admins) && admins.length > 0) {
            try {
                const adminSettings = await loadUserSettings(admins[0].id);
                adminTz = adminSettings?.timezone || null;
            } catch (_) {}
        }
        await runAutonomousJournalMidnightTick(adminTz);
        if (!Array.isArray(admins) || admins.length === 0) return;
        for (const adminUser of admins) {
            await evaluateAndDispatchUserReminders(adminUser, { dispatchPush: true });
        }
    } catch (err) {
        if (err && err.code !== 'ER_NO_SUCH_TABLE') {
            console.error('[REMINDER_SCHEDULER_ERROR]', err.message);
        }
    } finally {
        schedulerRunning = false;
    }
}

if (process.env.DISABLE_REMINDER_SCHEDULER !== 'true') {
    setTimeout(runReminderSchedulerTick, 5000).unref();
    setInterval(runReminderSchedulerTick, 30 * 1000).unref();
}

app.get('/api/settings', apiReadLimiter.middleware, requireAdmin, async (req, res) => {
    try {
        const settings = await loadUserSettings(req.user.id);
        res.json({ settings: sanitizeSettingsForClient(settings) });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error loading settings.');
    }
});

app.put('/api/settings', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, preventDuplicateSubmit({ dedupeWindowMs: 0 }), async (req, res) => {
    try {
        const current = await loadUserSettings(req.user.id);
        const result = validateUserSettingsPayload(req.body, current);
        if (result.error) {
            return res.status(400).send(result.error);
        }
        await saveUserSettings(req.user.id, result.settings);
        bumpSyncRevision('settings');
        if (req.body.uiLanguage !== undefined && result.settings.uiLanguage !== current.uiLanguage) {
            recentSubmissionCache.clear();
        }
        if (
            req.body.commuteRemindersEnabled !== undefined ||
            req.body.commuteExtraBufferMinutes !== undefined ||
            req.body.commuteRepeatEveryMinutes !== undefined ||
            req.body.commuteNearAlertMinutes !== undefined ||
            req.body.commuteNearRadiusKm !== undefined ||
            req.body.academicPlanner !== undefined
        ) {
            bumpSyncRevision('planner');
        }
        res.json({
            message: tServer(result.settings.uiLanguage, 'response.settings_saved'),
            settings: sanitizeSettingsForClient(result.settings)
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error saving settings.');
    }
});

app.patch('/api/settings/language', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, async (req, res) => {
    try {
        if (!isValidStrictUiLang(req.body?.uiLanguage)) {
            return res.status(400).send(tServer('en', 'error.invalid_ui_language'));
        }
        const current = await loadUserSettings(req.user.id);
        const nextLang = normalizeUiLang(req.body.uiLanguage);
        const updated = { ...current, uiLanguage: nextLang };
        await saveUserSettings(req.user.id, updated);
        bumpSyncRevision('settings');
        recentSubmissionCache.clear();
        res.json({
            ok: true,
            uiLanguage: nextLang,
            message: tServer(nextLang, 'response.lang_saved'),
            settings: sanitizeSettingsForClient(updated)
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error updating interface language.');
    }
});

const handleTestPhonePush = async (req, res) => {
    try {
        const saved = await loadUserSettings(req.user.id);
        const body = req.body || {};
        const merged = {
            ...saved,
            phoneNotificationsEnabled: true,
            ntfyServerUrl: body.ntfyServerUrl !== undefined ? body.ntfyServerUrl : saved.ntfyServerUrl,
            ntfyTopic: body.ntfyTopic !== undefined ? body.ntfyTopic : saved.ntfyTopic,
            ntfyPriority: body.ntfyPriority !== undefined ? body.ntfyPriority : saved.ntfyPriority,
            publicBaseUrl: body.publicBaseUrl !== undefined ? body.publicBaseUrl : saved.publicBaseUrl,
            ...(body.uiLanguage !== undefined ? { uiLanguage: body.uiLanguage } : {})
        };
        const validation = validateUserSettingsPayload(merged, saved);
        if (validation.error) {
            return res.status(400).send(validation.error);
        }

        const uiLang = resolveRequestUiLang({ settings: validation.settings, req });
        const baseUrl = buildPublicBaseUrlForUser(validation.settings, req);
        await sendPhonePushViaNtfy({
            settings: validation.settings,
            reminder: {
                key: `test:${Date.now()}`,
                type: 'test',
                lang: uiLang,
                title: tServer(uiLang, 'test_push.title'),
                message: tServer(uiLang, 'test_push.message'),
                targetView: 'settings',
                canSnooze: true,
                previewActions: true
            },
            baseUrl,
            userId: req.user.id,
            lang: uiLang
        });
        res.json({
            ok: true,
            uiLanguage: uiLang,
            message: tServer(uiLang, 'test_push.sent_response')
        });
    } catch (err) {
        console.error('[TEST_PUSH_ERROR]', err.message);
        res.status(502).send(err.message || 'Could not reach phone notification relay.');
    }
};

app.post('/api/settings/test-notification', apiWriteLimiter.middleware, requireAdmin, preventDuplicateSubmit({ dedupeWindowMs: 3000 }), handleTestPhonePush);
app.post('/api/reminders/test-push', apiWriteLimiter.middleware, requireAdmin, preventDuplicateSubmit({ dedupeWindowMs: 3000 }), handleTestPhonePush);

function sanitizePlannerForClient(planner = {}) {
    if (!planner || typeof planner !== 'object') return planner;
    const { phoneGpsNonce, ...rest } = planner;
    return {
        ...rest,
        hasPhoneWebhook: Boolean(phoneGpsNonce)
    };
}

function buildLiveCommutePreview(planner, localNow) {
    const originInfo = resolveUserOriginCoords(planner, true);
    const originCoords = originInfo.coords;
    const currCoords = parseCoordinatesFromInput(planner?.locations?.current || {});
    const homeCoords = parseCoordinatesFromInput(planner?.locations?.home || {});
    const hasLiveGps = Boolean(currCoords);
    const originKind = currCoords ? 'current' : (homeCoords ? 'home' : 'none');
    const effNearRadiusKm = planner.commuteNearRadiusKm ?? planner.nearRadiusKm ?? 0.5;
    const effExtraBuffer = planner.commuteExtraBufferMinutes ?? 30;
    const effRepeatEvery = planner.commuteRepeatEveryMinutes ?? 5;
    const effNearAlerts = planner.commuteNearAlertMinutes ?? [20, 15, 10];
    const campusDirectory = getEffectiveCampusDirectory(planner);
    const campuses = {};
    const commutes = [];
    for (const [key, campus] of Object.entries(campusDirectory)) {
        const comm = estimateCommuteDetails({
            originCoords,
            homeCoords,
            destCoords: { lat: campus.lat, lng: campus.lng },
            targetMinutesOfDay: localNow.minutesOfDay,
            weekday: localNow.weekday,
            isFirstOfDay: true,
            nearRadiusKm: effNearRadiusKm,
            extraBufferMinutes: effExtraBuffer,
            repeatEveryMinutes: effRepeatEvery,
            nearAlertMinutes: effNearAlerts,
            hasLiveGps
        });
        campuses[key] = {
            ...campus,
            commute: comm
        };
        commutes.push({
            campusKey: key,
            target: campus.name,
            isNearCampus: comm.isNear,
            isAtHome: comm.isAtHome,
            commuteZone: comm.commuteZone,
            alertMilestones: comm.alertMilestones,
            distanceKm: comm.distanceKm,
            driveMinutesWithTraffic: comm.driveMinutes,
            extraBufferMinutes: comm.extraBufferMinutes,
            repeatEveryMinutes: comm.repeatEveryMinutes,
            nearAlertMinutes: comm.nearAlertMinutes,
            trafficLabel: comm.trafficLabel,
            recommendedLeadMinutes: comm.recommendedLeadMinutes,
            mapsDirectionsUrl: comm.mapsUrl
        });
    }

    const resCoords = parseCoordinatesFromInput(planner.residencias?.location || {});
    const workCoords = parseCoordinatesFromInput(planner.work?.location || {});

    return {
        originSource: originInfo.sourceLabel,
        originKind,
        originUpdatedAt: currCoords ? (planner?.locations?.current?.updatedAt || null) : null,
        originTechnicalSource: currCoords ? (planner?.locations?.current?.source || 'gps') : (homeCoords ? 'home' : 'none'),
        homeConfigured: Boolean(homeCoords),
        originCoords,
        campuses,
        commutes,
        residenciasCommute: resCoords
            ? estimateCommuteDetails({
                originCoords,
                homeCoords,
                destCoords: resCoords,
                targetMinutesOfDay: hhmmToMinutes(planner.residencias?.startTime || '08:00'),
                weekday: localNow.weekday,
                isFirstOfDay: true,
                nearRadiusKm: effNearRadiusKm,
                extraBufferMinutes: effExtraBuffer,
                repeatEveryMinutes: effRepeatEvery,
                nearAlertMinutes: effNearAlerts,
                hasLiveGps
            })
            : null,
        workCommute: workCoords
            ? estimateCommuteDetails({
                originCoords,
                homeCoords,
                destCoords: workCoords,
                targetMinutesOfDay: hhmmToMinutes(planner.work?.startTime || '08:00'),
                weekday: localNow.weekday,
                isFirstOfDay: true,
                nearRadiusKm: effNearRadiusKm,
                extraBufferMinutes: effExtraBuffer,
                repeatEveryMinutes: effRepeatEvery,
                nearAlertMinutes: effNearAlerts,
                hasLiveGps
            })
            : null
    };
}

app.get('/api/planner', apiReadLimiter.middleware, requireAdmin, async (req, res) => {
    try {
        const settings = await loadUserSettings(req.user.id);
        const planner = sanitizeAcademicPlanner(settings.academicPlanner);
        const localNow = getLocalNowParts(settings.timezone);
        await warmLiveDrivingRoutesForPlanner(planner, localNow);
        res.json({
            planner: sanitizePlannerForClient(planner),
            campusDirectory: getEffectiveCampusDirectory(planner),
            activeVacation: isDateInVacation(localNow.dateStr, planner.vacations),
            commutePreview: buildLiveCommutePreview(planner, localNow)
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error loading academic & work planner.');
    }
});

app.put('/api/planner', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, preventDuplicateSubmit({ dedupeWindowMs: 0 }), async (req, res) => {
    try {
        const current = await loadUserSettings(req.user.id);
        const incomingPlanner = req.body.planner !== undefined ? req.body.planner : req.body;
        const nextPlanner = sanitizeAcademicPlanner(incomingPlanner, current.academicPlanner);

        for (const locKey of ['home', 'university']) {
            const locObj = nextPlanner.locations?.[locKey];
            if (locObj && locObj.mapsUrl && !parseCoordinatesFromInput({ lat: locObj.lat, lng: locObj.lng })) {
                const expanded = await resolveGoogleMapsShortLinkIfNeeded(locObj.mapsUrl);
                if (expanded && expanded !== locObj.mapsUrl) {
                    locObj.mapsUrl = expanded.slice(0, 500);
                }
                const resolvedCoords = parseCoordinatesFromInput({ mapsUrl: locObj.mapsUrl });
                if (resolvedCoords) {
                    locObj.lat = resolvedCoords.lat;
                    locObj.lng = resolvedCoords.lng;
                }
            }
        }
        for (const extraLoc of [nextPlanner.residencias?.location, nextPlanner.work?.location]) {
            if (extraLoc && extraLoc.mapsUrl && !parseCoordinatesFromInput({ lat: extraLoc.lat, lng: extraLoc.lng })) {
                const expanded = await resolveGoogleMapsShortLinkIfNeeded(extraLoc.mapsUrl);
                if (expanded && expanded !== extraLoc.mapsUrl) {
                    extraLoc.mapsUrl = expanded.slice(0, 500);
                }
                const resolvedCoords = parseCoordinatesFromInput({ mapsUrl: extraLoc.mapsUrl });
                if (resolvedCoords) {
                    extraLoc.lat = resolvedCoords.lat;
                    extraLoc.lng = resolvedCoords.lng;
                }
            }
        }

        const nextSettings = {
            ...current,
            commuteRemindersEnabled: nextPlanner.classRemindersEnabled !== false,
            commuteExtraBufferMinutes: nextPlanner.commuteExtraBufferMinutes,
            commuteRepeatEveryMinutes: nextPlanner.commuteRepeatEveryMinutes,
            commuteNearAlertMinutes: nextPlanner.commuteNearAlertMinutes,
            commuteNearRadiusKm: nextPlanner.nearRadiusKm,
            academicPlanner: nextPlanner
        };
        await saveUserSettings(req.user.id, nextSettings);
        bumpSyncRevision('planner');
        bumpSyncRevision('settings');
        const localNow = getLocalNowParts(nextSettings.timezone);
        await warmLiveDrivingRoutesForPlanner(nextPlanner, localNow);
        res.json({
            message: 'Academic, Residencias & Work schedule saved.',
            planner: sanitizePlannerForClient(nextPlanner),
            campusDirectory: getEffectiveCampusDirectory(nextPlanner),
            activeVacation: isDateInVacation(localNow.dateStr, nextPlanner.vacations),
            commutePreview: buildLiveCommutePreview(nextPlanner, localNow)
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error saving academic & work planner.');
    }
});

async function resolveGoogleMapsShortLinkIfNeeded(rawUrl = '') {
    const clean = String(rawUrl || '').trim();
    if (!clean || !/^https?:\/\//i.test(clean)) return clean;
    try {
        let currentUrl = new URL(clean);
        for (let hop = 0; hop < 4; hop++) {
            const host = currentUrl.hostname.toLowerCase();
            if (!['maps.app.goo.gl', 'goo.gl'].includes(host) || currentUrl.protocol !== 'https:') {
                return currentUrl.toString();
            }
            const headResp = await fetch(currentUrl.toString(), {
                method: 'HEAD',
                redirect: 'manual',
                signal: AbortSignal.timeout(4500)
            });
            let loc = headResp.headers.get('location');
            if (!loc) {
                const getResp = await fetch(currentUrl.toString(), {
                    method: 'GET',
                    redirect: 'manual',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (compatible; PersonalDailyHub/1.0)',
                        Accept: 'text/html,application/xhtml+xml'
                    },
                    signal: AbortSignal.timeout(4500)
                });
                loc = getResp.headers.get('location');
                if (!loc) {
                    const htmlSnippet = (await getResp.text()).slice(0, 65536);
                    const metaRefreshMatch = htmlSnippet.match(/content=["'][^"']*url=([^"'\s>]+)/i);
                    const canonicalMatch = htmlSnippet.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i);
                    const bodyUrlCandidate = (metaRefreshMatch && metaRefreshMatch[1]) || (canonicalMatch && canonicalMatch[1]) || '';
                    if (bodyUrlCandidate) {
                        const decodedCandidate = bodyUrlCandidate.replace(/&amp;/g, '&');
                        const nextFromBody = new URL(decodedCandidate, currentUrl);
                        if (nextFromBody.protocol === 'https:') {
                            currentUrl = nextFromBody;
                            if (parseCoordinatesFromInput({ mapsUrl: currentUrl.toString() })) {
                                return currentUrl.toString();
                            }
                            continue;
                        }
                    }
                    const directCoordsFromHtml = parseCoordinatesFromInput({ mapsUrl: htmlSnippet });
                    if (directCoordsFromHtml) {
                        return `https://www.google.com/maps/search/?api=1&query=${directCoordsFromHtml.lat},${directCoordsFromHtml.lng}`;
                    }
                    return currentUrl.toString();
                }
            }
            const nextUrl = new URL(loc, currentUrl);
            if (nextUrl.protocol !== 'https:') return clean;
            currentUrl = nextUrl;
            if (parseCoordinatesFromInput({ mapsUrl: currentUrl.toString() })) {
                return currentUrl.toString();
            }
        }
        return currentUrl.toString();
    } catch (_err) {
        return clean;
    }
}

async function geocodeAddressWithNominatim(rawAddress = '') {
    const clean = String(rawAddress || '').trim().slice(0, 220);
    if (!clean || clean.length < 4 || /^https?:\/\//i.test(clean)) return null;
    if (/^\s*-?\d+(?:\.\d+)?\s*[,\s]\s*-?\d+(?:\.\d+)?\s*$/.test(clean)) return null;

    const tryQuery = async (queryText) => {
        const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=3&countrycodes=mx&q=${encodeURIComponent(queryText)}`;
        const resp = await fetch(url, {
            method: 'GET',
            headers: {
                'User-Agent': 'PersonalDailyHub/1.0 (self-hosted academic planner)',
                Accept: 'application/json'
            },
            signal: AbortSignal.timeout(4500)
        });
        if (!resp.ok) return null;
        const list = await resp.json();
        if (!Array.isArray(list)) return null;
        for (const item of list) {
            const lat = Number(item?.lat);
            const lng = Number(item?.lon);
            if (isValidNonZeroCoords(lat, lng)) {
                return {
                    lat: Number(lat.toFixed(6)),
                    lng: Number(lng.toFixed(6)),
                    displayName: String(item.display_name || clean).slice(0, 200),
                    source: 'nominatim'
                };
            }
        }
        return null;
    };

    try {
        const hasRegionHint = /\b(saltillo|coahuila|mexico|méxico|ramos|arteaga)\b/i.test(clean);
        const primaryQuery = hasRegionHint ? clean : `${clean}, Saltillo, Coahuila, México`;
        const hit = await tryQuery(primaryQuery);
        if (hit) return hit;
        if (!hasRegionHint && clean.includes(',')) {
            return await tryQuery(clean);
        }
        return null;
    } catch (_err) {
        return null;
    }
}

function ensureUserPhoneGpsNonce(planner) {
    const existing = typeof planner?.phoneGpsNonce === 'string' && /^[a-f0-9]{16,64}$/i.test(planner.phoneGpsNonce.trim())
        ? planner.phoneGpsNonce.trim()
        : '';
    if (existing) {
        return { nonce: existing, changed: false };
    }
    const fresh = crypto.randomBytes(16).toString('hex');
    planner.phoneGpsNonce = fresh;
    return { nonce: fresh, changed: true };
}

function signPhoneGpsToken({ userId, email = 'phone@dailyhub.local', nonce }) {
    return signMfaChallenge({
        userId: Number(userId),
        email: String(email || 'phone@dailyhub.local'),
        purpose: 'phone_gps_webhook',
        nonce: String(nonce || ''),
        exp: Date.now() + 365 * 24 * 60 * 60 * 1000
    });
}

function verifyPhoneGpsToken(token) {
    const parsed = verifyMfaChallenge(token);
    if (!parsed || parsed.purpose !== 'phone_gps_webhook' || !parsed.nonce || !Number.isInteger(Number(parsed.userId))) {
        return null;
    }
    return parsed;
}

app.post('/api/planner/location', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, preventDuplicateSubmit({ dedupeWindowMs: 0 }), async (req, res) => {
    try {
        const current = await loadUserSettings(req.user.id);
        const planner = sanitizeAcademicPlanner(current.academicPlanner);
        const target = String(req.body.target || 'current').trim();

        const campusResetTargetMap = {
            reset_campus_principal: 'principal',
            reset_campus_miravalle: 'miravalle',
            reset_campus_boillot: 'boillot'
        };
        const resolveDynamicCampusTarget = (rawTarget) => {
            if (rawTarget === 'university') return 'principal';
            if (!rawTarget.startsWith('campus_')) return '';
            const candidate = normalizeCampusId(rawTarget.slice('campus_'.length));
            if (!candidate) return '';
            if (planner.locations?.campuses?.[candidate] || ITS_CAMPUS_DIRECTORY[candidate]) {
                return candidate;
            }
            return '';
        };

        if (target === 'clear_current') {
            planner.locations.current = {
                label: 'Ubicación actual',
                lat: null,
                lng: null,
                updatedAt: null,
                source: 'none'
            };
            const nextSettings = { ...current, academicPlanner: planner };
            await saveUserSettings(req.user.id, nextSettings);
            bumpSyncRevision('planner');
            const localNow = getLocalNowParts(nextSettings.timezone);
            const preview = buildLiveCommutePreview(planner, localNow);
            return res.json({
                message: 'Live GPS cleared. Commutes now use your Saved Home as origin.',
                planner: sanitizePlannerForClient(planner),
                campusDirectory: getEffectiveCampusDirectory(planner),
                commutePreview: preview,
                commutes: preview.commutes
            });
        }

        const dynamicCampusKey = resolveDynamicCampusTarget(target);
        const resetCampusKey = campusResetTargetMap[target] || (req.body.reset === true ? dynamicCampusKey : '');
        if (resetCampusKey && ITS_CAMPUS_DIRECTORY[resetCampusKey]) {
            const baseCampus = ITS_CAMPUS_DIRECTORY[resetCampusKey];
            const prevEntry = planner.locations?.campuses?.[resetCampusKey] || {};
            const defaultLoc = {
                id: resetCampusKey,
                name: baseCampus.name,
                label: baseCampus.name,
                plano: baseCampus.plano,
                address: baseCampus.address,
                mapsUrl: `https://www.google.com/maps?q=${baseCampus.lat},${baseCampus.lng}`,
                lat: baseCampus.lat,
                lng: baseCampus.lng,
                rooms: normalizeCampusRooms(prevEntry.rooms || []),
                buildings: baseCampus.buildings
            };
            planner.locations.campuses = planner.locations.campuses || {};
            planner.locations.campuses[resetCampusKey] = sanitizeCampusEntry(resetCampusKey, defaultLoc, defaultLoc);
            if (resetCampusKey === 'principal') {
                planner.locations.university = sanitizeLocationObject({
                    ...defaultLoc,
                    label: 'Instituto Tecnológico de Saltillo (Blvd. V. Carranza #2400)'
                }, defaultLoc);
            }
            const nextSettings = { ...current, academicPlanner: planner };
            await saveUserSettings(req.user.id, nextSettings);
            bumpSyncRevision('planner');
            const localNow = getLocalNowParts(nextSettings.timezone);
            const preview = buildLiveCommutePreview(planner, localNow);
            return res.json({
                message: `${baseCampus.name} restored to official croquis coordinates.`,
                target,
                resolvedCoords: { lat: baseCampus.lat, lng: baseCampus.lng },
                resolutionSource: 'default_croquis',
                planner: sanitizePlannerForClient(planner),
                campusDirectory: getEffectiveCampusDirectory(planner),
                commutePreview: preview,
                commutes: preview.commutes
            });
        }

        const rawUrlInput = String(req.body.mapsUrl || req.body.url || '').trim();
        const rawTextInput = String(req.body.query || req.body.input || rawUrlInput || '').trim();
        let expandedUrl = rawUrlInput;
        let coords = parseCoordinatesFromInput({
            ...req.body,
            mapsUrl: rawUrlInput || rawTextInput
        });
        if (!coords && rawUrlInput && /^https?:\/\//i.test(rawUrlInput)) {
            expandedUrl = await resolveGoogleMapsShortLinkIfNeeded(rawUrlInput);
            coords = parseCoordinatesFromInput({ ...req.body, mapsUrl: expandedUrl });
        }

        let geocodedMeta = null;
        if (!coords) {
            const addrCandidate = String(
                req.body.address ||
                (!/^https?:\/\//i.test(rawTextInput) ? rawTextInput : '') ||
                ''
            ).trim();
            if (addrCandidate) {
                geocodedMeta = await geocodeAddressWithNominatim(addrCandidate);
                if (geocodedMeta) {
                    coords = { lat: geocodedMeta.lat, lng: geocodedMeta.lng };
                }
            }
        }

        if (!coords) {
            return res.status(400).send('Valid non-zero latitude/longitude, a Google Maps link with coordinates, or a street address (e.g. Margarita Maza de Juárez 924, Saltillo) is required.');
        }

        const resolvedMapsUrl = expandedUrl && /^https?:\/\//i.test(expandedUrl)
            ? expandedUrl.slice(0, 500)
            : `https://www.google.com/maps?q=${coords.lat},${coords.lng}`;

        const customLabel = typeof req.body.label === 'string' && req.body.label.trim()
            ? req.body.label.trim().slice(0, 80)
            : '';

        if (target === 'home') {
            planner.locations.home = sanitizeLocationObject({
                ...planner.locations.home,
                ...req.body,
                address: req.body.address || (geocodedMeta ? rawTextInput : planner.locations.home.address),
                mapsUrl: req.body.mapsUrl ? resolvedMapsUrl : (planner.locations.home.mapsUrl || resolvedMapsUrl),
                ...coords
            }, planner.locations.home);
        } else if (dynamicCampusKey) {
            const campusKey = dynamicCampusKey;
            const baseCampus = ITS_CAMPUS_DIRECTORY[campusKey] || null;
            planner.locations.campuses = planner.locations.campuses || {};
            const existingCampus = planner.locations.campuses[campusKey] || (baseCampus ? {
                id: campusKey,
                name: baseCampus.name,
                label: baseCampus.name,
                plano: baseCampus.plano,
                address: baseCampus.address,
                mapsUrl: `https://www.google.com/maps?q=${baseCampus.lat},${baseCampus.lng}`,
                lat: baseCampus.lat,
                lng: baseCampus.lng,
                rooms: [],
                buildings: baseCampus.buildings
            } : { id: campusKey, name: customLabel || campusKey, address: '', lat: coords.lat, lng: coords.lng, rooms: [] });
            const cleanAddr = typeof req.body.address === 'string' && req.body.address.trim()
                ? req.body.address.trim().slice(0, 220)
                : (geocodedMeta ? rawTextInput.slice(0, 220) : (existingCampus.address || ''));
            const nextName = customLabel || existingCampus.name || existingCampus.label || campusKey;
            const updatedCampusLoc = sanitizeCampusEntry(campusKey, {
                ...existingCampus,
                name: nextName,
                label: nextName,
                address: cleanAddr,
                mapsUrl: req.body.mapsUrl ? resolvedMapsUrl : `https://www.google.com/maps?q=${coords.lat},${coords.lng}`,
                ...coords
            }, existingCampus);
            planner.locations.campuses[campusKey] = updatedCampusLoc;
            if (campusKey === 'principal') {
                planner.locations.university = sanitizeLocationObject({
                    ...planner.locations.university,
                    ...updatedCampusLoc,
                    label: customLabel || planner.locations.university?.label || nextName
                }, planner.locations.university);
            }
        } else if (target === 'residencias') {
            planner.residencias.location = sanitizeLocationObject({
                ...planner.residencias.location,
                ...req.body,
                mapsUrl: req.body.mapsUrl ? resolvedMapsUrl : (planner.residencias.location.mapsUrl || resolvedMapsUrl),
                ...coords
            }, planner.residencias.location);
        } else if (target === 'work') {
            planner.work.location = sanitizeLocationObject({
                ...planner.work.location,
                ...req.body,
                mapsUrl: req.body.mapsUrl ? resolvedMapsUrl : (planner.work.location.mapsUrl || resolvedMapsUrl),
                ...coords
            }, planner.work.location);
        } else {
            planner.locations.current = {
                label: customLabel || (geocodedMeta ? rawTextInput.slice(0, 80) : 'Ubicación GPS actual'),
                lat: coords.lat,
                lng: coords.lng,
                updatedAt: new Date().toISOString(),
                source: String(req.body.source || (geocodedMeta ? 'address_geocode' : 'gps')).slice(0, 30)
            };
        }

        const nextSettings = { ...current, academicPlanner: planner };
        await saveUserSettings(req.user.id, nextSettings);
        bumpSyncRevision('planner');
        const localNow = getLocalNowParts(nextSettings.timezone);
        await warmLiveDrivingRoutesForPlanner(planner, localNow);
        const preview = buildLiveCommutePreview(planner, localNow);
        res.json({
            message: target === 'home'
                ? 'Home location saved & coordinates verified.'
                : 'Location updated and routes recalculated.',
            resolvedCoords: coords,
            geocodedDisplayName: geocodedMeta?.displayName || null,
            planner: sanitizePlannerForClient(planner),
            campusDirectory: getEffectiveCampusDirectory(planner),
            commutePreview: preview,
            commutes: preview.commutes
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error updating location.');
    }
});

app.get('/api/planner/phone-gps-token', apiReadLimiter.middleware, requireAdmin, async (req, res) => {
    try {
        const current = await loadUserSettings(req.user.id);
        const planner = sanitizeAcademicPlanner(current.academicPlanner);
        const { nonce, changed } = ensureUserPhoneGpsNonce(planner);
        if (changed) {
            await saveUserSettings(req.user.id, { ...current, academicPlanner: planner });
        }
        const token = signPhoneGpsToken({ userId: req.user.id, email: req.user.email, nonce });
        const baseUrl = buildPublicBaseUrlForUser(current, req);
        const webhookPostUrl = `${baseUrl}/api/planner/phone-location?token=${encodeURIComponent(token)}`;
        const webhookGetExampleUrl = `${webhookPostUrl}&lat={lat}&lng={lng}`;
        res.json({
            token,
            baseUrl,
            webhookPostUrl,
            webhookGetExampleUrl,
            macroDroidJson: '{"lat":[lv=lat],"lng":[lv=lng],"source":"macrodroid_gps","label":"Teléfono GPS (HTTP)"}',
            currentLocation: planner.locations.current
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error generating phone GPS webhook token.');
    }
});

app.post('/api/planner/phone-gps-token/rotate', apiWriteLimiter.middleware, requireAdmin, async (req, res) => {
    try {
        const current = await loadUserSettings(req.user.id);
        const planner = sanitizeAcademicPlanner(current.academicPlanner);
        const nonce = crypto.randomBytes(16).toString('hex');
        planner.phoneGpsNonce = nonce;
        await saveUserSettings(req.user.id, { ...current, academicPlanner: planner });
        bumpSyncRevision('planner');

        const token = signPhoneGpsToken({ userId: req.user.id, email: req.user.email, nonce });
        const baseUrl = buildPublicBaseUrlForUser(current, req);
        const webhookPostUrl = `${baseUrl}/api/planner/phone-location?token=${encodeURIComponent(token)}`;
        const webhookGetExampleUrl = `${webhookPostUrl}&lat={lat}&lng={lng}`;
        res.json({
            message: 'Phone GPS webhook token rotated. Previous token revoked.',
            token,
            baseUrl,
            webhookPostUrl,
            webhookGetExampleUrl,
            macroDroidJson: '{"lat":[lv=lat],"lng":[lv=lng],"source":"macrodroid_gps","label":"Teléfono GPS (HTTP)"}'
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error rotating phone GPS webhook token.');
    }
});

async function handlePhoneLocationWebhook(req, res) {
    try {
        const bearerMatch = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
        const token = String(
            req.query?.token ||
            req.body?.token ||
            req.headers['x-phone-gps-token'] ||
            (bearerMatch ? bearerMatch[1] : '') ||
            ''
        ).trim();

        if (!token) {
            return res.status(401).send('Signed phone GPS token is required.');
        }

        const parsed = verifyPhoneGpsToken(token);
        if (!parsed) {
            return res.status(401).send('Invalid or expired phone GPS token.');
        }

        const settings = await loadUserSettings(parsed.userId);
        const planner = sanitizeAcademicPlanner(settings.academicPlanner);
        if (!planner.phoneGpsNonce || !safeCompareStrings(String(parsed.nonce), String(planner.phoneGpsNonce))) {
            return res.status(401).send('Phone GPS webhook token has been revoked or rotated.');
        }

        const payload = {
            ...(req.query || {}),
            ...(req.body && typeof req.body === 'object' ? req.body : {})
        };
        let coords = parseCoordinatesFromInput(payload);
        if (!coords && typeof payload.mapsUrl === 'string' && payload.mapsUrl.trim()) {
            const expanded = await resolveGoogleMapsShortLinkIfNeeded(payload.mapsUrl);
            coords = parseCoordinatesFromInput({ ...payload, mapsUrl: expanded });
        }
        if (!coords) {
            return res.status(400).send('Valid non-zero lat and lng parameters are required (0, 0 is rejected).');
        }

        const customLabel = typeof payload.label === 'string' && payload.label.trim()
            ? payload.label.trim().slice(0, 80)
            : 'Teléfono GPS (HTTP Webhook)';
        const customSource = typeof payload.source === 'string' && payload.source.trim()
            ? payload.source.trim().slice(0, 30)
            : 'phone_webhook';

        planner.locations.current = {
            label: customLabel,
            lat: coords.lat,
            lng: coords.lng,
            updatedAt: new Date().toISOString(),
            source: customSource
        };

        const nextSettings = { ...settings, academicPlanner: planner };
        await saveUserSettings(parsed.userId, nextSettings);
        bumpSyncRevision('planner');
        const localNow = getLocalNowParts(nextSettings.timezone);
        await warmLiveDrivingRoutesForPlanner(planner, localNow);
        const preview = buildLiveCommutePreview(planner, localNow);

        res.json({
            ok: true,
            message: 'Phone GPS location updated over HTTP webhook.',
            location: planner.locations.current,
            commutePreview: preview,
            commutes: preview.commutes
        });
    } catch (err) {
        console.error('[PHONE_GPS_WEBHOOK_ERROR]', err);
        res.status(500).send('Error processing phone GPS webhook.');
    }
}

app.get('/api/planner/phone-location', apiWriteLimiter.middleware, handlePhoneLocationWebhook);
app.post('/api/planner/phone-location', apiWriteLimiter.middleware, handlePhoneLocationWebhook);

app.post('/api/planner/request-phone-gps', apiWriteLimiter.middleware, requireAdmin, preventDuplicateSubmit({ dedupeWindowMs: 2500 }), async (req, res) => {
    try {
        const settings = await loadUserSettings(req.user.id);
        if (!settings.phoneNotificationsEnabled || !settings.ntfyTopic) {
            return res.status(400).send('Configure Phone Notifications (ntfy topic) in Settings first so Daily Hub can ping your phone.');
        }
        const uiLang = resolveRequestUiLang({ settings, req });
        const baseUrl = buildPublicBaseUrlForUser(settings, req);
        if (!baseUrl) {
            return res.status(400).send('Public Server URL could not be determined. Set it in Settings first.');
        }

        await sendPhonePushViaNtfy({
            settings,
            reminder: {
                key: `capture-gps:${Date.now()}`,
                type: 'class',
                lang: uiLang,
                title: tServer(uiLang, 'gps_ping.title'),
                message: tServer(uiLang, 'gps_ping.message'),
                targetView: 'horario',
                targetTab: 'locations',
                extraQuery: { captureGps: '1' },
                canSnooze: false
            },
            baseUrl,
            userId: req.user.id,
            lang: uiLang
        });

        res.json({
            message: tServer(uiLang, 'gps_ping.sent_response')
        });
    } catch (err) {
        console.error('[REQUEST_PHONE_GPS_ERROR]', err.message);
        res.status(502).send(err.message || 'Could not reach ntfy push relay.');
    }
});

const SALTILLO_LOCAL_LANDMARKS = [
    {
        label: 'ITS Campus Principal (CTO-002)',
        displayName: 'Tec de Saltillo — Campus Principal, Blvd. Venustiano Carranza #2400, Col. Tecnológico, Saltillo',
        address: 'Blvd. Venustiano Carranza #2400, Col. Tecnológico, Saltillo, Coahuila',
        lat: 25.4414,
        lng: -100.9922,
        keywords: 'tec de saltillo its principal campus cto-002 blvd venustiano carranza 2400 tecnologico'
    },
    {
        label: 'ITS Campus Blvd / Glorieta (CTO-004)',
        displayName: 'Tec de Saltillo — Campus Blvd (Glorieta), Blvd. V. Carranza esq. Av. Universidad, Saltillo',
        address: 'Blvd. Venustiano Carranza esq. Av. Universidad (Glorieta), Saltillo, Coahuila',
        lat: 25.4385,
        lng: -100.9940,
        keywords: 'tec de saltillo its boillot blvd glorieta sistemas mecatronica cto-004 universidad'
    },
    {
        label: 'ITS Campus Miravalle (CTO-003)',
        displayName: 'Tec de Saltillo — Campus Miravalle, Blvd. Vito Alessio Robles, Col. Miravalle, Saltillo',
        address: 'Blvd. Vito Alessio Robles, Col. Miravalle, Saltillo, Coahuila',
        lat: 25.4194,
        lng: -101.0232,
        keywords: 'tec de saltillo its miravalle vito alessio robles cto-003 aulas n'
    },
    {
        label: 'Centro Histórico / Plaza de Armas Saltillo',
        displayName: 'Centro Histórico / Plaza de Armas, Saltillo, Coahuila',
        address: 'Zona Centro, Saltillo, Coahuila',
        lat: 25.4232,
        lng: -100.9997,
        keywords: 'centro historico plaza de armas catedral saltillo zona centro'
    },
    {
        label: 'Alameda Zaragoza Saltillo',
        displayName: 'Alameda Zaragoza, Calle Purcell / Victoria, Zona Centro, Saltillo, Coahuila',
        address: 'Calle Purcell y Victoria, Zona Centro, Saltillo, Coahuila',
        lat: 25.4212,
        lng: -101.0063,
        keywords: 'alameda zaragoza purcell victoria saltillo'
    },
    {
        label: 'Galerías Saltillo / Parque Centro',
        displayName: 'Galerías Saltillo & Parque Centro, Blvd. Nazario Ortiz Garza, Saltillo, Coahuila',
        address: 'Blvd. Nazario Ortiz Garza, Saltillo, Coahuila',
        lat: 25.4581,
        lng: -100.9855,
        keywords: 'galerias saltillo parque centro nazario ortiz garza'
    },
    {
        label: 'Zona Industrial Ramos Arizpe',
        displayName: 'Zona Industrial Ramos Arizpe / Blvd. Miguel Ramos Arizpe, Coahuila',
        address: 'Blvd. Miguel Ramos Arizpe, Ramos Arizpe, Coahuila',
        lat: 25.5428,
        lng: -100.9478,
        keywords: 'ramos arizpe parque industrial zona industrial magna gm stellantis'
    },
    {
        label: 'Derramadero / Parque Industrial Saltillo Sur',
        displayName: 'Parque Industrial Derramadero, Saltillo, Coahuila',
        address: 'Carretera Saltillo - Derramadero Km 19, Saltillo, Coahuila',
        lat: 25.2528,
        lng: -101.1489,
        keywords: 'derramadero stellantis chrysler parque industrial sur saltillo'
    },
    {
        label: 'Arteaga Centro / Campus UADEC Arteaga',
        displayName: 'Arteaga, Coahuila (Blvd. Fundadores / Libramiento Óscar Flores Tapia)',
        address: 'Arteaga, Coahuila',
        lat: 25.4461,
        lng: -100.8473,
        keywords: 'arteaga fundadores uadec ciudad universitaria'
    }
];

function stripSearchAccents(str = '') {
    return String(str || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

function findMatchingSaltilloLandmarks(queryText, campusDir = ITS_CAMPUS_DIRECTORY) {
    const cleanNorm = stripSearchAccents(queryText).trim();
    const tokens = cleanNorm.split(/\s+/).filter(Boolean);
    const campusExtraKeywords = {
        principal: 'tec tecnm tec de saltillo instituto tecnologico de saltillo cto-002 blvd venustiano carranza',
        boillot: 'tec tecnm tec de saltillo its boillot glorieta blvd sistemas mecatronica cto-004 universidad',
        miravalle: 'tec tecnm tec de saltillo its miravalle vito alessio robles cto-003 aulas n'
    };
    const dynamicCampuses = ['principal', 'boillot', 'miravalle'].map((k) => {
        const c = (campusDir && campusDir[k]) || ITS_CAMPUS_DIRECTORY[k];
        return {
            label: `${c.name} (${c.plano})`,
            displayName: `${c.name} — ${c.address}`,
            address: c.address,
            lat: Number(c.lat),
            lng: Number(c.lng),
            source: 'croquis',
            keywords: `${c.name} ${c.plano} ${c.address} ${campusExtraKeywords[k] || ''} ${k}`
        };
    });
    const combined = [...dynamicCampuses, ...SALTILLO_LOCAL_LANDMARKS.slice(3).map(item => ({ ...item, source: 'landmark' }))];
    if (!tokens.length) return combined.slice(0, 5);
    return combined
        .filter((entry) => {
            const hay = stripSearchAccents(`${entry.label} ${entry.displayName} ${entry.address} ${entry.keywords || ''}`);
            return tokens.every(tok => hay.includes(tok)) || hay.includes(cleanNorm);
        })
        .slice(0, 6)
        .map(({ keywords: _kw, ...rest }) => rest);
}

app.get('/api/planner/geocode-search', apiReadLimiter.middleware, requireAdmin, async (req, res) => {
    try {
        const q = typeof req.query?.q === 'string' ? req.query.q.trim().slice(0, 220) : '';
        if (!q || q.length < 2) {
            return res.status(400).json({ ok: false, error: 'Ingresa al menos 2 caracteres para buscar.' });
        }

        const current = await loadUserSettings(req.user.id);
        const planner = sanitizeAcademicPlanner(current.academicPlanner);
        const campusDir = getEffectiveCampusDirectory(planner);

        const results = [];
        const directCoords = parseCoordinatesFromInput({ mapsUrl: q, input: q });
        if (directCoords) {
            results.push({
                label: 'Coordenadas exactas',
                displayName: `Punto exacto en mapa (${directCoords.lat.toFixed(5)}, ${directCoords.lng.toFixed(5)})`,
                address: `${directCoords.lat.toFixed(5)}, ${directCoords.lng.toFixed(5)}`,
                lat: directCoords.lat,
                lng: directCoords.lng,
                source: 'coordinates'
            });
        }

        const localHits = findMatchingSaltilloLandmarks(q, campusDir);
        for (const hit of localHits) {
            results.push(hit);
        }

        const shouldQueryNominatim = !directCoords && (!isAutomatedTestEnv() || process.env.ALLOW_TEST_NOMINATIM === 'true');
        if (shouldQueryNominatim) {
            try {
                const hasRegionHint = /\b(saltillo|coahuila|mexico|méxico|ramos|arteaga)\b/i.test(q);
                const queryText = hasRegionHint ? q : `${q}, Saltillo, Coahuila, México`;
                const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=mx&addressdetails=1&q=${encodeURIComponent(queryText)}`;
                const resp = await fetch(url, {
                    method: 'GET',
                    headers: {
                        'User-Agent': 'PersonalDailyHub-ITS-Saltillo/1.0 (self-hosted academic planner)',
                        Accept: 'application/json'
                    },
                    signal: AbortSignal.timeout(3500)
                });
                if (resp.ok) {
                    const list = await resp.json();
                    if (Array.isArray(list)) {
                        for (const item of list) {
                            const lat = Number(item?.lat);
                            const lng = Number(item?.lon);
                            if (!isValidNonZeroCoords(lat, lng)) continue;
                            const addrObj = item.address || {};
                            const shortParts = [
                                [addrObj.road, addrObj.house_number].filter(Boolean).join(' '),
                                addrObj.neighbourhood || addrObj.suburb || addrObj.quarter,
                                addrObj.city || addrObj.town || addrObj.municipality || addrObj.state
                            ].filter(Boolean);
                            const displayName = String(item.display_name || shortParts.join(', ') || q).slice(0, 200);
                            const alreadyNear = results.some(r => calculateHaversineKm(r.lat, r.lng, lat, lng) < 0.08);
                            if (!alreadyNear) {
                                results.push({
                                    label: shortParts[0] || String(item.name || q).slice(0, 80),
                                    displayName,
                                    address: (shortParts.join(', ') || displayName).slice(0, 200),
                                    lat: Number(lat.toFixed(6)),
                                    lng: Number(lng.toFixed(6)),
                                    source: 'nominatim'
                                });
                            }
                        }
                    }
                }
            } catch (_err) {
                // Offline o límite de Nominatim: conservar resultados locales
            }
        }

        return res.json({
            ok: true,
            query: q,
            results: results.slice(0, 8)
        });
    } catch (err) {
        console.error('[GEOCODE_SEARCH_ERROR]', err);
        return res.status(500).json({ ok: false, error: 'Error searching places.' });
    }
});

app.get('/api/planner/reverse-geocode', apiReadLimiter.middleware, requireAdmin, async (req, res) => {
    try {
        const lat = Number(req.query?.lat);
        const lng = Number(req.query?.lng);
        if (!isValidNonZeroCoords(lat, lng)) {
            return res.status(400).json({ ok: false, error: 'Valid non-zero lat and lng query parameters are required.' });
        }
        const safeLat = Number(lat.toFixed(6));
        const safeLng = Number(lng.toFixed(6));

        const current = await loadUserSettings(req.user.id);
        const planner = sanitizeAcademicPlanner(current.academicPlanner);
        const campusDir = getEffectiveCampusDirectory(planner);
        const localCandidates = [
            ...['principal', 'boillot', 'miravalle'].map((k) => {
                const c = campusDir[k];
                return { label: c.name, address: c.address, lat: c.lat, lng: c.lng };
            }),
            ...SALTILLO_LOCAL_LANDMARKS.slice(3)
        ];

        let nearest = null;
        let nearestKm = Infinity;
        for (const item of localCandidates) {
            const d = calculateHaversineKm(safeLat, safeLng, item.lat, item.lng);
            if (d < nearestKm) {
                nearestKm = d;
                nearest = item;
            }
        }

        let displayName = nearest && nearestKm <= 0.45
            ? `Cerca de ${nearest.label} (${nearest.address})`
            : 'Ubicación seleccionada en Saltillo, Coahuila';
        let address = nearest && nearestKm <= 0.45 ? nearest.address : 'Saltillo, Coahuila';
        let source = 'local_fallback';

        if (!isAutomatedTestEnv() || process.env.ALLOW_TEST_NOMINATIM === 'true') {
            try {
                const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${safeLat}&lon=${safeLng}`;
                const resp = await fetch(url, {
                    method: 'GET',
                    headers: {
                        'User-Agent': 'PersonalDailyHub-ITS-Saltillo/1.0 (self-hosted academic planner)',
                        Accept: 'application/json'
                    },
                    signal: AbortSignal.timeout(3000)
                });
                if (resp.ok) {
                    const data = await resp.json();
                    const a = data?.address || {};
                    const roadLine = [a.road, a.house_number].filter(Boolean).join(' ');
                    const hoodLine = a.neighbourhood || a.suburb || a.quarter || a.industrial || '';
                    const cityLine = a.city || a.town || a.municipality || a.state || 'Coahuila';
                    const concise = [roadLine, hoodLine, cityLine].filter(Boolean).join(', ');
                    if (concise) {
                        displayName = concise.slice(0, 200);
                        address = concise.slice(0, 200);
                        source = 'nominatim';
                    } else if (data?.display_name) {
                        displayName = String(data.display_name).slice(0, 200);
                        address = displayName;
                        source = 'nominatim';
                    }
                }
            } catch (_err) {
                // Conservar descripción local sin bloquear al usuario
            }
        }

        return res.json({
            ok: true,
            lat: safeLat,
            lng: safeLng,
            displayName,
            address,
            source
        });
    } catch (err) {
        console.error('[REVERSE_GEOCODE_ERROR]', err);
        return res.status(500).json({ ok: false, error: 'Error resolving location address.' });
    }
});

const MAP_TILE_CACHE_VERSION = 'v2';
const MAP_TILE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAP_TILE_MEM_MAX_ENTRIES = 300;
const MAP_TILE_MIN_BYTES = 101;
const MAP_TILE_MAX_BYTES = 512 * 1024;
const MAP_TILE_FETCH_TIMEOUT_MS = 4000;
const MAP_TILE_DISK_CACHE_ROOT = path.join(os.tmpdir(), '.cache', 'map-tiles');
const MAP_TILE_DISK_CACHE_DIR = path.join(MAP_TILE_DISK_CACHE_ROOT, MAP_TILE_CACHE_VERSION);
const MAP_TILE_USER_AGENT = 'PersonalDailyHub/1.21 (+https://github.com/Flax64/personal-daily-hub)';
const mapTileMemoryCache = new Map();

const MAP_TILE_PROVIDERS = {
    streets: [
        {
            id: 'osm',
            buildUrl: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`
        },
        {
            id: 'esri-streets',
            buildUrl: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`
        },
        {
            id: 'esri-topo',
            buildUrl: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/${z}/${y}/${x}`
        }
    ],
    satellite: [
        {
            id: 'esri-imagery',
            buildUrl: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`
        },
        {
            id: 'esri-streets',
            buildUrl: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`
        }
    ]
};

function detectMapTileImageMime(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
    if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
        return 'image/webp';
    }
    return null;
}

async function cleanupLegacyMapTileDiskCache() {
    if (isAutomatedTestEnv()) return;
    try {
        const rootDir = path.resolve(MAP_TILE_DISK_CACHE_ROOT);
        const entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry || entry.name === MAP_TILE_CACHE_VERSION) continue;
            const targetPath = path.resolve(rootDir, entry.name);
            if (!targetPath.startsWith(rootDir + path.sep)) continue;
            await fs.promises.rm(targetPath, { recursive: true, force: true });
        }
    } catch (_) {
        // Best-effort cleanup; ignore missing cache root or permissions
    }
}

if (!isAutomatedTestEnv()) {
    cleanupLegacyMapTileDiskCache();
}

function getMapTileFromMemory(cacheKey) {
    const entry = mapTileMemoryCache.get(cacheKey);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        mapTileMemoryCache.delete(cacheKey);
        return null;
    }
    // Refresh LRU recency
    mapTileMemoryCache.delete(cacheKey);
    mapTileMemoryCache.set(cacheKey, entry);
    return entry;
}

function setMapTileInMemory(cacheKey, entry) {
    if (!entry || !Buffer.isBuffer(entry.buffer) || entry.buffer.length < MAP_TILE_MIN_BYTES) return;
    if (mapTileMemoryCache.has(cacheKey)) {
        mapTileMemoryCache.delete(cacheKey);
    }
    while (mapTileMemoryCache.size >= MAP_TILE_MEM_MAX_ENTRIES) {
        const oldestKey = mapTileMemoryCache.keys().next().value;
        if (oldestKey === undefined) break;
        mapTileMemoryCache.delete(oldestKey);
    }
    mapTileMemoryCache.set(cacheKey, {
        buffer: entry.buffer,
        contentType: entry.contentType || 'image/png',
        provider: entry.provider || 'cache',
        expiresAt: Date.now() + MAP_TILE_CACHE_TTL_MS
    });
}

function resolveMapTileDiskPath(layer, z, x, y) {
    const safeLayer = layer === 'satellite' ? 'satellite' : 'streets';
    const fileName = `${safeLayer}-${z}-${x}-${y}.tile`;
    const baseDir = path.resolve(MAP_TILE_DISK_CACHE_DIR);
    const resolved = path.resolve(baseDir, fileName);
    if (!resolved.startsWith(baseDir + path.sep)) return null;
    return { baseDir, filePath: resolved };
}

async function readMapTileFromDisk(layer, z, x, y) {
    if (isAutomatedTestEnv()) return null;
    const loc = resolveMapTileDiskPath(layer, z, x, y);
    if (!loc) return null;
    try {
        const stat = await fs.promises.stat(loc.filePath);
        if (!stat.isFile()) return null;
        if (Date.now() - stat.mtimeMs > MAP_TILE_CACHE_TTL_MS) return null;
        if (stat.size < MAP_TILE_MIN_BYTES || stat.size > MAP_TILE_MAX_BYTES) return null;
        const buf = await fs.promises.readFile(loc.filePath);
        if (!buf || buf.length < MAP_TILE_MIN_BYTES || buf.length > MAP_TILE_MAX_BYTES) return null;
        const detectedMime = detectMapTileImageMime(buf);
        if (!detectedMime) return null;
        return {
            buffer: buf,
            contentType: detectedMime,
            provider: 'disk-cache'
        };
    } catch (_) {
        return null;
    }
}

async function writeMapTileToDisk(layer, z, x, y, buf) {
    if (isAutomatedTestEnv() || !Buffer.isBuffer(buf) || buf.length < MAP_TILE_MIN_BYTES || buf.length > MAP_TILE_MAX_BYTES) return;
    if (!detectMapTileImageMime(buf)) return;
    const loc = resolveMapTileDiskPath(layer, z, x, y);
    if (!loc) return;
    try {
        await fs.promises.mkdir(loc.baseDir, { recursive: true });
        await fs.promises.writeFile(loc.filePath, buf);
    } catch (_) {
        // Optional disk cache; ignore permission/tempfs errors cleanly
    }
}

app.get('/api/planner/map-tile/:z/:x/:y.png', mapTileLimiter.middleware, requireAdmin, async (req, res) => {
    const rawZ = String(req.params.z || '').trim();
    const rawX = String(req.params.x || '').trim();
    const rawY = String(req.params.y || '').trim().replace(/\.png$/i, '');

    if (!/^\d{1,2}$/.test(rawZ) || !/^\d{1,7}$/.test(rawX) || !/^\d{1,7}$/.test(rawY)) {
        return res.status(400).json({ ok: false, error: 'Invalid map tile coordinates.' });
    }

    const z = Number.parseInt(rawZ, 10);
    const x = Number.parseInt(rawX, 10);
    const y = Number.parseInt(rawY, 10);
    if (!Number.isInteger(z) || z < 10 || z > 19) {
        return res.status(400).json({ ok: false, error: 'Map tile zoom level out of allowed range (10-19).' });
    }
    const maxCoord = Math.pow(2, z);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= maxCoord || y >= maxCoord) {
        return res.status(400).json({ ok: false, error: 'Map tile x/y out of bounds for zoom level.' });
    }

    const layer = String(req.query?.layer || '').trim().toLowerCase() === 'satellite' ? 'satellite' : 'streets';
    const cacheKey = `${MAP_TILE_CACHE_VERSION}/${layer}/${z}/${x}/${y}`;

    const memHit = getMapTileFromMemory(cacheKey);
    if (memHit) {
        res.set({
            'Content-Type': memHit.contentType,
            'Cache-Control': 'private, max-age=86400',
            'X-Content-Type-Options': 'nosniff',
            'X-Map-Tile-Provider': memHit.provider,
            'X-Map-Tile-Cache': 'hit-mem'
        });
        return res.status(200).send(memHit.buffer);
    }

    const diskHit = await readMapTileFromDisk(layer, z, x, y);
    if (diskHit) {
        setMapTileInMemory(cacheKey, diskHit);
        res.set({
            'Content-Type': diskHit.contentType,
            'Cache-Control': 'private, max-age=86400',
            'X-Content-Type-Options': 'nosniff',
            'X-Map-Tile-Provider': diskHit.provider,
            'X-Map-Tile-Cache': 'hit-disk'
        });
        return res.status(200).send(diskHit.buffer);
    }

    if (isAutomatedTestEnv() && process.env.ALLOW_TEST_MAP_TILES !== 'true') {
        return res.status(502).json({ ok: false, error: 'Map tile upstream disabled in automated test mode.' });
    }

    const providers = MAP_TILE_PROVIDERS[layer] || MAP_TILE_PROVIDERS.streets;
    for (const provider of providers) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), MAP_TILE_FETCH_TIMEOUT_MS) : null;
        try {
            const upstreamUrl = provider.buildUrl(z, x, y);
            const resp = await fetch(upstreamUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': MAP_TILE_USER_AGENT,
                    'Accept': 'image/png,image/jpeg,image/webp,image/*;q=0.8'
                },
                ...(controller ? { signal: controller.signal } : {})
            });
            if (!resp || resp.status !== 200) continue;

            const rawCt = typeof resp.headers?.get === 'function'
                ? resp.headers.get('content-type')
                : (resp.headers?.['content-type'] || '');
            const cleanCt = String(rawCt || '').split(';')[0].trim().toLowerCase();
            if (!/^image\/(png|jpeg|jpg|webp)$/i.test(cleanCt)) continue;

            const buf = Buffer.from(await resp.arrayBuffer());
            if (!buf || buf.length < MAP_TILE_MIN_BYTES || buf.length > MAP_TILE_MAX_BYTES) continue;

            const detectedMime = detectMapTileImageMime(buf);
            if (!detectedMime) continue;

            setMapTileInMemory(cacheKey, {
                buffer: buf,
                contentType: detectedMime,
                provider: provider.id
            });
            writeMapTileToDisk(layer, z, x, y, buf);

            res.set({
                'Content-Type': detectedMime,
                'Cache-Control': 'private, max-age=86400',
                'X-Content-Type-Options': 'nosniff',
                'X-Map-Tile-Provider': provider.id,
                'X-Map-Tile-Cache': 'miss'
            });
            return res.status(200).send(buf);
        } catch (_) {
            // Try next tile provider cleanly
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    return res.status(502).json({ ok: false, error: 'Map tiles temporarily unavailable from upstream providers.' });
});

app.post('/api/planner/resolve-room', apiReadLimiter.middleware, requireAdmin, async (req, res) => {
    try {
        const room = String((req.body && req.body.room) || (req.query && req.query.room) || '').trim();
        const settings = await loadUserSettings(req.user.id);
        const planner = sanitizeAcademicPlanner(settings.academicPlanner);
        const campusDir = getEffectiveCampusDirectory(planner);
        const classroom = resolveItsClassroom(room, campusDir);
        res.json({ classroom, resolved: classroom });
    } catch (_err) {
        const room = String((req.body && req.body.room) || (req.query && req.query.room) || '').trim();
        const classroom = resolveItsClassroom(room);
        res.json({ classroom, resolved: classroom });
    }
});

app.post('/api/planner/sync-agenda', apiWriteLimiter.middleware, requireAdmin, preventDuplicateSubmit({ dedupeWindowMs: 2000 }), async (req, res) => {
    try {
        const settings = await loadUserSettings(req.user.id);
        const planner = sanitizeAcademicPlanner(settings.academicPlanner);
        const effectiveCampusDir = getEffectiveCampusDirectory(planner);
        const localNow = getLocalNowParts(settings.timezone);

        const rawStart = String(req.body?.begin || req.body?.weekStartDate || '');
        const begin = /^\d{4}-\d{2}-\d{2}$/.test(rawStart)
            ? rawStart
            : localNow.dateStr;
        const end = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.end || ''))
            ? String(req.body.end)
            : getDateStrDaysAgo(begin, -6);

        const existingRows = await dbQueryAsync(
            `SELECT id, DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, bloque,
                    TIME_FORMAT(hora, '%H:%i') AS hora, actividad,
                    COALESCE(tipo, 'evento') AS tipo,
                    COALESCE(categoria, 'personal') AS categoria,
                    COALESCE(estado, CASE WHEN completada = 1 THEN 'done' ELSE 'todo' END) AS estado,
                    completada, recordatorio_min, en_progreso_desde
             FROM RegistrosAgenda
             WHERE fecha BETWEEN ? AND ?
             ORDER BY fecha ASC, hora ASC`,
            [begin, end]
        );
        const existingSet = new Set(
            (Array.isArray(existingRows) ? existingRows : []).map(r => `${r.fecha}|${String(r.hora).slice(0, 5)}|${r.actividad}`)
        );

        const activeSem = planner.semesters.find(s => s.id === planner.activeSemesterId) || planner.semesters[0];
        const [by, bm, bd] = begin.split('-').map(Number);
        const [ey, em, ed] = end.split('-').map(Number);
        const startDt = new Date(Date.UTC(by, bm - 1, bd));
        const endDt = new Date(Date.UTC(ey, em - 1, ed));

        let insertedCount = 0;
        let skippedVacationDays = 0;

        for (let dt = new Date(startDt); dt <= endDt && insertedCount < 70; dt.setUTCDate(dt.getUTCDate() + 1)) {
            const dStr = dt.toISOString().slice(0, 10);
            const dayOfWeek = dt.getUTCDay();
            const vac = isDateInVacation(dStr, planner.vacations);
            if (vac) {
                skippedVacationDays += 1;
            }

            if (!vac && activeSem && dStr >= activeSem.startDate && dStr <= activeSem.endDate) {
                const dayCourses = (activeSem.courses || [])
                    .filter(c => Array.isArray(c.days) && c.days.includes(dayOfWeek))
                    .sort((a, b) => hhmmToMinutes(a.startTime) - hhmmToMinutes(b.startTime));

                for (let idx = 0; idx < dayCourses.length; idx++) {
                    const c = dayCourses[idx];
                    const roomMeta = resolveItsClassroom(c.room, effectiveCampusDir);
                    const isFirst = idx === 0 || (hhmmToMinutes(c.startTime) - hhmmToMinutes(dayCourses[idx - 1].endTime) >= 120);
                    const originInfo = resolveUserOriginCoords(planner, isFirst);
                    const commute = estimateCommuteDetails({
                        originCoords: originInfo.coords,
                        destCoords: { lat: roomMeta.lat, lng: roomMeta.lng },
                        targetMinutesOfDay: hhmmToMinutes(c.startTime),
                        weekday: dayOfWeek,
                        isFirstOfDay: isFirst,
                        nearRadiusKm: planner.nearRadiusKm || 0.5,
                        extraBufferMinutes: planner.commuteExtraBufferMinutes ?? 30,
                        repeatEveryMinutes: planner.commuteRepeatEveryMinutes ?? 5,
                        nearAlertMinutes: planner.commuteNearAlertMinutes ?? [20, 15, 10]
                    });

                    const titulo = `${c.code ? `${c.code} ` : ''}${c.name} (${roomMeta.room})`;
                    const descripcion = `${roomMeta.campusName} · ${c.startTime}-${c.endTime}${c.teacher ? ` · Prof. ${c.teacher}` : ''}`;
                    const actividad = composeAgendaActividad({ titulo, descripcion });
                    const sig = `${dStr}|${c.startTime}|${actividad}`;
                    if (existingSet.has(sig)) continue;

                    await dbQueryAsync(
                        `INSERT INTO RegistrosAgenda (fecha, bloque, hora, actividad, tipo, categoria, estado, completada, recordatorio_min, materia_id, materia_nombre)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [dStr, 'cole', c.startTime, actividad, 'evento', 'universidad', 'todo', 0, commute.recommendedLeadMinutes, c.id || null, String(c.name || '').trim().slice(0, 120) || null]
                    );
                    existingSet.add(sig);
                    insertedCount += 1;
                }
            }

            if (planner.residencias?.enabled && Array.isArray(planner.residencias.days) && planner.residencias.days.includes(dayOfWeek)) {
                const titulo = `Residencias: ${planner.residencias.projectName || planner.residencias.companyName || 'Proyecto Profesional'}`;
                const descripcion = `${planner.residencias.companyName || 'Empresa'} (${planner.residencias.startTime}-${planner.residencias.endTime})`;
                const actividad = composeAgendaActividad({ titulo, descripcion });
                const bloque = inferAgendaBlockFromTimeServer(planner.residencias.startTime, 'universidad');
                const sig = `${dStr}|${planner.residencias.startTime}|${actividad}`;
                if (!existingSet.has(sig)) {
                    await dbQueryAsync(
                        `INSERT INTO RegistrosAgenda (fecha, bloque, hora, actividad, tipo, categoria, estado, completada, recordatorio_min, materia_id, materia_nombre)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [dStr, bloque, planner.residencias.startTime, actividad, 'evento', 'universidad', 'todo', 0, Math.max(30, planner.farLeadMinutesMin || 30), null, null]
                    );
                    existingSet.add(sig);
                    insertedCount += 1;
                }
            }

            if (planner.work?.enabled && Array.isArray(planner.work.days) && planner.work.days.includes(dayOfWeek)) {
                const shiftLabel = planner.work.scheduleType === 'tiempo_completo' ? 'Tiempo Completo' : 'Medio Tiempo';
                const titulo = `Trabajo (${shiftLabel}): ${planner.work.companyName || planner.work.roleTitle || 'Jornada'}`;
                const descripcion = `${planner.work.roleTitle ? `${planner.work.roleTitle} · ` : ''}${planner.work.startTime}-${planner.work.endTime}`;
                const actividad = composeAgendaActividad({ titulo, descripcion });
                const bloque = inferAgendaBlockFromTimeServer(planner.work.startTime, 'personal');
                const sig = `${dStr}|${planner.work.startTime}|${actividad}`;
                if (!existingSet.has(sig)) {
                    await dbQueryAsync(
                        `INSERT INTO RegistrosAgenda (fecha, bloque, hora, actividad, tipo, categoria, estado, completada, recordatorio_min, materia_id, materia_nombre)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [dStr, bloque, planner.work.startTime, actividad, 'evento', 'personal', 'todo', 0, Math.max(30, planner.farLeadMinutesMin || 30), null, null]
                    );
                    existingSet.add(sig);
                    insertedCount += 1;
                }
            }
        }

        if (insertedCount > 0) {
            bumpSyncRevision('agenda');
        }
        res.json({
            message: `Synced ${insertedCount} schedule item(s) to Weekly Agenda${skippedVacationDays ? ` (${skippedVacationDays} vacation day(s) skipped)` : ''}.`,
            inserted: insertedCount,
            insertedCount,
            skippedVacationDays
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error syncing schedule to agenda.');
    }
});

const handleGetActiveOrPendingReminders = async (req, res) => {
    try {
        const state = await evaluateAndDispatchUserReminders(req.user, {
            dispatchPush: req.query.dispatchPush === '1',
            req,
            langOverride: req.query?.lang || null
        });
        res.json({
            localNow: state.localNow,
            uiLanguage: state.uiLanguage,
            active: state.active,
            pending: state.active,
            reminders: state.active,
            snoozed: state.snoozed
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error checking active reminders.');
    }
};

app.get('/api/reminders/active', apiReadLimiter.middleware, requireAdmin, handleGetActiveOrPendingReminders);
app.get('/api/reminders/pending', apiReadLimiter.middleware, requireAdmin, handleGetActiveOrPendingReminders);

async function rescheduleAgendaItemOnSnooze({ userId, key, type, refId, safeMins, snoozeSql, title, message }) {
    if (String(key || '').trim().startsWith('task-inprog:')) {
        return null;
    }
    const keyMatch = /^(?:agenda|task-pending):(\d+):/.exec(String(key || '').trim());
    const resolvedAgendaId = (type === 'agenda' && refId)
        ? parseAgendaId(refId)
        : (keyMatch ? parseAgendaId(keyMatch[1]) : null);
    if (!(type === 'agenda' || Boolean(keyMatch)) || !resolvedAgendaId) {
        return null;
    }

    const rows = await dbQueryAsync(
        `SELECT id, DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, bloque,
                TIME_FORMAT(hora, '%H:%i') AS hora, actividad,
                COALESCE(tipo, 'evento') AS tipo,
                COALESCE(categoria, 'personal') AS categoria,
                materia_id, materia_nombre,
                COALESCE(estado, CASE WHEN completada = 1 THEN 'done' ELSE 'todo' END) AS estado,
                completada, recordatorio_min
         FROM RegistrosAgenda
         WHERE id = ?
         LIMIT 1`,
        [resolvedAgendaId]
    );
    if (!Array.isArray(rows) || rows.length === 0) {
        return null;
    }

    const currentRow = rows[0];
    const settings = await loadUserSettings(userId);
    const computed = computePostponedAgendaDateTime({
        currentFecha: currentRow.fecha,
        currentHora: currentRow.hora,
        offsetMinutes: safeMins,
        nowDate: new Date(),
        timeZone: settings.timezone,
        categoria: currentRow.categoria,
        fromNow: true
    });
    const newBloque = computed.bloque;

    await dbQueryAsync(
        'UPDATE RegistrosAgenda SET fecha = ?, bloque = ?, hora = ? WHERE id = ?',
        [computed.fecha, newBloque, computed.hora, resolvedAgendaId]
    );

    const nextAgendaKey = `agenda:${resolvedAgendaId}:${computed.fecha}`;
    if (nextAgendaKey !== key) {
        await dbQueryAsync(
            `INSERT INTO RecordatoriosEstado (usuario_id, clave_unica, tipo, ref_id, titulo, mensaje, estado, snooze_hasta, enviado_push_en)
             VALUES (?, ?, 'agenda', ?, ?, ?, 'snoozed', ?, NULL)
             ON DUPLICATE KEY UPDATE estado = 'snoozed', snooze_hasta = VALUES(snooze_hasta), enviado_push_en = NULL`,
            [userId, nextAgendaKey, resolvedAgendaId, title.slice(0, 140), message.slice(0, 320), snoozeSql]
        );
    }

    bumpSyncRevision('agenda');
    return {
        rescheduled: true,
        newFecha: computed.fecha,
        newHora: computed.hora,
        newBloque
    };
}

async function applyReminderSnoozeOrDismiss({ userId, key, type = 'general', refId = null, action = 'snooze', minutes = 15, title = 'Reminder', message = '' }) {
    if (action === 'ack') {
        const baseSeriesKey = String(key || '').trim().replace(/:m\d+$/, '');
        await dbQueryAsync(
            `INSERT INTO RecordatoriosEstado (usuario_id, clave_unica, tipo, ref_id, titulo, mensaje, estado, snooze_hasta)
             VALUES (?, ?, ?, ?, ?, ?, 'dismissed', NULL)
             ON DUPLICATE KEY UPDATE estado = 'dismissed', snooze_hasta = NULL`,
            [userId, baseSeriesKey, type, refId, title.slice(0, 140), message.slice(0, 320)]
        );
        await dbQueryAsync(
            "DELETE FROM RecordatoriosEstado WHERE usuario_id = ? AND clave_unica LIKE CONCAT(?, ':m%')",
            [userId, baseSeriesKey]
        );
        return { action: 'acknowledged', key: baseSeriesKey, snoozeUntil: null };
    }

    if (action === 'dismiss') {
        await dbQueryAsync(
            `INSERT INTO RecordatoriosEstado (usuario_id, clave_unica, tipo, ref_id, titulo, mensaje, estado, snooze_hasta)
             VALUES (?, ?, ?, ?, ?, ?, 'dismissed', NULL)
             ON DUPLICATE KEY UPDATE estado = 'dismissed', snooze_hasta = NULL`,
            [userId, key, type, refId, title.slice(0, 140), message.slice(0, 320)]
        );
        return { action: 'dismissed', snoozeUntil: null };
    }

    const safeMins = Number.isInteger(Number(minutes)) && Number(minutes) >= 1 && Number(minutes) <= 240
        ? Number(minutes)
        : 15;
    const snoozeUntil = new Date(Date.now() + safeMins * 60 * 1000);
    const snoozeSql = formatMySqlDateTime(snoozeUntil);

    await dbQueryAsync(
        `INSERT INTO RecordatoriosEstado (usuario_id, clave_unica, tipo, ref_id, titulo, mensaje, estado, snooze_hasta, enviado_push_en)
         VALUES (?, ?, ?, ?, ?, ?, 'snoozed', ?, NULL)
         ON DUPLICATE KEY UPDATE estado = 'snoozed', snooze_hasta = VALUES(snooze_hasta), enviado_push_en = NULL`,
        [userId, key, type, refId, title.slice(0, 140), message.slice(0, 320), snoozeSql]
    );
    const rescheduledInfo = await rescheduleAgendaItemOnSnooze({
        userId,
        key,
        type,
        refId,
        safeMins,
        snoozeSql,
        title,
        message
    });
    return {
        action: 'snoozed',
        snoozeUntil: snoozeUntil.toISOString(),
        minutes: safeMins,
        ...(rescheduledInfo || {})
    };
}

const handleInAppReminderSnoozeOrAck = async (req, res, forcedAction = null) => {
    const key = typeof req.body.key === 'string' ? req.body.key.trim() : '';
    const rawAction = typeof forcedAction === 'string'
        ? forcedAction
        : (typeof req.body.action === 'string' ? req.body.action.trim().toLowerCase() : 'snooze');
    const action = rawAction === 'ack'
        ? 'ack'
        : (rawAction === 'skip' ? 'skip' : (rawAction === 'dismiss' ? 'dismiss' : 'snooze'));
    const type = typeof req.body.type === 'string' && req.body.type.trim() ? req.body.type.trim().slice(0, 30) : 'general';
    const settings = await loadUserSettings(req.user.id).catch(() => getDefaultUserSettings());
    const uiLang = resolveRequestUiLang({ settings, req });
    const title = typeof req.body.title === 'string' ? req.body.title : tServer(uiLang, 'reminder.default_title');
    const message = typeof req.body.message === 'string' ? req.body.message : '';
    const refId = req.body.refId ? parseAgendaId(req.body.refId) : null;

    if (!key || key.length > 120) {
        return res.status(400).send(tServer(uiLang, 'reminder.invalid_key'));
    }
    if (action === 'snooze') {
        const mins = Number(req.body.minutes ?? 15);
        if (!Number.isInteger(mins) || mins < 1 || mins > 240) {
            return res.status(400).send('Snooze minutes must be an integer between 1 and 240.');
        }
    }

    try {
        if (action === 'skip' && refId) {
            await dbQueryAsync("UPDATE RegistrosAgenda SET estado = 'skipped', completada = 0, en_progreso_desde = NULL WHERE id = ?", [refId]);
        }
        const result = await applyReminderSnoozeOrDismiss({
            userId: req.user.id,
            key,
            type,
            refId,
            action: action === 'ack' ? 'ack' : (action === 'snooze' ? 'snooze' : 'dismiss'),
            minutes: Number(req.body.minutes ?? 15),
            title,
            message
        });
        if (action === 'ack') {
            return res.json({
                ok: true,
                key: result.key || key,
                action: 'acknowledged',
                snoozeUntil: null,
                message: tServer(uiLang, 'reminder.ack_success')
            });
        }
        res.json({
            message: action === 'skip'
                ? tServer(uiLang, 'reminder.skipped')
                : (result.action === 'dismissed'
                    ? tServer(uiLang, 'reminder.dismissed')
                    : tServer(uiLang, 'reminder.postponed', { minutes: result.minutes })),
            key,
            ...result,
            action: action === 'skip' ? 'skipped' : result.action
        });
    } catch (err) {
        console.error(err);
        res.status(500).send(tServer(uiLang, 'reminder.state_error'));
    }
};

app.post('/api/reminders/snooze', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, preventDuplicateSubmit({ dedupeWindowMs: 0 }), (req, res) => {
    return handleInAppReminderSnoozeOrAck(req, res, null);
});

app.post('/api/reminders/ack', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, preventDuplicateSubmit({ dedupeWindowMs: 0 }), (req, res) => {
    return handleInAppReminderSnoozeOrAck(req, res, 'ack');
});

const handleReminderExternalAction = async (req, res) => {
    const src = {
        ...(req.query || {}),
        ...(req.body && typeof req.body === 'object' ? req.body : {})
    };
    const userId = parsePositiveInt(src.userId, 1);
    const key = typeof src.key === 'string' ? src.key.trim() : '';
    const token = typeof src.token === 'string' ? src.token.trim() : '';
    const action = typeof src.action === 'string' ? src.action.trim().toLowerCase() : 'snooze';
    const rawMins = Number(src.minutes);
    const minutes = Number.isFinite(rawMins) && rawMins >= 1 && rawMins <= 240 ? Math.round(rawMins) : 15;
    const type = typeof src.type === 'string' && src.type.trim() ? src.type.trim().slice(0, 30) : 'general';
    const refId = parsePositiveInt(src.refId, null);
    const title = typeof src.title === 'string' && src.title.trim() ? src.title.trim().slice(0, 140) : 'Reminder';
    const message = typeof src.message === 'string' ? src.message.trim().slice(0, 320) : '';

    try {
        let authorized = verifyReminderActionToken(userId, key, token);
        let effectiveUserId = userId;

        if (!authorized && req.headers && req.headers.cookie) {
            const cookies = parseCookies(req);
            const rawCookieToken = cookies.mt_session;
            if (rawCookieToken && rawCookieToken.length >= 32) {
                const tokenHash = sha256Hex(rawCookieToken);
                const nowSql = formatMySqlDateTime(new Date());
                const sessRows = await dbQueryAsync(
                    `SELECT s.id AS sesion_id, s.expira_en, u.id, u.nombre, u.email, u.rol, u.estado
                     FROM SesionesAuth s
                     INNER JOIN Usuarios u ON u.id = s.usuario_id
                     WHERE s.token_hash = ? AND s.expira_en > ?
                     LIMIT 1`,
                    [tokenHash, nowSql]
                );
                if (sessRows && sessRows.length > 0 && (sessRows[0].estado || 'activo') === 'activo' && sessRows[0].rol === 'admin') {
                    authorized = true;
                    effectiveUserId = Number(sessRows[0].id);
                }
            }
        }

        const settings = await loadUserSettings(effectiveUserId).catch(() => getDefaultUserSettings());
        const uiLang = resolveRequestUiLang({ settings, req });

        if (!authorized) {
            return res.status(401).send(tServer(uiLang, 'reminder.invalid_token'));
        }

        if (!key || key.length > 120) {
            return res.status(400).send(tServer(uiLang, 'reminder.invalid_key'));
        }

        const userRows = await dbQueryAsync('SELECT id, rol, estado FROM Usuarios WHERE id = ? LIMIT 1', [effectiveUserId]);
        if (!userRows || userRows.length === 0 || (userRows[0].estado || 'activo') !== 'activo' || userRows[0].rol !== 'admin') {
            return res.status(403).send(tServer(uiLang, 'reminder.unauthorized'));
        }

        if (key.startsWith('test:') || type === 'test') {
            const isSkipOrDismiss = action === 'skip' || action === 'dismiss';
            return res.json({
                ok: true,
                key,
                action: isSkipOrDismiss ? 'skipped' : 'snoozed',
                minutes: isSkipOrDismiss ? 0 : minutes,
                message: isSkipOrDismiss
                    ? tServer(uiLang, 'reminder.test_skipped')
                    : tServer(uiLang, 'reminder.test_snoozed', { minutes })
            });
        }

        if ((action === 'complete_agenda' || action === 'complete') && refId) {
            await dbQueryAsync("UPDATE RegistrosAgenda SET estado = 'done', completada = 1, en_progreso_desde = NULL WHERE id = ?", [refId]);
            await applyReminderSnoozeOrDismiss({
                userId: effectiveUserId,
                key,
                type: type || 'agenda',
                refId,
                action: 'dismiss',
                title,
                message
            });
            return res.json({ ok: true, action: 'complete_agenda', key, refId, message: tServer(uiLang, 'reminder.complete_agenda') });
        }

        if (action === 'ack') {
            const ackRes = await applyReminderSnoozeOrDismiss({
                userId: effectiveUserId,
                key,
                type,
                refId,
                action: 'ack',
                title,
                message
            });
            return res.json({
                ok: true,
                action: 'acknowledged',
                key: ackRes.key || key,
                message: tServer(uiLang, 'reminder.ack_success')
            });
        }

        if (action === 'skip' && refId) {
            await dbQueryAsync("UPDATE RegistrosAgenda SET estado = 'skipped', completada = 0, en_progreso_desde = NULL WHERE id = ?", [refId]);
        }

        const isDismissAction = action === 'dismiss' || action === 'skip';
        const result = await applyReminderSnoozeOrDismiss({
            userId: effectiveUserId,
            key,
            type,
            refId,
            action: isDismissAction ? 'dismiss' : 'snooze',
            minutes,
            title,
            message
        });
        return res.json({
            ok: true,
            key,
            refId: refId || null,
            message: action === 'skip'
                ? tServer(uiLang, 'reminder.skipped')
                : (result.action === 'dismissed'
                    ? tServer(uiLang, 'reminder.dismissed')
                    : tServer(uiLang, 'reminder.postponed_short', { minutes: result.minutes })),
            ...result,
            action: action === 'skip' ? 'skipped' : result.action
        });
    } catch (err) {
        console.error(err);
        return res.status(500).send(tServer('en', 'reminder.action_error'));
    }
};

app.post('/api/reminders/action', reminderActionLimiter.middleware, handleReminderExternalAction);
app.get('/api/reminders/action', reminderActionLimiter.middleware, handleReminderExternalAction);

// =========================================================================
// APRENDIZAJE DE INGLÉS CON MÚSICA (SÓLO METADATOS EN MYSQL + YOUTUBE MUSIC)
// Las notas largas y fragmentos de estudio se envían cifrados E2EE a Word (.docx).
// =========================================================================
const MUSIC_RELEASE_TYPES = new Set(['album', 'mini_album', 'ep', 'single', 'ost', 'collab_single']);
const MUSIC_STUDY_STATES = new Set(['to_study', 'in_progress', 'mastered']);
const MUSIC_ARTIST_ROLES = new Set(['main', 'feat', 'collab', 'producer']);
const YOUTUBE_ALLOWED_HOSTS = new Set([
    'music.youtube.com',
    'www.youtube.com',
    'youtube.com',
    'm.youtube.com',
    'youtu.be'
]);

const YOUTUBE_TITLE_NOISE_RE = /\s*(?:\((?:official(?:\s+(?:music\s+)?(?:video|m\/?v|audio|lyric(?:s)?\s+video|visualizer|performance\s+video))?|m\/?v|mv|lyrics?|lyric\s+video|audio|hd|4k|color\s+coded(?:\s+lyrics)?|eng(?:\/esp|\/kor|\/jpn)?\s+sub(?:s)?)\)|\[(?:official(?:\s+(?:music\s+)?(?:video|m\/?v|audio|lyric(?:s)?\s+video|visualizer|performance\s+video))?|m\/?v|mv|lyrics?|lyric\s+video|audio|hd|4k|color\s+coded(?:\s+lyrics)?|eng(?:\/esp|\/kor|\/jpn)?\s+sub(?:s)?)\])[\s!?.,;:~·•\-]*$/i;

function normalizarTextoCatalogo(valor) {
    return String(valor || '')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/[’‘ʼ]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/[–—]/g, '-')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function quitarRuidoTituloCatalogo(valor) {
    let clean = String(valor || '')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .trim()
        .replace(/\s+/g, ' ');
    while (clean) {
        const next = clean.replace(YOUTUBE_TITLE_NOISE_RE, '').trim();
        if (next === clean) break;
        clean = next;
    }
    return clean;
}

function normalizarClaveFuzzyCatalogo(valor, { stripYouTubeNoise = false } = {}) {
    const raw = stripYouTubeNoise ? quitarRuidoTituloCatalogo(valor) : String(valor || '');
    const base = normalizarTextoCatalogo(raw);
    if (!base) return '';
    const noMarks = base.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    const alnum = noMarks.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    return alnum || noMarks;
}

function distanciaEdicionAcotada(a, b, maxDist = 2) {
    if (a === b) return 0;
    const lenA = a.length;
    const lenB = b.length;
    if (Math.abs(lenA - lenB) > maxDist) return maxDist + 1;
    let prev = new Array(lenB + 1);
    let curr = new Array(lenB + 1);
    for (let j = 0; j <= lenB; j++) prev[j] = j;
    for (let i = 1; i <= lenA; i++) {
        curr[0] = i;
        let rowMin = curr[0];
        const chA = a.charCodeAt(i - 1);
        for (let j = 1; j <= lenB; j++) {
            const cost = chA === b.charCodeAt(j - 1) ? 0 : 1;
            const val = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
            curr[j] = val;
            if (val < rowMin) rowMin = val;
        }
        if (rowMin > maxDist) return maxDist + 1;
        const tmp = prev;
        prev = curr;
        curr = tmp;
    }
    return prev[lenB];
}

function esTypoCercanoCatalogo(a, b) {
    if (!a || !b) return false;
    const minLen = Math.min(a.length, b.length);
    if (minLen < 5) return false;
    if (minLen >= 9 && a[0] === b[0]) {
        return distanciaEdicionAcotada(a, b, 2) <= 2;
    }
    if (a[0] === b[0] || minLen >= 6) {
        return distanciaEdicionAcotada(a, b, 1) <= 1;
    }
    return false;
}

function buildStandardYouTubeUrl({ videoId, ytMusicUrl }) {
    const cleanId = String(videoId || '').trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(cleanId)) {
        return `https://www.youtube.com/watch?v=${cleanId}`;
    }

    const rawUrl = String(ytMusicUrl || '').trim();
    if (!rawUrl) return null;

    try {
        const parsed = new URL(rawUrl);
        const vParam = parsed.searchParams.get('v');
        if (vParam && /^[A-Za-z0-9_-]{11}$/.test(vParam)) {
            return `https://www.youtube.com/watch?v=${vParam}`;
        }
        const listParam = parsed.searchParams.get('list');
        if (listParam && /^[A-Za-z0-9_-]{10,80}$/.test(listParam)) {
            return `https://www.youtube.com/playlist?list=${encodeURIComponent(listParam)}`;
        }
        if (parsed.pathname === '/search' && parsed.searchParams.get('q')) {
            return `https://www.youtube.com/results?search_query=${encodeURIComponent(parsed.searchParams.get('q').slice(0, 120))}`;
        }
        if (parsed.pathname === '/' || parsed.pathname === '') {
            return 'https://www.youtube.com/';
        }
        return rawUrl;
    } catch (_err) {
        return null;
    }
}

function parseYouTubeMusicInput(rawInput) {
    const trimmed = String(rawInput || '').trim();
    if (!trimmed) {
        return { valid: true, videoId: null, ytMusicUrl: null, youtubeUrl: null, thumbnailUrl: null };
    }

    // Permitir ingresar únicamente el ID de 11 caracteres si el usuario lo prefiere
    if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) {
        return {
            valid: true,
            videoId: trimmed,
            ytMusicUrl: `https://music.youtube.com/watch?v=${trimmed}`,
            youtubeUrl: `https://www.youtube.com/watch?v=${trimmed}`,
            thumbnailUrl: `https://i.ytimg.com/vi/${trimmed}/hqdefault.jpg`
        };
    }

    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch (_err) {
        return { valid: false, error: 'Invalid YouTube / YouTube Music URL.' };
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return { valid: false, error: 'YouTube Music URL must use HTTPS.' };
    }

    if (parsed.username || parsed.password) {
        return { valid: false, error: 'URLs cannot contain embedded credentials.' };
    }

    const host = parsed.hostname.toLowerCase();
    if (!YOUTUBE_ALLOWED_HOSTS.has(host)) {
        return { valid: false, error: 'Only youtube.com, music.youtube.com, or youtu.be URLs are allowed.' };
    }

    let videoId = null;
    if (host === 'youtu.be') {
        const candidate = parsed.pathname.replace(/^\/+/, '').split('/')[0];
        if (/^[A-Za-z0-9_-]{11}$/.test(candidate)) videoId = candidate;
    } else {
        const vParam = parsed.searchParams.get('v');
        if (vParam && /^[A-Za-z0-9_-]{11}$/.test(vParam)) {
            videoId = vParam;
        } else {
            const pathMatch = parsed.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
            if (pathMatch) videoId = pathMatch[1];
        }
    }

    if (videoId) {
        return {
            valid: true,
            videoId,
            ytMusicUrl: `https://music.youtube.com/watch?v=${videoId}`,
            youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
            thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
        };
    }

    const listParam = parsed.searchParams.get('list');
    if (listParam && /^[A-Za-z0-9_-]{10,80}$/.test(listParam)) {
        return {
            valid: true,
            videoId: null,
            ytMusicUrl: `https://music.youtube.com/playlist?list=${encodeURIComponent(listParam)}`,
            youtubeUrl: `https://www.youtube.com/playlist?list=${encodeURIComponent(listParam)}`,
            thumbnailUrl: null
        };
    }

    if (host === 'music.youtube.com') {
        const cleanParams = new URLSearchParams();
        if (parsed.pathname === '/search' && parsed.searchParams.get('q')) {
            cleanParams.set('q', parsed.searchParams.get('q').slice(0, 120));
        }
        const suffix = cleanParams.toString() ? `?${cleanParams.toString()}` : '';
        const ytMusicUrl = `https://music.youtube.com${parsed.pathname}${suffix}`.slice(0, 490);
        return {
            valid: true,
            videoId: null,
            ytMusicUrl,
            youtubeUrl: buildStandardYouTubeUrl({ videoId: null, ytMusicUrl }),
            thumbnailUrl: null
        };
    }

    return { valid: false, error: 'Could not extract a valid YouTube Music track, video, or playlist link.' };
}

function parseCollaboratorsInput(rawCollaborators, mainArtistName) {
    const mainNorm = normalizarTextoCatalogo(mainArtistName);
    const seen = new Set(mainNorm ? [mainNorm] : []);
    const result = [];

    let items = [];
    if (Array.isArray(rawCollaborators)) {
        items = rawCollaborators;
    } else if (typeof rawCollaborators === 'string' && rawCollaborators.trim()) {
        items = rawCollaborators.split(/[,;&\n]+/).map(part => {
            const cleaned = part.trim();
            const featMatch = cleaned.match(/^(?:feat\.?|ft\.?)\s+(.+)$/i);
            return featMatch ? { nombre: featMatch[1], rol: 'feat' } : { nombre: cleaned, rol: 'collab' };
        });
    }

    for (const item of items) {
        const nombre = String(typeof item === 'string' ? item : (item && item.nombre) || '').trim().replace(/\s+/g, ' ');
        if (!nombre || nombre.length > 140) continue;
        const norm = normalizarTextoCatalogo(nombre);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        const rawRol = String((item && item.rol) || 'collab').trim().toLowerCase();
        const rol = MUSIC_ARTIST_ROLES.has(rawRol) && rawRol !== 'main' ? rawRol : 'collab';
        result.push({ nombre, rol });
        if (result.length >= 8) break;
    }
    return result;
}

async function upsertMusicaArtista(usuarioId, nombre, tipoArtista = 'solo', { updateExisting = false } = {}) {
    const cleanName = String(nombre || '').trim().replace(/\s+/g, ' ').slice(0, 140);
    const norm = normalizarTextoCatalogo(cleanName);
    if (!norm) return null;

    const tipo = ['solo', 'group', 'duo', 'collab_project'].includes(tipoArtista) ? tipoArtista : 'solo';
    const existing = await dbQueryAsync(
        'SELECT id FROM MusicaArtistas WHERE usuario_id = ? AND nombre_normalizado = ? LIMIT 1',
        [usuarioId, norm]
    );
    if (existing.length) {
        if (updateExisting) {
            await dbQueryAsync(
                'UPDATE MusicaArtistas SET nombre = ?, tipo_artista = ? WHERE id = ? AND usuario_id = ?',
                [cleanName, tipo, existing[0].id, usuarioId]
            );
        }
        return existing[0].id;
    }

    const fuzzyNorm = normalizarClaveFuzzyCatalogo(cleanName);
    if (fuzzyNorm) {
        const allArtists = await dbQueryAsync(
            'SELECT id, nombre, tipo_artista, notas_cortas, creado_en FROM MusicaArtistas WHERE usuario_id = ? ORDER BY nombre ASC',
            [usuarioId]
        );
        const fuzzyMatch = (allArtists || []).find((a) => normalizarClaveFuzzyCatalogo(a.nombre) === fuzzyNorm);
        if (fuzzyMatch) {
            if (updateExisting) {
                await dbQueryAsync(
                    'UPDATE MusicaArtistas SET nombre = ?, tipo_artista = ? WHERE id = ? AND usuario_id = ?',
                    [fuzzyMatch.nombre || cleanName, tipo, fuzzyMatch.id, usuarioId]
                );
            }
            return fuzzyMatch.id;
        }
    }

    const inserted = await dbQueryAsync(
        'INSERT INTO MusicaArtistas (usuario_id, nombre, nombre_normalizado, tipo_artista) VALUES (?, ?, ?, ?)',
        [usuarioId, cleanName, norm, tipo]
    );
    return inserted.insertId;
}

async function upsertMusicaAlbum({ usuarioId, albumTitle, albumType, albumYear, mainArtistId }) {
    const cleanTitle = String(albumTitle || '').trim().replace(/\s+/g, ' ').slice(0, 180);
    const norm = normalizarTextoCatalogo(cleanTitle);
    if (!norm) return null;

    const tipo = MUSIC_RELEASE_TYPES.has(albumType) ? albumType : 'album';
    const yearVal = albumYear && Number.isInteger(Number(albumYear)) && Number(albumYear) >= 1900 && Number(albumYear) <= 2100
        ? Number(albumYear)
        : null;

    const existing = await dbQueryAsync(
        `SELECT id FROM MusicaAlbumes
         WHERE usuario_id = ? AND titulo_normalizado = ? AND COALESCE(artista_principal_id, 0) = COALESCE(?, 0)
         LIMIT 1`,
        [usuarioId, norm, mainArtistId || null]
    );
    if (existing.length) {
        await dbQueryAsync(
            'UPDATE MusicaAlbumes SET tipo_lanzamiento = ?, anio = COALESCE(?, anio) WHERE id = ? AND usuario_id = ?',
            [tipo, yearVal, existing[0].id, usuarioId]
        );
        return existing[0].id;
    }

    const fuzzyNorm = normalizarClaveFuzzyCatalogo(cleanTitle);
    if (fuzzyNorm) {
        const { albums } = await fetchUserMusicAlbumsAndSongs(usuarioId);
        const fuzzyMatch = (albums || []).find(
            (al) => Number(al.artista_principal_id || 0) === Number(mainArtistId || 0)
                && normalizarClaveFuzzyCatalogo(al.titulo) === fuzzyNorm
        );
        if (fuzzyMatch) {
            await dbQueryAsync(
                'UPDATE MusicaAlbumes SET tipo_lanzamiento = ?, anio = COALESCE(?, anio) WHERE id = ? AND usuario_id = ?',
                [tipo, yearVal, fuzzyMatch.id, usuarioId]
            );
            return fuzzyMatch.id;
        }
    }

    const inserted = await dbQueryAsync(
        `INSERT INTO MusicaAlbumes (usuario_id, artista_principal_id, titulo, titulo_normalizado, tipo_lanzamiento, anio)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [usuarioId, mainArtistId || null, cleanTitle, norm, tipo, yearVal]
    );
    return inserted.insertId;
}

async function findExistingUserSongMatch({
    usuarioId,
    titulo,
    mainArtistId = null,
    mainArtistName = '',
    ytVideoId = null,
    excludeSongId = null
}) {
    const { songs } = await fetchUserMusicAlbumsAndSongs(usuarioId);
    if (!songs || !songs.length) return null;

    const artistLinks = await dbQueryAsync(
        `SELECT mca.cancion_id, mca.artista_id, mca.rol, mca.orden, ma.nombre
         FROM MusicaCancionArtistas mca
         JOIN MusicaArtistas ma ON ma.id = mca.artista_id
         JOIN MusicaCanciones mc ON mc.id = mca.cancion_id
         WHERE mc.usuario_id = ?
         ORDER BY mca.orden ASC, mca.artista_id ASC`,
        [usuarioId]
    );
    const linksBySong = new Map();
    for (const link of (artistLinks || [])) {
        const sid = Number(link.cancion_id);
        if (!linksBySong.has(sid)) linksBySong.set(sid, []);
        linksBySong.get(sid).push(link);
    }

    const cleanVideoId = String(ytVideoId || '').trim();
    const newTitleKey = normalizarClaveFuzzyCatalogo(titulo, { stripYouTubeNoise: true });
    const newArtistKey = normalizarClaveFuzzyCatalogo(mainArtistName);
    let typoMatch = null;

    for (const s of songs) {
        if (excludeSongId && Number(s.id) === Number(excludeSongId)) continue;
        const songLinks = linksBySong.get(Number(s.id)) || [];
        if (cleanVideoId && s.yt_video_id && String(s.yt_video_id).trim() === cleanVideoId) {
            return { matchType: 'exact_video', song: { ...s, artists: songLinks } };
        }
        const mainLink = songLinks.find((l) => l.rol === 'main') || songLinks[0] || null;
        const sameArtist = (mainLink && mainArtistId && Number(mainLink.artista_id) === Number(mainArtistId))
            || Boolean(mainLink && newArtistKey && normalizarClaveFuzzyCatalogo(mainLink.nombre) === newArtistKey)
            || (!songLinks.length);
        if (!sameArtist) continue;

        const existingTitleKey = normalizarClaveFuzzyCatalogo(s.titulo, { stripYouTubeNoise: true });
        if (!newTitleKey || !existingTitleKey) continue;
        if (existingTitleKey === newTitleKey) {
            return { matchType: 'exact_title', song: { ...s, artists: songLinks } };
        }
        if (mainLink && !typoMatch && esTypoCercanoCatalogo(newTitleKey, existingTitleKey)) {
            typoMatch = { matchType: 'possible_typo', song: { ...s, artists: songLinks } };
        }
    }

    return typoMatch;
}

function validateAndExtractSongPayload(body) {
    const titulo = String(body.titulo || body.title || '').trim().replace(/\s+/g, ' ');
    const mainArtist = String(body.mainArtist || body.artistaPrincipal || '').trim().replace(/\s+/g, ' ');
    if (!titulo || titulo.length > 180) {
        return { error: 'Song title is required (max 180 characters).' };
    }
    if (!mainArtist || mainArtist.length > 140) {
        return { error: 'Main artist or group name is required (max 140 characters).' };
    }

    const enfoqueRaw = String(body.enfoqueCorto || body.focus || '').trim();
    if (enfoqueRaw.length > 255 || enfoqueRaw.split(/\r?\n/).length > 4) {
        return {
            error: 'Short study focus must be <= 255 chars. Keep long lyrics & translations encrypted to Word on your PC.'
        };
    }

    const ytParsed = parseYouTubeMusicInput(body.ytMusicUrl || body.youtubeUrl || '');
    if (!ytParsed.valid) {
        return { error: ytParsed.error };
    }

    const albumTitle = String(body.albumTitle || '').trim().replace(/\s+/g, ' ');
    if (albumTitle.length > 180) {
        return { error: 'Album / Mini Album title must be <= 180 characters.' };
    }

    const rawType = String(body.albumType || 'album').trim().toLowerCase();
    const albumType = MUSIC_RELEASE_TYPES.has(rawType) ? rawType : 'album';

    let albumYear = null;
    if (body.albumYear !== undefined && body.albumYear !== null && String(body.albumYear).trim() !== '') {
        const y = Number.parseInt(body.albumYear, 10);
        if (!Number.isInteger(y) || y < 1900 || y > 2100) {
            return { error: 'Album release year must be between 1900 and 2100.' };
        }
        albumYear = y;
    }

    let numeroPista = null;
    if (body.trackNumber !== undefined && body.trackNumber !== null && String(body.trackNumber).trim() !== '') {
        const n = Number.parseInt(body.trackNumber, 10);
        if (!Number.isInteger(n) || n < 1 || n > 999) {
            return { error: 'Track number must be between 1 and 999.' };
        }
        numeroPista = n;
    }

    const rawState = String(body.estadoEstudio || body.status || 'to_study').trim().toLowerCase();
    const estadoEstudio = MUSIC_STUDY_STATES.has(rawState) ? rawState : 'to_study';
    const idioma = String(body.idioma || body.language || 'English').trim().slice(0, 40) || 'English';
    const artistType = ['solo', 'group', 'duo', 'collab_project'].includes(body.artistType)
        ? body.artistType
        : 'solo';
    const collaborators = parseCollaboratorsInput(body.collaborators, mainArtist);

    return {
        data: {
            titulo,
            mainArtist,
            artistType,
            collaborators,
            albumTitle,
            albumType,
            albumYear,
            numeroPista,
            idioma,
            ytMusicUrl: ytParsed.ytMusicUrl,
            youtubeUrl: ytParsed.youtubeUrl,
            ytVideoId: ytParsed.videoId,
            thumbnailUrl: ytParsed.thumbnailUrl,
            estadoEstudio,
            enfoqueCorto: enfoqueRaw || null
        }
    };
}

async function ensureMusicaSchemaExtraColumns() {
    await Promise.all([
        dbQueryAsync('ALTER TABLE MusicaAlbumes ADD COLUMN fecha_lanzamiento DATE NULL DEFAULT NULL AFTER anio').catch(() => {}),
        dbQueryAsync('ALTER TABLE MusicaCanciones ADD COLUMN anio SMALLINT NULL AFTER idioma').catch(() => {})
    ]);
}

function isUnknownColumnDbError(err) {
    return Boolean(err && (err.code === 'ER_BAD_FIELD_ERROR' || /Unknown column/i.test(err.message || '')));
}

async function fetchUserMusicAlbumsAndSongs(uid) {
    const queryWithReleaseDate = () => Promise.all([
        dbQueryAsync(
            `SELECT al.id, al.artista_principal_id, ma.nombre AS artista_principal_nombre,
                    al.titulo, al.tipo_lanzamiento, al.anio, al.notas_cortas, al.creado_en,
                    DATE_FORMAT(al.fecha_lanzamiento, '%Y-%m-%d') AS fecha_lanzamiento
             FROM MusicaAlbumes al
             LEFT JOIN MusicaArtistas ma ON ma.id = al.artista_principal_id
             WHERE al.usuario_id = ?
             ORDER BY COALESCE(al.fecha_lanzamiento, CONCAT(COALESCE(al.anio, 0), '-01-01')) DESC, al.titulo ASC`,
            [uid]
        ),
        dbQueryAsync(
            `SELECT c.id, c.album_id, al.titulo AS album_titulo, al.tipo_lanzamiento AS album_tipo,
                    COALESCE(al.anio, c.anio) AS album_anio, c.anio AS cancion_anio,
                    DATE_FORMAT(al.fecha_lanzamiento, '%Y-%m-%d') AS album_fecha_lanzamiento,
                    c.titulo, c.numero_pista, c.idioma,
                    c.yt_music_url, c.yt_video_id, c.thumbnail_url, c.estado_estudio,
                    c.enfoque_corto, c.word_sincronizado,
                    c.ultimo_estudio_en, c.creado_en, c.actualizado_en
             FROM MusicaCanciones c
             LEFT JOIN MusicaAlbumes al ON al.id = c.album_id
             WHERE c.usuario_id = ?
             ORDER BY c.actualizado_en DESC, c.id DESC`,
            [uid]
        )
    ]);

    try {
        const [albums, songs] = await queryWithReleaseDate();
        return { albums, songs };
    } catch (err) {
        if (isUnknownColumnDbError(err)) {
            await ensureMusicaSchemaExtraColumns();
            try {
                const [albums, songs] = await queryWithReleaseDate();
                return { albums, songs };
            } catch (_) {
                const [albums, songs] = await Promise.all([
                    dbQueryAsync(
                        `SELECT al.id, al.artista_principal_id, ma.nombre AS artista_principal_nombre,
                                al.titulo, al.tipo_lanzamiento, al.anio, al.notas_cortas, al.creado_en,
                                NULL AS fecha_lanzamiento
                         FROM MusicaAlbumes al
                         LEFT JOIN MusicaArtistas ma ON ma.id = al.artista_principal_id
                         WHERE al.usuario_id = ?
                         ORDER BY COALESCE(al.anio, 0) DESC, al.titulo ASC`,
                        [uid]
                    ),
                    dbQueryAsync(
                        `SELECT c.id, c.album_id, al.titulo AS album_titulo, al.tipo_lanzamiento AS album_tipo,
                                al.anio AS album_anio, NULL AS cancion_anio, NULL AS album_fecha_lanzamiento,
                                c.titulo, c.numero_pista, c.idioma,
                                c.yt_music_url, c.yt_video_id, c.thumbnail_url, c.estado_estudio,
                                c.enfoque_corto, c.word_sincronizado,
                                c.ultimo_estudio_en, c.creado_en, c.actualizado_en
                         FROM MusicaCanciones c
                         LEFT JOIN MusicaAlbumes al ON al.id = c.album_id
                         WHERE c.usuario_id = ?
                         ORDER BY c.actualizado_en DESC, c.id DESC`,
                        [uid]
                    )
                ]);
                return { albums, songs };
            }
        }
        throw err;
    }
}

async function insertMusicaCancionRow(valuesWithAnio) {
    const [uid, albumId, titulo, numPista, idioma, anio, ytMusicUrl, ytVideoId, thumbUrl, estadoEstudio, enfoqueCorto, wordSync] = valuesWithAnio;
    const includeWordSync = wordSync !== undefined;
    const insertWithAnio = () => (
        includeWordSync
            ? dbQueryAsync(
                `INSERT INTO MusicaCanciones
                 (usuario_id, album_id, titulo, numero_pista, idioma, anio, yt_music_url, yt_video_id, thumbnail_url, estado_estudio, enfoque_corto, word_sincronizado)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [uid, albumId, titulo, numPista, idioma, anio, ytMusicUrl, ytVideoId, thumbUrl, estadoEstudio, enfoqueCorto, wordSync]
            )
            : dbQueryAsync(
                `INSERT INTO MusicaCanciones
                 (usuario_id, album_id, titulo, numero_pista, idioma, anio, yt_music_url, yt_video_id, thumbnail_url, estado_estudio, enfoque_corto)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [uid, albumId, titulo, numPista, idioma, anio, ytMusicUrl, ytVideoId, thumbUrl, estadoEstudio, enfoqueCorto]
            )
    );
    const insertLegacy = () => (
        includeWordSync
            ? dbQueryAsync(
                `INSERT INTO MusicaCanciones
                 (usuario_id, album_id, titulo, numero_pista, idioma, yt_music_url, yt_video_id, thumbnail_url, estado_estudio, enfoque_corto, word_sincronizado)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [uid, albumId, titulo, numPista, idioma, ytMusicUrl, ytVideoId, thumbUrl, estadoEstudio, enfoqueCorto, wordSync]
            )
            : dbQueryAsync(
                `INSERT INTO MusicaCanciones
                 (usuario_id, album_id, titulo, numero_pista, idioma, yt_music_url, yt_video_id, thumbnail_url, estado_estudio, enfoque_corto)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [uid, albumId, titulo, numPista, idioma, ytMusicUrl, ytVideoId, thumbUrl, estadoEstudio, enfoqueCorto]
            )
    );
    try {
        return await insertWithAnio();
    } catch (err) {
        if (!isUnknownColumnDbError(err)) throw err;
        await ensureMusicaSchemaExtraColumns();
        try {
            return await insertWithAnio();
        } catch (retryErr) {
            if (!isUnknownColumnDbError(retryErr)) throw retryErr;
            return await insertLegacy();
        }
    }
}

async function tryRestoreMusicCatalogFromDriveIfEmpty(uid) {
    const archive = await loadDriveHistoricalArchiveInRam();
    if (!archive || typeof archive !== 'object') return false;

    const archArtists = Object.values(archive.music_artists || {});
    const archAlbums = Object.values(archive.music_albums || {});
    const archSongs = Object.values(archive.music_songs || {});
    const archLinks = Object.values(archive.music_song_artists || {});
    if (!archSongs.length && !archAlbums.length && !archArtists.length) return false;

    const artistByOldId = new Map();
    for (const a of archArtists) {
        if (!a || !a.nombre) continue;
        const newId = await upsertMusicaArtista(uid, a.nombre, a.tipo_artista || 'solo').catch(() => null);
        if (newId && a.id != null) artistByOldId.set(Number(a.id), { newId, nombre: a.nombre });
    }

    const albumByOldId = new Map();
    for (const al of archAlbums) {
        if (!al || !al.titulo) continue;
        const mappedMain = al.artista_principal_id != null ? artistByOldId.get(Number(al.artista_principal_id)) : null;
        const newId = await upsertMusicaAlbum({
            usuarioId: uid,
            mainArtistId: mappedMain ? mappedMain.newId : null,
            albumTitle: al.titulo,
            albumType: al.tipo_lanzamiento || 'album',
            albumYear: al.anio || null
        }).catch(() => null);
        if (newId && al.id != null) albumByOldId.set(Number(al.id), newId);
    }

    const linksByOldSong = new Map();
    for (const lk of archLinks) {
        if (!lk || lk.cancion_id == null) continue;
        const sid = Number(lk.cancion_id);
        if (!linksByOldSong.has(sid)) linksByOldSong.set(sid, []);
        linksByOldSong.get(sid).push(lk);
    }

    let restoredCount = 0;
    for (const s of archSongs) {
        if (!s || !s.titulo) continue;
        const mappedAlbumId = s.album_id != null ? (albumByOldId.get(Number(s.album_id)) || null) : null;
        const songYear = Number.isInteger(Number(s.anio || s.cancion_anio || s.album_anio))
            ? Number(s.anio || s.cancion_anio || s.album_anio)
            : null;
        const ins = await insertMusicaCancionRow([
            uid,
            mappedAlbumId,
            String(s.titulo).slice(0, 180),
            s.numero_pista || null,
            s.idioma || 'English',
            songYear,
            s.yt_music_url || null,
            s.yt_video_id || null,
            s.thumbnail_url || null,
            MUSIC_STUDY_STATES.has(s.estado_estudio) ? s.estado_estudio : 'to_study',
            s.enfoque_corto || null,
            s.word_sincronizado ? 1 : 0
        ]).catch(() => null);
        const newSongId = ins && ins.insertId;
        if (!newSongId) continue;
        restoredCount += 1;
        const songLinks = linksByOldSong.get(Number(s.id)) || [];
        for (const lk of songLinks) {
            const art = artistByOldId.get(Number(lk.artista_id));
            if (!art) continue;
            await dbQueryAsync(
                `INSERT IGNORE INTO MusicaCancionArtistas (cancion_id, artista_id, rol, orden)
                 VALUES (?, ?, ?, ?)`,
                [newSongId, art.newId, lk.rol || 'main', lk.orden || 1]
            ).catch(() => {});
        }
    }
    return restoredCount > 0 || albumByOldId.size > 0 || artistByOldId.size > 0;
}

app.get('/api/english/music/catalog', apiReadLimiter.middleware, requireAdmin, async (req, res) => {
    try {
        const uid = req.user.id;
        let [artists, albumsAndSongs, songArtists] = await Promise.all([
            dbQueryAsync(
                `SELECT id, nombre, tipo_artista, notas_cortas, creado_en
                 FROM MusicaArtistas WHERE usuario_id = ? ORDER BY nombre ASC`,
                [uid]
            ),
            fetchUserMusicAlbumsAndSongs(uid),
            dbQueryAsync(
                `SELECT mca.cancion_id, mca.artista_id, mca.rol, mca.orden, ma.nombre
                 FROM MusicaCancionArtistas mca
                 INNER JOIN MusicaCanciones c ON c.id = mca.cancion_id
                 INNER JOIN MusicaArtistas ma ON ma.id = mca.artista_id
                 WHERE c.usuario_id = ?
                 ORDER BY mca.orden ASC, ma.nombre ASC`,
                [uid]
            )
        ]);
        if (artists.length === 0 && albumsAndSongs.albums.length === 0 && albumsAndSongs.songs.length === 0) {
            const restored = await tryRestoreMusicCatalogFromDriveIfEmpty(uid).catch(() => false);
            if (restored) {
                [artists, albumsAndSongs, songArtists] = await Promise.all([
                    dbQueryAsync(
                        `SELECT id, nombre, tipo_artista, notas_cortas, creado_en
                         FROM MusicaArtistas WHERE usuario_id = ? ORDER BY nombre ASC`,
                        [uid]
                    ),
                    fetchUserMusicAlbumsAndSongs(uid),
                    dbQueryAsync(
                        `SELECT mca.cancion_id, mca.artista_id, mca.rol, mca.orden, ma.nombre
                         FROM MusicaCancionArtistas mca
                         INNER JOIN MusicaCanciones c ON c.id = mca.cancion_id
                         INNER JOIN MusicaArtistas ma ON ma.id = mca.artista_id
                         WHERE c.usuario_id = ?
                         ORDER BY mca.orden ASC, ma.nombre ASC`,
                        [uid]
                    )
                ]);
            }
        }
        const { albums, songs } = albumsAndSongs;

        const artistsBySong = new Map();
        for (const link of songArtists) {
            if (!artistsBySong.has(link.cancion_id)) artistsBySong.set(link.cancion_id, []);
            artistsBySong.get(link.cancion_id).push({
                id: link.artista_id,
                nombre: link.nombre,
                rol: link.rol,
                orden: link.orden
            });
        }

        const enrichedSongs = songs.map(song => {
            const youtubeUrl = buildStandardYouTubeUrl({
                videoId: song.yt_video_id || song.youtube_video_id,
                ytMusicUrl: song.yt_music_url
            });
            return {
                ...song,
                word_sincronizado: Boolean(song.word_sincronizado),
                youtube_url: youtubeUrl,
                youtubeUrl,
                artists: artistsBySong.get(song.id) || []
            };
        });

        const stats = {
            totalSongs: enrichedSongs.length,
            totalArtists: artists.length,
            totalAlbums: albums.length,
            toStudy: enrichedSongs.filter(s => s.estado_estudio === 'to_study').length,
            inProgress: enrichedSongs.filter(s => s.estado_estudio === 'in_progress').length,
            mastered: enrichedSongs.filter(s => s.estado_estudio === 'mastered').length,
            wordSynced: enrichedSongs.filter(s => s.word_sincronizado).length
        };

        res.json({ artists, albums, songs: enrichedSongs, stats });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error loading English music catalog.');
    }
});

app.get('/api/english/music/search', apiReadLimiter.middleware, requireAdmin, async (req, res) => {
    const queryText = String(req.query.q || '').trim().slice(0, 120);
    const ytMusicSearchUrl = queryText
        ? `https://music.youtube.com/search?q=${encodeURIComponent(queryText)}`
        : 'https://music.youtube.com/';
    const ytMusicLibraryUrl = 'https://music.youtube.com/library';
    const youtubeSearchUrl = queryText
        ? `https://www.youtube.com/results?search_query=${encodeURIComponent(queryText)}`
        : 'https://www.youtube.com/';
    const youtubeHomeUrl = 'https://www.youtube.com/';

    const apiKey = String(process.env.YOUTUBE_API_KEY || '').trim();
    if (!apiKey || !queryText) {
        return res.json({
            configured: Boolean(apiKey),
            ytMusicSearchUrl,
            ytMusicLibraryUrl,
            youtubeSearchUrl,
            youtubeHomeUrl,
            results: []
        });
    }

    try {
        const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
        searchUrl.searchParams.set('part', 'snippet');
        searchUrl.searchParams.set('type', 'video');
        searchUrl.searchParams.set('videoCategoryId', '10');
        searchUrl.searchParams.set('maxResults', '8');
        searchUrl.searchParams.set('q', queryText);
        searchUrl.searchParams.set('key', apiKey);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const apiRes = await fetch(searchUrl.toString(), { signal: controller.signal });
        clearTimeout(timer);

        if (!apiRes.ok) {
            return res.json({
                configured: true,
                apiUnavailable: true,
                ytMusicSearchUrl,
                ytMusicLibraryUrl,
                youtubeSearchUrl,
                youtubeHomeUrl,
                results: []
            });
        }

        const payload = await apiRes.json();
        const results = (Array.isArray(payload.items) ? payload.items : [])
            .map(item => {
                const videoId = item && item.id && item.id.videoId;
                const snippet = (item && item.snippet) || {};
                if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
                return {
                    videoId,
                    title: String(snippet.title || '').slice(0, 180),
                    channelTitle: String(snippet.channelTitle || '').replace(/\s*-\s*Topic$/i, '').slice(0, 140),
                    ytMusicUrl: `https://music.youtube.com/watch?v=${videoId}`,
                    youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
                    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
                };
            })
            .filter(Boolean);

        return res.json({
            configured: true,
            ytMusicSearchUrl,
            ytMusicLibraryUrl,
            youtubeSearchUrl,
            youtubeHomeUrl,
            results
        });
    } catch (_err) {
        return res.json({
            configured: Boolean(apiKey),
            apiUnavailable: true,
            ytMusicSearchUrl,
            ytMusicLibraryUrl,
            youtubeSearchUrl,
            youtubeHomeUrl,
            results: []
        });
    }
});

async function fetchExternalWithTimeout(url, { timeoutMs = 4500, headers = {}, asJson = false, maxBytes = 1200000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetch(url, { signal: controller.signal, headers });
        if (!resp || !resp.ok) return null;
        if (asJson) return await resp.json();
        const text = await resp.text();
        return text.length > maxBytes ? text.slice(0, maxBytes) : text;
    } catch (_err) {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

app.post('/api/english/music/resolve', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, async (req, res) => {
    const parsed = parseYouTubeMusicInput(req.body.url || '');
    if (!parsed.valid || (!parsed.ytMusicUrl && !parsed.videoId)) {
        return res.status(400).send(parsed.error || 'Provide a valid YouTube or YouTube Music URL.');
    }

    const uid = req.user.id;
    let oembed = null;
    let apiVideo = null;
    let watchMeta = null;
    let ytmMeta = null;
    let externalMeta = null;
    let ytdlpMeta = null;
    let catalogAlbums = [];
    let catalogSongs = [];
    let catalogArtists = [];

    const catalogPromise = fetchUserMusicAlbumsAndSongs(uid).catch(() => ({ albums: [], songs: [] }));
    const artistsPromise = dbQueryAsync(
        `SELECT id, nombre, tipo_artista, notas_cortas, creado_en
         FROM MusicaArtistas WHERE usuario_id = ? ORDER BY nombre ASC`,
        [uid]
    ).catch(() => []);

    if (parsed.videoId) {
        const videoIdEnc = encodeURIComponent(parsed.videoId);
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${parsed.videoId}`)}&format=json`;
        const watchUrl = `https://www.youtube.com/watch?v=${videoIdEnc}&hl=en`;
        const apiKey = String(process.env.YOUTUBE_API_KEY || '').trim();
        const apiUrl = apiKey
            ? `https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=${videoIdEnc}&key=${encodeURIComponent(apiKey)}`
            : null;

        const [oembedRes, apiRes, watchHtml, ytmRes, catRes, artRes] = await Promise.all([
            fetchExternalWithTimeout(oembedUrl, { timeoutMs: 4000, asJson: true }),
            apiUrl ? fetchExternalWithTimeout(apiUrl, { timeoutMs: 4000, asJson: true }) : Promise.resolve(null),
            fetchExternalWithTimeout(watchUrl, {
                timeoutMs: 4500,
                asJson: false,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9',
                    Cookie: 'CONSENT=YES+1'
                }
            }),
            ytmusicLyrics.fetchYouTubeMusicTrackMetadata({
                videoId: parsed.videoId,
                isAllowedUrl: ytdlpService.isAllowedInnerTubeUrl,
                timeoutMs: 4200
            }).catch(() => null),
            catalogPromise,
            artistsPromise
        ]);

        oembed = oembedRes;
        apiVideo = apiRes && Array.isArray(apiRes.items) && apiRes.items[0] ? apiRes.items[0] : null;
        watchMeta = watchHtml ? extractYouTubeWatchPageMetadata(watchHtml) : null;
        ytmMeta = ytmRes && ytmRes.ok ? ytmRes : null;
        catalogAlbums = catRes.albums || [];
        catalogSongs = catRes.songs || [];
        catalogArtists = Array.isArray(artRes) ? artRes : [];
    } else {
        const [catRes, artRes] = await Promise.all([catalogPromise, artistsPromise]);
        catalogAlbums = catRes.albums || [];
        catalogSongs = catRes.songs || [];
        catalogArtists = Array.isArray(artRes) ? artRes : [];
    }

    const preliminary = mergeResolvedTrackMetadata({
        videoId: parsed.videoId,
        oembed,
        apiVideo,
        watchMeta,
        ytmMeta,
        catalogSongs,
        catalogAlbums,
        catalogArtists
    });

    if (parsed.videoId && preliminary.suggestedTitle) {
        externalMeta = await externalLyricsAndMeta.fetchExternalTrackMetadata({
            title: preliminary.suggestedTitle,
            artist: preliminary.suggestedArtist || '',
            timeoutMs: 3200
        }).catch(() => null);
    }

    let merged = mergeResolvedTrackMetadata({
        videoId: parsed.videoId,
        oembed,
        apiVideo,
        watchMeta,
        ytmMeta,
        externalMeta,
        catalogSongs,
        catalogAlbums,
        catalogArtists
    });

    if (parsed.videoId && (!merged.suggestedTitle || !merged.suggestedAlbumYear)) {
        const ytdlpRes = await ytdlpService.fetchVideoMetadataViaYtDlp({
            videoId: parsed.videoId,
            timeoutMs: 6000
        }).catch(() => null);
        if (ytdlpRes && ytdlpRes.ok) {
            ytdlpMeta = ytdlpRes;
            merged = mergeResolvedTrackMetadata({
                videoId: parsed.videoId,
                oembed,
                apiVideo,
                watchMeta,
                ytmMeta,
                externalMeta,
                ytdlpMeta,
                catalogSongs,
                catalogAlbums,
                catalogArtists
            });
        }
    }

    res.json({
        videoId: parsed.videoId,
        ytMusicUrl: parsed.ytMusicUrl,
        youtubeUrl: parsed.youtubeUrl,
        thumbnailUrl: parsed.thumbnailUrl,
        ...merged
    });
});

async function syncMusicaCancionArtistas(uid, songId, mainArtistId, collaborators, clearExisting = false) {
    if (clearExisting) {
        await dbQueryAsync('DELETE FROM MusicaCancionArtistas WHERE cancion_id = ?', [songId]);
    }
    await dbQueryAsync(
        'INSERT INTO MusicaCancionArtistas (cancion_id, artista_id, rol, orden) VALUES (?, ?, ?, ?)',
        [songId, mainArtistId, 'main', 1]
    );

    let order = 2;
    for (const collab of collaborators) {
        const collabId = await upsertMusicaArtista(uid, collab.nombre, 'solo');
        if (collabId && collabId !== mainArtistId) {
            await dbQueryAsync(
                'INSERT INTO MusicaCancionArtistas (cancion_id, artista_id, rol, orden) VALUES (?, ?, ?, ?)',
                [songId, collabId, collab.rol, order++]
            );
        }
    }
}

async function persistMusicaCancionUpdate(uid, songId, {
    albumId,
    titulo,
    numeroPista,
    idioma,
    albumYear,
    ytMusicUrl,
    ytVideoId,
    thumbnailUrl,
    estadoEstudio,
    enfoqueCorto
}) {
    const updateWithAnio = () => dbQueryAsync(
        `UPDATE MusicaCanciones
         SET album_id = ?, titulo = ?, numero_pista = ?, idioma = ?, anio = ?,
             yt_music_url = ?, yt_video_id = ?, thumbnail_url = ?,
             estado_estudio = ?, enfoque_corto = ?
         WHERE id = ? AND usuario_id = ?`,
        [
            albumId,
            titulo,
            numeroPista,
            idioma,
            albumYear,
            ytMusicUrl,
            ytVideoId,
            thumbnailUrl,
            estadoEstudio,
            enfoqueCorto,
            songId,
            uid
        ]
    );
    const updateLegacy = () => dbQueryAsync(
        `UPDATE MusicaCanciones
         SET album_id = ?, titulo = ?, numero_pista = ?, idioma = ?,
             yt_music_url = ?, yt_video_id = ?, thumbnail_url = ?,
             estado_estudio = ?, enfoque_corto = ?
         WHERE id = ? AND usuario_id = ?`,
        [
            albumId,
            titulo,
            numeroPista,
            idioma,
            ytMusicUrl,
            ytVideoId,
            thumbnailUrl,
            estadoEstudio,
            enfoqueCorto,
            songId,
            uid
        ]
    );

    try {
        await updateWithAnio();
    } catch (updErr) {
        if (!isUnknownColumnDbError(updErr)) throw updErr;
        await ensureMusicaSchemaExtraColumns();
        try {
            await updateWithAnio();
        } catch (retryUpdErr) {
            if (!isUnknownColumnDbError(retryUpdErr)) throw retryUpdErr;
            await updateLegacy();
        }
    }
}

app.post('/api/english/music/songs', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, preventDuplicateSubmit({ dedupeWindowMs: 8000 }), async (req, res) => {
    const validated = validateAndExtractSongPayload(req.body);
    if (validated.error) return res.status(400).send(validated.error);

    const d = validated.data;
    const uid = req.user.id;

    try {
        const mainArtistId = await upsertMusicaArtista(uid, d.mainArtist, d.artistType, { updateExisting: true });
        const albumId = await upsertMusicaAlbum({
            usuarioId: uid,
            albumTitle: d.albumTitle,
            albumType: d.albumType,
            albumYear: d.albumYear,
            mainArtistId
        });

        const existingMatch = await findExistingUserSongMatch({
            usuarioId: uid,
            titulo: d.titulo,
            mainArtistId,
            mainArtistName: d.mainArtist,
            ytVideoId: d.ytVideoId
        });
        if (existingMatch && existingMatch.matchType === 'possible_typo' && !req.body.allowSimilarTitle) {
            return res.status(409).send(
                `Possible typo or duplicate: "${existingMatch.song.titulo}" already exists for this artist. Edit the existing song or verify the spelling.`
            );
        }
        if (existingMatch && (existingMatch.matchType === 'exact_video' || existingMatch.matchType === 'exact_title')) {
            const cur = existingMatch.song;
            const mergedAlbumId = albumId || cur.album_id || null;
            const mergedTitulo = cur.titulo || d.titulo;
            const mergedNumeroPista = d.numeroPista || cur.numero_pista || null;
            const mergedIdioma = (d.idioma && d.idioma !== 'English') ? d.idioma : (cur.idioma || d.idioma || 'English');
            const mergedAnio = d.albumYear || cur.cancion_anio || cur.album_anio || null;
            const mergedYtMusicUrl = d.ytMusicUrl || cur.yt_music_url || null;
            const mergedYtVideoId = d.ytVideoId || cur.yt_video_id || null;
            const mergedThumbUrl = d.thumbnailUrl || cur.thumbnail_url || null;
            const mergedEstado = cur.estado_estudio || d.estadoEstudio || 'to_study';
            const mergedEnfoque = cur.enfoque_corto || d.enfoqueCorto || null;

            await persistMusicaCancionUpdate(uid, cur.id, {
                albumId: mergedAlbumId,
                titulo: mergedTitulo,
                numeroPista: mergedNumeroPista,
                idioma: mergedIdioma,
                albumYear: mergedAnio,
                ytMusicUrl: mergedYtMusicUrl,
                ytVideoId: mergedYtVideoId,
                thumbnailUrl: mergedThumbUrl,
                estadoEstudio: mergedEstado,
                enfoqueCorto: mergedEnfoque
            });

            const existingCollabs = (cur.artists || [])
                .filter((a) => a.rol && a.rol !== 'main')
                .map((a) => ({ nombre: a.nombre, rol: a.rol }));
            const mergedCollabs = parseCollaboratorsInput([...existingCollabs, ...d.collaborators], d.mainArtist);
            if (mergedCollabs.length > existingCollabs.length) {
                await syncMusicaCancionArtistas(uid, cur.id, mainArtistId, mergedCollabs, true);
            }

            bumpSyncRevision('music');
            return res.status(200).json({
                ok: true,
                deduplicated: true,
                duplicateReason: existingMatch.matchType,
                message: 'Song already exists in your catalog; updated existing entry instead of duplicating.',
                songId: cur.id,
                ytMusicUrl: mergedYtMusicUrl,
                youtubeUrl: buildStandardYouTubeUrl({ videoId: mergedYtVideoId, ytMusicUrl: mergedYtMusicUrl })
            });
        }

        const insertedSong = await insertMusicaCancionRow([
            uid,
            albumId,
            d.titulo,
            d.numeroPista,
            d.idioma,
            d.albumYear,
            d.ytMusicUrl,
            d.ytVideoId,
            d.thumbnailUrl,
            d.estadoEstudio,
            d.enfoqueCorto
        ]);
        const songId = insertedSong.insertId;
        await syncMusicaCancionArtistas(uid, songId, mainArtistId, d.collaborators, false);
        bumpSyncRevision('music');

        res.status(201).json({
            message: 'Song registered in your English Music catalog.',
            songId,
            ytMusicUrl: d.ytMusicUrl,
            youtubeUrl: d.youtubeUrl
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error saving song to music catalog.');
    }
});

app.put('/api/english/music/songs/:id', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, preventDuplicateSubmit({ dedupeWindowMs: 0 }), async (req, res) => {
    const songId = parsePositiveInt(req.params.id);
    if (!songId) return res.status(400).send('Invalid song ID.');

    const validated = validateAndExtractSongPayload(req.body);
    if (validated.error) return res.status(400).send(validated.error);

    const d = validated.data;
    const uid = req.user.id;

    try {
        const existing = await dbQueryAsync(
            'SELECT id FROM MusicaCanciones WHERE id = ? AND usuario_id = ? LIMIT 1',
            [songId, uid]
        );
        if (!existing.length) return res.status(404).send('Song not found.');

        const mainArtistId = await upsertMusicaArtista(uid, d.mainArtist, d.artistType, { updateExisting: true });
        const dupMatch = await findExistingUserSongMatch({
            usuarioId: uid,
            titulo: d.titulo,
            mainArtistId,
            mainArtistName: d.mainArtist,
            ytVideoId: d.ytVideoId,
            excludeSongId: songId
        });
        if (dupMatch && (dupMatch.matchType === 'exact_video' || dupMatch.matchType === 'exact_title')) {
            return res.status(409).send(
                `Another song ("${dupMatch.song.titulo}") with that title or YouTube link already exists for this artist.`
            );
        }

        const albumId = await upsertMusicaAlbum({
            usuarioId: uid,
            albumTitle: d.albumTitle,
            albumType: d.albumType,
            albumYear: d.albumYear,
            mainArtistId
        });

        await persistMusicaCancionUpdate(uid, songId, {
            albumId,
            titulo: d.titulo,
            numeroPista: d.numeroPista,
            idioma: d.idioma,
            albumYear: d.albumYear,
            ytMusicUrl: d.ytMusicUrl,
            ytVideoId: d.ytVideoId,
            thumbnailUrl: d.thumbnailUrl,
            estadoEstudio: d.estadoEstudio,
            enfoqueCorto: d.enfoqueCorto
        });

        await syncMusicaCancionArtistas(uid, songId, mainArtistId, d.collaborators, true);
        bumpSyncRevision('music');

        res.json({ message: 'Song metadata updated.' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error updating song metadata.');
    }
});

app.patch('/api/english/music/songs/:id/status', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, async (req, res) => {
    const songId = parsePositiveInt(req.params.id);
    if (!songId) return res.status(400).send('Invalid song ID.');

    const uid = req.user.id;
    const rawState = req.body.estadoEstudio !== undefined ? String(req.body.estadoEstudio).trim().toLowerCase() : null;
    if (rawState !== null && !MUSIC_STUDY_STATES.has(rawState)) {
        return res.status(400).send('Unsupported study status.');
    }
    const wordSyncedProvided = req.body.wordSynced !== undefined;
    const wordSyncedVal = wordSyncedProvided ? (req.body.wordSynced ? 1 : 0) : null;

    if (rawState === null && !wordSyncedProvided) {
        return res.status(400).send('Nothing to update.');
    }

    try {
        const currentRows = await dbQueryAsync(
            'SELECT id, estado_estudio, word_sincronizado FROM MusicaCanciones WHERE id = ? AND usuario_id = ? LIMIT 1',
            [songId, uid]
        );
        if (!currentRows.length) return res.status(404).send('Song not found.');

        const nextState = rawState !== null ? rawState : currentRows[0].estado_estudio;
        const nextWord = wordSyncedProvided ? wordSyncedVal : (currentRows[0].word_sincronizado ? 1 : 0);

        await dbQueryAsync(
            `UPDATE MusicaCanciones
             SET estado_estudio = ?, word_sincronizado = ?, ultimo_estudio_en = ?
             WHERE id = ? AND usuario_id = ?`,
            [nextState, nextWord, formatMySqlDateTime(new Date()), songId, uid]
        );
        bumpSyncRevision('music');

        res.json({ message: 'Song study state updated.', estado_estudio: nextState, word_sincronizado: Boolean(nextWord) });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error updating song study state.');
    }
});

app.post('/api/english/music/songs/:id/sync-metadata', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, async (req, res) => {
    const songId = parsePositiveInt(req.params.id);
    if (!songId) return res.status(400).send('Invalid song ID.');
    const uid = req.user.id;
    try {
        const rows = await dbQueryAsync(
            'SELECT id, album_id, numero_pista FROM MusicaCanciones WHERE id = ? AND usuario_id = ? LIMIT 1',
            [songId, uid]
        );
        if (!rows.length) return res.status(404).send('Song not found.');
        const songRow = rows[0];

        const relDate = req.body.releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.releaseDate).trim())
            ? String(req.body.releaseDate).trim()
            : null;
        const relYear = req.body.releaseYear && Number.isInteger(Number(req.body.releaseYear))
            ? Number(req.body.releaseYear)
            : (relDate ? Number(relDate.slice(0, 4)) : null);
        const trackNum = req.body.trackNumber && Number.isInteger(Number(req.body.trackNumber)) && Number(req.body.trackNumber) > 0
            ? Number(req.body.trackNumber)
            : null;

        if (trackNum && !songRow.numero_pista) {
            await dbQueryAsync(
                'UPDATE MusicaCanciones SET numero_pista = ? WHERE id = ? AND usuario_id = ?',
                [trackNum, songId, uid]
            );
        }
        if (songRow.album_id && (relDate || relYear)) {
            if (relYear) {
                await dbQueryAsync(
                    'UPDATE MusicaAlbumes SET anio = COALESCE(anio, ?) WHERE id = ? AND usuario_id = ?',
                    [relYear, songRow.album_id, uid]
                );
            }
            if (relDate) {
                await dbQueryAsync(
                    'UPDATE MusicaAlbumes SET fecha_lanzamiento = COALESCE(fecha_lanzamiento, ?) WHERE id = ? AND usuario_id = ?',
                    [relDate, songRow.album_id, uid]
                ).catch(() => {});
            }
        }
        res.json({ ok: true, songId, releaseDate: relDate, releaseYear: relYear, trackNumber: trackNum });
    } catch (err) {
        console.error('[MUSIC_METADATA_SYNC_ERROR]', err);
        res.status(500).send('Error syncing song metadata.');
    }
});

app.delete('/api/english/music/songs/:id', apiWriteLimiter.middleware, requireAdmin, preventDuplicateSubmit({ dedupeWindowMs: 0 }), async (req, res) => {
    const songId = parsePositiveInt(req.params.id);
    if (!songId) return res.status(400).send('Invalid song ID.');

    try {
        const result = await dbQueryAsync(
            'DELETE FROM MusicaCanciones WHERE id = ? AND usuario_id = ?',
            [songId, req.user.id]
        );
        if (!result.affectedRows) return res.status(404).send('Song not found.');

        bumpSyncRevision('music');
        res.json({ message: 'Song deleted from music catalog.' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error deleting song.');
    }
});

const SAFE_MEDIA_CONTENT_TYPES = new Set([
    'video/mp4',
    'audio/mp4',
    'video/webm',
    'audio/webm',
    'audio/mpeg'
]);

async function fetchOwnedMusicSongForMediaOrLyrics(songId, uid) {
    const rows = await dbQueryAsync(
        `SELECT id, titulo, idioma, yt_music_url, yt_video_id
         FROM MusicaCanciones
         WHERE id = ? AND usuario_id = ?
         LIMIT 1`,
        [songId, uid]
    );
    return rows[0] || null;
}

// ==========================================
// PUENTE CIFRADO SITE-TO-SITE (EC2 RAM <-> SINCRONIZADOR PC)
// ==========================================
const MAX_PC_MUSIC_JOBS = 25;
const PC_MUSIC_JOB_TTL_MS = 5 * 60 * 1000;
const PC_HEARTBEAT_ONLINE_MS = 65 * 1000;
const pcMusicJobs = new Map();
const pcPollWaiters = new Set();
const pcJobResultWaiters = new Map();
let lastPcHeartbeatAt = 0;

function isPcBridgeOnline() {
    return pcPollWaiters.size > 0 || (lastPcHeartbeatAt > 0 && (Date.now() - lastPcHeartbeatAt) <= PC_HEARTBEAT_ONLINE_MS);
}

function getPcBridgeSecrets() {
    return [process.env.JOURNAL_SECRET_KEY, process.env.ADMIN_SECRET]
        .map(v => String(v || '').trim())
        .filter(Boolean);
}

function purgeExpiredPcMusicJobs() {
    const now = Date.now();
    for (const [jid, job] of pcMusicJobs.entries()) {
        if (!job || (now - job.createdAt) > PC_MUSIC_JOB_TTL_MS) {
            pcMusicJobs.delete(jid);
            const waiters = pcJobResultWaiters.get(jid);
            if (waiters) {
                for (const wake of waiters) wake();
                pcJobResultWaiters.delete(jid);
            }
        }
    }
}

function verifyPcBridgeAuth(req, res, next) {
    const secrets = getPcBridgeSecrets();
    if (!secrets.length) {
        return res.status(503).send('PC bridge authentication secret is not configured.');
    }

    const tsRaw = String(req.headers['x-pc-timestamp'] || '').trim();
    const sigHex = String(req.headers['x-pc-signature'] || '').trim().toLowerCase();
    const tsSec = Number(tsRaw);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(tsSec) || Math.abs(nowSec - tsSec) > 120 || !/^[0-9a-f]{64}$/.test(sigHex)) {
        return res.status(401).send('Invalid or expired PC bridge signature.');
    }

    const payloadBlob = (req.method === 'POST' && req.body)
        ? (typeof req.body.encryptedResult === 'string'
            ? req.body.encryptedResult
            : (typeof req.body.encryptedDocxB64 === 'string' ? req.body.encryptedDocxB64 : ''))
        : '';
    const bodyHash = crypto.createHash('sha256').update(payloadBlob, 'utf8').digest('hex');
    const canonical = `${req.method.toUpperCase()}:${req.path}:${tsRaw}:${bodyHash}`;

    const providedBuf = Buffer.from(sigHex, 'hex');
    const valid = secrets.some((sec) => {
        const expected = crypto.createHmac('sha256', sec).update(canonical, 'utf8').digest();
        return expected.length === providedBuf.length && crypto.timingSafeEqual(expected, providedBuf);
    });

    if (!valid) {
        return res.status(401).send('PC bridge HMAC verification failed.');
    }
    return next();
}

function popPendingPcJobs() {
    purgeExpiredPcMusicJobs();
    const dispatched = [];
    for (const job of pcMusicJobs.values()) {
        if (job.status === 'pending') {
            job.status = 'dispatched';
            job.updatedAt = Date.now();
            dispatched.push({
                jobId: job.jobId,
                encryptedRequest: job.encryptedRequest,
                createdAt: job.createdAt
            });
        }
    }
    return dispatched;
}

function notifyPcPollWaiters() {
    if (!pcPollWaiters.size) return;
    const snapshot = [...pcPollWaiters];
    pcPollWaiters.clear();
    for (const wake of snapshot) wake();
}

function notifyPcJobResultWaiters(jobId) {
    const waiters = pcJobResultWaiters.get(jobId);
    if (!waiters || !waiters.size) return;
    pcJobResultWaiters.delete(jobId);
    for (const wake of waiters) wake();
}

async function openAllowedMediaUpstreamResponse(initialUrl, headers, signal) {
    let currentUrl = initialUrl;
    for (let hop = 0; hop <= 3; hop++) {
        if (!ytdlpService.isAllowedMediaCdnUrl(currentUrl)) {
            return null;
        }
        const upstream = await fetch(currentUrl, {
            method: 'GET',
            headers,
            signal,
            redirect: 'manual'
        });
        if (upstream.status >= 300 && upstream.status < 400) {
            const loc = upstream.headers.get('location');
            try { await upstream.body?.cancel(); } catch (_) {}
            if (!loc) return null;
            currentUrl = new URL(loc, currentUrl).toString();
            continue;
        }
        return upstream;
    }
    return null;
}

app.get('/api/english/music/ytdlp-status', apiReadLimiter.middleware, requireAdmin, (_req, res) => {
    purgeExpiredPcMusicJobs();
    const ytdlpStatus = ytdlpService.getYtDlpStatus();
    const journalStatus = serverNotesService.getLocalJournalStatus({ rootDir: __dirname });
    res.json({
        ...ytdlpStatus,
        pcOnline: isPcBridgeOnline(),
        serverAutonomous: serverNotesService.isServerAutonomousNotesEnabled(),
        journalEncryptedLocal: Boolean(journalStatus.passwordConfigured),
        lastPcSeenAt: lastPcHeartbeatAt ? new Date(lastPcHeartbeatAt).toISOString() : null,
        pendingPcJobs: pcMusicJobs.size,
        pendingEnglishQueueCount: englishQueue.size()
    });
});

app.post('/api/english/music/pc-jobs', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, (req, res) => {
    purgeExpiredPcMusicJobs();
    const { encryptedRequest } = req.body || {};
    if (typeof encryptedRequest !== 'string' || !encryptedRequest.trim() || encryptedRequest.length > 48000) {
        return res.status(400).send('Invalid E2EE encryptedRequest payload.');
    }

    while (pcMusicJobs.size >= MAX_PC_MUSIC_JOBS) {
        const oldestKey = pcMusicJobs.keys().next().value;
        if (!oldestKey) break;
        pcMusicJobs.delete(oldestKey);
    }

    const jobId = crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    pcMusicJobs.set(jobId, {
        jobId,
        usuarioId: req.user.id,
        encryptedRequest: encryptedRequest.trim(),
        status: 'pending',
        encryptedResult: null,
        createdAt: now,
        updatedAt: now
    });

    notifyPcPollWaiters();
    return res.status(201).json({
        ok: true,
        jobId,
        pcOnline: isPcBridgeOnline(),
        expiresInMs: PC_MUSIC_JOB_TTL_MS
    });
});

app.get('/api/english/music/pc-jobs/poll', pcPullLimiter.middleware, verifyPcBridgeAuth, async (req, res) => {
    lastPcHeartbeatAt = Date.now();
    let jobs = popPendingPcJobs();
    const requestedWaitMs = Number.parseInt(String(req.query.waitMs || '0'), 10);
    const waitMs = Number.isFinite(requestedWaitMs) ? Math.min(Math.max(requestedWaitMs, 0), 25000) : 0;

    if (!jobs.length && waitMs > 0) {
        if (req.aborted || res.destroyed) {
            return;
        }
        let clientAborted = false;
        await new Promise((resolve) => {
            let done = false;
            const wake = () => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                pcPollWaiters.delete(wake);
                req.off('close', onClose);
                resolve();
            };
            const onClose = () => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                pcPollWaiters.delete(wake);
                clientAborted = true;
                resolve();
            };
            const timer = setTimeout(wake, waitMs);
            pcPollWaiters.add(wake);
            req.on('close', onClose);
        });
        if (clientAborted || res.headersSent || res.destroyed) return;
        lastPcHeartbeatAt = Date.now();
        jobs = popPendingPcJobs();
    }

    if (res.headersSent || res.destroyed) return;
    return res.json({ ok: true, jobs });
});

app.post('/api/english/music/pc-jobs/:jobId/result', pcPullLimiter.middleware, verifyPcBridgeAuth, requireNonEmptyBody, (req, res) => {
    lastPcHeartbeatAt = Date.now();
    purgeExpiredPcMusicJobs();
    const jobId = String(req.params.jobId || '').trim().toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(jobId)) {
        return res.status(400).send('Invalid job ID.');
    }

    const job = pcMusicJobs.get(jobId);
    if (!job) {
        return res.status(404).send('PC job expired or not found.');
    }

    const { encryptedResult } = req.body || {};
    if (typeof encryptedResult !== 'string' || !encryptedResult.trim() || encryptedResult.length > 64000) {
        return res.status(400).send('Invalid encryptedResult payload.');
    }

    job.status = 'completed';
    job.encryptedResult = encryptedResult.trim();
    job.updatedAt = Date.now();
    notifyPcJobResultWaiters(jobId);

    return res.json({ ok: true, jobId });
});

app.get('/api/english/music/pc-jobs/:jobId', apiReadLimiter.middleware, requireAdmin, async (req, res) => {
    purgeExpiredPcMusicJobs();
    const jobId = String(req.params.jobId || '').trim().toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(jobId)) {
        return res.status(400).send('Invalid job ID.');
    }

    let job = pcMusicJobs.get(jobId);
    if (!job || Number(job.usuarioId) !== Number(req.user.id)) {
        return res.status(404).send('PC job expired or not found.');
    }

    const requestedWaitMs = Number.parseInt(String(req.query.waitMs || '0'), 10);
    const waitMs = Number.isFinite(requestedWaitMs) ? Math.min(Math.max(requestedWaitMs, 0), 25000) : 0;

    if (job.status !== 'completed' && waitMs > 0) {
        await new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                const set = pcJobResultWaiters.get(jobId);
                if (set) {
                    set.delete(finish);
                    if (set.size === 0) pcJobResultWaiters.delete(jobId);
                }
                req.off('close', finish);
                resolve();
            };
            const timer = setTimeout(finish, waitMs);
            if (!pcJobResultWaiters.has(jobId)) pcJobResultWaiters.set(jobId, new Set());
            pcJobResultWaiters.get(jobId).add(finish);
            req.on('close', finish);
        });
        purgeExpiredPcMusicJobs();
        job = pcMusicJobs.get(jobId);
        if (!job) {
            return res.status(404).send('PC job expired.');
        }
    }

    if (res.headersSent || res.destroyed) return;
    if (job.status === 'completed' && job.encryptedResult) {
        const encryptedResult = job.encryptedResult;
        pcMusicJobs.delete(jobId);
        return res.json({
            ok: true,
            jobId,
            status: 'completed',
            encryptedResult
        });
    }

    return res.json({
        ok: true,
        jobId,
        status: job.status,
        pcOnline: isPcBridgeOnline()
    });
});

const studyNotebookCache = {
    sha256: '',
    mtimeMs: 0,
    remoteModTime: '',
    size: 0,
    loadedAt: 0,
    source: '',
    parsed: null
};
const STUDY_NOTEBOOK_CACHE_TTL_MS = 60 * 1000;
let _studyNotebookFetchPromise = null;

function resolveStudyDriveRemoteTarget(rcloneConf, usingStudyConfig) {
    const configuredStudyRemote = String(process.env.STUDY_RCLONE_REMOTE || '').trim();
    const mainRemote = String(process.env.RCLONE_REMOTE || 'gdrive').trim();
    const studyDir = String(process.env.STUDY_RCLONE_DIR || 'NotasIdiomas').trim().replace(/^\/+|\/+$/g, '') || 'NotasIdiomas';
    const mainBackupDir = String(process.env.RCLONE_BACKUP_DIR || 'RespaldosApp').trim().replace(/^\/+|\/+$/g, '') || 'RespaldosApp';

    let hasDedicatedStudyRemote = Boolean(usingStudyConfig && configuredStudyRemote);
    if (!hasDedicatedStudyRemote && configuredStudyRemote && rcloneConf && fs.existsSync(rcloneConf)) {
        try {
            hasDedicatedStudyRemote = fs.readFileSync(rcloneConf, 'utf8').includes(`[${configuredStudyRemote}]`);
        } catch (_) {}
    }

    const remoteName = hasDedicatedStudyRemote ? configuredStudyRemote : mainRemote;
    const folderName = hasDedicatedStudyRemote ? studyDir : `${mainBackupDir}/${studyDir}`;
    return {
        remoteName,
        folderName,
        remoteTarget: `${remoteName}:${folderName}/English_Learning_Notebook.docx`
    };
}

function updateStudyNotebookCacheFromBuffer(docxBuffer, source = 'word', diskMeta = null) {
    if (!Buffer.isBuffer(docxBuffer) || docxBuffer.length < 64) return null;
    const parsed = parseStudyNotebookDocxBuffer(docxBuffer, { includeAllEntries: true, includeAll: true });
    if (!parsed || !parsed.ok) return null;
    const sha256 = crypto.createHash('sha256').update(docxBuffer).digest('hex');
    parsed.source = source;
    parsed.updatedAt = new Date().toISOString();
    studyNotebookCache.sha256 = sha256;
    studyNotebookCache.mtimeMs = diskMeta ? Number(diskMeta.mtimeMs) || 0 : 0;
    studyNotebookCache.remoteModTime = diskMeta && diskMeta.remoteModTime ? String(diskMeta.remoteModTime) : '';
    studyNotebookCache.size = diskMeta ? Number(diskMeta.size) || docxBuffer.length : docxBuffer.length;
    studyNotebookCache.loadedAt = Date.now();
    studyNotebookCache.source = source;
    studyNotebookCache.parsed = parsed;
    return parsed;
}

async function getStudyNotebookDataForUser({ forceRefresh = false, fastLocalOnly = false } = {}) {
    if (
        !forceRefresh
        && studyNotebookCache.parsed
        && Date.now() - studyNotebookCache.loadedAt < STUDY_NOTEBOOK_CACHE_TTL_MS
    ) {
        return studyNotebookCache.parsed;
    }

    // Strict isolation: Journal Notes (WORD_FILE_PATH / Diario.docx) are NEVER touched in the cloud.
    const localPath = serverNotesService.resolveLocalEnglishPath({ rootDir: __dirname });
    const readLocalMirror = () => {
        try {
            if (localPath && fs.existsSync(localPath)) {
                const stat = fs.statSync(localPath);
                if (stat.isFile() && stat.size >= 64) {
                    if (
                        !forceRefresh
                        && studyNotebookCache.parsed
                        && studyNotebookCache.source === 'local-word'
                        && studyNotebookCache.mtimeMs === stat.mtimeMs
                        && studyNotebookCache.size === stat.size
                    ) {
                        return studyNotebookCache.parsed;
                    }
                    const buf = fs.readFileSync(localPath);
                    const parsedLocal = updateStudyNotebookCacheFromBuffer(buf, 'local-word', stat);
                    if (parsedLocal) return parsedLocal;
                }
            }
        } catch (_) {}
        return null;
    };

    if (fastLocalOnly) {
        return readLocalMirror() || studyNotebookCache.parsed || null;
    }

    const probeRclone = resolveRcloneConfigPath({ preferStudy: true });
    const hasConfiguredRclone = Boolean(probeRclone?.confPath && fs.existsSync(probeRclone.confPath));
    if (probeRclone?.cleanup && probeRclone.confPath && fs.existsSync(probeRclone.confPath)) {
        try { fs.unlinkSync(probeRclone.confPath); } catch (_) {}
    }

    if (!hasConfiguredRclone) {
        const localRes = readLocalMirror();
        if (localRes) return localRes;
        return studyNotebookCache.parsed || null;
    }

    if (_studyNotebookFetchPromise) {
        return _studyNotebookFetchPromise;
    }

    _studyNotebookFetchPromise = runWithDocxLock('pdh_docx_english', async () => {
        const { confPath: rcloneConf, cleanup: cleanupConf, usingStudyConfig } = resolveRcloneConfigPath({ preferStudy: true });
        const tmpDocxPath = path.join(os.tmpdir(), `English_Read_${process.pid}_${Date.now()}.docx`);
        try {
            if (!fs.existsSync(rcloneConf)) {
                return readLocalMirror() || studyNotebookCache.parsed || null;
            }
            const { remoteTarget } = resolveStudyDriveRemoteTarget(rcloneConf, usingStudyConfig);

            // Only download to /tmp when remote size or ModTime changed (zero unnecessary RAM/network spikes)
            let remoteModTime = '';
            let remoteSize = 0;
            try {
                const lsRaw = await serverNotesService.runRcloneCommand({
                    rcloneConf,
                    args: ['lsjson', remoteTarget],
                    timeout: 7000
                });
                const entries = JSON.parse(String(lsRaw || '[]'));
                if (!Array.isArray(entries) || entries.length === 0) {
                    return readLocalMirror() || studyNotebookCache.parsed || null;
                }
                remoteModTime = String(entries[0].ModTime || '');
                remoteSize = Number(entries[0].Size) || 0;
                if (
                    !forceRefresh
                    && studyNotebookCache.parsed
                    && studyNotebookCache.source === 'drive-word'
                    && remoteModTime
                    && studyNotebookCache.remoteModTime === remoteModTime
                    && studyNotebookCache.size === remoteSize
                ) {
                    studyNotebookCache.loadedAt = Date.now();
                    return studyNotebookCache.parsed;
                }
            } catch (_) {
                // Proceed to copyto if lsjson isn't supported or timed out briefly
            }

            await serverNotesService.runRcloneCommand({
                rcloneConf,
                args: ['copyto', '--retries', '1', remoteTarget, tmpDocxPath],
                timeout: 15000
            });
            const buf = fs.readFileSync(tmpDocxPath);
            if (buf.length < 64 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
                return readLocalMirror() || studyNotebookCache.parsed || null;
            }
            // Mirror Drive copy locally via atomic rename so concurrent readers never observe partial bytes
            let tmpMirrorPath = '';
            try {
                fs.mkdirSync(path.dirname(localPath), { recursive: true });
                tmpMirrorPath = `${localPath}.${process.pid}.${Date.now()}.tmp`;
                fs.writeFileSync(tmpMirrorPath, buf, { mode: 0o600 });
                fs.renameSync(tmpMirrorPath, localPath);
            } catch (_) {
                if (tmpMirrorPath && fs.existsSync(tmpMirrorPath)) {
                    try { fs.unlinkSync(tmpMirrorPath); } catch (_cleanupErr) {}
                }
            }

            const bufSha = crypto.createHash('sha256').update(buf).digest('hex');
            if (
                studyNotebookCache.parsed
                && studyNotebookCache.sha256 === bufSha
                && studyNotebookCache.source === 'drive-word'
            ) {
                studyNotebookCache.remoteModTime = remoteModTime || studyNotebookCache.remoteModTime;
                studyNotebookCache.loadedAt = Date.now();
                return studyNotebookCache.parsed;
            }
            const parsedDrive = updateStudyNotebookCacheFromBuffer(buf, 'drive-word', {
                remoteModTime,
                size: remoteSize || buf.length
            });
            return parsedDrive || readLocalMirror() || studyNotebookCache.parsed || null;
        } catch (_err) {
            return readLocalMirror() || studyNotebookCache.parsed || null;
        } finally {
            try {
                if (fs.existsSync(tmpDocxPath)) fs.unlinkSync(tmpDocxPath);
            } catch (_) {}
            if (cleanupConf) {
                try {
                    if (fs.existsSync(rcloneConf)) fs.unlinkSync(rcloneConf);
                } catch (_) {}
            }
        }
    });

    try {
        return await _studyNotebookFetchPromise;
    } finally {
        _studyNotebookFetchPromise = null;
    }
}

async function syncNotebookSongsOrderToMysql(parsedNotebook, uid) {
    if (!parsedNotebook || !parsedNotebook.ok || !uid) return 0;
    const allEntries = (parsedNotebook.allEntries || parsedNotebook.entries || []).filter(e => e && e.section === 'music');
    if (!allEntries.length) return 0;
    try {
        const { albums, songs } = await fetchUserMusicAlbumsAndSongs(uid);
        if (!Array.isArray(songs) || !songs.length) return 0;
        const albumsById = new Map((albums || []).map((a) => [Number(a.id), a]));
        let updatedCount = 0;
        for (const song of songs) {
            if (!song || !song.titulo) continue;
            const albumObj = song.album_id ? albumsById.get(Number(song.album_id)) : null;
            const match = findNotebookSongEntry(parsedNotebook, {
                songTitle: song.titulo,
                artistName: String(albumObj?.artista_principal_nombre || '').trim(),
                albumTitle: String(song.album_titulo || albumObj?.titulo || '').trim()
            });
            if (match && match.trackNumber && !song.numero_pista) {
                await dbQueryAsync(
                    'UPDATE MusicaCanciones SET numero_pista = COALESCE(numero_pista, ?) WHERE id = ? AND usuario_id = ?',
                    [match.trackNumber, song.id, uid]
                ).catch(() => {});
                updatedCount += 1;
            }
        }
        return updatedCount;
    } catch (_) {
        return 0;
    }
}

app.get('/api/english/study-notebook', apiReadLimiter.middleware, requireAdmin, async (req, res) => {
    try {
        const forceRefresh = String(req.query.refresh || '') === '1';
        const parsedBase = await getStudyNotebookDataForUser({ forceRefresh });
        if (!parsedBase || !parsedBase.ok) {
            return res.json({
                ok: true,
                available: false,
                source: 'none',
                updatedAt: null,
                total: 0,
                offset: 0,
                nextOffset: null,
                counts: { total: 0, vocabulary: 0, grammar: 0, phrasal_verb: 0, music: 0, notes: 0, alphabet: 0 },
                countsByLanguage: { all: 0, en: 0, ko: 0, ja: 0, en_ko: 0, en_ja: 0 },
                facets: { artists: [], albums: [], songs: [] },
                entries: []
            });
        }
        syncNotebookSongsOrderToMysql(parsedBase, req.user.id).catch(() => {});
        const filtered = filterStudyNotebookData(parsedBase, {
            section: req.query.section,
            language: req.query.language,
            artist: req.query.artist,
            album: req.query.album,
            song: req.query.song,
            q: req.query.q,
            offset: req.query.offset,
            limit: req.query.limit
        });
        return res.json({
            ...filtered,
            available: true
        });
    } catch (err) {
        console.error('[STUDY_NOTEBOOK_READ_ERROR]', err);
        return res.status(500).json({ ok: false, error: 'Error reading study notebook.' });
    }
});

app.post('/api/english/music/pc-word-drive-sync', apiWriteLimiter.middleware, verifyPcBridgeAuth, async (req, res) => {
    const requestedTarget = String(req.body?.target || req.body?.documentType || req.body?.kind || 'study_word')
        .trim()
        .toLowerCase();
    if (requestedTarget === 'journal' || requestedTarget === 'diario') {
        return res.status(403).json({
            ok: false,
            error: 'Personal journal files cannot be synced to the isolated Study Word Drive (Drive 2).'
        });
    }

    const rawBlob = req.body && typeof req.body.encryptedResult === 'string'
        ? req.body.encryptedResult.trim()
        : (req.body && typeof req.body.encryptedDocxB64 === 'string' ? req.body.encryptedDocxB64.trim() : '');
    if (!rawBlob || rawBlob.length > 15000000) {
        return res.status(400).json({ ok: false, error: 'Invalid or oversized Word payload.' });
    }

    const { confPath: rcloneConf, cleanup: cleanupConf, usingStudyConfig } = resolveRcloneConfigPath({ preferStudy: true });
    const { remoteName, folderName, remoteTarget } = resolveStudyDriveRemoteTarget(rcloneConf, usingStudyConfig);

    let docxBuffer = null;
    try {
        // Desempaquetar Base64 del .docx enviado por sincronizador.py
        const parsed = JSON.parse(Buffer.from(rawBlob, 'base64').toString('utf8'));
        if (parsed && typeof parsed.docxB64 === 'string') {
            docxBuffer = Buffer.from(parsed.docxB64, 'base64');
        }
    } catch (_) {
        try {
            docxBuffer = Buffer.from(rawBlob, 'base64');
        } catch (_e) {
            docxBuffer = null;
        }
    }

    if (!docxBuffer || docxBuffer.length < 64 || docxBuffer[0] !== 0x50 || docxBuffer[1] !== 0x4b) {
        return res.status(400).json({ ok: false, error: 'Payload is not a valid .docx ZIP container.' });
    }

    const shmDir = fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir();
    const tmpDocxPath = path.join(shmDir, `English_Learning_Notebook_${process.pid}_${Date.now()}.docx`);

    try {
        return await runWithDocxLock('pdh_docx_english', async () => {
            updateStudyNotebookCacheFromBuffer(docxBuffer, 'pc-sync');
            fs.writeFileSync(tmpDocxPath, docxBuffer, { mode: 0o600 });

            const localMirrorPath = serverNotesService.resolveLocalEnglishPath({ rootDir: __dirname });
            if (serverNotesService.isValidDocxZipBuffer(docxBuffer)) {
                try {
                    serverNotesService.writeBufferAtomic(localMirrorPath, docxBuffer, 0o600);
                } catch (_) {}
            }

            if (!fs.existsSync(rcloneConf)) {
                return res.json({
                    ok: true,
                    uploaded: false,
                    remoteTarget,
                    message: 'rclone.conf no encontrado en entorno local; en servidor se sube automáticamente con RCLONE_CONF_B64.'
                });
            }

            const syncRes = await serverNotesService.uploadAndVerifyStudyDocx({
                docxBuffer,
                filePath: tmpDocxPath,
                rcloneConf,
                remoteTarget
            });

            if (!syncRes.verified) {
                return res.status(502).json({
                    ok: false,
                    uploaded: false,
                    verified: false,
                    remoteTarget,
                    localSize: syncRes.localSize,
                    remoteSize: syncRes.remoteSize,
                    error: 'Google Drive upload could not be verified with matching byte size.'
                });
            }

            if (serverNotesService.isValidDocxZipBuffer(docxBuffer)) {
                serverNotesService.clearEnglishDrivePendingMarker(localMirrorPath);
            }
            _englishDriveRetryCount = 0;

            return res.json({
                ok: true,
                uploaded: true,
                verified: true,
                localSize: syncRes.localSize,
                remoteSize: syncRes.remoteSize,
                remoteModTime: syncRes.remoteModTime,
                sha256: syncRes.sha256,
                remoteTarget
            });
        });
    } catch (err) {
        if (err && err.code === 'LOCK_TIMEOUT') {
            return res.status(503).json({ ok: false, error: 'Concurrent English Notebook sync busy; please retry shortly.' });
        }
        console.error('[STUDY_DRIVE_SYNC_ERROR]', err.message);
        return res.status(502).json({ ok: false, error: err.message || 'Failed to upload language notebook to Google Drive.' });
    } finally {
        try {
            if (fs.existsSync(tmpDocxPath)) fs.unlinkSync(tmpDocxPath);
            if (cleanupConf && rcloneConf && fs.existsSync(rcloneConf)) fs.unlinkSync(rcloneConf);
        } catch (_) {}
    }
});

// Drive -> PC (reverse mirror). Signed GET from sincronizador.py; `?download=1` returns the .docx as base64.
// Read-only against Drive: never writes remote files, and only touches the isolated Study Word remote.
app.get('/api/english/music/pc-word-drive-pull', pcPullLimiter.middleware, verifyPcBridgeAuth, async (req, res) => {
    const { confPath: rcloneConf, cleanup: cleanupConf, usingStudyConfig } = resolveRcloneConfigPath({ preferStudy: true });
    const { remoteTarget } = resolveStudyDriveRemoteTarget(rcloneConf, usingStudyConfig);

    const shmDir = fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir();
    const tmpDocxPath = path.join(shmDir, `English_Pull_${process.pid}_${Date.now()}.docx`);
    try {
        if (!fs.existsSync(rcloneConf)) {
            return res.json({ ok: true, exists: false, message: 'rclone.conf not available on this server.' });
        }
        const run = (args, timeout) => serverNotesService.runRcloneCommand({ rcloneConf, args, timeout });

        const entries = JSON.parse(String(await run(['lsjson', remoteTarget], 15000) || '[]'));
        if (!Array.isArray(entries) || !entries.length) {
            return res.json({ ok: true, exists: false, remoteTarget });
        }
        const meta = { ok: true, exists: true, remoteTarget, remoteSize: Number(entries[0].Size) || 0, remoteModTime: String(entries[0].ModTime || '') };
        if (String(req.query.download || '') !== '1') return res.json(meta);
        if (meta.remoteSize > 12 * 1024 * 1024) {
            return res.status(413).json({ ok: false, error: 'Remote notebook exceeds the 12 MB sync limit.' });
        }

        await run(['copyto', '--retries', '2', remoteTarget, tmpDocxPath], 40000);
        const buf = fs.readFileSync(tmpDocxPath);
        if (buf.length < 64 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
            return res.status(502).json({ ok: false, error: 'Downloaded file is not a valid .docx container.' });
        }
        updateStudyNotebookCacheFromBuffer(buf, 'drive-word');
        return res.json({
            ...meta,
            sha256: crypto.createHash('sha256').update(buf).digest('hex'),
            docxB64: buf.toString('base64')
        });
    } catch (err) {
        console.error('[STUDY_DRIVE_PULL_ERROR]', err.message);
        return res.status(502).json({ ok: false, error: 'Could not read the language notebook from Google Drive.' });
    } finally {
        try {
            if (fs.existsSync(tmpDocxPath)) fs.unlinkSync(tmpDocxPath);
            if (cleanupConf && rcloneConf && fs.existsSync(rcloneConf)) fs.unlinkSync(rcloneConf);
        } catch (_) {}
    }
});

const AUTONOMOUS_LYRICS_DEADLINE_MS = 34000;
const autonomousLyricsInFlight = new Map();

async function resolveSongArtistAndAlbumForLyrics(song, uid) {
    let artistName = String(song.artista_principal_nombre || song.artistName || '').trim();
    let albumTitle = String(song.album_titulo || song.albumTitle || '').trim();
    try {
        const [catData, songArtists] = await Promise.all([
            fetchUserMusicAlbumsAndSongs(uid).catch(() => ({ albums: [], songs: [] })),
            dbQueryAsync(
                `SELECT mca.cancion_id, mca.artista_id, mca.rol, mca.orden, ma.nombre
                 FROM MusicaCancionArtistas mca
                 INNER JOIN MusicaCanciones c ON c.id = mca.cancion_id
                 INNER JOIN MusicaArtistas ma ON ma.id = mca.artista_id
                 WHERE c.usuario_id = ?
                 ORDER BY mca.orden ASC, ma.nombre ASC`,
                [uid]
            ).catch(() => [])
        ]);
        const fullSong = Array.isArray(catData?.songs)
            ? catData.songs.find((s) => Number(s.id) === Number(song.id))
            : null;
        if (fullSong && !albumTitle) {
            albumTitle = String(fullSong.album_titulo || '').trim();
        }
        if (!artistName && Array.isArray(songArtists) && songArtists.length) {
            const linked = songArtists.filter((l) => Number(l.cancion_id) === Number(song.id));
            const mainLink = linked.find((l) => l.rol === 'main') || linked[0];
            if (mainLink && mainLink.nombre) {
                artistName = String(mainLink.nombre).trim();
            }
        }
        if (fullSong && fullSong.album_id && Array.isArray(catData?.albums)) {
            const albumObj = catData.albums.find((a) => Number(a.id) === Number(fullSong.album_id));
            if (albumObj) {
                if (!artistName) artistName = String(albumObj.artista_principal_nombre || '').trim();
                if (!albumTitle) albumTitle = String(albumObj.titulo || '').trim();
            }
        }
    } catch (_) {}
    return { artistName, albumTitle };
}

/**
 * Evita que varios clics sobre la misma canción apilen trabajos pesados (rclone / yt-dlp) en la
 * instancia t3.micro y garantiza respuesta antes del timeout del navegador (el cliente espera 40 s).
 * Si se agota el tiempo, responde `reason: 'timeout'` para que el cliente pruebe el puente PC.
 */
function resolveAutonomousSongLyrics(opts = {}) {
    const song = opts.song;
    if (!song || !song.id) return resolveAutonomousSongLyricsUncached(opts);

    const key = `${opts.uid}:${song.id}:${opts.forceExtract ? 'force' : 'auto'}`;
    if (autonomousLyricsInFlight.has(key)) return autonomousLyricsInFlight.get(key);

    const work = resolveAutonomousSongLyricsUncached(opts);
    let timer = null;
    const deadline = new Promise((resolve) => {
        timer = setTimeout(() => resolve({
            ok: false,
            tier: 4,
            songId: song.id,
            reason: 'timeout',
            error: 'Cloud lyrics lookup timed out.',
            canFallbackToPc: isPcBridgeOnline(),
            pcOnline: isPcBridgeOnline(),
            storedInDb: false
        }), AUTONOMOUS_LYRICS_DEADLINE_MS);
    });
    const guarded = Promise.race([work, deadline]).finally(() => {
        clearTimeout(timer);
        autonomousLyricsInFlight.delete(key);
    });
    work.catch(() => {});
    autonomousLyricsInFlight.set(key, guarded);
    return guarded;
}

async function resolveAutonomousSongLyricsUncached({ song, uid, forceExtract = false, preferredLangs = null } = {}) {
    if (!song || !song.id) {
        return { ok: false, tier: 4, reason: 'song_not_found', error: 'Song not found.', storedInDb: false };
    }

    const { artistName, albumTitle } = await resolveSongArtistAndAlbumForLyrics(song, uid);

    const videoId =
        ytdlpService.extractValidYouTubeVideoId(song.yt_video_id) ||
        ytdlpService.extractValidYouTubeVideoId(song.yt_music_url) ||
        '';

    // Tier 1 — Cloud Cache / Study Word Notebook in Google Drive (0 tokens, works with PC off)
    if (!forceExtract) {
        try {
            const notebookData = await getStudyNotebookDataForUser({ forceRefresh: false });
            if (notebookData && notebookData.ok) {
                const nbSong = findNotebookSongEntry(notebookData, {
                    songTitle: song.titulo || '',
                    artistName,
                    albumTitle
                });
                if (nbSong && nbSong.lyrics) {
                    if (nbSong.trackNumber) {
                        await dbQueryAsync(
                            'UPDATE MusicaCanciones SET numero_pista = COALESCE(numero_pista, ?) WHERE id = ? AND usuario_id = ?',
                            [nbSong.trackNumber, song.id, uid]
                        ).catch(() => {});
                    }
                    const rawTracks = ytdlpService.classifyLyricsIntoFiveTracks(
                        [{ rawLanguage: 'multi', lyrics: nbSong.lyrics, source: notebookData.source || 'drive-word' }],
                        { rawOriginal: nbSong.lyrics }
                    );
                    const allowedNb = resolveAllowedLyricsSections({
                        songLanguage: song.idioma || nbSong.fields?.language || '',
                        rawLyrics: nbSong.lyrics,
                        tracks: rawTracks
                    });
                    const tracks = allowedNb.tracks || rawTracks;
                    const resolvedLyricsText = (allowedNb.formattedLyrics || nbSong.lyrics).slice(0, 50000);
                    const spanishFromTracksOrWord = String(tracks?.es || nbSong.spanishLyrics || '').trim();
                    return {
                        ok: true,
                        tier: 1,
                        songId: song.id,
                        videoId,
                        lyrics: resolvedLyricsText,
                        tracks,
                        trackList: [{ language: 'original', lyrics: resolvedLyricsText, source: notebookData.source || 'drive-word' }],
                        fields: nbSong.fields || null,
                        trackNumber: nbSong.trackNumber || null,
                        spanishSource: spanishFromTracksOrWord ? 'word-cache' : null,
                        tokensUsed: 0,
                        source: notebookData.source || 'drive-word',
                        language: song.idioma || '',
                        pcOnline: isPcBridgeOnline(),
                        storedInDb: false
                    };
                }
            }
        } catch (_) {}
    }

    if (!videoId) {
        return {
            ok: false,
            tier: 4,
            songId: song.id,
            videoId: '',
            reason: 'invalid_video_id',
            error: 'This song does not have a valid YouTube / YouTube Music link and was not found in the Drive Word notebook.',
            canFallbackToPc: isPcBridgeOnline(),
            pcOnline: isPcBridgeOnline(),
            storedInDb: false
        };
    }

    // Tier 2 (YouTube Music InnerTube WEB_REMIX / MPLYt_) + Tier 3 (yt-dlp + LRCLIB + Watch Page + Alt Video + Lyrics.ovh + ASR)
    const extracted = await ytdlpService.extractSongLyrics({
        videoId,
        url: song.yt_music_url || '',
        idioma: song.idioma || '',
        preferredLangs,
        useInnerTube: true,
        useExternalFallbacks: true,
        enrichCaptions: true,
        budgetMs: 30000,
        trackTitle: song.titulo || '',
        trackArtist: artistName,
        trackAlbum: albumTitle
    });

    if (extracted.ok && extracted.lyrics) {
        const rawCleanLyrics = String(extracted.lyrics).trim().slice(0, 50000);
        const allowedExt = resolveAllowedLyricsSections({
            songLanguage: song.idioma || extracted.language || '',
            rawLyrics: rawCleanLyrics,
            tracks: extracted.tracks || null
        });
        const cleanLyrics = (allowedExt.formattedLyrics || rawCleanLyrics).slice(0, 50000);
        const cleanSource = String(extracted.source || 'yt-dlp').trim().slice(0, 80) || 'yt-dlp';
        const isInnerTube = cleanSource.includes('innertube') || cleanSource.includes('ytmusic');
        serverLogger.info('YTDLP', 'Letra resuelta en servidor', {
            songId: song.id,
            videoId,
            tier: isInnerTube ? 2 : 3,
            source: cleanSource
        });
        return {
            ok: true,
            tier: isInnerTube ? 2 : 3,
            songId: song.id,
            videoId,
            lyrics: cleanLyrics,
            tracks: allowedExt.tracks || extracted.tracks || null,
            trackList: extracted.trackList || [],
            spanishSource: (allowedExt.tracks?.es || extracted.tracks?.es) ? 'yt-captions' : null,
            tokensUsed: 0,
            source: cleanSource,
            language: extracted.language || '',
            ytdlpAvailable: Boolean(extracted.ytdlpAvailable),
            availableLangs: extracted.availableLangs || [],
            suggestedCommand: extracted.suggestedCommand || '',
            pcOnline: isPcBridgeOnline(),
            storedInDb: false
        };
    }

    // Tier 4 — Local PC bridge only if Tiers 1-3 failed and PC is online
    serverLogger.warn('YTDLP', 'Sin subtítulos/letra en fuentes del servidor', {
        songId: song.id,
        videoId,
        reason: extracted.reason || 'no_subtitles'
    });
    return {
        ok: false,
        tier: 4,
        songId: song.id,
        videoId,
        reason: extracted.reason || 'no_subtitles',
        error: extracted.error || 'Could not extract lyrics automatically on the cloud server.',
        canFallbackToPc: isPcBridgeOnline(),
        pcOnline: isPcBridgeOnline(),
        ytdlpAvailable: Boolean(extracted.ytdlpAvailable),
        availableLangs: extracted.availableLangs || [],
        suggestedCommand: extracted.suggestedCommand || '',
        storedInDb: false
    };
}

app.post('/api/english/music/songs/:id/resolve-lyrics', apiWriteLimiter.middleware, requireAdmin, async (req, res) => {
    const songId = parsePositiveInt(req.params.id);
    if (!songId) return res.status(400).send('Invalid song ID.');

    const uid = req.user.id;
    try {
        const song = await fetchOwnedMusicSongForMediaOrLyrics(songId, uid);
        if (!song) return res.status(404).send('Song not found.');

        const forceExtract = Boolean(req.body?.forceExtract);
        const preferredLangs = Array.isArray(req.body?.preferredLangs) ? req.body.preferredLangs : null;
        const result = await resolveAutonomousSongLyrics({ song, uid, forceExtract, preferredLangs });
        return res.json(result);
    } catch (err) {
        console.error('[AUTONOMOUS_LYRICS_RESOLVE_ERROR]', err);
        res.status(500).send('Error resolving song lyrics autonomously.');
    }
});

app.post('/api/english/music/songs/:id/lyrics/extract', apiWriteLimiter.middleware, requireAdmin, preventDuplicateSubmit({ dedupeWindowMs: 2500 }), async (req, res) => {
    const songId = parsePositiveInt(req.params.id);
    if (!songId) return res.status(400).send('Invalid song ID.');

    const uid = req.user.id;
    try {
        const song = await fetchOwnedMusicSongForMediaOrLyrics(songId, uid);
        if (!song) return res.status(404).send('Song not found.');

        const videoId =
            ytdlpService.extractValidYouTubeVideoId(song.yt_video_id) ||
            ytdlpService.extractValidYouTubeVideoId(song.yt_music_url);
        if (!videoId) {
            return res.status(400).send('This song does not have a valid YouTube or YouTube Music link yet.');
        }

        const { artistName, albumTitle } = await resolveSongArtistAndAlbumForLyrics(song, uid);
        const preferredLangs = Array.isArray(req.body?.preferredLangs) ? req.body.preferredLangs : null;
        const extracted = await ytdlpService.extractSongLyrics({
            videoId,
            url: song.yt_music_url || '',
            idioma: song.idioma || '',
            preferredLangs,
            useInnerTube: true,
            useExternalFallbacks: true,
            enrichCaptions: true,
            budgetMs: 30000,
            trackTitle: song.titulo || '',
            trackArtist: artistName,
            trackAlbum: albumTitle
        });

        if (extracted.ok && extracted.lyrics) {
            const rawCleanLyrics = String(extracted.lyrics).trim().slice(0, 50000);
            const allowedExt = resolveAllowedLyricsSections({
                songLanguage: song.idioma || extracted.language || '',
                rawLyrics: rawCleanLyrics,
                tracks: extracted.tracks || null
            });
            const cleanLyrics = (allowedExt.formattedLyrics || rawCleanLyrics).slice(0, 50000);
            const cleanSource = String(extracted.source || 'yt-dlp').trim().slice(0, 80) || 'yt-dlp';
            return res.json({
                ok: true,
                songId,
                videoId,
                lyrics: cleanLyrics,
                tracks: allowedExt.tracks || extracted.tracks || null,
                trackList: extracted.trackList || [],
                spanishSource: (allowedExt.tracks?.es || extracted.tracks?.es) ? 'yt-captions' : null,
                tokensUsed: 0,
                source: cleanSource,
                language: extracted.language || '',
                ytdlpAvailable: Boolean(extracted.ytdlpAvailable),
                availableLangs: extracted.availableLangs || [],
                suggestedCommand: extracted.suggestedCommand || '',
                storedInDb: false
            });
        }

        return res.json({
            ok: false,
            songId,
            videoId,
            reason: extracted.reason || 'no_subtitles',
            error: extracted.error || 'Could not extract lyrics automatically for this video.',
            ytdlpAvailable: Boolean(extracted.ytdlpAvailable),
            availableLangs: extracted.availableLangs || [],
            suggestedCommand: extracted.suggestedCommand || '',
            storedInDb: false
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error extracting song lyrics.');
    }
});

app.post('/api/english/music/verify-replace-lyrics', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, async (req, res) => {
    if (!serverNotesService.isServerAutonomousNotesEnabled()) {
        return res.status(409).json({
            ok: false,
            action: 'rejected',
            reason: 'SERVER_NOTES_DISABLED',
            message: 'El modo autónomo de cuaderno Word en servidor no está habilitado.'
        });
    }

    const uid = req.user.id;
    try {
        const songId = parsePositiveInt(req.body?.songId);
        let resolvedTitle = String(req.body?.songTitle || '').trim().slice(0, 300);
        let resolvedArtist = String(req.body?.artistName || '').trim().slice(0, 300);
        let resolvedAlbum = String(req.body?.albumTitle || '').trim().slice(0, 300);
        let resolvedUrl = String(req.body?.ytMusicUrl || '').trim().slice(0, 500);
        let resolvedLanguage = String(req.body?.language || '').trim().slice(0, 80);
        let videoId = ytdlpService.extractValidYouTubeVideoId(resolvedUrl);

        if (songId) {
            const song = await fetchOwnedMusicSongForMediaOrLyrics(songId, uid);
            if (!song) {
                return res.status(404).json({
                    ok: false,
                    action: 'not_found',
                    reason: 'SONG_NOT_FOUND',
                    message: 'Song not found.'
                });
            }
            const meta = await resolveSongArtistAndAlbumForLyrics(song, uid);
            resolvedTitle = String(song.titulo || resolvedTitle).trim().slice(0, 300);
            resolvedArtist = String(meta.artistName || resolvedArtist).trim().slice(0, 300);
            resolvedAlbum = String(meta.albumTitle || resolvedAlbum).trim().slice(0, 300);
            resolvedUrl = String(song.yt_music_url || resolvedUrl).trim().slice(0, 500);
            resolvedLanguage = String(song.idioma || resolvedLanguage).trim().slice(0, 80);
            videoId = ytdlpService.extractValidYouTubeVideoId(song.yt_video_id)
                || ytdlpService.extractValidYouTubeVideoId(resolvedUrl)
                || videoId;
        }

        if (!resolvedTitle) {
            return res.status(400).json({
                ok: false,
                action: 'rejected',
                reason: 'MISSING_SONG_TITLE',
                message: 'Falta el título de la canción.'
            });
        }

        const notebookSnapshot = await getStudyNotebookDataForUser({ forceRefresh: true });
        const existingSong = notebookSnapshot && notebookSnapshot.ok
            ? findNotebookSongEntry(notebookSnapshot, {
                songTitle: resolvedTitle,
                artistName: resolvedArtist,
                albumTitle: resolvedAlbum
            })
            : null;
        if (!existingSong) {
            return res.status(404).json({
                ok: false,
                action: 'not_found',
                reason: 'SONG_NOT_FOUND',
                message: 'La canción aún no existe en English_Learning_Notebook.docx.'
            });
        }

        if (!resolvedUrl) {
            resolvedUrl = String(existingSong.fields?.yt_music_url || '').trim().slice(0, 500);
        }
        if (!resolvedLanguage) {
            resolvedLanguage = String(existingSong.fields?.language || '').trim().slice(0, 80);
        }
        if (!videoId) {
            videoId = ytdlpService.extractValidYouTubeVideoId(resolvedUrl);
        }
        if (!videoId) {
            return res.status(400).json({
                ok: false,
                action: 'rejected',
                reason: 'INVALID_VIDEO_ID',
                message: 'La canción no tiene un enlace válido de YouTube / YouTube Music.'
            });
        }

        const effectiveLanguage = existingSong.fields?.language || resolvedLanguage;
        const existingAllowed = resolveAllowedLyricsSections({
            songLanguage: effectiveLanguage,
            rawLyrics: existingSong.lyrics
        });

        const extracted = await ytdlpService.extractSongLyrics({
            videoId,
            url: resolvedUrl,
            idioma: effectiveLanguage,
            useInnerTube: true,
            useExternalFallbacks: true,
            enrichCaptions: true,
            budgetMs: 30000,
            trackTitle: existingSong.songTitle || resolvedTitle,
            trackArtist: existingSong.artist || resolvedArtist,
            trackAlbum: existingSong.album || resolvedAlbum
        });

        let sanitizedFresh = '';
        if (extracted && extracted.ok && String(extracted.lyrics || '').trim()) {
            const cleanedFresh = ytdlpService.stripNonLyricAudioTags(extracted.lyrics).trim().slice(0, 50000);
            const sectionFixedFresh = resolveLyricsSectionMismatch(notebookSnapshot, {
                songTitle: existingSong.songTitle || resolvedTitle,
                artistName: existingSong.artist || resolvedArtist,
                language: effectiveLanguage,
                lyrics: cleanedFresh
            });
            const candidateRaw = String(sectionFixedFresh.lyrics || cleanedFresh).trim();
            const allowedFresh = resolveAllowedLyricsSections({
                songLanguage: effectiveLanguage,
                rawLyrics: candidateRaw,
                tracks: sectionFixedFresh.fixed ? null : (extracted.tracks || null)
            });
            sanitizedFresh = String(allowedFresh.formattedLyrics || candidateRaw).trim().slice(0, 50000);
        } else if (existingAllowed.isPureEnglish && existingAllowed.hadRedundantEnglish && existingAllowed.formattedLyrics) {
            const selfCheck = compareExistingVsFreshLyrics(existingSong, existingAllowed.formattedLyrics, {
                notebookData: notebookSnapshot,
                songTitle: existingSong.songTitle || resolvedTitle,
                artistName: existingSong.artist || resolvedArtist,
                language: effectiveLanguage
            });
            if (selfCheck.freshValid) {
                sanitizedFresh = existingAllowed.formattedLyrics.slice(0, 50000);
            }
        }

        if (!sanitizedFresh) {
            return res.status(409).json({
                ok: false,
                action: 'rejected',
                reason: extracted?.reason || 'NO_RELIABLE_LYRICS',
                message: 'No se pudo obtener una letra verificada para esta canción; el archivo Word no fue modificado.'
            });
        }

        let comparisonResult = null;
        const saveRes = await runWithDocxLock('pdh_docx_english', () =>
            serverNotesService.saveEnglishEntryToCloudAndLocal({
                entry: {
                    category: 'music',
                    song_title: existingSong.songTitle || resolvedTitle,
                    artists_display: existingSong.artist || resolvedArtist,
                    language: existingSong.fields?.language || resolvedLanguage || 'English',
                    yt_music_url: resolvedUrl,
                    lyrics_study: sanitizedFresh,
                    replace_lyrics: true
                },
                resolveRcloneFn: resolveRcloneConfigPath,
                resolveStudyTargetFn: resolveStudyDriveRemoteTarget,
                updateCacheFn: updateStudyNotebookCacheFromBuffer,
                lyricsGuardFn: createEnglishLyricsGuard({
                    mode: 'replace',
                    freshLyrics: sanitizedFresh,
                    songTitle: existingSong.songTitle || resolvedTitle,
                    artistName: existingSong.artist || resolvedArtist,
                    language: existingSong.fields?.language || resolvedLanguage,
                    onComparison: (cmp) => { comparisonResult = cmp; }
                }),
                rootDir: __dirname
            })
        );

        if (saveRes && saveRes.reason === 'UNCHANGED') {
            return res.json({
                ok: true,
                action: 'unchanged',
                similarity: saveRes.similarity ?? 1,
                message: 'La letra guardada ya coincide y está verificada.'
            });
        }

        if (saveRes && saveRes.ok) {
            if (saveRes.needsRetry) {
                scheduleStudyDriveRetry();
            } else {
                _englishDriveRetryCount = 0;
            }
            bumpSyncRevision('music');
            serverLogger.info('DRIVE_NOTES', 'Letra verificada y reemplazada en Word', {
                heading: saveRes.heading,
                previousStatus: comparisonResult?.status || 'mismatch',
                verified: Boolean(saveRes.verified),
                mode: saveRes.mode
            });
            return res.json({
                ok: true,
                action: 'replaced',
                previousStatus: comparisonResult?.status || 'mismatch',
                similarity: comparisonResult?.similarity ?? 0,
                lyrics: sanitizedFresh,
                mode: saveRes.mode,
                verified: Boolean(saveRes.verified),
                needsRetry: Boolean(saveRes.needsRetry),
                message: 'Letra verificada y reemplazada correctamente en Word.'
            });
        }

        if (['DUPLICATE_OTHER_SONG', 'SECTION_MISMATCH', 'NO_RELIABLE_LYRICS', 'EMPTY_LYRICS'].includes(saveRes?.reason)) {
            return res.status(409).json({
                ok: false,
                action: 'rejected',
                reason: saveRes.reason,
                matchedSong: saveRes.matchedSong || '',
                similarity: saveRes.similarity ?? null,
                message: saveRes.error || 'La letra candidata no pasó la validación; el archivo Word no fue modificado.'
            });
        }

        if (saveRes?.reason === 'SONG_NOT_FOUND') {
            return res.status(404).json({
                ok: false,
                action: 'not_found',
                reason: 'SONG_NOT_FOUND',
                message: saveRes.error || 'La canción no se encontró en English_Learning_Notebook.docx.'
            });
        }

        return res.status(500).json({
            ok: false,
            action: 'error',
            reason: saveRes?.reason || 'VERIFY_REPLACE_FAILED',
            message: saveRes?.error || 'Error al verificar y actualizar la letra en Word.'
        });
    } catch (err) {
        console.error('[VERIFY_REPLACE_LYRICS_ERROR]', err);
        if (err && err.code === 'LOCK_TIMEOUT') {
            return res.status(503).json({
                ok: false,
                action: 'error',
                reason: 'LOCK_TIMEOUT',
                message: 'Concurrent English Notebook file write busy; please retry shortly.'
            });
        }
        return res.status(500).json({
            ok: false,
            action: 'error',
            reason: 'VERIFY_REPLACE_FAILED',
            message: 'Error verifying and replacing song lyrics.'
        });
    }
});

app.get('/api/english/music/songs/:id/media', apiReadLimiter.middleware, requireAdmin, async (req, res) => {
    const songId = parsePositiveInt(req.params.id);
    if (!songId) return res.status(400).send('Invalid song ID.');

    const uid = req.user.id;
    let headerTimer = null;
    const controller = new AbortController();
    const onClientClose = () => controller.abort();
    req.on('close', onClientClose);

    try {
        const song = await fetchOwnedMusicSongForMediaOrLyrics(songId, uid);
        if (!song) return res.status(404).send('Song not found.');

        const videoId =
            ytdlpService.extractValidYouTubeVideoId(song.yt_video_id) ||
            ytdlpService.extractValidYouTubeVideoId(song.yt_music_url);
        if (!videoId) {
            return res.status(400).send('This song does not have a valid YouTube or YouTube Music link yet.');
        }

        const rawRange = String(req.headers.range || '').trim();
        const safeRange = /^bytes=\d*-\d*$/i.test(rawRange) ? rawRange : '';

        let streamInfo = await ytdlpService.resolvePlayableMediaStream({
            videoId,
            url: song.yt_music_url || ''
        });
        if (!streamInfo.ok || !streamInfo.streamUrl) {
            const status = streamInfo.reason === 'ytdlp_missing' ? 503 : 502;
            return res.status(status).json({
                error: streamInfo.error || 'Could not resolve playable stream via yt-dlp.',
                reason: streamInfo.reason || 'ytdlp_stream_error'
            });
        }

        const buildUpstreamHeaders = (info) => {
            const h = { ...(info.headers || {}) };
            if (safeRange) h.Range = safeRange;
            return h;
        };

        headerTimer = setTimeout(() => controller.abort(), 30000);
        let upstream = await openAllowedMediaUpstreamResponse(
            streamInfo.streamUrl,
            buildUpstreamHeaders(streamInfo),
            controller.signal
        );

        // Retry once with forced fresh CDN signature if cached URL expired (HTTP 403/410)
        if (upstream && (upstream.status === 403 || upstream.status === 410)) {
            try { await upstream.body?.cancel(); } catch (_) {}
            streamInfo = await ytdlpService.resolvePlayableMediaStream({
                videoId,
                url: song.yt_music_url || '',
                forceRefresh: true
            });
            if (streamInfo.ok && streamInfo.streamUrl) {
                upstream = await openAllowedMediaUpstreamResponse(
                    streamInfo.streamUrl,
                    buildUpstreamHeaders(streamInfo),
                    controller.signal
                );
            } else {
                upstream = null;
            }
        }

        if (headerTimer) {
            clearTimeout(headerTimer);
            headerTimer = null;
        }

        if (!upstream || (upstream.status !== 200 && upstream.status !== 206) || !upstream.body) {
            try { await upstream?.body?.cancel(); } catch (_) {}
            return res.status(502).json({
                error: 'Upstream media stream rejected playback or returned no body.',
                reason: 'upstream_rejected'
            });
        }

        const rawType = String(upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        const contentType = SAFE_MEDIA_CONTENT_TYPES.has(rawType)
            ? rawType
            : (streamInfo.contentType || 'video/mp4');

        res.status(upstream.status === 206 ? 206 : 200);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');

        const contentLength = upstream.headers.get('content-length');
        if (contentLength && /^\d+$/.test(contentLength)) {
            res.setHeader('Content-Length', contentLength);
        }
        const contentRange = upstream.headers.get('content-range');
        if (contentRange && upstream.status === 206) {
            res.setHeader('Content-Range', contentRange);
        }

        if (req.method === 'HEAD') {
            try { await upstream.body.cancel(); } catch (_) {}
            return res.end();
        }

        await pipeline(Readable.fromWeb(upstream.body), res);
    } catch (err) {
        if (headerTimer) {
            clearTimeout(headerTimer);
            headerTimer = null;
        }
        const code = err?.code || err?.name;
        if (code === 'ABORT_ERR' || code === 'AbortError' || code === 'ERR_STREAM_PREMATURE_CLOSE') {
            return;
        }
        console.error('Error streaming yt-dlp song media:', err.message);
        if (!res.headersSent) {
            res.status(502).json({ error: 'Failed to stream track through server.' });
        } else if (!res.destroyed) {
            res.destroy();
        }
    } finally {
        if (headerTimer) clearTimeout(headerTimer);
        req.off('close', onClientClose);
    }
});

app.patch('/api/english/music/artists/:id', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, preventDuplicateSubmit({ dedupeWindowMs: 0 }), async (req, res) => {
    const artistId = parsePositiveInt(req.params.id);
    if (!artistId) return res.status(400).send('Invalid artist ID.');

    const cleanName = String(req.body.nombre || '').trim().replace(/\s+/g, ' ').slice(0, 140);
    const norm = normalizarTextoCatalogo(cleanName);
    if (!norm) return res.status(400).send('Artist name is required.');

    const tipo = ['solo', 'group', 'duo', 'collab_project'].includes(req.body.tipoArtista)
        ? req.body.tipoArtista
        : 'group';
    const notasCortas = String(req.body.notasCortas || '').trim().slice(0, 255) || null;
    const uid = req.user.id;

    try {
        const existing = await dbQueryAsync(
            'SELECT id FROM MusicaArtistas WHERE id = ? AND usuario_id = ? LIMIT 1',
            [artistId, uid]
        );
        if (!existing.length) return res.status(404).send('Artist not found.');

        const conflict = await dbQueryAsync(
            'SELECT id FROM MusicaArtistas WHERE usuario_id = ? AND nombre_normalizado = ? AND id <> ? LIMIT 1',
            [uid, norm, artistId]
        );
        if (conflict.length) {
            return res.status(409).send('Another artist with that name already exists in your catalog.');
        }

        const fuzzyNorm = normalizarClaveFuzzyCatalogo(cleanName);
        if (fuzzyNorm) {
            const allArtists = await dbQueryAsync(
                'SELECT id, nombre, tipo_artista, notas_cortas, creado_en FROM MusicaArtistas WHERE usuario_id = ? ORDER BY nombre ASC',
                [uid]
            );
            const fuzzyConflict = (allArtists || []).find(
                (a) => Number(a.id) !== Number(artistId) && normalizarClaveFuzzyCatalogo(a.nombre) === fuzzyNorm
            );
            if (fuzzyConflict) {
                return res.status(409).send('Another artist with that name already exists in your catalog.');
            }
        }

        await dbQueryAsync(
            'UPDATE MusicaArtistas SET nombre = ?, nombre_normalizado = ?, tipo_artista = ?, notas_cortas = ? WHERE id = ? AND usuario_id = ?',
            [cleanName, norm, tipo, notasCortas, artistId, uid]
        );
        bumpSyncRevision('music');
        res.json({ message: 'Artist updated successfully.', id: artistId, nombre: cleanName, tipo_artista: tipo, notas_cortas: notasCortas });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error updating artist.');
    }
});

app.patch('/api/english/music/albums/:id', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, preventDuplicateSubmit({ dedupeWindowMs: 0 }), async (req, res) => {
    const albumId = parsePositiveInt(req.params.id);
    if (!albumId) return res.status(400).send('Invalid album ID.');

    const cleanTitle = String(req.body.titulo || '').trim().replace(/\s+/g, ' ').slice(0, 180);
    const norm = normalizarTextoCatalogo(cleanTitle);
    if (!norm) return res.status(400).send('Album title is required.');

    const tipo = MUSIC_RELEASE_TYPES.has(req.body.tipoLanzamiento) ? req.body.tipoLanzamiento : 'album';
    const rawYear = req.body.anio !== undefined && req.body.anio !== '' && req.body.anio !== null ? Number(req.body.anio) : null;
    const anio = rawYear && Number.isInteger(rawYear) && rawYear >= 1950 && rawYear <= 2100 ? rawYear : null;
    const uid = req.user.id;

    try {
        const existing = await dbQueryAsync(
            'SELECT id FROM MusicaAlbumes WHERE id = ? AND usuario_id = ? LIMIT 1',
            [albumId, uid]
        );
        if (!existing.length) return res.status(404).send('Album not found.');

        const { albums } = await fetchUserMusicAlbumsAndSongs(uid);
        const currentAlbum = (albums || []).find((a) => Number(a.id) === Number(albumId));
        const currentArtistId = currentAlbum ? Number(currentAlbum.artista_principal_id || 0) : 0;
        const fuzzyNorm = normalizarClaveFuzzyCatalogo(cleanTitle);
        const conflictAlbum = (albums || []).find(
            (a) => Number(a.id) !== Number(albumId)
                && Number(a.artista_principal_id || 0) === currentArtistId
                && (normalizarTextoCatalogo(a.titulo) === norm || (fuzzyNorm && normalizarClaveFuzzyCatalogo(a.titulo) === fuzzyNorm))
        );
        if (conflictAlbum) {
            return res.status(409).send('Another album with that title already exists for this artist.');
        }

        await dbQueryAsync(
            'UPDATE MusicaAlbumes SET titulo = ?, titulo_normalizado = ?, tipo_lanzamiento = ?, anio = ? WHERE id = ? AND usuario_id = ?',
            [cleanTitle, norm, tipo, anio, albumId, uid]
        );
        bumpSyncRevision('music');
        res.json({ message: 'Album updated successfully.', id: albumId, titulo: cleanTitle, tipo_lanzamiento: tipo, anio });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error updating album.');
    }
});

app.post('/api/english/music/albums', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, preventDuplicateSubmit({ dedupeWindowMs: 6000 }), async (req, res) => {
    const cleanTitle = String(req.body.albumTitle || req.body.titulo || req.body.title || '').trim().replace(/\s+/g, ' ');
    const normTitle = normalizarTextoCatalogo(cleanTitle);
    if (!normTitle || cleanTitle.length > 180) {
        return res.status(400).send('Album / Mini Album title is required (max 180 characters).');
    }

    const mainArtist = String(req.body.mainArtist || req.body.artistaPrincipal || '').trim().replace(/\s+/g, ' ');
    if (!mainArtist || mainArtist.length > 140) {
        return res.status(400).send('Main artist or group name is required (max 140 characters).');
    }

    const rawType = String(req.body.albumType || req.body.tipoLanzamiento || 'mini_album').trim().toLowerCase();
    const tipoLanzamiento = MUSIC_RELEASE_TYPES.has(rawType) ? rawType : 'mini_album';

    const rawYear = req.body.albumYear ?? req.body.anio;
    let anio = null;
    if (rawYear !== undefined && rawYear !== null && String(rawYear).trim() !== '') {
        const y = Number.parseInt(rawYear, 10);
        if (!Number.isInteger(y) || y < 1900 || y > 2100) {
            return res.status(400).send('Album release year must be between 1900 and 2100.');
        }
        anio = y;
    }

    const artistType = ['solo', 'group', 'duo', 'collab_project'].includes(req.body.artistType)
        ? req.body.artistType
        : 'solo';
    const notasCortas = req.body.notasCortas ? String(req.body.notasCortas).trim().slice(0, 255) : null;
    const uid = req.user.id;

    try {
        const mainArtistId = await upsertMusicaArtista(uid, mainArtist, artistType, { updateExisting: true });
        const albumId = await upsertMusicaAlbum({
            usuarioId: uid,
            albumTitle: cleanTitle,
            albumType: tipoLanzamiento,
            albumYear: anio,
            mainArtistId
        });

        if (albumId && notasCortas) {
            await dbQueryAsync(
                'UPDATE MusicaAlbumes SET notas_cortas = ? WHERE id = ? AND usuario_id = ?',
                [notasCortas, albumId, uid]
            );
        }

        bumpSyncRevision('music');
        res.status(201).json({
            message: 'Album / Mini Album saved to catalog.',
            album: {
                id: albumId,
                artista_principal_id: mainArtistId,
                artista_principal_nombre: mainArtist,
                titulo: cleanTitle,
                tipo_lanzamiento: tipoLanzamiento,
                anio,
                notas_cortas: notasCortas
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error saving album to catalog.');
    }
});

app.delete('/api/english/music/albums/:id', apiWriteLimiter.middleware, requireAdmin, preventDuplicateSubmit({ dedupeWindowMs: 0 }), async (req, res) => {
    const albumId = parsePositiveInt(req.params.id);
    if (!albumId) return res.status(400).send('Invalid album ID.');

    try {
        const uid = req.user.id;
        await dbQueryAsync(
            'UPDATE MusicaCanciones SET album_id = NULL WHERE album_id = ? AND usuario_id = ?',
            [albumId, uid]
        );
        const del = await dbQueryAsync(
            'DELETE FROM MusicaAlbumes WHERE id = ? AND usuario_id = ?',
            [albumId, uid]
        );
        if (!del.affectedRows) return res.status(404).send('Album not found.');

        bumpSyncRevision('music');
        res.json({ message: 'Album deleted successfully (its songs were preserved as standalone tracks).', id: albumId });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error deleting album.');
    }
});

// =========================================================================
// SIMULATED HTTPS HYBRID TRANSPORT LAYER (X25519 + AES-256-CTR + HMAC-SHA256)
// =========================================================================
app.post('/api/transport/handshake', transportHandshakeLimiter.middleware, requireNonEmptyBody, (req, res) => {
    try {
        const result = transportManager.createHandshakeResponse(req.body.clientPub);
        res.json(result);
    } catch (err) {
        res.status(err.status || 400).json({
            error: err.message || 'Transport handshake failed.',
            code: err.code || 'TRANSPORT_HANDSHAKE_ERROR'
        });
    }
});

app.get('/api/transport/status', apiReadLimiter.middleware, (req, res) => {
    const kid = typeof req.headers['x-transport-session'] === 'string'
        ? req.headers['x-transport-session'].trim()
        : null;
    res.json(transportManager.getStatusSnapshot(kid));
});

app.post('/api/transport/benchmark', apiWriteLimiter.middleware, requireAuth, requireNonEmptyBody, (req, res) => {
    const startedNs = process.hrtime.bigint();
    const rawPayload = typeof req.body.samplePayload === 'string'
        ? req.body.samplePayload
        : JSON.stringify(req.body.samplePayload || {});
    const byteLength = Buffer.byteLength(rawPayload, 'utf8');
    const sha256 = crypto.createHash('sha256').update(rawPayload, 'utf8').digest('hex').slice(0, 16);
    const serverProcessMs = Number(Number(process.hrtime.bigint() - startedNs) / 1e6).toFixed(3);

    res.json({
        ok: true,
        encryptedIn: Boolean(req.transportEncryptedIn),
        serverDecryptMs: req.transportDecryptMs ?? null,
        serverProcessMs: Number(serverProcessMs),
        payloadBytes: byteLength,
        sha256Prefix: sha256,
        echoSample: req.body.echo ? rawPayload : undefined,
        protocol: TRANSPORT_PROTOCOL
    });
});

// =========================================================================
// MULTI-LANGUAGE STUDY & AI LYRICS ENGINE (English, Korean, K-Pop EN+KR)
// =========================================================================
app.get('/api/language/registry', apiReadLimiter.middleware, requireAdmin, async (req, res) => {
    try {
        const settings = await loadUserSettings(req.user.id);
        const mem = sanitizeLanguageMemory(settings.languageMemory);
        const effectiveKey = String(settings.geminiApiKey || process.env.GEMINI_API_KEY || '').trim();
        const modelInfo = await getAvailableGeminiModelsForUser({ apiKey: effectiveKey });
        const onlyAvailableModels = modelInfo.models.filter((m) => m.available !== false);

        res.json({
            languages: getLanguageRegistry(),
            geminiModels: onlyAvailableModels,
            preferredStudyLanguage: settings.preferredStudyLanguage || 'en',
            activeGeminiModel: settings.geminiModel || 'gemini-2.5-flash',
            geminiKeyConfigured: Boolean(effectiveKey),
            pcOnline: isPcBridgeOnline(),
            languageMemory: mem
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error loading language registry.');
    }
});

app.get('/api/language/memory', apiReadLimiter.middleware, requireAdmin, async (req, res) => {
    try {
        const settings = await loadUserSettings(req.user.id);
        res.json({
            languageMemory: sanitizeLanguageMemory(settings.languageMemory)
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error loading AI language learning memory.');
    }
});

app.post('/api/language/memory', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, async (req, res) => {
    try {
        const settings = await loadUserSettings(req.user.id);
        if (req.body.clear === true) {
            settings.languageMemory = sanitizeLanguageMemory();
        } else {
            settings.languageMemory = mergeLanguageMemory(settings.languageMemory, {
                terms: Array.isArray(req.body.terms) ? req.body.terms : (req.body.term || req.body.word ? [req.body] : []),
                grammarNotes: Array.isArray(req.body.grammarNotes) ? req.body.grammarNotes : [],
                songTitle: req.body.songTitle || '',
                artistName: req.body.artistName || '',
                language: req.body.language || settings.preferredStudyLanguage || 'en_ko',
                customContext: req.body.customContext
            });
        }
        await saveUserSettings(req.user.id, settings);
        bumpSyncRevision('settings');
        res.json({
            message: 'AI Learning Memory updated.',
            languageMemory: settings.languageMemory
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error updating AI language learning memory.');
    }
});

app.post('/api/language/romanize', apiReadLimiter.middleware, requireAdmin, requireNonEmptyBody, (req, res) => {
    const text = String(req.body.text || '').trim().slice(0, 5000);
    if (!text) {
        return res.status(400).send('Provide Korean or Japanese text or mixed lyrics to romanize.');
    }
    const romanization = hasJapaneseScript(text) && !/[\uAC00-\uD7A3]/.test(text)
        ? kanaToRomaji(text)
        : hangulToRomanization(text);
    return res.json({
        text,
        script: detectScriptKind(text),
        romanization
    });
});

app.get('/api/language/alphabet-guide', apiReadLimiter.middleware, requireAdmin, async (req, res) => {
    try {
        const settings = await loadUserSettings(req.user.id);
        const uiLang = req.headers['x-ui-lang'] === 'en' ? 'en' : 'es';
        const language = normalizeStudyLanguage(req.query.language || settings.preferredStudyLanguage || 'ko');
        const guide = ALPHABET_COMPOSITION_GUIDES[language] || ALPHABET_COMPOSITION_GUIDES.ko;
        return res.json({
            ok: true,
            languageCode: language,
            language: getLanguageSectionMeta(language, uiLang).label,
            guide,
            availableLanguages: Object.keys(ALPHABET_COMPOSITION_GUIDES)
        });
    } catch (err) {
        console.error('[ALPHABET_GUIDE_GET_ERR]', err.message);
        return res.status(500).send('Error loading alphabet & composition guide.');
    }
});

app.post('/api/language/alphabet-guide', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, async (req, res) => {
    try {
        const settings = await loadUserSettings(req.user.id);
        const uiLang = req.headers['x-ui-lang'] === 'en' ? 'en' : 'es';
        const language = normalizeStudyLanguage(req.body.language || settings.preferredStudyLanguage || 'ko');
        const customFocus = String(req.body.customFocus || req.body.focus || '').trim().slice(0, 500);
        const mode = String(req.body.mode || 'auto').trim().toLowerCase();
        const apiKey = String(settings.geminiApiKey || process.env.GEMINI_API_KEY || '').trim();
        const model = validateGeminiModelId(req.body.model || settings.geminiModel);

        const result = await generateAlphabetGuideWithAi({
            apiKey,
            model,
            language,
            customFocus,
            mode,
            learningMemory: settings.languageMemory,
            uiLang
        });
        return res.json(result);
    } catch (err) {
        console.error('[ALPHABET_GUIDE_POST_ERR]', err.message);
        return res.status(500).send('Error generating AI alphabet & composition guide.');
    }
});

let _koreanPracticeDriveCache = {
    loadedAt: 0,
    syncedFromDrive: false,
    driveFiles: [],
    liveParagraphs: []
};

app.get('/api/language/korean-practice-drive', apiReadLimiter.middleware, requireAdmin, async (req, res) => {
    const forceSync = String(req.query.syncDrive || '') === '1';
    const cacheValid = !forceSync && _koreanPracticeDriveCache.loadedAt > 0
        && (Date.now() - _koreanPracticeDriveCache.loadedAt < 5 * 60 * 1000);

    if (cacheValid && _koreanPracticeDriveCache.syncedFromDrive) {
        return res.json({
            ok: true,
            readOnly: true,
            saved: false,
            folderId: KOREAN_PRACTICE_DRIVE_FOLDER_ID,
            folderUrl: KOREAN_PRACTICE_DRIVE_URL,
            fileName: KOREAN_PRACTICE_DRIVE_DOC_NAME,
            syncedFromDrive: true,
            driveFiles: _koreanPracticeDriveCache.driveFiles,
            liveParagraphs: _koreanPracticeDriveCache.liveParagraphs,
            notes: KOREAN_PRACTICE_DRIVE_NOTES
        });
    }

    let syncedFromDrive = false;
    let driveFiles = [];
    let liveParagraphs = [];

    if (forceSync) {
        const { confPath: rcloneConf, cleanup: cleanupConf } = resolveRcloneConfigPath({ preferStudy: false });
        try {
            if (rcloneConf && fs.existsSync(rcloneConf)) {
                const mainRemote = String(process.env.RCLONE_REMOTE || 'gdrive').trim() || 'gdrive';
                const remoteSpec = `${mainRemote},root_folder_id=${KOREAN_PRACTICE_DRIVE_FOLDER_ID}:`;
                const lsRaw = await serverNotesService.runRcloneCommand({
                    rcloneConf,
                    args: ['lsjson', remoteSpec],
                    timeout: 8000
                });
                const entries = JSON.parse(String(lsRaw || '[]'));
                if (Array.isArray(entries)) {
                    driveFiles = entries
                        .filter((f) => f && f.Name && !f.IsDir)
                        .map((f) => ({ name: String(f.Name), size: Number(f.Size) || 0, modTime: String(f.ModTime || '') }));
                    const targetDoc = driveFiles.find((f) => /\.docx$/i.test(f.name) && f.size > 0 && f.size < 8 * 1024 * 1024);
                    if (targetDoc) {
                        const docBuf = await serverNotesService.runRcloneCommand({
                            rcloneConf,
                            args: ['cat', `${remoteSpec}${targetDoc.name}`],
                            timeout: 12000,
                            encoding: 'buffer',
                            maxBuffer: 8 * 1024 * 1024
                        });
                        if (Buffer.isBuffer(docBuf) && docBuf.length > 64) {
                            liveParagraphs = extractKoreanPracticeParagraphsFromDocx(docBuf);
                            syncedFromDrive = liveParagraphs.length > 0;
                        }
                    } else if (driveFiles.length > 0) {
                        syncedFromDrive = true;
                    }
                }
            }
        } catch (_driveErr) {
            syncedFromDrive = false;
        } finally {
            if (cleanupConf && rcloneConf && fs.existsSync(rcloneConf)) {
                try { fs.unlinkSync(rcloneConf); } catch (_) {}
            }
        }
        _koreanPracticeDriveCache = {
            loadedAt: Date.now(),
            syncedFromDrive,
            driveFiles,
            liveParagraphs
        };
    }

    return res.json({
        ok: true,
        readOnly: true,
        saved: false,
        folderId: KOREAN_PRACTICE_DRIVE_FOLDER_ID,
        folderUrl: KOREAN_PRACTICE_DRIVE_URL,
        fileName: (driveFiles[0] && driveFiles[0].name) || KOREAN_PRACTICE_DRIVE_DOC_NAME,
        syncedFromDrive,
        driveFiles,
        liveParagraphs,
        notes: KOREAN_PRACTICE_DRIVE_NOTES
    });
});

app.post('/api/language/korean-symbol-compare', apiReadLimiter.middleware, requireAdmin, (req, res) => {
    try {
        const input = String(req.body?.input || '').trim().slice(0, 120);
        const compareWith = String(req.body?.compareWith || '').trim().slice(0, 120);
        const analysis = compareAndAnalyzeKoreanSymbols(input, compareWith);
        return res.json({
            ok: true,
            saved: false,
            readOnly: true,
            folderUrl: KOREAN_PRACTICE_DRIVE_URL,
            analysis
        });
    } catch (err) {
        console.error('[KOREAN_SYMBOL_COMPARE_ERR]', err.message);
        return res.status(500).send('Error analyzing Korean symbols.');
    }
});

async function loadUserRepertoireForAi(uid) {
    try {
        const [songs, songArtists] = await Promise.all([
            dbQueryAsync(
                `SELECT c.id, c.album_id, al.titulo AS album_titulo, al.tipo_lanzamiento AS album_tipo,
                        al.anio AS album_anio, c.titulo, c.numero_pista, c.idioma,
                        c.yt_music_url, c.yt_video_id, c.thumbnail_url, c.estado_estudio,
                        c.enfoque_corto, c.word_sincronizado, c.ultimo_estudio_en,
                        c.creado_en, c.actualizado_en
                 FROM MusicaCanciones c
                 LEFT JOIN MusicaAlbumes al ON al.id = c.album_id
                 WHERE c.usuario_id = ?
                 ORDER BY c.actualizado_en DESC, c.id DESC`,
                [uid]
            ),
            dbQueryAsync(
                `SELECT mca.cancion_id, mca.artista_id, mca.rol, mca.orden, ma.nombre
                 FROM MusicaCancionArtistas mca
                 INNER JOIN MusicaCanciones c ON c.id = mca.cancion_id
                 INNER JOIN MusicaArtistas ma ON ma.id = mca.artista_id
                 WHERE c.usuario_id = ?
                 ORDER BY mca.orden ASC, ma.nombre ASC`,
                [uid]
            )
        ]);
        const artistsBySong = new Map();
        for (const link of songArtists || []) {
            if (!artistsBySong.has(link.cancion_id)) artistsBySong.set(link.cancion_id, []);
            artistsBySong.get(link.cancion_id).push(link.nombre);
        }
        return (songs || []).slice(0, 60).map((s) => ({
            id: s.id,
            titulo: s.titulo,
            album: s.album_titulo || '',
            albumTipo: s.album_tipo || '',
            anio: s.album_anio || null,
            idioma: s.idioma || '',
            estado: s.estado_estudio || 'to_study',
            enfoque: s.enfoque_corto || '',
            artistas: artistsBySong.get(s.id) || []
        }));
    } catch (_) {
        return [];
    }
}

function createBoundedAiCache(maxEntries = 150, ttlMs = 24 * 60 * 60 * 1000) {
    const store = new Map();
    return {
        get(key) {
            const entry = store.get(key);
            if (!entry) return null;
            if (Date.now() - entry.createdAt > ttlMs) {
                store.delete(key);
                return null;
            }
            return entry.result;
        },
        set(key, result) {
            if (store.has(key)) store.delete(key);
            while (store.size >= maxEntries) {
                const oldestKey = store.keys().next().value;
                if (!oldestKey) break;
                store.delete(oldestKey);
            }
            store.set(key, { result, createdAt: Date.now() });
        }
    };
}

const languageAnalysisCache = createBoundedAiCache(150);
const languageTranslationCache = createBoundedAiCache(300);
const lyricsTranslationCache = createBoundedAiCache(120);

app.post('/api/language/analyze', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, async (req, res) => {
    try {
        const text = String(req.body.text || '').trim();
        const question = String(req.body.question || '').trim();
        if (!text && !question) {
            return res.status(400).send('Paste lyrics, a phrase, or a language question to analyze.');
        }
        if (text.length > 10000 || question.length > 1000) {
            return res.status(400).send('Lyrics text cannot exceed 10,000 characters.');
        }

        const [settings, repertoire] = await Promise.all([
            loadUserSettings(req.user.id),
            loadUserRepertoireForAi(req.user.id)
        ]);
        const currentMemory = sanitizeLanguageMemory(settings.languageMemory);
        const mode = ['auto', 'gemini', 'offline'].includes(String(req.body.mode || 'auto').toLowerCase())
            ? String(req.body.mode || 'auto').toLowerCase()
            : 'auto';
        const direction = normalizeTranslationDirection(req.body.direction || 'auto');
        const language = normalizeStudyLanguage(req.body.language || settings.preferredStudyLanguage || 'en_ko');
        const requestedReasoning = String(req.body.reasoningMode || settings.geminiMode || 'fast').toLowerCase() === 'reasoning';
        const configuredForMode = requestedReasoning
            ? (settings.geminiModelReasoning || settings.geminiModel)
            : (settings.geminiModelFast || settings.geminiModel);
        const model = validateGeminiModelId(req.body.model || configuredForMode || 'gemini-2.5-flash');
        const inlineKey = typeof req.body.apiKey === 'string' ? req.body.apiKey.trim() : '';
        const effectiveKey = inlineKey || settings.geminiApiKey || process.env.GEMINI_API_KEY || '';
        const songTitle = String(req.body.songTitle || '').trim().slice(0, 180);
        const artistName = String(req.body.artistName || '').trim().slice(0, 140);

        const uiLang = req.headers['x-ui-lang'] || req.body?.uiLang || 'es';
        const forceRefresh = req.body.forceRefresh === true;
        const analysisCacheKey = crypto
            .createHash('sha256')
            .update(`${req.user.id}|${language}|${uiLang}|${songTitle.toLowerCase()}|${artistName.toLowerCase()}|${text.replace(/\s+/g, ' ').trim()}|${question.replace(/\s+/g, ' ').trim()}`)
            .digest('hex');

        const ramHit = (!forceRefresh && mode !== 'offline') ? languageAnalysisCache.get(analysisCacheKey) : null;
        const cacheableDirs = ['auto', 'en_es', 'ko_es', 'ko_en', 'ja_es', 'ja_en', 'en_ja'];
        const exactMemHit = (!ramHit && !forceRefresh && !question && mode === 'auto' && text.length <= 160 && cacheableDirs.includes(direction))
            ? currentMemory.terms.find((t) =>
                t.term.toLowerCase() === text.toLowerCase()
                && t.meaning
                && !isPoisonedMemoryMeaning(t.meaning)
            )
            : null;
        let notebookMatch = null;
        if (!ramHit && !exactMemHit && !forceRefresh && !question && mode !== 'offline') {
            const notebookData = await getStudyNotebookDataForUser({ fastLocalOnly: true });
            if (notebookData && notebookData.ok) {
                notebookMatch = findNotebookTranslationMatch(notebookData, {
                    text,
                    songTitle,
                    artistName,
                    mode: (text.includes('\n') || songTitle) ? 'lyrics' : 'text'
                });
            }
        }

        let result;
        if (ramHit) {
            result = { ok: true, ...ramHit, usedGemini: false, cached: true, cacheHit: true, rememberable: false };
        } else if (notebookMatch && notebookMatch.hit) {
            const baseOffline = analyzeTextOffline({
                text,
                question,
                language,
                songTitle: songTitle || notebookMatch.entry?.title || '',
                artistName: artistName || notebookMatch.entry?.artist || '',
                learningMemory: currentMemory,
                repertoire,
                uiLang
            });
            if (notebookMatch.kind === 'music-lyrics') {
                const esLines = String(notebookMatch.spanishLyrics || '').split(/\r?\n/).filter(Boolean);
                const enrichedLines = Array.isArray(baseOffline.lines)
                    ? baseOffline.lines.map((lineObj, idx) => ({
                        ...lineObj,
                        translation: esLines[idx] || lineObj.translation || ''
                    }))
                    : baseOffline.lines;
                result = {
                    ...baseOffline,
                    ok: true,
                    lines: enrichedLines,
                    usedGemini: false,
                    cachedFromWord: true,
                    cacheHit: true,
                    provider: 'word-notebook-cache',
                    rememberable: false,
                    translatedText: notebookMatch.spanishLyrics,
                    spanishMeaning: notebookMatch.spanishLyrics,
                    summary: uiLang === 'en'
                        ? `Retrieved instantaneously from your local Word notebook (${notebookMatch.entry?.title || songTitle}, 0 AI tokens).`
                        : `Recuperado al instante desde tu cuaderno Word (${notebookMatch.entry?.title || songTitle}, 0 tokens de IA).`,
                    culturalAndGrammarNotes: [
                        uiLang === 'en'
                            ? '⚡ Word Cache Hit: Existing song translation loaded without calling Gemini.'
                            : '⚡ Caché del Cuaderno Word: Traducción cargada sin consumir tokens de Gemini.',
                        ...(Array.isArray(baseOffline.culturalAndGrammarNotes) ? baseOffline.culturalAndGrammarNotes : [])
                    ]
                };
            } else {
                const cachedMeaning = notebookMatch.translatedText;
                const cachedRom = notebookMatch.romanization || baseOffline.wordNoteDraft?.romanization || '';
                result = {
                    ...baseOffline,
                    ok: true,
                    usedGemini: false,
                    cachedFromWord: true,
                    cacheHit: true,
                    provider: 'word-notebook-cache',
                    rememberable: false,
                    direction,
                    sourceText: text,
                    translatedText: cachedMeaning,
                    spanishMeaning: cachedMeaning,
                    romanization: cachedRom,
                    detectedScript: detectScriptKind(text),
                    summary: notebookMatch.summary || `${text} -> ${cachedMeaning}`,
                    vocabulary: [
                        {
                            term: text,
                            meaning: cachedMeaning,
                            romanization: cachedRom,
                            category: notebookMatch.section || 'vocabulary',
                            notes: notebookMatch.explanation || ''
                        },
                        ...(Array.isArray(baseOffline.vocabulary) ? baseOffline.vocabulary.filter((v) => String(v.term || '').toLowerCase() !== text.toLowerCase()) : [])
                    ],
                    culturalAndGrammarNotes: [
                        uiLang === 'en'
                            ? `⚡ Word Cache Hit (${notebookMatch.section || 'notebook'}): 0 AI tokens used.`
                            : `⚡ Caché del Cuaderno Word (${notebookMatch.section || 'cuaderno'}): 0 tokens de IA consumidos.`,
                        ...(notebookMatch.explanation ? [notebookMatch.explanation] : []),
                        ...(Array.isArray(baseOffline.culturalAndGrammarNotes) ? baseOffline.culturalAndGrammarNotes : [])
                    ],
                    wordNoteDraft: {
                        ...(baseOffline.wordNoteDraft || {}),
                        word: text,
                        romanization: cachedRom,
                        meaning: cachedMeaning,
                        example: notebookMatch.example || baseOffline.wordNoteDraft?.example || '',
                        notes: notebookMatch.explanation || baseOffline.wordNoteDraft?.notes || ''
                    }
                };
            }
        } else if (exactMemHit) {
            const baseOffline = analyzeTextOffline({
                text,
                question,
                language,
                songTitle,
                artistName,
                learningMemory: currentMemory,
                repertoire,
                uiLang
            });
            result = {
                ...baseOffline,
                ok: true,
                usedGemini: false,
                cachedFromMemory: true,
                cacheHit: true,
                provider: 'memory-cache',
                direction,
                sourceText: text,
                translatedText: exactMemHit.meaning,
                spanishMeaning: exactMemHit.meaning,
                romanization: exactMemHit.romanization || baseOffline.wordNoteDraft?.romanization || '',
                detectedScript: detectScriptKind(text),
                rememberable: false,
                summary: `${text} -> ${exactMemHit.meaning}`,
                explanation: uiLang === 'en'
                    ? 'Retrieved instantaneously from your saved study memory (0 AI tokens).'
                    : 'Recuperado al instante desde tu memoria de estudio guardada (0 tokens de IA).',
                wordNoteDraft: {
                    ...(baseOffline.wordNoteDraft || {}),
                    word: text,
                    romanization: exactMemHit.romanization || baseOffline.wordNoteDraft?.romanization || '',
                    meaning: exactMemHit.meaning
                }
            };
        } else if (mode === 'offline' || (mode === 'auto' && !effectiveKey)) {
            result = analyzeTextOffline({
                text,
                question,
                language,
                songTitle,
                artistName,
                learningMemory: currentMemory,
                repertoire,
                uiLang
            });
        } else {
            result = await analyzeWithGemini({
                apiKey: effectiveKey,
                model,
                text,
                question,
                language,
                songTitle,
                artistName,
                learningMemory: currentMemory,
                repertoire,
                uiLang
            });
            if (result && result.ok !== false && result.usedGemini !== false) {
                languageAnalysisCache.set(analysisCacheKey, result);
            }
        }

        // Persist newly learned terms, grammar notes, and studied songs into user's AI memory bank
        if (req.body.remember !== false && result.rememberable !== false) {
            const matchedFirst = Array.isArray(result.matchedRepertoireSongs) && result.matchedRepertoireSongs[0];
            const termsToRemember = [
                ...(Array.isArray(result.vocabulary) ? result.vocabulary.slice(0, 8) : []),
                ...(result.wordNoteDraft && result.wordNoteDraft.word
                    ? [{
                        term: result.wordNoteDraft.word,
                        meaning: result.wordNoteDraft.meaning,
                        category: 'vocabulary',
                        language: result.language || language
                    }]
                    : [])
            ].filter((t) => t && t.meaning && !isPoisonedMemoryMeaning(t.meaning));

            settings.languageMemory = mergeLanguageMemory(currentMemory, {
                terms: termsToRemember,
                grammarNotes: Array.isArray(result.culturalAndGrammarNotes)
                    ? result.culturalAndGrammarNotes.filter((n) => !String(n).startsWith('🧠 Memory Recall:') && !String(n).startsWith('🎵 Repertoire Match:')).slice(0, 3)
                    : [],
                songTitle: songTitle || (matchedFirst ? matchedFirst.titulo : ''),
                artistName: artistName || (matchedFirst && matchedFirst.artistas ? matchedFirst.artistas.join(', ') : ''),
                language: result.language || language
            });
            await saveUserSettings(req.user.id, settings);
        }

        const modelInfo = await getAvailableGeminiModelsForUser({ apiKey: effectiveKey });
        const onlyAvailableModels = (modelInfo.models || []).filter((m) => m.available !== false);

        res.json({
            ...result,
            languageMemory: settings.languageMemory,
            memoryTotalTerms: settings.languageMemory.terms.length,
            availableModels: onlyAvailableModels,
            geminiKeyConfigured: Boolean(effectiveKey)
        });
    } catch (err) {
        console.error('[LANGUAGE_ANALYZE_ERROR]', err);
        res.status(500).send('Error running language & lyrics analysis.');
    }
});

app.post('/api/language/test-gemini', apiWriteLimiter.middleware, requireAdmin, async (req, res) => {
    try {
        const settings = await loadUserSettings(req.user.id);
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const typedKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
        const effectiveKey = typedKey || settings.geminiApiKey || process.env.GEMINI_API_KEY || '';
        const model = validateGeminiModelId(body.model || settings.geminiModel || 'gemini-2.5-flash');
        const [diag, activeRegistry] = await Promise.all([
            testGeminiConnection({ apiKey: effectiveKey, model }),
            getAvailableGeminiModelsForUser({ apiKey: effectiveKey, forceRefresh: true })
        ]);
        const activeModels = (activeRegistry.models || []).filter((m) => m.available !== false);
        res.json({
            ...diag,
            activeModels,
            fastModel: activeRegistry.fastModel || null,
            reasoningModel: activeRegistry.reasoningModel || null,
            keySource: typedKey
                ? 'typed-input'
                : (settings.geminiApiKey ? 'saved-settings' : (process.env.GEMINI_API_KEY ? 'server-env' : 'none'))
        });
    } catch (err) {
        console.error('[LANGUAGE_TEST_GEMINI_ERROR]', err);
        res.status(500).send('Error testing Gemini connection.');
    }
});

app.post('/api/language/translate', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, async (req, res) => {
    try {
        const text = String(req.body.text || req.body.word || '').trim();
        if (!text) {
            return res.status(400).send('Enter a word, phrase, or lyric line to translate.');
        }
        if (text.length > 4000) {
            return res.status(400).send('Translation text cannot exceed 4,000 characters.');
        }

        const direction = normalizeTranslationDirection(req.body.direction || 'auto');
        const mode = ['auto', 'gemini', 'offline'].includes(String(req.body.mode || 'auto').toLowerCase())
            ? String(req.body.mode || 'auto').toLowerCase()
            : 'auto';
        const context = String(req.body.context || '').trim().slice(0, 400);

        const settings = await loadUserSettings(req.user.id);
        const currentMemory = sanitizeLanguageMemory(settings.languageMemory);
        const model = validateGeminiModelId(req.body.model || settings.geminiModel || 'gemini-2.5-flash');
        const inlineKey = typeof req.body.apiKey === 'string' ? req.body.apiKey.trim() : '';
        const effectiveKey = inlineKey || settings.geminiApiKey || process.env.GEMINI_API_KEY || '';

        const uiLang = req.headers['x-ui-lang'] || req.body?.uiLang || 'es';
        const forceRefresh = req.body.forceRefresh === true;
        const transCacheKey = crypto
            .createHash('sha256')
            .update(`${req.user.id}|${direction}|${uiLang}|${context.toLowerCase()}|${text.toLowerCase().replace(/\s+/g, ' ').trim()}`)
            .digest('hex');

        const cachedTrans = (!forceRefresh && mode !== 'offline') ? languageTranslationCache.get(transCacheKey) : null;
        const cacheableTransDirs = ['auto', 'en_es', 'ko_es', 'ko_en', 'ja_es', 'ja_en', 'en_ja'];
        const exactMemHit = (!cachedTrans && !forceRefresh && mode === 'auto' && text.length <= 160 && cacheableTransDirs.includes(direction))
            ? currentMemory.terms.find((t) =>
                t.term.toLowerCase() === text.toLowerCase()
                && t.meaning
                && !isPoisonedMemoryMeaning(t.meaning)
            )
            : null;
        let notebookMatch = null;
        if (!cachedTrans && !exactMemHit && !forceRefresh && mode !== 'offline' && cacheableTransDirs.includes(direction)) {
            const notebookData = await getStudyNotebookDataForUser({ fastLocalOnly: true });
            if (notebookData && notebookData.ok) {
                notebookMatch = findNotebookTranslationMatch(notebookData, { text, mode: 'text' });
            }
        }

        let result;
        if (cachedTrans) {
            result = {
                ...cachedTrans,
                usedGemini: false,
                cached: true,
                cacheHit: true,
                rememberable: false
            };
        } else if (notebookMatch && notebookMatch.hit) {
            const translatedVal = notebookMatch.translatedText || notebookMatch.spanishLyrics || '';
            result = {
                ok: true,
                usedGemini: false,
                cachedFromWord: true,
                cacheHit: true,
                provider: 'word-notebook-cache',
                direction,
                sourceText: text,
                translatedText: translatedVal,
                spanishMeaning: translatedVal,
                romanization: notebookMatch.romanization || '',
                detectedScript: detectScriptKind(text),
                rememberable: false,
                explanation: notebookMatch.explanation
                    || (uiLang === 'en'
                        ? 'Retrieved instantaneously from your local Word notebook (0 AI tokens).'
                        : 'Recuperado al instante desde tu cuaderno Word local (0 tokens de IA).')
            };
        } else if (exactMemHit) {
            result = {
                ok: true,
                usedGemini: false,
                cachedFromMemory: true,
                cacheHit: true,
                provider: 'memory-cache',
                direction,
                sourceText: text,
                translatedText: exactMemHit.meaning,
                spanishMeaning: exactMemHit.meaning,
                romanization: exactMemHit.romanization || '',
                detectedScript: detectScriptKind(text),
                rememberable: false,
                explanation: uiLang === 'en'
                    ? 'Retrieved instantaneously from your saved study memory (0 AI tokens).'
                    : 'Recuperado al instante desde tu memoria de estudio guardada (0 tokens de IA).'
            };
        } else if (mode === 'offline' || (mode === 'auto' && !effectiveKey)) {
            result = translateOffline({
                text,
                direction,
                learningMemory: currentMemory,
                uiLang
            });
        } else {
            result = await translateWithGemini({
                apiKey: effectiveKey,
                model,
                text,
                direction,
                context,
                learningMemory: currentMemory,
                uiLang
            });
            if (result && result.ok !== false && result.translatedText && result.usedGemini !== false) {
                languageTranslationCache.set(transCacheKey, result);
            }
        }

        const candidateMemoryMeaning = result.spanishMeaning || result.translatedText;
        const canRemember = req.body.remember !== false
            && result.rememberable === true
            && text.length <= 160
            && Boolean(result.translatedText)
            && !isPoisonedMemoryMeaning(candidateMemoryMeaning);

        if (canRemember) {
            const detScript = String(result.detectedScript || '');
            let langCode = 'en';
            if (['ja_es', 'ja_en', 'es_ja'].includes(result.direction) || detScript === 'japanese') {
                langCode = 'ja';
            } else if (result.direction === 'en_ja' || detScript === 'mixed-jpop') {
                langCode = 'en_ja';
            } else if (result.direction === 'ko_en' || result.direction === 'ko_es' || /hangul|korean/i.test(detScript)) {
                langCode = 'ko';
            }
            settings.languageMemory = mergeLanguageMemory(currentMemory, {
                terms: [{
                    term: text.slice(0, 120),
                    meaning: String(candidateMemoryMeaning).slice(0, 240),
                    romanization: result.romanization || '',
                    category: 'vocabulary',
                    language: langCode
                }],
                grammarNotes: [],
                songTitle: '',
                artistName: '',
                language: langCode
            });
            await saveUserSettings(req.user.id, settings);
        } else if (JSON.stringify(currentMemory) !== JSON.stringify(settings.languageMemory)) {
            settings.languageMemory = currentMemory;
            await saveUserSettings(req.user.id, settings);
        }

        res.json({
            ...result,
            languageMemory: settings.languageMemory,
            memoryTotalTerms: settings.languageMemory.terms.length,
            availableModels: RECOMMENDED_GEMINI_MODELS,
            geminiKeyConfigured: Boolean(effectiveKey)
        });
    } catch (err) {
        console.error('[LANGUAGE_TRANSLATE_ERROR]', err);
        res.status(500).send('Error running translator.');
    }
});

app.post('/api/english/music/translate-lyrics', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, async (req, res) => {
    try {
        const nativeTracksEs = String(req.body.tracks?.es || '').trim().slice(0, 24000);
        const lyrics = String(req.body.lyrics || req.body.text || req.body.tracks?.original || nativeTracksEs || '').trim();
        if (!lyrics) {
            return res.status(400).send('Provide song lyrics to translate to Spanish.');
        }
        if (lyrics.length > 24000) {
            return res.status(400).send('Lyrics cannot exceed 24,000 characters.');
        }

        const modeRaw = String(req.body.mode || 'auto').toLowerCase();
        const mode = ['auto', 'gemini', 'offline'].includes(modeRaw) ? modeRaw : 'auto';
        const forceRefresh = req.body.forceRefresh === true;
        const songTitle = String(req.body.songTitle || req.body.titulo || '').trim().slice(0, 160);
        const artistName = String(req.body.artistName || req.body.artista || '').trim().slice(0, 160);
        const language = String(req.body.language || req.body.idioma || '').trim().slice(0, 60);

        const settings = await loadUserSettings(req.user.id);
        const currentMemory = sanitizeLanguageMemory(settings.languageMemory);
        const model = validateGeminiModelId(req.body.model || settings.geminiModel || 'gemini-2.5-flash');
        const inlineKey = typeof req.body.apiKey === 'string' ? req.body.apiKey.trim() : '';
        const effectiveKey = inlineKey || settings.geminiApiKey || process.env.GEMINI_API_KEY || '';
        const uiLang = req.headers['x-ui-lang'] || req.body?.uiLang || 'es';

        const baseLyrics = stripAiSpanishLyricsSection(lyrics).trim() || lyrics;
        const cacheKey = crypto
            .createHash('sha256')
            .update(`${req.user.id}|${songTitle.toLowerCase()}|${artistName.toLowerCase()}|${baseLyrics.replace(/\s+/g, ' ').trim()}`)
            .digest('hex');

        const embeddedEs = (!forceRefresh && mode !== 'offline') ? extractSpanishBlockFromLyrics(lyrics) : '';
        const ytEsLyrics = (!forceRefresh && mode !== 'offline') ? (nativeTracksEs || (/(?:^|\n)(?:\[ES(?:-[^\]]+)?\]|Spanish)\s*\n/i.test(lyrics) ? embeddedEs : '')) : '';
        let result = (!ytEsLyrics && !embeddedEs && !forceRefresh && mode !== 'offline') ? lyricsTranslationCache.get(cacheKey) : null;
        if (ytEsLyrics) {
            result = {
                ok: true,
                usedGemini: false,
                cached: true,
                cacheHit: true,
                source: 'yt-captions',
                provider: 'yt-captions',
                tokensUsed: 0,
                songTitle,
                artistName,
                language: language || 'yt-captions',
                spanishLyrics: ytEsLyrics,
                summary: uiLang === 'en'
                    ? 'Official Spanish captions loaded directly from YouTube (0 AI tokens).'
                    : 'Subtítulos oficiales en español cargados directamente desde YouTube (0 tokens de IA).'
            };
        } else if (embeddedEs) {
            result = {
                ok: true,
                usedGemini: false,
                cached: true,
                cacheHit: true,
                source: 'embedded-lyrics-cache',
                provider: 'embedded-lyrics-cache',
                tokensUsed: 0,
                songTitle,
                artistName,
                language: language || 'Word Cache',
                spanishLyrics: embeddedEs,
                summary: uiLang === 'en'
                    ? 'Spanish lyrics extracted directly from existing notebook content (0 AI tokens).'
                    : 'Traducción al español extraída del registro existente sin consumir Gemini.'
            };
        } else if (result) {
            result = { ...result, usedGemini: false, cached: true, cacheHit: true, tokensUsed: 0 };
        } else {
            let nbMatch = null;
            if (!forceRefresh && mode !== 'offline') {
                const notebookData = await getStudyNotebookDataForUser({ fastLocalOnly: true });
                if (notebookData && notebookData.ok) {
                    nbMatch = findNotebookTranslationMatch(notebookData, {
                        text: baseLyrics,
                        songTitle,
                        artistName,
                        mode: 'lyrics'
                    });
                }
            }
            if (nbMatch && nbMatch.spanishLyrics) {
                result = {
                    ok: true,
                    usedGemini: false,
                    cachedFromWord: true,
                    cacheHit: true,
                    source: 'word-notebook-cache',
                    provider: 'word-notebook-cache',
                    tokensUsed: 0,
                    songTitle: nbMatch.entry?.title || songTitle,
                    artistName: nbMatch.entry?.artist || artistName,
                    language: language || 'Word Cache',
                    spanishLyrics: nbMatch.spanishLyrics,
                    summary: uiLang === 'en'
                        ? 'Spanish lyrics retrieved from your local Word notebook without using Gemini.'
                        : 'Traducción al español recuperada directamente del cuaderno Word (0 tokens de Gemini).'
                };
                lyricsTranslationCache.set(cacheKey, result);
            } else {
                let ytEsCaptionText = '';
                if (!forceRefresh && mode === 'auto') {
                    try {
                        let capVideoId = ytdlpService.extractValidYouTubeVideoId(req.body.videoId)
                            || ytdlpService.extractValidYouTubeVideoId(req.body.ytMusicUrl)
                            || '';
                        let capUrl = String(req.body.ytMusicUrl || '').trim();
                        const reqSongId = parsePositiveInt(req.body.songId);
                        if (!capVideoId && reqSongId) {
                            const dbSong = await fetchOwnedMusicSongForMediaOrLyrics(reqSongId, req.user.id).catch(() => null);
                            if (dbSong) {
                                capVideoId = ytdlpService.extractValidYouTubeVideoId(dbSong.yt_video_id)
                                    || ytdlpService.extractValidYouTubeVideoId(dbSong.yt_music_url)
                                    || '';
                                if (!capUrl) capUrl = String(dbSong.yt_music_url || '').trim();
                            }
                        }
                        if (capVideoId) {
                            const capTry = await ytdlpService.extractSongLyrics({
                                videoId: capVideoId,
                                url: capUrl,
                                preferredLangs: ['es', 'en', 'ko', 'ja'],
                                useInnerTube: false,
                                budgetMs: 12000
                            });
                            if (capTry?.ok && capTry.tracks?.es) {
                                ytEsCaptionText = String(capTry.tracks.es).trim();
                            }
                        }
                    } catch (_) {}
                }

                if (ytEsCaptionText) {
                    result = {
                        ok: true,
                        usedGemini: false,
                        cached: true,
                        cacheHit: true,
                        source: 'yt-captions',
                        provider: 'yt-captions',
                        tokensUsed: 0,
                        songTitle,
                        artistName,
                        language: language || 'yt-captions',
                        spanishLyrics: ytEsCaptionText,
                        summary: uiLang === 'en'
                            ? 'Official Spanish captions loaded directly from YouTube (0 AI tokens).'
                            : 'Subtítulos oficiales en español cargados directamente desde YouTube (0 tokens de IA).'
                    };
                    lyricsTranslationCache.set(cacheKey, result);
                } else if (mode === 'offline' || (mode === 'auto' && !effectiveKey)) {
                    result = translateLyricsToSpanishOffline({
                        lyrics: baseLyrics,
                        songTitle,
                        artistName,
                        learningMemory: currentMemory,
                        uiLang
                    });
                } else {
                    result = await translateLyricsToSpanishWithGemini({
                        apiKey: effectiveKey,
                        model,
                        lyrics: baseLyrics,
                        songTitle,
                        artistName,
                        language,
                        learningMemory: currentMemory,
                        uiLang
                    });
                    if (result && result.ok !== false && result.spanishLyrics) {
                        lyricsTranslationCache.set(cacheKey, result);
                    }
                }
            }
        }

        if (!result || result.ok === false) {
            return res.status(400).send(result?.error || 'Could not translate lyrics.');
        }

        const liveRegistry = await getAvailableGeminiModelsForUser({ apiKey: effectiveKey });
        res.json({
            ...result,
            availableModels: (liveRegistry.models || []).filter((m) => m.available !== false),
            geminiKeyConfigured: Boolean(effectiveKey)
        });
    } catch (err) {
        console.error('[MUSIC_LYRICS_TRANSLATE_ERROR]', err);
        res.status(500).send('Error translating song lyrics.');
    }
});

async function ensureDefaultStudyLessonsForUser(uid) {
    const existing = await dbQueryAsync(
        'SELECT id, codigo_leccion, idioma, nombre_practica, orden_secuencia, completada, word_leido_en, completada_en FROM EstudioLecciones WHERE usuario_id = ? ORDER BY orden_secuencia ASC',
        [uid]
    );
    if (existing.length > 0) return existing;

    for (const item of DEFAULT_CURRICULUM_LESSONS) {
        await dbQueryAsync(
            `INSERT IGNORE INTO EstudioLecciones (usuario_id, idioma, codigo_leccion, nombre_practica, orden_secuencia, completada)
             VALUES (?, ?, ?, ?, ?, 0)`,
            [uid, item.idioma, item.codigo, item.nombre, item.orden]
        );
    }
    return dbQueryAsync(
        'SELECT id, codigo_leccion, idioma, nombre_practica, orden_secuencia, completada, word_leido_en, completada_en FROM EstudioLecciones WHERE usuario_id = ? ORDER BY orden_secuencia ASC',
        [uid]
    );
}

app.get('/api/language/lessons', apiReadLimiter.middleware, requireAdmin, async (req, res) => {
    try {
        const uid = req.user.id;
        const [lessons, settings] = await Promise.all([
            ensureDefaultStudyLessonsForUser(uid),
            loadUserSettings(uid)
        ]);

        let activeLessonFound = false;
        const enriched = lessons.map((l) => {
            const isCompleted = Boolean(l.completada);
            const hasReadWord = Boolean(l.word_leido_en);
            let locked = false;
            if (!isCompleted) {
                if (!activeLessonFound) {
                    activeLessonFound = true;
                } else {
                    locked = true;
                }
            }
            return {
                id: l.id,
                codigo: l.codigo_leccion,
                idioma: l.idioma,
                nombre: l.nombre_practica,
                lesson_name: l.nombre_practica,
                orden: l.orden_secuencia,
                completada: isCompleted,
                completed: isCompleted,
                wordLeido: hasReadWord,
                locked
            };
        });

        const currentLesson = enriched.find((l) => !l.completada) || enriched[enriched.length - 1] || null;
        const learningActive = Boolean(settings.languageLearningActive ?? settings.englishReminderEnabled);
        res.json({
            studyEnabled: learningActive,
            languageLearningActive: learningActive,
            recommendedMinutes: 15,
            pcOnline: isPcBridgeOnline(),
            currentLesson,
            needsPracticeAlert: Boolean(currentLesson && !currentLesson.wordLeido),
            lessons: enriched
        });
    } catch (err) {
        console.error('[LANGUAGE_LESSONS_GET_ERROR]', err);
        res.status(500).send('Error loading study lessons.');
    }
});

app.patch('/api/language/learning-toggle', apiWriteLimiter.middleware, requireAdmin, async (req, res) => {
    try {
        const uid = req.user.id;
        const current = await loadUserSettings(uid);
        const currentActive = Boolean(current.languageLearningActive ?? current.englishReminderEnabled);
        const nextActive = typeof req.body?.active === 'boolean' ? req.body.active : !currentActive;
        const rawTopic = String(req.body?.topic || current.englishReminderTopic || 'Dedica 10 a 15 minutos a tu lección activa').trim();
        const safeTopic = rawTopic.slice(0, 180) || 'Dedica 10 a 15 minutos a tu lección activa';

        const nextSettings = {
            ...current,
            englishReminderEnabled: nextActive,
            languageLearningActive: nextActive,
            englishReminderTopic: safeTopic
        };
        await saveUserSettings(uid, nextSettings);

        bumpSyncRevision('settings');
        res.json({
            ok: true,
            studyEnabled: nextActive,
            languageLearningActive: nextActive,
            recommendedMinutes: 15,
            topic: safeTopic,
            settings: sanitizeSettingsForClient(nextSettings)
        });
    } catch (err) {
        console.error('[LANGUAGE_TOGGLE_ERROR]', err);
        res.status(500).send('Error toggling language learning state.');
    }
});

app.post('/api/language/word-activity', apiWriteLimiter.middleware, requireAdmin, async (req, res) => {
    try {
        const uid = req.user.id;
        const nowSql = formatMySqlDateTime(new Date());
        const requestedId = parsePositiveInt(req.body?.lessonId);
        const lessons = await ensureDefaultStudyLessonsForUser(uid);
        const targetLesson = requestedId
            ? lessons.find((l) => Number(l.id) === Number(requestedId))
            : (lessons.find((l) => !l.completada) || lessons[lessons.length - 1] || null);

        if (targetLesson) {
            await dbQueryAsync(
                'UPDATE EstudioLecciones SET word_leido_en = COALESCE(word_leido_en, ?) WHERE id = ? AND usuario_id = ?',
                [nowSql, targetLesson.id, uid]
            );
        }

        const current = await loadUserSettings(uid);
        await saveUserSettings(uid, {
            ...current,
            lastWordActivityAt: new Date().toISOString(),
            lastWordAction: String(req.body?.action || 'word_activity').trim().slice(0, 64)
        });

        res.json({
            ok: true,
            recordedAt: nowSql,
            lessonId: targetLesson ? targetLesson.id : null
        });
    } catch (err) {
        console.error('[WORD_ACTIVITY_ERROR]', err);
        res.status(500).send('Error recording Word study activity.');
    }
});

app.post('/api/language/lessons/:id/generate-practice', apiWriteLimiter.middleware, requireAdmin, async (req, res) => {
    const lessonId = parsePositiveInt(req.params.id);
    if (!lessonId) return res.status(400).send('Invalid lesson ID.');

    try {
        const uid = req.user.id;
        const lessons = await ensureDefaultStudyLessonsForUser(uid);
        const targetIdx = lessons.findIndex((l) => Number(l.id) === Number(lessonId));
        if (targetIdx === -1) return res.status(404).send('Lesson not found.');

        const prevIncomplete = lessons.slice(0, targetIdx).find((l) => !l.completada);
        if (prevIncomplete) {
            return res.status(409).json({
                locked: true,
                message: `Debes completar primero la lección previa: "${prevIncomplete.nombre_practica}".`
            });
        }

        const lesson = lessons[targetIdx];
        const settings = await loadUserSettings(uid);
        const effectiveKey = String(settings.geminiApiKey || process.env.GEMINI_API_KEY || '').trim();
        const generated = await generatePracticalLessonForWord({
            apiKey: effectiveKey,
            model: settings.geminiModel || 'gemini-2.5-flash',
            lessonCode: lesson.codigo_leccion,
            lessonName: lesson.nombre_practica,
            language: lesson.idioma,
            learningMemory: settings.languageMemory
        });

        await dbQueryAsync(
            'UPDATE EstudioLecciones SET word_leido_en = COALESCE(word_leido_en, ?) WHERE id = ? AND usuario_id = ?',
            [formatMySqlDateTime(new Date()), lesson.id, uid]
        );

        res.json({
            ok: true,
            lessonId: lesson.id,
            pcOnline: isPcBridgeOnline(),
            practice: generated
        });
    } catch (err) {
        console.error('[LANGUAGE_LESSON_GENERATE_ERROR]', err);
        res.status(500).send('Error generating practical lesson.');
    }
});

app.patch('/api/language/lessons/:id/complete', apiWriteLimiter.middleware, requireAdmin, async (req, res) => {
    const lessonId = parsePositiveInt(req.params.id);
    if (!lessonId) return res.status(400).send('Invalid lesson ID.');

    try {
        const uid = req.user.id;
        const lessons = await ensureDefaultStudyLessonsForUser(uid);
        const targetIdx = lessons.findIndex((l) => Number(l.id) === Number(lessonId));
        if (targetIdx === -1) return res.status(404).send('Lesson not found.');

        const lesson = lessons[targetIdx];
        const prevIncomplete = lessons.slice(0, targetIdx).find((l) => !l.completada);
        if (prevIncomplete) {
            return res.status(409).send(`No puedes avanzar sin terminar antes: "${prevIncomplete.nombre_practica}".`);
        }
        if (!lesson.word_leido_en && req.body?.wordReadConfirmed !== true) {
            return res.status(409).send('Aún no has abierto ni practicado el contenido de esta lección en tu documento Word (mínimo 10-15 min).');
        }

        const nowSql = formatMySqlDateTime(new Date());
        await dbQueryAsync(
            'UPDATE EstudioLecciones SET completada = 1, word_leido_en = COALESCE(word_leido_en, ?), completada_en = ? WHERE id = ? AND usuario_id = ?',
            [nowSql, nowSql, lesson.id, uid]
        );
        bumpSyncRevision('music');

        bumpSyncRevision('music');
        res.json({ ok: true, id: lesson.id, completed: true });
    } catch (err) {
        console.error('[LANGUAGE_LESSON_COMPLETE_ERROR]', err);
        res.status(500).send('Error updating lesson completion.');
    }
});

app.post('/api/language/pronunciation', apiWriteLimiter.middleware, requireAdmin, requireNonEmptyBody, async (req, res) => {
    try {
        const targetText = String(req.body.targetText || '').trim();
        const spokenText = String(req.body.spokenText || '').trim();
        if (!targetText || !spokenText) {
            return res.status(400).send('Provide both target phrase and microphone spoken transcript.');
        }
        const settings = await loadUserSettings(req.user.id);
        const effectiveKey = String(settings.geminiApiKey || process.env.GEMINI_API_KEY || '').trim();
        const evaluation = await evaluatePronunciation({
            apiKey: effectiveKey,
            model: settings.geminiModel || 'gemini-2.5-flash',
            targetText,
            spokenText,
            language: req.body.language || settings.preferredStudyLanguage || 'en'
        });
        res.json(evaluation);
    } catch (err) {
        console.error('[PRONUNCIATION_EVAL_ERROR]', err);
        res.status(500).send('Error evaluating pronunciation.');
    }
});

function loadVersionMetadata() {
    const rawEnvVersion = String(process.env.APP_VERSION || '').trim().replace(/^v/i, '');
    const envVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(rawEnvVersion) ? rawEnvVersion : '';

    let pkgVersion = '1.0.0';
    try {
        const pkgPath = path.join(__dirname, 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (pkg && typeof pkg.version === 'string' && pkg.version.trim()) {
                pkgVersion = pkg.version.trim();
            }
        }
    } catch (_) {
        pkgVersion = '1.0.0';
    }
    const fallbackVersion = envVersion || pkgVersion || '1.0.0';

    let historyData = null;
    try {
        const historyPath = path.join(__dirname, 'version-history.json');
        if (fs.existsSync(historyPath)) {
            historyData = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
        }
    } catch (_) {
        historyData = null;
    }

    const releases = Array.isArray(historyData?.releases)
        ? historyData.releases
        : [{
            version: fallbackVersion,
            tag: `v${fallbackVersion}`,
            bumpType: 'initial',
            previousVersion: '0.0.0',
            releasedAt: null,
            commitSha: 'baseline',
            trigger: 'baseline',
            summary: 'Current application release',
            counts: { breaking: 0, features: 0, fixes: 0, maintenance: 0 },
            changes: { breaking: [], features: [], fixes: [], maintenance: [] }
        }];

    const latest = releases[0] || null;
    const currentVersion = (historyData && typeof historyData.currentVersion === 'string' && historyData.currentVersion.trim())
        ? historyData.currentVersion.trim()
        : (latest?.version || fallbackVersion);

    return {
        currentVersion,
        tag: latest?.tag || `v${currentVersion}`,
        bumpType: latest?.bumpType || 'initial',
        releasedAt: latest?.releasedAt || historyData?.updatedAt || null,
        commitSha: latest?.commitSha || '',
        summary: latest?.summary || '',
        standard: (historyData && historyData.standard) || 'SemVer 2.0.0 + Conventional Commits',
        totalReleases: releases.length,
        history: releases
    };
}

app.get('/api/version', apiReadLimiter.middleware, requireAuth, (req, res) => {
    try {
        return res.json(loadVersionMetadata());
    } catch (err) {
        console.error('[VERSION_ENDPOINT_ERROR]', err);
        return res.status(500).send('Failed to load version history.');
    }
});

app.get('/api/system/logs', apiReadLimiter.middleware, requireAdmin, (req, res) => {
    const kind = String(req.query.kind || 'server').trim().toLowerCase();
    const lines = Number.parseInt(String(req.query.lines || '120'), 10) || 120;
    return res.json({
        replicaId: REPLICA_ID,
        ...serverLogger.getRecentLogTail({ kind, lines })
    });
});

// =========================================================================
// SINCRONIZACIÓN EN TIEMPO REAL ENTRE SESIONES Y RÉPLICAS (SSE + SyncRevisions)
// =========================================================================
const SYNC_SCOPES = ['mood', 'sleep', 'crisis', 'agenda', 'planner', 'settings', 'music', 'journal'];
const CLINICAL_SYNC_SCOPES = ['mood', 'sleep', 'crisis'];
const SYNC_CACHE_TTL_MS = 1500;
const SYNC_POLL_INTERVAL_MS = 3000;
const SYNC_HEARTBEAT_INTERVAL_MS = 25000;
const MAX_SSE_CLIENTS_PER_USER = 5;

const syncBus = new EventEmitter();
syncBus.setMaxListeners(100);

const syncRevisionsSnapshot = {
    mood: 1,
    sleep: 1,
    crisis: 1,
    agenda: 1,
    planner: 1,
    settings: 1,
    music: 1,
    journal: 1
};
let syncRevisionsCacheAt = 0;

const sseClients = new Set();
const sseClientsByUser = new Map();
let syncPollerTimer = null;
let syncHeartbeatTimer = null;
let syncPollerInFlight = false;

const syncReadLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 180,
    message: 'Too many sync requests. Please slow down briefly.'
});

function filterRevisionsForRole(revisions, role) {
    if (role !== 'psiquiatra') {
        return { ...revisions };
    }
    const filtered = {};
    for (const s of CLINICAL_SYNC_SCOPES) {
        filtered[s] = Number(revisions[s]) || 1;
    }
    return filtered;
}

async function fetchSyncRevisions({ force = false } = {}) {
    const now = Date.now();
    if (!force && syncRevisionsCacheAt > 0 && (now - syncRevisionsCacheAt) < SYNC_CACHE_TTL_MS) {
        return { ...syncRevisionsSnapshot };
    }
    try {
        const rows = await dbQueryAsync('SELECT scope, revision FROM SyncRevisions');
        if (Array.isArray(rows)) {
            for (const row of rows) {
                const scope = String(row?.scope || '').trim();
                if (!SYNC_SCOPES.includes(scope)) continue;
                const rev = Number(row.revision);
                if (Number.isFinite(rev) && rev > syncRevisionsSnapshot[scope]) {
                    syncRevisionsSnapshot[scope] = rev;
                }
            }
        }
        syncRevisionsCacheAt = Date.now();
    } catch (_) {
        // Keep last snapshot in RAM if DB temporarily unavailable
    }
    return { ...syncRevisionsSnapshot };
}

function bumpSyncRevision(scope) {
    if (!SYNC_SCOPES.includes(scope)) return;
    syncRevisionsSnapshot[scope] = (Number(syncRevisionsSnapshot[scope]) || 1) + 1;
    syncRevisionsCacheAt = 0;
    const snapshotCopy = { ...syncRevisionsSnapshot };
    syncBus.emit('change', { scopes: [scope], revisions: snapshotCopy });

    db.query(
        'INSERT INTO SyncRevisions (scope, revision) VALUES (?, 2) ON DUPLICATE KEY UPDATE revision = revision + 1',
        [scope],
        (err) => {
            if (err && !/ER_NO_SUCH_TABLE/i.test(err.message || '')) {
                console.error(`[SYNC_BUMP_ERROR] (${scope}):`, err.message);
            }
        }
    );
}

function writeSseEvent(client, eventName, payload) {
    if (!client || client.closed || client.res.writableEnded) return;
    try {
        client.res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch (_) {
        unregisterSseClient(client);
    }
}

function broadcastSseChange(changedScopes, revisions) {
    if (!Array.isArray(changedScopes) || changedScopes.length === 0 || sseClients.size === 0) return;
    for (const client of sseClients) {
        const allowedScopes = client.role === 'psiquiatra'
            ? changedScopes.filter((s) => CLINICAL_SYNC_SCOPES.includes(s))
            : changedScopes;
        if (allowedScopes.length === 0) continue;
        writeSseEvent(client, 'sync', {
            scopes: allowedScopes,
            revisions: filterRevisionsForRole(revisions, client.role)
        });
    }
}

syncBus.on('change', ({ scopes, revisions }) => {
    broadcastSseChange(scopes, revisions);
});

function stopSyncTimersIfIdle() {
    if (sseClients.size > 0) return;
    if (syncPollerTimer) {
        clearInterval(syncPollerTimer);
        syncPollerTimer = null;
    }
    if (syncHeartbeatTimer) {
        clearInterval(syncHeartbeatTimer);
        syncHeartbeatTimer = null;
    }
}

function ensureSyncTimersStarted() {
    if (sseClients.size === 0) return;
    if (!syncPollerTimer) {
        syncPollerTimer = setInterval(async () => {
            if (sseClients.size === 0 || syncPollerInFlight) return;
            syncPollerInFlight = true;
            try {
                const prev = { ...syncRevisionsSnapshot };
                const next = await fetchSyncRevisions({ force: true });
                const changedScopes = SYNC_SCOPES.filter((s) => Number(next[s]) > Number(prev[s]));
                if (changedScopes.length > 0) {
                    broadcastSseChange(changedScopes, next);
                }
            } finally {
                syncPollerInFlight = false;
            }
        }, SYNC_POLL_INTERVAL_MS);
        syncPollerTimer.unref?.();
    }
    if (!syncHeartbeatTimer) {
        syncHeartbeatTimer = setInterval(() => {
            if (sseClients.size === 0) return;
            for (const client of sseClients) {
                if (client.closed || client.res.writableEnded) continue;
                try {
                    client.res.write(': ping\n\n');
                } catch (_) {
                    unregisterSseClient(client);
                }
            }
        }, SYNC_HEARTBEAT_INTERVAL_MS);
        syncHeartbeatTimer.unref?.();
    }
}

function unregisterSseClient(client) {
    if (!client || client.closed) return;
    client.closed = true;
    sseClients.delete(client);
    const userSet = sseClientsByUser.get(client.userId);
    if (userSet) {
        userSet.delete(client);
        if (userSet.size === 0) sseClientsByUser.delete(client.userId);
    }
    try {
        if (!client.res.writableEnded) client.res.end();
    } catch (_) {}
    stopSyncTimersIfIdle();
}

function closeAllSseClients() {
    for (const client of Array.from(sseClients)) {
        unregisterSseClient(client);
    }
    stopSyncTimersIfIdle();
}

app.get('/api/sync/revisions', syncReadLimiter.middleware, requireAuth, async (req, res) => {
    const revisions = await fetchSyncRevisions();
    res.json({
        revisions: filterRevisionsForRole(revisions, req.user.rol)
    });
});

app.get('/api/sync/stream', requireAuth, async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const userId = Number(req.user.id);
    let userSet = sseClientsByUser.get(userId);
    if (!userSet) {
        userSet = new Set();
        sseClientsByUser.set(userId, userSet);
    }
    while (userSet.size >= MAX_SSE_CLIENTS_PER_USER) {
        const oldest = userSet.values().next().value;
        if (!oldest) break;
        unregisterSseClient(oldest);
    }

    const client = {
        userId,
        role: req.user.rol,
        res,
        closed: false
    };
    sseClients.add(client);
    userSet.add(client);
    ensureSyncTimersStarted();

    req.on('close', () => {
        unregisterSseClient(client);
    });

    const revisions = await fetchSyncRevisions();
    if (!client.closed) {
        writeSseEvent(client, 'ready', {
            revisions: filterRevisionsForRole(revisions, client.role)
        });
    }
});

// Manejo controlado de rutas inexistentes y errores inesperados en API (sin filtrar stack traces)
app.use('/api', (req, res) => {
    res.status(404).send('API endpoint not found.');
});

app.use((err, req, res, _next) => {
    console.error(`[API_ERROR] ${req.method} ${req.originalUrl}:`, err && err.message ? err.message : err);
    if (res.headersSent) return;
    res.status(500).send('An internal server error occurred.');
});

const PORT = process.env.PORT || 3000;
const httpServer = app.listen(PORT, () => {
    console.log(`Backend server running at http://localhost:${PORT}`);
    serverLogger.info('SYSTEM', 'Servidor iniciado', {
        replicaId: REPLICA_ID,
        port: PORT,
        tz: process.env.TZ || 'system',
        trustProxy: process.env.TRUST_PROXY || 'off',
        requireHttps: String(process.env.REQUIRE_HTTPS || '').toLowerCase() === 'true',
        autonomousNotes: serverNotesService.isServerAutonomousNotesEnabled(),
        fileLogs: serverLogger.fileEnabled,
        logDir: serverLogger.logDir
    });
    if (!isAutomatedTestEnv() && serverNotesService.isServerAutonomousNotesEnabled()) {
        const pendingDrive = serverNotesService.readEnglishDrivePendingMarker(
            serverNotesService.resolveLocalEnglishPath({ rootDir: __dirname })
        );
        if (pendingDrive) {
            serverLogger.warn('DRIVE_NOTES', 'Respaldo local de cuaderno pendiente de subir a Google Drive detectado al iniciar; programando reintento', {
                pendingSince: pendingDrive.pendingSince,
                attempts: pendingDrive.attempts
            });
            scheduleStudyDriveRetry();
        }
    }
});
// Protección anti-Slowloris / agotamiento de sockets HTTP
httpServer.keepAliveTimeout = 15000;
httpServer.headersTimeout = 20000;
httpServer.requestTimeout = 90000;
httpServer.maxHeadersCount = 64;
httpServer.on('close', closeAllSseClients);

// Capturar errores imprevistos para saber por qué se cayó
process.on('uncaughtException', (err) => {
    serverLogger.crash('PROCESS', 'Server crashed with uncaughtException', {
        error: err && err.stack ? err.stack : String(err)
    });
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    serverLogger.crash('PROCESS', 'Unhandled promise rejection', {
        reason: reason && reason.stack ? reason.stack : String(reason)
    });
    process.exit(1);
});

module.exports = {
    app,
    httpServer,
    computeSmartCommuteAlertSchedule,
    computeCommuteAlertMilestones,
    normalizeNearAlertMinutes,
    computeCandidateReminders,
    sanitizeAcademicPlanner,
    validateUserSettingsPayload,
    sendPhonePushViaNtfy
};

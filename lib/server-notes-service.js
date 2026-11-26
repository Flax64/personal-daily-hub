'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');

const E2EE_ENVELOPE_REGEX = /^[0-9a-fA-F]{32}:[A-Za-z0-9+/=]+$/;
const JOURNAL_SALTED_E2EE_PREFIX = 'pdh-j2';
const JOURNAL_SALTED_PBKDF2_ITERATIONS = 120000;
const JOURNAL_SALTED_MIN_ITERATIONS = 100000;
const JOURNAL_SALTED_MAX_ITERATIONS = 600000;
const JOURNAL_SALTED_ENVELOPE_REGEX = /^pdh-j2:(\d{1,7}):([0-9a-fA-F]{32}):([0-9a-fA-F]{32}):([0-9a-fA-F]{64}):([A-Za-z0-9+/]+={0,2})$/;
const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function isServerAutonomousNotesEnabled(env = process.env) {
    return String(env?.SERVER_AUTONOMOUS_NOTES ?? 'true').trim().toLowerCase() !== 'false';
}

function isWindowsPathString(rawValue) {
    const val = String(rawValue || '').trim();
    if (!val) return false;
    return /^[A-Za-z]:[\\/]/.test(val) || /^\\\\/.test(val) || val.includes('\\');
}

function isValidJournalSaltedEnvelope(rawText) {
    if (typeof rawText !== 'string') return false;
    const trimmed = rawText.trim();
    const match = JOURNAL_SALTED_ENVELOPE_REGEX.exec(trimmed);
    if (!match) return false;
    const [, iterStr, saltHex, ivHex, macHex, cipherB64] = match;
    if (
        saltHex !== saltHex.toLowerCase()
        || ivHex !== ivHex.toLowerCase()
        || macHex !== macHex.toLowerCase()
    ) {
        return false;
    }
    const iterations = Number(iterStr);
    if (
        !Number.isSafeInteger(iterations)
        || iterations < JOURNAL_SALTED_MIN_ITERATIONS
        || iterations > JOURNAL_SALTED_MAX_ITERATIONS
        || String(iterations) !== iterStr
    ) {
        return false;
    }
    const cipherBuf = Buffer.from(cipherB64, 'base64');
    if (cipherBuf.length === 0 || cipherBuf.length % 16 !== 0 || cipherBuf.toString('base64') !== cipherB64) {
        return false;
    }
    return true;
}

function isValidE2eeEnvelope(rawText) {
    if (typeof rawText !== 'string') return false;
    const trimmed = rawText.trim();
    return isValidJournalSaltedEnvelope(trimmed) || E2EE_ENVELOPE_REGEX.test(trimmed);
}

function normalizeE2eeKeyBuffer(secretKey) {
    const raw = String(secretKey || '');
    if (!raw) return null;
    const buf = Buffer.from(raw, 'utf8');
    return buf.length === 32 ? buf : null;
}

function encryptClientE2ee(plainText, secretKey) {
    const keyBuf = normalizeE2eeKeyBuffer(secretKey);
    if (!keyBuf) {
        throw new Error('JOURNAL_SECRET_KEY must be exactly 32 UTF-8 bytes.');
    }
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', keyBuf, iv);
    const encrypted = Buffer.concat([cipher.update(String(plainText ?? ''), 'utf8'), cipher.final()]);
    return `${iv.toString('hex')}:${encrypted.toString('base64')}`;
}

function encryptJournalSaltedE2ee(plainText, secretKey, { iterations = JOURNAL_SALTED_PBKDF2_ITERATIONS } = {}) {
    const keyBuf = normalizeE2eeKeyBuffer(secretKey);
    if (!keyBuf) {
        throw new Error('JOURNAL_SECRET_KEY must be exactly 32 UTF-8 bytes.');
    }
    const iterNum = Number(iterations);
    if (!Number.isSafeInteger(iterNum) || iterNum < 1) {
        throw new Error('PBKDF2 iterations must be a positive integer.');
    }
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(16);
    const derived = crypto.pbkdf2Sync(keyBuf, salt, iterNum, 64, 'sha256');
    const encKey = derived.subarray(0, 32);
    const macKey = derived.subarray(32, 64);

    const cipher = crypto.createCipheriv('aes-256-cbc', encKey, iv);
    const encrypted = Buffer.concat([cipher.update(String(plainText ?? ''), 'utf8'), cipher.final()]);
    const saltHex = salt.toString('hex');
    const ivHex = iv.toString('hex');
    const cipherB64 = encrypted.toString('base64');
    const authPayload = `${JOURNAL_SALTED_E2EE_PREFIX}:${iterNum}:${saltHex}:${ivHex}:${cipherB64}`;
    const macHex = crypto.createHmac('sha256', macKey).update(authPayload, 'utf8').digest('hex');
    return `${JOURNAL_SALTED_E2EE_PREFIX}:${iterNum}:${saltHex}:${ivHex}:${macHex}:${cipherB64}`;
}

function decryptJournalSaltedE2ee(rawCipher, secretKey) {
    if (typeof rawCipher !== 'string') {
        return { ok: false, reason: 'NOT_E2EE_ENVELOPE' };
    }
    const trimmed = rawCipher.trim();
    const match = JOURNAL_SALTED_ENVELOPE_REGEX.exec(trimmed);
    if (!match) {
        return { ok: false, reason: 'INVALID_ENVELOPE' };
    }
    const [, iterStr, saltHex, ivHex, macHex, cipherB64] = match;
    if (
        saltHex !== saltHex.toLowerCase()
        || ivHex !== ivHex.toLowerCase()
        || macHex !== macHex.toLowerCase()
    ) {
        return { ok: false, reason: 'INVALID_ENVELOPE' };
    }
    const iterations = Number(iterStr);
    if (
        !Number.isSafeInteger(iterations)
        || iterations < JOURNAL_SALTED_MIN_ITERATIONS
        || iterations > JOURNAL_SALTED_MAX_ITERATIONS
        || String(iterations) !== iterStr
    ) {
        return { ok: false, reason: 'INVALID_ITERATIONS' };
    }
    const keyBuf = normalizeE2eeKeyBuffer(secretKey);
    if (!keyBuf) {
        return { ok: false, reason: 'NO_VALID_SERVER_KEY' };
    }
    const salt = Buffer.from(saltHex, 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const providedMacBuf = Buffer.from(macHex, 'hex');
    const cipherBuf = Buffer.from(cipherB64, 'base64');
    if (
        salt.length !== 16
        || iv.length !== 16
        || providedMacBuf.length !== 32
        || cipherBuf.length === 0
        || cipherBuf.length % 16 !== 0
        || cipherBuf.toString('base64') !== cipherB64
    ) {
        return { ok: false, reason: 'INVALID_CIPHERTEXT' };
    }

    const derived = crypto.pbkdf2Sync(keyBuf, salt, iterations, 64, 'sha256');
    const encKey = derived.subarray(0, 32);
    const macKey = derived.subarray(32, 64);

    const authPayload = `${JOURNAL_SALTED_E2EE_PREFIX}:${iterStr}:${saltHex}:${ivHex}:${cipherB64}`;
    const expectedMacBuf = crypto.createHmac('sha256', macKey).update(authPayload, 'utf8').digest();
    if (providedMacBuf.length !== expectedMacBuf.length || !crypto.timingSafeEqual(providedMacBuf, expectedMacBuf)) {
        return { ok: false, reason: 'MAC_MISMATCH' };
    }

    try {
        const decipher = crypto.createDecipheriv('aes-256-cbc', encKey, iv);
        const plainBuf = Buffer.concat([decipher.update(cipherBuf), decipher.final()]);
        const plain = new TextDecoder('utf-8', { fatal: true }).decode(plainBuf);
        if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(plain)) {
            return { ok: false, reason: 'E2EE_KEY_MISMATCH' };
        }
        return { ok: true, plainText: plain, scheme: JOURNAL_SALTED_E2EE_PREFIX };
    } catch (_) {
        return { ok: false, reason: 'E2EE_KEY_MISMATCH' };
    }
}

function decryptClientE2ee(rawCipher, secretKey) {
    if (typeof rawCipher === 'string' && rawCipher.trim().startsWith(`${JOURNAL_SALTED_E2EE_PREFIX}:`)) {
        return decryptJournalSaltedE2ee(rawCipher, secretKey);
    }
    if (!isValidE2eeEnvelope(rawCipher)) {
        return { ok: false, reason: 'NOT_E2EE_ENVELOPE' };
    }
    const keyBuf = normalizeE2eeKeyBuffer(secretKey);
    if (!keyBuf) {
        return { ok: false, reason: 'NO_VALID_SERVER_KEY' };
    }
    const trimmed = rawCipher.trim();
    const sepIdx = trimmed.indexOf(':');
    const iv = Buffer.from(trimmed.slice(0, sepIdx), 'hex');
    const cipherBuf = Buffer.from(trimmed.slice(sepIdx + 1), 'base64');
    if (iv.length !== 16 || cipherBuf.length === 0 || cipherBuf.length % 16 !== 0) {
        return { ok: false, reason: 'INVALID_CIPHERTEXT' };
    }
    try {
        const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuf, iv);
        const plainBuf = Buffer.concat([decipher.update(cipherBuf), decipher.final()]);
        const plain = new TextDecoder('utf-8', { fatal: true }).decode(plainBuf);
        if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(plain)) {
            return { ok: false, reason: 'E2EE_KEY_MISMATCH' };
        }
        return { ok: true, plainText: plain };
    } catch (_) {
        return { ok: false, reason: 'E2EE_KEY_MISMATCH' };
    }
}

function isValidJournalDownloadPassword(password) {
    if (typeof password !== 'string') return false;
    if (password.length < 8 || password.length > 128) return false;
    if (password.trim().length === 0) return false;
    if (/[\x00-\x1F\x7F]/.test(password)) return false;
    return true;
}

function encryptJournalSaltedBytesE2ee(plainBuffer, password, { iterations = JOURNAL_SALTED_PBKDF2_ITERATIONS } = {}) {
    const buf = Buffer.isBuffer(plainBuffer)
        ? plainBuffer
        : (plainBuffer instanceof Uint8Array ? Buffer.from(plainBuffer) : null);
    if (!buf || buf.length === 0) {
        throw new Error('plainBuffer must be a non-empty Buffer.');
    }
    if (!isValidJournalDownloadPassword(password)) {
        throw new Error('Download password must be between 8 and 128 characters.');
    }
    const iterNum = Number(iterations);
    if (!Number.isSafeInteger(iterNum) || iterNum < 1) {
        throw new Error('PBKDF2 iterations must be a positive integer.');
    }

    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(16);
    const derived = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterNum, 64, 'sha256');
    try {
        const encKey = derived.subarray(0, 32);
        const macKey = derived.subarray(32, 64);

        const cipher = crypto.createCipheriv('aes-256-cbc', encKey, iv);
        const encrypted = Buffer.concat([cipher.update(buf), cipher.final()]);
        const saltHex = salt.toString('hex');
        const ivHex = iv.toString('hex');
        const cipherB64 = encrypted.toString('base64');
        const authPayload = `${JOURNAL_SALTED_E2EE_PREFIX}:${iterNum}:${saltHex}:${ivHex}:${cipherB64}`;
        const macHex = crypto.createHmac('sha256', macKey).update(authPayload, 'utf8').digest('hex');
        return `${JOURNAL_SALTED_E2EE_PREFIX}:${iterNum}:${saltHex}:${ivHex}:${macHex}:${cipherB64}`;
    } finally {
        derived.fill(0);
    }
}

function decryptJournalSaltedBytesE2ee(rawCipher, password) {
    if (typeof rawCipher !== 'string') {
        return { ok: false, reason: 'NOT_E2EE_ENVELOPE' };
    }
    const trimmed = rawCipher.trim();
    const parts = trimmed.split(':');
    if (parts.length !== 6 || parts[0] !== JOURNAL_SALTED_E2EE_PREFIX) {
        return { ok: false, reason: 'INVALID_ENVELOPE' };
    }
    const [, iterStr, saltHex, ivHex, macHex, cipherB64] = parts;
    if (
        !/^\d{1,7}$/.test(iterStr)
        || !/^[0-9a-f]{32}$/.test(saltHex)
        || !/^[0-9a-f]{32}$/.test(ivHex)
        || !/^[0-9a-f]{64}$/.test(macHex)
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(cipherB64)
    ) {
        return { ok: false, reason: 'INVALID_ENVELOPE' };
    }
    const iterations = Number(iterStr);
    if (
        !Number.isSafeInteger(iterations)
        || iterations < JOURNAL_SALTED_MIN_ITERATIONS
        || iterations > JOURNAL_SALTED_MAX_ITERATIONS
        || String(iterations) !== iterStr
    ) {
        return { ok: false, reason: 'INVALID_ITERATIONS' };
    }
    if (!isValidJournalDownloadPassword(password)) {
        return { ok: false, reason: 'INVALID_PASSWORD' };
    }

    const salt = Buffer.from(saltHex, 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const providedMacBuf = Buffer.from(macHex, 'hex');
    const cipherBuf = Buffer.from(cipherB64, 'base64');
    if (
        salt.length !== 16
        || iv.length !== 16
        || providedMacBuf.length !== 32
        || cipherBuf.length === 0
        || cipherBuf.length % 16 !== 0
        || cipherBuf.toString('base64') !== cipherB64
    ) {
        return { ok: false, reason: 'INVALID_CIPHERTEXT' };
    }

    const derived = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 64, 'sha256');
    try {
        const encKey = derived.subarray(0, 32);
        const macKey = derived.subarray(32, 64);

        const authPayload = `${JOURNAL_SALTED_E2EE_PREFIX}:${iterStr}:${saltHex}:${ivHex}:${cipherB64}`;
        const expectedMacBuf = crypto.createHmac('sha256', macKey).update(authPayload, 'utf8').digest();
        if (providedMacBuf.length !== expectedMacBuf.length || !crypto.timingSafeEqual(providedMacBuf, expectedMacBuf)) {
            return { ok: false, reason: 'MAC_MISMATCH' };
        }

        try {
            const decipher = crypto.createDecipheriv('aes-256-cbc', encKey, iv);
            const plainBuf = Buffer.concat([decipher.update(cipherBuf), decipher.final()]);
            return { ok: true, buffer: plainBuf, scheme: JOURNAL_SALTED_E2EE_PREFIX };
        } catch (_) {
            return { ok: false, reason: 'DECRYPT_FAILED' };
        }
    } finally {
        derived.fill(0);
    }
}

function buildSafeRcloneExecEnv(env = process.env) {
    const cleanEnv = { ...env };
    for (const k of Object.keys(cleanEnv)) {
        if (k.startsWith('RCLONE_') || k.startsWith('STUDY_RCLONE_')) {
            delete cleanEnv[k];
        }
    }
    return cleanEnv;
}

function runRcloneCommand({
    rcloneConf,
    args,
    timeout = 30000,
    encoding = 'utf8',
    maxBuffer = 16 * 1024 * 1024,
    execFileFn = execFile,
    env = process.env
}) {
    return new Promise((resolve, reject) => {
        execFileFn(
            'rclone',
            ['--config', rcloneConf, ...args],
            { timeout, encoding, maxBuffer, env: buildSafeRcloneExecEnv(env) },
            (err, stdout, stderr) => {
                if (err) {
                    return reject(new Error(String(stderr || err.message || 'rclone failed').trim()));
                }
                resolve(stdout);
            }
        );
    });
}

async function uploadAndVerifyStudyDocx({
    docxBuffer,
    filePath,
    rcloneConf,
    remoteTarget,
    execFileFn = execFile,
    env = process.env
}) {
    if (!Buffer.isBuffer(docxBuffer) || docxBuffer.length < 64 || !docxBuffer.subarray(0, 4).equals(ZIP_MAGIC)) {
        throw new Error('Payload is not a valid .docx ZIP container.');
    }

    const localSha256 = crypto.createHash('sha256').update(docxBuffer).digest('hex');
    await runRcloneCommand({
        rcloneConf,
        args: ['copyto', '--retries', '1', filePath, remoteTarget],
        timeout: 14000,
        execFileFn,
        env
    });

    let verified = false;
    let remoteSize = null;
    let remoteModTime = '';
    try {
        const lsOut = await runRcloneCommand({
            rcloneConf,
            args: ['lsjson', remoteTarget],
            timeout: 7000,
            execFileFn,
            env
        });
        const entries = JSON.parse(String(lsOut || '[]'));
        if (Array.isArray(entries) && entries.length > 0) {
            remoteModTime = String(entries[0].ModTime || '');
            remoteSize = Number(entries[0].Size);
            if (remoteSize === docxBuffer.length) {
                verified = true;
            }
        }
    } catch (_) {
        verified = false;
    }

    return {
        uploaded: verified,
        verified,
        localSize: docxBuffer.length,
        remoteSize,
        remoteModTime,
        sha256: localSha256,
        remoteTarget
    };
}

function resolveLocalJournalPath({ env = process.env, platform = process.platform, rootDir = path.resolve(__dirname, '..') } = {}) {
    const pathImpl = platform === 'win32' ? path.win32 : path.posix;
    const rawExplicit = String(env.JOURNAL_LOCAL_PATH || env.WORD_FILE_PATH || '').trim();
    if (rawExplicit && (platform === 'win32' || !isWindowsPathString(rawExplicit))) {
        return pathImpl.resolve(rawExplicit);
    }
    const containerDir = '/app/journal-data';
    if (platform !== 'win32' && fs.existsSync(containerDir)) {
        return pathImpl.join(containerDir, 'Diario.docx');
    }
    return pathImpl.join(rootDir, 'data', 'journal', 'Diario.docx');
}

function resolveLocalEnglishPath({ env = process.env, platform = process.platform, rootDir = path.resolve(__dirname, '..') } = {}) {
    const pathImpl = platform === 'win32' ? path.win32 : path.posix;
    const rawExplicit = String(env.ENGLISH_WORD_FILE_PATH || '').trim();
    const journalPath = resolveLocalJournalPath({ env, platform, rootDir });
    let candidate = pathImpl.join(rootDir, 'english-notes', 'English_Learning_Notebook.docx');
    if (rawExplicit && (platform === 'win32' || !isWindowsPathString(rawExplicit))) {
        candidate = pathImpl.resolve(rawExplicit);
    }
    const base = pathImpl.basename(candidate);
    if (candidate === journalPath || /personal_journal|journal_notes|diario\.docx/i.test(base)) {
        return pathImpl.join(rootDir, 'english-notes', 'English_Learning_Notebook.docx');
    }
    return candidate;
}

function resolvePythonBinary({ env = process.env, platform = process.platform, execFileSyncFn = execFileSync } = {}) {
    const explicit = String(env.PYTHON_PATH || '').trim();
    const candidates = [];
    if (explicit && (platform === 'win32' || !isWindowsPathString(explicit))) {
        candidates.push(explicit);
    }
    if (platform === 'win32') {
        candidates.push('python', 'python3', 'py');
    } else {
        candidates.push('python3', 'python');
    }
    for (const cmd of candidates) {
        try {
            execFileSyncFn(cmd, ['--version'], { stdio: 'pipe', timeout: 3000 });
            return cmd;
        } catch (_) {}
    }
    return null;
}

function runDocxWriter({
    mode,
    payload,
    maxBuffer = 4 * 1024 * 1024,
    env = process.env,
    platform = process.platform,
    execFileFn = execFile,
    execFileSyncFn = execFileSync
}) {
    const pythonBin = resolvePythonBinary({ env, platform, execFileSyncFn });
    if (!pythonBin) {
        return Promise.resolve({ ok: false, reason: 'PYTHON_MISSING', error: 'Python 3 runtime is not installed.' });
    }
    const resolvedMaxBuffer = Number.isFinite(Number(maxBuffer)) && Number(maxBuffer) > 0
        ? Math.min(24 * 1024 * 1024, Math.floor(Number(maxBuffer)))
        : 4 * 1024 * 1024;
    const scriptPath = path.join(__dirname, 'docx_writer.py');
    const stdinPayload = JSON.stringify(payload || {});
    const pyEnv = { ...env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
    return new Promise((resolve) => {
        const child = execFileFn(
            pythonBin,
            [scriptPath, '--mode', mode],
            { timeout: 30000, maxBuffer: resolvedMaxBuffer, env: pyEnv },
            (err, stdout, stderr) => {
                const rawOut = String(stdout || '').trim();
                if (rawOut) {
                    try {
                        const parsed = JSON.parse(rawOut.split(/\r?\n/).pop());
                        return resolve(parsed);
                    } catch (_) {}
                }
                const errMsg = String(stderr || err?.message || 'docx_writer failed').trim();
                return resolve({ ok: false, reason: 'WRITER_EXEC_ERROR', error: errMsg.slice(0, 300) });
            }
        );
        if (child && child.stdin) {
            child.stdin.write(stdinPayload, 'utf8');
            child.stdin.end();
        }
    });
}

const DOC_XML_ENTRY_MARKER = Buffer.from('word/document.xml', 'utf8');

function isValidDocxZipBuffer(buf) {
    return Boolean(
        Buffer.isBuffer(buf)
        && buf.length >= 64
        && buf.subarray(0, 4).equals(ZIP_MAGIC)
        && buf.includes(DOC_XML_ENTRY_MARKER)
    );
}

function isValidDocxZipFile(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return false;
        const st = fs.statSync(filePath);
        if (!st.isFile() || st.size < 64) return false;
        const buf = fs.readFileSync(filePath);
        return isValidDocxZipBuffer(buf);
    } catch (_) {
        return false;
    }
}

function resolveEnglishDrivePendingMarkerPath({ env = process.env, platform = process.platform, rootDir = path.resolve(__dirname, '..') } = {}) {
    const localMirrorPath = resolveLocalEnglishPath({ env, platform, rootDir });
    const pathImpl = platform === 'win32' ? path.win32 : path.posix;
    return pathImpl.join(pathImpl.dirname(localMirrorPath), '.english_drive_pending.json');
}

function getPendingMarkerPathForMirror(localMirrorPath) {
    return path.join(path.dirname(localMirrorPath), '.english_drive_pending.json');
}

function readEnglishDrivePendingMarker(localMirrorPathOrOpts = null) {
    try {
        const markerPath = typeof localMirrorPathOrOpts === 'string' && localMirrorPathOrOpts
            ? getPendingMarkerPathForMirror(localMirrorPathOrOpts)
            : resolveEnglishDrivePendingMarkerPath(localMirrorPathOrOpts || {});
        if (!fs.existsSync(markerPath)) return null;
        const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
        return null;
    }
}

function writeBufferAtomic(targetPath, buf, mode = 0o644) {
    const dir = path.dirname(targetPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, buf, { mode });
    fs.renameSync(tmp, targetPath);
    try {
        fs.chmodSync(targetPath, mode);
    } catch (_) {}
}

function writeEnglishDrivePendingMarker(localMirrorPath, payload = {}) {
    const markerPath = getPendingMarkerPathForMirror(localMirrorPath);
    const data = {
        pendingSince: payload.pendingSince || new Date().toISOString(),
        lastAttemptAt: payload.lastAttemptAt || new Date().toISOString(),
        attempts: Math.max(1, Number(payload.attempts) || 1),
        localSize: Number(payload.localSize) || 0,
        heading: String(payload.heading || '').slice(0, 200),
        remoteTarget: String(payload.remoteTarget || '').slice(0, 300),
        lastError: String(payload.lastError || '').slice(0, 300)
    };
    writeBufferAtomic(markerPath, Buffer.from(JSON.stringify(data, null, 2), 'utf8'), 0o600);
    return data;
}

function clearEnglishDrivePendingMarker(localMirrorPath) {
    try {
        const markerPath = getPendingMarkerPathForMirror(localMirrorPath);
        if (fs.existsSync(markerPath)) {
            fs.unlinkSync(markerPath);
        }
    } catch (_) {}
}

async function saveEnglishEntryToCloudAndLocal({
    entry,
    resolveRcloneFn,
    resolveStudyTargetFn,
    updateCacheFn,
    lyricsGuardFn = null,
    rootDir = path.resolve(__dirname, '..'),
    env = process.env,
    platform = process.platform,
    execFileFn = execFile,
    execFileSyncFn = execFileSync
}) {
    const localMirrorPath = resolveLocalEnglishPath({ env, platform, rootDir });
    const shmDir = fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir();
    const tmpWorkPath = path.join(shmDir, `English_Write_${process.pid}_${Date.now()}.docx`);
    const isReplaceLyrics = Boolean(entry && typeof entry === 'object' && (entry.replace_lyrics || entry.replaceLyrics));

    const rcloneCtx = typeof resolveRcloneFn === 'function'
        ? resolveRcloneFn({ preferStudy: true })
        : { confPath: '', cleanup: false, usingStudyConfig: false };
    const rcloneConf = rcloneCtx?.confPath || '';
    const hasRclone = Boolean(rcloneConf && fs.existsSync(rcloneConf));
    const targetInfo = typeof resolveStudyTargetFn === 'function'
        ? resolveStudyTargetFn(rcloneConf, Boolean(rcloneCtx?.usingStudyConfig))
        : { remoteTarget: '' };
    const remoteTarget = targetInfo?.remoteTarget || '';

    const pendingMarker = readEnglishDrivePendingMarker(localMirrorPath);
    const localMirrorValid = isValidDocxZipFile(localMirrorPath);
    let seededFrom = 'fresh';
    try {
        // Offline-first when local mirror has unsynced pending writes: never overwrite newer offline notes with stale Drive copy
        if (pendingMarker && localMirrorValid) {
            fs.copyFileSync(localMirrorPath, tmpWorkPath);
            seededFrom = 'local-pending-word';
        } else if (hasRclone && remoteTarget) {
            // Cloud-first: pull existing notebook from Google Drive when available (skip download if local mirror size already matches Drive)
            try {
                const lsRaw = await runRcloneCommand({
                    rcloneConf,
                    args: ['lsjson', remoteTarget],
                    timeout: 6000,
                    execFileFn,
                    env
                });
                const entries = JSON.parse(String(lsRaw || '[]'));
                if (Array.isArray(entries) && entries.length > 0) {
                    const remoteSize = Number(entries[0].Size);
                    if (localMirrorValid) {
                        const localStat = fs.statSync(localMirrorPath);
                        if (Number.isFinite(remoteSize) && remoteSize > 0 && localStat.size === remoteSize) {
                            fs.copyFileSync(localMirrorPath, tmpWorkPath);
                            seededFrom = 'drive-word';
                        }
                    }
                    if (seededFrom === 'fresh') {
                        await runRcloneCommand({
                            rcloneConf,
                            args: ['copyto', '--retries', '1', remoteTarget, tmpWorkPath],
                            timeout: 12000,
                            execFileFn,
                            env
                        });
                        if (isValidDocxZipFile(tmpWorkPath)) {
                            seededFrom = 'drive-word';
                        } else if (fs.existsSync(tmpWorkPath)) {
                            try { fs.unlinkSync(tmpWorkPath); } catch (_) {}
                        }
                    }
                }
            } catch (_) {
                // Fall back to local mirror or fresh template if Drive check/download failed transiently
            }
        }

        if (seededFrom === 'fresh' && localMirrorValid) {
            fs.copyFileSync(localMirrorPath, tmpWorkPath);
            seededFrom = 'local-word';
        }

        const hasValidTmpSeed = isValidDocxZipFile(tmpWorkPath);
        if (isReplaceLyrics && !hasValidTmpSeed) {
            return {
                ok: false,
                reason: 'SONG_NOT_FOUND',
                error: 'English_Learning_Notebook.docx does not exist yet.'
            };
        }

        if (typeof lyricsGuardFn === 'function') {
            const existingBuf = hasValidTmpSeed ? fs.readFileSync(tmpWorkPath) : null;
            const guardRes = await lyricsGuardFn({ entry, docxBuffer: existingBuf, seededFrom });
            if (guardRes && guardRes.ok === false) {
                return {
                    ok: false,
                    reason: guardRes.reason || 'LYRICS_VALIDATION_FAILED',
                    error: guardRes.error || 'Lyrics validation failed.',
                    matchedSong: guardRes.matchedSong || '',
                    similarity: guardRes.similarity ?? null,
                    seededFrom
                };
            }
            if (guardRes && guardRes.entry) {
                entry = guardRes.entry;
            }
        }

        const writerPayload = {
            docxPath: tmpWorkPath,
            entry,
            ...(isReplaceLyrics ? { replaceLyrics: true, backup: true } : {})
        };
        const writeRes = await runDocxWriter({
            mode: 'english',
            payload: writerPayload,
            rootDir,
            env,
            platform,
            execFileFn,
            execFileSyncFn
        });
        if (!writeRes || !writeRes.ok || !fs.existsSync(tmpWorkPath)) {
            return {
                ok: false,
                reason: writeRes?.reason || 'ENGLISH_DOCX_WRITE_FAILED',
                error: writeRes?.error || 'Could not update English_Learning_Notebook.docx'
            };
        }

        const updatedBuf = fs.readFileSync(tmpWorkPath);
        if (!isValidDocxZipBuffer(updatedBuf)) {
            return {
                ok: false,
                reason: 'INVALID_OUTPUT_DOCX',
                error: 'Generated English_Learning_Notebook.docx failed ZIP integrity check.'
            };
        }
        if (isReplaceLyrics && localMirrorValid) {
            try {
                fs.copyFileSync(localMirrorPath, `${localMirrorPath}.bak`);
            } catch (bakErr) {
                return {
                    ok: false,
                    reason: 'BACKUP_FAILED',
                    error: `Failed to create local backup before replacing lyrics: ${bakErr.message}`
                };
            }
        }
        try {
            writeBufferAtomic(localMirrorPath, updatedBuf, 0o600);
        } catch (_) {}

        if (typeof updateCacheFn === 'function') {
            updateCacheFn(updatedBuf, hasRclone ? 'drive-word' : 'local-word', {
                size: updatedBuf.length,
                mtimeMs: Date.now()
            });
        }

        if (hasRclone && remoteTarget) {
            try {
                const syncRes = await uploadAndVerifyStudyDocx({
                    docxBuffer: updatedBuf,
                    filePath: tmpWorkPath,
                    rcloneConf,
                    remoteTarget,
                    execFileFn,
                    env
                });
                if (syncRes.verified) {
                    clearEnglishDrivePendingMarker(localMirrorPath);
                    return {
                        ok: true,
                        mode: 'cloud_drive',
                        uploaded: true,
                        verified: true,
                        hadPendingRecovery: Boolean(pendingMarker),
                        seededFrom,
                        heading: writeRes.heading,
                        language: writeRes.language || '',
                        languageCode: writeRes.languageCode || '',
                        deduplicated: Boolean(writeRes.deduplicated),
                        replacedLyrics: Boolean(writeRes.replacedLyrics),
                        remoteTarget,
                        localMirrorPath
                    };
                }
                writeEnglishDrivePendingMarker(localMirrorPath, {
                    pendingSince: pendingMarker?.pendingSince,
                    attempts: Number(pendingMarker?.attempts || 0) + 1,
                    localSize: updatedBuf.length,
                    heading: writeRes.heading,
                    remoteTarget,
                    lastError: 'Drive byte verification mismatch'
                });
                return {
                    ok: true,
                    mode: 'local_cache_pending_drive',
                    uploaded: false,
                    verified: false,
                    needsRetry: true,
                    heading: writeRes.heading,
                    language: writeRes.language || '',
                    languageCode: writeRes.languageCode || '',
                    error: 'Drive byte verification mismatch',
                    localMirrorPath
                };
            } catch (uploadErr) {
                writeEnglishDrivePendingMarker(localMirrorPath, {
                    pendingSince: pendingMarker?.pendingSince,
                    attempts: Number(pendingMarker?.attempts || 0) + 1,
                    localSize: updatedBuf.length,
                    heading: writeRes.heading,
                    remoteTarget,
                    lastError: uploadErr.message
                });
                return {
                    ok: true,
                    mode: 'local_cache_pending_drive',
                    uploaded: false,
                    verified: false,
                    needsRetry: true,
                    heading: writeRes.heading,
                    language: writeRes.language || '',
                    languageCode: writeRes.languageCode || '',
                    error: uploadErr.message,
                    localMirrorPath
                };
            }
        }

        return {
            ok: true,
            mode: 'local_volume',
            uploaded: false,
            verified: false,
            seededFrom,
            heading: writeRes.heading,
            language: writeRes.language || '',
            languageCode: writeRes.languageCode || '',
            deduplicated: Boolean(writeRes.deduplicated),
            replacedLyrics: Boolean(writeRes.replacedLyrics),
            localMirrorPath
        };
    } finally {
        try {
            if (fs.existsSync(tmpWorkPath)) fs.unlinkSync(tmpWorkPath);
            if (fs.existsSync(`${tmpWorkPath}.bak`)) fs.unlinkSync(`${tmpWorkPath}.bak`);
            if (rcloneCtx?.cleanup && rcloneConf && fs.existsSync(rcloneConf)) fs.unlinkSync(rcloneConf);
        } catch (_) {}
    }
}

async function flushPendingEnglishDriveUpload({
    resolveRcloneFn,
    resolveStudyTargetFn,
    updateCacheFn,
    rootDir = path.resolve(__dirname, '..'),
    env = process.env,
    platform = process.platform,
    execFileFn = execFile
} = {}) {
    const localMirrorPath = resolveLocalEnglishPath({ env, platform, rootDir });
    const pendingMarker = readEnglishDrivePendingMarker(localMirrorPath);
    if (!pendingMarker) {
        return { ok: true, pending: false, flushed: false, localMirrorPath };
    }
    if (!isValidDocxZipFile(localMirrorPath)) {
        return {
            ok: false,
            pending: true,
            flushed: false,
            localMirrorPath,
            error: 'Local English notebook mirror is missing or invalid.'
        };
    }

    const rcloneCtx = typeof resolveRcloneFn === 'function'
        ? resolveRcloneFn({ preferStudy: true })
        : { confPath: '', cleanup: false, usingStudyConfig: false };
    const rcloneConf = rcloneCtx?.confPath || '';
    const hasRclone = Boolean(rcloneConf && fs.existsSync(rcloneConf));
    const targetInfo = typeof resolveStudyTargetFn === 'function'
        ? resolveStudyTargetFn(rcloneConf, Boolean(rcloneCtx?.usingStudyConfig))
        : { remoteTarget: '' };
    const remoteTarget = targetInfo?.remoteTarget || '';

    try {
        if (!hasRclone || !remoteTarget) {
            return {
                ok: false,
                pending: true,
                flushed: false,
                localMirrorPath,
                error: 'rclone configuration or Drive target unavailable.'
            };
        }
        const buf = fs.readFileSync(localMirrorPath);
        const syncRes = await uploadAndVerifyStudyDocx({
            docxBuffer: buf,
            filePath: localMirrorPath,
            rcloneConf,
            remoteTarget,
            execFileFn,
            env
        });
        if (syncRes.verified) {
            clearEnglishDrivePendingMarker(localMirrorPath);
            if (typeof updateCacheFn === 'function') {
                updateCacheFn(buf, 'drive-word', { size: buf.length, mtimeMs: Date.now() });
            }
            return {
                ok: true,
                pending: false,
                flushed: true,
                verified: true,
                localSize: syncRes.localSize,
                remoteSize: syncRes.remoteSize,
                remoteTarget,
                localMirrorPath
            };
        }
        writeEnglishDrivePendingMarker(localMirrorPath, {
            ...pendingMarker,
            lastAttemptAt: new Date().toISOString(),
            attempts: Number(pendingMarker.attempts || 0) + 1,
            localSize: buf.length,
            remoteTarget,
            lastError: 'Drive byte verification mismatch'
        });
        return {
            ok: false,
            pending: true,
            flushed: false,
            verified: false,
            remoteTarget,
            localMirrorPath,
            error: 'Drive byte verification mismatch'
        };
    } catch (err) {
        try {
            writeEnglishDrivePendingMarker(localMirrorPath, {
                ...pendingMarker,
                lastAttemptAt: new Date().toISOString(),
                attempts: Number(pendingMarker.attempts || 0) + 1,
                remoteTarget,
                lastError: err.message
            });
        } catch (_) {}
        return {
            ok: false,
            pending: true,
            flushed: false,
            remoteTarget,
            localMirrorPath,
            error: err.message || 'Drive upload retry failed'
        };
    } finally {
        try {
            if (rcloneCtx?.cleanup && rcloneConf && fs.existsSync(rcloneConf)) fs.unlinkSync(rcloneConf);
        } catch (_) {}
    }
}

const JOURNAL_MONTH_NAMES_EN = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];

function computeJournalHeadingForDateIso(dateIso = null) {
    const clean = String(dateIso || '').trim();
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(clean)
        ? clean
        : new Date().toISOString().slice(0, 10);
    const [year, month, day] = iso.split('-').map(Number);
    const epochMs = Date.UTC(2026, 7, 30); // 2026-08-30 -> D-500
    const targetMs = Date.UTC(year, month - 1, day);
    const daysPassed = Math.round((targetMs - epochMs) / 86400000);
    const dActual = 500 - daysPassed;
    const suffix = (day >= 11 && day <= 13)
        ? 'th'
        : ({ 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] || 'th');
    return `${JOURNAL_MONTH_NAMES_EN[month - 1]} ${String(day).padStart(2, '0')}${suffix} D-${dActual}`;
}

async function saveJournalNoteLocalEncrypted({
    plainText,
    wordPassword,
    targetDateIso = null,
    backfillMissingBefore = true,
    rootDir = path.resolve(__dirname, '..'),
    env = process.env,
    platform = process.platform,
    execFileFn = execFile,
    execFileSyncFn = execFileSync
}) {
    const journalPath = resolveLocalJournalPath({ env, platform, rootDir });
    if (!wordPassword) {
        return { ok: false, reason: 'PASSWORD_MISSING', error: 'WORD_PASSWORD is required to encrypt local Diario.docx.' };
    }
    return runDocxWriter({
        mode: 'journal',
        payload: {
            docxPath: journalPath,
            password: String(wordPassword),
            text: String(plainText || ''),
            targetDateIso,
            backfillMissingBefore: Boolean(backfillMissingBefore)
        },
        rootDir,
        env,
        platform,
        execFileFn,
        execFileSyncFn
    });
}

async function inspectJournalDailyCoverage({
    wordPassword,
    todayIso = null,
    rootDir = path.resolve(__dirname, '..'),
    env = process.env,
    platform = process.platform,
    execFileFn = execFile,
    execFileSyncFn = execFileSync
}) {
    const journalPath = resolveLocalJournalPath({ env, platform, rootDir });
    if (!wordPassword) {
        return { ok: false, reason: 'PASSWORD_MISSING', error: 'WORD_PASSWORD is required to inspect local Diario.docx.' };
    }
    return runDocxWriter({
        mode: 'journal-inspect',
        payload: {
            docxPath: journalPath,
            password: String(wordPassword),
            todayIso
        },
        rootDir,
        env,
        platform,
        execFileFn,
        execFileSyncFn
    });
}

async function verifyJournalDailyCoverage({
    wordPassword,
    todayIso = null,
    throughDateIso = null,
    createIfMissing = false,
    fillIfEmptyDoc = false,
    rootDir = path.resolve(__dirname, '..'),
    env = process.env,
    platform = process.platform,
    execFileFn = execFile,
    execFileSyncFn = execFileSync
}) {
    const journalPath = resolveLocalJournalPath({ env, platform, rootDir });
    if (!wordPassword) {
        return { ok: false, reason: 'PASSWORD_MISSING', error: 'WORD_PASSWORD is required to verify local Diario.docx.' };
    }
    return runDocxWriter({
        mode: 'journal-verify',
        payload: {
            docxPath: journalPath,
            password: String(wordPassword),
            todayIso,
            throughDateIso,
            createIfMissing: Boolean(createIfMissing),
            fillIfEmptyDoc: Boolean(fillIfEmptyDoc)
        },
        rootDir,
        env,
        platform,
        execFileFn,
        execFileSyncFn
    });
}

function getLocalJournalStatus({ env = process.env, platform = process.platform, rootDir = path.resolve(__dirname, '..') } = {}) {
    const journalPath = resolveLocalJournalPath({ env, platform, rootDir });
    const exists = fs.existsSync(journalPath);
    let sizeBytes = 0;
    let updatedAt = null;
    let encrypted = false;
    if (exists) {
        try {
            const st = fs.statSync(journalPath);
            sizeBytes = st.size;
            updatedAt = st.mtime ? st.mtime.toISOString() : null;
            const fd = fs.openSync(journalPath, 'r');
            try {
                const head = Buffer.alloc(8);
                const readBytes = fs.readSync(fd, head, 0, 8, 0);
                encrypted = readBytes === 8 && head.equals(OLE2_MAGIC);
            } finally {
                fs.closeSync(fd);
            }
        } catch (_) {}
    }
    return {
        exists,
        encrypted,
        sizeBytes,
        updatedAt,
        path: journalPath,
        passwordConfigured: Boolean(String(env.WORD_PASSWORD || '').trim())
    };
}

async function exportJournalDocxEncryptedForClient({
    wordPassword,
    downloadPassword,
    rootDir = path.resolve(__dirname, '..'),
    env = process.env,
    platform = process.platform,
    execFileFn = execFile,
    execFileSyncFn = execFileSync
}) {
    if (!String(wordPassword || '').trim()) {
        return { ok: false, reason: 'PASSWORD_MISSING', error: 'WORD_PASSWORD is required to export local Diario.docx.' };
    }
    if (!isValidJournalDownloadPassword(downloadPassword)) {
        return {
            ok: false,
            reason: 'INVALID_DOWNLOAD_PASSWORD',
            error: 'Download password must be between 8 and 128 characters.'
        };
    }

    const status = getLocalJournalStatus({ env, platform, rootDir });
    if (!status.exists) {
        return {
            ok: false,
            reason: 'MISSING_FILE',
            error: 'Local encrypted Diario.docx has not been created yet.'
        };
    }
    if (!status.encrypted) {
        return {
            ok: false,
            reason: 'UNENCRYPTED_FILE',
            error: 'Refusing to export unencrypted Journal file.'
        };
    }

    const writerRes = await runDocxWriter({
        mode: 'journal-export-plain',
        payload: {
            docxPath: status.path,
            password: String(wordPassword)
        },
        maxBuffer: 24 * 1024 * 1024,
        env,
        platform,
        execFileFn,
        execFileSyncFn
    });

    if (!writerRes || !writerRes.ok || typeof writerRes.docxBase64 !== 'string' || !writerRes.docxBase64) {
        return {
            ok: false,
            reason: writerRes?.reason || 'EXPORT_FAILED',
            error: writerRes?.error || 'Could not export local encrypted Diario.docx.'
        };
    }

    const docxBuf = Buffer.from(writerRes.docxBase64, 'base64');
    writerRes.docxBase64 = '';
    try {
        if (!isValidDocxZipBuffer(docxBuf)) {
            return {
                ok: false,
                reason: 'CORRUPT_DOCX',
                error: 'Decrypted Diario.docx failed OOXML ZIP integrity check.'
            };
        }
        const sizeBytes = docxBuf.length;
        const encryptedDocx = encryptJournalSaltedBytesE2ee(docxBuf, downloadPassword);
        return {
            ok: true,
            encryptedDocx,
            sizeBytes,
            updatedAt: status.updatedAt
        };
    } finally {
        docxBuf.fill(0);
    }
}

module.exports = {
    E2EE_ENVELOPE_REGEX,
    JOURNAL_SALTED_E2EE_PREFIX,
    JOURNAL_SALTED_PBKDF2_ITERATIONS,
    isServerAutonomousNotesEnabled,
    isWindowsPathString,
    isValidJournalSaltedEnvelope,
    isValidE2eeEnvelope,
    normalizeE2eeKeyBuffer,
    encryptClientE2ee,
    encryptJournalSaltedE2ee,
    decryptJournalSaltedE2ee,
    decryptClientE2ee,
    isValidJournalDownloadPassword,
    encryptJournalSaltedBytesE2ee,
    decryptJournalSaltedBytesE2ee,
    buildSafeRcloneExecEnv,
    runRcloneCommand,
    uploadAndVerifyStudyDocx,
    isValidDocxZipBuffer,
    isValidDocxZipFile,
    writeBufferAtomic,
    resolveLocalJournalPath,
    resolveLocalEnglishPath,
    resolveEnglishDrivePendingMarkerPath,
    readEnglishDrivePendingMarker,
    writeEnglishDrivePendingMarker,
    clearEnglishDrivePendingMarker,
    resolvePythonBinary,
    runDocxWriter,
    computeJournalHeadingForDateIso,
    saveEnglishEntryToCloudAndLocal,
    flushPendingEnglishDriveUpload,
    saveJournalNoteLocalEncrypted,
    inspectJournalDailyCoverage,
    verifyJournalDailyCoverage,
    getLocalJournalStatus,
    exportJournalDocxEncryptedForClient
};

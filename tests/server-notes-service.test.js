const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const serverNotes = require('../lib/server-notes-service');
const serverLoggerMod = require('../lib/server-logger');
const langStudio = require('../lib/language-studio');

const ROOT = path.resolve(__dirname, '..');

function resolvePythonCmd() {
    const candidates = process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python'];
    for (const cmd of candidates) {
        const res = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
        if (!res.error && res.status === 0) return cmd;
    }
    return null;
}

describe('lib/server-notes-service & lib/docx_writer.py (Notas autónomas en Ubuntu Server)', () => {
    it('cifra y descifra sobres E2EE compatibles con frontend.js (AES-256-CBC 32 bytes) y rechaza llaves erróneas', () => {
        const key32 = '1234567890abcdef1234567890abcdef';
        const wrongKey32 = 'abcdef1234567890abcdef1234567890';
        const sample = JSON.stringify({ category: 'vocabulary', word: 'Resilience', spanish: 'Resiliencia' });

        const cipher = serverNotes.encryptClientE2ee(sample, key32);
        assert.strictEqual(serverNotes.isValidE2eeEnvelope(cipher), true);

        const okDec = serverNotes.decryptClientE2ee(cipher, key32);
        assert.strictEqual(okDec.ok, true);
        assert.strictEqual(okDec.plainText, sample);

        const badDec = serverNotes.decryptClientE2ee(cipher, wrongKey32);
        assert.strictEqual(badDec.ok, false);
        assert.strictEqual(badDec.reason, 'E2EE_KEY_MISMATCH');

        assert.strictEqual(serverNotes.isValidE2eeEnvelope('cipher-1'), false);
        assert.strictEqual(serverNotes.decryptClientE2ee('cipher-1', key32).reason, 'NOT_E2EE_ENVELOPE');
    });

    it('resuelve rutas de Journal local y Cuaderno de Idiomas ignorando rutas Windows en Linux y aislando Diario', () => {
        const linuxJournal = serverNotes.resolveLocalJournalPath({
            env: { WORD_FILE_PATH: 'C:\\Users\\flavi\\Desktop\\Diario.docx' },
            platform: 'linux',
            rootDir: '/srv/hub'
        });
        assert.strictEqual(linuxJournal, '/srv/hub/data/journal/Diario.docx');

        const customLinuxJournal = serverNotes.resolveLocalJournalPath({
            env: { JOURNAL_LOCAL_PATH: '/var/lib/hub/Diario.docx' },
            platform: 'linux',
            rootDir: '/srv/hub'
        });
        assert.strictEqual(customLinuxJournal, '/var/lib/hub/Diario.docx');

        const isolatedEnglish = serverNotes.resolveLocalEnglishPath({
            env: {
                JOURNAL_LOCAL_PATH: '/srv/hub/data/journal/Diario.docx',
                ENGLISH_WORD_FILE_PATH: '/srv/hub/data/journal/Diario.docx'
            },
            platform: 'linux',
            rootDir: '/srv/hub'
        });
        assert.strictEqual(isolatedEnglish, '/srv/hub/english-notes/English_Learning_Notebook.docx');
    });

    it('crea, actualiza, fusiona canciones/traducciones y deduplica English_Learning_Notebook.docx vía OOXML sin MS Word', () => {
        const pyCmd = resolvePythonCmd();
        assert.ok(pyCmd, 'Python 3 debe estar disponible para probar lib/docx_writer.py');

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdh-eng-docx-'));
        const docxPath = path.join(tmpDir, 'English_Learning_Notebook.docx');
        try {
            const utf8Env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
            const runWriter = (entry) => spawnSync(
                pyCmd,
                [path.join(ROOT, 'lib', 'docx_writer.py'), '--mode', 'english'],
                { input: JSON.stringify({ docxPath, entry }), encoding: 'utf8', env: utf8Env }
            );

            // 1. Vocabulario
            const r1 = runWriter({
                category: 'vocabulary',
                language: 'English',
                word: 'Ubiquitous',
                part_of_speech: 'adjective',
                spanish: 'Ubicuo / en todas partes',
                example: 'Tailscale makes private access ubiquitous.'
            });
            assert.strictEqual(r1.status, 0, r1.stderr);
            const j1 = JSON.parse(r1.stdout.trim());
            assert.strictEqual(j1.ok, true);
            assert.strictEqual(j1.deduplicated, false);

            // 2. Duplicado de vocabulario omitido
            const rDup = runWriter({
                category: 'vocabulary',
                language: 'English',
                word: 'Ubiquitous',
                part_of_speech: 'adjective',
                spanish: 'Ubicuo / en todas partes'
            });
            assert.strictEqual(rDup.status, 0, rDup.stderr);
            assert.strictEqual(JSON.parse(rDup.stdout.trim()).deduplicated, true);

            // 3. Canción inicial + actualización posterior conservando letra previa y agregando traducción ES
            const rSong1 = runWriter({
                category: 'music',
                language: 'English + Korean',
                song_title: 'FOREVER',
                artists_display: 'BABYMONSTER',
                album_title: 'DRIP',
                album_type: 'Album',
                release_year: '2024',
                track_number: 7,
                lyrics_study: '[EN]\nForever ever never fade'
            });
            assert.strictEqual(rSong1.status, 0, rSong1.stderr);

            const rSong2 = runWriter({
                category: 'music',
                language: 'English + Korean',
                song_title: 'FOREVER',
                artists_display: 'BABYMONSTER',
                album_title: 'DRIP',
                album_type: 'Album',
                release_year: '2024',
                track_number: 7,
                lyrics_study: '=== [ES — Traducción IA] ===\nPor siempre jamás se desvanecerá',
                vocabulary_list: 'fade: desvanecerse'
            });
            assert.strictEqual(rSong2.status, 0, rSong2.stderr);

            const parsed = langStudio.parseStudyNotebookDocxBuffer(fs.readFileSync(docxPath), { includeAllEntries: true });
            assert.strictEqual(parsed.ok, true);
            assert.strictEqual(parsed.counts.vocabulary, 1);
            assert.strictEqual(parsed.counts.music, 1);
            assert.deepStrictEqual(parsed.facets.artists, ['BABYMONSTER']);
            assert.deepStrictEqual(parsed.facets.albums, ['DRIP']);

            const songEntry = langStudio.findNotebookSongEntry(parsed, {
                songTitle: 'FOREVER',
                artistName: 'BABYMONSTER',
                albumTitle: 'DRIP'
            });
            assert.ok(songEntry);
            assert.match(songEntry.lyrics, /Forever ever never fade/);
            assert.match(songEntry.lyrics, /Por siempre jamás se desvanecerá/);
            assert.strictEqual(songEntry.trackNumber, 7);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('calcula encabezados Month DDth D-XXX, agrega entradas al Journal OOXML y evita escribir sin contraseña', () => {
        const pyCmd = resolvePythonCmd();
        assert.ok(pyCmd, 'Python 3 debe estar disponible');

        assert.strictEqual(serverNotes.computeJournalHeadingForDateIso('2026-08-30'), 'August 30th D-500');
        assert.strictEqual(serverNotes.computeJournalHeadingForDateIso('2026-09-01'), 'September 01st D-498');
        assert.strictEqual(serverNotes.computeJournalHeadingForDateIso('2026-11-18'), 'November 18th D-420');

        const pyCheck = spawnSync(
            pyCmd,
            [
                '-c',
                [
                    'import sys, json, zipfile, io, xml.etree.ElementTree as ET',
                    `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'lib'))})`,
                    'import docx_writer as dw',
                    'assert dw.calcular_encabezado("2026-08-30") == "August 30th D-500"',
                    'assert dw.calcular_encabezado("2026-09-01") == "September 01st D-498"',
                    'assert dw.calcular_encabezado("2026-11-18") == "November 18th D-420"',
                    'assert str(dw.parsear_fecha_encabezado_journal("November 18th D-420")) == "2026-11-18"',
                    'assert str(dw.parsear_fecha_encabezado_journal("September 1st D-498")) == "2026-09-01"',
                    'assert dw.parsear_fecha_encabezado_journal("Un párrafo cualquiera de diario") is None',
                    'plain = dw._build_minimal_docx_bytes(mode="journal")',
                    'p1, m1 = dw._append_journal_entry_to_docx_bytes(plain, "Primer pensamiento del día", "2026-11-18")',
                    'assert m1["heading"] == "November 18th D-420" and m1["skipped"] is False',
                    'p2, m2 = dw._append_journal_entry_to_docx_bytes(p1, "Nothing to report.", "2026-11-18")',
                    'assert m2["skipped"] is True',
                    'p3, m3 = dw._append_journal_entry_to_docx_bytes(p1, "Segunda nota del mismo día", "2026-11-18")',
                    'assert m3["skipped"] is False',
                    'with zipfile.ZipFile(io.BytesIO(p3), "r") as zf: xml_txt = zf.read("word/document.xml").decode("utf-8")',
                    'assert xml_txt.count("November 18th D-420") == 1',
                    'assert "Primer pensamiento del día" in xml_txt and "Segunda nota del mismo día" in xml_txt',
                    'no_pwd = dw.write_encrypted_journal_docx("/tmp/ignored.docx", "", "Hola")',
                    'assert no_pwd["ok"] is False and no_pwd["reason"] == "PASSWORD_MISSING"',
                    'print("JOURNAL_OOXML_OK")'
                ].join('\n')
            ],
            { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } }
        );
        assert.strictEqual(pyCheck.status, 0, pyCheck.stderr || pyCheck.stdout);
        assert.match(pyCheck.stdout, /JOURNAL_OOXML_OK/);
    });

    it('verifica continuidad diaria en Journal OOXML, rellena huecos cronológicos, respeta TOC y reemplaza placeholder', () => {
        const pyCmd = resolvePythonCmd();
        assert.ok(pyCmd, 'Python 3 debe estar disponible');

        const pyCheck = spawnSync(
            pyCmd,
            [
                '-c',
                [
                    'import sys, json, zipfile, io, xml.etree.ElementTree as ET',
                    `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'lib'))})`,
                    'import docx_writer as dw',
                    'W_NS = dw.W_NS_URI',
                    '# 1. Crear entrada en 2026-11-15 y luego 2026-11-18 -> debe rellenar 2026-11-16 y 2026-11-17 en orden cronológico',
                    'doc = dw._build_minimal_docx_bytes(mode="journal")',
                    'doc, _ = dw._append_journal_entry_to_docx_bytes(doc, "Secreto privado dia 15", "2026-11-15")',
                    '# Inyectar párrafo TOC1 falso + bookmark _Toc en Heading 1 + encabezado vacío para 2026-11-16',
                    'with zipfile.ZipFile(io.BytesIO(doc), "r") as zin:',
                    '    doc_xml = zin.read("word/document.xml")',
                    '    styles_xml = zin.read("word/styles.xml")',
                    '    other_files = {i.filename: zin.read(i.filename) for i in zin.infolist() if i.filename != "word/document.xml"}',
                    'root = ET.fromstring(doc_xml)',
                    'body = root.find(dw._w_tag("body"))',
                    'toc_p = dw._crear_parrafo_texto(style_id="TOC1", text="November 14th D-424\t3")',
                    'body.insert(1, toc_p)',
                    '# Agregar bookmark _Toc dentro de November 15th D-423 y un heading vacío para November 16th D-422',
                    'for el in list(body):',
                    '    if el.tag == dw._w_tag("p") and "November 15th D-423" in dw._texto_parrafo_ooxml(el):',
                    '        bm = ET.Element(dw._w_tag("bookmarkStart"), {dw._w_tag("id"): "0", dw._w_tag("name"): "_Toc999999"})',
                    '        el.insert(1, bm)',
                    'empty_h16 = dw._crear_parrafo_texto(style_id="Heading1", text="November 16th D-422", font_size=16, bold_all=True)',
                    'body.insert(dw._indice_sectpr(body), empty_h16)',
                    'buf_mod = io.BytesIO()',
                    'with zipfile.ZipFile(buf_mod, "w") as zout:',
                    '    for fn, payload in other_files.items(): zout.writestr(fn, payload)',
                    '    zout.writestr("word/document.xml", dw._serializar_documento(root, doc_xml))',
                    'doc_with_gap = buf_mod.getvalue()',
                    '# Inspect antes de rellenar: debe detectar 2026-11-16 (empty) y 2026-11-17 (missing), ignorando TOC1 (2026-11-14)',
                    'cov_before = dw.inspect_journal_docx_bytes(doc_with_gap, today_date="2026-11-18")',
                    'assert cov_before["missingPastDates"] == ["2026-11-16", "2026-11-17"], cov_before',
                    'assert cov_before["firstDateIso"] == "2026-11-15", cov_before',
                    'assert "Secreto privado" not in json.dumps(cov_before)',
                    '# 2. Escribir 2026-11-18 -> auto-rellena 2026-11-16 y 2026-11-17 con "Nothing to report." en orden cronológico',
                    'doc_filled, meta18 = dw._append_journal_entry_to_docx_bytes(doc_with_gap, "Nota del dia 18", "2026-11-18")',
                    'assert meta18["backfilledDates"] == ["2026-11-16", "2026-11-17"], meta18',
                    'cov_after18 = dw.inspect_journal_docx_bytes(doc_filled, today_date="2026-11-19")',
                    'assert cov_after18["missingPastDates"] == [], cov_after18',
                    'assert cov_after18["allPastDaysFilled"] is True',
                    'assert cov_after18["todayStatus"] == "missing"',
                    '# Verificar orden cronológico exacto en word/document.xml',
                    'with zipfile.ZipFile(io.BytesIO(doc_filled), "r") as zf: xml18 = zf.read("word/document.xml").decode("utf-8")',
                    'pos15 = xml18.index("November 15th D-423")',
                    'pos16 = xml18.index("November 16th D-422")',
                    'pos17 = xml18.index("November 17th D-421")',
                    'pos18 = xml18.index("November 18th D-420")',
                    'assert pos15 < pos16 < pos17 < pos18, (pos15, pos16, pos17, pos18)',
                    'assert xml18.count("Nothing to report.") == 2',
                    '# 3. verify_and_backfill hasta 2026-11-20 rellena 19 y 20 (cuando hoy es 21) y es idempotente',
                    'doc_v, vmeta = dw.verify_and_backfill_journal_docx_bytes(doc_filled, today_date="2026-11-21")',
                    'assert vmeta["modified"] is True and vmeta["filledDates"] == ["2026-11-19", "2026-11-20"], vmeta',
                    'doc_v2, vmeta2 = dw.verify_and_backfill_journal_docx_bytes(doc_v, today_date="2026-11-21")',
                    'assert vmeta2["modified"] is False and vmeta2["filledDates"] == [], vmeta2',
                    '# 4. Si luego se escribe una nota real en un día marcado "Nothing to report." (2026-11-19), reemplaza el placeholder',
                    'doc_rep, rmeta = dw._append_journal_entry_to_docx_bytes(doc_v2, "Recordé algo del día 19", "2026-11-19", backfill_missing_before=False)',
                    'assert rmeta["replacedPlaceholder"] is True, rmeta',
                    'cov_rep = dw.inspect_journal_docx_bytes(doc_rep, today_date="2026-11-21")',
                    'st19 = next(d for d in cov_rep["recentDays"] if d["dateIso"] == "2026-11-19")',
                    'assert st19["status"] == "filled", st19',
                    'print("JOURNAL_CONTINUITY_OK")'
                ].join('\n')
            ],
            { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } }
        );
        assert.strictEqual(pyCheck.status, 0, pyCheck.stderr || pyCheck.stdout);
        assert.match(pyCheck.stdout, /JOURNAL_CONTINUITY_OK/);
    });

    it('sincroniza English_Learning_Notebook.docx directo con Google Drive vía rclone mockeado y detecta reintentos', async () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdh-cloud-sync-'));
        const fakeConf = path.join(tmpRoot, 'rclone.conf');
        fs.writeFileSync(fakeConf, '[gdrive_study]\ntype = drive\n');

        let uploadedBuf = null;
        let failUpload = false;
        const fakeExecFile = (bin, args, _opts, cb) => {
            if (bin !== 'rclone') {
                return require('node:child_process').execFile(bin, args, _opts, cb);
            }
            // args: ['--config', conf, cmd, ...]
            const subCmd = args[2];
            if (subCmd === 'lsjson') {
                if (uploadedBuf) {
                    return cb(null, JSON.stringify([{ Size: uploadedBuf.length, ModTime: '2026-11-18T12:00:00Z' }]), '');
                }
                return cb(null, '[]', '');
            }
            if (subCmd === 'copyto') {
                const src = args[args.length - 2];
                const dst = args[args.length - 1];
                if (String(src).startsWith('gdrive_study:')) {
                    if (!uploadedBuf) return cb(new Error('not found'), '', 'not found');
                    fs.writeFileSync(dst, uploadedBuf);
                    return cb(null, '', '');
                }
                if (failUpload) {
                    return cb(new Error('network timeout'), '', 'network timeout');
                }
                uploadedBuf = fs.readFileSync(src);
                return cb(null, '', '');
            }
            return cb(new Error(`Unexpected rclone cmd: ${subCmd}`), '', '');
        };

        let cachedParsed = null;
        try {
            const resOk = await serverNotes.saveEnglishEntryToCloudAndLocal({
                entry: {
                    category: 'grammar',
                    language: 'English',
                    title: 'Present Perfect vs Past Simple',
                    notes: 'Use Present Perfect when the timeframe is unfinished.'
                },
                resolveRcloneFn: () => ({ confPath: fakeConf, cleanup: false, usingStudyConfig: true }),
                resolveStudyTargetFn: () => ({ remoteTarget: 'gdrive_study:NotasIdiomas/English_Learning_Notebook.docx' }),
                updateCacheFn: (buf, source) => {
                    cachedParsed = langStudio.parseStudyNotebookDocxBuffer(buf, { includeAllEntries: true });
                    cachedParsed.source = source;
                },
                rootDir: tmpRoot,
                execFileFn: fakeExecFile
            });

            assert.strictEqual(resOk.ok, true);
            assert.strictEqual(resOk.mode, 'cloud_drive');
            assert.strictEqual(resOk.uploaded, true);
            assert.strictEqual(resOk.verified, true);
            assert.ok(Buffer.isBuffer(uploadedBuf) && uploadedBuf.length > 500);
            assert.strictEqual(cachedParsed?.ok, true);
            assert.strictEqual(cachedParsed?.source, 'drive-word');
            assert.strictEqual(cachedParsed?.counts?.grammar, 1);

            // Simular fallo temporal de Drive -> conserva caché local y marca needsRetry
            failUpload = true;
            const resRetry = await serverNotes.saveEnglishEntryToCloudAndLocal({
                entry: {
                    category: 'phrasal_verb',
                    language: 'English',
                    verb: 'Look forward to',
                    meaning_es: 'Esperar con ilusión'
                },
                resolveRcloneFn: () => ({ confPath: fakeConf, cleanup: false, usingStudyConfig: true }),
                resolveStudyTargetFn: () => ({ remoteTarget: 'gdrive_study:NotasIdiomas/English_Learning_Notebook.docx' }),
                updateCacheFn: (buf) => {
                    cachedParsed = langStudio.parseStudyNotebookDocxBuffer(buf, { includeAllEntries: true });
                },
                rootDir: tmpRoot,
                execFileFn: fakeExecFile
            });

            assert.strictEqual(resRetry.ok, true);
            assert.strictEqual(resRetry.mode, 'local_cache_pending_drive');
            assert.strictEqual(resRetry.needsRetry, true);
            assert.strictEqual(cachedParsed?.counts?.grammar, 1);
            assert.strictEqual(cachedParsed?.counts?.phrasal_verb, 1);
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });

    it('genera logs rotativos del sistema en server.log y error.log, redacta secretos y respeta exclusión de Git', () => {
        const tmpLogs = fs.mkdtempSync(path.join(os.tmpdir(), 'pdh-sys-logs-'));
        try {
            assert.strictEqual(serverLoggerMod.isAutomatedTestEnv(), true);
            assert.strictEqual(
                serverLoggerMod.sanitizeUrlForLog('/api/planner/phone-location?token=secret123&mode=gps'),
                '/api/planner/phone-location?token=%5BREDACTED%5D&mode=gps'
            );

            const capturedOut = [];
            const capturedErr = [];
            const logger = serverLoggerMod.createServerLogger({
                logDir: tmpLogs,
                level: 'info',
                maxBytes: 64 * 1024,
                maxFiles: 3,
                enableFileLogging: true,
                stdoutWrite: (ln) => capturedOut.push(ln),
                stderrWrite: (ln) => capturedErr.push(ln)
            });

            logger.info('SYSTEM', 'Servidor iniciado', { port: 3000 });
            logger.warn('YTDLP', 'Sin subtítulos disponibles', { songId: 7 });
            logger.error('HTTP', 'GET /api/test?token=mySecretToken -> 500', { ms: '12.4' });

            assert.strictEqual(capturedOut.length, 1);
            assert.strictEqual(capturedErr.length, 2);
            assert.strictEqual(fs.existsSync(logger.serverLogPath), true);
            assert.strictEqual(fs.existsSync(logger.errorLogPath), true);

            const srvText = fs.readFileSync(logger.serverLogPath, 'utf8');
            const errText = fs.readFileSync(logger.errorLogPath, 'utf8');
            assert.match(srvText, /\[SYSTEM\] Servidor iniciado \| port=3000/);
            assert.match(srvText, /\[YTDLP\]/);
            assert.equal(srvText.includes('mySecretToken'), false, 'No debe filtrar tokens en logs');
            assert.match(errText, /\[WARN\] \[YTDLP\]/);
            assert.match(errText, /\[ERROR\] \[HTTP\]/);
            assert.equal(errText.includes('[SYSTEM]'), false, 'error.log solo debe incluir WARN/ERROR/CRASH');

            // Verificar redacción estricta de llaves Google/Tailscale/GitHub, PEM y variables .env en logs
            const leakedSample = [
                'GEMINI=AIzaSyDummyGoogleKey1234567890abcdef',
                'TS=tskey-auth-kSecretTailscaleKey999',
                'GH=ghp_1234567890abcdefghijklmnopqr',
                'WORD_PASSWORD=miClaveSuperSecreta',
                'DB_PASS=mysqlRootPass99',
                'RCLONE_CONF_B64=dG9rZW49c2VjcmV0bw==',
                '-----BEGIN OPENSSH PRIVATE KEY-----\nabc123\n-----END OPENSSH PRIVATE KEY-----'
            ].join(' ');
            const sanitized = serverLoggerMod.sanitizeMessageText(leakedSample);
            assert.equal(/DummyGoogleKey|kSecretTailscaleKey|abcdefghijklmnopqr|miClaveSuperSecreta|mysqlRootPass99|dG9rZW49c2VjcmV0bw|abc123/.test(sanitized), false);
            assert.match(sanitized, /\[REDACTED_GOOGLE_KEY\]/);
            assert.match(sanitized, /\[REDACTED_TS_KEY\]/);
            assert.match(sanitized, /\[REDACTED_GH_TOKEN\]/);
            assert.match(sanitized, /\[REDACTED_PRIVATE_KEY\]/);

            const tail = logger.getRecentLogTail({ kind: 'server', lines: 2 });
            assert.strictEqual(tail.ok, true);
            assert.strictEqual(tail.lines.length, 2);

            // Verificar que git ignore logs/, *.log y *.log.1
            const gitChk = spawnSync('git', ['check-ignore', '-q', '--no-index', 'logs/server.log', 'logs/server.log.1', 'server.log.2'], {
                cwd: ROOT,
                encoding: 'utf8'
            });
            if (!gitChk.error && gitChk.status !== 128) {
                assert.strictEqual(gitChk.status, 0, 'logs/, server.log y archivos rotados *.log.* deben ser ignorados por Git');
            }
        } finally {
            fs.rmSync(tmpLogs, { recursive: true, force: true });
        }
    });

    it('divide automáticamente entradas del cuaderno por idioma y soporta Sección 6 (Alfabetos y Composición)', async () => {
        const pyCmd = resolvePythonCmd();
        assert.ok(pyCmd, 'Python debe estar disponible para probar docx_writer.py');

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdh-lang-apt-'));
        try {
            const docxPath = path.join(tmpDir, 'Study_Languages.docx');
            const utf8Env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
            const runWriter = (entry) => spawnSync(
                pyCmd,
                [path.join(ROOT, 'lib', 'docx_writer.py'), '--mode', 'english'],
                { input: JSON.stringify({ docxPath, entry }), encoding: 'utf8', env: utf8Env }
            );

            // Enviar frase puramente en coreano aunque venga etiquetada erróneamente como English
            const r1 = runWriter({
                category: 'vocabulary',
                language: '🇺🇸 English',
                word: '그를 볼 때마다 가슴이 뛰어',
                spanish: 'Cada vez que lo veo, mi corazón late fuerte',
                notes: 'Expresión emocional en coreano'
            });
            assert.strictEqual(r1.status, 0, r1.stderr || r1.stdout);
            const j1 = JSON.parse(r1.stdout.trim());
            assert.strictEqual(j1.ok, true);
            assert.strictEqual(j1.languageCode, 'ko');

            const r2 = runWriter({
                category: 'vocabulary',
                language: '🎵 K-Pop (EN + 한국어)',
                word: 'Resilience',
                spanish: 'Resiliencia',
                example: 'She showed great resilience.'
            });
            assert.strictEqual(r2.status, 0, r2.stderr || r2.stdout);
            const j2 = JSON.parse(r2.stdout.trim());
            assert.strictEqual(j2.ok, true);
            assert.strictEqual(j2.languageCode, 'en');

            const r3 = runWriter({
                category: 'alphabet',
                language: '🇰🇷 Korean (한국어)',
                language_code: 'ko',
                title: 'Alfabeto Coreano Hangul (자모)',
                alphabet_overview: 'Consonantes y vocales combinadas en bloques.',
                symbols_table: 'ㅏ [a], ㅓ [eo], ㄱ [g/k], ㄴ [n]',
                composition_rules: 'Consonante + Vocal + Batchim opcional (한).',
                example: '한글 [han-geul]'
            });
            assert.strictEqual(r3.status, 0, r3.stderr || r3.stdout);
            const j3 = JSON.parse(r3.stdout.trim());
            assert.strictEqual(j3.ok, true);
            assert.strictEqual(j3.languageCode, 'ko');

            const docxBuf = fs.readFileSync(docxPath);
            const parsedAll = await langStudio.parseStudyNotebookDocxBuffer(docxBuf, { section: 'all', limit: 50, includeAllEntries: true });
            assert.strictEqual(parsedAll.ok, true);
            assert.strictEqual(parsedAll.counts.vocabulary, 2);
            assert.strictEqual(parsedAll.counts.alphabet, 1);
            assert.strictEqual(parsedAll.countsByLanguage.ko, 2);
            assert.strictEqual(parsedAll.countsByLanguage.en, 1);

            const onlyKo = langStudio.filterStudyNotebookData(parsedAll, { language: 'ko' });
            assert.strictEqual(onlyKo.entries.length, 2);
            assert.ok(onlyKo.entries.every((e) => e.languageCode === 'ko'));
            assert.ok(onlyKo.entries.some((e) => e.heading.includes('그를 볼 때마다')));
            assert.ok(onlyKo.entries.some((e) => e.section === 'alphabet'));

            const onlyEn = langStudio.filterStudyNotebookData(parsedAll, { language: 'en' });
            assert.strictEqual(onlyEn.entries.length, 1);
            assert.ok(onlyEn.entries[0].heading.includes('Resilience'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('genera guías de alfabeto y reglas de composición en offline y con Gemini simulado', async () => {
        const offlineKo = await langStudio.generateAlphabetGuideWithAi({
            language: 'ko',
            mode: 'offline',
            uiLang: 'es'
        });
        assert.strictEqual(offlineKo.ok, true);
        assert.strictEqual(offlineKo.languageCode, 'ko');
        assert.ok(Array.isArray(offlineKo.symbols) && offlineKo.symbols.length >= 6);
        assert.ok(Array.isArray(offlineKo.compositionRules) && offlineKo.compositionRules.length >= 4);
        assert.ok(offlineKo.symbols[0].sound);
        assert.strictEqual(offlineKo.wordPayloads.alphabetEntry.category, 'alphabet');
        assert.strictEqual(offlineKo.wordPayloads.alphabetEntry.language_code, 'ko');
        assert.strictEqual(offlineKo.wordPayloads.notesEntry.category, 'notes');
        assert.strictEqual(offlineKo.wordPayloads.notesEntry.language_code, 'ko');

        const geminiMockPayload = {
            candidates: [{
                content: {
                    parts: [{
                        text: JSON.stringify({
                            aiAnswer: 'El alfabeto inglés combina vocales cortas/largas y dígrafos.',
                            extraSymbols: [{ symbol: 'th', name: 'Dígrafo TH', sound: 'θ / ð', formation: 't + h', example: 'think / this' }],
                            extraRules: [{ rule: 'Silent E alarga la vocal', pattern: 'CVCe', explanation: 'La e muda alarga la vocal previa: cap -> cape.', examples: 'cap -> cape' }],
                            soundTips: ['Distingue short i (ship) de long ee (sheep).'],
                            practiceExercises: [{ prompt: 'Lee en voz alta cap vs cape', answer: 'cap [kæp] / cape [keɪp]' }]
                        })
                    }]
                }
            }]
        };
        const aiEn = await langStudio.generateAlphabetGuideWithAi({
            apiKey: 'AIzaSyMockKey1234567890123456789012345',
            model: 'gemini-2.5-flash',
            language: 'en',
            mode: 'gemini',
            customFocus: 'Silent E',
            fetchImpl: async () => ({
                ok: true,
                status: 200,
                json: async () => geminiMockPayload,
                text: async () => JSON.stringify(geminiMockPayload)
            })
        });
        assert.strictEqual(aiEn.ok, true);
        assert.strictEqual(aiEn.usedGemini, true);
        assert.strictEqual(aiEn.languageCode, 'en');
        assert.match(aiEn.aiAnswer, /dígrafos/);
        assert.ok(aiEn.compositionRules.some((r) => String(r.rule || '').includes('Silent E')));
    });

    it('aplica reglas Google Translate: inglés siempre a español y KO/JP solo a inglés o español según idioma del sistema', () => {
        assert.strictEqual(langStudio.resolveGoogleStyleTranslationDirection('사랑해', 'auto', 'es'), 'ko_es');
        assert.strictEqual(langStudio.resolveGoogleStyleTranslationDirection('사랑해', 'auto', 'en'), 'ko_en');
        assert.strictEqual(langStudio.resolveGoogleStyleTranslationDirection('ありがとう', 'auto', 'es'), 'ja_es');
        assert.strictEqual(langStudio.resolveGoogleStyleTranslationDirection('ありがとう', 'auto', 'en'), 'ja_en');
        assert.strictEqual(langStudio.resolveGoogleStyleTranslationDirection('hold on', 'auto', 'es'), 'en_es');
        assert.strictEqual(langStudio.resolveGoogleStyleTranslationDirection('hold on', 'auto', 'en'), 'en_es');

        const koEs = langStudio.translateOffline({ text: '사랑해', direction: 'auto', uiLang: 'es' });
        assert.strictEqual(koEs.direction, 'ko_es');
        assert.match(koEs.translatedText, /Te amo|Te quiero/i);

        const koEn = langStudio.translateOffline({ text: '사랑해', direction: 'auto', uiLang: 'en' });
        assert.strictEqual(koEn.direction, 'ko_en');
        assert.match(koEn.translatedText, /I love you/i);

        const enAlwaysEs = langStudio.translateOffline({ text: 'hold on', direction: 'auto', uiLang: 'en' });
        assert.strictEqual(enAlwaysEs.direction, 'en_es');
        assert.match(enAlwaysEs.translatedText, /esperar|resistir/i);
    });

    it('formatea Word (.docx) con English/Spanish sin [EN]/[ES], salto de línea, indentación, sin duplicados e índice TOC reparado para todas las canciones', () => {
        const pyCmd = resolvePythonCmd();
        assert.ok(pyCmd, 'Python 3 debe estar disponible');

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdh-docx-format-toc-'));
        const docxPath = path.join(tmpDir, 'English_Learning_Notebook.docx');
        try {
            const utf8Env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
            const pyCheck = spawnSync(
                pyCmd,
                [
                    '-c',
                    [
                        'import io, json, sys, zipfile, xml.etree.ElementTree as ET',
                        `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'lib'))})`,
                        'import docx_writer as dw',
                        'docx_path = sys.argv[1]',
                        '# Crear un Word heredado donde BABYMONS7ER y BATTER UP perdieron estilos Heading2/3 y falta Heading3 en styles.xml',
                        'W = dw.W_NS_URI',
                        'legacy_styles = f\'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="{W}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>\'',
                        'legacy_doc = (',
                        '  f\'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="{W}"><w:body>\'',
                        '  \'<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>4. Songs &amp; Music Study</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>BABYMONS7ER (Album, 2024)</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>BATTER UP — BABYMONSTER</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:r><w:t>Song: BATTER UP</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:r><w:t>Artists / Collabs: BABYMONSTER</w:t></w:r></w:p>\'',
                        '  \'<w:sectPr/></w:body></w:document>\'',
                        ')',
                        'buf = io.BytesIO()',
                        'with zipfile.ZipFile(buf, "w") as zout:',
                        '    zout.writestr("[Content_Types].xml", \'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>\')',
                        '    zout.writestr("word/styles.xml", legacy_styles)',
                        '    zout.writestr("word/document.xml", legacy_doc)',
                        '# Insertar nueva canción con [ORIGINAL], [KO], [EN], === [ES — Traducción IA] === y versos repetidos',
                        'out_bytes, meta = dw.update_english_docx_bytes(buf.getvalue(), {',
                        '    "category": "music",',
                        '    "language": "English + Korean",',
                        '    "song_title": "DRIP",',
                        '    "artists_display": "BABYMONSTER",',
                        '    "album_title": "Drip",',
                        '    "album_type": "Album",',
                        '    "release_year": "2024",',
                        '    "track_number": 2,',
                        '    "lyrics_study": "[ORIGINAL]\\nBaby got no chill\\n소릴 높여\\n\\n[KO]\\n소릴 높여\\n\\n[EN]\\nI\'m on a mission\\n\\nI\'m on a mission\\n\\n=== [ES — Traducción IA] ===\\nEstoy en una misión"',
                        '})',
                        'with open(docx_path, "wb") as fh: fh.write(out_bytes)',
                        'with zipfile.ZipFile(docx_path, "r") as zin:',
                        '    doc_xml = zin.read("word/document.xml").decode("utf-8")',
                        '    styles_xml = zin.read("word/styles.xml").decode("utf-8")',
                        'root = ET.fromstring(doc_xml)',
                        'paras = [dw._texto_parrafo_ooxml(p) for p in root.findall(f".//{{{W}}}p")]',
                        'joined = "\\n".join(paras)',
                        'assert "[ORIGINAL]" not in doc_xml and "[EN]" not in doc_xml and "[KO]" not in doc_xml and "[ES" not in doc_xml, "No raw bracketed language codes allowed"',
                        'assert "Lyrics & Meaning Breakdown: [ORIGINAL]" not in joined',
                        'idx_lbl = paras.index("Lyrics & Meaning Breakdown:")',
                        'assert paras[idx_lbl + 1] == "Original", paras[idx_lbl:idx_lbl+6]',
                        'assert "Korean" in paras and "English" in paras and "Spanish — Traducción IA" in paras, paras',
                        '# Verificar salto de línea antes de English/Spanish y sangría en versos',
                        'idx_en = paras.index("English")',
                        'assert paras[idx_en - 1] == "", paras[idx_en-2:idx_en+2]',
                        'assert paras.count("I\'m on a mission") == 1, "Duplicate consecutive verse must be removed"',
                        'assert \'w:ind w:left="480"\' in doc_xml, "Verses must be indented"',
                        'assert "Heading3" in styles_xml and "TOC3" in styles_xml',
                        '# Verificar que BOTH BABYMONS7ER + BATTER UP y Drip + DRIP están en la TOC',
                        'hyperlinks = ["".join(t.text or "" for t in h.iter(f"{{{W}}}t")) for h in root.findall(f".//{{{W}}}hyperlink")]',
                        'hl_str = " | ".join(hyperlinks)',
                        'assert "BABYMONS7ER (Album, 2024)" in hl_str, hl_str',
                        'assert "BATTER UP — BABYMONSTER" in hl_str, hl_str',
                        'assert "Drip (Album, 2024)" in hl_str, hl_str',
                        'assert "02. DRIP — BABYMONSTER" in hl_str, hl_str',
                    ].join('\n'),
                    docxPath
                ],
                { encoding: 'utf8', env: utf8Env }
            );
            assert.strictEqual(pyCheck.status, 0, pyCheck.stderr || pyCheck.stdout);

            const parsed = langStudio.parseStudyNotebookDocxBuffer(fs.readFileSync(docxPath), { includeAllEntries: true });
            assert.strictEqual(parsed.ok, true);
            assert.strictEqual(parsed.counts.music, 2);
            const drip = parsed.allEntries.find((e) => e.song === 'DRIP');
            assert.ok(drip && drip.fields && drip.fields.lyrics_study);
            assert.ok(drip.fields.lyrics_study.includes('English\n'));
            assert.ok(drip.fields.lyrics_study.includes('Spanish — Traducción IA\n'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('expone notas solo vista de Korean Practice (Drive), comparador sin guardar y blindaje de arranque PC', () => {
        const langStudio = require('../lib/language-studio');
        assert.strictEqual(langStudio.KOREAN_PRACTICE_DRIVE_FOLDER_ID, '1ehP4g7brBR7dnGNiN7zfiUQLEdZdTeuE');
        assert.ok(langStudio.KOREAN_PRACTICE_DRIVE_URL.includes('1ehP4g7brBR7dnGNiN7zfiUQLEdZdTeuE'));
        assert.strictEqual(langStudio.KOREAN_PRACTICE_DRIVE_NOTES.basicVowels.length, 10);
        assert.strictEqual(langStudio.KOREAN_PRACTICE_DRIVE_NOTES.compoundVowels.length, 11);
        assert.strictEqual(langStudio.KOREAN_PRACTICE_DRIVE_NOTES.basicConsonants.length, 14);
        assert.strictEqual(langStudio.KOREAN_PRACTICE_DRIVE_NOTES.doubleConsonants.length, 5);
        assert.strictEqual(langStudio.KOREAN_PRACTICE_DRIVE_NOTES.formationRules.length, 4);
        assert.strictEqual(langStudio.KOREAN_PRACTICE_DRIVE_NOTES.practicalExamples.length, 4);

        const cmpVowels = langStudio.compareAndAnalyzeKoreanSymbols('ㅓ', 'ㅗ');
        assert.strictEqual(cmpVowels.saved, false);
        assert.strictEqual(cmpVowels.readOnly, true);
        assert.strictEqual(cmpVowels.primary.items[0].romanization, 'eo');
        assert.strictEqual(cmpVowels.secondary.items[0].romanization, 'o');
        assert.ok(cmpVowels.comparisonSummary.includes('ㅓ') && cmpVowels.comparisonSummary.includes('ㅗ'));

        const cmpWord = langStudio.compareAndAnalyzeKoreanSymbols('한국어', '');
        assert.strictEqual(cmpWord.saved, false);
        assert.strictEqual(cmpWord.primary.items.length, 3);
        assert.ok(cmpWord.primary.phonologicalNotes.some((n) => /연음|Enlace sonoro/i.test(n)));
        assert.strictEqual(cmpWord.primary.romanization, 'hangugeo');

        const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
        const styleCss = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
        const frontendJs = fs.readFileSync(path.join(ROOT, 'public', 'frontend.js'), 'utf8');
        const transportJs = fs.readFileSync(path.join(ROOT, 'public', 'transport-crypto.js'), 'utf8');
        const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

        assert.ok(indexHtml.includes('id="englishKoreanReadonlyNotesStudio"'));
        assert.ok(indexHtml.includes('id="englishKoreanComparatorStudio"'));
        assert.ok(indexHtml.includes('class="auth-top-actions"'));
        assert.ok(styleCss.includes('.auth-top-actions') && styleCss.includes('white-space: nowrap'));
        assert.ok(transportJs.includes('AbortController') && transportJs.includes('clearTimeout(timer)'));
        assert.ok(frontendJs.includes('bootFailsafeTimer') && /finally\s*\{\s*hideBootScreen\(\);/.test(frontendJs));
        assert.ok(serverJs.includes('/api/language/korean-practice-drive') && serverJs.includes('/api/language/korean-symbol-compare'));
    });

    it('arranca frontend.js sin errores TDZ ni bloqueo de appBootScreen en navegador simulado', async () => {
        const vm = require('node:vm');
        const crypto = require('node:crypto');
        const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
        const elementsById = new Map();
        const makeEl = (id = '', tag = 'DIV') => ({
            id,
            tagName: tag,
            hidden: false,
            value: '',
            textContent: '',
            innerHTML: '',
            style: { setProperty() {}, removeProperty() {} },
            dataset: {},
            classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
            addEventListener() {},
            removeEventListener() {},
            setAttribute() {},
            getAttribute() { return ''; },
            removeAttribute() {},
            appendChild() {},
            append() {},
            prepend() {},
            replaceChildren() {},
            remove() {},
            querySelector() { return null; },
            querySelectorAll() { return []; },
            closest() { return null; },
            matches() { return false; },
            focus() {},
            click() {},
            dispatchEvent() {}
        });
        for (const m of indexHtml.matchAll(/\bid=(?:"([^"]+)"|'([^']+)')/g)) {
            const id = m[1] || m[2];
            elementsById.set(id, makeEl(id));
        }
        const doc = {
            readyState: 'complete',
            body: makeEl('body', 'BODY'),
            documentElement: makeEl('html', 'HTML'),
            getElementById(id) { return elementsById.get(id) || null; },
            querySelector(sel) {
                const m = String(sel || '').match(/#([a-zA-Z0-9_-]+)/);
                if (m && elementsById.has(m[1])) return elementsById.get(m[1]);
                return makeEl(sel);
            },
            querySelectorAll() { return []; },
            createElement(tag) { return makeEl('', String(tag || 'DIV').toUpperCase()); },
            createDocumentFragment() { return makeEl('', 'FRAGMENT'); },
            createTextNode(t) { return { textContent: t }; },
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent() {}
        };
        const fetchCalls = [];
        const win = {
            document: doc,
            window: null,
            globalThis: null,
            addEventListener() {},
            removeEventListener() {},
            location: { search: '', hash: '', pathname: '/', href: 'https://example.ts.net/' },
            history: { replaceState() {}, pushState() {} },
            localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
            sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
            navigator: { userAgent: 'Mozilla/5.0', clipboard: { writeText: async () => {} } },
            crypto: crypto.webcrypto,
            fetch: async (url) => {
                fetchCalls.push(String(url));
                if (String(url).startsWith('/api/language/korean-practice-drive')) {
                    return { ok: true, status: 200, headers: { get() { return null; } }, json: async () => ({ ok: true, notes: { title: 'Test', intro: '', vowelsIntro: '', basicVowels: [], compoundVowels: [], consonantsIntro: '', basicConsonants: [], doubleConsonants: [], formationIntro: '', formationRules: [], practicalExamples: [] } }), text: async () => '{}' };
                }
                if (String(url).startsWith('/api/language/korean-symbol-compare')) {
                    return { ok: true, status: 200, headers: { get() { return null; } }, json: async () => ({ ok: true, analysis: { primary: { input: '' } } }), text: async () => '{}' };
                }
                if (String(url).startsWith('/api/get-') || String(url).startsWith('/api/language/')) {
                    return { ok: true, status: 200, headers: { get() { return null; } }, json: async () => ([]), text: async () => '[]' };
                }
                return { ok: false, status: 401, headers: { get() { return null; } }, json: async () => ({}), text: async () => '' };
            },
            Headers,
            Response,
            Request,
            URL,
            URLSearchParams,
            AbortController,
            BroadcastChannel: function BroadcastChannel() { this.postMessage = () => {}; this.close = () => {}; },
            MutationObserver: function MutationObserver() { this.observe = () => {}; this.disconnect = () => {}; },
            IntersectionObserver: function IntersectionObserver() { this.observe = () => {}; this.disconnect = () => {}; },
            CustomEvent: function CustomEvent(t, o) { this.type = t; this.detail = o && o.detail; },
            Event: function Event(t) { this.type = t; },
            NodeFilter: { SHOW_TEXT: 4 },
            matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
            setTimeout: () => 1,
            clearTimeout() {},
            setInterval: () => 1,
            clearInterval() {},
            requestAnimationFrame() {},
            scrollTo() {},
            console
        };
        win.window = win;
        win.globalThis = win;
        const ctx = vm.createContext(win);

        for (const rel of [
            'public/vendor/crypto-js.min.js',
            'public/transport-crypto.js',
            'public/i18n.js',
            'public/guia-visual.js',
            'public/translator-widget.js',
            'public/frontend.js'
        ]) {
            vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), ctx, { filename: rel });
        }

        // Esperar microtasks del fetch('/api/auth/me')
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        assert.strictEqual(elementsById.get('appBootScreen').hidden, true, 'El loader Checking session... debe ocultarse tras /api/auth/me 401');
        assert.strictEqual(elementsById.get('authOverlay').hidden, false, 'La pantalla de login debe mostrarse cuando /api/auth/me responde 401');
        assert.strictEqual(
            fetchCalls.some((u) => u.startsWith('/api/language/korean-') || u.startsWith('/api/language/alphabet-guide')),
            false,
            'No debe disparar fetches autenticados de estudio antes del login'
        );

        ctx.enterAppSession({ id: 1, nombre: 'Flavio', email: 'flavio@example.com', rol: 'admin', expira_en: '2026-11-29T00:00:00Z' });
        assert.strictEqual(elementsById.get('appBootScreen').hidden, true);
        assert.strictEqual(elementsById.get('appShell').hidden, false);

        for (const cat of ['vocabulary', 'grammar', 'phrasal_verb', 'notes', 'hangul_practice', 'korean_readonly_notes', 'korean_comparator', 'alphabet', 'music']) {
            ctx.__switchEnglishStudioTab(cat);
        }
        for (let t = 0; t < 8; t++) {
            await new Promise((r) => setImmediate(r));
        }
        assert.ok(fetchCalls.some((u) => u.startsWith('/api/language/korean-practice-drive')), `fetchCalls=${JSON.stringify(fetchCalls)}`);
        assert.ok(fetchCalls.some((u) => u.startsWith('/api/language/korean-symbol-compare')), `fetchCalls=${JSON.stringify(fetchCalls)}`);
    });

    it('mantiene 1 sola TOC tras 5+ guardados, auto-sana TOCs corruptas (repair-english / update) y endurece lectura en language-studio.js', () => {
        const pyCmd = resolvePythonCmd();
        assert.ok(pyCmd, 'Python 3 debe estar disponible para probar lib/docx_writer.py');

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdh-toc-selfheal-'));
        const docxPath = path.join(tmpDir, 'English_Learning_Notebook.docx');
        const corruptPath = path.join(tmpDir, 'Corrupt_English_Learning_Notebook.docx');
        try {
            const utf8Env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
            const runWriter = (entry, targetPath = docxPath) => spawnSync(
                pyCmd,
                [path.join(ROOT, 'lib', 'docx_writer.py'), '--mode', 'english'],
                { input: JSON.stringify({ docxPath: targetPath, entry }), encoding: 'utf8', env: utf8Env }
            );

            // 1) Guardar 6 entradas consecutivas (vocabulario, gramática, phrasal verb, nota y 2 canciones)
            const entries = [
                { category: 'vocabulary', language: 'English', word: 'resilient', part_of_speech: 'adjective', spanish: 'resiliente', example: 'Stay resilient.' },
                { category: 'vocabulary', language: 'English', word: 'eloquent', part_of_speech: 'adjective', spanish: 'elocuente', example: 'An eloquent speech.' },
                { category: 'grammar', language: 'English', title: 'Third Conditional', notes: 'If + past perfect, would have + past participle.' },
                { category: 'phrasal_verb', language: 'English', verb: 'figure out', meaning_es: 'descifrar / resolver' },
                { category: 'notes', language: 'English', title: 'Listening Tip', notes: 'Shadow native audio daily.' },
                { category: 'music', language: 'English', song_title: 'Midnight Rain', artists_display: 'Taylor Swift', album_title: 'Midnights', album_type: 'Album', release_year: '2022', track_number: 6, lyrics_study: '[EN]\nHe wanted it comfortable' },
                { category: 'music', language: 'English', song_title: 'Anti-Hero', artists_display: 'Taylor Swift', album_title: 'Midnights', album_type: 'Album', release_year: '2022', track_number: 3, lyrics_study: '[EN]\nIt is me, hi' }
            ];
            for (const entry of entries) {
                const res = runWriter(entry);
                assert.strictEqual(res.status, 0, res.stderr || res.stdout);
                const parsedRes = JSON.parse(res.stdout.trim());
                assert.strictEqual(parsedRes.ok, true);
            }

            // Verificar que después de 7 guardados solo existe 1 TOC exacta y sin campos abiertos/duplicados
            const pyVerify = spawnSync(
                pyCmd,
                [
                    '-c',
                    [
                        'import io, json, sys, zipfile, xml.etree.ElementTree as ET',
                        `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'lib'))})`,
                        'import docx_writer as dw',
                        'docx_path, corrupt_path = sys.argv[1], sys.argv[2]',
                        'W = dw.W_NS_URI',
                        'w_tag = dw._w_tag',
                        'with open(docx_path, "rb") as fh: clean_bytes = fh.read()',
                        'def inspect_doc(b):',
                        '    with zipfile.ZipFile(io.BytesIO(b), "r") as zf:',
                        '        st = dw._ooxml_cargar_estilos_mapa(zf)',
                        '        root = ET.fromstring(zf.read("word/document.xml"))',
                        '    body = root.find(w_tag("body"))',
                        '    headings, toc_paras, toc_links, toc_titles, toc_instrs, broken = [], [], [], 0, 0, []',
                        '    depth, in_toc, closed_toc, orphan_ends = 0, False, 0, 0',
                        '    for ch in list(body):',
                        '        if ch.tag != w_tag("p"): continue',
                        '        txt = dw._texto_parrafo_ooxml(ch)',
                        '        if txt.strip().lower() in ("table of contents", "tabla de contenido"): toc_titles += 1',
                        '        ppr = ch.find(w_tag("pPr"))',
                        '        sid = ppr.find(w_tag("pStyle")).attrib.get(w_tag("val"), "") if ppr is not None and ppr.find(w_tag("pStyle")) is not None else ""',
                        '        if sid.upper().startswith("TOC"): toc_paras.append(txt)',
                        '        if "content not found" in txt.lower() or "bookmark=id" in txt.lower(): broken.append(txt)',
                        '        for hl in ch.iter(w_tag("hyperlink")):',
                        '            anc = hl.attrib.get(w_tag("anchor"), "")',
                        '            if "bookmark=id" in anc.lower(): broken.append(anc)',
                        '            elif anc.startswith("_Toc"): toc_links.append(anc)',
                        '        for el in ch.iter():',
                        '            if el.tag == w_tag("instrText"):',
                        '                up = (el.text or "").upper()',
                        '                if "TOC \\\\O" in up or ("TOC" in up and "PAGEREF" not in up): toc_instrs += 1',
                        '            elif el.tag == w_tag("fldChar"):',
                        '                ft = el.attrib.get(w_tag("fldCharType"), "")',
                        '                if ft == "begin": depth += 1',
                        '                elif ft == "end":',
                        '                    if depth == 0: orphan_ends += 1',
                        '                    else:',
                        '                        depth -= 1',
                        '                        if in_toc and depth == 0: in_toc = False; closed_toc += 1',
                        '            if el.tag == w_tag("instrText") and "TOC" in (el.text or "").upper() and "PAGEREF" not in (el.text or "").upper() and depth == 1: in_toc = True',
                        '        lvl = dw._nivel_parrafo_ooxml(ch, st["levels"])',
                        '        if lvl in (1, 2, 3) and txt: headings.append((lvl, txt))',
                        '    return {"headings": headings, "toc_paras": len(toc_paras), "toc_links": len(toc_links), "toc_titles": toc_titles, "toc_instrs": toc_instrs, "broken": broken, "depth": depth, "closed_toc": closed_toc, "orphan_ends": orphan_ends}',
                        'c_info = inspect_doc(clean_bytes)',
                        'assert c_info["toc_titles"] == 1 and c_info["toc_instrs"] == 1, c_info',
                        'assert c_info["closed_toc"] == 1 and c_info["depth"] == 0 and c_info["orphan_ends"] == 0, c_info',
                        'assert c_info["toc_paras"] == len(c_info["headings"]) == c_info["toc_links"], c_info',
                        '# 2) Construir un .docx corrupto simulando TOC repetida en cascada, PAGEREF huérfanos y enlaces rotos de Google Docs',
                        'with zipfile.ZipFile(io.BytesIO(clean_bytes), "r") as zin:',
                        '    orig_xml = zin.read("word/document.xml")',
                        '    others = {i.filename: zin.read(i.filename) for i in zin.infolist() if i.filename != "word/document.xml"}',
                        'root_m = ET.fromstring(orig_xml)',
                        'body_m = root_m.find(w_tag("body"))',
                        'h1_idx = next(i for i, ch in enumerate(list(body_m)) if ch.tag == w_tag("p") and dw._nivel_parrafo_ooxml(ch, {"Heading1": 1}) == 1)',
                        'junk = [',
                        '    dw._crear_parrafo_texto(text="Table of Contents", font_size=13, bold_all=True),',
                        '    dw._crear_parrafo_texto(text="Tabla de contenido", font_size=13, bold_all=True),',
                        '    dw._crear_parrafo_toc(1, "1. Glossary & New Words", "_Toc1", {"toc_1": "TOC1", "hyperlink": "Hyperlink"}, is_first=False),',
                        '    dw._crear_parrafo_toc(2, "resilient (adjective) — resiliente", "_Toc2", {"toc_2": "TOC2", "hyperlink": "Hyperlink"}, is_first=False),',
                        '    dw._crear_parrafo_toc(1, "1. Glossary & New Words", "_Toc1", {"toc_1": "TOC1", "hyperlink": "Hyperlink"}, is_first=False),',
                        '    ET.fromstring(f\'<w:p xmlns:w="{W}"><w:pPr><w:pStyle w:val="TOC2"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGEREF _Toc888 \\\\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Content not found</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>\'),',
                        '    ET.fromstring(f\'<w:p xmlns:w="{W}"><w:hyperlink w:anchor="bookmark=id.bad999"><w:r><w:t>#bookmark=id.bad999 Content not found</w:t></w:r></w:hyperlink></w:p>\'),',
                        '    ET.fromstring(f\'<w:p xmlns:w="{W}"><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>\'),',
                        '    dw._w_el("p"),',
                        ']',
                        'for off, j_el in enumerate(junk): body_m.insert(h1_idx + off, j_el)',
                        'buf_corrupt = io.BytesIO()',
                        'with zipfile.ZipFile(buf_corrupt, "w", compression=zipfile.ZIP_DEFLATED) as zout:',
                        '    for fn, pl in others.items(): zout.writestr(fn, pl)',
                        '    zout.writestr("word/document.xml", dw._serializar_documento(root_m, orig_xml))',
                        'with open(corrupt_path, "wb") as fh: fh.write(buf_corrupt.getvalue())',
                        'healed_bytes, umeta = dw.update_english_docx_bytes(buf_corrupt.getvalue(), {"category": "notes", "language": "English", "title": "Extra Note", "notes": "Preserved after healing."})',
                        'h_info = inspect_doc(healed_bytes)',
                        'assert umeta["removedTocParagraphs"] >= 7, umeta',
                        'assert h_info["toc_titles"] == 1 and h_info["toc_instrs"] == 1 and h_info["broken"] == [], h_info',
                        'assert h_info["closed_toc"] == 1 and h_info["depth"] == 0 and h_info["orphan_ends"] == 0, h_info',
                        'assert h_info["toc_paras"] == len(h_info["headings"]) == h_info["toc_links"], h_info',
                        'print(json.dumps({"cleanHeadings": len(c_info["headings"]), "healedHeadings": len(h_info["headings"])}))'
                    ].join('\n'),
                    docxPath,
                    corruptPath
                ],
                { encoding: 'utf8', env: utf8Env }
            );
            assert.strictEqual(pyVerify.status, 0, pyVerify.stderr || pyVerify.stdout);

            // 3) Verificar que lib/language-studio.js filtra TOC basadas en fldChar/TOC1/PAGEREF/Content not found incluso ANTES de reparar
            const corruptBuf = fs.readFileSync(corruptPath);
            const parsedCorrupt = langStudio.parseStudyNotebookDocxBuffer(corruptBuf, { includeAllEntries: true });
            assert.strictEqual(parsedCorrupt.ok, true);
            assert.strictEqual(parsedCorrupt.counts.vocabulary, 2);
            assert.strictEqual(parsedCorrupt.counts.grammar, 1);
            assert.strictEqual(parsedCorrupt.counts.phrasal_verb, 1);
            assert.strictEqual(parsedCorrupt.counts.notes, 1);
            assert.strictEqual(parsedCorrupt.counts.music, 2);
            assert.ok(parsedCorrupt.allEntries.every((e) => !/Content not found|Table of Contents|bookmark=id/i.test(`${e.title} ${e.text}`)));

            // 4) Probar el modo CLI --mode repair-english con respaldo .bak sobre el archivo corrupto
            const repairCli = spawnSync(
                pyCmd,
                [path.join(ROOT, 'lib', 'docx_writer.py'), '--mode', 'repair-english'],
                { input: JSON.stringify({ docxPath: corruptPath }), encoding: 'utf8', env: utf8Env }
            );
            assert.strictEqual(repairCli.status, 0, repairCli.stderr || repairCli.stdout);
            const repairStats = JSON.parse(repairCli.stdout.trim());
            assert.strictEqual(repairStats.ok, true);
            assert.strictEqual(repairStats.repaired, true);
            assert.ok(repairStats.removedTocParagraphs >= 7, JSON.stringify(repairStats));
            assert.strictEqual(repairStats.sectionsIntact, true);
            assert.strictEqual(fs.existsSync(`${corruptPath}.bak`), true);
            assert.strictEqual(repairStats.counts.vocabulary, 2);
            assert.strictEqual(repairStats.counts.music, 2);

            const parsedRepaired = langStudio.parseStudyNotebookDocxBuffer(fs.readFileSync(corruptPath), { includeAllEntries: true });
            assert.strictEqual(parsedRepaired.ok, true);
            assert.strictEqual(parsedRepaired.counts.vocabulary, 2);
            assert.strictEqual(parsedRepaired.counts.grammar, 1);
            assert.strictEqual(parsedRepaired.counts.phrasal_verb, 1);
            assert.strictEqual(parsedRepaired.counts.notes, 1);
            assert.strictEqual(parsedRepaired.counts.music, 2);

            // 5) Regresión real: styles.xml con Ttulo1Car..3 (character), Tablanormal (table), TDC1..3,
            // encabezados reales sin pStyle y secciones 1..6 duplicadas al final
            const realCasePath = path.join(tmpDir, 'RealGoogleDocsCase.docx');
            const pyRealCase = spawnSync(
                pyCmd,
                [
                    '-c',
                    [
                        'import io, json, sys, zipfile',
                        `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'lib'))})`,
                        'import docx_writer as dw',
                        'W = dw.W_NS_URI',
                        'styles = (',
                        '  f\'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="{W}">\'',
                        '  \'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>\'',
                        '  \'<w:style w:type="table" w:styleId="Tablanormal"><w:name w:val="Normal Table"/></w:style>\'',
                        '  \'<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>\'',
                        '  \'<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>\'',
                        '  \'<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/></w:style>\'',
                        '  \'<w:style w:type="character" w:styleId="Ttulo1Car"><w:name w:val="Título 1 Car"/></w:style>\'',
                        '  \'<w:style w:type="character" w:styleId="Ttulo2Car"><w:name w:val="Título 2 Car"/></w:style>\'',
                        '  \'<w:style w:type="character" w:styleId="Ttulo3Car"><w:name w:val="Título 3 Car"/></w:style>\'',
                        '  \'<w:style w:type="paragraph" w:styleId="TDC1"><w:name w:val="toc 1"/></w:style>\'',
                        '  \'<w:style w:type="paragraph" w:styleId="TDC2"><w:name w:val="toc 2"/></w:style>\'',
                        '  \'<w:style w:type="paragraph" w:styleId="TDC3"><w:name w:val="toc 3"/></w:style>\'',
                        '  \'<w:style w:type="character" w:styleId="Hipervnculo"><w:name w:val="Hyperlink"/></w:style>\'',
                        '  \'</w:styles>\'',
                        ')',
                        'doc = (',
                        '  f\'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="{W}"><w:body>\'',
                        '  \'<w:p><w:r><w:t>Table of Contents</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:pPr><w:pStyle w:val="TDC1"/></w:pPr><w:r><w:t>1. Glossary &amp; New Words 1</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:r><w:t>1. Glossary &amp; New Words</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:r><w:t>tiptoeing over — Caminar de puntitas</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:r><w:t>Language: English</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:r><w:t>Expression: tiptoeing over</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:r><w:t>2. Grammar &amp; Usage Notes</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:r><w:t>3. Phrasal Verbs</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:r><w:t>4. Songs &amp; Music Study</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:r><w:t>Drip (Album, 2024)</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:r><w:t>DRIP — BABYMONSTER</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:r><w:t>Song: DRIP</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:r><w:t>Artists / Collabs: BABYMONSTER</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:r><w:t>5. My Notes &amp; Learnings</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:r><w:t>6. Alphabets &amp; Composition Rules</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:pPr><w:pStyle w:val="Ttulo1Car"/></w:pPr><w:r><w:t>1. Glossary &amp; New Words</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:pPr><w:pStyle w:val="Ttulo1Car"/></w:pPr><w:r><w:t>2. Grammar &amp; Usage Notes</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:pPr><w:pStyle w:val="Ttulo1Car"/></w:pPr><w:r><w:t>3. Phrasal Verbs</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:pPr><w:pStyle w:val="Ttulo1Car"/></w:pPr><w:r><w:t>4. Songs &amp; Music Study</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:pPr><w:pStyle w:val="Ttulo2Car"/></w:pPr><w:r><w:t>Someone to Hold (from the Netflix Film "Steps") (Album, 2026)</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:pPr><w:pStyle w:val="Ttulo3Car"/></w:pPr><w:r><w:t>Someone to Hold (from the Netflix Film "Steps") — JENNIE</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:r><w:t>Song: Someone to Hold (from the Netflix Film "Steps")</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:r><w:t>Artists / Collabs: JENNIE</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:pPr><w:pStyle w:val="Ttulo1Car"/></w:pPr><w:r><w:t>5. My Notes &amp; Learnings</w:t></w:r></w:p>\'',
                        '  \'<w:p><w:pPr><w:pStyle w:val="Ttulo1Car"/></w:pPr><w:r><w:t>6. Alphabets &amp; Composition Rules</w:t></w:r></w:p>\'',
                        '  \'<w:sectPr/></w:body></w:document>\'',
                        ')',
                        'buf = io.BytesIO()',
                        'with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zout:',
                        '    zout.writestr("[Content_Types].xml", \'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>\')',
                        '    zout.writestr("word/styles.xml", styles)',
                        '    zout.writestr("word/document.xml", doc)',
                        'repaired_b, stats = dw.repair_english_docx_bytes(buf.getvalue())',
                        'with open(sys.argv[1], "wb") as fh: fh.write(repaired_b)',
                        'xml_s = zipfile.ZipFile(io.BytesIO(repaired_b), "r").read("word/document.xml").decode("utf-8")',
                        'assert "Ttulo1Car" not in xml_s and "Ttulo2Car" not in xml_s and "Ttulo3Car" not in xml_s and "Tablanormal" not in xml_s',
                        'assert stats["sectionsCount"] == 6 and stats["sectionsIntact"] is True, stats',
                        'assert stats["counts"]["vocabulary"] == 1 and stats["counts"]["music"] == 2, stats',
                        'assert stats["validTocEntries"] == 11, stats',
                        'print(json.dumps(stats))'
                    ].join('\n'),
                    realCasePath
                ],
                { encoding: 'utf8', env: utf8Env }
            );
            assert.strictEqual(pyRealCase.status, 0, pyRealCase.stderr || pyRealCase.stdout);

            const parsedReal = langStudio.parseStudyNotebookDocxBuffer(fs.readFileSync(realCasePath), { includeAllEntries: true });
            assert.strictEqual(parsedReal.ok, true);
            assert.strictEqual(parsedReal.counts.vocabulary, 1);
            assert.strictEqual(parsedReal.counts.music, 2);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

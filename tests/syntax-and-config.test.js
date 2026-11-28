const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
// Rutas absolutas resueltas desde la raíz del proyecto (independientes del cwd de `node --test`).
// Evita ENOENT cuando la suite se ejecuta desde otra carpeta (Issue #84).
const SYNC_PY_PATH = path.resolve(__dirname, '..', 'sincronitation', 'sincronizador.py');
const YT_HELPER_PY_PATH = path.resolve(__dirname, '..', 'sincronitation', 'yt_lyrics_helper.py');

function readText(relPath) {
    return fs.readFileSync(path.resolve(ROOT, relPath), 'utf8');
}

function resolvePythonCmd() {
    const candidates = process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python'];
    for (const cmd of candidates) {
        try {
            execFileSync(cmd, ['--version'], { stdio: 'pipe' });
            return cmd;
        } catch (_) { /* siguiente candidato */ }
    }
    return null;
}

describe('Sintaxis de código (JS, HTML, CSS, Python, Bash)', () => {
    it('valida sintaxis de server.js, módulos lib/, scripts públicos y tests/ci-summary.js con node --check', () => {
        for (const rel of [
            'server.js',
            'lib/transport-crypto.js',
            'lib/language-studio.js',
            'lib/youtube-metadata.js',
            'lib/ytdlp-service.js',
            'lib/server-notes-service.js',
            'lib/server-logger.js',
            'lib/server-i18n.js',
            'public/theme-init.js',
            'public/i18n.js',
            'public/dashboard.js',
            'public/guia-visual.js',
            'public/transport-crypto.js',
            'public/translator-widget.js',
            'public/translator-popup.js',
            'public/hangul-trace-recognizer.js',
            'public/frontend.js',
            'scripts/release-version.js',
            'tests/ci-summary.js'
        ]) {
            execFileSync(process.execPath, ['--check', path.join(ROOT, rel)], { stdio: 'pipe' });
        }

        const popupHtml = fs.readFileSync(path.join(ROOT, 'public/translator-popup.html'), 'utf8');
        for (const token of [
            '<script src="theme-init.js"></script>',
            '<link rel="stylesheet" href="style.css">',
            '<script src="translator-widget.js" defer></script>',
            '<script src="translator-popup.js" defer></script>',
            'id="popupTranslatorInput"',
            'class="english-textarea translator-extension-textarea"',
            'id="btnRunPopupTranslator"',
            'id="popupTranslatorResultBox"'
        ]) {
            assert.ok(popupHtml.includes(token), `public/translator-popup.html missing required token: ${token}`);
        }
        assert.ok(
            !/<script\b(?![^>]*\bsrc\s*=)[^>]*>/i.test(popupHtml),
            'public/translator-popup.html must not include inline <script> tags due to strict CSP'
        );
    });

    it('valida sintaxis de scripts embebidos y estructura básica de HTML', () => {
        const indexHtml = readText('public/index.html');
        assert.match(indexHtml, /<html\s+lang=["']en["']/i);
        assert.match(indexHtml, /<script[^>]+src=["']theme-init\.js["']/i);
        assert.match(indexHtml, /<script[^>]+src=["']frontend\.js["']/i);
        assert.match(indexHtml, /href=["']style\.css["']/i);
        assert.match(indexHtml, /id=["']themeToggleBtn["']|data-theme/i);
        assert.match(indexHtml, /id=["']appBootScreen["']/i);
        assert.match(indexHtml, /id=["']authOverlay["'][^>]*\bhidden\b/i);
        assert.match(indexHtml, /Personal Daily Hub/);
        assert.match(indexHtml, /Daily Hub/);
        assert.match(indexHtml, /id=["']agendaLoadingBanner["']/i);
        assert.match(indexHtml, /id=["']resumenLoadingBanner["']/i);
        assert.match(indexHtml, /id=["']view-english["']/i);
        assert.match(indexHtml, /id=["']englishForm["']/i);
        for (const fieldId of [
            'loginPassword',
            'regPassword',
            'regCodigoValidacion',
            'resetNewPassword',
            'resetConfirmPassword',
            'medicoPassword',
            'mfaCodeInput'
        ]) {
            assert.ok(
                indexHtml.includes(`data-toggle-password="${fieldId}"`),
                `Falta botón ojito data-toggle-password="${fieldId}" en index.html`
            );
        }
        assert.ok(indexHtml.includes('id="authMfaForm"'), 'Falta formulario #authMfaForm en index.html');
        const frontendJs = readText('public/frontend.js');
        assert.match(frontendJs, /function\s+initPasswordToggles\s*\(/);
        for (const fnName of [
            'runWithButtonLock',
            'createIdempotencyKey',
            'createRequestTracker',
            'submitMutationRequest',
            'createLoadingBanner',
            'hideBootScreen',
            'validateEmailClient',
            'validatePasswordFormatClient'
        ]) {
            assert.match(frontendJs, new RegExp(`function\\s+${fnName}\\s*\\(`), `Falta helper ${fnName} en frontend.js`);
        }

        const serverJs = readText('server.js');
        assert.match(serverJs, /Permissions-Policy['"],\s*['"]geolocation=\(self\)/);
        for (const fnName of [
            'preventDuplicateSubmit',
            'createRateLimiter',
            'normalizeEmail',
            'validatePasswordFormat',
            'requireNonEmptyBody'
        ]) {
            assert.match(serverJs, new RegExp(`function\\s+${fnName}\\s*\\(`), `Falta helper ${fnName} en server.js`);
        }
        assert.match(serverJs, /Personal Daily Hub/);

        const dashHtml = readText('public/dashboard.html');
        assert.match(dashHtml, /<html\s+lang=["']en["']/i);
        assert.match(dashHtml, /Daily Hub/);
        const scriptMatches = [...dashHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
        assert.ok(scriptMatches.length > 0, 'dashboard.html debe incluir script de redirección');
        for (const m of scriptMatches) {
            new vm.Script(m[1], { filename: 'public/dashboard.html' });
        }
    });

    it('verifica llaves balanceadas, spinners, tema oscuro y responsividad de agenda en public/style.css', () => {
        const css = readText('public/style.css');
        assert.match(css, /\[data-theme=["']dark["']\]/);
        assert.match(css, /\.spinner-circle\b/);
        assert.match(css, /\.boot-screen\b/);
        assert.match(css, /\.agenda-item-top\b/);
        assert.match(css, /\.jira-status-select\s*\{[\s\S]*?max-width:\s*100%/);
        assert.match(css, /\.jira-status-select\s*\{[\s\S]*?min-width:\s*0/);
        assert.match(css, /\.agenda-cat-pill,\s*\.agenda-type-pill\s*\{[\s\S]*?white-space:\s*nowrap/);
        assert.match(css, /\.agenda-cell\s*\{[\s\S]*?min-width:\s*0/);
        assert.match(css, /\.music-catalog-container\s*\{[\s\S]*?overflow-y:\s*auto/);
        assert.match(css, /\.music-artist-group\s*\{[\s\S]*?flex-shrink:\s*0/);
        assert.match(css, /\.music-song-row\s*\{[\s\S]*?flex-shrink:\s*0/);
        assert.match(css, /\.rep-item\s*\{[\s\S]*?flex-shrink:\s*0/);

        const frontendJs = readText('public/frontend.js');
        assert.match(frontendJs, /agenda-item-top/);

        const stripped = css
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '');
        const opens = (stripped.match(/\{/g) || []).length;
        const closes = (stripped.match(/\}/g) || []).length;
        assert.ok(opens > 20, 'style.css debe contener reglas CSS');
        assert.strictEqual(opens, closes, `Llaves desbalanceadas en style.css: ${opens} vs ${closes}`);
    });

    it('evita estiramiento vertical en columna móvil reseteando flex/height en .journal-submit-row y contenedores flex auditados', () => {
        const css = readText('public/style.css');

        function extractMediaBlocks(source, mediaHeaderRegex) {
            const blocks = [];
            let match;
            const globalRegex = new RegExp(mediaHeaderRegex.source, 'g');
            while ((match = globalRegex.exec(source)) !== null) {
                const openIdx = source.indexOf('{', match.index);
                if (openIdx === -1) continue;
                let depth = 0;
                let endIdx = -1;
                for (let i = openIdx; i < source.length; i++) {
                    if (source[i] === '{') depth++;
                    else if (source[i] === '}') {
                        depth--;
                        if (depth === 0) {
                            endIdx = i;
                            break;
                        }
                    }
                }
                if (endIdx !== -1) {
                    blocks.push(source.slice(openIdx + 1, endIdx));
                }
            }
            return blocks;
        }

        // Escritorio (> 640px) mantiene flex: 1 1 240px en .journal-submit-row .btn-submit
        assert.match(css, /\.journal-submit-row\s+\.btn-submit\s*\{[^}]*flex:\s*1\s+1\s+240px;/);

        const media640 = extractMediaBlocks(css, /@media\s*\(\s*max-width:\s*640px\s*\)/).join('\n');
        const media480 = extractMediaBlocks(css, /@media\s*\(\s*max-width:\s*480px\s*\)/).join('\n');

        // Regresión principal: .journal-submit-row en columna móvil debe resetear flex/height
        const journalMobileMatch = media640.match(/\.journal-submit-row\s*\{[^}]*flex-direction:\s*column;[\s\S]*?\}(\s*\.journal-submit-row\s+\.btn-submit[\s\S]*?\{[^}]*\})/);
        assert.ok(journalMobileMatch, 'Debe existir el bloque móvil de .journal-submit-row y .journal-submit-row .btn-submit en @media (max-width: 640px)');
        const journalBtnRule = journalMobileMatch[1];
        assert.match(journalBtnRule, /\.journal-submit-row\s+\.btn-submit/);
        assert.match(journalBtnRule, /\.journal-submit-row\s+\.btn-journal-ntr/);
        assert.match(journalBtnRule, /(?:flex:\s*(?:0\s+0\s+auto|none)|flex-basis:\s*auto)\s*;/);
        assert.match(journalBtnRule, /height:\s*auto\s*;/);
        assert.match(journalBtnRule, /width:\s*100%\s*;/);
        assert.match(journalBtnRule, /min-height:\s*46px\s*;/);
        assert.match(journalBtnRule, /padding:\s*12px\s+16px\s*;/);

        // Contenedores flex auditados que pasan a columna en móvil
        for (const [label, regex] of [
            ['.view-header-main en 640px', /\.view-header-main\s*\{[^}]*flex:\s*0\s+0\s+auto;[^}]*height:\s*auto;/],
            ['.yt-platform-info en 640px', /\.yt-platform-info\s*\{[^}]*flex:\s*0\s+0\s+auto;[^}]*height:\s*auto;/],
            ['.music-yt-finder-bar input y .music-inline-input input en 640px', /\.music-yt-finder-bar\s+input,\s*\.music-inline-input\s+input\s*\{[^}]*flex:\s*0\s+0\s+auto;[^}]*height:\s*auto;/],
            ['.rule-row-split > .switch-row en 640px', /\.rule-row-split\s*>\s*\.switch-row[\s\S]*?\{[^}]*flex:\s*0\s+0\s+auto;[^}]*height:\s*auto;/]
        ]) {
            assert.match(media640, regex, `Falta reseteo flex/height en ${label}`);
        }

        assert.match(
            media480,
            /\.modal-actions-split\s+\.modal-actions\s+button\s*\{[^}]*flex:\s*0\s+0\s+auto;[^}]*height:\s*auto;/,
            'Falta reseteo flex/height en .modal-actions-split .modal-actions button en @media (max-width: 480px)'
        );
    });

    it('valida sintaxis Python de sincronitation/*.py y lib/docx_writer.py', () => {
        const DOCX_WRITER_PY_PATH = path.resolve(ROOT, 'lib', 'docx_writer.py');
        const pyFiles = [SYNC_PY_PATH, YT_HELPER_PY_PATH, DOCX_WRITER_PY_PATH];
        for (const pyPath of pyFiles) {
            assert.ok(fs.existsSync(pyPath), `Falta ${path.relative(ROOT, pyPath)}`);
        }
        const pyCmd = resolvePythonCmd();
        for (const pyPath of pyFiles) {
            const pyCode = fs.readFileSync(pyPath, 'utf8');
            if (pyPath === SYNC_PY_PATH) {
                assert.match(pyCode, /EC2_HOST/);
                assert.match(pyCode, /JOURNAL_SECRET_KEY/);
            }
            if (!pyCmd) continue;
            execFileSync(
                pyCmd,
                ['-c', 'import ast, sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())', pyPath],
                { stdio: 'pipe' }
            );
        }
    });

    it('valida formato Unix (LF), cabecera e higiene de los scripts bash', () => {
        const scripts = ['scripts/backup.sh', 'scripts/blue-green.sh', 'scripts/env-vault.sh', 'scripts/restore.sh', 'scripts/verify-ubuntu-local.sh'];
        for (const rel of scripts) {
            const full = path.join(ROOT, rel);
            const content = fs.readFileSync(full, 'utf8');
            assert.strictEqual(content.includes('\r\n'), false, `${rel} no debe contener saltos CRLF`);
            assert.ok(content.startsWith('#!/bin/bash\n'), `${rel} debe iniciar con #!/bin/bash`);
            assert.match(content, /set -euo pipefail/, `${rel} debe usar set -euo pipefail`);

            if (process.platform !== 'win32') {
                execFileSync('bash', ['-n', full], { stdio: 'pipe' });
            }
        }

        const backupSh = readText('scripts/backup.sh');
        const restoreSh = readText('scripts/restore.sh');
        assert.match(backupSh, /unset RCLONE_BACKUP_DIR RCLONE_REMOTE/);
        assert.match(restoreSh, /unset RCLONE_BACKUP_DIR RCLONE_REMOTE/);
    });
});

describe('Integridad de configuración, Docker, SQL y CI/CD', () => {
    it('mantiene package.json y package-lock.json válidos y sincronizados', () => {
        const pkg = JSON.parse(readText('package.json'));
        const lock = JSON.parse(readText('package-lock.json'));
        assert.ok(pkg.scripts && pkg.scripts.test, 'package.json debe definir script test');
        const deps = Object.keys(pkg.dependencies || {});
        assert.ok(deps.length > 0);
        for (const dep of deps) {
            assert.ok(
                lock.packages && lock.packages[`node_modules/${dep}`],
                `Falta ${dep} en package-lock.json`
            );
        }
    });

    it('define las 14 tablas requeridas (incluyendo música/inglés/crisis/sync) en init.sql', () => {
        const sql = readText('init.sql');
        for (const table of [
            'RegistrosMood',
            'RegistrosSleep',
            'RegistrosCrisis',
            'RegistrosAgenda',
            'Usuarios',
            'SesionesAuth',
            'CodigosSeguridad',
            'ConfiguracionUsuario',
            'RecordatoriosEstado',
            'MusicaArtistas',
            'MusicaAlbumes',
            'MusicaCanciones',
            'MusicaCancionArtistas',
            'SyncRevisions'
        ]) {
            assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `Falta tabla ${table}`);
        }
        assert.match(sql, /estado\s+ENUM\('activo',\s*'inactivo',\s*'suspendido'\)/);
        assert.match(sql, /hora_dormir\s+VARCHAR\(5\)/);
        assert.match(sql, /es_desvelo\s+TINYINT\(1\)/);
        assert.match(sql, /tipo_registro\s+VARCHAR\(30\)/);
        assert.match(sql, /motivo_desvelo\s+VARCHAR\(500\)/);
        assert.match(sql, /tipo\s+ENUM\('registro',\s*'reset',\s*'mfa'\)/);
        assert.match(sql, /tipo\s+ENUM\('evento',\s*'tarea'\)/);
        assert.match(sql, /categoria\s+ENUM\('universidad',\s*'personal'\)/);
        assert.match(sql, /estado\s+ENUM\('todo',\s*'in_progress',\s*'done',\s*'skipped'\)/);
        assert.match(sql, /tipo_lanzamiento\s+ENUM\('album',\s*'mini_album',\s*'ep',\s*'single',\s*'ost',\s*'collab_single'\)/);
        assert.match(sql, /fecha_lanzamiento\s+DATE\s+NULL/i);
    });

    it('reemplaza el arcoíris, expone controles de Settings/Jira/Recordatorios/Música y agrega índices a las guías', () => {
        const activeDocs = [
            'README.md',
            'guides/GUIA_TECNICA_UNIFICADA.md',
            'guides/GUIA_COMANDOS.md',
            'guides/GUIA_COMANDOS_RAPIDOS.md',
            'guides/GUIA_INSTALACION_UBUNTU_SERVER_26.md',
            'guides/MANUAL_DE_USUARIO.md'
        ];
        for (const relPath of [
            'public/index.html',
            'public/dashboard.html',
            ...activeDocs
        ]) {
            const content = readText(relPath);
            assert.equal(content.includes('🌈'), false, `${relPath} no debe contener el emoji arcoíris`);
        }

        for (const docPath of activeDocs) {
            const top = readText(docPath).slice(0, 1200);
            assert.match(top, /## .*[ÍI]ndice/i, `${docPath} debe incluir un índice al inicio`);
        }

        const indexHtml = readText('public/index.html');
        for (const requiredId of [
            'id="btnMobileHome"',
            'id="reminderTray"',
            'id="agendaCategoryFilters"',
            'id="agendaTypeFilters"',
            'id="agendaTipo"',
            'id="agendaCategoria"',
            'id="agendaEstado"',
            'id="view-settings"',
            'id="settingsForm"',
            'id="setPhoneEnabled"',
            'id="setNtfyTopic"',
            'id="setEnglishEnabled"',
            'id="setMoodLateNight"',
            'id="setYoutubePlatformMode"',
            'id="setGeminiMode"',
            'data-english-cat="music"',
            'id="englishMusicStudio"',
            'id="ytPlatformBar"',
            'id="ytPlatformModeGroup"',
            'id="musicSongForm"',
            'id="musicFilterSort"',
            'id="musicCatalogContainer"',
            'id="musicWordNotesForm"',
            'id="btnMusicSearchYt"',
            'id="e2eeKeyModal"',
            'id="confirmActionModal"',
            'id="appToastContainer"',
            'id="moodTodayChecklist"',
            'id="sleepTodaySummary"',
            'id="studyLanguageSelectorBar"',
            'id="btnToggleStudyCourse"',
            'id="btnStartMicPronunciation"',
            'id="languageAiPanel"',
            'id="btnAskLangAi"',
            'id="setGeminiModel"',
            'id="view-crisis"',
            'id="crisisForm"',
            'id="resumenCrisisList"',
            'id="resumenCalendarioDia"',
            'id="resumenVisualWeekDays"',
            'id="btnResumenWeekAllDays"',
            'id="musicEntityEditModal"',
            'id="musicSongModal"',
            'id="btnMusicNewSong"',
            'id="btnCloseMusicSongModal"',
            'id="musicAlbumCreateModal"',
            'id="btnMusicNewAlbum"',
            'id="btnMusicQuickNewAlbum"',
            'id="btnMusicStudyEditSelected"',
            'id="btnDeleteMusicEntityModal"',
            'id="quickLocationModal"',
            'id="homeLocationLabel"',
            'id="btnSaveHomeLocation"',
            'id="homeLocationVerifyLink"',
            'id="btnPingPhoneGps"',
            'id="btnClearCurrentGps"',
            'id="btnLoadPhoneWebhook"',
            'id="btnModalPingPhoneGps"',
            'id="sleepModePills"',
            'data-sleep-mode="siesta"',
            'id="btnSleepOpenSettings"',
            'id="sleepEsDesvelo"',
            'id="sleepStillAwake"',
            'id="sleepTodaySummary"',
            'id="resumenSleepDetailsList"',
            'id="settingsSleepRulesBlock"',
            'id="setSleepDesveloBedtimeTime"',
            'id="setSleepMinNormalHours"',
            'id="btnTestGeminiConnection"',
            'id="settingsGeminiTestResult"',
            'id="floatingTranslatorModal"',
            'id="floatingTranslatorDragHandle"',
            'floating-translator-drag-grip',
            'class="floating-translator-body"',
            'id="btnCloseFloatingTranslator"',
            'id="btnSidebarOpenTranslator"',
            'id="btnMobileTranslator"',
            'id="floatTranslatorInput"',
            'translator-extension-textarea',
            'id="musicLyricsViewerCard"',
            'id="musicLyricsMetaBadge"',
            'id="musicLyricsAlbumPlaylistBox"',
            'id="btnMusicExtractLyrics"',
            'id="btnVerifyReplaceSongLyrics"',
            'id="btnMusicCopyLyricsToStudy"',
            'id="btnMusicTranslateLyricsSel"',
            'floating-translate-sel-btn',
            'id="musicSongLyricsViewer"',
            'id="musicLyricsStatusHint"',
            'id="chkAutoSyncAiToWord"',
            'id="chkAutoSyncQuickAiToWord"'
        ]) {
            assert.ok(indexHtml.includes(requiredId), `public/index.html debe incluir ${requiredId}`);
        }
        for (const removedId of [
            'id="btnResumenWeekStartToggle"',
            'id="plannerParkingBufferMin"',
            'id="btnBackToHome"',
            'id="transportSecurityCard"',
            'id="btnTransportBenchmark"',
            'id="btnSyncScheduleToAgenda"',
            'id="semanaSeleccionada"',
            'id="musicRepertoireNavigator"',
            'id="btnMusicSaveLyrics"',
            'id="btnMusicToggleYtdlpHint"',
            'id="musicYtdlpHelperBox"',
            'id="musicDockedTranslatorPane"',
            'id="musicDockedTransInput"',
            'id="btnMusicDockedTranslateRun"',
            'id="musicStudyLyrics"',
            'id="btnMusicAiExplainLyrics"',
            'id="btnMusicCleanTimestamps"',
            'id="musicPcBridgeBadge"',
            'id="btnResetFloatTranslatorPos"',
            'id="btnFloatPopoutTranslator"',
            'id="btnMinimizeFloatingTranslator"'
        ]) {
            assert.equal(indexHtml.includes(removedId), false, `public/index.html debe retirar el elemento obsoleto ${removedId}`);
        }
        const frontendSrcCheck = readText('public/frontend.js');
        for (const removedFrontendRef of [
            'musicStudyLyrics',
            'btnMusicAiExplainLyrics',
            'btnMusicCleanTimestamps',
            'musicPcBridgeBadge'
        ]) {
            assert.equal(frontendSrcCheck.includes(removedFrontendRef), false, `public/frontend.js no debe referenciar ${removedFrontendRef}`);
        }
        assert.equal(
            indexHtml.includes('id="languageTranslatorPanel"'),
            false,
            'public/index.html no debe incluir panel inline de traductor en Learn with AI'
        );
        assert.equal(
            indexHtml.includes('id="translatorInput"'),
            false,
            'public/index.html no debe incluir translatorInput obsoleto'
        );
        assert.match(indexHtml, /<script[^>]+src=["']transport-crypto\.js["']/i);
        assert.ok(fs.existsSync(path.join(ROOT, 'public/transport-crypto.js')));

        const styleCssText = readText('public/style.css');
        assert.ok(frontendSrcCheck.includes('initSidebarSwipeGesture') && frontendSrcCheck.includes('touchstart') && frontendSrcCheck.includes('touchmove') && frontendSrcCheck.includes('touchend'));
        assert.ok(frontendSrcCheck.includes('is-swiping') && styleCssText.includes('.sidebar.is-swiping'));
        assert.ok(frontendSrcCheck.includes('initRealtimeSessionSync') && frontendSrcCheck.includes('/api/sync/stream') && frontendSrcCheck.includes('/api/sync/revisions'));

        const serverSrcCheck = readText('server.js');
        assert.ok(serverSrcCheck.includes("app.get('/api/sync/revisions'") && serverSrcCheck.includes("app.get('/api/sync/stream'"));
        assert.match(serverSrcCheck, /script-src 'self'/);
        assert.match(serverSrcCheck, /connect-src 'self'/);

        // Regresiones de diseño simétrico #sleepGrid, anti-autofill #medicoForm, recarga en #inicio e historial popstate
        assert.match(styleCssText, /\.sleep-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\)/);
        assert.match(styleCssText, /\.sleep-card\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;[\s\S]*?justify-content:\s*space-between/);
        assert.match(styleCssText, /\.sleep-card\s+\.sleep-hours\s*\{[\s\S]*?white-space:\s*nowrap/);

        assert.match(indexHtml, /<form\s+id="medicoForm"\s+autocomplete="off">/);
        assert.match(indexHtml, /id="medicoEmail"[^>]*data-no-autofill="true"/);
        assert.match(indexHtml, /id="medicoPassword"[^>]*data-secret-mask="true"[^>]*data-no-autofill="true"/);
        assert.ok(indexHtml.includes('data-toggle-password="medicoPassword"'));

        // Regresión anti-recortes de inputs time/móvil, compactación por ícono y bloqueo global de autocompletado fuera de Login
        assert.match(styleCssText, /\.secret-input-masked\s*\{[\s\S]*?-webkit-text-security:\s*disc/);
        assert.ok(styleCssText.includes('.btn-responsive-text') && styleCssText.includes('.icon-only-mobile'),
            'style.css debe definir .btn-responsive-text y .icon-only-mobile para compactar botones en móvil');
        const sleepRuleTimeMatch = styleCssText.match(/\.rule-row-split input\[type="time"\][\s\S]*?min-width:\s*(\d+)px/);
        assert.ok(sleepRuleTimeMatch && Number(sleepRuleTimeMatch[1]) >= 150,
            'input[type="time"] en reglas de sueño/recordatorios debe tener min-width >= 150px para evitar recortes en formato 12h');

        assert.match(indexHtml, /id="loginEmail"[^>]*autocomplete="email"/);
        assert.match(indexHtml, /id="loginPassword"[^>]*autocomplete="current-password"/);
        assert.match(indexHtml, /<input\s+type="password"\s+id="loginPassword"/);

        for (const maskedId of [
            'medicoPassword',
            'setGeminiApiKey',
            'e2eeKeyInput',
            'setJournalDownloadPassword',
            'journalDownloadPasswordInput',
            'journalDownloadPasswordConfirm'
        ]) {
            assert.match(
                indexHtml,
                new RegExp(`type="text"[^>]*class="[^"]*secret-input-masked[^"]*"[^>]*id="${maskedId}"[^>]*data-secret-mask="true"`),
                `#${maskedId} debe usar type="text" + .secret-input-masked + data-secret-mask="true" sin disparar gestores de contraseñas`
            );
            assert.match(
                indexHtml,
                new RegExp(`id="${maskedId}"[^>]*autocomplete="off"[^>]*data-lpignore="true"`),
                `#${maskedId} debe desactivar autocompletado del navegador`
            );
            assert.ok(
                indexHtml.includes(`data-toggle-password="${maskedId}"`),
                `#${maskedId} debe incluir botón ojito data-toggle-password`
            );
        }

        const appShellHtml = indexHtml.slice(indexHtml.indexOf('id="appShell"'));
        const appFormsWithoutOff = [...appShellHtml.matchAll(/<form\b([^>]*)>/gi)]
            .map((m) => m[1])
            .filter((attrs) => !/autocomplete="off"/i.test(attrs));
        assert.deepEqual(appFormsWithoutOff, [], `Todos los <form> en #appShell/modales deben llevar autocomplete="off": ${JSON.stringify(appFormsWithoutOff)}`);

        assert.ok(frontendSrcCheck.includes('function initGlobalNoAutofillGuard(') && frontendSrcCheck.includes('initGlobalNoAutofillGuard();'),
            'public/frontend.js debe definir e invocar initGlobalNoAutofillGuard()');

        assert.ok(frontendSrcCheck.includes('history.pushState({ view: targetView }, \'\', targetHash)'));
        assert.ok(frontendSrcCheck.includes("window.addEventListener('popstate'"));
        assert.ok(frontendSrcCheck.includes("history.replaceState({ view: 'inicio' }, '', `${window.location.pathname}#inicio`)"));
        assert.ok(frontendSrcCheck.includes('initMedicoAutofillShield') && frontendSrcCheck.includes('resetMedicoAutofillShield'));
        assert.ok(frontendSrcCheck.includes('weekStartDay: 1'), 'Resumen Semanal debe iniciar siempre en Lunes (weekStartDay: 1)');
        assert.match(indexHtml, /<th data-day-col="Monday">Monday<\/th>[\s\S]*?<th data-day-col="Sunday">Sunday<\/th>/);
        assert.ok(serverSrcCheck.includes('function computeCommuteAlertMilestones') && serverSrcCheck.includes('function resolveLiveDrivingMinutes'));

        const dockerfileText = readText('Dockerfile');
        assert.ok(dockerfileText.includes('COPY lib ./lib'), 'Dockerfile debe copiar carpeta lib/');
        assert.match(dockerfileText, /python3/);
        assert.match(dockerfileText, /\brclone\b/);

        const serverJs = readText('server.js');
        assert.match(serverJs, /media-src 'self'/);

        const initSql = readText('init.sql');
        assert.doesNotMatch(initSql, /\blyrics_text\b/i);
        assert.doesNotMatch(initSql, /\blyrics_source\b/i);

        const styleCss = readText('public/style.css');
        for (const requiredClass of [
            '.view-shell',
            '.view-header-card',
            '.yt-platform-bar',
            '.app-toast-container',
            '.english-row-2',
            '.select-input',
            '.tunnel-pill',
            '.lang-ai-panel',
            '.lang-translator-panel',
            '.ai-network-fallback',
            '.music-yt-search-hint',
            '.music-filter-bar > input[type="search"]',
            '.rep-item > span:first-child',
            '.btn-mini-edit',
            '.btn-mini-add',
            '.is-editing-song',
            '.music-empty-album-cta',
            '.agenda-week-board .jira-status-select',
            '.quick-loc-presets',
            '.phone-webhook-box',
            '.sleep-desvelo-badge',
            '.sleep-mode-pill',
            '.music-embed-toolbar',
            '.music-embed-fallback-note',
            '.music-lyrics-label-actions',
            '.music-ytdlp-helper',
            '.floating-translator-drawer',
            '.translator-popup-shell',
            '.music-html5-player',
            '.music-lyrics-viewer-card',
            '.music-lyrics-textarea',
            '.music-album-tracklist-box',
            '.music-album-track-btn',
            '.ai-autosync-toggle',
            '.lang-toggle-pill',
            '.btn-lang-sidebar',
            '.vg-root',
            '.vg-standalone-shell'
        ]) {
            assert.ok(styleCss.includes(requiredClass), `public/style.css debe definir ${requiredClass}`);
        }
    });

    it('protege archivos secretos y configura Dockerfile / docker-compose.yml para Ubuntu Server (8 GB RAM + Tailscale)', () => {
        const gitignore = readText('.gitignore');
        for (const entry of ['.env', '.env.enc', '.env.*.tmp', 'english-notes/', 'data/', 'logs/', '*.log', '*.log.*']) {
            assert.ok(gitignore.includes(entry), `.gitignore debe excluir ${entry}`);
        }

        const dockerignore = readText('.dockerignore');
        for (const entry of ['.git', '.env', '.env.enc', 'node_modules', 'test', 'tests', 'guides', 'english-notes', 'data', 'logs', '*.log.*']) {
            assert.ok(dockerignore.includes(entry), `.dockerignore debe excluir ${entry}`);
        }

        for (const guidePath of [
            'README.md',
            'guides/GUIA_TECNICA_UNIFICADA.md',
            'guides/GUIA_COMANDOS.md',
            'guides/GUIA_COMANDOS_RAPIDOS.md',
            'guides/GUIA_INSTALACION_UBUNTU_SERVER_26.md',
            'guides/MANUAL_DE_USUARIO.md'
        ]) {
            const guide = readText(guidePath);
            assert.equal(guide.includes('file:///'), false, `${guidePath} no debe contener enlaces locales file:///`);
            assert.equal(guide.includes('docs-privados'), false, `${guidePath} no debe referenciar docs-privados`);
        }

        for (const removedGuide of [
            'guides/GUIA_TECNICA.md',
            'guides/GUIA_TECNICA_ARQUITECTURA.md',
            'guides/GUIA_OPERACION_Y_MIGRACION.md',
            'guides/GUIA_MIGRACION.md'
        ]) {
            assert.equal(fs.existsSync(path.resolve(ROOT, removedGuide)), false, `${removedGuide} debe haberse consolidado y eliminado`);
        }

        const readme = readText('README.md');
        const guideLinkMatches = [...readme.matchAll(/\((guides\/[^)#\s]+\.md)(?:#[^)]*)?\)/g)];
        assert.ok(guideLinkMatches.length >= 5, 'README.md debe enlazar las 5 guías vigentes de guides/');
        for (const match of guideLinkMatches) {
            const targetPath = match[1];
            assert.equal(fs.existsSync(path.resolve(ROOT, targetPath)), true, `Enlace roto en README.md: ${targetPath}`);
        }

        const dockerfile = readText('Dockerfile');
        assert.match(dockerfile, /FROM node:20-alpine/);
        assert.match(dockerfile, /npm ci --omit=dev/);
        assert.equal(dockerfile.includes('npm cache clean --force'), false, 'Dockerfile no debe usar npm cache clean --force');
        assert.match(dockerfile, /rm -rf \/root\/\.npm/);
        assert.match(dockerfile, /--root-user-action=ignore/);
        assert.match(dockerfile, /--max-old-space-size=768/);
        assert.match(dockerfile, /\btzdata\b/);
        assert.match(dockerfile, /XDG_CACHE_HOME=\/tmp\/\.cache/);
        assert.match(dockerfile, /OOXMLFile/);
        assert.match(dockerfile, /OfficeFile/);
        assert.match(dockerfile, /\.encrypt\(/);
        assert.match(dockerfile, /\.decrypt\(/);
        assert.match(dockerfile, /\/app\/lib\/docx_writer\.py/);
        assert.match(dockerfile, /chown -R 1000:1000/);
        assert.match(dockerfile, /msoffcrypto-tool/);
        assert.match(dockerfile, /\bffmpeg\b/);
        assert.match(dockerfile, /\/usr\/local\/bin\/yt-dlp/);
        assert.match(dockerfile, /YTM_INNERTUBE=1/);

        const compose = readText('docker-compose.yml');
        assert.match(compose, /mem_limit:\s*1024m/);
        assert.match(compose, /no-new-privileges:true/);
        assert.match(compose, /cap_drop:/);
        assert.match(compose, /pids_limit:/);
        assert.match(compose, /noexec,nosuid,nodev/);
        assert.match(compose, /REQUIRE_HTTPS=/);
        assert.match(compose, /REQUIRE_PC_BRIDGE_AUTH=/);
        assert.match(compose, /\/healthz/);
        assert.match(compose, /--performance-schema=OFF/);
        assert.match(compose, /--skip-log-bin/);
        assert.match(compose, /--innodb-buffer-pool-size=384M/);
        assert.match(compose, /--innodb-flush-method=O_DIRECT/);
        assert.match(compose, /--innodb-flush-log-at-trx-commit=2/);
        assert.match(compose, /--innodb-io-capacity=150/);
        assert.match(compose, /--innodb-redo-log-capacity=64M/);
        assert.match(compose, /mysqladmin",\s*"ping",\s*"-h",\s*"127\.0\.0\.1"/);
        assert.match(compose, /user:\s*"\$\{APP_UID:-1000\}:\$\{APP_GID:-1000\}"/);
        assert.match(compose, /"127\.0\.0\.1:\$\{BLUE_PORT:-3001\}:\$\{PORT:-3000\}"/);
        assert.match(compose, /"127\.0\.0\.1:\$\{GREEN_PORT:-3002\}:\$\{PORT:-3000\}"/);
        assert.equal(/^\s*-\s*"(?:\$\{?(?:PORT|BLUE_PORT|GREEN_PORT)[^"]*|\d+:3000)"/m.test(compose), false, 'Ningún slot Blue/Green debe exponer puertos en 0.0.0.0');
        assert.match(compose, /DB_RETENTION_DAYS=\$\{DB_RETENTION_DAYS:-0\}/);
        assert.match(compose, /ENABLE_LOGIN_MFA=\$\{ENABLE_LOGIN_MFA:-false\}/);
        assert.match(compose, /YOUTUBE_API_KEY=\$\{YOUTUBE_API_KEY:-\}/);
        assert.match(compose, /\/app\/journal-data/);
        assert.match(compose, /\/app\/english-notes/);
        assert.match(compose, /\/app\/logs/);
        assert.match(compose, /LOG_DIR=\$\{LOG_DIR:-\/app\/logs\}/);
        assert.match(compose, /TRUST_PROXY=\$\{TRUST_PROXY:-1\}/);
        assert.match(compose, /SERVER_AUTONOMOUS_NOTES=\$\{SERVER_AUTONOMOUS_NOTES:-true\}/);
        assert.match(compose, /YT_DLP_PATH=\$\{YT_DLP_PATH:-\}/);
        assert.ok((compose.match(/restart:\s*always/g) || []).length >= 3, 'db, app y proxy deben usar restart: always');
        assert.ok((compose.match(/healthcheck:/g) || []).length >= 3, 'db, app y proxy deben definir healthcheck');

        // CryptoJS 100% local sin CDN externo + interoperabilidad E2EE y TransportCrypto
        const cryptoVendorPath = path.join(ROOT, 'public', 'vendor', 'crypto-js.min.js');
        assert.ok(fs.existsSync(cryptoVendorPath), 'Debe existir public/vendor/crypto-js.min.js');
        assert.ok(fs.statSync(cryptoVendorPath).size > 30000, 'crypto-js.min.js debe estar completo (> 30 KB)');
        const indexHtmlMain = readText('public/index.html');
        assert.ok(indexHtmlMain.includes('src="vendor/crypto-js.min.js"'), 'index.html debe cargar vendor/crypto-js.min.js local');
        assert.equal(indexHtmlMain.includes('cdnjs.cloudflare.com'), false, 'index.html no debe depender de cdnjs.cloudflare.com');
        const serverSrc = readText('server.js');
        assert.equal(serverSrc.includes('cdnjs.cloudflare.com'), false, 'server.js CSP no debe incluir cdnjs.cloudflare.com');
        assert.match(serverSrc, /script-src 'self'/);

        const { webcrypto } = require('node:crypto');
        const serverNotes = require(path.join(ROOT, 'lib', 'server-notes-service.js'));
        const vendorSandbox = {
            window: { crypto: webcrypto },
            self: { crypto: webcrypto },
            globalThis: { crypto: webcrypto },
            crypto: webcrypto
        };
        vm.runInNewContext(fs.readFileSync(cryptoVendorPath, 'utf8'), vendorSandbox);
        const C = vendorSandbox.CryptoJS || vendorSandbox.window.CryptoJS;
        assert.ok(C && C.AES && C.HmacSHA256 && C.mode.CBC && C.pad.Pkcs7);
        const e2eeKey = '12345678901234567890123456789012';
        const iv = C.lib.WordArray.random(16);
        const encObj = C.AES.encrypt('Nota local Ubuntu Tailscale', C.enc.Utf8.parse(e2eeKey), { iv });
        const envelope = iv.toString(C.enc.Hex) + ':' + encObj.toString();
        const decCheck = serverNotes.decryptClientE2ee(envelope, e2eeKey);
        assert.equal(decCheck.ok, true);
        assert.equal(decCheck.plainText, 'Nota local Ubuntu Tailscale');

        const transportSandbox = {
            window: { crypto: webcrypto, CryptoJS: C },
            globalThis: { crypto: webcrypto, CryptoJS: C },
            CryptoJS: C,
            crypto: webcrypto,
            TextEncoder,
            TextDecoder,
            btoa: (str) => Buffer.from(str, 'binary').toString('base64'),
            atob: (b64) => Buffer.from(b64, 'base64').toString('binary')
        };
        vm.runInNewContext(readText('public/transport-crypto.js'), transportSandbox);
        const tcClient = transportSandbox.window.TransportCrypto || transportSandbox.globalThis.TransportCrypto;
        assert.ok(tcClient && typeof tcClient.aes256CtrTransform === 'function');
        const ctrKey = new Uint8Array(32).fill(7);
        const ctrIv = new Uint8Array(16).fill(3);
        const rawBytes = new TextEncoder().encode('Ubuntu 100% local');
        const cipherBytes = tcClient.aes256CtrTransform(ctrKey, ctrIv, rawBytes, C);
        const plainBytes = tcClient.aes256CtrTransform(ctrKey, ctrIv, cipherBytes, C);
        assert.equal(new TextDecoder().decode(plainBytes), 'Ubuntu 100% local');

        // Backup 100% local o Drive verificado, .backup.meta con DB_RETENTION_DAYS y .gitignore con node_modules/
        const envVaultSh = readText('scripts/env-vault.sh');
        assert.match(envVaultSh, /DB_RETENTION_DAYS/);
        assert.match(envVaultSh, /REQUIRE_DRIVE_BACKUP/);
        const backupShCfg = readText('scripts/backup.sh');
        assert.match(backupShCfg, /DRIVE_ENABLED=0/);
        assert.match(backupShCfg, /--require-drive/);
        assert.match(backupShCfg, /REQUIRE_DRIVE_BACKUP/);
        assert.match(backupShCfg, /lsf "\$\{REMOTE_NAME\}:\$\{REMOTE_DIR\}" --include "respaldo_mood_tracker\.sql\.gz"/);
        const verifyUbuntuSh = readText('scripts/verify-ubuntu-local.sh');
        assert.match(verifyUbuntuSh, /\[9\/10\].*Google Drive/);
        assert.match(verifyUbuntuSh, /\[10\/10\].*Blindaje/);
        assert.match(verifyUbuntuSh, /Strict-Transport-Security/);
        assert.match(verifyUbuntuSh, /426/);
        assert.match(verifyUbuntuSh, /evil\.example/);
        assert.match(verifyUbuntuSh, /respaldo_mood_tracker\.sql\.gz/);
        assert.match(verifyUbuntuSh, /\/etc\/ufw\/ufw\.conf/);
        assert.match(verifyUbuntuSh, /systemctl is-active --quiet ufw/);
        assert.match(verifyUbuntuSh, /msoffcrypto\.OfficeFile/);
        assert.match(verifyUbuntuSh, /PY_CHECK=.*\b2>&1\)/s);
        assert.match(verifyUbuntuSh, /-ge 40/);
        assert.match(verifyUbuntuSh, /-lt 85/);
        assert.match(verifyUbuntuSh, /-lt 5/);
        assert.match(readText('.gitignore'), /^node_modules\/$/m);

        const ubuntuGuide = readText('guides/GUIA_INSTALACION_UBUNTU_SERVER_26.md');
        assert.match(ubuntuGuide, /authorized_keys/);
        assert.match(ubuntuGuide, /NOPASSWD:ALL/);
        assert.match(ubuntuGuide, /TS_OAUTH_CLIENT_ID/);
        assert.match(ubuntuGuide, /SERVER_SSH_KEY/);
        assert.match(ubuntuGuide, /--require-drive/);
        assert.match(ubuntuGuide, /hidepid=2/);
        assert.match(ubuntuGuide, /fail2ban/);
        assert.match(ubuntuGuide, /unattended-upgrades/);
        assert.match(ubuntuGuide, /tcp_syncookies/);
        assert.match(ubuntuGuide, /auditd/);
    });

    it('mantiene sincronizadas las variables env y envs en deploy.yml sin dejar .env en disco', () => {
        const deploy = readText('.github/workflows/deploy.yml');
        const envSection = deploy.match(/uses:\s*appleboy\/ssh-action@[^\r\n]+\r?\n\s+env:\r?\n([\s\S]*?)\r?\n\s+with:/);
        assert.ok(envSection, 'No se encontró bloque env: en el paso ssh-action de deploy.yml');
        const envKeys = [...envSection[1].matchAll(/^\s+([A-Z0-9_]+):/gm)].map((m) => m[1]);

        const envsLine = deploy.match(/\benvs:\s*([^\r\n]+)/);
        assert.ok(envsLine, 'No se encontró línea envs: en deploy.yml');
        const forwardedKeys = envsLine[1].split(',').map((s) => s.trim()).filter(Boolean);

        for (const key of envKeys) {
            assert.ok(
                forwardedKeys.includes(key),
                `La variable ${key} está en env: pero falta en envs: de ssh-action`
            );
        }

        // Validación de Tailscale CI OAuth sin evaluar secrets.* dentro de expresiones if:
        assert.match(deploy, /uses:\s*tailscale\/github-action@v3/);
        assert.match(deploy, /steps\.ts_mode\.outputs\.mode\s*==\s*'oauth'/);
        assert.equal(/if:\s*[^\r\n]*\bsecrets\./.test(deploy), false, 'GitHub Actions no permite secrets.* dentro de expresiones if:');
        assert.match(deploy, /SERVER_HOST/);
        assert.match(deploy, /SERVER_SSH_KEY/);
        assert.match(deploy, /SECRET_DB_RETENTION_DAYS/);
        assert.match(deploy, /SECRET_REQUIRE_DRIVE_BACKUP/);
        assert.match(deploy, /SECRET_REQUIRE_HTTPS/);
        assert.match(deploy, /SECRET_REQUIRE_PC_BRIDGE_AUTH/);
        assert.match(deploy, /SECRET_CORS_ALLOWED_ORIGINS/);
        assert.match(deploy, /APP_UID=/);
        assert.match(deploy, /docker exec -u 0 mood_app_blue yt-dlp -U/);
        assert.match(deploy, /docker exec -u 0 mood_app_green yt-dlp -U/);
        assert.match(deploy, /printf 'DB_RETENTION_DAYS=%s\\n' "\$FINAL_DB_RETENTION_DAYS"/);

        assert.match(deploy, /cleanup_deploy_env/);
        assert.match(deploy, /git remote set-url origin "https:\/\/github\.com\/\$\{GITHUB_REPO\}\.git"/);
        assert.match(deploy, /\/swapfile/);
        assert.match(deploy, /fallocate -l 2G \/swapfile/);
        assert.match(deploy, /swapon\s+\/swapfile/);
        assert.match(deploy, /vm\.swappiness=15/);
        assert.match(deploy, /vm\.vfs_cache_pressure=50/);
        assert.match(deploy, /apt-get upgrade -y/);
        assert.match(deploy, /\bffmpeg\b/);
        assert.match(deploy, /yt-dlp -U/);
        assert.ok(
            deploy.indexOf('/swapfile') < deploy.indexOf('# 1. Instalar dependencias base'),
            'El paso de activación Swap debe ejecutarse primero al entrar por SSH antes de instalar dependencias'
        );
        assert.match(deploy, /BACKUP_CRON_SCHEDULE:-30 3 \* \* \*/);
        assert.match(deploy, /SEAL_ENV_AFTER_DEPLOY:-true/);
        assert.match(deploy, /SECRET_YT_DLP_PATH/);

        // Automatización integral de Ubuntu Server y configuración vía GitHub Variables
        assert.match(deploy, /concurrency:\r?\n\s+group:\s*deploy-main\r?\n\s+cancel-in-progress:\s*false/);
        assert.match(deploy, /vars\.TS_OAUTH_CLIENT_ID\s*\|\|\s*secrets\.TS_OAUTH_CLIENT_ID/);
        assert.match(deploy, /git init/);
        assert.match(deploy, /git fetch origin main/);
        assert.match(deploy, /git reset --hard origin\/main/);
        assert.equal(/git clone\s+["']?https:\/\/github\.com/.test(deploy), false, 'deploy.yml debe usar git init + fetch para no fallar si data/ ya existe');
        for (const token of [
            'DEPLOY_VIA_TAILSCALE',
            'SECRET_TRUST_PROXY',
            'SECRET_SERVER_SUDO_PASS',
            'SUDO_ASKPASS',
            'sudo -A',
            'sudo -k',
            'cleanup_sudo_askpass_files',
            '/etc/cron.d/dailyhub-sys-update',
            'AUTO_CONFIGURE_SERVER',
            'ENABLE_TAILSCALE_SERVE',
            'UFW_CLOSE_LAN_SSH',
            'tailscale serve --bg',
            'ufw default deny incoming',
            'systemctl mask sleep.target',
            '99-dailyhub-ignore-lid.conf',
            '99-security-dos.conf',
            'tcp_syncookies',
            'hidepid=2',
            '99-hardening.conf',
            'sshd -t',
            'fail2ban',
            'unattended-upgrades',
            '99-dailyhub-watch.rules',
            './scripts/verify-ubuntu-local.sh'
        ]) {
            assert.ok(deploy.includes(token), `deploy.yml debe incluir ${token} para automatización completa del servidor`);
        }

        const ubuntuGuide = readText('guides/GUIA_INSTALACION_UBUNTU_SERVER_26.md');
        for (const guideToken of ['EC2_SSH_KEY', 'SERVER_SUDO_PASS', 'AUTO_CONFIGURE_SERVER', 'UFW_CLOSE_LAN_SSH', 'ENABLE_TAILSCALE_SERVE']) {
            assert.ok(ubuntuGuide.includes(guideToken), `GUIA_INSTALACION_UBUNTU_SERVER_26.md debe documentar ${guideToken}`);
        }

        const ci = readText('.github/workflows/ci.yml');
        assert.match(ci, /branches-ignore:\r?\n\s+-\s*main/);
        assert.match(ci, /pull_request:\r?\n\s+branches:\r?\n\s+-\s*main/);
        assert.match(ci, /GITHUB_STEP_SUMMARY|ci-summary\.js/);
    });
});

describe('Modo Oscuro Permanente, Motor Bilingüe EN/ES y Guía Visual Interactiva', () => {
    it('mantiene modo oscuro permanente sin botones de tema claro en HTML/JS', () => {
        const indexHtml = readText('public/index.html');
        const dashHtml = readText('public/dashboard.html');
        const popupHtml = readText('public/translator-popup.html');
        const guideHtml = readText('public/guia-visual.html');
        const themeInit = readText('public/theme-init.js');

        assert.match(indexHtml, /<html\b[^>]*lang=["']en["'][^>]*data-theme=["']dark["']/i);
        assert.match(dashHtml, /<html\b[^>]*lang=["']en["'][^>]*data-theme=["']dark["']/i);
        assert.match(popupHtml, /<html\b[^>]*data-theme=["']dark["']/i);
        assert.match(guideHtml, /<html\b[^>]*data-theme=["']dark["']/i);
        assert.match(themeInit, /data-theme.*dark|setAttribute\(['"]data-theme['"],\s*['"]dark['"]\)/);

        for (const removedId of ['id="btnThemeToggle"', 'id="btnThemeToggleMobile"', 'id="btnThemeToggleAuth"', 'id="setTheme"', 'id="btnPopupThemeToggle"']) {
            assert.equal(indexHtml.includes(removedId), false, `index.html no debe reintroducir ${removedId}`);
            assert.equal(popupHtml.includes(removedId), false, `translator-popup.html no debe reintroducir ${removedId}`);
        }

        // CSP estricto sin script inline en guia-visual.html ni translator-popup.html
        assert.equal(/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(guideHtml), false, 'guia-visual.html no debe contener <script> inline');
        assert.match(guideHtml, /<script\s+src=["']theme-init\.js["'][^>]*><\/script>/i);
        assert.match(guideHtml, /<script\s+src=["']i18n\.js["'][^>]*><\/script>/i);
        assert.match(guideHtml, /<script\s+src=["']guia-visual\.js["'][^>]*><\/script>/i);
        assert.match(guideHtml, /id=["']visualGuideStandaloneHost["']/);
    });

    it('expone controles EN/ES y Guía Visual en index.html y popup', () => {
        const indexHtml = readText('public/index.html');
        const popupHtml = readText('public/translator-popup.html');

        for (const requiredAttr of [
            'id="btnLangToggleSidebar"',
            'id="btnLangToggleMobile"',
            'id="btnLangToggleAuth"',
            'id="btnSettingsLangToggle"',
            'id="setUiLanguage"',
            'data-view="guia"',
            'id="view-guia"',
            'id="visualGuideAppHost"'
        ]) {
            assert.ok(indexHtml.includes(requiredAttr), `public/index.html debe incluir ${requiredAttr}`);
        }

        assert.ok(popupHtml.includes('id="btnPopupLangToggle"'), 'translator-popup.html debe incluir #btnPopupLangToggle');
        assert.ok(popupHtml.includes('src="i18n.js"'), 'translator-popup.html debe cargar i18n.js');
    });

    it('verifica traducciones EN <-> ES, HTML_BLOCKS y conservación de claves MySQL en public/i18n.js y public/guia-visual.js', () => {
        const i18nCode = readText('public/i18n.js');
        const guideCode = readText('public/guia-visual.js');

        const store = new Map();
        const sandboxWindow = {
            localStorage: {
                getItem: (k) => (store.has(k) ? store.get(k) : null),
                setItem: (k, v) => store.set(k, String(v)),
                removeItem: (k) => store.delete(k)
            },
            document: {
                readyState: 'complete',
                documentElement: { lang: 'en', style: {}, setAttribute: () => {}, classList: { add: () => {}, remove: () => {} } },
                body: null,
                getElementById: () => null,
                querySelectorAll: () => [],
                createTreeWalker: () => ({ nextNode: () => null }),
                addEventListener: () => {}
            },
            addEventListener: () => {}
        };
        sandboxWindow.window = sandboxWindow;
        const ctx = vm.createContext({
            window: sandboxWindow,
            document: sandboxWindow.document,
            localStorage: sandboxWindow.localStorage,
            NodeFilter: { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 },
            MutationObserver: class { observe() {} },
            console
        });

        vm.runInContext(i18nCode, ctx, { filename: 'public/i18n.js' });
        vm.runInContext(guideCode, ctx, { filename: 'public/guia-visual.js' });

        const i18n = sandboxWindow.DailyHubI18n;
        const guide = sandboxWindow.DailyHubVisualGuide;
        assert.ok(i18n && typeof i18n.setLang === 'function', 'DailyHubI18n debe exportarse');
        assert.ok(guide && Array.isArray(guide.SECTIONS) && guide.SECTIONS.length >= 4, 'DailyHubVisualGuide.SECTIONS debe exportarse');
        for (const sec of guide.SECTIONS) {
            assert.ok(sec.badgeEn && sec.badgeEs, `Sección visual ${sec.id} debe incluir badgeEn y badgeEs`);
        }

        // Verificar que todo data-i18n-html usado en HTML exista en HTML_BLOCKS
        for (const htmlFile of ['public/index.html', 'public/translator-popup.html', 'public/guia-visual.html']) {
            const rawHtml = readText(htmlFile);
            for (const m of rawHtml.matchAll(/data-i18n-html=["']([^"']+)["']/g)) {
                const key = m[1];
                assert.ok(i18n.HTML_BLOCKS[key], `Falta HTML_BLOCKS["${key}"] usado en ${htmlFile}`);
                assert.ok(i18n.HTML_BLOCKS[key].en && i18n.HTML_BLOCKS[key].es, `HTML_BLOCKS["${key}"] debe tener .en y .es`);
            }
        }

        // Roundtrip ES <-> EN + preservación de claves MySQL
        i18n.setLang('es', { silent: true });
        assert.equal(i18n.getLang(), 'es');
        assert.equal(i18n.translateText('Home'), 'Inicio');
        assert.equal(i18n.momentLabel('Madrugada'), 'Madrugada');
        assert.equal(i18n.agendaStatusLabel('in_progress'), 'En progreso');
        assert.match(i18n.translateServerMessage('Synced 3 schedule item(s) to Weekly Agenda.'), /Se sincronizaron 3 actividades a tu Agenda Semanal/i);
        assert.match(i18n.translateServerMessage('Selected class was not found in your semester schedule.'), /La clase seleccionada no se encontró/i);
        assert.equal(i18n.translateText('🎓 All Classes'), '🎓 Todas las clases');

        i18n.setLang('en', { silent: true });
        assert.equal(i18n.getLang(), 'en');
        assert.equal(i18n.translateText('Inicio'), 'Home');
        assert.equal(i18n.momentLabel('Madrugada'), 'Late Night');
        assert.equal(i18n.agendaStatusLabel('in_progress'), 'In Progress');
        assert.match(i18n.translateServerMessage('Sin traducción exacta en diccionario local (Gemini HTTP 404)'), /No exact match in local dictionary \(Gemini HTTP 404\)/i);

        const indexHtml = readText('public/index.html');
        const frontendJs = readText('public/frontend.js');
        assert.ok(indexHtml.includes('id="agendaCourseFilter"'), 'index.html debe exponer filtro de clase actual en Agenda');
        assert.ok(indexHtml.includes('id="agendaMateriaId"') && indexHtml.includes('id="agendaMateriaGroup"'), 'index.html debe exponer selector de materia universitaria');
        assert.ok(frontendJs.includes('resolveAgendaItemClassLabel') && frontendJs.includes('syncAgendaMateriaFieldUI'), 'frontend.js debe vincular tareas universitarias con clases actuales');
    });

    it('adapta lib/language-studio.js al idioma uiLang (en vs es) sin envenenar languageMemory', async () => {
        const langStudio = require('../lib/language-studio');
        assert.equal(langStudio.normalizeUiLang('en-US'), 'en');
        assert.equal(langStudio.normalizeUiLang('es-MX'), 'es');
        assert.equal(langStudio.normalizeUiLang(undefined), 'es');

        const offlineEs = langStudio.translateOffline({ text: 'not_in_dict_xyz', direction: 'en_es' });
        assert.match(offlineEs.explanationEs, /Google Gemini API en Ajustes/i);
        assert.equal(langStudio.isPoisonedMemoryMeaning(offlineEs.explanationEs), true);

        const offlineEn = langStudio.translateOffline({ text: 'not_in_dict_xyz', direction: 'en_es', uiLang: 'en' });
        assert.match(offlineEn.explanationEs, /Enable Google Gemini API in Settings/i);
        assert.equal(langStudio.isPoisonedMemoryMeaning(offlineEn.explanationEs), true);

        const analyzeEn = langStudio.analyzeTextOffline({ text: '사랑해\nI hold on', language: 'en_ko', uiLang: 'en' });
        const analyzeEs = langStudio.analyzeTextOffline({ text: '사랑해\nI hold on', language: 'en_ko', uiLang: 'es' });
        assert.match(analyzeEn.summary, /Instant Local Analysis/i);
        assert.match(analyzeEs.summary, /Análisis Local Instantáneo/i);
    });
});

describe('Versionado Automático SemVer 2.0.0 e Historial de Despliegues', () => {
    it('calcula incrementos MAJOR/MINOR/PATCH con Conventional Commits y actualiza artefactos de versión', () => {
        const relMod = require('../scripts/release-version');

        assert.deepEqual(relMod.parseSemver('v1.2.3'), { major: 1, minor: 2, patch: 3 });
        assert.equal(relMod.bumpSemver('1.0.0', 'patch'), '1.0.1');
        assert.equal(relMod.bumpSemver('1.0.1', 'minor'), '1.1.0');
        assert.equal(relMod.bumpSemver('1.1.0', 'major'), '2.0.0');

        assert.equal(relMod.classifyCommit({ sha: 'a1', subject: 'fix: resolve agenda pill crash' }).kind, 'fix');
        assert.equal(relMod.classifyCommit({ sha: 'a2', subject: 'feat(ui): add version history modal' }).kind, 'feature');
        assert.equal(relMod.classifyCommit({ sha: 'a3', subject: 'feat!: redesign auth schema' }).kind, 'breaking');
        assert.equal(relMod.classifyCommit({ sha: 'a4', subject: 'chore: docs', body: 'BREAKING CHANGE: drop legacy v0' }).kind, 'breaking');
        assert.equal(relMod.analyzeCommits([{ sha: 'a1', subject: 'fix: resolve agenda pill crash' }]).bumpType, 'patch');
        assert.equal(relMod.analyzeCommits([{ sha: 'a2', subject: 'feat(ui): add version history modal' }]).bumpType, 'minor');
        assert.equal(relMod.analyzeCommits([{ sha: 'a3', subject: 'feat!: redesign auth schema' }]).bumpType, 'major');

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdh-semver-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'tmp-hub', version: '1.0.0' }, null, 2));
            fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), JSON.stringify({ name: 'tmp-hub', version: '1.0.0', lockfileVersion: 3, packages: { '': { version: '1.0.0' } } }, null, 2));

            const r1 = relMod.runRelease({
                cwd: tmpDir,
                apply: true,
                headShaOverride: 'abc1234',
                releasedAt: '2026-11-15T10:00:00.000Z',
                commitsOverride: [{ sha: 'abc1234', subject: 'fix(audio): repair range header check', body: '' }]
            });
            assert.equal(r1.nextVersion, '1.0.1');
            assert.equal(r1.bumpType, 'patch');

            const r2 = relMod.runRelease({
                cwd: tmpDir,
                apply: true,
                headShaOverride: 'def5678',
                releasedAt: '2026-11-15T11:00:00.000Z',
                commitsOverride: [
                    { sha: 'def5677', subject: 'fix: typo in tooltip', body: '' },
                    { sha: 'def5678', subject: 'feat: link tasks to semester classes', body: '' }
                ]
            });
            assert.equal(r2.nextVersion, '1.1.0');
            assert.equal(r2.bumpType, 'minor');

            const pkgAfter = JSON.parse(fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf8'));
            const lockAfter = JSON.parse(fs.readFileSync(path.join(tmpDir, 'package-lock.json'), 'utf8'));
            const historyAfter = JSON.parse(fs.readFileSync(path.join(tmpDir, 'version-history.json'), 'utf8'));
            const changelogAfter = fs.readFileSync(path.join(tmpDir, 'CHANGELOG.md'), 'utf8');

            assert.equal(pkgAfter.version, '1.1.0');
            assert.equal(lockAfter.version, '1.1.0');
            assert.equal(lockAfter.packages[''].version, '1.1.0');
            assert.equal(historyAfter.currentVersion, '1.1.0');
            assert.equal(historyAfter.releases.length, 2);
            assert.equal(historyAfter.releases[0].tag, 'v1.1.0');
            assert.equal(historyAfter.releases[1].tag, 'v1.0.1');
            assert.match(changelogAfter, /## \[v1\.1\.0\]/);
            assert.match(changelogAfter, /## \[v1\.0\.1\]/);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('integra auto-versionado en deploy.yml, Dockerfile y UI modal de Version History', () => {
        const deploy = readText('.github/workflows/deploy.yml');
        const dockerfile = readText('Dockerfile');
        const historyJson = JSON.parse(readText('version-history.json'));
        const changelog = readText('CHANGELOG.md');
        const indexHtml = readText('public/index.html');
        const styleCss = readText('public/style.css');
        const frontendJs = readText('public/frontend.js');

        assert.match(deploy, /scripts\/release-version\.js\s+--apply\s+--github-output/);
        assert.match(deploy, /permissions:\r?\n\s+contents:\s*write/);
        assert.match(deploy, /needs:\s*release/);
        assert.match(deploy, /APP_VERSION/);
        assert.match(deploy, /RELEASE_HISTORY_B64/);
        assert.match(dockerfile, /version-history\.json/);
        assert.match(dockerfile, /CHANGELOG\.md/);
        assert.match(String(historyJson.standard), /SemVer 2\.0\.0/);
        assert.ok(Array.isArray(historyJson.releases) && historyJson.releases.length >= 1);
        assert.match(changelog, /^# Historial de Versiones/m);

        for (const id of ['id="btnOpenVersionHistory"', 'id="sidebarVersionText"', 'id="btnSettingsVersionHistory"', 'id="versionHistoryModal"', 'id="versionHistoryBody"']) {
            assert.ok(indexHtml.includes(id), `public/index.html debe incluir ${id}`);
        }
        assert.ok(styleCss.includes('.ver-badge') && styleCss.includes('.version-history-list'));
        assert.ok(frontendJs.includes('cargarVersionInfo') && frontendJs.includes('initVersionHistoryHandlers'));
    });

    it('verifica integridad lógica de DOM IDs en frontend.js y ausencia de llaves duplicadas en public/i18n.js', () => {
        const indexHtml = readText('public/index.html');
        const frontendJs = readText('public/frontend.js');
        assert.ok(indexHtml.includes('id="englishForm"'));
        assert.ok(!frontendJs.includes('englishPracticeForm'), 'frontend.js no debe referenciar #englishPracticeForm inexistente');
        assert.ok(frontendJs.includes("getElementById('englishForm')?.scrollIntoView"));

        const i18nSrc = readText('public/i18n.js');
        const m = i18nSrc.match(/(?:const|var|let)\s+PAIRS\s*=\s*(\[[\s\S]*?\r?\n\s*\]);/);
        assert.ok(m, 'No se pudo localizar PAIRS en public/i18n.js');
        const pairs = vm.runInNewContext(`(${m[1]})`, Object.create(null));
        const seen = new Map();
        const duplicates = [];
        for (const [en] of pairs) {
            seen.set(en, (seen.get(en) || 0) + 1);
            if (seen.get(en) === 2) duplicates.push(en);
        }
        assert.deepEqual(duplicates, [], `Llaves EN duplicadas en public/i18n.js: ${duplicates.join(', ')}`);
    });
});

describe('Arquitectura Fases 1-5: Plug-and-Play Cloud, Caddy HTTPS, Dual Drive, Campus y Word Bloque A/B', () => {
    it('elimina credenciales, rutas locales y repositorios hardcodeados (Cloud Agnostic)', () => {
        for (const file of ['.env.example', 'docker-compose.yml', '.github/workflows/deploy.yml', 'server.js']) {
            const text = readText(file);
            assert.equal(/flavio\.flax1234@gmail\.com/i.test(text), false, `${file} no debe hardcodear correo personal`);
            assert.equal(/C:\\\\Users\\\\flavi|C:\\Users\\flavi/i.test(text), false, `${file} no debe hardcodear rutas locales Windows de usuario`);
        }
        for (const absPath of [SYNC_PY_PATH, YT_HELPER_PY_PATH]) {
            assert.ok(fs.existsSync(absPath), `No se encontró ${absPath} (ruta resuelta desde la raíz del proyecto)`);
            const text = fs.readFileSync(absPath, 'utf8');
            const rel = path.relative(ROOT, absPath);
            assert.equal(/flavio\.flax1234@gmail\.com/i.test(text), false, `${rel} no debe hardcodear correo personal`);
            assert.equal(/C:\\\\Users\\\\flavi|C:\\Users\\flavi/i.test(text), false, `${rel} no debe hardcodear rutas locales Windows de usuario`);
        }

        const caddyfile = readText('Caddyfile');
        assert.match(caddyfile, /import\s+\/etc\/caddy\/state\/upstream\.caddy/);
        assert.match(caddyfile, /tls internal/);
        assert.match(caddyfile, /max_size\s+16MB/);
        assert.match(caddyfile, /header -Server/);

        const compose = readText('docker-compose.yml');
        assert.match(compose, /caddy:2-alpine/);
        assert.match(compose, /STUDY_RCLONE_REMOTE/);
        assert.match(compose, /STUDY_RCLONE_CONF_B64/);
    });

    it('verifica coordenadas oficiales TecNM Saltillo, responsividad OPPO A79, Dual Drive y Guías nuevas', () => {
        const indexHtml = readText('public/index.html');
        const styleCss = readText('public/style.css');
        const frontendJs = readText('public/frontend.js');
        const serverJs = readText('server.js');

        assert.match(serverJs, /25\.4414/);
        assert.match(serverJs, /-100\.9922/);
        assert.match(serverJs, /25\.4385/);
        assert.match(serverJs, /-100\.994/);
        assert.match(serverJs, /25\.4194/);
        assert.match(serverJs, /-101\.0232/);

        assert.match(styleCss, /position:\s*fixed/);
        assert.match(styleCss, /orientation:\s*landscape/);
        assert.match(styleCss, /mobile-landscape-song-study/);

        assert.equal(indexHtml.includes('id="semanaSeleccionada"'), false);
        assert.equal(indexHtml.includes('id="btnLoadDriveMonthsRam"'), false, 'La UI no debe exponer botones manuales de Google Drive al usuario');
        assert.equal(indexHtml.includes('id="resumenDriveMonthsSelect"'), false, 'La UI no debe exponer selector manual de Drive al usuario');
        assert.equal(indexHtml.includes('id="setDriveStudySyncEnabled"'), false, 'La sincronización Drive debe ser automática, no configurable en UI');
        assert.equal(indexHtml.includes('id="setDriveStudyDir"'), false, 'La carpeta Drive no debe quedar expuesta en Configuración UI');
        assert.equal(frontendJs.includes('/lyrics/extract'), false, 'frontend no debe depender del endpoint antiguo de extracción bloqueada');
        assert.ok(frontendJs.includes('/resolve-lyrics'), 'frontend debe usar /resolve-lyrics autónomo en la nube');
        assert.equal(frontendJs.includes('/media'), false, 'frontend debe usar embeds oficiales y nunca descargar audio/video al servidor');
        assert.ok(frontendJs.includes('play_on_pc') && frontendJs.includes('onError'));

        const backupSh = readText('scripts/backup.sh');
        assert.match(backupSh, /ARCHIVE_READY/, 'backup.sh debe verificar respaldo histórico antes de purgar registros > 30 días');
        assert.match(backupSh, /historico_sql\/respaldo_/, 'backup.sh debe conservar instantáneas mensuales SQL completas en Drive');
        assert.match(serverJs, /buildSafeRcloneExecEnv/, 'server.js debe limpiar variables RCLONE_* al invocar rclone CLI');

        const cmdGuide = readText('guides/GUIA_COMANDOS.md');
        const unifiedGuide = readText('guides/GUIA_TECNICA_UNIFICADA.md');
        assert.match(cmdGuide, /\| Parámetro/);
        assert.match(cmdGuide, /Git Bash/i);
        assert.match(cmdGuide, /Ubuntu|Linux/i);
        assert.ok(unifiedGuide.includes('blue-green.sh'), 'GUIA_TECNICA_UNIFICADA.md debe documentar blue-green.sh');
        assert.ok(unifiedGuide.includes('rollback.yml'), 'GUIA_TECNICA_UNIFICADA.md debe documentar rollback.yml');
        assert.ok(unifiedGuide.includes('SyncRevisions'), 'GUIA_TECNICA_UNIFICADA.md debe documentar SyncRevisions SSE');
        assert.match(unifiedGuide, /Gratuito/i);
        assert.match(unifiedGuide, /Pago/i);
        assert.match(unifiedGuide, /Dual Drive|STUDY_RCLONE/i);
        assert.match(unifiedGuide, /Google Cloud Platform|GCP/i);
        assert.match(unifiedGuide, /Ubuntu/i);

        for (const removedStudyId of [
            'id="studyViewerArtistFilter"',
            'id="studyViewerAlbumFilter"',
            'id="studyViewerSongFilter"',
            'id="studyViewerLangFilter"',
            'id="studyViewerNotebookLangFilter"',
            'id="studyViewerLanguageApartments"'
        ]) {
            assert.equal(indexHtml.includes(removedStudyId), false, `public/index.html debe retirar el filtro obsoleto ${removedStudyId}`);
        }
        assert.ok(indexHtml.includes('id="studyViewerSectionFilter"'));
        assert.ok(indexHtml.includes('id="studyViewerSearchInput"'));
        assert.ok(indexHtml.includes('id="btnRefreshStudyViewer"'));
        assert.match(indexHtml, /id="btnRefreshStudyViewer"[\s\S]*?<svg\b/i);
        assert.equal(/id="btnRefreshStudyViewer"[^>]*>[^<]*Recargar/i.test(indexHtml), false, 'El botón #btnRefreshStudyViewer solo debe mostrar ícono SVG sin texto Recargar');
        assert.ok(indexHtml.includes('id="btnOpenStudyViewerFromMusic"'));
        assert.ok(styleCss.includes('modal-scroll-locked'), 'public/style.css debe definir modal-scroll-locked');
        assert.ok(styleCss.includes('overscroll-behavior: contain'), 'public/style.css debe aislar scroll con overscroll-behavior: contain');
        assert.ok(frontendJs.includes('initGlobalModalScrollLock'), 'public/frontend.js debe definir e invocar initGlobalModalScrollLock');

        const langStudio = require(path.join(ROOT, 'lib', 'language-studio.js'));
        assert.equal(typeof langStudio.parseStudyNotebookDocxBuffer, 'function');
        assert.equal(typeof langStudio.filterStudyNotebookData, 'function');
        assert.equal(typeof langStudio.findNotebookTranslationMatch, 'function');
        assert.equal(langStudio.parseStudyNotebookDocxBuffer(Buffer.from('PK\x03\x04invalid')).ok, false);
        const synMatch = langStudio.findNotebookTranslationMatch({
            allEntries: [{
                section: 'music',
                title: 'Test Track',
                artist: 'Test Artist',
                fields: {
                    lyrics_study: '[EN]\nHello world line one\n=== [ES — Traducción IA] ===\nHola mundo línea uno'
                }
            }]
        }, { songTitle: 'Test Track', artistName: 'Test Artist', mode: 'lyrics' });
        assert.equal(synMatch?.hit, true);
        assert.match(synMatch?.spanishLyrics || '', /Hola mundo línea uno/);

        assert.equal(typeof langStudio.findNotebookSongEntry, 'function');
        const songNbMatch = langStudio.findNotebookSongEntry({
            allEntries: [{
                section: 'music',
                title: 'Track Without ES',
                artist: 'Test Artist',
                album: 'Test Album',
                trackNumber: 4,
                fields: {
                    lyrics_study: 'Line one\nLine two',
                    vocabulary_list: 'fade: desvanecerse'
                }
            }]
        }, { songTitle: 'Track Without ES', artistName: 'Test Artist', albumTitle: 'Test Album' });
        assert.equal(songNbMatch?.lyrics, 'Line one\nLine two');
        assert.equal(songNbMatch?.trackNumber, 4);
        assert.equal(songNbMatch?.fields?.vocabulary_list, 'fade: desvanecerse');

        // Regresión Fase Japonés (JP / JP-EN), Romaji y Guía de Comandos en 1ª página
        assert.match(cmdGuide.slice(0, 3200), /Stop-Process[\s\S]*sincronizador\.py/);
        assert.match(cmdGuide.slice(0, 4200), /--configurar-autoinicio/);
        assert.ok(indexHtml.includes('data-study-lang="ja"') && indexHtml.includes('data-study-lang="en_ja"'));
        assert.equal(langStudio.normalizeStudyLanguage('jp-en'), 'en_ja');
        assert.equal(langStudio.normalizeStudyLanguage('日本語'), 'ja');
        assert.equal(langStudio.detectScriptKind('夢を見る midnight'), 'mixed-jpop');
        assert.equal(langStudio.detectScriptKind('ずっとありがとう'), 'japanese');
        assert.equal(langStudio.kanaToRomaji('ずっとありがとう'), 'zuttoarigatou');
        const romWithKanji = langStudio.kanaToRomaji('愛してる shining star');
        assert.match(romWithKanji, /aishiteru/i);
        assert.match(romWithKanji, /shining star/);
        const jaOff = langStudio.translateOffline({ text: 'ありがとう', direction: 'auto', uiLang: 'es' });
        assert.equal(jaOff.direction, 'ja_es');
        assert.match(jaOff.translatedText, /Gracias/i);
        const jpEnAnalysis = langStudio.analyzeTextOffline({ text: 'Shining star\n夢を見る', language: 'en_ja', uiLang: 'es' });
        assert.equal(jpEnAnalysis.language, 'en_ja');
        assert.ok(jpEnAnalysis.lines.some((l) => l.script === 'japanese' && /yume/i.test(l.romanization)));

        // Regresión UX Modo Estudio: Traductor flotante con header fijo + cuerpo con scroll, limpieza automática de selección, móvil amplio e íconos SVG semánticos
        assert.ok(styleCss.includes('.floating-translate-sel-btn'), 'style.css debe definir .floating-translate-sel-btn');
        assert.ok(styleCss.includes('.floating-translator-body'), 'style.css debe definir .floating-translator-body');
        assert.match(styleCss, /\.floating-translator-header[\s\S]*?flex-shrink:\s*0/, 'style.css debe mantener fija .floating-translator-header');
        assert.match(styleCss, /min\(96vw,\s*440px\)/, 'style.css debe definir ancho móvil ampliado min(96vw, 440px)');
        assert.match(styleCss, /86dvh/, 'style.css debe definir altura máxima móvil vertical en 86dvh');
        assert.match(styleCss, /calc\(100dvh\s*-\s*16px\)/, 'style.css debe limitar altura en paisaje a calc(100dvh - 16px)');
        assert.match(styleCss, /touch-action:\s*none/, 'style.css debe incluir touch-action: none para arrastre táctil fluido');
        assert.ok(frontendJs.includes('orientationchange'), 'frontend.js debe recalcular coordenadas flotantes en orientationchange');
        assert.ok(frontendJs.includes('selectionchange'), 'frontend.js debe escuchar selectionchange para mostrar Traducir Selección');
        assert.ok(frontendJs.includes('clearActiveTextSelection') && frontendJs.includes('removeAllRanges'), 'frontend.js debe deseleccionar automáticamente el texto al traducir selección');
        assert.ok((indexHtml.match(/<svg class="ui-icon"/g) || []).length >= 20, 'public/index.html debe usar íconos SVG inline uniformes en navegación, vistas y tarjetas');
        assert.ok(frontendJs.includes('extractLyricsForActiveLanguage'), 'frontend.js debe filtrar estrofas por el idioma seleccionado');

        // Verificación funcional en VM de parseAndDivideLyricsByLanguage + extractLyricsForActiveLanguage
        const vm = require('node:vm');
        const extractFnBlock = (name, nextFnName) => {
            const start = frontendJs.indexOf(`function ${name}(`);
            assert.ok(start >= 0, `Debe existir function ${name} en frontend.js`);
            const end = frontendJs.indexOf(`function ${nextFnName}(`, start);
            assert.ok(end > start, `Debe existir límite ${nextFnName} tras ${name}`);
            return frontendJs.slice(start, end);
        };
        const sandbox = {};
        vm.runInNewContext([
            extractFnBlock('_isolateHangulLinesClient', 'renderLyricsSectionsIntoContainer'),
            extractFnBlock('_isStructuralLyricTagClient', 'renderReadonlyLyricsByLanguage')
        ].join('\n'), sandbox);

        const multiLangSample = [
            '=== [ORIGINAL] ===',
            '사랑해 forever',
            '[saranghae forever]',
            'Shining night together',
            '=== [KO] ===',
            '사랑해',
            '[saranghae]',
            '영원히 함께해',
            '=== [EN] ===',
            'Shining night together',
            'Forever by my side',
            '=== [ES — Traducción IA] ===',
            'Te amo por siempre',
            'Noche brillante juntos'
        ].join('\n');

        const koFiltered = sandbox.extractLyricsForActiveLanguage(multiLangSample, 'ko');
        assert.equal(koFiltered.langCode, 'ko');
        assert.ok(koFiltered.text.includes('사랑해') && koFiltered.text.includes('영원히 함께해'));
        assert.equal(/saranghae|Shining night|Te amo/i.test(koFiltered.text), false, 'El filtro Coreano no debe incluir inglés, español ni romanización');

        const enFiltered = sandbox.extractLyricsForActiveLanguage(multiLangSample, 'en');
        assert.equal(enFiltered.langCode, 'en');
        assert.ok(enFiltered.text.includes('Shining night together') && enFiltered.text.includes('Forever by my side'));
        assert.equal(/사랑해|Te amo/i.test(enFiltered.text), false, 'El filtro Inglés no debe incluir coreano ni español');

        const origFiltered = sandbox.extractLyricsForActiveLanguage(multiLangSample, 'original');
        assert.equal(origFiltered.langCode, 'original');
        assert.ok(origFiltered.text.includes('사랑해 forever') && origFiltered.text.includes('Shining night together'));
        assert.equal(/Te amo por siempre/.test(origFiltered.text), false, 'El filtro Original no debe incluir el bloque de traducción al español');

        // K-Pop mixto sin etiqueta [EN] explícita ni etiquetas [ORIGINAL] visibles; y coreano puro sin pestaña Original redundante
        const dividedMixed = Array.from(sandbox.parseAndDivideLyricsByLanguage(
            '[ORIGINAL]\n끝없는 가치\nWhen I dress I don\'t think so much\n\n[KO]\n끝없는 가치\n\n[EN]\nWhen I dress I don\'t think so much'
        ));
        assert.deepEqual(dividedMixed.map(s => s.code), ['original', 'ko', 'en']);
        assert.equal(dividedMixed[0].lines.some(l => /^\[(?:ORIGINAL|EN|KO)\]$/i.test(l)), false, 'No deben quedar cabeceras [ORIGINAL]/[EN] en el cuerpo');

        const dividedPureKo = Array.from(sandbox.parseAndDivideLyricsByLanguage('', { original: '사랑해\n영원히', ko: '사랑해\n영원히', en: '', ja: '', es: '' }));
        assert.deepEqual(dividedPureKo.map(s => s.code), ['ko'], 'Canción en coreano puro debe renderizarse únicamente en Coreano puro');

        // Verificación exhaustiva de división de letras en todos los idiomas predefinidos (EN, KO, EN_KO, JA, EN_JA, ES, ORIGINAL, ALL)
        const adlibKpop = [
            '[EN_KO]',
            'Baby, 사랑해 (forever)!',
            '사랑해, baby, 영원히',
            '사랑해!',
            '사랑해 (영원히)',
            'Shining bright in the night'
        ].join('\n');
        const dividedAdlibKpop = Array.from(sandbox.parseAndDivideLyricsByLanguage(adlibKpop));
        assert.deepEqual(dividedAdlibKpop.map(s => s.code), ['original', 'ko', 'en']);
        const koSecAdlib = dividedAdlibKpop.find(s => s.code === 'ko');
        assert.deepEqual(
            Array.from(koSecAdlib.lines),
            ['사랑해', '사랑해, 영원히', '사랑해!', '사랑해 (영원히)'],
            'El apartado KO debe quitar palabras/ad-libs latinos con puntuación y conservar puntuación CJK real'
        );
        const enSecAdlib = dividedAdlibKpop.find(s => s.code === 'en');
        assert.equal(enSecAdlib.lines.join('\n'), 'Shining bright in the night');

        // J-Pop mixto (EN_JA) con structuredTracks solo en original + español
        const jpopMixed = Array.from(sandbox.parseAndDivideLyricsByLanguage('', {
            original: '愛してる, my love!\n夢を見る (tonight)\nShining bright in the dark',
            ko: '',
            en: '',
            ja: '',
            es: 'Te amo por siempre\nSueño esta noche'
        }));
        assert.deepEqual(jpopMixed.map(s => s.code), ['original', 'en', 'ja', 'es']);
        assert.deepEqual(Array.from(jpopMixed.find(s => s.code === 'ja').lines), ['愛してる', '夢を見る']);
        const jpopEnText = jpopMixed.find(s => s.code === 'en').lines.join('\n');
        assert.equal(jpopEnText, 'my love!\nShining bright in the dark');
        assert.equal(/tonight|愛してる|夢を見る|Te amo/i.test(jpopEnText), false);

        // Filtro 'en' en _cleanLinesForLanguageAnalysis debe rechazar español y extraer bloques multi-palabra en inglés
        const cleanedEn = Array.from(sandbox._cleanLinesForLanguageAnalysis([
            '사랑해 forever',
            '사랑해 shining night together',
            'Te amo por siempre',
            'Every single step'
        ], 'en'));
        assert.deepEqual(cleanedEn, ['shining night together', 'Every single step']);

        // Validar extractLyricsForActiveLanguage con los 6 filtros predefinidos + original + all
        const fullMulti = [
            '[ORIGINAL]',
            'Baby, 사랑해 (forever)!',
            'Shining night together',
            '[JA]',
            '愛してる, my love!',
            '夢を見る (tonight)',
            '[ES]',
            'Te amo por siempre',
            'Noche brillante juntos'
        ].join('\n');
        assert.equal(sandbox.extractLyricsForActiveLanguage(fullMulti, 'ko').text, '사랑해');
        assert.equal(sandbox.extractLyricsForActiveLanguage(fullMulti, 'en').text, 'Shining night together');
        assert.equal(sandbox.extractLyricsForActiveLanguage(fullMulti, 'ja').text, '愛してる\n夢を見る');
        assert.equal(sandbox.extractLyricsForActiveLanguage(fullMulti, 'es').text, 'Te amo por siempre\nNoche brillante juntos');
        assert.equal(sandbox.extractLyricsForActiveLanguage(fullMulti, 'en_ko').apiLanguage, 'en_ko');
        assert.ok(sandbox.extractLyricsForActiveLanguage(fullMulti, 'en_ko').text.includes('Baby, 사랑해 (forever)!'));
        assert.equal(sandbox.extractLyricsForActiveLanguage(fullMulti, 'en_ja').apiLanguage, 'en_ja');
        assert.equal(sandbox.extractLyricsForActiveLanguage(fullMulti, 'original').langCode, 'original');
        assert.equal(sandbox.extractLyricsForActiveLanguage(fullMulti, 'all').langCode, 'all');

        // Regla visual por idioma original: Inglés puro oculta pestaña EN; K-Pop y J-Pop conservan EN/KO/JA
        const pureEnSections = Array.from(sandbox.applySongLanguageSectionRulesClient(
            sandbox.parseAndDivideLyricsByLanguage(
                '[ORIGINAL]\nOh, hey now, come outside\n\n[EN]\nOh, hey now, come outside'
            ),
            'English'
        ));
        assert.deepEqual(pureEnSections.map(s => s.code), ['original']);
        const pureEnWithEs = Array.from(sandbox.applySongLanguageSectionRulesClient(
            sandbox.parseAndDivideLyricsByLanguage(
                '[ORIGINAL]\nOh, hey now, come outside\n\n[EN]\nOh, hey now, come outside\n\n[ES]\nSal afuera'
            ),
            'English'
        ));
        assert.deepEqual(pureEnWithEs.map(s => s.code), ['original', 'es']);
        const kpopVisSections = Array.from(sandbox.applySongLanguageSectionRulesClient(dividedMixed, 'en_ko'));
        assert.deepEqual(kpopVisSections.map(s => s.code), ['original', 'ko', 'en']);
        const jpopVisSections = Array.from(sandbox.applySongLanguageSectionRulesClient(jpopMixed, 'en_ja'));
        assert.deepEqual(jpopVisSections.map(s => s.code), ['original', 'en', 'ja', 'es']);
        assert.ok(frontendJs.includes('applySongLanguageSectionRulesClient(rawSections, songLanguage)'));

        // Regresión Planificador Semanal V2/V3: orden Título/Descripción arriba, Calendario fijo siempre visible, Personal vs Escuela separados y Drag & Drop con hora
        assert.equal(
            indexHtml.includes('id="btnToggleAgendaCalendar"'),
            false,
            'public/index.html debe eliminar el botón #btnToggleAgendaCalendar'
        );
        const fixedCalMatch = indexHtml.match(/<div[^>]*\bid="agendaCalendarDropdown"[^>]*>/i);
        assert.ok(fixedCalMatch, 'public/index.html debe incluir #agendaCalendarDropdown');
        assert.equal(
            /\bhidden\b/i.test(fixedCalMatch[0]),
            false,
            '#agendaCalendarDropdown debe mostrarse fijo y siempre visible (sin atributo hidden)'
        );

        for (const reqAgendaSel of [
            'id="agendaCalendarDropdown"',
            'id="agendaPersonalSection"',
            'id="agendaSchoolSection"',
            'id="agendaSchoolWeekBoard"',
            'id="agendaDropTimeModal"',
            'id="agendaDropTimeInput"',
            'id="agendaDropPositionHint"',
            'id="agendaDropRangeHint"',
            'id="agendaDropTightNote"',
            'id="agendaDropTimeError"',
            'id="btnConfirmAgendaDropTime"',
            'id="agendaModalQuickDateBar"',
            'id="agendaModalCalendarBox"',
            'id="agendaRepeatMode"',
            'id="agendaRepeatSummaryPreview"',
            'id="agendaPostponePopover"',
            'data-postpone-minutes="15"',
            'data-postpone-minutes="30"',
            'data-postpone-minutes="60"',
            'data-postpone-minutes="120"',
            'id="postponeCustomUnitSelect"',
            'value="skipped"'
        ]) {
            assert.ok(indexHtml.includes(reqAgendaSel), `public/index.html debe incluir ${reqAgendaSel}`);
        }
        const modalStartIdx = indexHtml.indexOf('id="agendaModal"');
        const actPos = indexHtml.indexOf('id="agendaActividad"', modalStartIdx);
        const descPos = indexHtml.indexOf('id="agendaDescripcion"', modalStartIdx);
        const datePos = indexHtml.indexOf('id="agendaFecha"', modalStartIdx);
        const repModePos = indexHtml.indexOf('id="agendaRepeatMode"', modalStartIdx);
        assert.ok(actPos > modalStartIdx && descPos > actPos && datePos > descPos && repModePos > datePos,
            'En #agendaModal, Título y Descripción deben aparecer antes que Fecha y Repeticiones');

        for (const cssCls of [
            '.agenda-item.is-skipped',
            '.agenda-calendar-popover',
            '.agenda-calendar-panel',
            '.agenda-postpone-popover',
            '.agenda-repeat-section',
            '.agenda-drag-handle',
            '.is-drop-valid',
            '.is-drop-invalid',
            '.is-insert-before',
            '.is-insert-after',
            '.agenda-item.is-drop-settled',
            'prefers-reduced-motion'
        ]) {
            assert.ok(styleCss.includes(cssCls), `public/style.css debe definir ${cssCls}`);
        }
        const reducedMotionMatch = styleCss.match(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{[\s\S]*?\}\s*$/);
        assert.ok(reducedMotionMatch, 'public/style.css debe incluir bloque @media (prefers-reduced-motion: reduce)');
        assert.ok(
            reducedMotionMatch[0].includes('.is-insert-before') && reducedMotionMatch[0].includes('.is-insert-after'),
            '@media (prefers-reduced-motion: reduce) debe incluir .is-insert-before y .is-insert-after'
        );
        assert.ok(frontendJs.includes('posponerAgendaItem') && frontendJs.includes('openAgendaPostponePopover'));
        assert.ok(frontendJs.includes('function computePostponedAgendaDateTime('), 'public/frontend.js debe definir computePostponedAgendaDateTime');
        const postponeFnBlock = extractFnBlock('posponerAgendaItem', 'eliminarAgendaItem');
        assert.equal(
            /agendaState\.selectedDate\s*=/.test(postponeFnBlock),
            false,
            'posponerAgendaItem no debe cambiar agendaState.selectedDate ni sacar al usuario del día actual'
        );
        assert.ok(
            frontendJs.includes('function canMoveAgendaItemToDate(') &&
            frontendJs.includes('function computeAgendaReorderTimeBounds(') &&
            frontendJs.includes('function evaluateAgendaCardDrop(') &&
            frontendJs.includes('function cleanupAgendaDragState('),
            'public/frontend.js debe definir canMoveAgendaItemToDate, computeAgendaReorderTimeBounds, evaluateAgendaCardDrop y cleanupAgendaDragState'
        );

        const agendaSandbox = {};
        vm.runInNewContext(extractFnBlock('shiftYmdDateClient', 'toggleAgendaItem'), agendaSandbox);
        const now1122 = new Date(2026, 10, 26, 11, 22, 0);
        assert.deepEqual(
            (() => {
                const r = agendaSandbox.computePostponedAgendaDateTime({
                    currentFecha: '2026-11-26',
                    currentHora: '09:00',
                    offsetMinutes: 15,
                    nowDate: now1122,
                    categoria: 'personal'
                });
                return { fecha: r.fecha, hora: r.hora, bloque: r.bloque };
            })(),
            { fecha: '2026-11-26', hora: '11:37', bloque: 'manana' }
        );
        const toAfternoon = agendaSandbox.computePostponedAgendaDateTime({
            currentFecha: '2026-11-26',
            currentHora: '10:00',
            offsetMinutes: 30,
            nowDate: new Date(2026, 10, 26, 11, 50, 0),
            categoria: 'personal'
        });
        assert.equal(toAfternoon.hora, '12:20');
        assert.equal(toAfternoon.bloque, 'tarde');
        const toNight = agendaSandbox.computePostponedAgendaDateTime({
            currentFecha: '2026-11-26',
            currentHora: '17:00',
            offsetMinutes: 30,
            nowDate: new Date(2026, 10, 26, 18, 45, 0),
            categoria: 'personal'
        });
        assert.equal(toNight.hora, '19:15');
        assert.equal(toNight.bloque, 'noche');
        const crossMidnight = agendaSandbox.computePostponedAgendaDateTime({
            currentFecha: '2026-11-26',
            currentHora: '23:00',
            offsetMinutes: 25,
            nowDate: new Date(2026, 10, 26, 23, 50, 0),
            categoria: 'personal'
        });
        assert.equal(crossMidnight.fecha, '2026-11-27');
        assert.equal(crossMidnight.hora, '00:15');
        assert.equal(crossMidnight.bloque, 'manana');
        const futureTask = agendaSandbox.computePostponedAgendaDateTime({
            currentFecha: '2026-11-30',
            currentHora: '14:00',
            offsetMinutes: 60,
            nowDate: now1122,
            categoria: 'personal'
        });
        assert.equal(futureTask.fecha, '2026-11-30');
        assert.equal(futureTask.hora, '15:00');
        assert.equal(futureTask.bloque, 'tarde');
        const uniTask = agendaSandbox.computePostponedAgendaDateTime({
            currentFecha: '2026-11-26',
            currentHora: '09:00',
            offsetMinutes: 120,
            nowDate: now1122,
            categoria: 'universidad'
        });
        assert.equal(uniTask.bloque, 'escuela');
        assert.equal(agendaSandbox.canMoveAgendaItemToDate('2026-11-25', '2026-11-24', '2026-11-24'), false, 'No debe permitir mover hacia atrás respecto a la fecha origen');
        assert.equal(agendaSandbox.canMoveAgendaItemToDate('2026-11-20', '2026-11-22', '2026-11-24'), false, 'No debe permitir mover hacia una fecha pasada respecto a hoy');
        assert.equal(agendaSandbox.canMoveAgendaItemToDate('2026-11-24', '2026-11-24', '2026-11-24'), false, 'No debe mover al mismo día sin cambio de bloque personal');
        assert.equal(
            agendaSandbox.canMoveAgendaItemToDate('2026-11-24', '2026-11-24', '2026-11-24', {
                categoria: 'personal',
                sourceBlock: 'manana',
                targetBlock: 'tarde'
            }),
            true,
            'Debe permitir cambiar de bloque personal (ej. Mañana -> Tarde) en fecha actual o futura'
        );
        assert.equal(agendaSandbox.canMoveAgendaItemToDate('2026-11-24', '2026-11-27', '2026-11-24'), true, 'Debe permitir mover hacia días futuros');
        assert.equal(
            agendaSandbox.canMoveAgendaItemToDate('2026-11-24', '2026-11-24', '2026-11-24', {
                categoria: 'universidad',
                allowSameDayReorder: true
            }),
            true,
            'Debe permitir reordenar en el mismo día con allowSameDayReorder'
        );

        // Pruebas unitarias de computeAgendaReorderTimeBounds (antes, después, entre dos, pegadas y límites extremos)
        assert.equal(typeof agendaSandbox.computeAgendaReorderTimeBounds, 'function');
        const boundsBefore = agendaSandbox.computeAgendaReorderTimeBounds({
            siblings: [{ hora: '12:00', titulo: 'Almuerzo' }],
            insertIndex: 0,
            isPersonal: false
        });
        assert.equal(boundsBefore.minTime, '00:00');
        assert.equal(boundsBefore.maxTime, '11:59');
        assert.equal(boundsBefore.suggestedTime, '11:45');
        assert.equal(boundsBefore.isTight, false);
        assert.match(boundsBefore.positionLabel, /Antes de "Almuerzo" \(12:00\)/);

        const boundsBeforeBlock = agendaSandbox.computeAgendaReorderTimeBounds({
            siblings: [{ hora: '15:00', titulo: 'Lectura' }],
            insertIndex: 0,
            targetBloque: 'tarde',
            isPersonal: true
        });
        assert.equal(boundsBeforeBlock.minTime, '12:00');
        assert.equal(boundsBeforeBlock.maxTime, '14:59');
        assert.equal(boundsBeforeBlock.suggestedTime, '14:45');

        const boundsAfter = agendaSandbox.computeAgendaReorderTimeBounds({
            siblings: [{ hora: '13:00', actividad: 'Laboratorio — Sala B' }],
            insertIndex: 1,
            isPersonal: false
        });
        assert.equal(boundsAfter.minTime, '13:01');
        assert.equal(boundsAfter.maxTime, '23:59');
        assert.equal(boundsAfter.suggestedTime, '13:15');
        assert.match(boundsAfter.positionLabel, /Después de "Laboratorio" \(13:00\)/);

        const boundsAfterBlock = agendaSandbox.computeAgendaReorderTimeBounds({
            siblings: [{ hora: '10:00', titulo: 'Desayuno' }],
            insertIndex: 1,
            targetBloque: 'manana',
            isPersonal: true
        });
        assert.equal(boundsAfterBlock.minTime, '10:01');
        assert.equal(boundsAfterBlock.maxTime, '11:59');
        assert.equal(boundsAfterBlock.suggestedTime, '10:15');

        const boundsBetween = agendaSandbox.computeAgendaReorderTimeBounds({
            siblings: [
                { hora: '12:00', titulo: 'Clase A' },
                { hora: '12:49', titulo: 'Clase B' }
            ],
            insertIndex: 1,
            isPersonal: false
        });
        assert.equal(boundsBetween.minTime, '12:01');
        assert.equal(boundsBetween.maxTime, '12:48');
        assert.equal(boundsBetween.suggestedTime, '12:25');
        assert.equal(boundsBetween.isTight, false);
        assert.match(boundsBetween.positionLabel, /Entre "Clase A" \(12:00\) y "Clase B" \(12:49\)/);

        const boundsTightAdjacent = agendaSandbox.computeAgendaReorderTimeBounds({
            siblings: [
                { hora: '12:00', titulo: 'Reunión 1' },
                { hora: '12:01', titulo: 'Reunión 2' }
            ],
            insertIndex: 1,
            isPersonal: false
        });
        assert.equal(boundsTightAdjacent.minTime, '12:00');
        assert.equal(boundsTightAdjacent.maxTime, '12:01');
        assert.equal(boundsTightAdjacent.suggestedTime, '12:00');
        assert.equal(boundsTightAdjacent.isTight, true);
        assert.ok(boundsTightAdjacent.note.length > 0);

        const boundsTightEqual = agendaSandbox.computeAgendaReorderTimeBounds({
            siblings: [
                { hora: '12:00', titulo: 'A' },
                { hora: '12:00', titulo: 'B' }
            ],
            insertIndex: 1,
            isPersonal: false
        });
        assert.equal(boundsTightEqual.minTime, '12:00');
        assert.equal(boundsTightEqual.maxTime, '12:00');
        assert.equal(boundsTightEqual.suggestedTime, '12:00');
        assert.equal(boundsTightEqual.isTight, true);

        const boundsStartDay = agendaSandbox.computeAgendaReorderTimeBounds({
            siblings: [{ hora: '00:00', titulo: 'Medianoche' }],
            insertIndex: 0,
            isPersonal: false
        });
        assert.equal(boundsStartDay.minTime, '00:00');
        assert.equal(boundsStartDay.maxTime, '00:00');
        assert.equal(boundsStartDay.suggestedTime, '00:00');

        const boundsEndDay = agendaSandbox.computeAgendaReorderTimeBounds({
            siblings: [{ hora: '23:59', titulo: 'Cierre' }],
            insertIndex: 1,
            isPersonal: false
        });
        assert.equal(boundsEndDay.minTime, '23:59');
        assert.equal(boundsEndDay.maxTime, '23:59');
        assert.equal(boundsEndDay.suggestedTime, '23:59');
        assert.deepEqual(
            Array.from(agendaSandbox.computeAgendaRepeatDates({
                startDate: '2026-11-18',
                mode: 'interval',
                intervalDays: 2,
                endMode: 'count',
                countExtra: 3
            })),
            ['2026-11-18', '2026-11-20', '2026-11-22', '2026-11-24']
        );
        assert.deepEqual(
            Array.from(agendaSandbox.computeAgendaRepeatDates({
                startDate: '2026-11-16',
                mode: 'weekdays',
                weekdays: [1, 3, 5],
                endMode: 'until',
                untilDate: '2026-11-23'
            })),
            ['2026-11-16', '2026-11-18', '2026-11-20', '2026-11-23']
        );
        assert.equal(agendaSandbox.buildMonthCalendarMatrix(2026, 10).length >= 35, true);
    });
});

describe('Traductor Global por Selección e Integridad Bilingüe EN/ES', () => {
    it('elimina el pill flotante fijo (#btnFloatingTranslatorFab), habilita selección global y soporta japonés en popup', () => {
        const indexHtml = readText('public/index.html');
        const styleCss = readText('public/style.css');
        const frontendJs = readText('public/frontend.js');
        const popupHtml = readText('public/translator-popup.html');

        assert.equal(indexHtml.includes('id="btnFloatingTranslatorFab"'), false, 'public/index.html no debe renderizar #btnFloatingTranslatorFab');
        assert.equal(/\.translator-fab\b/.test(styleCss), false, 'public/style.css no debe definir .translator-fab');
        assert.equal(frontendJs.includes('btnFloatingTranslatorFab'), false, 'public/frontend.js no debe referenciar btnFloatingTranslatorFab');

        assert.ok(frontendJs.includes('function initGlobalSelectionTranslator('), 'frontend.js debe definir initGlobalSelectionTranslator');
        assert.ok(frontendJs.includes("document.addEventListener('selectionchange'"), 'frontend.js debe escuchar selectionchange globalmente');
        assert.ok(
            frontendJs.includes("activeEl.tagName === 'TEXTAREA'") &&
            frontendJs.includes('#floatingTranslatorModal, #btnMusicTranslateLyricsSel, #authOverlay, #singleTabGuardModal'),
            'initGlobalSelectionTranslator debe soportar selección global y textarea/input excluyendo auth/traductor'
        );

        for (const jaDir of ['data-dir="ja_es"', 'data-dir="ja_en"', 'data-dir="en_ja"', 'data-dir="es_ja"']) {
            assert.ok(popupHtml.includes(jaDir), `public/translator-popup.html debe incluir opción de dirección ${jaDir}`);
        }
    });

    it('garantiza traducciones bidireccionales EN <-> ES consistentes en public/i18n.js sin llaves ES autorreferenciales', () => {
        const i18nSrc = readText('public/i18n.js');
        const mockDoc = {
            readyState: 'loading',
            title: '',
            documentElement: { lang: 'es', style: {}, setAttribute() {}, querySelector() { return null; } },
            getElementById() { return null; },
            querySelector() { return null; },
            querySelectorAll() { return []; },
            addEventListener() {},
            dispatchEvent() {}
        };
        const sandbox = {
            window: {},
            document: mockDoc,
            localStorage: { getItem: () => 'en', setItem() {} },
            CustomEvent: function CustomEvent(name, opts) { this.type = name; this.detail = opts && opts.detail; },
            NodeFilter: { SHOW_TEXT: 4 },
            dispatchEvent() {}
        };
        sandbox.window = sandbox;
        vm.runInNewContext(i18nSrc, sandbox);
        const i18n = sandbox.DailyHubI18n;
        assert.ok(i18n && typeof i18n.translateText === 'function', 'DailyHubI18n debe exponerse en sandbox');

        i18n.setLang('en');
        assert.equal(i18n.translateText('📄 Extraer letra'), '📄 Extract lyrics');
        assert.equal(i18n.translateText('🌐 Traducir selección'), '🌐 Translate selection');
        assert.equal(i18n.translateText('Por hacer'), 'To Do');
        assert.equal(i18n.translateText('🏢 Residencias Profesionales'), '🏢 Professional Internships');
        assert.equal(i18n.translateText('0 / 250 máx.'), '0 / 250 max');
        assert.equal(i18n.translateText('Página 2'), 'Page 2');
        assert.equal(i18n.translateText('12 líneas · Solo lectura'), '12 lines · Read-only');
        assert.equal(i18n.translateText('🎵 Original (Mezcla Nativa)'), '🎵 Original (Native Mix)');
        assert.equal(i18n.translateText('🌐 Switch to Español'), '🌐 Switch to Español');

        i18n.setLang('es');
        assert.equal(i18n.translateText('📄 Extract lyrics'), '📄 Extraer letra');
        assert.equal(i18n.translateText('🌐 Translate selection'), '🌐 Traducir selección');
        assert.equal(i18n.translateText('To Do'), 'Por hacer');
        assert.equal(i18n.translateText('🏢 Professional Internships'), '🏢 Residencias Profesionales');
        assert.equal(i18n.translateText('0 / 250 max'), '0 / 250 máx.');
        assert.equal(i18n.translateText('Page 2'), 'Página 2');
        assert.equal(i18n.translateText('12 lines · Read-only'), '12 líneas · Solo lectura');
        assert.equal(i18n.translateText('🎵 Original (Native Mix)'), '🎵 Original (Mezcla Nativa)');
        assert.equal(i18n.translateText('🌐 Switch to Español'), '🌐 Cambiar a Inglés');

        // Verificar que ninguna pareja no-idéntica en PAIRS quede atrapada en español al traducir a EN
        const pairsMatch = i18nSrc.match(/var\s+PAIRS\s*=\s*(\[[\s\S]*?\n\s*\]);/);
        assert.ok(pairsMatch, 'public/i18n.js debe declarar var PAIRS = [...]');
        const pairs = vm.runInNewContext(pairsMatch[1], {});
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        i18n.setLang('en');
        const trappedEs = [];
        for (const [enText, esText] of pairs) {
            if (norm(enText) !== norm(esText)) {
                const backToEn = i18n.translateText(esText);
                if (norm(backToEn) === norm(esText)) {
                    trappedEs.push({ enText, esText, backToEn });
                }
            }
        }
        assert.deepEqual(trappedEs, [], `Entradas de PAIRS que no regresan a inglés: ${JSON.stringify(trappedEs.slice(0, 5))}`);
    });

    it('cubre tooltips (title), mensajes de error del servidor, toasts, banners, loadingText y patrones dinámicos en EN <-> ES', () => {
        const i18nSrc = readText('public/i18n.js');
        const frontendJs = readText('public/frontend.js');
        const mockDoc = {
            readyState: 'loading',
            title: '',
            documentElement: { lang: 'en', style: {}, setAttribute() {}, querySelector() { return null; } },
            getElementById() { return null; },
            querySelector() { return null; },
            querySelectorAll() { return []; },
            addEventListener() {},
            dispatchEvent() {}
        };
        const sandbox = {
            window: {},
            document: mockDoc,
            localStorage: { getItem: () => 'en', setItem() {} },
            CustomEvent: function CustomEvent(name, opts) { this.type = name; this.detail = opts && opts.detail; },
            NodeFilter: { SHOW_TEXT: 4 },
            dispatchEvent() {}
        };
        sandbox.window = sandbox;
        vm.runInNewContext(i18nSrc, sandbox);
        const i18n = sandbox.DailyHubI18n;

        // 1. Todos los tooltips (title="...") en index.html y translator-popup.html deben diferir entre EN y ES
        const missingTooltips = [];
        for (const htmlFile of ['public/index.html', 'public/translator-popup.html']) {
            const html = readText(htmlFile);
            const titleRe = /\btitle="([^"]+)"/g;
            let m;
            while ((m = titleRe.exec(html))) {
                const raw = m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
                if (!raw || !/[a-zA-ZáéíóúñÁÉÍÓÚÑ]/.test(raw)) continue;
                i18n.setLang('en');
                const enVal = i18n.translateServerMessage(raw);
                i18n.setLang('es');
                const esVal = i18n.translateServerMessage(raw);
                if (enVal === esVal) {
                    missingTooltips.push(`${htmlFile}: ${raw}`);
                }
            }
        }
        assert.deepEqual(missingTooltips, [], `Tooltips sin traducción bidireccional: ${JSON.stringify(missingTooltips)}`);

        // 2. Verificar que mostrarBannerMusica y runWithButtonLock traduzcan mensajes/loadingText con tServer
        assert.ok(frontendJs.includes('el.textContent = tServer(String(msg));'), 'mostrarBannerMusica debe traducir mensajes con tServer');
        assert.ok(frontendJs.includes('label.textContent = tServer(String(loadingText));'), 'runWithButtonLock debe traducir loadingText con tServer');

        // 3. Mensajes representativos de servidor, validaciones, toasts, banners y patrones dinámicos EN <-> ES
        const samples = [
            ['HTTPS is required for all API requests.', 'Se requiere HTTPS para todas las peticiones a la API.'],
            ['Too many requests to the server. Please slow down briefly.', 'Demasiadas peticiones al servidor. Reduce el ritmo brevemente.'],
            ['Concurrent English Notebook file write busy; please retry shortly.', 'Escritura concurrente del cuaderno de idiomas ocupada; reintenta en un momento.'],
            ['Concurrent journal file write busy; please retry shortly.', 'Escritura concurrente de Diario.docx ocupada; reintenta en un momento.'],
            ['Record updated successfully\nYou were still within the edit window.', 'Registro actualizado correctamente. Aún estabas dentro de la ventana de edición.'],
            ['Invalid date format (expected YYYY-MM-DD).', 'Fecha inválida (formato esperado YYYY-MM-DD).'],
            ['Intensity must be an integer between 1 and 5.', 'La intensidad debe ser un entero entre 1 y 5.'],
            ['Google Drive upload could not be verified with matching byte size.', 'La subida a Google Drive no pudo verificarse con el mismo tamaño en bytes.'],
            ['Song study notes encrypted & queued for Word!', '¡Notas de estudio de la canción cifradas y enviadas a Word!'],
            ['Saving...', 'Guardando...'],
            ['Edit Song: DRIP', 'Editar canción: DRIP'],
            ['Edit Album: BABYMONS7ER', 'Editar álbum: BABYMONS7ER'],
            ['Studying: BABYMONSTER — DRIP', 'Estudiando: BABYMONSTER — DRIP'],
            ['Late bedtime (03:15) saved! Complete your wake-up time when you get up.', '¡Hora de dormir tardía (03:15) guardada! Completa tu hora de despertar cuando te levantes.'],
            ['Note encrypted with password and saved locally (Nov 19th D-001).', 'Nota cifrada con contraseña y guardada localmente (Nov 19th D-001).'],
            ['Today already has a journal entry (November 19th D-419); "Nothing to report." was skipped.', 'Hoy ya tiene una entrada en el diario (November 19th D-419); se omitió "Nothing to report.".'],
            ['Marked "November 19th D-419" as "Nothing to report.".', 'Se marcó "November 19th D-419" como "Nothing to report.".'],
            ['Filled 3 missing day(s) with "Nothing to report.".', 'Se llenaron 3 día(s) faltante(s) con "Nothing to report.".'],
            ['All past days are already filled.', 'Todos los días anteriores ya están llenos.'],
            ['Write the crisis reason or trigger (max 250 characters).', 'Escribe el motivo o detonante de la crisis (máx. 250 caracteres).'],
            ['You must complete the previous lesson first: "Lesson 1".', 'Debes completar primero la lección previa: "Lesson 1".'],
            ['Synced 4 schedule item(s) to Weekly Agenda (1 vacation day(s) skipped)', 'Se sincronizaron 4 actividades a tu Agenda Semanal (1 día(s) de vacaciones omitidos)'],
            ['Failed to send note: Network Error', 'No se pudo enviar la nota: Network Error']
        ];
        for (const [enExpected, esExpected] of samples) {
            i18n.setLang('es');
            assert.equal(i18n.translateServerMessage(enExpected), esExpected, `EN -> ES falló para "${enExpected}"`);
            i18n.setLang('en');
            assert.equal(i18n.translateServerMessage(esExpected), enExpected.replace(/\n/g, ' '), `ES -> EN falló para "${esExpected}"`);
        }
    });
});

describe('Arquitectura Blue-Green Caddy + Rollback y Modal de Canción (#musicSongModal)', () => {
    it('configura slots simétricos app_blue/app_green en loopback, Caddy dinámico y blue-green.sh', () => {
        const caddyfile = readText('Caddyfile');
        assert.match(caddyfile, /trusted_proxies\s+static\s+private_ranges/);
        assert.match(caddyfile, /import\s+\/etc\/caddy\/state\/upstream\.caddy/);
        assert.equal(/reverse_proxy\s+app:\{\$PORT:3000\}\s+app2:/m.test(caddyfile), false, 'Caddyfile ya no debe apuntar al pool fijo app/app2');

        const compose = readText('docker-compose.yml');
        assert.match(compose, /^\s{2}app_blue:/m);
        assert.match(compose, /^\s{2}app_green:/m);
        assert.match(compose, /container_name:\s*mood_app_blue/);
        assert.match(compose, /container_name:\s*mood_app_green/);
        assert.match(compose, /REPLICA_ID=blue/);
        assert.match(compose, /REPLICA_ID=green/);
        assert.match(compose, /APP_SLOT=blue/);
        assert.match(compose, /APP_SLOT=green/);
        assert.match(compose, /APP_SLOT_STATE_FILE=\/app\/deploy-state\/active-slot/);
        assert.match(compose, /LOG_DIR=\$\{LOG_DIR:-\/app\/logs\}\/blue/);
        assert.match(compose, /LOG_DIR=\$\{LOG_DIR:-\/app\/logs\}\/green/);
        assert.match(compose, /\.\/data\/deploy-state:\/app\/deploy-state:ro/);
        assert.match(compose, /\.\/data\/deploy-state:\/etc\/caddy\/state:ro/);

        const proxyBlockMatch = compose.match(/^\s{2}proxy:[\s\S]*?(?=^volumes:)/m);
        assert.ok(proxyBlockMatch, 'Debe existir servicio proxy en docker-compose.yml');
        assert.equal(/depends_on:/m.test(proxyBlockMatch[0]), false, 'proxy no debe tener depends_on rígido sobre ambos slots');

        const bgScript = readText('scripts/blue-green.sh');
        for (const token of ['init-state)', 'status)', 'switch)', 'rollback)', 'caddy reload --config /etc/caddy/Caddyfile --force', 'atomic_write_file', 'state.json']) {
            assert.ok(bgScript.includes(token), `scripts/blue-green.sh debe incluir ${token}`);
        }

        const ubuntuGuide = readText('guides/GUIA_INSTALACION_UBUNTU_SERVER_26.md');
        assert.match(ubuntuGuide, /127\.0\.0\.1:8080/);
        assert.match(ubuntuGuide, /\[1\/10\]/);
        assert.match(ubuntuGuide, /\[10\/10\]/);
    });

    it('ubica #musicSongForm dentro de #musicSongModal antes de #musicAlbumCreateModal para superposición limpia', () => {
        const indexHtml = readText('public/index.html');
        const songModalPos = indexHtml.indexOf('id="musicSongModal"');
        const songFormPos = indexHtml.indexOf('id="musicSongForm"');
        const albumModalPos = indexHtml.indexOf('id="musicAlbumCreateModal"');

        assert.ok(songModalPos > -1, 'public/index.html debe definir #musicSongModal');
        assert.ok(songFormPos > songModalPos, '#musicSongForm debe estar contenido dentro de #musicSongModal');
        assert.ok(albumModalPos > songFormPos, '#musicAlbumCreateModal debe ir después de #musicSongModal en el DOM');
        assert.equal(indexHtml.includes('id="btnMusicNewSong"'), true, 'Catálogo debe incluir botón #btnMusicNewSong');
        assert.equal(indexHtml.includes('id="btnCloseMusicSongModal"'), true, '#musicSongModal debe incluir botón de cierre');
    });

    it('amplía retención local y respaldos para discos >= 300 GB en backup.sh, docker-compose y deploy.yml', () => {
        const backupSh = readText('scripts/backup.sh');
        assert.match(backupSh, /RETENTION_DAYS="\$\{DB_RETENTION_DAYS:-0\}"/);
        assert.match(backupSh, /LOCAL_SQL_DAILY_BACKUP_DAYS="\$\{LOCAL_SQL_DAILY_BACKUP_DAYS:-180\}"/);
        assert.match(backupSh, /LOCAL_WORD_BACKUP_DAYS="\$\{LOCAL_WORD_BACKUP_DAYS:-365\}"/);
        assert.ok(backupSh.includes('$RUTA_LOCAL/diario_sql'), 'backup.sh debe guardar respaldos SQL diarios locales en diario_sql/');

        const compose = readText('docker-compose.yml');
        assert.match(compose, /LOG_MAX_BYTES=\$\{LOG_MAX_BYTES:-20971520\}/);
        assert.match(compose, /LOG_MAX_FILES=\$\{LOG_MAX_FILES:-10\}/);
        assert.match(compose, /max-size:\s*"25m"/);
        assert.match(compose, /max-file:\s*"5"/);

        const verifySh = readText('scripts/verify-ubuntu-local.sh');
        assert.equal(
            /RCLONE_BACKUP_DIR=.*tr -d '"\r '/.test(verifySh),
            false,
            'verify-ubuntu-local.sh no debe eliminar espacios internos de RCLONE_BACKUP_DIR (ej. Personal Daily Hub/RespaldosApp)'
        );
    });

    it('ubica #plannerCourseForm dentro de #plannerCourseModal y configura #locationMapPickerModal con CSP segura para tiles OSM', () => {
        const indexHtml = readText('public/index.html');
        const serverJs = readText('server.js');
        const frontendJs = readText('public/frontend.js');

        const courseModalPos = indexHtml.indexOf('id="plannerCourseModal"');
        const courseFormPos = indexHtml.indexOf('id="plannerCourseForm"');
        const campusPlaceModalPos = indexHtml.indexOf('id="campusPlaceModal"');
        const mapModalPos = indexHtml.indexOf('id="locationMapPickerModal"');
        assert.ok(courseModalPos > -1, 'public/index.html debe incluir #plannerCourseModal');
        assert.ok(courseFormPos > courseModalPos, '#plannerCourseForm debe estar dentro de #plannerCourseModal');
        assert.ok(campusPlaceModalPos > courseFormPos, '#campusPlaceModal debe definirse en el DOM');
        assert.ok(mapModalPos > campusPlaceModalPos, '#locationMapPickerModal debe definirse después de #campusPlaceModal para quedar arriba');

        for (const requiredId of [
            'id="btnOpenCourseModal"',
            'id="btnCloseCourseModal"',
            'id="btnAddCampusPlace"',
            'id="campusPlaceModal"',
            'id="campusPlaceForm"',
            'id="campusPlaceNameInput"',
            'id="campusPlaceCodeInput"',
            'id="campusPlaceLocationSummary"',
            'id="btnCampusPlacePickMap"',
            'id="campusPlaceRoomInput"',
            'id="btnAddCampusRoom"',
            'id="campusPlaceRoomsList"',
            'id="mapPickerViewport"',
            'id="mapPickerCanvas"',
            'id="mapPickerTilesLayer"',
            'id="mapPickerPinMarker"',
            'id="btnMapZoomIn"',
            'id="btnMapZoomOut"',
            'id="mapPickerSearchInput"',
            'id="btnMapPickerSearch"',
            'id="btnConfirmMapPickerLocation"',
            'id="btnHomeOpenMapPicker"',
            'id="btnResOpenMapPicker"',
            'id="btnWorkOpenMapPicker"'
        ]) {
            assert.ok(indexHtml.includes(requiredId), `public/index.html debe incluir ${requiredId}`);
        }
        assert.strictEqual(indexHtml.includes('id="btnResetCampusDefaultLocation"'), false, 'public/index.html ya no debe incluir #btnResetCampusDefaultLocation');
        assert.strictEqual(frontendJs.includes('btnResetCampusDefaultLocation'), false, 'public/frontend.js ya no debe referenciar btnResetCampusDefaultLocation');
        assert.ok(frontendJs.includes('function renderCourseCampusSelectOptions('), 'public/frontend.js debe llenar dinámicamente #courseCampus');

        // Todos los IDs previos de coordenadas siguen presentes en inputs ocultos para retrocompatibilidad
        for (const legacyId of [
            'id="homeLocationLat"',
            'id="homeLocationLng"',
            'id="homeLocationMapsUrl"',
            'id="uniLocationLat"',
            'id="uniLocationLng"',
            'id="resLocationLat"',
            'id="resLocationLng"',
            'id="workLocationLat"',
            'id="workLocationLng"'
        ]) {
            assert.ok(indexHtml.includes(legacyId), `public/index.html debe conservar ${legacyId}`);
        }

        // Verificar CSP estricta intacta + tiles cargados vía proxy local autenticado (sin CARTO, con OSM + Esri y caché v2)
        assert.match(serverJs, /script-src 'self'/);
        assert.match(serverJs, /connect-src 'self'/);
        assert.match(serverJs, /img-src 'self' data: https:\/\/i\.ytimg\.com https:\/\/tile\.openstreetmap\.org https:\/\/\*\.tile\.openstreetmap\.org/);
        assert.ok(serverJs.includes('/api/planner/geocode-search') && serverJs.includes('/api/planner/reverse-geocode'));
        assert.ok(serverJs.includes('mapTileLimiter') && serverJs.includes('/api/planner/map-tile/:z/:x/:y.png'));
        assert.strictEqual(serverJs.includes('basemaps.cartocdn.com'), false, 'server.js no debe usar basemaps.cartocdn.com (API KEY REQUIRED)');
        assert.ok(serverJs.includes('https://tile.openstreetmap.org/'), 'server.js debe usar OpenStreetMap como proveedor principal');
        assert.ok(serverJs.includes('World_Street_Map/MapServer/tile/') && serverJs.includes('World_Topo_Map/MapServer/tile/') && serverJs.includes('World_Imagery/MapServer/tile/'), 'server.js debe incluir respaldo Esri World Street/Topo/Imagery sin API key');
        assert.ok(serverJs.includes("MAP_TILE_CACHE_VERSION = 'v2'") && serverJs.includes('detectMapTileImageMime('), 'server.js debe versionar caché de tiles (v2) y validar magic bytes');
        assert.ok(frontendJs.includes('function openLocationMapPicker(') && frontendJs.includes('function openPlannerCourseModal('));
        assert.ok(frontendJs.includes('/api/planner/map-tile/') && frontendJs.includes('&v=2'), 'El mapa debe solicitar tiles v=2 a través del proxy local autenticado');
        assert.ok(!frontendJs.includes("referrerPolicy = 'no-referrer'"), 'No debe enviarse referrerPolicy no-referrer para tiles del mapa');
        assert.ok(!frontendJs.includes('https://tile.openstreetmap.org/'), 'frontend.js no debe cargar tiles directamente desde tile.openstreetmap.org');
        assert.strictEqual(frontendJs.includes('CARTO') || indexHtml.includes('CARTO'), false, 'La atribución del mapa no debe mencionar CARTO');
        assert.ok(indexHtml.includes('id="btnMapLayerStreets"') && indexHtml.includes('id="btnMapLayerSatellite"'), 'El selector de mapa debe incluir cambio de capa Calles / Satélite');
    });

    it('elimina el botón #btnLoadMindboxPreset y preset MindBox backend, y agrega #btnDeleteSemester en #view-horario sin afectar #courseCode', () => {
        const indexHtml = readText('public/index.html');
        const frontendJs = readText('public/frontend.js');
        const i18nJs = readText('public/i18n.js');
        const serverJs = readText('server.js');

        assert.strictEqual(serverJs.includes('getItsMindboxPresetCourses'), false, 'server.js no debe conservar getItsMindboxPresetCourses');
        assert.strictEqual(serverJs.includes('mindboxPreset:'), false, 'server.js no debe exponer mindboxPreset en /api/planner');

        assert.strictEqual(indexHtml.includes('id="btnLoadMindboxPreset"'), false, 'public/index.html no debe incluir #btnLoadMindboxPreset');
        assert.ok(indexHtml.includes('id="btnNewSemester"'), 'public/index.html debe conservar #btnNewSemester');
        assert.ok(indexHtml.includes('id="btnDeleteSemester"'), 'public/index.html debe incluir #btnDeleteSemester');
        assert.ok(indexHtml.includes('for="courseCode"'), 'public/index.html debe conservar el campo Subject Key (MindBox) #courseCode');

        assert.strictEqual(frontendJs.includes('btnLoadMindboxPreset'), false, 'public/frontend.js no debe contener listener de btnLoadMindboxPreset');
        assert.strictEqual(frontendJs.includes('academicPlannerMindboxPreset'), false, 'public/frontend.js no debe contener academicPlannerMindboxPreset');
        assert.ok(frontendJs.includes('btnDeleteSemester'), 'public/frontend.js debe gestionar #btnDeleteSemester');
        assert.strictEqual(
            frontendJs.includes('¡Cargadas tus 5 materias MindBox 9° semestre ITS!') || frontendJs.includes('Loaded your 5 MindBox 9th-semester ITS courses!'),
            false,
            'public/frontend.js no debe incluir el banner obsoleto de las 5 materias MindBox'
        );
        assert.strictEqual(
            frontendJs.includes('Cargar Plantilla MindBox') || frontendJs.includes('Load MindBox 9th Sem Preset'),
            false,
            'public/frontend.js no debe mencionar la plantilla MindBox en mensajes de estado vacío'
        );

        assert.strictEqual(i18nJs.includes('⚡ Load MindBox 9th Sem Preset'), false, 'public/i18n.js no debe conservar la entrada obsoleta de preset MindBox');
        assert.ok(i18nJs.includes('🗑️ Delete Semester'), 'public/i18n.js debe incluir la traducción de 🗑️ Delete Semester');
        assert.ok(i18nJs.includes('Subject Key (MindBox):'), 'public/i18n.js debe conservar la traducción de Clave de materia (MindBox)');
    });

    it('optimiza caché de Docker, elimina push directo en main protegido e idempotiza deploy.yml', () => {
        const dockerfile = readText('Dockerfile');
        const compose = readText('docker-compose.yml');
        const deploy = readText('.github/workflows/deploy.yml');
        const serverJs = readText('server.js');

        // 1. Dockerfile: capa de sistema (apk/python/msoffcrypto/yt-dlp) antes de COPY package*.json y npm ci
        const apkIdx = dockerfile.indexOf('RUN apk add --no-cache');
        const msoffIdx = apkIdx > -1 ? dockerfile.indexOf('msoffcrypto-tool', apkIdx) : -1;
        const copyPkgIdx = dockerfile.indexOf('COPY package*.json ./');
        const npmCiIdx = dockerfile.indexOf('RUN npm ci --omit=dev');
        assert.ok(apkIdx > -1 && msoffIdx > apkIdx, 'Dockerfile debe instalar paquetes Alpine y msoffcrypto-tool');
        assert.ok(copyPkgIdx > msoffIdx && npmCiIdx > copyPkgIdx, 'Dockerfile debe ejecutar apk add y msoffcrypto-tool antes de COPY package*.json ./ y npm ci --omit=dev');

        // 2. docker-compose.yml: build único en app_blue, compartido por app_green y APP_VERSION en ambos slots
        const buildMatches = compose.match(/^\s*build:\s*\.\s*$/gm) || [];
        assert.equal(buildMatches.length, 1, 'docker-compose.yml solo debe definir build: . una vez (en el servicio app_blue)');
        const blueBlockMatch = compose.match(/^\s{2}app_blue:\r?\n([\s\S]*?)\r?\n\s{2}app_green:/m);
        const greenBlockMatch = compose.match(/^\s{2}app_green:\r?\n([\s\S]*?)\r?\n\s{2}proxy:/m);
        assert.ok(blueBlockMatch && greenBlockMatch, 'docker-compose.yml debe definir servicios app_blue y app_green');
        assert.match(blueBlockMatch[1], /^\s*build:\s*\.\s*$/m, 'El servicio app_blue debe definir build: .');
        assert.equal(/^\s*build:\s*\./m.test(greenBlockMatch[1]), false, 'El servicio app_green no debe duplicar build: .');
        assert.match(blueBlockMatch[1], /image:\s*personal-daily-hub-app:\$\{BLUE_IMAGE_TAG:-blue\}/);
        assert.match(greenBlockMatch[1], /image:\s*personal-daily-hub-app:\$\{GREEN_IMAGE_TAG:-green\}/);
        assert.match(blueBlockMatch[1], /APP_VERSION=\$\{APP_VERSION:-\}/);
        assert.match(greenBlockMatch[1], /APP_VERSION=\$\{APP_VERSION:-\}/);

        // 3. server.js: respaldo con process.env.APP_VERSION, /healthz enriquecido y guardia de slot activo
        const versionFnMatch = serverJs.match(/function loadVersionMetadata\(\)\s*\{[\s\S]*?\r?\n\}/);
        assert.ok(versionFnMatch, 'server.js debe definir loadVersionMetadata()');
        assert.ok(versionFnMatch[0].includes('process.env.APP_VERSION'), 'loadVersionMetadata() debe usar process.env.APP_VERSION como respaldo');
        assert.ok(serverJs.includes('function isActiveBlueGreenSlot('), 'server.js debe definir isActiveBlueGreenSlot()');
        assert.match(serverJs, /res\.setHeader\('X-App-Version'/);
        assert.match(serverJs, /app\.get\('\/healthz'[\s\S]*?slot[\s\S]*?replicaId[\s\S]*?version/);

        // Validar comportamiento real de isActiveBlueGreenSlot() ante cambios de archivo active-slot
        const bgSlotFnMatch = serverJs.match(/function isActiveBlueGreenSlot\(\)\s*\{[\s\S]*?\r?\n\}/);
        assert.ok(bgSlotFnMatch, 'No se pudo extraer isActiveBlueGreenSlot() para prueba unitaria');
        const tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdh-bg-slot-'));
        try {
            const stateFilePath = path.join(tmpStateDir, 'active-slot');
            const makeChecker = (slotEnv, fileEnv) => {
                const sb = { fs, process: { env: { APP_SLOT: slotEnv, APP_SLOT_STATE_FILE: fileEnv } }, APP_SLOT_NAME: String(slotEnv || '').toLowerCase(), APP_SLOT_STATE_FILE: fileEnv };
                vm.runInNewContext(bgSlotFnMatch[0], sb);
                return sb.isActiveBlueGreenSlot();
            };
            assert.equal(makeChecker('', stateFilePath), true, 'Sin APP_SLOT configurado debe operar como slot activo (local/tests)');
            assert.equal(makeChecker('blue', stateFilePath), true, 'Sin archivo active-slot previo debe permitir arranque inicial');
            fs.writeFileSync(stateFilePath, 'blue\n', 'utf8');
            assert.equal(makeChecker('blue', stateFilePath), true);
            assert.equal(makeChecker('green', stateFilePath), false);
            fs.writeFileSync(stateFilePath, 'green\n', 'utf8');
            assert.equal(makeChecker('green', stateFilePath), true);
            assert.equal(makeChecker('blue', stateFilePath), false);
        } finally {
            fs.rmSync(tmpStateDir, { recursive: true, force: true });
        }

        // 4. deploy.yml: tag directo sobre main protegido, sin checkout en deploy, build único Blue-Green e idempotencia
        assert.ok(deploy.includes("vars.RELEASE_PUSH_TO_MAIN || 'false'"), 'El job release debe soportar vars.RELEASE_PUSH_TO_MAIN con default false');
        assert.equal(deploy.includes('Direct push to main skipped'), false, 'deploy.yml ya no debe emitir la advertencia GH013 de push directo a main');

        const deployJobMatch = deploy.match(/^\s{2}deploy:\r?\n([\s\S]*)$/m);
        assert.ok(deployJobMatch, 'deploy.yml debe definir el job deploy');
        assert.equal(/uses:\s*actions\/checkout@/.test(deployJobMatch[1]), false, 'El job deploy no debe ejecutar actions/checkout innecesariamente');

        assert.equal(/fs\.writeFileSync\(['"]package\.json['"]/.test(deploy) || /open\(['"]package\.json['"],\s*['"]w['"]/.test(deploy), false, 'deploy.yml no debe mutar package.json en disco antes de build');
        assert.ok(deploy.includes("printf 'APP_VERSION=%s\\n'"), 'deploy.yml debe incluir APP_VERSION en DEPLOY_ENV_FILE');
        assert.ok(deploy.includes('compose --env-file "$DEPLOY_ENV_FILE" build app_blue'), 'deploy.yml debe construir la imagen una sola vez con compose build app_blue');
        assert.ok(deploy.includes('up -d --no-deps --no-build "app_${TARGET_SLOT}"'), 'deploy.yml debe levantar solo el slot inactivo antes de cortar tráfico');
        assert.ok(deploy.includes('./scripts/blue-green.sh switch "${TARGET_SLOT}"'), 'deploy.yml debe ejecutar blue-green.sh switch tras validar smoke test');
        assert.equal(deploy.includes('up -d --build'), false, 'deploy.yml no debe usar up -d --build');
        assert.ok(deploy.includes('--filter "until=168h"'), 'deploy.yml debe conservar caché de builder durante 168h');

        // 5. rollback.yml: workflow_dispatch con instant-switch y specific-tag, concurrency deploy-main y env/envs sincronizados
        const rollbackYml = readText('.github/workflows/rollback.yml');
        assert.match(rollbackYml, /workflow_dispatch:/);
        assert.match(rollbackYml, /instant-switch/);
        assert.match(rollbackYml, /specific-tag/);
        assert.match(rollbackYml, /concurrency:\r?\n\s+group:\s*deploy-main\r?\n\s+cancel-in-progress:\s*false/);
        assert.equal(/if:\s*[^\r\n]*\bsecrets\./.test(rollbackYml), false, 'rollback.yml no debe evaluar secrets.* dentro de expresiones if:');
        assert.ok(rollbackYml.includes('./scripts/blue-green.sh rollback') && rollbackYml.includes('./scripts/blue-green.sh switch'));
        const rbEnvSection = rollbackYml.match(/uses:\s*appleboy\/ssh-action@[^\r\n]+\r?\n\s+env:\r?\n([\s\S]*?)\r?\n\s+with:/);
        const rbEnvsLine = rollbackYml.match(/\benvs:\s*([^\r\n]+)/);
        assert.ok(rbEnvSection && rbEnvsLine, 'rollback.yml debe definir env y envs en ssh-action');
        const rbEnvKeys = [...rbEnvSection[1].matchAll(/^\s+([A-Z0-9_]+):/gm)].map((m) => m[1]);
        const rbForwardedKeys = rbEnvsLine[1].split(',').map((s) => s.trim()).filter(Boolean);
        for (const k of rbEnvKeys) {
            assert.ok(rbForwardedKeys.includes(k), `rollback.yml env '${k}' falta en envs:`);
        }

        for (const guardToken of [
            'systemctl is-enabled sleep.target',
            'find /usr/local/bin/yt-dlp -mtime +7',
            'git symbolic-ref --short HEAD',
            'cmp -s',
            'ufw status verbose',
            'Firewall UFW ya configurado.'
        ]) {
            assert.ok(deploy.includes(guardToken), `deploy.yml debe incluir validación idempotente: ${guardToken}`);
        }
    });

    it('mantiene scripts/*.sh ejecutables en Git (100755) y evita dirty git status en deploy.yml', () => {
        const scripts = [
            'scripts/backup.sh',
            'scripts/blue-green.sh',
            'scripts/env-vault.sh',
            'scripts/restore.sh',
            'scripts/verify-ubuntu-local.sh'
        ];
        const stageOut = execFileSync('git', ['ls-files', '--stage', ...scripts], {
            cwd: ROOT,
            encoding: 'utf8'
        }).trim();
        const lines = stageOut.split(/\r?\n/).filter(Boolean);
        assert.equal(lines.length, scripts.length, 'Todos los scripts/*.sh deben estar versionados en Git');
        for (const scriptPath of scripts) {
            const match = lines.find((line) => line.endsWith(`\t${scriptPath}`));
            assert.ok(match, `Falta entrada en índice Git para ${scriptPath}`);
            assert.ok(match.startsWith('100755 '), `${scriptPath} debe tener modo 100755 en Git (encontrado: ${match})`);
        }

        const deploy = readText('.github/workflows/deploy.yml');
        const noSkipIdx = deploy.indexOf('--no-skip-worktree');
        const resetIdx = deploy.indexOf('git reset --hard origin/main');
        const rmSyncIdx = deploy.indexOf('rm -rf "$HOME/projects/mood-tracker/sincronitation"');
        const skipSyncIdx = deploy.indexOf('git update-index --skip-worktree -- 2>/dev/null || true');
        const skipHistoryIdx = deploy.indexOf('git update-index --skip-worktree -- version-history.json');

        assert.ok(noSkipIdx !== -1, 'deploy.yml debe limpiar --no-skip-worktree antes de resetear');
        assert.ok(resetIdx !== -1 && noSkipIdx < resetIdx, '--no-skip-worktree debe ejecutarse antes de git reset --hard origin/main');
        assert.ok(rmSyncIdx !== -1 && skipSyncIdx > rmSyncIdx, 'deploy.yml debe marcar sincronitation con --skip-worktree tras rm -rf');
        assert.ok(skipHistoryIdx !== -1, 'deploy.yml debe marcar version-history.json con --skip-worktree');
    });

    it('unifica tokens de color principal, habilita edición de tipos de crisis y mejora simetría/scroll de Agenda', () => {
        const styleCss = readText('public/style.css');
        const indexHtml = readText('public/index.html');
        const frontendJs = readText('public/frontend.js');

        // 1. Tokens unificados de marca y remoción de acentos inconsistentes
        for (const token of [
            '--brand-primary:',
            '--brand-primary-hover:',
            '--brand-primary-active:',
            '--brand-primary-soft:',
            '--brand-primary-border:'
        ]) {
            assert.ok(styleCss.includes(token), `public/style.css debe definir ${token}`);
        }
        const crisisActiveMatch = styleCss.match(/\.crisis-pill\.active,\s*\.crisis-int-pill\.active\s*\{([^}]*)\}/);
        assert.ok(crisisActiveMatch, 'Debe existir .crisis-pill.active, .crisis-int-pill.active en style.css');
        assert.equal(/#ef4444|#dc2626/i.test(crisisActiveMatch[1]), false, '.crisis-pill.active no debe usar rojo intenso sino --brand-primary');
        assert.match(crisisActiveMatch[1], /var\(--brand-primary\)/);

        const sleepActiveMatch = styleCss.match(/\.sleep-mode-pill\.active\s*\{([^}]*)\}/);
        assert.ok(sleepActiveMatch, 'Debe existir .sleep-mode-pill.active en style.css');
        assert.equal(/linear-gradient|#7c3aed|#8b5cf6|#4f46e5/i.test(sleepActiveMatch[1]), false, '.sleep-mode-pill.active no debe usar gradiente morado');
        assert.match(sleepActiveMatch[1], /var\(--brand-primary\)/);

        // 2. Agenda: Vista Día simétrica, filtros en 2 filas y Vista Rejilla amplia con columna sticky
        assert.match(styleCss, /\.agenda-day-tabs\s*\{[\s\S]*?display:\s*grid;[\s\S]*?minmax\(92px,\s*1fr\)/);
        assert.match(styleCss, /\.agenda-day-tabs\s*\{[\s\S]*?minmax\(64px,\s*1fr\)/);
        assert.match(styleCss, /\.agenda-table-scroll\s*\{[\s\S]*?overflow-x:\s*auto/);
        assert.match(styleCss, /\.agenda-week-board\s*\{[\s\S]*?minmax\(220px,\s*1fr\)[\s\S]*?width:\s*max-content;[\s\S]*?min-width:\s*100%/);
        assert.match(styleCss, /\.agenda-block-header\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?left:\s*0/);
        assert.ok(styleCss.includes('minmax(205px, 1fr)') && styleCss.includes('minmax(195px, 1fr)'),
            'style.css debe definir columnas amplias en tablet (>=205px) y celular (>=195px)');

        const filterBarMatch = indexHtml.match(/<div class="agenda-filter-bar">([\s\S]*?)<\/div>\s*<div id="agendaLoadingBanner"/);
        assert.ok(filterBarMatch, 'Debe existir .agenda-filter-bar en public/index.html');
        assert.ok(filterBarMatch[1].includes('agenda-filter-row-primary') && filterBarMatch[1].includes('agenda-filter-row-secondary'),
            '.agenda-filter-bar debe separar filtros en dos filas claras (.agenda-filter-row-primary y .agenda-filter-row-secondary)');

        // 3. Controles y modal para administrar Tipos de Episodio de Crisis
        assert.ok(indexHtml.includes('id="btnManageCrisisTypes"'), 'public/index.html debe incluir #btnManageCrisisTypes');
        assert.ok(indexHtml.includes('id="crisisTypesModal"'), 'public/index.html debe incluir #crisisTypesModal');
        assert.ok(frontendJs.includes('function renderCrisisTypePills(') && frontendJs.includes('function initCrisisTypesModal('),
            'public/frontend.js debe definir renderCrisisTypePills() e initCrisisTypesModal()');
    });

    it('aplica cifrado pdh-j2 (salt + PBKDF2 + HMAC) exclusivamente al Journal (/api/send-to-pc) sin alterar encriptarTextoE2EE para /api/send-english', () => {
        const frontendJs = readText('public/frontend.js');
        assert.match(frontendJs, /JOURNAL_SALTED_PBKDF2_ITERATIONS\s*=\s*120000/);
        assert.match(frontendJs, /async\s+function\s+encriptarDiarioSaltedE2EE\s*\(/);
        assert.match(frontendJs, /function\s+encriptarTextoE2EE\s*\(/);

        // Todos los envíos a /api/send-to-pc deben usar encriptarDiarioSaltedE2EE y no encriptarTextoE2EE
        const sendToPcBlocks = [...frontendJs.matchAll(/url:\s*['"]\/api\/send-to-pc['"][\s\S]{0,360}?\}\)/g)];
        assert.strictEqual(sendToPcBlocks.length, 2, 'Deben existir exactamente 2 flujos de envío a /api/send-to-pc en frontend.js');
        assert.ok(frontendJs.includes("await encriptarDiarioSaltedE2EE('Nothing to report.', llaveTexto)"),
            'El fallback Nothing to report. hacia /api/send-to-pc debe usar encriptarDiarioSaltedE2EE');
        assert.ok(frontendJs.includes('await encriptarDiarioSaltedE2EE(composedJournalText, llaveTexto)'),
            'El formulario principal del Journal hacia /api/send-to-pc debe usar encriptarDiarioSaltedE2EE');
        for (const match of sendToPcBlocks) {
            assert.equal(match[0].includes('encriptarTextoE2EE('), false,
                '/api/send-to-pc ya no debe enviar sobres legacy sin salt');
        }

        // Todos los envíos a /api/send-english deben mantener encriptarTextoE2EE
        const sendEnglishMatches = [...frontendJs.matchAll(/url:\s*['"]\/api\/send-english['"][\s\S]{0,420}?buildBody:\s*\(\)\s*=>\s*\(\{[^\n]+\}\)/g)];
        assert.ok(sendEnglishMatches.length >= 1, 'Debe existir envío a /api/send-english en frontend.js');
        for (const match of sendEnglishMatches) {
            assert.ok(match[0].includes('encriptarTextoE2EE('), '/api/send-english debe conservar encriptarTextoE2EE');
            assert.equal(match[0].includes('encriptarDiarioSaltedE2EE('), false,
                '/api/send-english no debe cambiarse a encriptarDiarioSaltedE2EE');
        }
    });

    it('expone botón, modal, ajuste anti-autofill y descifrado local binario pdh-j2 para descargar Diario (.docx)', async () => {
        const indexHtml = readText('public/index.html');
        const frontendJs = readText('public/frontend.js');
        const styleCss = readText('public/style.css');

        assert.equal(/\.settings-inline-actions\s+button\s*\{/.test(styleCss), false,
            'style.css no debe estirar .password-toggle-btn al 100% dentro de .settings-inline-actions');
        assert.ok(styleCss.includes('.settings-inline-actions > button:not(.password-toggle-btn)'),
            'style.css debe excluir .password-toggle-btn al expandir botones en móvil');
        assert.match(styleCss, /\.password-input-wrap\s*>\s*\.password-toggle-btn[\s\S]*?width:\s*34px;[\s\S]*?max-width:\s*34px;/);
        assert.match(styleCss, /\.label-with-helper\s*\{[^}]*flex-wrap:\s*wrap;/);
        assert.match(styleCss, /@media\s*\(max-width:\s*520px\)[\s\S]*?\.mobile-topbar-title\s*\{[^}]*flex:\s*1\s+1\s+auto;/);

        for (const requiredToken of [
            'id="btnDownloadJournalWord"',
            'id="journalDownloadPasswordModal"',
            'id="journalDownloadPasswordInput"',
            'id="journalDownloadPasswordConfirm"',
            'id="setJournalDownloadPassword"'
        ]) {
            assert.ok(indexHtml.includes(requiredToken), `public/index.html debe incluir ${requiredToken}`);
        }

        assert.match(frontendJs, /async\s+function\s+desencriptarDiarioBytesSaltedE2EE\s*\(/);
        assert.ok(frontendJs.includes('/api/journal/download-encrypted'), 'frontend.js debe consumir /api/journal/download-encrypted');

        // Validar interoperabilidad Node (encryptJournalSaltedBytesE2ee) -> navegador (desencriptarDiarioBytesSaltedE2EE)
        // tanto en WebCrypto nativo como en el fallback CryptoJS sin subtle
        const { webcrypto } = require('node:crypto');
        const serverNotes = require(path.join(ROOT, 'lib', 'server-notes-service.js'));
        const C = require(path.join(ROOT, 'public', 'vendor', 'crypto-js.min.js'));
        const fnMatch = frontendJs.match(/async\s+function\s+desencriptarDiarioBytesSaltedE2EE\s*\([\s\S]*?\r?\n\}\r?\nif\s*\(typeof window/);
        assert.ok(fnMatch, 'No se pudo extraer desencriptarDiarioBytesSaltedE2EE de public/frontend.js');
        const fnBody = fnMatch[0].replace(/\r?\nif\s*\(typeof window[\s\S]*$/, '');
        const validPwdFnMatch = frontendJs.match(/function\s+isJournalDownloadPwdValidClient\s*\([\s\S]*?\r?\n\}/);
        assert.ok(validPwdFnMatch, 'No se pudo extraer isJournalDownloadPwdValidClient de public/frontend.js');

        const sampleDocx = Buffer.concat([
            Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
            Buffer.from([0x00, 0xff, 0x80, 0x7f, 0xfe, 0x01, 0x02, 0x03]),
            Buffer.from('word/document.xml-binary-payload-for-pc-and-mobile-word-2026', 'utf8')
        ]);
        const userPwd = 'ClaveDescargaWeb2026!';
        const envelope = serverNotes.encryptJournalSaltedBytesE2ee(sampleDocx, userPwd);

        const runInSandbox = async (useSubtle) => {
            const sandbox = {
                window: { crypto: useSubtle ? webcrypto : {} },
                CryptoJS: C,
                TextEncoder,
                TextDecoder,
                Uint8Array,
                atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
                btoa: (bin) => Buffer.from(bin, 'binary').toString('base64')
            };
            vm.runInNewContext(`${validPwdFnMatch[0]}\n${fnBody}\nthis.fn = desencriptarDiarioBytesSaltedE2EE;`, sandbox);
            return sandbox.fn(envelope, userPwd);
        };

        const outSubtle = await runInSandbox(true);
        assert.strictEqual(Buffer.compare(Buffer.from(outSubtle), sampleDocx), 0, 'WebCrypto debe descifrar bytes .docx exactos');

        const outFallback = await runInSandbox(false);
        assert.strictEqual(Buffer.compare(Buffer.from(outFallback), sampleDocx), 0, 'Fallback CryptoJS debe descifrar bytes .docx exactos sin corrupción UTF-8');

        await assert.rejects(async () => {
            const sandbox = {
                window: { crypto: webcrypto },
                CryptoJS: C,
                TextEncoder,
                TextDecoder,
                Uint8Array,
                atob: (b64) => Buffer.from(b64, 'base64').toString('binary')
            };
            vm.runInNewContext(`${validPwdFnMatch[0]}\n${fnBody}\nthis.fn = desencriptarDiarioBytesSaltedE2EE;`, sandbox);
            await sandbox.fn(envelope, 'OtraClaveIncorrecta!');
        }, /MAC_MISMATCH|Incorrect password/i);
    });
});

describe('Mejoras de Materias (Pausa/Promedio), En Progreso 1h y Smart Commute en Ajustes', () => {
    it('mantiene cero IDs duplicados en public/index.html, mueve reglas de traslado a #view-settings y agrega controles por materia', () => {
        const indexHtml = readText('public/index.html');
        const frontendJs = readText('public/frontend.js');
        const styleCss = readText('public/style.css');
        const initSql = readText('init.sql');
        const serverJs = readText('server.js');

        // 1. Cero IDs duplicados en public/index.html
        const idCounts = new Map();
        for (const m of indexHtml.matchAll(/\bid="([^"]+)"/g)) {
            idCounts.set(m[1], (idCounts.get(m[1]) || 0) + 1);
        }
        const duplicateIds = [...idCounts.entries()].filter(([, cnt]) => cnt > 1).map(([id]) => id);
        assert.deepEqual(duplicateIds, [], `IDs duplicados encontrados en public/index.html: ${duplicateIds.join(', ')}`);

        // 2. Controles antiguos retirados de #view-horario y trasladados a #view-settings
        for (const oldId of [
            'id="plannerClassRemindersEnabled"',
            'id="plannerFarLeadMin"',
            'id="plannerNearLeadMin"',
            'id="plannerNearRadiusKm"'
        ]) {
            assert.equal(indexHtml.includes(oldId), false, `public/index.html ya no debe incluir ${oldId} en #view-horario`);
        }

        for (const newId of [
            'id="plannerSemesterAverageBadge"',
            'id="courseRemindersPaused"',
            'id="courseCompleted"',
            'id="courseFinalGrade"',
            'id="plannerCommuteRulesSummaryBox"',
            'id="btnOpenSmartCommuteSettings"',
            'id="settingsSmartCommuteCard"',
            'id="setCommuteRemindersEnabled"',
            'id="setCommuteExtraBufferMin"',
            'id="setCommuteRepeatEveryMin"',
            'id="setCommuteNearMilestones"',
            'id="setCommuteNearRadiusKm"'
        ]) {
            assert.ok(indexHtml.includes(newId), `public/index.html debe incluir ${newId}`);
        }

        // 3. Presencia de columna en_progreso_desde, helper computeSmartCommuteAlertSchedule y estilos responsivos
        assert.match(initSql, /en_progreso_desde\s+DATETIME\s+NULL/i);
        assert.ok(serverJs.includes('function computeSmartCommuteAlertSchedule('));
        assert.ok(frontendJs.includes('function openSmartCommuteSettingsSection('));
        assert.ok(styleCss.includes('.planner-course-status-badges') && styleCss.includes('.planner-commute-summary-box'));
    });

    it('lib/server-i18n.js mantiene paridad exacta de claves en/es, interpola variables y dashboard.html incluye i18n.js', () => {
        const serverI18n = require('../lib/server-i18n');
        assert.ok(serverI18n && serverI18n.DICTIONARIES);
        const enKeys = Object.keys(serverI18n.DICTIONARIES.en || {}).sort();
        const esKeys = Object.keys(serverI18n.DICTIONARIES.es || {}).sort();
        assert.deepStrictEqual(enKeys, esKeys, 'Diccionarios en y es en lib/server-i18n.js deben tener exactamente las mismas claves');

        for (const k of enKeys) {
            assert.strictEqual(typeof serverI18n.DICTIONARIES.en[k], 'string');
            assert.strictEqual(typeof serverI18n.DICTIONARIES.es[k], 'string');
            assert.ok(serverI18n.DICTIONARIES.en[k].length > 0, `Clave en vacia: ${k}`);
            assert.ok(serverI18n.DICTIONARIES.es[k].length > 0, `Clave es vacia: ${k}`);
            const enPlaceholders = [...serverI18n.DICTIONARIES.en[k].matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map(m => m[1]).sort();
            const esPlaceholders = [...serverI18n.DICTIONARIES.es[k].matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map(m => m[1]).sort();
            assert.deepStrictEqual(enPlaceholders, esPlaceholders, `Placeholders diferentes para ${k}`);
        }

        assert.strictEqual(serverI18n.isValidStrictUiLang('en'), true);
        assert.strictEqual(serverI18n.isValidStrictUiLang('es'), true);
        assert.strictEqual(serverI18n.isValidStrictUiLang('fr'), false);
        assert.strictEqual(serverI18n.normalizeUiLang('ES'), 'es');
        assert.strictEqual(serverI18n.normalizeUiLang('unknown', 'en'), 'en');
        assert.strictEqual(serverI18n.tServer('es', 'action.mark_done'), 'Marcar hecha');
        assert.strictEqual(serverI18n.tServer('en', 'action.mark_done'), 'Mark done');
        assert.strictEqual(serverI18n.tServer('es', 'action.snooze_15m'), 'Posponer 15m');
        assert.strictEqual(serverI18n.tServer('es', 'agenda.in_progress_title', { activity: 'Tesis' }), '⏳ Llevas 1 hora en progreso: Tesis');
        assert.strictEqual(serverI18n.tServer('en', 'agenda.in_progress_title', { activity: 'Tesis' }), '⏳ 1 hour in progress: Tesis');

        const dashHtml = fs.readFileSync(path.join(ROOT, 'public/dashboard.html'), 'utf8');
        assert.ok(dashHtml.includes('<script src="i18n.js" defer></script>'));
        assert.ok(dashHtml.includes('<script src="dashboard.js" defer></script>'));
    });

    it('elimina el bloque fijo Campus ITS (Croquis) y habilita drag & drop desde toda la tarjeta de Agenda sin afectar controles', () => {
        const indexHtml = readText('public/index.html');
        const frontendJs = readText('public/frontend.js');
        const i18nJs = readText('public/i18n.js');
        const styleCss = readText('public/style.css');

        // 1. Bloque fijo de 3 botones de Campus ITS eliminado de #view-horario
        for (const removedId of [
            'id="btnCampusPrincipalMap"',
            'id="btnCampusBoillotMap"',
            'id="btnCampusMiravalleMap"',
            'id="uniLocationSummaryText"'
        ]) {
            assert.strictEqual(indexHtml.includes(removedId), false, `public/index.html ya no debe incluir ${removedId}`);
        }
        assert.strictEqual(
            indexHtml.includes('ITS Campuses (Instituto Tecnológico de Saltillo Croquis)'),
            false,
            'public/index.html ya no debe incluir el encabezado fijo de Campus ITS (Croquis)'
        );
        for (const keptId of [
            'id="itsCroquisDirectoryCards"',
            'id="btnHomeOpenMapPicker"',
            'id="liveCommuteCardsContainer"',
            'id="btnPingPhoneGps"',
            'id="btnClearCurrentGps"',
            'id="uniLocationLat"',
            'id="uniLocationLng"'
        ]) {
            assert.ok(indexHtml.includes(keptId), `public/index.html debe conservar ${keptId}`);
        }

        // 2. Traducciones limpias y tooltip de tarjeta arrastrable en public/i18n.js
        for (const oldText of [
            '📍 Pin Campus Principal (CTO-002)',
            '📍 Pin Campus Blvd / Glorieta (CTO-004)',
            '📍 Pin Campus Miravalle (CTO-003)'
        ]) {
            assert.strictEqual(i18nJs.includes(oldText), false, `public/i18n.js no debe conservar texto obsoleto ${oldText}`);
        }
        assert.ok(
            i18nJs.includes("['Drag card to move', 'Arrastra la tarjeta para moverla']"),
            'public/i18n.js debe incluir la traducción de Drag card to move'
        );

        // 3. Helper isAgendaCardInteractiveTarget y comportamiento en tarjeta de Agenda
        assert.ok(frontendJs.includes('function isAgendaCardInteractiveTarget('), 'public/frontend.js debe definir isAgendaCardInteractiveTarget');
        assert.ok(frontendJs.includes('agenda-task-card'), 'public/frontend.js debe asignar clase .agenda-task-card');
        assert.ok(frontendJs.includes('agenda-status-select'), 'public/frontend.js debe incluir .agenda-status-select');

        const dragSandbox = {};
        const fnStart = frontendJs.indexOf('function isAgendaCardInteractiveTarget(');
        const fnEnd = frontendJs.indexOf('function wireAgendaCardDrag(', fnStart);
        assert.ok(fnStart > 0 && fnEnd > fnStart, 'No se pudo extraer isAgendaCardInteractiveTarget');
        vm.runInNewContext(frontendJs.slice(fnStart, fnEnd), dragSandbox);
        assert.strictEqual(typeof dragSandbox.isAgendaCardInteractiveTarget, 'function');

        const makeMockNode = (tagName, className = '', attrs = {}, parent = null) => ({
            nodeType: 1,
            tagName: tagName.toUpperCase(),
            className,
            parentElement: parent,
            getAttribute: (k) => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null),
            hasAttribute: (k) => Object.prototype.hasOwnProperty.call(attrs, k)
        });
        const cardEl = makeMockNode('div', 'agenda-item agenda-task-card');
        const titleEl = makeMockNode('span', 'agenda-item-text', {}, cardEl);
        const timeEl = makeMockNode('span', 'agenda-time-pill', {}, cardEl);
        const catEl = makeMockNode('span', 'agenda-cat-pill', {}, cardEl);
        const handleEl = makeMockNode('span', 'agenda-drag-handle', {}, cardEl);
        const checkBtn = makeMockNode('button', 'agenda-check-circle status-todo', {}, cardEl);
        const statusSel = makeMockNode('select', 'jira-status-select agenda-status-select', {}, cardEl);
        const postponeBtn = makeMockNode('button', 'agenda-mini-btn agenda-postpone-btn', {}, cardEl);
        const editIcon = makeMockNode('svg', '', {}, postponeBtn);
        const roleBtn = makeMockNode('div', 'custom-ctrl', { role: 'button' }, cardEl);
        const noDragEl = makeMockNode('span', 'badge', { 'data-no-drag': '1' }, cardEl);

        assert.strictEqual(dragSandbox.isAgendaCardInteractiveTarget(cardEl, cardEl), false);
        assert.strictEqual(dragSandbox.isAgendaCardInteractiveTarget(titleEl, cardEl), false);
        assert.strictEqual(dragSandbox.isAgendaCardInteractiveTarget(timeEl, cardEl), false);
        assert.strictEqual(dragSandbox.isAgendaCardInteractiveTarget(catEl, cardEl), false);
        assert.strictEqual(dragSandbox.isAgendaCardInteractiveTarget(handleEl, cardEl), false);
        assert.strictEqual(dragSandbox.isAgendaCardInteractiveTarget(checkBtn, cardEl), true);
        assert.strictEqual(dragSandbox.isAgendaCardInteractiveTarget(statusSel, cardEl), true);
        assert.strictEqual(dragSandbox.isAgendaCardInteractiveTarget(postponeBtn, cardEl), true);
        assert.strictEqual(dragSandbox.isAgendaCardInteractiveTarget(editIcon, cardEl), true);
        assert.strictEqual(dragSandbox.isAgendaCardInteractiveTarget(roleBtn, cardEl), true);
        assert.strictEqual(dragSandbox.isAgendaCardInteractiveTarget(noDragEl, cardEl), true);

        // 4. Estilos cursor grab/grabbing en tarjetas y pointer en controles
        assert.match(styleCss, /\.agenda-task-card[\s\S]*?cursor:\s*grab\b/);
        assert.match(styleCss, /\.agenda-task-card\.is-dragging[\s\S]*?cursor:\s*grabbing\b/);
        assert.match(styleCss, /\.agenda-item\s+\.agenda-status-select[\s\S]*?cursor:\s*pointer\b/);
    });

    it('mantiene documentación técnica completa en docs/, enlaces válidos en README.md, .dockerignore y cero secretos reales', () => {
        const readme = readText('README.md');
        const dockerignore = readText('.dockerignore');
        assert.ok(dockerignore.includes('docs'), '.dockerignore debe excluir docs/ del build Docker');

        for (const docPath of ['docs/CONCEPTOS_Y_ARQUITECTURA.md', 'docs/RECREAR_DESDE_CERO.md']) {
            const fullPath = path.resolve(ROOT, docPath);
            assert.equal(fs.existsSync(fullPath), true, `Debe existir ${docPath}`);
            assert.ok(readme.includes(`(${docPath})`), `README.md debe enlazar ${docPath}`);
            const text = readText(docPath);
            assert.match(text.slice(0, 1200), /## .*[ÍI]ndice/i, `${docPath} debe incluir índice al inicio`);
            assert.equal(text.includes('file:///'), false, `${docPath} no debe contener enlaces locales file:///`);
            assert.equal(text.includes('docs-privados'), false, `${docPath} no debe referenciar docs-privados`);
            assert.equal(text.includes('🌈'), false, `${docPath} no debe contener emoji arcoíris`);
            assert.equal(/flavio\.flax1234@gmail\.com/i.test(text), false, `${docPath} no debe incluir correos personales reales`);
            assert.equal(/C:\\\\Users\\\\flavi|C:\\Users\\flavi/i.test(text), false, `${docPath} no debe incluir rutas locales Windows personales`);
        }

        const archDoc = readText('docs/CONCEPTOS_Y_ARQUITECTURA.md');
        for (const conceptToken of ['pdh-j2', 'GET_LOCK', 'SyncRevisions', 'computeSmartCommuteAlertSchedule', 'isAgendaCardInteractiveTarget', 'lib/server-i18n.js', 'Blue-Green', 'Tailscale', 'rclone', 'ntfy']) {
            assert.ok(archDoc.includes(conceptToken), `docs/CONCEPTOS_Y_ARQUITECTURA.md debe documentar ${conceptToken}`);
        }

        const recreateDoc = readText('docs/RECREAR_DESDE_CERO.md');
        for (const phaseToken of ['Fase 1', 'Fase 2', 'Fase 3', 'Fase 4', 'Fase 5', 'Fase 6', 'Fase 7', 'init.sql', 'local-vault.js', 'blue-green.sh', 'npm test']) {
            assert.ok(recreateDoc.includes(phaseToken), `docs/RECREAR_DESDE_CERO.md debe documentar ${phaseToken}`);
        }
    });
});

describe('Agenda V4: Swipe Táctil en Vista Día, Repetición Google Calendar y Alineación de #agendaModal', () => {
    it('implementa swipe táctil exclusivo de móvil/tablet (sin PC), modal #agendaDeleteSeriesModal, hints debajo de combos y alineación en #agendaModal', () => {
        const initSql = readText('init.sql');
        const serverJs = readText('server.js');
        const indexHtml = readText('public/index.html');
        const frontendJs = readText('public/frontend.js');
        const styleCss = readText('public/style.css');
        const i18nJs = readText('public/i18n.js');

        // 1. Esquema y migración de serie_id
        assert.match(initSql, /serie_id\s+VARCHAR\(64\)\s+NULL/i);
        assert.match(initSql, /idx_agenda_serie_fecha\s*\(serie_id,\s*fecha\)/i);
        assert.match(serverJs, /serie_id\s+VARCHAR\(64\)\s+NULL/i);
        assert.match(serverJs, /idx_agenda_serie_fecha/);

        // 2. HTML de #agendaModal y #agendaDeleteSeriesModal + orden del hint de Bloque del día
        for (const requiredToken of [
            'id="agendaRepeatDays"',
            'min="2"',
            'max="90"',
            'value="days_daily"',
            'value="days_weekdays"',
            'id="agendaDeleteSeriesModal"',
            'id="btnDeleteAgendaSeriesSingle"',
            'id="btnDeleteAgendaSeriesFollowing"',
            'id="btnCancelAgendaDeleteSeries"'
        ]) {
            assert.ok(indexHtml.includes(requiredToken), `public/index.html debe incluir ${requiredToken}`);
        }

        const agendaModalStart = indexHtml.indexOf('id="agendaModal"');
        const agendaModalEnd = indexHtml.indexOf('id="e2eeKeyModal"', agendaModalStart);
        assert.ok(agendaModalStart > 0 && agendaModalEnd > agendaModalStart);
        const agendaModalHtml = indexHtml.slice(agendaModalStart, agendaModalEnd);

        const bloqueSelectPos = agendaModalHtml.indexOf('<select id="agendaBloque"');
        const bloqueSelectClosePos = agendaModalHtml.indexOf('</select>', bloqueSelectPos);
        const bloqueHintPos = agendaModalHtml.indexOf('id="agendaBloqueAutoHint"');
        assert.ok(bloqueSelectPos > 0 && bloqueSelectClosePos > bloqueSelectPos, 'Debe existir <select id="agendaBloque"> en #agendaModal');
        assert.ok(bloqueHintPos > bloqueSelectClosePos, 'El hint #agendaBloqueAutoHint debe colocarse DESPUÉS de </select> de #agendaBloque y nunca antes');

        // Ninguna fila .form-row-2 dentro de #agendaModal debe colocar <small> antes de <select> o <input>
        const row2Matches = [...agendaModalHtml.matchAll(/<div class="form-row-2[^"]*">([\s\S]*?)<\/div>\s*<\/div>/g)];
        assert.ok(row2Matches.length >= 4, 'Deben existir las filas de 2 columnas dentro de #agendaModal');
        for (const m of row2Matches) {
            const firstCtrlIdx = m[1].search(/<(?:select|input)\b/i);
            const firstSmallIdx = m[1].search(/<small\b/i);
            if (firstSmallIdx !== -1) {
                assert.ok(firstCtrlIdx !== -1 && firstSmallIdx > firstCtrlIdx, 'Los textos auxiliares <small> dentro de .form-row-2 deben ir después del control');
            }
        }

        // 3. CSS de alineación uniforme de combo boxes en #agendaModal y animación GPU del swipe
        assert.match(styleCss, /#agendaModal\s+\.form-row-2,\s*#agendaModal\s+\.agenda-form-row\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);[\s\S]*?align-items:\s*start;/);
        assert.match(styleCss, /#agendaModal\s+select,[\s\S]*?height:\s*44px;[\s\S]*?min-height:\s*44px;[\s\S]*?box-sizing:\s*border-box;/);
        assert.match(styleCss, /@media\s*\(\s*max-width:\s*640px\s*\)\s*\{[\s\S]*?#agendaModal\s+\.form-row-2,\s*#agendaModal\s+\.agenda-form-row\s*\{\s*grid-template-columns:\s*1fr;/);
        assert.ok(styleCss.includes('#agendaDayBoard') && styleCss.includes('is-swipe-anim-next') && styleCss.includes('is-swipe-anim-prev'));

        // 4. Traducciones bilingües EN/ES
        assert.ok(i18nJs.includes("['Delete recurring activity', 'Eliminar actividad repetitiva']"));
        assert.ok(i18nJs.includes("['Only this activity', 'Solo esta actividad']"));

        // 5. Lógica en frontend.js: swipe táctil exclusivo móvil/tablet, #agendaDeleteSeriesModal y repetición por X días
        for (const fnToken of [
            'function isAgendaDaySwipeAllowedEvent(',
            'function isAgendaSwipeIgnoredTarget(',
            'function evaluateAgendaDaySwipeGesture(',
            'function computeNextAgendaSwipeTarget(',
            'function initAgendaDaySwipeNavigation(',
            'function openAgendaDeleteSeriesDialog('
        ]) {
            assert.ok(frontendJs.includes(fnToken), `public/frontend.js debe definir ${fnToken}`);
        }
        assert.ok(frontendJs.includes('initAgendaDaySwipeNavigation();'), 'public/frontend.js debe inicializar initAgendaDaySwipeNavigation()');
        assert.ok(frontendJs.includes('agendaDeleteSeriesModal'), 'public/frontend.js debe integrar #agendaDeleteSeriesModal');

        // Evaluación aislada en sandbox VM de las funciones puras de swipe y repetición por X días
        const shiftIdx = frontendJs.indexOf('function shiftYmdDateClient(');
        const computeEndIdx = frontendJs.indexOf('function canMoveAgendaItemToDate(');
        const swipeStartIdx = frontendJs.indexOf('function isAgendaDaySwipeAllowedEvent(');
        const swipeEndIdx = frontendJs.indexOf('function scrollActiveAgendaDayTabIntoView(');
        assert.ok(shiftIdx > 0 && computeEndIdx > shiftIdx && swipeStartIdx > 0 && swipeEndIdx > swipeStartIdx);

        const sandbox = { agendaDragRuntime: { started: false, longPressArmed: false } };
        vm.runInNewContext(
            `${frontendJs.slice(shiftIdx, computeEndIdx)}\n${frontendJs.slice(swipeStartIdx, swipeEndIdx)}`,
            sandbox
        );

        // Regla estricta de dispositivo: ratón/PC bloqueado, táctil permitido
        assert.strictEqual(sandbox.isAgendaDaySwipeAllowedEvent({ pointerType: 'mouse' }), false);
        assert.strictEqual(sandbox.isAgendaDaySwipeAllowedEvent({ pointerType: 'touch' }), true);
        assert.strictEqual(
            sandbox.isAgendaDaySwipeAllowedEvent({ touches: [{}] }, { coarsePointer: true, hasTouchSupport: true, viewportWidth: 412 }),
            true
        );
        assert.strictEqual(
            sandbox.isAgendaDaySwipeAllowedEvent({ touches: [{}] }, { coarsePointer: false, hasTouchSupport: false, viewportWidth: 1440 }),
            false
        );
        assert.strictEqual(
            sandbox.isAgendaDaySwipeAllowedEvent({ touches: [{}] }, { coarsePointer: false, hasTouchSupport: true, viewportWidth: 1440 }),
            false
        );
        assert.strictEqual(
            sandbox.isAgendaDaySwipeAllowedEvent({ touches: [{}] }, { coarsePointer: false, hasTouchSupport: true, viewportWidth: 768 }),
            true
        );

        // Umbrales calibrados para pulgar: >= 35px (|dx| >= |dy|*1.15, <= 900ms) o flick >= 24px (>= 0.22 px/ms)
        assert.deepEqual(
            JSON.parse(JSON.stringify(sandbox.evaluateAgendaDaySwipeGesture({ deltaX: -85, deltaY: 12, durationMs: 240 }))),
            { triggered: true, direction: 'next' }
        );
        assert.deepEqual(
            JSON.parse(JSON.stringify(sandbox.evaluateAgendaDaySwipeGesture({ deltaX: 90, deltaY: -10, durationMs: 220 }))),
            { triggered: true, direction: 'prev' }
        );
        assert.strictEqual(sandbox.evaluateAgendaDaySwipeGesture({ deltaX: -20, deltaY: 0, durationMs: 180 }).triggered, false);
        assert.strictEqual(sandbox.evaluateAgendaDaySwipeGesture({ deltaX: -40, deltaY: 55, durationMs: 200 }).triggered, false);
        assert.strictEqual(sandbox.evaluateAgendaDaySwipeGesture({ deltaX: -90, deltaY: 0, durationMs: 1050 }).triggered, false);

        // Ignorar objetivos interactivos, pestañas, rejilla y Drag & Drop activo
        const mkEl = (id = '', tagName = 'DIV', className = '', parentElement = null) => ({
            nodeType: 1,
            id,
            tagName,
            className,
            parentElement,
            getAttribute: () => null
        });
        assert.strictEqual(sandbox.isAgendaSwipeIgnoredTarget(mkEl('agendaDayTabs', 'DIV')), true);
        assert.strictEqual(sandbox.isAgendaSwipeIgnoredTarget(mkEl('agendaTableScroll', 'DIV')), true);
        assert.strictEqual(sandbox.isAgendaSwipeIgnoredTarget(mkEl('', 'SELECT')), true);
        assert.strictEqual(sandbox.isAgendaSwipeIgnoredTarget(mkEl('', 'BUTTON')), true);
        assert.strictEqual(sandbox.isAgendaSwipeIgnoredTarget(mkEl('', 'DIV', 'agenda-mobile-block-body')), false);
        sandbox.agendaDragRuntime.started = true;
        assert.strictEqual(sandbox.isAgendaSwipeIgnoredTarget(mkEl('', 'DIV', 'agenda-mobile-block-body')), true);
        sandbox.agendaDragRuntime.started = false;

        // Salto de semanas respetando Solo Lun-Vie y Lun-Dom
        const monFriDays = [
            { fecha: '2026-11-30' },
            { fecha: '2026-12-01' },
            { fecha: '2026-12-02' },
            { fecha: '2026-12-03' },
            { fecha: '2026-12-04' }
        ];
        assert.deepEqual(
            JSON.parse(JSON.stringify(sandbox.computeNextAgendaSwipeTarget({
                direction: 'next',
                visibleDays: monFriDays,
                selectedDate: '2026-12-04',
                weekOffset: 0,
                showWeekend: false
            }))),
            { nextSelectedDate: '2026-12-07', nextWeekOffset: 1, crossedWeek: true }
        );
        assert.deepEqual(
            JSON.parse(JSON.stringify(sandbox.computeNextAgendaSwipeTarget({
                direction: 'prev',
                visibleDays: monFriDays,
                selectedDate: '2026-11-30',
                weekOffset: 0,
                showWeekend: false
            }))),
            { nextSelectedDate: '2026-11-27', nextWeekOffset: -1, crossedWeek: true }
        );

        // Repetición por X días (todos los días vs Lun-Vie)
        assert.deepEqual(
            Array.from(sandbox.computeAgendaRepeatDates({ startDate: '2026-11-27', mode: 'days_daily', repeatDays: 4 })),
            ['2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30']
        );
        assert.deepEqual(
            Array.from(sandbox.computeAgendaRepeatDates({ startDate: '2026-11-27', mode: 'days_weekdays', repeatDays: 4 })),
            ['2026-11-27', '2026-11-30', '2026-12-01', '2026-12-02']
        );
    });
});

describe('Pizarra de Trazo Hangul (Sin Guardar, Offline & Touch-Safe)', () => {
    it('integra #hangulTraceStudio dentro de #englishHangulPracticeStudio con touch-action: none, CSP local y cero guardado en Word/BD', () => {
        const indexHtml = readText('public/index.html');
        const styleCss = readText('public/style.css');
        const frontendJs = readText('public/frontend.js');
        const i18nJs = readText('public/i18n.js');
        const recognizerJs = readText('public/hangul-trace-recognizer.js');

        // 1. Carga local compatible con script-src 'self' y ubicación dentro de #englishHangulPracticeStudio
        assert.match(indexHtml, /<script[^>]+src=["']hangul-trace-recognizer\.js["']/i);
        assert.equal(/https?:\/\/.*hangul-trace-recognizer/i.test(indexHtml), false);

        const studioStart = indexHtml.indexOf('id="englishHangulPracticeStudio"');
        const studioEnd = indexHtml.indexOf('id="englishAlphabetStudio"', studioStart);
        assert.ok(studioStart > 0 && studioEnd > studioStart, 'Debe existir #englishHangulPracticeStudio antes de #englishAlphabetStudio');
        const hangulStudioHtml = indexHtml.slice(studioStart, studioEnd);

        for (const requiredId of [
            'id="hangulTraceStudio"',
            'id="hangulTraceCanvas"',
            'id="hangulTraceGuideSelect"',
            'id="chkHangulTraceAutoRecognize"',
            'id="btnHangulTraceRecognize"',
            'id="btnHangulTraceUndo"',
            'id="btnHangulTraceClear"',
            'id="btnHangulTraceToggleGuide"',
            'id="btnHangulTraceRandom"',
            'id="btnHangulTraceSpeak"',
            'id="btnHangulPracticeSelectedTrace"',
            'id="hangulTraceResult"'
        ]) {
            assert.ok(hangulStudioHtml.includes(requiredId), `#englishHangulPracticeStudio debe incluir ${requiredId}`);
        }

        // 2. Reglas CSS de touch-action: none y layout responsivo
        assert.match(styleCss, /#hangulTraceCanvas,\s*\.hangul-trace-canvas\s*\{[\s\S]*?touch-action:\s*none;[\s\S]*?user-select:\s*none;/);
        assert.match(styleCss, /\.hangul-trace-body\s*\{[\s\S]*?grid-template-columns:/);
        assert.match(styleCss, /@media\s*\(\s*max-width:\s*640px\s*\)\s*\{[\s\S]*?\.hangul-trace-body\s*\{\s*grid-template-columns:\s*1fr;/);

        // 3. Traducciones bilingües EN/ES
        assert.ok(i18nJs.includes("['✍️ Hangul Tracing Pad (No Save)', '✍️ Pizarra de Trazo Hangul (Sin Guardar)']"));
        assert.ok(i18nJs.includes('hangul_trace_empty_hint'));

        // 4. Verificación estricta de cero persistencia en frontend.js (initHangulTracingPad) y hangul-trace-recognizer.js
        const fnStart = frontendJs.indexOf('function initHangulTracingPad(');
        const fnEnd = frontendJs.indexOf('var koreanReadonlyNotesInitialized', fnStart);
        assert.ok(fnStart > 0 && fnEnd > fnStart, 'Debe existir function initHangulTracingPad en public/frontend.js');
        const tracingFnBody = frontendJs.slice(fnStart, fnEnd);

        for (const forbidden of ['/api/send-english', '/api/send-to-pc', 'submitMutationRequest', 'resilientFetchJson', 'localStorage', 'sessionStorage', 'fetch(']) {
            assert.equal(tracingFnBody.includes(forbidden), false, `initHangulTracingPad no debe usar ${forbidden}`);
            assert.equal(recognizerJs.includes(forbidden), false, `hangul-trace-recognizer.js no debe usar ${forbidden}`);
        }
        assert.ok(tracingFnBody.includes('HangulTraceRecognizer'), 'initHangulTracingPad debe invocar HangulTraceRecognizer');
        assert.ok(tracingFnBody.includes('speakStudyText('), 'initHangulTracingPad debe reutilizar speakStudyText para ko-KR');
    });
});

describe('Agenda V5: Sensibilidad y Confiabilidad del Swipe Táctil en Vista Día', () => {
    it('implementa evaluateAgendaDaySwipe sensible para pulgar, eventos táctiles nativos (sin PC/ratón) y CSS touch-action: pan-y en móvil/tablet', () => {
        const frontendJs = readText('public/frontend.js');
        const styleCss = readText('public/style.css');

        // 1. Contrato en frontend.js
        assert.ok(frontendJs.includes('function evaluateAgendaDaySwipe('), 'public/frontend.js debe definir evaluateAgendaDaySwipe');
        assert.ok(frontendJs.includes('window.evaluateAgendaDaySwipe = evaluateAgendaDaySwipe;'), 'evaluateAgendaDaySwipe debe exponerse en window');

        const initStart = frontendJs.indexOf('function initAgendaDaySwipeNavigation(');
        const initEnd = frontendJs.indexOf('initAgendaDaySwipeNavigation();', initStart);
        assert.ok(initStart > 0 && initEnd > initStart, 'Debe existir initAgendaDaySwipeNavigation');
        const initBody = frontendJs.slice(initStart, initEnd);

        for (const requiredToken of [
            "addEventListener('touchstart'",
            "addEventListener('touchmove'",
            "addEventListener('touchend'",
            "addEventListener('touchcancel'",
            "lastPointerType === 'mouse'",
            'EDGE_GUARD_PX = 16',
            'MAX_FEEDBACK_PX = 28',
            'SWIPE_COOLDOWN_MS = 180',
            'hasDraggingCard()',
            'cleanupAgendaDragState()'
        ]) {
            assert.ok(initBody.includes(requiredToken), `initAgendaDaySwipeNavigation debe incluir ${requiredToken}`);
        }
        assert.equal(initBody.includes("addEventListener('pointercancel'"), false, 'No debe depender de pointercancel móvil');

        // 2. Evaluación aislada en VM de evaluateAgendaDaySwipe y compatibilidad con tarjetas/handles
        const swipeStartIdx = frontendJs.indexOf('function isAgendaDaySwipeAllowedEvent(');
        const swipeEndIdx = frontendJs.indexOf('function scrollActiveAgendaDayTabIntoView(');
        assert.ok(swipeStartIdx > 0 && swipeEndIdx > swipeStartIdx);

        const sandbox = { agendaDragRuntime: { started: false, longPressArmed: false, handleEl: null } };
        vm.runInNewContext(frontendJs.slice(swipeStartIdx, swipeEndIdx), sandbox);

        // Casos obligatorios pedidos para pulgar y flick
        assert.strictEqual(sandbox.evaluateAgendaDaySwipe({ deltaX: -38, deltaY: 20, durationMs: 250 }), 'next');
        assert.strictEqual(sandbox.evaluateAgendaDaySwipe({ deltaX: 26, deltaY: 10, durationMs: 90 }), 'prev');
        assert.strictEqual(sandbox.evaluateAgendaDaySwipe({ deltaX: 18, deltaY: 95 }), null);

        // Casos adicionales de frontera
        assert.strictEqual(sandbox.evaluateAgendaDaySwipe({ deltaX: 42, deltaY: -24, durationMs: 820 }), 'prev');
        assert.strictEqual(sandbox.evaluateAgendaDaySwipe({ deltaX: -28, deltaY: 4, durationMs: 250 }), null);
        assert.strictEqual(sandbox.evaluateAgendaDaySwipe({ deltaX: -95, deltaY: 0, durationMs: 1050 }), null);
        assert.strictEqual(sandbox.evaluateAgendaDaySwipe({ deltaX: -40, deltaY: 40, durationMs: 150 }), null);

        // Tarjeta .agenda-item permite iniciar swipe antes del long-press; handle .agenda-drag-handle lo bloquea
        const mkEl = (id = '', tagName = 'DIV', className = '', parentElement = null) => ({
            nodeType: 1,
            id,
            tagName,
            className,
            parentElement,
            getAttribute: () => null
        });
        assert.strictEqual(sandbox.isAgendaSwipeIgnoredTarget(mkEl('', 'DIV', 'agenda-item')), false);
        assert.strictEqual(sandbox.isAgendaSwipeIgnoredTarget(mkEl('', 'SPAN', 'agenda-drag-handle')), true);
        sandbox.agendaDragRuntime.started = true;
        assert.strictEqual(sandbox.isAgendaSwipeIgnoredTarget(mkEl('', 'DIV', 'agenda-item')), true);
        sandbox.agendaDragRuntime.started = false;

        // 3. Reglas CSS en móvil/tablet vs PC, tabs, rejilla y drag handle
        assert.match(
            styleCss,
            /@media\s*\(\s*pointer:\s*coarse\s*\)\s*,\s*\(\s*max-width:\s*1024px\s*\)\s*\{[\s\S]*?#agendaDayBoard\s*\{[\s\S]*?touch-action:\s*pan-y;[\s\S]*?overscroll-behavior-x:\s*contain;/
        );
        assert.match(styleCss, /#agendaDayTabs,[\s\S]*?#agendaTableScroll[\s\S]*?\{[\s\S]*?touch-action:\s*pan-x pan-y;/);
        assert.match(styleCss, /\.agenda-drag-handle\s*\{[\s\S]*?touch-action:\s*none;/);
    });
});

describe('Agenda V6: Modal y Alcance al Editar Actividades Repetitivas (Google Calendar)', () => {
    it('incluye #agendaEditSeriesModal, botones EN/ES y lógica frontend de scope single vs following sin cerrar #agendaModal al cancelar', () => {
        const indexHtml = readText('public/index.html');
        const styleCss = readText('public/style.css');
        const frontendJs = readText('public/frontend.js');
        const i18nJs = readText('public/i18n.js');

        // 1. HTML del modal #agendaEditSeriesModal y controles sin IDs duplicados
        for (const requiredId of [
            'id="agendaEditSeriesModal"',
            'id="btnCloseAgendaEditSeriesModal"',
            'id="agendaEditSeriesTitle"',
            'id="agendaEditSeriesItemTitle"',
            'id="agendaEditSeriesItemDate"',
            'id="agendaEditSeriesNotice"',
            'id="btnAgendaEditScopeSingle"',
            'id="btnAgendaEditScopeFollowing"',
            'id="btnAgendaEditScopeCancel"'
        ]) {
            assert.ok(indexHtml.includes(requiredId), `public/index.html debe contener ${requiredId}`);
        }

        // 2. CSS apilado sobre #agendaModal y estilos responsivos/oscuros
        assert.match(styleCss, /#agendaDeleteSeriesModal,\s*#agendaEditSeriesModal\s*\{[\s\S]*?z-index:\s*1260;/);
        assert.ok(styleCss.includes('.agenda-edit-series-notice'));

        // 3. Traducciones bilingües EN/ES completas
        for (const expectedI18n of [
            "['Edit recurring activity', 'Editar actividad repetitiva']",
            "['Past recurring occurrences cannot be edited.', 'Las actividades repetitivas de días anteriores no se pueden editar.']",
            "['Invalid edit scope (allowed: single, following).', 'Alcance de edición inválido (permitidos: single, following).']",
            "['Recurring activities updated successfully.', 'Actividades repetitivas actualizadas correctamente.']",
            'Updated this activity and'
        ]) {
            assert.ok(i18nJs.includes(expectedI18n), `public/i18n.js debe incluir ${expectedI18n}`);
        }

        // 4. Frontend: diálogo openAgendaEditSeriesDialog, protección de Escape y envío con scope
        assert.ok(frontendJs.includes('function openAgendaEditSeriesDialog('), 'public/frontend.js debe definir openAgendaEditSeriesDialog');
        const dialogStart = frontendJs.indexOf('function openAgendaEditSeriesDialog(');
        const dialogEnd = frontendJs.indexOf('const agendaModal = document.getElementById', dialogStart);
        assert.ok(dialogStart > 0 && dialogEnd > dialogStart);
        const dialogBody = frontendJs.slice(dialogStart, dialogEnd);
        assert.ok(dialogBody.includes("finish('single')") && dialogBody.includes("finish('following')") && dialogBody.includes('finish(null)'));
        assert.equal(dialogBody.includes('cerrarAgendaModal'), false, 'Cancelar #agendaEditSeriesModal nunca debe cerrar #agendaModal');

        assert.ok(frontendJs.includes('/api/update-agenda/${editId}?scope=${encodeURIComponent(editScope)}'));
        assert.ok(frontendJs.includes('payload.scope = editScope'));
    });
});

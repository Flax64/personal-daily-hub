(function (global) {
    'use strict';

    function tr(en, es) {
        if (global.DailyHubI18n && typeof global.DailyHubI18n.pick === 'function') {
            return global.DailyHubI18n.pick(en, es);
        }
        return en;
    }

    function currentUiLang() {
        if (global.DailyHubI18n && typeof global.DailyHubI18n.getLang === 'function') {
            return global.DailyHubI18n.getLang();
        }
        return 'en';
    }

    function trServer(msg) {
        if (!msg) return '';
        if (global.DailyHubI18n && typeof global.DailyHubI18n.translateServerMessage === 'function') {
            return global.DailyHubI18n.translateServerMessage(msg);
        }
        return String(msg);
    }

    /**
     * Reusable Bilingual Translator Controller shared by:
     * 1) Inline Language Studio card (#languageTranslatorPanel)
     * 2) Global Extension Floating Drawer (#floatingTranslatorModal)
     * 3) Standalone Extension Popup Window (/translator-popup.html)
     */

    function copyTextFallback(text) {
        const str = String(text || '');
        if (!str) return Promise.resolve(false);
        if (navigator.clipboard && window.isSecureContext && typeof navigator.clipboard.writeText === 'function') {
            return navigator.clipboard.writeText(str).then(() => true).catch(() => copyExecFallback(str));
        }
        return Promise.resolve(copyExecFallback(str));
    }

    function copyExecFallback(str) {
        try {
            const ta = document.createElement('textarea');
            ta.value = str;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return Boolean(ok);
        } catch (_) {
            return false;
        }
    }

    function defaultResilientFetch(url, fetchOpts, { timeoutMs = 50000, externalSignal = null, maxRetries = 1 } = {}) {
        const runAttempt = (attempt) => {
            const controller = typeof AbortController === 'function' ? new AbortController() : null;
            let timedOut = false;
            const timer = controller && timeoutMs > 0
                ? setTimeout(() => {
                    timedOut = true;
                    controller.abort();
                }, timeoutMs)
                : null;

            const onExternalAbort = () => {
                if (controller) controller.abort();
            };
            if (externalSignal && typeof externalSignal.addEventListener === 'function') {
                if (externalSignal.aborted) controller && controller.abort();
                else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
            }

            return fetch(url, {
                ...fetchOpts,
                signal: controller ? controller.signal : externalSignal || undefined
            })
                .then(async (res) => {
                    const rawText = await res.text();
                    if (!res.ok) {
                        const retryableStatus = res.status === 408 || res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
                        if (retryableStatus && attempt < maxRetries && !(externalSignal && externalSignal.aborted)) {
                            await new Promise((r) => setTimeout(r, 900 * (attempt + 1)));
                            return runAttempt(attempt + 1);
                        }
                        return {
                            ok: false,
                            aborted: false,
                            status: res.status,
                            data: null,
                            isNetworkIssue: res.status >= 500 || res.status === 0,
                            errorMessage: rawText && rawText.length < 220 && !/<[a-z][\s\S]*>/i.test(rawText)
                                ? trServer(rawText)
                                : tr(`Server error (HTTP ${res.status}). Please retry.`, `Error del servidor (HTTP ${res.status}). Reintenta.`)
                        };
                    }
                    try {
                        const parsed = rawText ? JSON.parse(rawText) : {};
                        return { ok: true, aborted: false, status: res.status, data: parsed, isNetworkIssue: false, errorMessage: '' };
                    } catch (_) {
                        if (attempt < maxRetries && !(externalSignal && externalSignal.aborted)) {
                            await new Promise((r) => setTimeout(r, 900 * (attempt + 1)));
                            return runAttempt(attempt + 1);
                        }
                        return {
                            ok: false,
                            aborted: false,
                            status: res.status,
                            data: null,
                            isNetworkIssue: true,
                            errorMessage: tr(
                                'Incomplete response from server due to a possible network interruption.',
                                'Respuesta incompleta del servidor por posible corte de red.'
                            )
                        };
                    }
                })
                .catch(async (err) => {
                    if (err && err.name === 'AbortError' && !timedOut && externalSignal && externalSignal.aborted) {
                        return { ok: false, aborted: true, status: 0, data: null, isNetworkIssue: false, errorMessage: '' };
                    }
                    if (attempt < maxRetries && !(externalSignal && externalSignal.aborted)) {
                        await new Promise((r) => setTimeout(r, 900 * (attempt + 1)));
                        return runAttempt(attempt + 1);
                    }
                    if (timedOut) {
                        return {
                            ok: false,
                            aborted: false,
                            status: 0,
                            data: null,
                            isNetworkIssue: true,
                            errorMessage: tr(
                                'Request timed out (slow network or temporary cut). Please retry.',
                                'Tiempo de espera agotado (red lenta o corte temporal). Reintenta.'
                            )
                        };
                    }
                    return {
                        ok: false,
                        aborted: false,
                        status: 0,
                        data: null,
                        isNetworkIssue: true,
                        errorMessage: tr(
                            'No stable connection to the server. Check your Wi-Fi or mobile data and try again.',
                            'Sin conexión estable con el servidor. Revisa tu Wi-Fi o datos móviles e intenta de nuevo.'
                        )
                    };
                })
                .finally(() => {
                    if (timer) clearTimeout(timer);
                    if (externalSignal && typeof externalSignal.removeEventListener === 'function') {
                        externalSignal.removeEventListener('abort', onExternalAbort);
                    }
                });
        };
        return runAttempt(0);
    }

    function defaultLoadingNode(message) {
        const wrap = document.createElement('div');
        wrap.className = 'loading-banner';
        const sp = document.createElement('span');
        sp.className = 'spinner-circle';
        const txt = document.createElement('span');
        txt.textContent = message || tr('Translating...', 'Traduciendo...');
        wrap.append(sp, txt);
        return wrap;
    }

    function defaultFallbackCard(container, { title, message, onRetry }) {
        if (!container) return;
        const box = document.createElement('div');
        box.className = 'ai-network-fallback';

        const h = document.createElement('strong');
        h.textContent = `⚠️ ${title || tr('Temporary connection error', 'Error temporal de conexión')}`;
        const p = document.createElement('small');
        p.textContent = message || tr('Could not complete the translation.', 'No se pudo completar la traducción.');

        const actions = document.createElement('div');
        actions.className = 'ai-network-fallback-actions';
        if (typeof onRetry === 'function') {
            const btnRetry = document.createElement('button');
            btnRetry.type = 'button';
            btnRetry.className = 'btn-primary btn-small';
            btnRetry.textContent = tr('🔄 Retry', '🔄 Reintentar');
            btnRetry.addEventListener('click', onRetry);
            actions.appendChild(btnRetry);
        }
        box.append(h, p, actions);
        container.replaceChildren(box);
        container.hidden = false;
    }

    function defaultButtonLock(btn, fn, { loadingText = tr('Translating...', 'Traduciendo...') } = {}) {
        if (!btn) return Promise.resolve().then(fn);
        const origText = btn.textContent;
        btn.disabled = true;
        btn.textContent = loadingText;
        return Promise.resolve()
            .then(fn)
            .finally(() => {
                btn.disabled = false;
                btn.textContent = origText;
            });
    }

    function detectSourceScriptClient(text) {
        const clean = String(text || '').trim();
        if (!clean) return 'auto';
        const hasHangul = /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/.test(clean);
        const hasJa = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(clean);
        if (hasHangul) return 'ko';
        if (hasJa) return 'ja';
        if (/[A-Za-z]/.test(clean)) return 'en';
        return 'auto';
    }

    function openPopupWindow({ text = '', dir = 'auto', engine = 'auto', context = '' } = {}) {
        const params = new URLSearchParams();
        if (dir) params.set('dir', dir);
        if (engine) params.set('engine', engine);
        if (text) params.set('text', String(text).slice(0, 1200));
        if (context) params.set('context', String(context).slice(0, 250));
        const qs = params.toString();
        const url = qs ? `/translator-popup.html?${qs}` : '/translator-popup.html';
        const win = window.open(
            url,
            'pdhTranslatorExtensionWindow',
            'width=450,height=680,menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes'
        );
        if (win && typeof win.focus === 'function') {
            win.focus();
        }
        return Boolean(win);
    }

    function renderTranslationCard(resultBox, data, { onSendToStudyForm, onOpenAiSettings, onToast } = {}) {
        if (!resultBox || !data) return;
        resultBox.replaceChildren();
        resultBox.hidden = false;

        const notify = typeof onToast === 'function' ? onToast : () => {};
        const dir = String(data.direction || 'auto');
        const targetLangCode = (dir === 'ko_en' || dir === 'ja_en' || dir === 'es_en') ? 'en' : 'es';
        const srcLabelMap = {
            ko: tr('🇰🇷 Korean', '🇰🇷 Coreano'),
            ja: tr('🇯🇵 Japanese', '🇯🇵 Japonés'),
            en: tr('🇺🇸 English', '🇺🇸 Inglés'),
            es: tr('🇪🇸 Spanish', '🇪🇸 Español')
        };
        const srcCode = dir.split('_')[0] || detectSourceScriptClient(data.sourceText) || 'en';
        const srcHuman = srcLabelMap[srcCode] || tr('Auto', 'Auto');
        const tgtHuman = targetLangCode === 'en' ? tr('🇺🇸 English', '🇺🇸 Inglés') : tr('🇪🇸 Spanish', '🇪🇸 Español');

        const headRow = document.createElement('div');
        headRow.className = 'lang-translator-footer';

        const dirBadge = document.createElement('span');
        dirBadge.className = 'lang-ai-badge';
        dirBadge.setAttribute('data-no-i18n', 'true');
        dirBadge.textContent = `${srcHuman} → ${tgtHuman}`;

        const engBadge = document.createElement('span');
        engBadge.className = 'lang-ai-badge';
        engBadge.textContent = data.engine === 'gemini'
            ? `🤖 Gemini (${data.model || 'gemini'})`
            : tr('⚡ Instant Local', '⚡ Local Instantáneo');

        headRow.append(dirBadge, engBadge);
        resultBox.appendChild(headRow);

        // Google Translate-style clean primary translation box
        const primaryBox = document.createElement('div');
        primaryBox.className = 'gt-result-primary-box';

        const tgtHdr = document.createElement('div');
        tgtHdr.className = 'gt-result-target-hdr';
        const tgtTitle = document.createElement('span');
        tgtTitle.textContent = data.partOfSpeech
            ? `${tgtHuman} · ${data.partOfSpeech}`
            : tgtHuman;
        tgtHdr.appendChild(tgtTitle);
        primaryBox.appendChild(tgtHdr);

        const mainVal = document.createElement('div');
        mainVal.className = 'gt-result-main-text';
        mainVal.setAttribute('data-no-i18n', 'true');
        const primaryText = targetLangCode === 'en'
            ? (data.translatedText || data.englishBridge || '')
            : (data.translatedText || data.spanishMeaning || '');
        mainVal.textContent = primaryText;
        primaryBox.appendChild(mainVal);

        if (data.romanization) {
            const rom = document.createElement('div');
            rom.className = 'lang-translator-rom';
            rom.setAttribute('data-no-i18n', 'true');
            rom.textContent = `[${data.romanization}]`;
            primaryBox.appendChild(rom);
        }

        resultBox.appendChild(primaryBox);

        // Clean secondary nuance/bridge details when helpful (never redundant when target already displays the same string)
        const secNorm = String(data.spanishMeaning || '').trim();
        const priNorm = String(primaryText || '').trim();
        const showEsSub = secNorm && secNorm !== priNorm;
        const showBridge = data.englishBridge && targetLangCode !== 'en' && String(data.englishBridge).trim() !== priNorm;
        if (showEsSub || showBridge || data.explanationEs) {
            const subBox = document.createElement('div');
            subBox.className = 'lang-translator-card';
            if (showEsSub) {
                const esLine = document.createElement('div');
                esLine.setAttribute('data-no-i18n', 'true');
                esLine.style.fontWeight = '600';
                esLine.textContent = `🇪🇸 ${secNorm}`;
                subBox.appendChild(esLine);
            }
            if (showBridge) {
                const brLine = document.createElement('small');
                brLine.setAttribute('data-no-i18n', 'true');
                brLine.textContent = `🇺🇸 ${tr('English', 'Inglés')}: ${data.englishBridge}`;
                subBox.appendChild(brLine);
            }
            if (data.explanationEs) {
                const exp = document.createElement('small');
                exp.className = 'muted-text';
                exp.setAttribute('data-no-i18n', 'true');
                exp.textContent = data.explanationEs;
                subBox.appendChild(exp);
            }
            resultBox.appendChild(subBox);
        }

        if (data.literalMeaning) {
            const lit = document.createElement('small');
            lit.className = 'muted-text';
            lit.setAttribute('data-no-i18n', 'true');
            lit.textContent = `Literal: ${data.literalMeaning}`;
            resultBox.appendChild(lit);
        }

        if (Array.isArray(data.alternatives) && data.alternatives.length) {
            const alts = document.createElement('small');
            alts.setAttribute('data-no-i18n', 'true');
            alts.textContent = `${tr('Other forms / nuances', 'Otras formas / matices')}: ${data.alternatives.join(' · ')}`;
            resultBox.appendChild(alts);
        }

        if (Array.isArray(data.examples) && data.examples.length) {
            const firstEx = data.examples[0];
            const exText = typeof firstEx === 'string'
                ? firstEx
                : [firstEx?.source, firstEx?.translation].filter(Boolean).join(' → ');
            if (exText) {
                const ex = document.createElement('small');
                ex.className = 'muted-text';
                ex.setAttribute('data-no-i18n', 'true');
                ex.textContent = `${tr('Example', 'Ejemplo')}: ${exText}`;
                resultBox.appendChild(ex);
            }
        }

        if (data.autoSwitchedNote) {
            const note = document.createElement('small');
            note.className = 'muted-text';
            note.textContent = `ℹ️ ${trServer(data.autoSwitchedNote)}`;
            resultBox.appendChild(note);
        }

        if (data.fallbackReason) {
            const warnRow = document.createElement('div');
            warnRow.className = 'lang-translator-fallback-hint';
            const warn = document.createElement('small');
            warn.className = 'muted-text';
            warn.textContent = `⚠️ ${trServer(data.fallbackReason)}`;
            warnRow.appendChild(warn);

            if (/Gemini|GEMINI_API_KEY|404|401|403/i.test(String(data.fallbackReason))) {
                const cfgBtn = document.createElement('button');
                cfgBtn.type = 'button';
                cfgBtn.className = 'btn-secondary btn-small';
                cfgBtn.textContent = tr('⚙️ Configure / Test AI in Settings', '⚙️ Configurar / Probar IA en Ajustes');
                cfgBtn.addEventListener('click', () => {
                    if (typeof onOpenAiSettings === 'function') {
                        onOpenAiSettings();
                    } else if (window.opener && !window.opener.closed && window.opener.location) {
                        window.opener.postMessage({ type: 'pdh_open_ai_settings' }, window.location.origin);
                        window.opener.focus();
                    } else {
                        window.open('/#settings', '_blank', 'noopener noreferrer');
                    }
                });
                warnRow.appendChild(cfgBtn);
            }
            resultBox.appendChild(warnRow);
        }

        const footer = document.createElement('div');
        footer.className = 'lang-translator-footer';

        if (typeof onSendToStudyForm === 'function') {
            const sendBtn = document.createElement('button');
            sendBtn.type = 'button';
            sendBtn.className = 'btn-secondary btn-small';
            sendBtn.textContent = tr('📝 Send to Vocabulary Study Form', '📝 Enviar al Formulario de Estudio');
            sendBtn.addEventListener('click', () => onSendToStudyForm(data));
            footer.appendChild(sendBtn);
        }

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'btn-secondary btn-small';
        copyBtn.textContent = tr('📋 Copy Translation', '📋 Copiar Traducción');
        copyBtn.addEventListener('click', async () => {
            const txt = data.translatedText || '';
            const ok = await copyTextFallback(txt);
            notify(
                ok ? 'ok' : 'info',
                ok
                    ? tr('Translation copied to clipboard.', 'Traducción copiada al portapapeles.')
                    : `${tr('Translation', 'Traducción')}: ${txt}`
            );
        });
        footer.appendChild(copyBtn);

        if (data.romanization) {
            const copyRomBtn = document.createElement('button');
            copyRomBtn.type = 'button';
            copyRomBtn.className = 'btn-secondary btn-small';
            copyRomBtn.textContent = tr('🔤 Copy Romanization', '🔤 Copiar Romanización');
            copyRomBtn.addEventListener('click', async () => {
                const ok = await copyTextFallback(data.romanization);
                notify(
                    ok ? 'ok' : 'info',
                    ok ? tr('Romanization copied.', 'Romanización copiada.') : data.romanization
                );
            });
            footer.appendChild(copyRomBtn);
        }

        resultBox.appendChild(footer);
    }

    function mountTranslatorInstance(config) {
        const {
            panel,
            dirPills = [],
            dirSelect,
            engineSelect,
            inputEl,
            contextEl,
            btnRun,
            btnPaste,
            btnClear,
            btnPopout,
            resultBox,
            fetchJsonFn = defaultResilientFetch,
            buttonLockFn = defaultButtonLock,
            renderFallbackFn = defaultFallbackCard,
            createLoadingFn = defaultLoadingNode,
            onMemoryUpdate,
            onSendToStudyForm,
            onOpenAiSettings,
            onToast,
            onUnauthorized
        } = config || {};

        if (!panel || panel.dataset.wired === 'true') return null;
        panel.dataset.wired = 'true';

        const notify = typeof onToast === 'function' ? onToast : () => {};
        let lastTranslation = null;
        let seqCounter = 0;
        let activeController = null;

        const sourceTabs = Array.from(panel.querySelectorAll('[data-gt-src]'));
        const targetTabs = Array.from(panel.querySelectorAll('[data-gt-tgt]'));
        const detectedHintEl = panel.querySelector('.gt-detected-hint');

        const getDefaultTargetForUi = () => (currentUiLang() === 'en' ? 'en' : 'es');
        let gtSource = 'auto'; // 'auto' | 'ko' | 'ja' | 'en'
        let gtTarget = getDefaultTargetForUi(); // 'es' | 'en'
        let userPickedTarget = null;

        const syncGoogleBarState = () => {
            const rawInput = inputEl && inputEl.value ? inputEl.value : '';
            const detectedScript = detectSourceScriptClient(rawInput);
            const effectiveSrc = gtSource === 'auto' ? detectedScript : gtSource;
            const uiDefaultTgt = getDefaultTargetForUi();

            // Regla clave del usuario:
            // - Si el texto fuente es Inglés -> SIEMPRE traduce al Español ('en_es') y bloquea target Inglés.
            // - Si el texto fuente es Coreano/Japonés/Auto -> target únicamente Español o Inglés (por defecto idioma del sistema).
            const englishLocked = effectiveSrc === 'en';
            const resolvedTarget = englishLocked ? 'es' : (userPickedTarget || uiDefaultTgt);
            gtTarget = resolvedTarget;

            let effectiveDir = 'auto';
            if (englishLocked) effectiveDir = 'en_es';
            else if (effectiveSrc === 'ko') effectiveDir = resolvedTarget === 'en' ? 'ko_en' : 'ko_es';
            else if (effectiveSrc === 'ja') effectiveDir = resolvedTarget === 'en' ? 'ja_en' : 'ja_es';
            else effectiveDir = resolvedTarget === 'en' ? 'auto' : 'auto';

            if (dirSelect) {
                if (effectiveDir === 'auto' && rawInput.trim()) {
                    effectiveDir = detectedScript === 'ko'
                        ? (resolvedTarget === 'en' ? 'ko_en' : 'ko_es')
                        : (detectedScript === 'ja' ? (resolvedTarget === 'en' ? 'ja_en' : 'ja_es') : 'en_es');
                }
                dirSelect.value = effectiveDir;
            }
            dirPills.forEach(p => {
                p.classList.toggle('active', p.getAttribute('data-dir') === effectiveDir);
            });

            sourceTabs.forEach(btn => {
                const isActive = btn.getAttribute('data-gt-src') === gtSource;
                btn.classList.toggle('active', isActive);
                btn.setAttribute('aria-selected', String(isActive));
            });

            targetTabs.forEach(btn => {
                const tCode = btn.getAttribute('data-gt-tgt');
                const isDisabled = englishLocked && tCode === 'en';
                const isActive = tCode === resolvedTarget;
                btn.disabled = isDisabled;
                btn.classList.toggle('is-locked', isDisabled);
                btn.classList.toggle('active', isActive);
                btn.setAttribute('aria-selected', String(isActive));
            });

            if (detectedHintEl) {
                const srcHuman = {
                    auto: tr('Auto-detect (KO / JP / EN)', 'Detección automática (KO / JP / EN)'),
                    ko: tr('Korean', 'Coreano'),
                    ja: tr('Japanese', 'Japonés'),
                    en: tr('English', 'Inglés')
                }[effectiveSrc] || tr('Auto', 'Auto');
                const tgtHuman = resolvedTarget === 'en' ? tr('English', 'Inglés') : tr('Español', 'Español');
                if (englishLocked) {
                    detectedHintEl.textContent = tr(
                        '🇺🇸 English detected → always translates to 🇪🇸 Spanish',
                        '🇺🇸 Inglés detectado → siempre traduce a 🇪🇸 Español'
                    );
                } else if (effectiveSrc === 'ko' || effectiveSrc === 'ja') {
                    detectedHintEl.textContent = `${srcHuman} → ${tgtHuman}`;
                } else {
                    detectedHintEl.textContent = tr(
                        `System default: ${tgtHuman} (KO/JP → ${tgtHuman}, EN → Español)`,
                        `Sistema (${tgtHuman}): KO/JP → ${tgtHuman}, Inglés → siempre Español`
                    );
                }
            }
            return effectiveDir;
        };

        const setDirection = (dir) => {
            const chosen = String(dir || 'auto');
            if (chosen === 'auto') {
                gtSource = 'auto';
                userPickedTarget = null;
            } else if (chosen === 'en_es') {
                gtSource = 'en';
                userPickedTarget = 'es';
            } else if (chosen === 'ko_en' || chosen === 'ko_es') {
                gtSource = 'ko';
                userPickedTarget = chosen === 'ko_en' ? 'en' : 'es';
            } else if (chosen === 'ja_en' || chosen === 'ja_es' || chosen === 'en_ja') {
                gtSource = 'ja';
                userPickedTarget = chosen === 'ja_en' ? 'en' : 'es';
            } else {
                gtSource = 'auto';
                userPickedTarget = chosen.endsWith('_en') ? 'en' : 'es';
            }
            syncGoogleBarState();
        };

        sourceTabs.forEach(btn => {
            btn.addEventListener('click', () => {
                gtSource = btn.getAttribute('data-gt-src') || 'auto';
                syncGoogleBarState();
                if (inputEl && inputEl.value.trim()) triggerTranslate();
                else if (inputEl) inputEl.focus();
            });
        });

        targetTabs.forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                userPickedTarget = btn.getAttribute('data-gt-tgt') || getDefaultTargetForUi();
                syncGoogleBarState();
                if (inputEl && inputEl.value.trim()) triggerTranslate();
                else if (inputEl) inputEl.focus();
            });
        });

        dirPills.forEach(pill => {
            pill.addEventListener('click', () => {
                setDirection(pill.getAttribute('data-dir'));
                if (inputEl && !inputEl.value.trim()) inputEl.focus();
            });
        });

        if (dirSelect) {
            dirSelect.addEventListener('change', () => setDirection(dirSelect.value));
        }

        if (inputEl) {
            inputEl.addEventListener('input', () => {
                syncGoogleBarState();
            });
        }

        syncGoogleBarState();

        const triggerTranslate = () => {
            if (!btnRun) return;
            const text = (inputEl && inputEl.value ? inputEl.value : '').trim();
            if (!text) {
                notify('err', tr(
                    'Type a word, phrase, or lyric line to translate.',
                    'Escribe una palabra, frase o línea de canción para traducir.'
                ));
                if (inputEl) inputEl.focus();
                return;
            }
            const direction = syncGoogleBarState() || (dirSelect && dirSelect.value) || 'auto';
            const mode = (engineSelect && engineSelect.value) || 'auto';
            const context = (contextEl && contextEl.value ? contextEl.value : '').trim();

            const mySeq = ++seqCounter;
            if (activeController) activeController.abort();
            activeController = typeof AbortController === 'function' ? new AbortController() : null;

            if (resultBox) {
                resultBox.hidden = false;
                resultBox.replaceChildren(createLoadingFn(tr('Translating...', 'Traduciendo...'), 'sm'));
            }

            buttonLockFn(btnRun, async () => {
                const resp = await fetchJsonFn('/api/language/translate', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-UI-Lang': currentUiLang()
                    },
                    body: JSON.stringify({ text, direction, mode, context })
                }, { timeoutMs: 50000, externalSignal: activeController ? activeController.signal : null });

                if (resp.aborted || mySeq !== seqCounter) return;

                if (resp.status === 401 || resp.status === 403) {
                    if (typeof onUnauthorized === 'function') onUnauthorized(resp);
                    notify('err', trServer(resp.errorMessage) || tr('Session required. Sign in on Daily Hub.', 'Sesión requerida. Inicia sesión en Daily Hub.'));
                    return;
                }

                if (!resp.ok || !resp.data) {
                    const errMsg = trServer(resp.errorMessage);
                    renderFallbackFn(resultBox, {
                        title: tr('Could not complete translation over the network', 'No se pudo completar la traducción por red'),
                        message: errMsg,
                        sampleText: text,
                        onRetry: triggerTranslate
                    });
                    notify('err', errMsg);
                    return;
                }

                const data = resp.data;
                lastTranslation = data;
                if (data.languageMemory && typeof onMemoryUpdate === 'function') {
                    onMemoryUpdate(data.languageMemory);
                }
                renderTranslationCard(resultBox, data, {
                    onSendToStudyForm: onSendToStudyForm ? () => onSendToStudyForm(lastTranslation) : null,
                    onOpenAiSettings,
                    onToast: notify
                });
            }, { loadingText: tr('Translating...', 'Traduciendo...') });
        };

        if (global.DailyHubI18n && typeof global.DailyHubI18n.onChange === 'function') {
            global.DailyHubI18n.onChange(() => {
                userPickedTarget = null;
                syncGoogleBarState();
                if (lastTranslation && resultBox && !resultBox.hidden) {
                    const hasTxt = Boolean(inputEl && inputEl.value && inputEl.value.trim());
                    const detectedScr = detectSourceScriptClient(inputEl ? inputEl.value : '');
                    if (hasTxt && (detectedScr === 'ko' || detectedScr === 'ja' || gtSource === 'ko' || gtSource === 'ja')) {
                        triggerTranslate();
                    } else {
                        renderTranslationCard(resultBox, lastTranslation, {
                            onSendToStudyForm: onSendToStudyForm ? () => onSendToStudyForm(lastTranslation) : null,
                            onOpenAiSettings,
                            onToast: notify
                        });
                    }
                }
            });
        }

        if (btnRun) btnRun.addEventListener('click', triggerTranslate);

        if (inputEl) {
            inputEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                    e.preventDefault();
                    triggerTranslate();
                }
            });
        }
        if (contextEl) {
            contextEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.isComposing) {
                    e.preventDefault();
                    triggerTranslate();
                }
            });
        }

        if (btnPaste) {
            btnPaste.addEventListener('click', async () => {
                if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
                    notify('info', tr(
                        'Press Ctrl+V inside the text box to paste (HTTP restricts automatic clipboard reading).',
                        'Presiona Ctrl+V en el cuadro de texto para pegar (HTTP restringe lectura automática del portapapeles).'
                    ));
                    if (inputEl) inputEl.focus();
                    return;
                }
                try {
                    const clip = await navigator.clipboard.readText();
                    if (clip && clip.trim() && inputEl) {
                        inputEl.value = clip.trim().slice(0, 4000);
                        triggerTranslate();
                    } else {
                        notify('info', tr('Clipboard is empty — paste with Ctrl+V.', 'Portapapeles vacío — pega con Ctrl+V.'));
                        if (inputEl) inputEl.focus();
                    }
                } catch (_) {
                    notify('info', tr('Browser denied clipboard read — paste with Ctrl+V here.', 'El navegador bloqueó el acceso al portapapeles — pega aquí con Ctrl+V.'));
                    if (inputEl) inputEl.focus();
                }
            });
        }

        if (btnClear) {
            btnClear.addEventListener('click', () => {
                if (inputEl) inputEl.value = '';
                if (contextEl) contextEl.value = '';
                if (resultBox) {
                    resultBox.hidden = true;
                    resultBox.replaceChildren();
                }
                lastTranslation = null;
                if (inputEl) inputEl.focus();
            });
        }

        if (btnPopout) {
            btnPopout.addEventListener('click', () => {
                const opened = openPopupWindow({
                    text: inputEl ? inputEl.value.trim() : '',
                    dir: dirSelect ? dirSelect.value : 'en_es',
                    engine: engineSelect ? engineSelect.value : 'auto',
                    context: contextEl ? contextEl.value.trim() : ''
                });
                if (!opened) {
                    notify('err', tr(
                        'Your browser blocked the popup window. Please allow popups for this site.',
                        'Tu navegador bloqueó la ventana emergente. Permite popups para este sitio.'
                    ));
                }
            });
        }

        return {
            triggerTranslate,
            setDirection,
            setEngine(engine) {
                if (engineSelect && engine) engineSelect.value = engine;
            },
            setInputText(txt) {
                if (inputEl && typeof txt === 'string') inputEl.value = txt;
            },
            setContextText(txt) {
                if (contextEl && typeof txt === 'string') contextEl.value = txt;
            },
            focusInput() {
                if (inputEl) inputEl.focus();
            },
            getLastTranslation() {
                return lastTranslation;
            }
        };
    }

    global.DailyHubTranslator = {
        mountTranslatorInstance,
        renderTranslationCard,
        openPopupWindow,
        copyTextFallback
    };
})(window);

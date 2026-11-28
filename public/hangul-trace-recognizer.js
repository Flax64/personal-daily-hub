/* ==========================================================================
   public/hangul-trace-recognizer.js
   100% Offline, Deterministic, Zero-Persistence 40-Jamo Hangul Recognizer
   - Covers all 40 Hangul Jamo (10 basic vowels, 11 compound vowels,
     14 basic consonants, 5 double/tense consonants)
   - Zero network calls, zero DOM writes, zero browser storage or DB usage
   - Compatible with Browser (<script src="hangul-trace-recognizer.js">) & Node
   ========================================================================== */
(function (root) {
    'use strict';

    var GRID_SIZE = 32;
    var GRID_PAD = 3.5;
    var CHAMFER_SIGMA = 2.2;
    var INF_DIST = 1e9;

    /* Helper builders for clean, exact [0..1] polyline stroke templates */
    function circlePts(cx, cy, rx, ry, steps) {
        var pts = [];
        var n = steps || 24;
        for (var i = 0; i <= n; i++) {
            var a = -Math.PI / 2 + (2 * Math.PI * i) / n;
            pts.push([
                Number((cx + rx * Math.cos(a)).toFixed(3)),
                Number((cy + ry * Math.sin(a)).toFixed(3))
            ]);
        }
        return pts;
    }

    function arcPts(cx, cy, rx, ry, startRad, endRad, steps) {
        var pts = [];
        var n = steps || 12;
        for (var i = 0; i <= n; i++) {
            var a = startRad + ((endRad - startRad) * i) / n;
            pts.push([
                Number((cx + rx * Math.cos(a)).toFixed(3)),
                Number((cy + ry * Math.sin(a)).toFixed(3))
            ]);
        }
        return pts;
    }

    var HANGUL_JAMO_CATALOG = [
        // ==================================================================
        // 1. BASIC VOWELS (10)
        // ==================================================================
        {
            glyph: 'ㅏ',
            name: '아 (A)',
            nameEs: 'Vocal básica A (ㅏ)',
            nameEn: 'Basic Vowel A (ㅏ)',
            category: 'basic_vowels',
            categoryLabelEs: 'Vocal Básica',
            categoryLabelEn: 'Basic Vowel',
            romanization: 'a',
            speak: '아',
            pronunciationEs: 'Como la "a" abierta y clara del español en "casa". Trazo vertical con un toque corto hacia la derecha.',
            pronunciationEn: 'Open "a" as in "father" or "ah". Vertical stroke with a short tick pointing right.',
            batchimNoteEs: 'Posición en sílaba: va siempre a la DERECHA de la consonante inicial (ej. 가 = ga, 나 = na).',
            batchimNoteEn: 'Syllable placement: always placed to the RIGHT of the initial consonant (e.g. 가 = ga, 나 = na).',
            variants: [
                [[[0.38, 0.10], [0.38, 0.90]], [[0.38, 0.50], [0.76, 0.50]]],
                [[[0.34, 0.10], [0.34, 0.90]], [[0.34, 0.48], [0.72, 0.48]]]
            ]
        },
        {
            glyph: 'ㅑ',
            name: '야 (YA)',
            nameEs: 'Vocal básica YA (ㅑ)',
            nameEn: 'Basic Vowel YA (ㅑ)',
            category: 'basic_vowels',
            categoryLabelEs: 'Vocal Básica',
            categoryLabelEn: 'Basic Vowel',
            romanization: 'ya',
            speak: '야',
            pronunciationEs: 'Como "ya" en "yate". El doble trazo corto hacia la derecha añade siempre el sonido "y-" inicial.',
            pronunciationEn: 'Pronounced like "ya" in "yard". The second short tick adds the initial "y-" glide.',
            batchimNoteEs: 'Posición en sílaba: va a la DERECHA de la consonante (ej. 야 = ya, 샤 = sya).',
            batchimNoteEn: 'Syllable placement: placed to the RIGHT of the consonant (e.g. 야 = ya, 샤 = sya).',
            variants: [
                [[[0.36, 0.10], [0.36, 0.90]], [[0.36, 0.36], [0.74, 0.36]], [[0.36, 0.62], [0.74, 0.62]]]
            ]
        },
        {
            glyph: 'ㅓ',
            name: '어 (EO)',
            nameEs: 'Vocal básica EO (ㅓ)',
            nameEn: 'Basic Vowel EO (ㅓ)',
            category: 'basic_vowels',
            categoryLabelEs: 'Vocal Básica',
            categoryLabelEn: 'Basic Vowel',
            romanization: 'eo',
            speak: '어',
            pronunciationEs: 'Sonido entre "o" y "a" relajada (boca abierta sin redondear los labios, como "uh/aw" en inglés "bought").',
            pronunciationEn: 'Relaxed open "uh/aw" sound (like "uh" in "cup" or "aw" in "saw", without rounding lips).',
            batchimNoteEs: 'Posición en sílaba: va a la DERECHA de la consonante (ej. 서 = seo, 너 = neo).',
            batchimNoteEn: 'Syllable placement: placed to the RIGHT of the consonant (e.g. 서 = seo, 너 = neo).',
            variants: [
                [[[0.24, 0.50], [0.62, 0.50]], [[0.62, 0.10], [0.62, 0.90]]],
                [[[0.62, 0.10], [0.62, 0.90]], [[0.24, 0.50], [0.62, 0.50]]]
            ]
        },
        {
            glyph: 'ㅕ',
            name: '여 (YEO)',
            nameEs: 'Vocal básica YEO (ㅕ)',
            nameEn: 'Basic Vowel YEO (ㅕ)',
            category: 'basic_vowels',
            categoryLabelEs: 'Vocal Básica',
            categoryLabelEn: 'Basic Vowel',
            romanization: 'yeo',
            speak: '여',
            pronunciationEs: 'Igual que "ㅓ" precedida de una "y" suave ("yeo"). Muy común en palabras como 여자 (yeoja = mujer).',
            pronunciationEn: 'Same as "ㅓ" preceded by a soft "y" glide ("yuh"). Common in 여자 (yeoja = woman).',
            batchimNoteEs: 'Posición en sílaba: va a la DERECHA de la consonante (ej. 여 = yeo, 혀 = hyeo).',
            batchimNoteEn: 'Syllable placement: placed to the RIGHT of the consonant (e.g. 여 = yeo, 혀 = hyeo).',
            variants: [
                [[[0.26, 0.36], [0.64, 0.36]], [[0.26, 0.62], [0.64, 0.62]], [[0.64, 0.10], [0.64, 0.90]]]
            ]
        },
        {
            glyph: 'ㅗ',
            name: '오 (O)',
            nameEs: 'Vocal básica O (ㅗ)',
            nameEn: 'Basic Vowel O (ㅗ)',
            category: 'basic_vowels',
            categoryLabelEs: 'Vocal Básica',
            categoryLabelEn: 'Basic Vowel',
            romanization: 'o',
            speak: '오',
            pronunciationEs: 'Como la "o" clara y cerrada del español con labios bien redondeados. Trazo corto arriba de la barra horizontal.',
            pronunciationEn: 'Rounded "o" as in "more" or "go". Short vertical tick sits ABOVE the horizontal bar.',
            batchimNoteEs: 'Posición en sílaba: vocal horizontal, va siempre DEBAJO de la consonante inicial (ej. 고 = go, 오 = o).',
            batchimNoteEn: 'Syllable placement: horizontal vowel, always placed BELOW the initial consonant (e.g. 고 = go).',
            variants: [
                [[[0.50, 0.24], [0.50, 0.62]], [[0.10, 0.62], [0.90, 0.62]]],
                [[[0.50, 0.20], [0.50, 0.66]], [[0.12, 0.66], [0.88, 0.66]]]
            ]
        },
        {
            glyph: 'ㅛ',
            name: '요 (YO)',
            nameEs: 'Vocal básica YO (ㅛ)',
            nameEn: 'Basic Vowel YO (ㅛ)',
            category: 'basic_vowels',
            categoryLabelEs: 'Vocal Básica',
            categoryLabelEn: 'Basic Vowel',
            romanization: 'yo',
            speak: '요',
            pronunciationEs: 'Como "yo" en "yoyo". Dos trazos verticales cortos hacia arriba sobre la barra horizontal.',
            pronunciationEn: 'Pronounced like "yo" in "yoyo". Two short vertical ticks above the horizontal line.',
            batchimNoteEs: 'Posición en sílaba: vocal horizontal, va siempre DEBAJO de la consonante (ej. 요 = yo, 교 = gyo).',
            batchimNoteEn: 'Syllable placement: horizontal vowel, always placed BELOW the consonant (e.g. 요 = yo).',
            variants: [
                [[[0.36, 0.26], [0.36, 0.64]], [[0.64, 0.26], [0.64, 0.64]], [[0.10, 0.64], [0.90, 0.64]]]
            ]
        },
        {
            glyph: 'ㅜ',
            name: '우 (U)',
            nameEs: 'Vocal básica U (ㅜ)',
            nameEn: 'Basic Vowel U (ㅜ)',
            category: 'basic_vowels',
            categoryLabelEs: 'Vocal Básica',
            categoryLabelEn: 'Basic Vowel',
            romanization: 'u',
            speak: '우',
            pronunciationEs: 'Como la "u" en "luna" con labios proyectados hacia adelante. El trazo corto apunta hacia abajo.',
            pronunciationEn: 'Pure "oo" sound as in "moon". Short vertical tick hangs BELOW the horizontal bar.',
            batchimNoteEs: 'Posición en sílaba: vocal horizontal, va siempre DEBAJO de la consonante inicial (ej. 구 = gu, 무 = mu).',
            batchimNoteEn: 'Syllable placement: horizontal vowel, always placed BELOW the initial consonant (e.g. 구 = gu).',
            variants: [
                [[[0.10, 0.38], [0.90, 0.38]], [[0.50, 0.38], [0.50, 0.78]]],
                [[[0.12, 0.34], [0.88, 0.34]], [[0.50, 0.34], [0.50, 0.80]]]
            ]
        },
        {
            glyph: 'ㅠ',
            name: '유 (YU)',
            nameEs: 'Vocal básica YU (ㅠ)',
            nameEn: 'Basic Vowel YU (ㅠ)',
            category: 'basic_vowels',
            categoryLabelEs: 'Vocal Básica',
            categoryLabelEn: 'Basic Vowel',
            romanization: 'yu',
            speak: '유',
            pronunciationEs: 'Como "yu" en "yuca" o "you" en inglés. Dos trazos cortos colgando debajo de la barra horizontal.',
            pronunciationEn: 'Pronounced like "you". Two short vertical ticks hanging below the horizontal line.',
            batchimNoteEs: 'Posición en sílaba: vocal horizontal, va DEBAJO de la consonante (ej. 유 = yu, 뉴 = nyu).',
            batchimNoteEn: 'Syllable placement: horizontal vowel, placed BELOW the consonant (e.g. 유 = yu).',
            variants: [
                [[[0.10, 0.36], [0.90, 0.36]], [[0.36, 0.36], [0.36, 0.74]], [[0.64, 0.36], [0.64, 0.74]]]
            ]
        },
        {
            glyph: 'ㅡ',
            name: '으 (EU)',
            nameEs: 'Vocal básica EU (ㅡ)',
            nameEn: 'Basic Vowel EU (ㅡ)',
            category: 'basic_vowels',
            categoryLabelEs: 'Vocal Básica',
            categoryLabelEn: 'Basic Vowel',
            romanization: 'eu',
            speak: '으',
            pronunciationEs: 'Estira los labios en sonrisa plana e intenta decir "u" sin redondearlos. Línea horizontal pura.',
            pronunciationEn: 'Unrounded "oo": pull lips back flat like smiling and pronounce "u". Single horizontal line.',
            batchimNoteEs: 'Posición en sílaba: vocal horizontal, va siempre DEBAJO de la consonante (ej. 그 = geu, 스 = seu).',
            batchimNoteEn: 'Syllable placement: horizontal vowel, always placed BELOW the consonant (e.g. 그 = geu).',
            variants: [
                [[[0.08, 0.50], [0.92, 0.50]]]
            ]
        },
        {
            glyph: 'ㅣ',
            name: '이 (I)',
            nameEs: 'Vocal básica I (ㅣ)',
            nameEn: 'Basic Vowel I (ㅣ)',
            category: 'basic_vowels',
            categoryLabelEs: 'Vocal Básica',
            categoryLabelEn: 'Basic Vowel',
            romanization: 'i',
            speak: '이',
            pronunciationEs: 'Como la "i" clara en "isla" o "ee" en "see". Una sola línea vertical recta de arriba hacia abajo.',
            pronunciationEn: 'Pure "ee" sound as in "see". Single straight vertical stroke from top to bottom.',
            batchimNoteEs: 'Posición en sílaba: vocal vertical, va siempre a la DERECHA de la consonante (ej. 이 = i, 시 = shi).',
            batchimNoteEn: 'Syllable placement: vertical vowel, always placed to the RIGHT of the consonant (e.g. 이 = i).',
            variants: [
                [[[0.50, 0.08], [0.50, 0.92]]]
            ]
        },

        // ==================================================================
        // 2. COMPOUND VOWELS / DIPHTHONGS (11)
        // ==================================================================
        {
            glyph: 'ㅐ',
            name: '애 (AE)',
            nameEs: 'Vocal compuesta AE (ㅐ)',
            nameEn: 'Compound Vowel AE (ㅐ)',
            category: 'compound_vowels',
            categoryLabelEs: 'Vocal Compuesta',
            categoryLabelEn: 'Compound Vowel',
            romanization: 'ae',
            speak: '애',
            pronunciationEs: 'Suena como una "e" ligeramente abierta (en el coreano moderno casi idéntica a ㅔ). Combinación de ㅏ + ㅣ.',
            pronunciationEn: 'Open "eh" sound as in "care" or "bet" (in modern Korean nearly identical to ㅔ). Built from ㅏ + ㅣ.',
            batchimNoteEs: 'Posición en sílaba: va a la DERECHA de la consonante (ej. 개 = gae, 내 = nae).',
            batchimNoteEn: 'Syllable placement: placed to the RIGHT of the consonant (e.g. 개 = gae).',
            variants: [
                [[[0.28, 0.10], [0.28, 0.90]], [[0.28, 0.48], [0.68, 0.48]], [[0.68, 0.10], [0.68, 0.90]]]
            ]
        },
        {
            glyph: 'ㅒ',
            name: '얘 (YAE)',
            nameEs: 'Vocal compuesta YAE (ㅒ)',
            nameEn: 'Compound Vowel YAE (ㅒ)',
            category: 'compound_vowels',
            categoryLabelEs: 'Vocal Compuesta',
            categoryLabelEn: 'Compound Vowel',
            romanization: 'yae',
            speak: '얘',
            pronunciationEs: 'Sonido "ye" abierta (ㅑ + ㅣ). Poco frecuente, aparece en palabras como 얘기 (yaegi = historia/charla).',
            pronunciationEn: 'Pronounced "yeh" (ㅑ + ㅣ). Less common; used in words like 얘기 (yaegi = story/talk).',
            batchimNoteEs: 'Posición en sílaba: va a la DERECHA de la consonante (ej. 얘 = yae).',
            batchimNoteEn: 'Syllable placement: placed to the RIGHT of the consonant (e.g. 얘 = yae).',
            variants: [
                [[[0.24, 0.10], [0.24, 0.90]], [[0.24, 0.36], [0.66, 0.36]], [[0.24, 0.62], [0.66, 0.62]], [[0.68, 0.10], [0.68, 0.90]]]
            ]
        },
        {
            glyph: 'ㅔ',
            name: '에 (E)',
            nameEs: 'Vocal compuesta E (ㅔ)',
            nameEn: 'Compound Vowel E (ㅔ)',
            category: 'compound_vowels',
            categoryLabelEs: 'Vocal Compuesta',
            categoryLabelEn: 'Compound Vowel',
            romanization: 'e',
            speak: '에',
            pronunciationEs: 'Como la "e" clara del español en "mesa". Combinación de ㅓ + ㅣ; muy usada en partículas (에, 에서).',
            pronunciationEn: 'Clear "eh" as in "met". Built from ㅓ + ㅣ; widely used in location particles (에, 에서).',
            batchimNoteEs: 'Posición en sílaba: va a la DERECHA de la consonante (ej. 네 = ne, 세 = se).',
            batchimNoteEn: 'Syllable placement: placed to the RIGHT of the consonant (e.g. 네 = ne, 세 = se).',
            variants: [
                [[[0.18, 0.50], [0.50, 0.50]], [[0.50, 0.10], [0.50, 0.90]], [[0.76, 0.10], [0.76, 0.90]]]
            ]
        },
        {
            glyph: 'ㅖ',
            name: '예 (YE)',
            nameEs: 'Vocal compuesta YE (ㅖ)',
            nameEn: 'Compound Vowel YE (ㅖ)',
            category: 'compound_vowels',
            categoryLabelEs: 'Vocal Compuesta',
            categoryLabelEn: 'Compound Vowel',
            romanization: 'ye',
            speak: '예',
            pronunciationEs: 'Como "ye" en "yegua" (ㅕ + ㅣ). Muy frecuente en 예 ("sí" formal) y 세계 (segye = mundo).',
            pronunciationEn: 'Pronounced "yeh" as in "yes" (ㅕ + ㅣ). Used in 예 (formal "yes") and 세계 (world).',
            batchimNoteEs: 'Posición en sílaba: va a la DERECHA de la consonante (ej. 예 = ye, 계 = gye).',
            batchimNoteEn: 'Syllable placement: placed to the RIGHT of the consonant (e.g. 예 = ye).',
            variants: [
                [[[0.16, 0.36], [0.48, 0.36]], [[0.16, 0.62], [0.48, 0.62]], [[0.48, 0.10], [0.48, 0.90]], [[0.76, 0.10], [0.76, 0.90]]]
            ]
        },
        {
            glyph: 'ㅘ',
            name: '와 (WA)',
            nameEs: 'Diptongo WA (ㅘ)',
            nameEn: 'Compound Vowel WA (ㅘ)',
            category: 'compound_vowels',
            categoryLabelEs: 'Vocal Compuesta',
            categoryLabelEn: 'Compound Vowel',
            romanization: 'wa',
            speak: '와',
            pronunciationEs: 'Unión rápida de ㅗ + ㅏ = "wa" (como "gua" en "guagua").',
            pronunciationEn: 'Fast glide of ㅗ + ㅏ = "wa" as in "water".',
            batchimNoteEs: 'Posición en sílaba: envuelve DEBAJO y a la DERECHA de la consonante (ej. 와 = wa, 과 = gwa).',
            batchimNoteEn: 'Syllable placement: wraps BELOW and to the RIGHT of the consonant (e.g. 와 = wa).',
            variants: [
                [[[0.34, 0.24], [0.34, 0.62]], [[0.10, 0.62], [0.56, 0.62]], [[0.66, 0.12], [0.66, 0.88]], [[0.66, 0.50], [0.90, 0.50]]]
            ]
        },
        {
            glyph: 'ㅙ',
            name: '왜 (WAE)',
            nameEs: 'Diptongo WAE (ㅙ)',
            nameEn: 'Compound Vowel WAE (ㅙ)',
            category: 'compound_vowels',
            categoryLabelEs: 'Vocal Compuesta',
            categoryLabelEn: 'Compound Vowel',
            romanization: 'wae',
            speak: '왜',
            pronunciationEs: 'Unión rápida de ㅗ + ㅐ = "we / wae". Clásico en 왜? (wae? = ¿por qué?).',
            pronunciationEn: 'Glide of ㅗ + ㅐ = "weh". Famous in 왜? (wae? = why?).',
            batchimNoteEs: 'Posición en sílaba: envuelve DEBAJO y a la DERECHA (ej. 왜 = wae, 돼 = dwae).',
            batchimNoteEn: 'Syllable placement: wraps BELOW and to the RIGHT (e.g. 왜 = wae).',
            variants: [
                [[[0.28, 0.24], [0.28, 0.62]], [[0.08, 0.62], [0.46, 0.62]], [[0.54, 0.12], [0.54, 0.88]], [[0.54, 0.48], [0.82, 0.48]], [[0.82, 0.12], [0.82, 0.88]]]
            ]
        },
        {
            glyph: 'ㅚ',
            name: '외 (OE / WE)',
            nameEs: 'Diptongo OE / WE (ㅚ)',
            nameEn: 'Compound Vowel OE / WE (ㅚ)',
            category: 'compound_vowels',
            categoryLabelEs: 'Vocal Compuesta',
            categoryLabelEn: 'Compound Vowel',
            romanization: 'oe',
            speak: '외',
            pronunciationEs: 'Compuesta por ㅗ + ㅣ; en coreano moderno se pronuncia "we" (ej. 외국 = weguk = extranjero).',
            pronunciationEn: 'Written ㅗ + ㅣ; pronounced "weh" in modern Korean (e.g. 외국 = weguk = foreign country).',
            batchimNoteEs: 'Posición en sílaba: envuelve DEBAJO y a la DERECHA (ej. 외 = oe/we, 회 = hoe).',
            batchimNoteEn: 'Syllable placement: wraps BELOW and to the RIGHT (e.g. 외 = oe/we).',
            variants: [
                [[[0.36, 0.24], [0.36, 0.64]], [[0.10, 0.64], [0.60, 0.64]], [[0.76, 0.12], [0.76, 0.88]]]
            ]
        },
        {
            glyph: 'ㅝ',
            name: '워 (WO)',
            nameEs: 'Diptongo WO (ㅝ)',
            nameEn: 'Compound Vowel WO (ㅝ)',
            category: 'compound_vowels',
            categoryLabelEs: 'Vocal Compuesta',
            categoryLabelEn: 'Compound Vowel',
            romanization: 'wo',
            speak: '워',
            pronunciationEs: 'Unión rápida de ㅜ + ㅓ = "wo" (como en "won"). Muy usada en 고마워 (gomawo = gracias).',
            pronunciationEn: 'Glide of ㅜ + ㅓ = "wo" as in "wonder". Used in 고마워 (gomawo = thank you).',
            batchimNoteEs: 'Posición en sílaba: envuelve DEBAJO y a la DERECHA (ej. 워 = wo, 뭐 = mwo).',
            batchimNoteEn: 'Syllable placement: wraps BELOW and to the RIGHT (e.g. 워 = wo).',
            variants: [
                [[[0.10, 0.34], [0.56, 0.34]], [[0.34, 0.34], [0.34, 0.74]], [[0.52, 0.56], [0.76, 0.56]], [[0.76, 0.12], [0.76, 0.88]]]
            ]
        },
        {
            glyph: 'ㅞ',
            name: '웨 (WE)',
            nameEs: 'Diptongo WE (ㅞ)',
            nameEn: 'Compound Vowel WE (ㅞ)',
            category: 'compound_vowels',
            categoryLabelEs: 'Vocal Compuesta',
            categoryLabelEn: 'Compound Vowel',
            romanization: 'we',
            speak: '웨',
            pronunciationEs: 'Unión de ㅜ + ㅔ = "we" (como en "web"). Frecuente en préstamos como 웨딩 (wedding).',
            pronunciationEn: 'Glide of ㅜ + ㅔ = "weh" as in "wet". Common in loanwords like 웨딩 (wedding).',
            batchimNoteEs: 'Posición en sílaba: envuelve DEBAJO y a la DERECHA (ej. 웨 = we).',
            batchimNoteEn: 'Syllable placement: wraps BELOW and to the RIGHT (e.g. 웨 = we).',
            variants: [
                [[[0.08, 0.34], [0.46, 0.34]], [[0.28, 0.34], [0.28, 0.74]], [[0.46, 0.52], [0.64, 0.52]], [[0.64, 0.12], [0.64, 0.88]], [[0.84, 0.12], [0.84, 0.88]]]
            ]
        },
        {
            glyph: 'ㅟ',
            name: '위 (WI)',
            nameEs: 'Diptongo WI (ㅟ)',
            nameEn: 'Compound Vowel WI (ㅟ)',
            category: 'compound_vowels',
            categoryLabelEs: 'Vocal Compuesta',
            categoryLabelEn: 'Compound Vowel',
            romanization: 'wi',
            speak: '위',
            pronunciationEs: 'Unión rápida de ㅜ + ㅣ = "wi" (como en "wifi"). Ej.: 위 (arriba) o 쉬다 (descansar).',
            pronunciationEn: 'Glide of ㅜ + ㅣ = "wee" as in "we". Example: 위 (above) or 뒤 (behind).',
            batchimNoteEs: 'Posición en sílaba: envuelve DEBAJO y a la DERECHA (ej. 위 = wi, 귀 = gwi).',
            batchimNoteEn: 'Syllable placement: wraps BELOW and to the RIGHT (e.g. 위 = wi).',
            variants: [
                [[[0.10, 0.36], [0.60, 0.36]], [[0.36, 0.36], [0.36, 0.78]], [[0.76, 0.12], [0.76, 0.88]]]
            ]
        },
        {
            glyph: 'ㅢ',
            name: '의 (UI / EUI)',
            nameEs: 'Diptongo UI / EUI (ㅢ)',
            nameEn: 'Compound Vowel UI / EUI (ㅢ)',
            category: 'compound_vowels',
            categoryLabelEs: 'Vocal Compuesta',
            categoryLabelEn: 'Compound Vowel',
            romanization: 'ui',
            speak: '의',
            pronunciationEs: 'Desliza ㅡ rápidamente hacia ㅣ ("eu-i"). Como partícula posesiva 의 suele sonar "e"; en 의사 (médico) "eu-i".',
            pronunciationEn: 'Glide from ㅡ to ㅣ ("eu-i"). As the possessive particle 의 it often sounds like "eh".',
            batchimNoteEs: 'Posición en sílaba: envuelve DEBAJO y a la DERECHA (ej. 의 = ui, 희 = hui).',
            batchimNoteEn: 'Syllable placement: wraps BELOW and to the RIGHT (e.g. 의 = ui).',
            variants: [
                [[[0.10, 0.56], [0.62, 0.56]], [[0.76, 0.12], [0.76, 0.88]]]
            ]
        },

        // ==================================================================
        // 3. BASIC CONSONANTS (14)
        // ==================================================================
        {
            glyph: 'ㄱ',
            name: '기역 (Giyeok)',
            nameEs: 'Consonante Giyeok (ㄱ)',
            nameEn: 'Consonant Giyeok (ㄱ)',
            category: 'basic_consonants',
            categoryLabelEs: 'Consonante',
            categoryLabelEn: 'Consonant',
            romanization: 'g / k',
            speak: '가',
            pronunciationEs: 'Al inicio de palabra suena suave entre "g" y "k"; entre vocales suena "g" suave (como "gato").',
            pronunciationEn: 'Soft voiceless g/k at word start; voiced "g" (as in "go") between vowels.',
            batchimNoteEs: 'En Batchim (final de sílaba): suena como "k" seca sin exhalar aire (ej. 책 [chaek] = libro).',
            batchimNoteEn: 'As Batchim (syllable-final): unreleased "k" stop without puffing air (e.g. 책 [chaek] = book).',
            variants: [
                [[[0.16, 0.18], [0.84, 0.18], [0.84, 0.84]]],
                [[[0.16, 0.18], [0.84, 0.18], [0.76, 0.84]]],
                [[[0.16, 0.18], [0.84, 0.18]], [[0.84, 0.18], [0.84, 0.84]]]
            ]
        },
        {
            glyph: 'ㄴ',
            name: '니은 (Nieun)',
            nameEs: 'Consonante Nieun (ㄴ)',
            nameEn: 'Consonant Nieun (ㄴ)',
            category: 'basic_consonants',
            categoryLabelEs: 'Consonante',
            categoryLabelEn: 'Consonant',
            romanization: 'n',
            speak: '나',
            pronunciationEs: 'Igual que la "n" en español ("noche"). Representa la lengua tocando detrás de los dientes superiores.',
            pronunciationEn: 'Same as English "n" in "nice". Shape mirrors the tongue tip touching behind upper teeth.',
            batchimNoteEs: 'En Batchim (final de sílaba): mantiene sonido nasal "-n" claro (ej. 산 [san] = montaña).',
            batchimNoteEn: 'As Batchim (syllable-final): clear nasal "-n" sound (e.g. 산 [san] = mountain).',
            variants: [
                [[[0.18, 0.16], [0.18, 0.84], [0.86, 0.84]]],
                [[[0.18, 0.16], [0.18, 0.84]], [[0.18, 0.84], [0.86, 0.84]]]
            ]
        },
        {
            glyph: 'ㄷ',
            name: '디귿 (Digeut)',
            nameEs: 'Consonante Digeut (ㄷ)',
            nameEn: 'Consonant Digeut (ㄷ)',
            category: 'basic_consonants',
            categoryLabelEs: 'Consonante',
            categoryLabelEn: 'Consonant',
            romanization: 'd / t',
            speak: '다',
            pronunciationEs: 'Al inicio suave entre "d" y "t"; entre vocales suena como "d" suave (ej. 바다 = bada).',
            pronunciationEn: 'Soft d/t initially; voiced "d" between vowels (e.g. 다 = da, 바다 = bada).',
            batchimNoteEs: 'En Batchim (final de sílaba): suena como "t" seca bloqueada sin soltar aire (ej. 곧 [got]).',
            batchimNoteEn: 'As Batchim (syllable-final): unreleased "t" stop (e.g. 곧 [got]).',
            variants: [
                [[[0.18, 0.18], [0.82, 0.18]], [[0.18, 0.18], [0.18, 0.82], [0.84, 0.82]]],
                [[[0.82, 0.18], [0.18, 0.18], [0.18, 0.82], [0.84, 0.82]]]
            ]
        },
        {
            glyph: 'ㄹ',
            name: '리을 (Rieul)',
            nameEs: 'Consonante Rieul (ㄹ)',
            nameEn: 'Consonant Rieul (ㄹ)',
            category: 'basic_consonants',
            categoryLabelEs: 'Consonante',
            categoryLabelEn: 'Consonant',
            romanization: 'r / l',
            speak: '라',
            pronunciationEs: 'Entre vocales suena como "r" suave española (como "pero"); al inicio suena suave entre r/l.',
            pronunciationEn: 'Flapped "r" (like Spanish "pero") between vowels; light "l" at syllable end.',
            batchimNoteEs: 'En Batchim (final de sílaba): suena siempre como "L" clara (ej. 물 [mul] = agua, 달 [dal] = luna).',
            batchimNoteEn: 'As Batchim (syllable-final): always pronounced as a smooth "l" (e.g. 물 [mul] = water).',
            variants: [
                [[[0.18, 0.16], [0.82, 0.16], [0.82, 0.48]], [[0.18, 0.48], [0.82, 0.48]], [[0.18, 0.48], [0.18, 0.84], [0.84, 0.84]]],
                [[[0.18, 0.16], [0.82, 0.16], [0.82, 0.48], [0.18, 0.48], [0.18, 0.84], [0.84, 0.84]]]
            ]
        },
        {
            glyph: 'ㅁ',
            name: '미음 (Mieum)',
            nameEs: 'Consonante Mieum (ㅁ)',
            nameEn: 'Consonant Mieum (ㅁ)',
            category: 'basic_consonants',
            categoryLabelEs: 'Consonante',
            categoryLabelEn: 'Consonant',
            romanization: 'm',
            speak: '마',
            pronunciationEs: 'Igual que la "m" en español ("mamá"). Su forma cuadrada simboliza los labios cerrados (una boca).',
            pronunciationEn: 'Same as English "m" in "mother". Square shape depicts closed lips (a mouth).',
            batchimNoteEs: 'En Batchim (final de sílaba): cierra los labios con "-m" clara (ej. 봄 [bom] = primavera).',
            batchimNoteEn: 'As Batchim (syllable-final): closes lips cleanly as "-m" (e.g. 봄 [bom] = spring).',
            variants: [
                [[[0.18, 0.18], [0.18, 0.82]], [[0.18, 0.18], [0.82, 0.18], [0.82, 0.82]], [[0.18, 0.82], [0.82, 0.82]]],
                [[[0.18, 0.18], [0.82, 0.18], [0.82, 0.82], [0.18, 0.82], [0.18, 0.18]]]
            ]
        },
        {
            glyph: 'ㅂ',
            name: '비읍 (Bieup)',
            nameEs: 'Consonante Bieup (ㅂ)',
            nameEn: 'Consonant Bieup (ㅂ)',
            category: 'basic_consonants',
            categoryLabelEs: 'Consonante',
            categoryLabelEn: 'Consonant',
            romanization: 'b / p',
            speak: '바',
            pronunciationEs: 'Al inicio suave entre "b" y "p"; entre vocales suena "b" suave (ej. 바다 = bada, 바나나 = banana).',
            pronunciationEn: 'Soft b/p initially; voiced "b" between vowels (e.g. 바다 = bada = sea).',
            batchimNoteEs: 'En Batchim (final de sílaba): suena "-p" seca sin aire (ej. 밥 [bap] = arroz, 집 [jip] = casa).',
            batchimNoteEn: 'As Batchim (syllable-final): unreleased "-p" stop (e.g. 밥 [bap] = rice, 집 [jip] = house).',
            variants: [
                [[[0.22, 0.14], [0.22, 0.84]], [[0.78, 0.14], [0.78, 0.84]], [[0.22, 0.50], [0.78, 0.50]], [[0.22, 0.84], [0.78, 0.84]]]
            ]
        },
        {
            glyph: 'ㅅ',
            name: '시옷 (Siot)',
            nameEs: 'Consonante Siot (ㅅ)',
            nameEn: 'Consonant Siot (ㅅ)',
            category: 'basic_consonants',
            categoryLabelEs: 'Consonante',
            categoryLabelEn: 'Consonant',
            romanization: 's / sh',
            speak: '사',
            pronunciationEs: 'Suena "s" suave normalmente; antes de vocales con "i/y" (ㅣ, ㅑ, ㅕ, ㅛ, ㅠ) suena casi como "sh" (시 = shi).',
            pronunciationEn: 'Soft "s" before most vowels; shifts toward "sh" before ㅣ/y-vowels (e.g. 시 = shi).',
            batchimNoteEs: 'En Batchim (final de sílaba): NO suena "s", sino como "t" bloqueada (ej. 옷 [ot] = ropa).',
            batchimNoteEn: 'As Batchim (syllable-final): pronounced as an unreleased "t" stop (e.g. 옷 [ot] = clothes).',
            variants: [
                [[[0.50, 0.14], [0.42, 0.44], [0.16, 0.84]], [[0.46, 0.42], [0.84, 0.84]]],
                [[[0.50, 0.14], [0.16, 0.84]], [[0.50, 0.32], [0.84, 0.84]]]
            ]
        },
        {
            glyph: 'ㅇ',
            name: '이응 (Ieung)',
            nameEs: 'Consonante Ieung (ㅇ)',
            nameEn: 'Consonant Ieung (ㅇ)',
            category: 'basic_consonants',
            categoryLabelEs: 'Consonante',
            categoryLabelEn: 'Consonant',
            romanization: '- / ng',
            speak: '아',
            pronunciationEs: 'MUDA al inicio de sílaba (solo sostiene la vocal, ej. 아 = a, 이 = i). Un círculo limpio.',
            pronunciationEn: 'SILENT as an initial consonant (acts as a placeholder before vowels: 아 = a). Drawn as a single circle.',
            batchimNoteEs: 'En Batchim (final de sílaba): suena nasal posterior "-ng" como en "song" (ej. 사랑 [sarang] = amor).',
            batchimNoteEn: 'As Batchim (syllable-final): nasal "-ng" as in "sing" (e.g. 사랑 [sarang] = love).',
            variants: [
                [circlePts(0.50, 0.50, 0.34, 0.34, 24)]
            ]
        },
        {
            glyph: 'ㅈ',
            name: '지읒 (Jieut)',
            nameEs: 'Consonante Jieut (ㅈ)',
            nameEn: 'Consonant Jieut (ㅈ)',
            category: 'basic_consonants',
            categoryLabelEs: 'Consonante',
            categoryLabelEn: 'Consonant',
            romanization: 'j',
            speak: '자',
            pronunciationEs: 'Similar a "y/j" suave en inglés ("jar" sin vibración fuerte). Entre vocales se suaviza (가자 = gaja).',
            pronunciationEn: 'Soft "j" as in "jam" (unaspirated initially, gently voiced between vowels).',
            batchimNoteEs: 'En Batchim (final de sílaba): suena como "t" bloqueada (ej. 낮 [nat] = día).',
            batchimNoteEn: 'As Batchim (syllable-final): unreleased "t" stop (e.g. 낮 [nat] = daytime).',
            variants: [
                [[[0.16, 0.20], [0.84, 0.20], [0.46, 0.56], [0.16, 0.84]], [[0.50, 0.52], [0.84, 0.84]]],
                [[[0.16, 0.20], [0.84, 0.20]], [[0.50, 0.20], [0.16, 0.84]], [[0.50, 0.44], [0.84, 0.84]]]
            ]
        },
        {
            glyph: 'ㅊ',
            name: '치읓 (Chieut)',
            nameEs: 'Consonante Chieut (ㅊ)',
            nameEn: 'Consonant Chieut (ㅊ)',
            category: 'basic_consonants',
            categoryLabelEs: 'Consonante',
            categoryLabelEn: 'Consonant',
            romanization: 'ch',
            speak: '차',
            pronunciationEs: '"Ch" ASPIRADA con golpe de aire ("chico" + soplo de aire). El trazo superior indica aspiración respecto a ㅈ.',
            pronunciationEn: 'Strongly aspirated "ch" with a burst of air (as in "cheese"). Top tick marks aspiration over ㅈ.',
            batchimNoteEs: 'En Batchim (final de sílaba): suena como "t" seca (ej. 꽃 [kkot] = flor).',
            batchimNoteEn: 'As Batchim (syllable-final): unreleased "t" stop (e.g. 꽃 [kkot] = flower).',
            variants: [
                [[[0.50, 0.10], [0.50, 0.24]], [[0.18, 0.30], [0.82, 0.30], [0.46, 0.62], [0.16, 0.86]], [[0.52, 0.56], [0.84, 0.86]]],
                [[[0.38, 0.14], [0.62, 0.14]], [[0.18, 0.30], [0.82, 0.30]], [[0.50, 0.30], [0.16, 0.86]], [[0.50, 0.52], [0.84, 0.86]]]
            ]
        },
        {
            glyph: 'ㅋ',
            name: '키읔 (Kieuk)',
            nameEs: 'Consonante Kieuk (ㅋ)',
            nameEn: 'Consonant Kieuk (ㅋ)',
            category: 'basic_consonants',
            categoryLabelEs: 'Consonante',
            categoryLabelEn: 'Consonant',
            romanization: 'k',
            speak: '카',
            pronunciationEs: '"K" ASPIRADA con fuerte golpe de aire (como "k" en inglés "key"). Es ㄱ con una barra media adicional.',
            pronunciationEn: 'Strongly aspirated "k" with a puff of air (as in "key"). Derived from ㄱ with an extra horizontal bar.',
            batchimNoteEs: 'En Batchim (final de sílaba): suena como "k" bloqueada (ej. 부엌 [bueok] = cocina).',
            batchimNoteEn: 'As Batchim (syllable-final): unreleased "k" stop (e.g. 부엌 [bueok] = kitchen).',
            variants: [
                [[[0.16, 0.18], [0.84, 0.18], [0.84, 0.84]], [[0.18, 0.50], [0.84, 0.50]]]
            ]
        },
        {
            glyph: 'ㅌ',
            name: '티읕 (Tieut)',
            nameEs: 'Consonante Tieut (ㅌ)',
            nameEn: 'Consonant Tieut (ㅌ)',
            category: 'basic_consonants',
            categoryLabelEs: 'Consonante',
            categoryLabelEn: 'Consonant',
            romanization: 't',
            speak: '타',
            pronunciationEs: '"T" ASPIRADA con golpe de aire (como "t" en inglés "top"). Es ㄷ con barra horizontal central.',
            pronunciationEn: 'Strongly aspirated "t" with a puff of air (as in "top"). Derived from ㄷ with a middle bar.',
            batchimNoteEs: 'En Batchim (final de sílaba): suena como "t" bloqueada (ej. 같이 [gachi] al enlazar con 이).',
            batchimNoteEn: 'As Batchim (syllable-final): unreleased "t" stop (palatalizes to "ch" before 이).',
            variants: [
                [[[0.18, 0.18], [0.82, 0.18]], [[0.18, 0.50], [0.76, 0.50]], [[0.18, 0.18], [0.18, 0.82], [0.84, 0.82]]]
            ]
        },
        {
            glyph: 'ㅍ',
            name: '피읖 (Pieup)',
            nameEs: 'Consonante Pieup (ㅍ)',
            nameEn: 'Consonant Pieup (ㅍ)',
            category: 'basic_consonants',
            categoryLabelEs: 'Consonante',
            categoryLabelEn: 'Consonant',
            romanization: 'p',
            speak: '파',
            pronunciationEs: '"P" ASPIRADA con golpe de aire (como "p" en inglés "pie"). Ej.: 피아노 (piano), 커피 (keopi = café).',
            pronunciationEn: 'Strongly aspirated "p" with a puff of air (as in "pie"). E.g. 피아노 (piano), 커피 (coffee).',
            batchimNoteEs: 'En Batchim (final de sílaba): suena "-p" seca sin aire (ej. 앞 [ap] = frente).',
            batchimNoteEn: 'As Batchim (syllable-final): unreleased "-p" stop (e.g. 앞 [ap] = front).',
            variants: [
                [[[0.14, 0.20], [0.86, 0.20]], [[0.34, 0.20], [0.34, 0.80]], [[0.66, 0.20], [0.66, 0.80]], [[0.14, 0.80], [0.86, 0.80]]]
            ]
        },
        {
            glyph: 'ㅎ',
            name: '히읗 (Hieut)',
            nameEs: 'Consonante Hieut (ㅎ)',
            nameEn: 'Consonant Hieut (ㅎ)',
            category: 'basic_consonants',
            categoryLabelEs: 'Consonante',
            categoryLabelEn: 'Consonant',
            romanization: 'h',
            speak: '하',
            pronunciationEs: 'Sonido "j" suave en español o "h" aspirada suave en inglés ("hello"). Muy débil entre vocales.',
            pronunciationEn: 'Soft breathy "h" as in "hello". Often fades gently when sitting between two vowels.',
            batchimNoteEs: 'En Batchim: vuelve aspiradas a ㄱ/ㄷ/ㅂ/ㅈ siguientes (좋다 -> [조타]); antes de vocal suele enmudecer (좋아 -> [조아]).',
            batchimNoteEn: 'As Batchim: aspirates adjacent ㄱ/ㄷ/ㅂ/ㅈ (좋다 -> [jota]); drops silently before vowels (좋아 -> [joa]).',
            variants: [
                [[[0.50, 0.10], [0.50, 0.24]], [[0.16, 0.32], [0.84, 0.32]], circlePts(0.50, 0.64, 0.24, 0.22, 20)],
                [[[0.36, 0.14], [0.64, 0.14]], [[0.16, 0.32], [0.84, 0.32]], circlePts(0.50, 0.64, 0.24, 0.22, 20)]
            ]
        },

        // ==================================================================
        // 4. DOUBLE / TENSE CONSONANTS (5)
        // ==================================================================
        {
            glyph: 'ㄲ',
            name: '쌍기역 (Ssang-giyeok)',
            nameEs: 'Consonante doble Ssang-giyeok (ㄲ)',
            nameEn: 'Double Consonant Ssang-giyeok (ㄲ)',
            category: 'double_consonants',
            categoryLabelEs: 'Doble / Tensa',
            categoryLabelEn: 'Double / Tense',
            romanization: 'kk',
            speak: '까',
            pronunciationEs: '"K" tensa y firme SIN aire (contracción seca de garganta, parecida a "c/k" fuerte española sin soplo).',
            pronunciationEn: 'Tense, unaspirated "kk" (produced with a firm glottal stop, zero burst of air).',
            batchimNoteEs: 'En Batchim (final de sílaba): suena como "k" bloqueada (ej. 밖 [bak] = afuera).',
            batchimNoteEn: 'As Batchim (syllable-final): unreleased "k" stop (e.g. 밖 [bak] = outside).',
            variants: [
                [[[0.12, 0.20], [0.46, 0.20], [0.46, 0.82]], [[0.56, 0.20], [0.88, 0.20], [0.88, 0.82]]]
            ]
        },
        {
            glyph: 'ㄸ',
            name: '쌍디귿 (Ssang-digeut)',
            nameEs: 'Consonante doble Ssang-digeut (ㄸ)',
            nameEn: 'Double Consonant Ssang-digeut (ㄸ)',
            category: 'double_consonants',
            categoryLabelEs: 'Doble / Tensa',
            categoryLabelEn: 'Double / Tense',
            romanization: 'tt',
            speak: '따',
            pronunciationEs: '"T" tensa pura sin aire (como la "t" española marcada con firmeza, ej. 때 = ttae).',
            pronunciationEn: 'Tense, unaspirated "tt" (crisp stop without any puff of air, e.g. 때 = ttae).',
            batchimNoteEs: 'No aparece como consonante final (Batchim) en palabras nativas.',
            batchimNoteEn: 'Does not appear as a syllable-final Batchim in standard Korean.',
            variants: [
                [[[0.12, 0.20], [0.46, 0.20]], [[0.12, 0.20], [0.12, 0.82], [0.46, 0.82]], [[0.56, 0.20], [0.88, 0.20]], [[0.56, 0.20], [0.56, 0.82], [0.88, 0.82]]]
            ]
        },
        {
            glyph: 'ㅃ',
            name: '쌍비읍 (Ssang-bieup)',
            nameEs: 'Consonante doble Ssang-bieup (ㅃ)',
            nameEn: 'Double Consonant Ssang-bieup (ㅃ)',
            category: 'double_consonants',
            categoryLabelEs: 'Doble / Tensa',
            categoryLabelEn: 'Double / Tense',
            romanization: 'pp',
            speak: '빠',
            pronunciationEs: '"P" tensa sin aire (como "p" en "papá" presionando firme los labios, ej. 오빠 = oppa).',
            pronunciationEn: 'Tense, unaspirated "pp" (firm bilabial release with zero air puff, e.g. 오빠 = oppa).',
            batchimNoteEs: 'No aparece como consonante final (Batchim) en el coreano estándar.',
            batchimNoteEn: 'Does not appear as a syllable-final Batchim in standard Korean.',
            variants: [
                [[[0.14, 0.18], [0.14, 0.82]], [[0.44, 0.18], [0.44, 0.82]], [[0.14, 0.50], [0.44, 0.50]], [[0.14, 0.82], [0.44, 0.82]],
                 [[0.56, 0.18], [0.56, 0.82]], [[0.86, 0.18], [0.86, 0.82]], [[0.56, 0.50], [0.86, 0.50]], [[0.56, 0.82], [0.86, 0.82]]]
            ]
        },
        {
            glyph: 'ㅆ',
            name: '쌍시옷 (Ssang-siot)',
            nameEs: 'Consonante doble Ssang-siot (ㅆ)',
            nameEn: 'Double Consonant Ssang-siot (ㅆ)',
            category: 'double_consonants',
            categoryLabelEs: 'Doble / Tensa',
            categoryLabelEn: 'Double / Tense',
            romanization: 'ss',
            speak: '싸',
            pronunciationEs: '"S" intensa y sostenida (con tensión firme, sin escape suave de aire). Muy común en verbos en pasado.',
            pronunciationEn: 'Sharp, tense "ss" with firm tongue tension (very common in past-tense endings).',
            batchimNoteEs: 'En Batchim (final de sílaba): suena como "t" bloqueada (ej. 있다 [itda] = haber/tener).',
            batchimNoteEn: 'As Batchim (syllable-final): unreleased "t" stop (e.g. 있다 [itda] = to exist/have).',
            variants: [
                [[[0.30, 0.18], [0.12, 0.82]], [[0.28, 0.42], [0.48, 0.82]], [[0.70, 0.18], [0.52, 0.82]], [[0.68, 0.42], [0.88, 0.82]]]
            ]
        },
        {
            glyph: 'ㅉ',
            name: '쌍지읒 (Ssang-jieut)',
            nameEs: 'Consonante doble Ssang-jieut (ㅉ)',
            nameEn: 'Double Consonant Ssang-jieut (ㅉ)',
            category: 'double_consonants',
            categoryLabelEs: 'Doble / Tensa',
            categoryLabelEn: 'Double / Tense',
            romanization: 'jj',
            speak: '짜',
            pronunciationEs: '"Ch/J" tensa y comprimida sin aire (ej. 진짜 = jinjja = de verdad).',
            pronunciationEn: 'Tense, unaspirated "jj" (firmly compressed release without air puff, e.g. 진짜 = jinjja).',
            batchimNoteEs: 'No aparece como consonante final (Batchim) en el coreano estándar.',
            batchimNoteEn: 'Does not appear as a syllable-final Batchim in standard Korean.',
            variants: [
                [[[0.12, 0.22], [0.46, 0.22], [0.12, 0.82]], [[0.30, 0.50], [0.48, 0.82]],
                 [[0.54, 0.22], [0.88, 0.22], [0.54, 0.82]], [[0.72, 0.50], [0.90, 0.82]]]
            ]
        }
    ];

    /* ------------------------------------------------------------------
       Stroke Sanitization, Aspect-Smart Normalization & Rasterization
       ------------------------------------------------------------------ */
    function sanitizeStrokes(rawStrokes) {
        if (!Array.isArray(rawStrokes)) return [];
        var cleanStrokes = [];
        var totalPathLen = 0;

        for (var i = 0; i < rawStrokes.length; i++) {
            var rawStroke = rawStrokes[i];
            if (!Array.isArray(rawStroke) || rawStroke.length === 0) continue;
            var pts = [];
            for (var j = 0; j < rawStroke.length; j++) {
                var p = rawStroke[j];
                var px;
                var py;
                if (Array.isArray(p)) {
                    px = Number(p[0]);
                    py = Number(p[1]);
                } else if (p && typeof p === 'object') {
                    px = Number(p.x);
                    py = Number(p.y);
                } else {
                    continue;
                }
                if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
                if (pts.length > 0) {
                    var prev = pts[pts.length - 1];
                    var segDist = Math.hypot(px - prev.x, py - prev.y);
                    if (segDist < 1e-6) continue;
                    totalPathLen += segDist;
                }
                pts.push({ x: px, y: py });
            }
            if (pts.length >= 2) {
                cleanStrokes.push(pts);
            }
        }

        if (cleanStrokes.length === 0 || totalPathLen < 1e-3) {
            return [];
        }
        return cleanStrokes;
    }

    function normalizeStrokesToGrid(rawStrokes, gridSize, pad) {
        var gs = gridSize || GRID_SIZE;
        var pd = pad !== undefined ? pad : GRID_PAD;
        var strokes = sanitizeStrokes(rawStrokes);
        if (strokes.length === 0) {
            return {
                strokes: [],
                rawW: 0,
                rawH: 0,
                minRatio: 0,
                aspectFeature: 0.5
            };
        }

        var minX = Infinity;
        var maxX = -Infinity;
        var minY = Infinity;
        var maxY = -Infinity;
        for (var i = 0; i < strokes.length; i++) {
            var st = strokes[i];
            for (var j = 0; j < st.length; j++) {
                var pt = st[j];
                if (pt.x < minX) minX = pt.x;
                if (pt.x > maxX) maxX = pt.x;
                if (pt.y < minY) minY = pt.y;
                if (pt.y > maxY) maxY = pt.y;
            }
        }

        var rawW = Math.max(0, maxX - minX);
        var rawH = Math.max(0, maxY - minY);
        var maxSpan = Math.max(rawW, rawH, 1e-5);
        var minRatio = Math.min(rawW, rawH) / maxSpan;
        var spanX = minRatio < 0.22 ? maxSpan : (0.55 * rawW + 0.45 * maxSpan);
        var spanY = minRatio < 0.22 ? maxSpan : (0.55 * rawH + 0.45 * maxSpan);
        spanX = Math.max(spanX, 1e-5);
        spanY = Math.max(spanY, 1e-5);

        var cx = (minX + maxX) * 0.5;
        var cy = (minY + maxY) * 0.5;
        var mid = (gs - 1) * 0.5;
        var usable = Math.max(1, gs - 1 - 2 * pd);

        var normStrokes = [];
        for (var sIdx = 0; sIdx < strokes.length; sIdx++) {
            var src = strokes[sIdx];
            var dst = [];
            for (var pIdx = 0; pIdx < src.length; pIdx++) {
                var gp = src[pIdx];
                dst.push({
                    x: mid + ((gp.x - cx) / spanX) * usable,
                    y: mid + ((gp.y - cy) / spanY) * usable
                });
            }
            normStrokes.push(dst);
        }

        return {
            strokes: normStrokes,
            rawW: rawW,
            rawH: rawH,
            minRatio: minRatio,
            aspectFeature: rawW / (rawW + rawH + 1e-5)
        };
    }

    function stampBrush(grid, gs, fx, fy) {
        var cx = Math.round(fx);
        var cy = Math.round(fy);
        for (var dy = -1; dy <= 1; dy++) {
            var py = cy + dy;
            if (py < 0 || py >= gs) continue;
            for (var dx = -1; dx <= 1; dx++) {
                var px = cx + dx;
                if (px < 0 || px >= gs) continue;
                var manhattan = Math.abs(dx) + Math.abs(dy);
                if (manhattan > 1) continue; // Plus-shaped 3x3 brush preserves small loops cleanly
                var w = manhattan === 0 ? 1.0 : 0.65;
                var idx = py * gs + px;
                if (w > grid[idx]) grid[idx] = w;
            }
        }
    }

    function rasterizeStrokes(normStrokes, gridSize) {
        var gs = gridSize || GRID_SIZE;
        var grid = new Float32Array(gs * gs);
        for (var i = 0; i < normStrokes.length; i++) {
            var st = normStrokes[i];
            for (var j = 1; j < st.length; j++) {
                var a = st[j - 1];
                var b = st[j];
                var dx = b.x - a.x;
                var dy = b.y - a.y;
                var dist = Math.hypot(dx, dy);
                var steps = Math.max(1, Math.ceil(dist / 0.45));
                for (var k = 0; k <= steps; k++) {
                    var t = k / steps;
                    stampBrush(grid, gs, a.x + dx * t, a.y + dy * t);
                }
            }
        }
        return grid;
    }

    /* Exact 2-pass 1D Felzenszwalb-Huttenlocher Squared Euclidean Distance Transform */
    function edt1d(f, n) {
        var d = new Float32Array(n);
        var v = new Int32Array(n);
        var z = new Float32Array(n + 1);
        var k = 0;
        v[0] = 0;
        z[0] = -INF_DIST;
        z[1] = INF_DIST;

        for (var q = 1; q < n; q++) {
            var s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
            while (s <= z[k]) {
                k -= 1;
                s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
            }
            k += 1;
            v[k] = q;
            z[k] = s;
            z[k + 1] = INF_DIST;
        }

        k = 0;
        for (var idx = 0; idx < n; idx++) {
            while (z[k + 1] < idx) k += 1;
            var diff = idx - v[k];
            d[idx] = diff * diff + f[v[k]];
        }
        return d;
    }

    function computeSquaredDistanceField(grid, gridSize) {
        var gs = gridSize || GRID_SIZE;
        var out = new Float32Array(gs * gs);
        var f = new Float32Array(gs);

        for (var x = 0; x < gs; x++) {
            for (var y = 0; y < gs; y++) {
                f[y] = grid[y * gs + x] >= 0.5 ? 0 : INF_DIST;
            }
            var colD = edt1d(f, gs);
            for (var y2 = 0; y2 < gs; y2++) {
                out[y2 * gs + x] = colD[y2];
            }
        }

        for (var row = 0; row < gs; row++) {
            for (var col = 0; col < gs; col++) {
                f[col] = out[row * gs + col];
            }
            var rowD = edt1d(f, gs);
            for (var col2 = 0; col2 < gs; col2++) {
                out[row * gs + col2] = rowD[col2];
            }
        }
        return out;
    }

    function computeDirectionalHistogram(normStrokes, gridSize) {
        var gs = gridSize || GRID_SIZE;
        var bins = 8;
        var orients = 4; // 0°, 45°, 90°, 135°
        var hist = new Float32Array(bins * bins * orients);
        var cellSize = gs / bins;

        for (var i = 0; i < normStrokes.length; i++) {
            var st = normStrokes[i];
            for (var j = 1; j < st.length; j++) {
                var a = st[j - 1];
                var b = st[j];
                var dx = b.x - a.x;
                var dy = b.y - a.y;
                var segLen = Math.hypot(dx, dy);
                if (segLen < 1e-4) continue;

                var theta = Math.atan2(dy, dx); // -PI..PI
                if (theta < 0) theta += Math.PI; // 0..PI unsigned
                var oFloat = (theta / Math.PI) * orients; // 0..4
                var o0 = Math.floor(oFloat) % orients;
                var o1 = (o0 + 1) % orients;
                var ow1 = oFloat - Math.floor(oFloat);
                var ow0 = 1 - ow1;

                var subSteps = Math.max(1, Math.ceil(segLen / 1.0));
                var stepW = segLen / subSteps;
                for (var s = 0; s < subSteps; s++) {
                    var t = (s + 0.5) / subSteps;
                    var mx = a.x + dx * t;
                    var my = a.y + dy * t;
                    var bx = Math.max(0, Math.min(bins - 1, Math.floor(mx / cellSize)));
                    var by = Math.max(0, Math.min(bins - 1, Math.floor(my / cellSize)));
                    var base = (by * bins + bx) * orients;
                    hist[base + o0] += stepW * ow0;
                    hist[base + o1] += stepW * ow1;
                }
            }
        }

        var normSq = 0;
        for (var idx = 0; idx < hist.length; idx++) {
            normSq += hist[idx] * hist[idx];
        }
        var norm = Math.sqrt(normSq);
        if (norm > 1e-6) {
            for (var k = 0; k < hist.length; k++) {
                hist[k] /= norm;
            }
        }
        return hist;
    }

    function detectClosedHole(grid, gridSize) {
        var gs = gridSize || GRID_SIZE;
        var total = gs * gs;
        var visited = new Uint8Array(total);
        var queue = new Int32Array(total);
        var head = 0;
        var tail = 0;

        var isWall = function (idx) {
            return grid[idx] >= 0.55;
        };

        for (var x = 0; x < gs; x++) {
            var topIdx = x;
            if (!isWall(topIdx) && !visited[topIdx]) {
                visited[topIdx] = 1;
                queue[tail++] = topIdx;
            }
            var botIdx = (gs - 1) * gs + x;
            if (!isWall(botIdx) && !visited[botIdx]) {
                visited[botIdx] = 1;
                queue[tail++] = botIdx;
            }
        }
        for (var y = 0; y < gs; y++) {
            var leftIdx = y * gs;
            if (!isWall(leftIdx) && !visited[leftIdx]) {
                visited[leftIdx] = 1;
                queue[tail++] = leftIdx;
            }
            var rightIdx = y * gs + (gs - 1);
            if (!isWall(rightIdx) && !visited[rightIdx]) {
                visited[rightIdx] = 1;
                queue[tail++] = rightIdx;
            }
        }

        while (head < tail) {
            var cur = queue[head++];
            var cx = cur % gs;
            var cy = (cur - cx) / gs;
            if (cx > 0) {
                var nL = cur - 1;
                if (!visited[nL] && !isWall(nL)) { visited[nL] = 1; queue[tail++] = nL; }
            }
            if (cx + 1 < gs) {
                var nR = cur + 1;
                if (!visited[nR] && !isWall(nR)) { visited[nR] = 1; queue[tail++] = nR; }
            }
            if (cy > 0) {
                var nU = cur - gs;
                if (!visited[nU] && !isWall(nU)) { visited[nU] = 1; queue[tail++] = nU; }
            }
            if (cy + 1 < gs) {
                var nD = cur + gs;
                if (!visited[nD] && !isWall(nD)) { visited[nD] = 1; queue[tail++] = nD; }
            }
        }

        var holeArea = 0;
        var holeSumY = 0;
        for (var idx = 0; idx < total; idx++) {
            if (!visited[idx] && !isWall(idx)) {
                holeArea += 1;
                holeSumY += Math.floor(idx / gs);
            }
        }

        return {
            hasClosedHole: holeArea >= 5,
            holeArea: holeArea,
            holeCenterY: holeArea > 0 ? (holeSumY / holeArea) / gs : 0.5
        };
    }

    function extractStrokeFeatures(normInfo, grid, gridSize) {
        var gs = gridSize || GRID_SIZE;
        var normStrokes = normInfo.strokes || [];
        var half = gs * 0.5;
        var qTL = 0;
        var qTR = 0;
        var qBL = 0;
        var qBR = 0;
        var totalInk = 0;
        var inkIndices = [];

        for (var y = 0; y < gs; y++) {
            for (var x = 0; x < gs; x++) {
                var idx = y * gs + x;
                var val = grid[idx];
                if (val >= 0.5) {
                    inkIndices.push(idx);
                }
                if (val > 0) {
                    totalInk += val;
                    if (y < half) {
                        if (x < half) qTL += val; else qTR += val;
                    } else {
                        if (x < half) qBL += val; else qBR += val;
                    }
                }
            }
        }

        var invInk = totalInk > 1e-6 ? 1 / totalInk : 0;
        var diagLen = 0;
        var orthoLen = 0;
        var totalLen = 0;
        for (var i = 0; i < normStrokes.length; i++) {
            var st = normStrokes[i];
            for (var j = 1; j < st.length; j++) {
                var dx = Math.abs(st[j].x - st[j - 1].x);
                var dy = Math.abs(st[j].y - st[j - 1].y);
                var len = Math.hypot(dx, dy);
                if (len < 1e-4) continue;
                totalLen += len;
                var ang = Math.atan2(dy, dx); // 0..PI/2
                if (ang > 0.34 && ang < 1.23) {
                    diagLen += len;
                } else {
                    orthoLen += len;
                }
            }
        }

        var holeInfo = detectClosedHole(grid, gs);
        return {
            aspectFeature: normInfo.aspectFeature,
            minRatio: normInfo.minRatio,
            isHorizontalBar: normInfo.aspectFeature > 0.82,
            isVerticalBar: normInfo.aspectFeature < 0.18,
            strokeCount: normStrokes.length,
            diagFraction: totalLen > 1e-5 ? diagLen / totalLen : 0,
            orthoFraction: totalLen > 1e-5 ? orthoLen / totalLen : 0,
            quadrants: [qTL * invInk, qTR * invInk, qBL * invInk, qBR * invInk],
            leftShare: (qTL + qBL) * invInk,
            rightShare: (qTR + qBR) * invInk,
            topShare: (qTL + qTR) * invInk,
            bottomShare: (qBL + qBR) * invInk,
            hasClosedHole: holeInfo.hasClosedHole,
            holeArea: holeInfo.holeArea,
            holeCenterY: holeInfo.holeCenterY,
            inkIndices: inkIndices
        };
    }

    function compileStrokePattern(rawStrokes) {
        var normInfo = normalizeStrokesToGrid(rawStrokes, GRID_SIZE, GRID_PAD);
        var grid = rasterizeStrokes(normInfo.strokes, GRID_SIZE);
        var distSq = computeSquaredDistanceField(grid, GRID_SIZE);
        var dirHist = computeDirectionalHistogram(normInfo.strokes, GRID_SIZE);
        var features = extractStrokeFeatures(normInfo, grid, GRID_SIZE);
        return {
            normInfo: normInfo,
            grid: grid,
            distSq: distSq,
            dirHist: dirHist,
            features: features
        };
    }

    var compiledCatalog = null;
    function getCompiledCatalog() {
        if (compiledCatalog) return compiledCatalog;
        compiledCatalog = HANGUL_JAMO_CATALOG.map(function (entry) {
            var compiledVariants = entry.variants.map(compileStrokePattern);
            var anyClosed = compiledVariants.some(function (v) { return v.features.hasClosedHole; });
            return {
                entry: entry,
                variants: compiledVariants,
                expectsClosedHole: anyClosed
            };
        });
        return compiledCatalog;
    }

    function scorePatterns(userPat, tplPat, entryExpectsClosed) {
        var uf = userPat.features;
        var tf = tplPat.features;
        var uInk = uf.inkIndices;
        var tInk = tf.inkIndices;
        if (uInk.length === 0 || tInk.length === 0) return 0;

        var twoSigmaSq = 2 * CHAMFER_SIGMA * CHAMFER_SIGMA;
        var sumUT = 0;
        for (var i = 0; i < uInk.length; i++) {
            sumUT += Math.exp(-tplPat.distSq[uInk[i]] / twoSigmaSq);
        }
        var covUT = sumUT / uInk.length;

        var sumTU = 0;
        for (var j = 0; j < tInk.length; j++) {
            sumTU += Math.exp(-userPat.distSq[tInk[j]] / twoSigmaSq);
        }
        var covTU = sumTU / tInk.length;

        var chamferF1 = (2 * covUT * covTU) / (covUT + covTU + 1e-6);

        var dirCosine = 0;
        var uHist = userPat.dirHist;
        var tHist = tplPat.dirHist;
        for (var h = 0; h < uHist.length; h++) {
            dirCosine += uHist[h] * tHist[h];
        }
        dirCosine = Math.max(0, Math.min(1, dirCosine));

        var aspectDiff = Math.abs(uf.aspectFeature - tf.aspectFeature);
        var aspectSim = Math.max(0, 1 - aspectDiff * 1.45);

        var quadDiff = 0;
        for (var q = 0; q < 4; q++) {
            quadDiff += Math.abs(uf.quadrants[q] - tf.quadrants[q]);
        }
        var quadSim = Math.max(0, 1 - quadDiff * 0.65);

        var diagSim = Math.max(0, 1 - Math.abs(uf.diagFraction - tf.diagFraction) * 1.3);

        var baseScore =
            0.48 * chamferF1 +
            0.26 * dirCosine +
            0.12 * quadSim +
            0.09 * aspectSim +
            0.05 * diagSim;

        // 1D bar separation (ㅡ vs ㅣ vs 2D symbols)
        if (uf.isHorizontalBar !== tf.isHorizontalBar || uf.isVerticalBar !== tf.isVerticalBar) {
            baseScore -= 0.24;
        } else if ((uf.isHorizontalBar && tf.isHorizontalBar) || (uf.isVerticalBar && tf.isVerticalBar)) {
            baseScore += 0.06;
        }

        // Closed-loop topology affinity (ㅇ, ㅁ, ㅂ, ㅃ, ㅎ vs open letters)
        if (uf.hasClosedHole && entryExpectsClosed) {
            baseScore += 0.05;
        } else if (uf.hasClosedHole && !entryExpectsClosed) {
            baseScore -= 0.08;
        } else if (!uf.hasClosedHole && entryExpectsClosed && tf.hasClosedHole) {
            baseScore -= 0.05;
        }

        // Soft stroke-count tie-breaker (multi-stroke vs single-stroke still passes)
        var strokeDelta = Math.abs(uf.strokeCount - tf.strokeCount);
        if (strokeDelta === 0) {
            baseScore += 0.03;
        } else if (strokeDelta >= 2) {
            baseScore -= Math.min(0.05, strokeDelta * 0.015);
        }

        return Math.max(0, Math.min(0.99, baseScore));
    }

    function recognizeHangulStrokes(rawStrokes, options) {
        var opts = options || {};
        var topK = Math.max(1, Math.min(10, Number.parseInt(opts.topK, 10) || 3));
        var sanitized = sanitizeStrokes(rawStrokes);
        if (sanitized.length === 0) {
            return {
                empty: true,
                strokeCount: 0,
                topMatch: null,
                candidates: []
            };
        }

        var userPat = compileStrokePattern(sanitized);
        var catalog = getCompiledCatalog();
        var scored = [];

        for (var i = 0; i < catalog.length; i++) {
            var item = catalog[i];
            var bestScore = 0;
            for (var v = 0; v < item.variants.length; v++) {
                var s = scorePatterns(userPat, item.variants[v], item.expectsClosedHole);
                if (s > bestScore) bestScore = s;
            }
            var rounded = Number(bestScore.toFixed(4));
            var e = item.entry;
            scored.push({
                glyph: e.glyph,
                name: e.name,
                nameEs: e.nameEs,
                nameEn: e.nameEn,
                category: e.category,
                categoryLabelEs: e.categoryLabelEs,
                categoryLabelEn: e.categoryLabelEn,
                romanization: e.romanization,
                speak: e.speak,
                pronunciationEs: e.pronunciationEs,
                pronunciationEn: e.pronunciationEn,
                batchimNoteEs: e.batchimNoteEs,
                batchimNoteEn: e.batchimNoteEn,
                score: rounded,
                matchPercent: Math.max(1, Math.min(99, Math.round(rounded * 100)))
            });
        }

        scored.sort(function (a, b) {
            if (b.score !== a.score) return b.score - a.score;
            return a.glyph.localeCompare(b.glyph);
        });

        var candidates = scored.slice(0, topK);
        return {
            empty: false,
            strokeCount: sanitized.length,
            topMatch: candidates[0] || null,
            candidates: candidates
        };
    }

    var api = {
        HANGUL_JAMO_CATALOG: HANGUL_JAMO_CATALOG,
        sanitizeStrokes: sanitizeStrokes,
        normalizeStrokesToGrid: normalizeStrokesToGrid,
        extractStrokeFeatures: extractStrokeFeatures,
        recognizeHangulStrokes: recognizeHangulStrokes
    };

    root.HangulTraceRecognizer = api;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);

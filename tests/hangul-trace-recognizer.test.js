const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const recognizer = require(path.join(ROOT, 'public', 'hangul-trace-recognizer.js'));

function buildCircleStrokes(cx = 150, cy = 150, r = 90, steps = 32) {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
        const a = -Math.PI / 2 + (2 * Math.PI * i) / steps;
        pts.push({
            x: cx + r * Math.cos(a),
            y: cy + r * Math.sin(a)
        });
    }
    return [pts];
}

describe('public/hangul-trace-recognizer.js (40 Jamo Offline & Zero-Persistence)', () => {
    it('cubre exactamente los 40 Jamo Hangul con metadatos completos bilingües y pronunciación', () => {
        const catalog = recognizer.HANGUL_JAMO_CATALOG;
        assert.ok(Array.isArray(catalog));
        assert.strictEqual(catalog.length, 40, 'El catálogo debe cubrir exactamente 40 Jamo Hangul');

        const counts = {
            basic_vowels: 0,
            compound_vowels: 0,
            basic_consonants: 0,
            double_consonants: 0
        };
        const seenGlyphs = new Set();

        for (const item of catalog) {
            assert.ok(item.glyph && typeof item.glyph === 'string');
            assert.strictEqual(seenGlyphs.has(item.glyph), false, `Glyph duplicado: ${item.glyph}`);
            seenGlyphs.add(item.glyph);

            assert.ok(Object.prototype.hasOwnProperty.call(counts, item.category), `Categoría desconocida: ${item.category}`);
            counts[item.category] += 1;

            assert.ok(item.name && item.name.length > 0);
            assert.ok(item.nameEs && item.nameEs.length > 0);
            assert.ok(item.nameEn && item.nameEn.length > 0);
            assert.ok(item.romanization && item.romanization.length > 0);
            assert.ok(item.speak && item.speak.length > 0);
            assert.ok(item.pronunciationEs && item.pronunciationEs.length > 0);
            assert.ok(item.pronunciationEn && item.pronunciationEn.length > 0);
            assert.ok(item.batchimNoteEs && item.batchimNoteEs.length > 0);
            assert.ok(item.batchimNoteEn && item.batchimNoteEn.length > 0);
            assert.ok(Array.isArray(item.variants) && item.variants.length >= 1);
        }

        assert.deepStrictEqual(counts, {
            basic_vowels: 10,
            compound_vowels: 11,
            basic_consonants: 14,
            double_consonants: 5
        });
    });

    it('reconoce trazos sintéticos claros (ㅇ, ㅣ, ㅡ, ㄱ, ㄴ, ㅏ, ㅗ, ㅁ, ㅎ) con pronunciación y Top-3 ordenados', () => {
        const cases = [
            {
                expected: 'ㅇ',
                expectedRom: '- / ng',
                strokes: buildCircleStrokes(150, 150, 88, 36)
            },
            {
                expected: 'ㅣ',
                expectedRom: 'i',
                strokes: [[{ x: 150, y: 30 }, { x: 152, y: 150 }, { x: 150, y: 270 }]]
            },
            {
                expected: 'ㅡ',
                expectedRom: 'eu',
                strokes: [[{ x: 30, y: 150 }, { x: 150, y: 148 }, { x: 270, y: 150 }]]
            },
            {
                expected: 'ㄱ',
                expectedRom: 'g / k',
                strokes: [[{ x: 55, y: 60 }, { x: 245, y: 60 }, { x: 245, y: 245 }]]
            },
            {
                expected: 'ㄴ',
                expectedRom: 'n',
                strokes: [[{ x: 60, y: 55 }, { x: 60, y: 245 }, { x: 245, y: 245 }]]
            },
            {
                expected: 'ㅏ',
                expectedRom: 'a',
                strokes: [
                    [{ x: 115, y: 40 }, { x: 115, y: 260 }],
                    [{ x: 115, y: 150 }, { x: 225, y: 150 }]
                ]
            },
            {
                expected: 'ㅗ',
                expectedRom: 'o',
                strokes: [
                    [{ x: 150, y: 72 }, { x: 150, y: 185 }],
                    [{ x: 40, y: 185 }, { x: 260, y: 185 }]
                ]
            },
            {
                expected: 'ㅁ',
                expectedRom: 'm',
                strokes: [
                    [{ x: 60, y: 60 }, { x: 60, y: 240 }],
                    [{ x: 60, y: 60 }, { x: 240, y: 60 }, { x: 240, y: 240 }],
                    [{ x: 60, y: 240 }, { x: 240, y: 240 }]
                ]
            },
            {
                expected: 'ㅎ',
                expectedRom: 'h',
                strokes: [
                    [{ x: 150, y: 36 }, { x: 150, y: 74 }],
                    [{ x: 54, y: 98 }, { x: 246, y: 98 }],
                    ...buildCircleStrokes(150, 194, 62, 28)
                ]
            }
        ];

        for (const testCase of cases) {
            const res = recognizer.recognizeHangulStrokes(testCase.strokes, { topK: 3 });
            assert.strictEqual(res.empty, false, `No debe marcar vacío para ${testCase.expected}`);
            assert.ok(res.topMatch, `Debe devolver topMatch para ${testCase.expected}`);
            assert.strictEqual(
                res.topMatch.glyph,
                testCase.expected,
                `Se esperaba "${testCase.expected}" pero reconoció "${res.topMatch.glyph}" (top3: ${res.candidates.map(c => `${c.glyph}:${c.score}`).join(', ')})`
            );
            assert.strictEqual(res.topMatch.romanization, testCase.expectedRom);
            assert.ok(res.topMatch.pronunciationEs && res.topMatch.pronunciationEn);
            assert.strictEqual(res.candidates.length, 3);
            assert.ok(res.candidates[0].score >= res.candidates[1].score);
            assert.ok(res.candidates[1].score >= res.candidates[2].score);
        }
    });

    it('maneja arreglos de trazos vacíos o inválidos sin lanzar excepciones ni depender de red/storage', () => {
        for (const emptyInput of [undefined, null, [], [[]], [[{ x: 10, y: 10 }]], [[{ x: NaN, y: 10 }, { x: 20, y: 20 }]]]) {
            const res = recognizer.recognizeHangulStrokes(emptyInput);
            assert.strictEqual(res.empty, true);
            assert.strictEqual(res.topMatch, null);
            assert.deepStrictEqual(res.candidates, []);
        }

        const src = fs.readFileSync(path.join(ROOT, 'public', 'hangul-trace-recognizer.js'), 'utf8');
        for (const forbiddenToken of ['fetch(', 'XMLHttpRequest', 'localStorage', 'sessionStorage', '/api/send-english', '/api/send-to-pc']) {
            assert.strictEqual(src.includes(forbiddenToken), false, `hangul-trace-recognizer.js no debe usar ${forbiddenToken}`);
        }
    });
});

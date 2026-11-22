#!/usr/bin/env python3
"""
Cross-platform OOXML (.docx) writer for Personal Daily Hub on Linux/Docker servers.

- Mode `english`: Creates or updates `English_Learning_Notebook.docx` directly in pure
  Python OOXML (no MS Word / win32com required), matching `lib/language-studio.js`.
- Mode `journal`: Creates or appends entries to local `Diario.docx` encrypted with
  `WORD_PASSWORD` via `msoffcrypto-tool` (MS-OFFCRYPTO Agile Encryption) strictly in RAM,
  with mandatory round-trip decryption verification before atomic disk replacement.
"""

from __future__ import annotations

import io
import json
import os
import re
import sys
import unicodedata
import zipfile
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape as _xml_escape
from datetime import datetime, date, timedelta

W_NS_URI = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS_URI = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
XML_NS_URI = "http://www.w3.org/XML/1998/namespace"
W_NS = f"{{{W_NS_URI}}}"
XML_NS = f"{{{XML_NS_URI}}}"

SECCIONES_INGLES = {
    "vocabulary": "1. Glossary & New Words",
    "grammar": "2. Grammar & Usage Notes",
    "phrasal_verb": "3. Phrasal Verbs",
    "music": "4. Songs & Music Study",
    "notes": "5. My Notes & Learnings",
    "alphabet": "6. Alphabets & Composition Rules",
}

_PREFIJOS_SECCION_INGLES = {
    "vocabulary": "1.",
    "grammar": "2.",
    "phrasal_verb": "3.",
    "music": "4.",
    "notes": "5.",
    "alphabet": "6.",
}

_STUDY_LANGUAGE_META = {
    "en": ("English", "🇺🇸 Apartado: Inglés (English)"),
    "ko": ("Korean (한국어)", "🇰🇷 Apartado: Coreano (한국어)"),
    "ja": ("Japanese (日本語)", "🇯🇵 Apartado: Japonés (日本語)"),
    "en_ko": ("English + Korean (K-Pop)", "🎵 Apartado: K-Pop (EN + 한국어)"),
    "en_ja": ("English + Japanese (J-Pop)", "🎌 Apartado: J-Pop (EN + 日本語)"),
}

_RE_JAPANESE_SCRIPT_CHAR = re.compile(r"[\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF]")

_LANG_CODE_ALIASES = {
    "kr": "ko",
    "korean": "ko",
    "coreano": "ko",
    "en": "en",
    "eng": "en",
    "english": "en",
    "inglés": "en",
    "ingles": "en",
    "jp": "ja",
    "jpn": "ja",
    "japanese": "ja",
    "japonés": "ja",
    "japones": "ja",
    "es": "es",
    "esp": "es",
    "spa": "es",
    "spanish": "es",
    "español": "es",
    "espanol": "es",
    "orig": "original",
    "original": "original",
    "jp-en": "original",
    "en-jp": "original",
    "ja-en": "original",
    "en-ja": "original",
}

_CANON_LYRIC_LANG_NAMES = {
    "original": "Original",
    "ko": "Korean",
    "en": "English",
    "ja": "Japanese",
    "es": "Spanish",
}

_RE_ENCABEZADO_IDIOMA_LETRA = re.compile(
    r"^(?:===\s*)?(?:"
    r"\[(?:Letra\s*[—\-]\s*)?(original|orig|en|eng|english|ko|kr|korean|es|esp|spanish|ja|jp|japanese|jp-en|en-jp|ja-en|en-ja|zh|fr|pt|de|it|ru|sub|und)(?:-[A-Za-z0-9]+)?(?:\s*[—/\-:]\s*([^\]]*))?\]"
    r"|"
    r"(Original|Korean|English|Japanese|Spanish)(?:\s*[—\-:]\s*((?:Traducci[oó]n|Translation|Subt[ií]tulos|Subtitles|IA|AI|Local|Romaji|Romanizaci[oó]n)[^\n]*))?"
    r")(?:\s*===)?\s*$",
    re.IGNORECASE,
)


def _formatear_encabezado_idioma_word(clave: str, raw_header: str = "") -> str:
    base_name = _CANON_LYRIC_LANG_NAMES.get(clave) or (str(clave or "").strip().title() or "Original")
    raw = str(raw_header or "").strip()
    if raw:
        m = _RE_ENCABEZADO_IDIOMA_LETRA.match(raw)
        if m:
            suffix = (m.group(2) or m.group(4) or "").strip()
            suffix = re.sub(r"\s*===+\s*$", "", suffix).strip(" —-:")
            if suffix:
                return f"{base_name} — {suffix}"
    return base_name
_RE_HANGUL_CHAR = re.compile(r"[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]")
_RE_STRUCTURAL_TAG_LINE = re.compile(
    r"^\[(?:intro|verse(?:\s*\d+)?|pre-?chorus|post-?chorus|chorus|refrain|bridge|rap(?:\s*part)?|interlude|outro|hook|solo|breakdown|coro|verso(?:\s*\d+)?|puente|estribillo)[^\]]*\]$",
    re.IGNORECASE,
)
_RE_RUIDO_SUBTITULO_LINEA = re.compile(
    r"^(?:\[(?:음악|音楽|歌|music|applause|laughter|cheering|instrumental)\]|\s*[\[\]]\s*)$",
    re.IGNORECASE,
)
_RE_TRADUCCION_ES_EN_NOTAS = re.compile(
    r"(?:^|\n)\[Traducción\s+ES\s*[—-][^\]]+\]\s*\n([\s\S]*?)(?=\n---\n|\Z)",
    re.IGNORECASE,
)

_WORD_SONG_LABEL_MAP = (
    ("Song:", "song_title"),
    ("Track #:", "track_number"),
    ("Language:", "language"),
    ("Artists / Collabs:", "artists_display"),
    ("Album / Release:", "album_release"),
    ("Release Date:", "release_date"),
    ("Playlist / List:", "playlist_name"),
    ("YouTube Music:", "yt_music_url"),
    ("Study Focus:", "focus_summary"),
    ("Stanzas Breakdown (Intro / Chorus / Rap):", "stanzas_breakdown"),
    ("Stanza Breakdown (Intro / Pre-Coro / Coro / Rap / Cierre):", "stanzas_breakdown"),
    ("Stanza Breakdown:", "stanzas_breakdown"),
    ("Lyrics & Meaning Breakdown:", "lyrics_study"),
    ("Heading 2: Letra", "lyrics_study"),
    ("Letra:", "lyrics_study"),
    ("Vocabulary & Expressions:", "vocabulary_list"),
    ("Pronunciation & Connected Speech:", "pronunciation_notes"),
    ("Practice & Quiz:", "practice_quiz"),
    ("Extra Study Notes:", "notes"),
    ("Added:", "added_at"),
)


def _w_tag(name: str) -> str:
    return f"{W_NS}{name}"


def _w_el(_tag_name: str, **attrs) -> ET.Element:
    attrib = {_w_tag(k): str(v) for k, v in attrs.items() if v is not None}
    return ET.Element(_w_tag(_tag_name), attrib)


_RE_XML_INVALID_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_RE_ZERO_WIDTH_CHARS = re.compile(r"[\u200b\u200c\u200d\ufeff]")
_RE_YOUTUBE_NOISE_SUFFIX = re.compile(
    r"\s*(?:\((?:official(?:\s+(?:music\s+)?(?:video|m/?v|audio|lyric(?:s)?\s+video|visualizer|performance\s+video))?|m/?v|mv|lyrics?|lyric\s+video|audio|hd|4k|color\s+coded(?:\s+lyrics)?|eng(?:/esp|/kor|/jpn)?\s+sub(?:s)?)\)|\[(?:official(?:\s+(?:music\s+)?(?:video|m/?v|audio|lyric(?:s)?\s+video|visualizer|performance\s+video))?|m/?v|mv|lyrics?|lyric\s+video|audio|hd|4k|color\s+coded(?:\s+lyrics)?|eng(?:/esp|/kor|/jpn)?\s+sub(?:s)?)\])[\s!?.,;:~·•\-]*$",
    re.IGNORECASE,
)


def _sanitizar_xml_texto(texto) -> str:
    if texto is None:
        return ""
    return _RE_XML_INVALID_CHARS.sub("", str(texto))


def _limpiar_linea(texto) -> str:
    if texto is None:
        return ""
    clean = _sanitizar_xml_texto(_RE_ZERO_WIDTH_CHARS.sub("", str(texto)))
    return clean.replace("\r", " ").replace("\n", " ").strip()


def _dividir_lineas_limpias(texto) -> list[str]:
    if texto is None:
        return []
    clean = _sanitizar_xml_texto(_RE_ZERO_WIDTH_CHARS.sub("", str(texto)))
    return [line.strip() for line in clean.replace("\r", "").split("\n") if line.strip()]


def _normalizar_clave_texto(texto) -> str:
    clean = _RE_ZERO_WIDTH_CHARS.sub("", str(texto or ""))
    clean = (
        clean.replace("’", "'")
        .replace("‘", "'")
        .replace("ʼ", "'")
        .replace("“", '"')
        .replace("”", '"')
        .replace("–", "-")
        .replace("—", "-")
    )
    return " ".join(clean.split()).strip().lower()


def _normalizar_clave_suave(texto) -> str:
    base = _normalizar_clave_texto(texto)
    if not base:
        return ""
    decomposed = unicodedata.normalize("NFKD", base)
    no_marks = "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")
    alnum = "".join(ch if (ch.isalnum() or ch.isspace()) else " " for ch in no_marks)
    cleaned = " ".join(alnum.split()).strip()
    return cleaned or base


def _quitar_ruido_titulo_cancion(titulo: str) -> str:
    clean = _limpiar_linea(titulo)
    while clean:
        nxt = _RE_YOUTUBE_NOISE_SUFFIX.sub("", clean).strip()
        if nxt == clean:
            break
        clean = nxt
    return clean


def _distancia_edicion_acotada(a: str, b: str, max_dist: int = 1) -> int:
    if a == b:
        return 0
    la, lb = len(a), len(b)
    if abs(la - lb) > max_dist:
        return max_dist + 1
    prev = list(range(lb + 1))
    for i, ca in enumerate(a, 1):
        curr = [i]
        row_min = i
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            val = min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
            curr.append(val)
            if val < row_min:
                row_min = val
        if row_min > max_dist:
            return max_dist + 1
        prev = curr
    return prev[lb]


def _es_typo_cercano(a: str, b: str) -> bool:
    if not a or not b:
        return False
    min_len = min(len(a), len(b))
    if min_len < 5:
        return False
    if min_len >= 9 and a[0] == b[0]:
        return _distancia_edicion_acotada(a, b, 2) <= 2
    if a[0] == b[0] or min_len >= 6:
        return _distancia_edicion_acotada(a, b, 1) <= 1
    return False


def _extraer_termino_principal_heading(heading: str) -> str:
    texto = _limpiar_linea(heading)
    for sep in (" — ", " – "):
        if sep in texto:
            texto = texto.split(sep, 1)[0].strip()
            break
    sin_parens = re.sub(r"\s*(?:\([^)]*\)|\[[^\]]*\])\s*", " ", texto).strip()
    return _normalizar_clave_suave(sin_parens or texto)


def _extraer_numero_pista(valor_o_heading):
    if isinstance(valor_o_heading, bool):
        return None
    if isinstance(valor_o_heading, (int, float)):
        num = int(valor_o_heading)
        return num if num > 0 else None
    texto = str(valor_o_heading or "").strip()
    if not texto:
        return None
    if texto.isdigit():
        num = int(texto)
        return num if num > 0 else None
    m = re.match(r"^(?:#|track\s+)?(\d{1,3})\s*[.\-:)\]]\s*", texto, re.IGNORECASE)
    if m:
        num = int(m.group(1))
        return num if num > 0 else None
    return None


def _quitar_prefijo_pista(heading_text) -> str:
    texto = _limpiar_linea(heading_text)
    return re.sub(r"^(?:#|track\s+)?\d{1,3}\s*[.\-:)\]]\s*", "", texto, flags=re.IGNORECASE).strip()


def calcular_encabezado(fecha_objetivo=None) -> str:
    if fecha_objetivo is None:
        fecha_dt = datetime.now().date()
    elif isinstance(fecha_objetivo, datetime):
        fecha_dt = fecha_objetivo.date()
    elif isinstance(fecha_objetivo, date):
        fecha_dt = fecha_objetivo
    else:
        fecha_dt = datetime.strptime(str(fecha_objetivo)[:10], "%Y-%m-%d").date()

    fecha_inicio = date(2026, 8, 30)
    dias_pasados = (fecha_dt - fecha_inicio).days
    d_actual = 500 - dias_pasados

    meses_ingles = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    ]
    mes = meses_ingles[fecha_dt.month - 1]
    dia = fecha_dt.day
    sufijo = "th" if 11 <= dia <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(dia % 10, "th")
    return f"{mes} {dia:02d}{sufijo} D-{d_actual}"


def _build_minimal_docx_bytes(mode: str = "english") -> bytes:
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
        "</Types>"
    )
    root_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        f'<Relationship Id="rId1" Type="{R_NS_URI}/officeDocument" Target="word/document.xml"/>'
        "</Relationships>"
    )
    doc_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        f'<Relationship Id="rId1" Type="{R_NS_URI}/styles" Target="styles.xml"/>'
        f'<Relationship Id="rId2" Type="{R_NS_URI}/settings" Target="settings.xml"/>'
        "</Relationships>"
    )
    settings_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
        f'<w:settings xmlns:w="{W_NS_URI}">'
        '<w:updateFields w:val="true"/>'
        "</w:settings>"
    )
    styles_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
        f'<w:styles xmlns:w="{W_NS_URI}">'
        '<w:docDefaults><w:rPrDefault><w:rPr>'
        '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>'
        '<w:sz w:val="22"/><w:szCs w:val="22"/>'
        "</w:rPr></w:rPrDefault></w:docDefaults>"
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">'
        '<w:name w:val="Normal"/><w:qFormat/>'
        '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="22"/></w:rPr>'
        "</w:style>"
        '<w:style w:type="paragraph" w:styleId="Title">'
        '<w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
        '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:b/><w:sz w:val="36"/></w:rPr>'
        "</w:style>"
        '<w:style w:type="paragraph" w:styleId="Subtitle">'
        '<w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
        '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:i/><w:color w:val="666666"/><w:sz w:val="20"/></w:rPr>'
        "</w:style>"
        '<w:style w:type="paragraph" w:styleId="Heading1">'
        '<w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
        '<w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr>'
        '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:b/><w:sz w:val="30"/></w:rPr>'
        "</w:style>"
        '<w:style w:type="paragraph" w:styleId="Heading2">'
        '<w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
        '<w:pPr><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr>'
        '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:b/><w:sz w:val="26"/></w:rPr>'
        "</w:style>"
        '<w:style w:type="paragraph" w:styleId="Heading3">'
        '<w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
        '<w:pPr><w:keepNext/><w:outlineLvl w:val="2"/></w:pPr>'
        '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:b/><w:sz w:val="23"/></w:rPr>'
        "</w:style>"
        '<w:style w:type="paragraph" w:styleId="TOC1">'
        '<w:name w:val="toc 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>'
        '<w:pPr><w:spacing w:after="60"/></w:pPr>'
        '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="21"/></w:rPr>'
        "</w:style>"
        '<w:style w:type="paragraph" w:styleId="TOC2">'
        '<w:name w:val="toc 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>'
        '<w:pPr><w:spacing w:after="40"/><w:ind w:left="240"/></w:pPr>'
        '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="20"/></w:rPr>'
        "</w:style>"
        '<w:style w:type="paragraph" w:styleId="TOC3">'
        '<w:name w:val="toc 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>'
        '<w:pPr><w:spacing w:after="40"/><w:ind w:left="480"/></w:pPr>'
        '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="19"/></w:rPr>'
        "</w:style>"
        '<w:style w:type="character" w:styleId="Hyperlink">'
        '<w:name w:val="Hyperlink"/>'
        '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr>'
        "</w:style>"
        "</w:styles>"
    )

    if mode == "english":
        sections_xml = "".join(
            f'<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>{_xml_escape(title)}</w:t></w:r></w:p><w:p/>'
            for title in SECCIONES_INGLES.values()
        )
        body_inner = (
            '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>English Learning Notebook</w:t></w:r></w:p>'
            '<w:p><w:pPr><w:pStyle w:val="Subtitle"/></w:pPr><w:r><w:t>Structured Vocabulary, Grammar &amp; Phrasal Verbs Log</w:t></w:r></w:p>'
            '<w:p><w:r><w:rPr><w:b/><w:sz w:val="26"/></w:rPr><w:t>Table of Contents</w:t></w:r></w:p>'
            '<w:p/><w:p/>'
            f"{sections_xml}"
        )
    else:
        body_inner = (
            '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Personal Daily Journal</w:t></w:r></w:p>'
            '<w:p/>'
        )

    document_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
        f'<w:document xmlns:w="{W_NS_URI}" xmlns:r="{R_NS_URI}">'
        f"<w:body>{body_inner}"
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>'
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>'
        "</w:body></w:document>"
    )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zout:
        zout.writestr("[Content_Types].xml", content_types.encode("utf-8"))
        zout.writestr("_rels/.rels", root_rels.encode("utf-8"))
        zout.writestr("word/_rels/document.xml.rels", doc_rels.encode("utf-8"))
        zout.writestr("word/settings.xml", settings_xml.encode("utf-8"))
        zout.writestr("word/styles.xml", styles_xml.encode("utf-8"))
        zout.writestr("word/document.xml", document_xml.encode("utf-8"))
    return buf.getvalue()


def _ooxml_cargar_estilos_mapa(zf: zipfile.ZipFile) -> dict:
    levels = {}
    ids = {
        "normal": "Normal",
        "heading_1": "Heading1",
        "heading_2": "Heading2",
        "heading_3": "Heading3",
        "toc_1": "TOC1",
        "toc_2": "TOC2",
        "toc_3": "TOC3",
        "hyperlink": "Hyperlink",
    }
    if "word/styles.xml" not in zf.namelist():
        return {"levels": levels, "ids": ids}
    try:
        root = ET.fromstring(zf.read("word/styles.xml"))
    except ET.ParseError:
        return {"levels": levels, "ids": ids}

    val_attr = _w_tag("val")
    id_attr = _w_tag("styleId")
    type_attr = _w_tag("type")
    for style in root.findall(f".//{_w_tag('style')}"):
        sid = style.attrib.get(id_attr, "")
        if not sid:
            continue
        stype = style.attrib.get(type_attr, "paragraph").strip().lower()
        name_el = style.find(_w_tag("name"))
        sname = name_el.attrib.get(val_attr, "") if name_el is not None else ""
        low = f"{sid} {sname}".lower()
        if "hyperlink" in low:
            if stype == "character":
                ids["hyperlink"] = sid
        elif sid.lower() == "normal" or sname.strip().lower() == "normal":
            if stype == "paragraph":
                ids["normal"] = sid
        elif re.search(r"\b(?:heading\s*1|t[ií]tulo\s*1)\b", low):
            levels[sid] = 1
            if stype == "paragraph":
                ids["heading_1"] = sid
        elif re.search(r"\b(?:heading\s*2|t[ií]tulo\s*2)\b", low):
            levels[sid] = 2
            if stype == "paragraph":
                ids["heading_2"] = sid
        elif re.search(r"\b(?:heading\s*3|t[ií]tulo\s*3)\b", low):
            levels[sid] = 3
            if stype == "paragraph":
                ids["heading_3"] = sid
        elif re.search(r"\btoc\s*1\b", low) or sid.lower() == "toc1":
            levels[sid] = 0
            if stype == "paragraph":
                ids["toc_1"] = sid
        elif re.search(r"\btoc\s*2\b", low) or sid.lower() == "toc2":
            levels[sid] = 0
            if stype == "paragraph":
                ids["toc_2"] = sid
        elif re.search(r"\btoc\s*3\b", low) or sid.lower() == "toc3":
            levels[sid] = 0
            if stype == "paragraph":
                ids["toc_3"] = sid

        lvl_el = style.find(f"{_w_tag('pPr')}/{_w_tag('outlineLvl')}")
        if lvl_el is not None and sid not in levels and stype == "paragraph":
            try:
                lvl_num = int(lvl_el.attrib.get(val_attr, "-1")) + 1
                if 1 <= lvl_num <= 3:
                    levels[sid] = lvl_num
            except ValueError:
                pass
    return {"levels": levels, "ids": ids}


def _asegurar_estilos_headings_y_toc(styles_bytes: bytes | None, orig_estilos_ids: dict | None = None) -> bytes:
    """Garantiza que word/styles.xml defina Heading1..3 (con w:outlineLvl), TOC1..3 y Hyperlink."""
    if not styles_bytes:
        styles_bytes = (
            f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
            f'<w:styles xmlns:w="{W_NS_URI}"></w:styles>'
        ).encode("utf-8")
    try:
        ET.register_namespace("w", W_NS_URI)
        root = ET.fromstring(styles_bytes)
    except ET.ParseError:
        return styles_bytes

    id_attr = _w_tag("styleId")
    val_attr = _w_tag("val")
    existing = {}
    for st in root.findall(f".//{_w_tag('style')}"):
        sid = st.attrib.get(id_attr, "")
        if sid:
            existing[sid] = st

    ids = orig_estilos_ids or {}
    h1_id = ids.get("heading_1") or "Heading1"
    h2_id = ids.get("heading_2") or "Heading2"
    h3_id = ids.get("heading_3") or "Heading3"
    toc1_id = ids.get("toc_1") or "TOC1"
    toc2_id = ids.get("toc_2") or "TOC2"
    toc3_id = ids.get("toc_3") or "TOC3"
    hl_id = ids.get("hyperlink") or "Hyperlink"

    def _ensure_heading_style(sid: str, name_val: str, outline_num: int, sz_half: int):
        st = existing.get(sid)
        if st is None:
            st = ET.fromstring(
                f'<w:style xmlns:w="{W_NS_URI}" w:type="paragraph" w:styleId="{_xml_escape(sid)}">'
                f'<w:name w:val="{_xml_escape(name_val)}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
                f'<w:pPr><w:keepNext/><w:outlineLvl w:val="{outline_num}"/></w:pPr>'
                f'<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:b/><w:sz w:val="{sz_half}"/></w:rPr>'
                f'</w:style>'
            )
            root.append(st)
            existing[sid] = st
            return
        ppr = st.find(_w_tag("pPr"))
        if ppr is None:
            ppr = _w_el("pPr")
            st.append(ppr)
        if ppr.find(_w_tag("outlineLvl")) is None:
            ppr.append(_w_el("outlineLvl", val=outline_num))

    _ensure_heading_style(h1_id, "heading 1", 0, 30)
    _ensure_heading_style(h2_id, "heading 2", 1, 26)
    _ensure_heading_style(h3_id, "heading 3", 2, 23)

    for tid, tname, tind, tsz in (
        (toc1_id, "toc 1", 0, 21),
        (toc2_id, "toc 2", 240, 20),
        (toc3_id, "toc 3", 480, 19),
    ):
        if tid not in existing:
            ind_xml = f'<w:ind w:left="{tind}"/>' if tind else ""
            st = ET.fromstring(
                f'<w:style xmlns:w="{W_NS_URI}" w:type="paragraph" w:styleId="{_xml_escape(tid)}">'
                f'<w:name w:val="{_xml_escape(tname)}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>'
                f'<w:pPr><w:spacing w:after="40"/>{ind_xml}</w:pPr>'
                f'<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="{tsz}"/></w:rPr>'
                f'</w:style>'
            )
            root.append(st)
            existing[tid] = st

    if hl_id not in existing:
        st = ET.fromstring(
            f'<w:style xmlns:w="{W_NS_URI}" w:type="character" w:styleId="{_xml_escape(hl_id)}">'
            f'<w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr>'
            f'</w:style>'
        )
        root.append(st)

    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' + ET.tostring(root, encoding="unicode")).encode("utf-8")


def _texto_parrafo_ooxml(p_elem: ET.Element) -> str:
    t_tag = _w_tag("t")
    br_tag = _w_tag("br")
    cr_tag = _w_tag("cr")
    tab_tag = _w_tag("tab")
    chunks = []
    for node in p_elem.iter():
        if node.tag == t_tag and node.text:
            chunks.append(node.text)
        elif node.tag in (br_tag, cr_tag):
            chunks.append("\n")
        elif node.tag == tab_tag:
            chunks.append(" ")
    return "".join(chunks).replace("\r", "").strip()


_RE_TOC_STYLE_ID = re.compile(
    r"^(?:toc\s*\d*|tocheading|tabla\s*de\s*contenido.*|indice\s*\d*|índice\s*\d*|tdc\s*\d*)$",
    re.IGNORECASE,
)


def _es_titulo_toc_ingles(el: ET.Element) -> bool:
    if el.tag != _w_tag("p"):
        return False
    return _texto_parrafo_ooxml(el).strip().lower() in (
        "table of contents",
        "tabla de contenido",
        "índice",
        "indice",
    )


def _es_elemento_residuo_toc_ingles(el: ET.Element, estilo_ids: dict | None = None) -> bool:
    if el.tag == _w_tag("sdt"):
        full_instr = " ".join(it.text or "" for it in el.iter(_w_tag("instrText"))).upper()
        if "TOC" in full_instr or "PAGEREF" in full_instr:
            return True
        val_attr = _w_tag("val")
        for g in el.iter(_w_tag("docPartGallery")):
            gval = g.attrib.get(val_attr, "").strip().lower()
            if "table of contents" in gval or "tabla de contenido" in gval:
                return True
        for p in el.iter(_w_tag("p")):
            if _es_titulo_toc_ingles(p) or _es_elemento_residuo_toc_ingles(p, estilo_ids):
                return True
        return False

    if el.tag != _w_tag("p"):
        return False

    val_attr = _w_tag("val")
    toc_style_ids = set()
    if estilo_ids:
        for k in ("toc_1", "toc_2", "toc_3"):
            v = str(estilo_ids.get(k) or "").strip().lower()
            if v:
                toc_style_ids.add(v)

    ppr = el.find(_w_tag("pPr"))
    if ppr is not None:
        pstyle_el = ppr.find(_w_tag("pStyle"))
        if pstyle_el is not None:
            sid = pstyle_el.attrib.get(val_attr, "").strip()
            if _RE_TOC_STYLE_ID.match(sid) or sid.lower() in toc_style_ids:
                return True

    for it in el.iter(_w_tag("instrText")):
        upper = (it.text or "").upper()
        if any(tok in upper for tok in ("TOC", "PAGEREF", "_TOC", "BOOKMARK=ID")):
            return True

    for hl in el.iter(_w_tag("hyperlink")):
        for aval in hl.attrib.values():
            low_a = str(aval or "").lower()
            if "_toc" in low_a or "bookmark=id" in low_a:
                return True

    if any(True for _ in el.iter(_w_tag("fldChar"))):
        return True

    low_txt = _texto_parrafo_ooxml(el).lower()
    if any(
        marker in low_txt
        for marker in (
            "content not found",
            "#bookmark=id",
            "bookmark=id.",
            "error! bookmark not defined",
            "¡error! marcador no definido",
        )
    ):
        return True
    return False


def _tiene_marcador_toc_roto(el: ET.Element) -> bool:
    for hl in el.iter(_w_tag("hyperlink")):
        for aval in hl.attrib.values():
            if "bookmark=id" in str(aval or "").lower():
                return True
    low_txt = _texto_parrafo_ooxml(el).lower()
    return any(
        marker in low_txt
        for marker in (
            "content not found",
            "#bookmark=id",
            "bookmark=id.",
            "error! bookmark not defined",
            "¡error! marcador no definido",
        )
    )


def _es_heading_real_para_corte_toc(el: ET.Element, style_levels: dict | None = None) -> bool:
    if el.tag != _w_tag("p"):
        return False
    if _es_elemento_residuo_toc_ingles(el) or _es_titulo_toc_ingles(el):
        return False
    val_attr = _w_tag("val")
    ppr = el.find(_w_tag("pPr"))
    if ppr is None:
        return False
    pstyle_el = ppr.find(_w_tag("pStyle"))
    if pstyle_el is not None:
        sid = pstyle_el.attrib.get(val_attr, "")
        if style_levels and sid in style_levels and style_levels[sid] in (1, 2, 3):
            return True
        if re.search(r"heading\s*[1-3]|t[ií]tulo\s*[1-3]", sid.lower()):
            return True
    lvl_el = ppr.find(_w_tag("outlineLvl"))
    if lvl_el is not None:
        try:
            lvl = int(lvl_el.attrib.get(val_attr, "-1")) + 1
            if 1 <= lvl <= 3:
                return True
        except ValueError:
            pass
    return False


def _nivel_parrafo_ooxml(p_elem: ET.Element, style_levels: dict) -> int:
    val_attr = _w_tag("val")
    ppr = p_elem.find(_w_tag("pPr"))
    if ppr is not None:
        pstyle_el = ppr.find(_w_tag("pStyle"))
        if pstyle_el is not None:
            sid = pstyle_el.attrib.get(val_attr, "").strip()
            if _RE_TOC_STYLE_ID.match(sid):
                return 0
    for it in p_elem.iter(_w_tag("instrText")):
        upper = (it.text or "").upper()
        if "TOC" in upper or "PAGEREF" in upper:
            return 0
    for hl in p_elem.iter(_w_tag("hyperlink")):
        for aval in hl.attrib.values():
            low_a = str(aval or "").lower()
            if "_toc" in low_a or "bookmark=id" in low_a:
                return 0
    if ppr is None:
        return 0
    pstyle_el = ppr.find(_w_tag("pStyle"))
    if pstyle_el is not None:
        sid = pstyle_el.attrib.get(val_attr, "")
        if sid in style_levels:
            return style_levels[sid]
        low = sid.lower()
        if re.search(r"heading\s*1|t[ií]tulo\s*1", low):
            return 1
        if re.search(r"heading\s*2|t[ií]tulo\s*2", low):
            return 2
        if re.search(r"heading\s*3|t[ií]tulo\s*3", low):
            return 3
    lvl_el = ppr.find(_w_tag("outlineLvl"))
    if lvl_el is not None:
        try:
            lvl = int(lvl_el.attrib.get(val_attr, "-1")) + 1
            if 1 <= lvl <= 3:
                return lvl
        except ValueError:
            pass
    return 0


def _crear_rpr(
    font_size=11,
    bold=False,
    italic=False,
    color=None,
    rstyle=None,
    no_proof=False,
    web_hidden=False,
    use_arial=True,
) -> ET.Element:
    rpr = _w_el("rPr")
    if rstyle:
        rpr.append(_w_el("rStyle", val=rstyle))
    if use_arial:
        rpr.append(_w_el("rFonts", ascii="Arial", hAnsi="Arial", cs="Arial"))
    if bold:
        rpr.append(_w_el("b"))
    if italic:
        rpr.append(_w_el("i"))
    if no_proof:
        rpr.append(_w_el("noProof"))
    if color:
        rpr.append(_w_el("color", val=color))
    if font_size:
        rpr.append(_w_el("sz", val=int(round(float(font_size) * 2))))
    if web_hidden:
        rpr.append(_w_el("webHidden"))
    return rpr


def _crear_run_texto(
    texto,
    font_size=11,
    bold=False,
    italic=False,
    color=None,
    rstyle=None,
    no_proof=False,
    use_arial=True,
) -> ET.Element:
    run = _w_el("r")
    run.append(
        _crear_rpr(
            font_size=font_size,
            bold=bold,
            italic=italic,
            color=color,
            rstyle=rstyle,
            no_proof=no_proof,
            use_arial=use_arial,
        )
    )
    t_el = _w_el("t")
    txt = _sanitizar_xml_texto(texto)
    if txt.startswith(" ") or txt.endswith(" ") or "\t" in txt:
        t_el.attrib[f"{XML_NS}space"] = "preserve"
    t_el.text = txt
    run.append(t_el)
    return run


def _crear_parrafo_texto(
    style_id=None,
    label="",
    text="",
    font_size=11,
    bold_all=False,
    italic=False,
    muted=False,
    color=None,
    page_break_before=None,
    indent_left=None,
    outline_level=None,
) -> ET.Element:
    p = _w_el("p")
    has_indent = indent_left is not None and int(indent_left) > 0
    has_outline = outline_level is not None and 0 <= int(outline_level) <= 8
    if style_id or page_break_before is not None or has_indent or has_outline:
        ppr = _w_el("pPr")
        if style_id:
            ppr.append(_w_el("pStyle", val=style_id))
        if page_break_before is True:
            ppr.append(_w_el("pageBreakBefore"))
        elif page_break_before is False:
            ppr.append(_w_el("pageBreakBefore", val="0"))
        if has_indent:
            ppr.append(_w_el("ind", left=int(indent_left)))
        if has_outline:
            ppr.append(_w_el("outlineLvl", val=int(outline_level)))
        p.append(ppr)
    color_hex = color if color is not None else ("666666" if muted else None)
    if label:
        p.append(_crear_run_texto(label, font_size=font_size, bold=True, italic=italic, color=color_hex))
    if text:
        lines = str(text).replace("\r", "").split("\n")
        for idx, line in enumerate(lines):
            if idx > 0:
                br_run = _w_el("r")
                br_run.append(_w_el("br"))
                p.append(br_run)
            p.append(_crear_run_texto(line, font_size=font_size, bold=bold_all, italic=italic, color=color_hex))
    return p


def _configurar_page_break_before(p_elem: ET.Element, enabled: bool = False) -> None:
    ppr_tag = _w_tag("pPr")
    pstyle_tag = _w_tag("pStyle")
    pb_tag = _w_tag("pageBreakBefore")
    r_tag = _w_tag("r")
    br_tag = _w_tag("br")
    type_attr = _w_tag("type")
    val_attr = _w_tag("val")

    for r in list(p_elem.findall(r_tag)):
        for br in list(r.findall(br_tag)):
            if br.attrib.get(type_attr) == "page":
                r.remove(br)
        if len(r) == 0:
            p_elem.remove(r)

    ppr = p_elem.find(ppr_tag)
    if ppr is None:
        if not enabled:
            return
        ppr = _w_el("pPr")
        p_elem.insert(0, ppr)

    for pb in list(ppr.findall(pb_tag)):
        ppr.remove(pb)

    pb_el = _w_el("pageBreakBefore") if enabled else _w_el("pageBreakBefore", val="0")
    pstyle = ppr.find(pstyle_tag)
    if pstyle is not None:
        idx = list(ppr).index(pstyle) + 1
        ppr.insert(idx, pb_el)
    else:
        ppr.insert(0, pb_el)


def _indice_sectpr(body: ET.Element) -> int:
    children = list(body)
    for idx in range(len(children) - 1, -1, -1):
        if children[idx].tag == _w_tag("sectPr"):
            return idx
    return len(children)


def _encontrar_rango_toc(body_children: list[ET.Element]):
    p_tag = _w_tag("p")
    sdt_tag = _w_tag("sdt")
    fld_tag = _w_tag("fldChar")
    instr_tag = _w_tag("instrText")
    ftype_attr = _w_tag("fldCharType")
    val_attr = _w_tag("val")

    for idx, child in enumerate(body_children):
        if child.tag == sdt_tag:
            full_txt = " ".join(t.text or "" for t in child.iter(instr_tag))
            has_toc_gallery = any(
                "table of contents" in (g.attrib.get(val_attr, "")).lower()
                or "tabla de contenido" in (g.attrib.get(val_attr, "")).lower()
                for g in child.iter(_w_tag("docPartGallery"))
            )
            if re.search(r"\bTOC\b", full_txt, re.IGNORECASE) or has_toc_gallery:
                return (idx, idx + 1)

    depth = 0
    in_toc = False
    pending_start = None
    toc_start = None

    for idx, child in enumerate(body_children):
        if child.tag != p_tag:
            continue
        if in_toc and _es_heading_real_para_corte_toc(child):
            return (toc_start, idx)
        for elem in child.iter():
            if elem.tag == fld_tag:
                ftype = elem.attrib.get(ftype_attr, "")
                if ftype == "begin":
                    depth += 1
                    if not in_toc and depth == 1:
                        pending_start = idx
                elif ftype == "end":
                    if depth > 0:
                        depth -= 1
                    if in_toc and depth == 0:
                        return (toc_start, idx + 1)
                    if not in_toc and depth == 0:
                        pending_start = None
            elif elem.tag == instr_tag and pending_start is not None:
                instr_txt = elem.text or ""
                if re.search(r"\bTOC\b", instr_txt, re.IGNORECASE) and "PAGEREF" not in instr_txt.upper():
                    in_toc = True
                    toc_start = pending_start
    if in_toc and toc_start is not None:
        return (toc_start, len(body_children))
    return None


def _items_cuerpo(body: ET.Element, style_levels: dict):
    p_tag = _w_tag("p")
    items = []
    for child in list(body):
        if child.tag == p_tag:
            items.append((_nivel_parrafo_ooxml(child, style_levels), _texto_parrafo_ooxml(child)))
        else:
            items.append((0, ""))
    return items


def _buscar_rango_seccion(body: ET.Element, style_levels: dict, category: str, toc_range=None):
    items = _items_cuerpo(body, style_levels)
    prefijo = _PREFIJOS_SECCION_INGLES.get(category, "2.")
    sec_start = None
    sec_end = None
    for idx, (level, text) in enumerate(items):
        if toc_range and toc_range[0] <= idx < toc_range[1]:
            continue
        if level == 1 and text.startswith(prefijo):
            sec_start = idx
            continue
        if sec_start is not None and level == 1:
            sec_end = idx
            break
    if sec_start is None:
        return None, _indice_sectpr(body), items
    if sec_end is None:
        sec_end = _indice_sectpr(body)
    return sec_start, sec_end, items


def _asegurar_secciones_y_final(body: ET.Element, style_levels: dict, estilo_ids: dict) -> None:
    p_tag = _w_tag("p")
    toc_range = _encontrar_rango_toc(list(body))
    present = []
    for idx, child in enumerate(list(body)):
        if toc_range and toc_range[0] <= idx < toc_range[1]:
            continue
        if child.tag == p_tag and _nivel_parrafo_ooxml(child, style_levels) == 1:
            present.append(_texto_parrafo_ooxml(child).lower())

    for cat, titulo in SECCIONES_INGLES.items():
        pref = _PREFIJOS_SECCION_INGLES[cat]
        if any(p.startswith(pref) for p in present):
            continue
        insert_pos = _indice_sectpr(body)
        body.insert(
            insert_pos,
            _crear_parrafo_texto(
                style_id=estilo_ids["heading_1"],
                text=titulo,
                font_size=15,
                bold_all=True,
            ),
        )
        body.insert(insert_pos + 1, _w_el("p"))


def _normalizar_saltos_pagina(body: ET.Element, style_levels: dict) -> None:
    children = list(body)
    p_tag = _w_tag("p")
    toc_range = _encontrar_rango_toc(children)
    sect_idx = _indice_sectpr(body)

    in_music = False
    music_albums_seen = 0
    music_tracks_in_album = 0

    for idx in range(sect_idx):
        if toc_range and toc_range[0] <= idx < toc_range[1]:
            continue
        child = children[idx]
        if child.tag != p_tag:
            continue
        lvl = _nivel_parrafo_ooxml(child, style_levels)
        txt = _texto_parrafo_ooxml(child).lower()
        if lvl == 1:
            in_music = txt.startswith("4.")
            music_albums_seen = 0
            music_tracks_in_album = 0
            _configurar_page_break_before(child, enabled=True)
        elif lvl == 2 and in_music:
            is_first_album = music_albums_seen == 0
            music_albums_seen += 1
            music_tracks_in_album = 0
            _configurar_page_break_before(child, enabled=(not is_first_album))
        elif lvl == 3 and in_music:
            is_first_track = music_tracks_in_album == 0
            music_tracks_in_album += 1
            _configurar_page_break_before(child, enabled=(not is_first_track))
        elif lvl in (2, 3):
            _configurar_page_break_before(child, enabled=False)


def _establecer_estilo_y_outline(p_elem: ET.Element, style_id: str, outline_level: int) -> None:
    ppr = p_elem.find(_w_tag("pPr"))
    if ppr is None:
        ppr = _w_el("pPr")
        p_elem.insert(0, ppr)
    pstyle = ppr.find(_w_tag("pStyle"))
    if pstyle is not None:
        pstyle.attrib[_w_tag("val")] = style_id
    else:
        ppr.insert(0, _w_el("pStyle", val=style_id))
    for old_out in list(ppr.findall(_w_tag("outlineLvl"))):
        ppr.remove(old_out)
    ppr.append(_w_el("outlineLvl", val=int(outline_level)))


_KNOWN_ENTRY_FIELD_PREFIXES = (
    "language:",
    "language section:",
    "expression:",
    "english:",
    "romanization:",
    "part of speech:",
    "meaning:",
    "spanish:",
    "example:",
    "examples:",
    "notes:",
    "extra study notes:",
    "phrasal verb:",
    "pattern:",
    "spanish meaning:",
    "english definition:",
    "alphabet overview:",
    "alphabet & symbols:",
    "composition rules:",
    "practice & quiz:",
    "added:",
    "song:",
    "track #:",
    "artists / collabs:",
    "album / release:",
    "release date:",
    "playlist / list:",
    "youtube music:",
    "study focus:",
    "stanzas breakdown",
    "stanza breakdown",
    "lyrics & meaning breakdown:",
    "vocabulary & expressions:",
    "pronunciation & connected speech:",
)
_ENTRY_START_FIELD_PREFIXES = (
    "language:",
    "language section:",
    "expression:",
    "english:",
    "phrasal verb:",
    "alphabet overview:",
)


def _migrar_estilos_heading_invalidos_y_promover_h1(body: ET.Element, style_levels: dict, estilo_ids: dict) -> bool:
    """Migra estilos de carácter inválidos (ej. Ttulo1Car) a Heading1..3 y restaura Heading1 en secciones 1..6 sin estilo."""
    p_tag = _w_tag("p")
    val_attr = _w_tag("val")
    children = list(body)
    toc_range = _encontrar_rango_toc(children)
    sect_idx = _indice_sectpr(body)
    canon_h1_titles = {_normalizar_clave_texto(v) for v in SECCIONES_INGLES.values()}
    changed = False

    for idx in range(sect_idx):
        if toc_range and toc_range[0] <= idx < toc_range[1]:
            continue
        child = children[idx]
        if child.tag != p_tag:
            continue
        if _es_elemento_residuo_toc_ingles(child, estilo_ids) or _es_titulo_toc_ingles(child):
            continue
        lvl = _nivel_parrafo_ooxml(child, style_levels)
        if lvl in (1, 2, 3):
            target_sid = estilo_ids.get(f"heading_{lvl}") or f"Heading{lvl}"
            ppr = child.find(_w_tag("pPr"))
            pstyle = ppr.find(_w_tag("pStyle")) if ppr is not None else None
            cur_sid = pstyle.attrib.get(val_attr, "") if pstyle is not None else ""
            has_out = ppr is not None and ppr.find(_w_tag("outlineLvl")) is not None
            if cur_sid != target_sid or not has_out:
                _establecer_estilo_y_outline(child, target_sid, lvl - 1)
                changed = True
        else:
            norm_txt = _normalizar_clave_texto(_texto_parrafo_ooxml(child))
            if norm_txt in canon_h1_titles:
                _establecer_estilo_y_outline(child, estilo_ids.get("heading_1") or "Heading1", 0)
                changed = True
    return changed


def _fusionar_secciones_h1_duplicadas(body: ET.Element, style_levels: dict) -> bool:
    """Fusiona bloques Heading 1 duplicados (ej. secciones 1..6 repetidas al final) dentro de su sección principal."""
    p_tag = _w_tag("p")
    merged_any = False

    for cat in SECCIONES_INGLES:
        pref = _PREFIJOS_SECCION_INGLES[cat]
        while True:
            children = list(body)
            toc_range = _encontrar_rango_toc(children)
            sect_idx = _indice_sectpr(body)
            matches = [
                idx
                for idx in range(sect_idx)
                if not (toc_range and toc_range[0] <= idx < toc_range[1])
                and children[idx].tag == p_tag
                and _nivel_parrafo_ooxml(children[idx], style_levels) == 1
                and _texto_parrafo_ooxml(children[idx]).lower().startswith(pref)
            ]
            if len(matches) <= 1:
                break

            merged_any = True
            primary_h1_el = children[matches[0]]
            dup_h1 = matches[-1]
            dup_end = sect_idx
            for idx in range(dup_h1 + 1, sect_idx):
                if toc_range and toc_range[0] <= idx < toc_range[1]:
                    continue
                if children[idx].tag == p_tag and _nivel_parrafo_ooxml(children[idx], style_levels) == 1:
                    dup_end = idx
                    break

            dup_body = list(children[dup_h1 + 1 : dup_end])
            for el in children[dup_h1 : dup_end]:
                if el in body:
                    body.remove(el)

            has_real_content = any(
                (el.tag == p_tag and bool(_texto_parrafo_ooxml(el))) or _elemento_tiene_contenido_no_textual(el)
                for el in dup_body
            )
            if not has_real_content:
                continue

            while dup_body and dup_body[0].tag == p_tag and not _texto_parrafo_ooxml(dup_body[0]) and not _elemento_tiene_contenido_no_textual(dup_body[0]):
                dup_body.pop(0)
            if not dup_body:
                continue

            children_after = list(body)
            sect_after = _indice_sectpr(body)
            toc_after = _encontrar_rango_toc(children_after)
            primary_pos = children_after.index(primary_h1_el)
            primary_end = sect_after
            for idx in range(primary_pos + 1, sect_after):
                if toc_after and toc_after[0] <= idx < toc_after[1]:
                    continue
                if children_after[idx].tag == p_tag and _nivel_parrafo_ooxml(children_after[idx], style_levels) == 1:
                    primary_end = idx
                    break

            insert_at = primary_end
            if insert_at > primary_pos + 1:
                prev_el = children_after[insert_at - 1]
                if prev_el.tag != p_tag or _texto_parrafo_ooxml(prev_el) or _elemento_tiene_contenido_no_textual(prev_el):
                    body.insert(insert_at, _w_el("p"))
                    insert_at += 1
            for offset, el in enumerate(dup_body):
                body.insert(insert_at + offset, el)
            last_el = dup_body[-1]
            if last_el.tag != p_tag or _texto_parrafo_ooxml(last_el) or _elemento_tiene_contenido_no_textual(last_el):
                body.insert(insert_at + len(dup_body), _w_el("p"))

    return merged_any


def _reparar_encabezados_entradas_huerfanos(body: ET.Element, style_levels: dict, estilo_ids: dict) -> bool:
    """Restaura Heading 2 + outlineLvl en entradas de secciones 1, 2, 3, 5 y 6 que perdieron su estilo."""
    p_tag = _w_tag("p")
    children = list(body)
    toc_range = _encontrar_rango_toc(children)
    changed = False
    h2_sid = estilo_ids.get("heading_2") or "Heading2"

    for cat in ("vocabulary", "grammar", "phrasal_verb", "notes", "alphabet"):
        sec_start, sec_end, items = _buscar_rango_seccion(body, style_levels, cat, toc_range)
        if sec_start is None:
            continue
        for idx in range(sec_start + 1, sec_end):
            child = children[idx]
            if child.tag != p_tag:
                continue
            lvl, txt = items[idx]
            if not txt or lvl in (1, 2, 3):
                continue
            if txt.lower().startswith(_KNOWN_ENTRY_FIELD_PREFIXES):
                continue
            next_txt = ""
            for j in range(idx + 1, min(sec_end, idx + 3)):
                if items[j][1]:
                    next_txt = items[j][1]
                    break
            if next_txt.lower().startswith(_ENTRY_START_FIELD_PREFIXES):
                _establecer_estilo_y_outline(child, h2_sid, 1)
                changed = True
    return changed


def _reparar_encabezados_musica_huerfanos(body: ET.Element, style_levels: dict, estilo_ids: dict) -> bool:
    """Repara álbumes/canciones existentes que perdieron Heading 2/3 o outlineLvl para que aparezcan en el índice."""
    p_tag = _w_tag("p")
    val_attr = _w_tag("val")
    children = list(body)
    toc_range = _encontrar_rango_toc(children)
    sect_idx = _indice_sectpr(body)
    changed = False

    # Asegurar pStyle válido + outlineLvl explícito en todos los Heading 1..3 existentes
    for idx in range(sect_idx):
        if toc_range and toc_range[0] <= idx < toc_range[1]:
            continue
        child = children[idx]
        if child.tag != p_tag:
            continue
        lvl = _nivel_parrafo_ooxml(child, style_levels)
        if lvl in (1, 2, 3):
            sid = estilo_ids.get(f"heading_{lvl}") or f"Heading{lvl}"
            ppr = child.find(_w_tag("pPr"))
            pstyle = ppr.find(_w_tag("pStyle")) if ppr is not None else None
            cur_sid = pstyle.attrib.get(val_attr, "") if pstyle is not None else ""
            if ppr is None or cur_sid != sid or ppr.find(_w_tag("outlineLvl")) is None:
                _establecer_estilo_y_outline(child, sid, lvl - 1)
                changed = True

    sec_start, sec_end, items = _buscar_rango_seccion(body, style_levels, "music", toc_range)
    if sec_start is None:
        return changed

    re_album_like = re.compile(
        r"^(?:Playlist:|Singles\s*&\s*Standalone\b|.+\((?:Album|Mini[\s-]*Album|EP|Single|Digital[\s-]*Single|Collab[\s-]*Single|Mixtape|OST(?:\s*/\s*Soundtrack)?|Soundtrack|Compilation|Repackage|Special[\s-]*Album|Live[\s-]*Album|Deluxe)[^)]*\)$)",
        re.IGNORECASE,
    )
    children = list(body)
    for idx in range(sec_start + 1, sec_end):
        child = children[idx]
        if child.tag != p_tag:
            continue
        lvl, txt = items[idx]
        if not txt or lvl in (1, 2, 3):
            continue
        # Buscar siguiente línea no vacía en un rango cercano
        next_txt = ""
        for j in range(idx + 1, min(sec_end, idx + 4)):
            if items[j][1]:
                next_txt = items[j][1]
                break
        if next_txt.startswith("Song:"):
            _establecer_estilo_y_outline(child, estilo_ids["heading_3"], 2)
            changed = True
            # Revisar el párrafo no vacío inmediatamente anterior: si parece Álbum, promocionarlo a Heading 2
            for k in range(idx - 1, sec_start, -1):
                prev_lvl, prev_txt = items[k]
                if not prev_txt:
                    continue
                if prev_lvl == 0 and re_album_like.match(prev_txt):
                    _establecer_estilo_y_outline(children[k], estilo_ids["heading_2"], 1)
                    changed = True
                break
        elif re_album_like.match(txt):
            # Solo promocionar si viene una canción después antes del próximo H1/H2
            has_song_after = any(items[j][1].startswith("Song:") for j in range(idx + 1, min(sec_end, idx + 6)))
            if has_song_after:
                _establecer_estilo_y_outline(child, estilo_ids["heading_2"], 1)
                changed = True
    return changed


def _crear_run_oculto_campo(fld_type=None, instr_text=None, text=None, is_tab=False) -> ET.Element:
    run = _w_el("r")
    run.append(_crear_rpr(font_size=None, no_proof=True, web_hidden=True, use_arial=False))
    if is_tab:
        run.append(_w_el("tab"))
    elif fld_type:
        run.append(_w_el("fldChar", fldCharType=fld_type))
    elif instr_text is not None:
        el = _w_el("instrText")
        el.attrib[f"{XML_NS}space"] = "preserve"
        el.text = instr_text
        run.append(el)
    elif text is not None:
        el = _w_el("t")
        el.text = text
        run.append(el)
    return run


def _crear_parrafo_toc(lvl: int, title: str, bm_name: str, estilo_ids: dict, is_first: bool = False) -> ET.Element:
    p = _w_el("p")
    ppr = _w_el("pPr")
    toc_style = estilo_ids.get(f"toc_{lvl}") or f"TOC{lvl}"
    ppr.append(_w_el("pStyle", val=toc_style))
    tabs = _w_el("tabs")
    tabs.append(_w_el("tab", val="right", leader="dot", pos="8828"))
    ppr.append(tabs)
    p.append(ppr)

    if is_first:
        r_begin = _w_el("r")
        r_begin.append(_w_el("fldChar", fldCharType="begin"))
        p.append(r_begin)

        r_instr = _w_el("r")
        instr = _w_el("instrText")
        instr.attrib[f"{XML_NS}space"] = "preserve"
        instr.text = ' TOC \\o "1-3" \\h \\z \\u '
        r_instr.append(instr)
        p.append(r_instr)

        r_sep = _w_el("r")
        r_sep.append(_w_el("fldChar", fldCharType="separate"))
        p.append(r_sep)

    hyperlink = ET.Element(_w_tag("hyperlink"), {_w_tag("anchor"): bm_name, _w_tag("history"): "1"})
    hyperlink.append(
        _crear_run_texto(
            title,
            font_size=None,
            bold=True,
            rstyle=estilo_ids.get("hyperlink") or "Hyperlink",
            no_proof=True,
        )
    )
    hyperlink.append(_crear_run_oculto_campo(is_tab=True))
    hyperlink.append(_crear_run_oculto_campo(fld_type="begin"))
    hyperlink.append(_crear_run_oculto_campo(instr_text=f" PAGEREF {bm_name} \\h "))
    hyperlink.append(_crear_run_oculto_campo(fld_type="separate"))
    hyperlink.append(_crear_run_oculto_campo(text="1"))
    hyperlink.append(_crear_run_oculto_campo(fld_type="end"))
    p.append(hyperlink)
    return p


def _asegurar_bookmark_en_parrafo(p_elem: ET.Element, alloc_bm_fn) -> str:
    bm_start_tag = _w_tag("bookmarkStart")
    name_attr = _w_tag("name")
    for elem in p_elem.iter():
        if elem.tag == bm_start_tag:
            bname = elem.attrib.get(name_attr, "")
            if bname.startswith("_Toc"):
                return bname

    bm_id, bm_name = alloc_bm_fn()
    bms = _w_el("bookmarkStart", id=bm_id, name=bm_name)
    bme = _w_el("bookmarkEnd", id=bm_id)
    insert_pos = 1 if len(p_elem) > 0 and p_elem[0].tag == _w_tag("pPr") else 0
    p_elem.insert(insert_pos, bms)
    p_elem.append(bme)
    return bm_name


def _tiene_residuos_toc_corrupta(body: ET.Element, style_levels: dict, estilo_ids: dict) -> bool:
    p_tag = _w_tag("p")
    children = list(body)
    first_h1_idx = next(
        (
            idx
            for idx, child in enumerate(children)
            if child.tag == p_tag
            and _nivel_parrafo_ooxml(child, style_levels) == 1
            and not _es_elemento_residuo_toc_ingles(child, estilo_ids)
            and not _es_titulo_toc_ingles(child)
        ),
        None,
    )
    pre_limit = first_h1_idx if first_h1_idx is not None else _indice_sectpr(body)
    pre_children = children[:pre_limit]
    toc_range = _encontrar_rango_toc(pre_children)
    toc_start, toc_end = toc_range if toc_range is not None else (-1, -1)

    title_count = 0
    for idx, el in enumerate(pre_children):
        if _es_titulo_toc_ingles(el):
            title_count += 1
            if title_count > 1:
                return True
        if toc_start <= idx < toc_end:
            if _tiene_marcador_toc_roto(el):
                return True
            if el.tag == _w_tag("sdt"):
                for p in el.iter(p_tag):
                    if _tiene_marcador_toc_roto(p):
                        return True
        elif _es_elemento_residuo_toc_ingles(el, estilo_ids):
            return True
    return False


def _reconstruir_toc_con_enlaces(body: ET.Element, style_levels: dict, estilo_ids: dict) -> dict:
    """Asegura marcadores _Toc en Heading 1..3 y reconstruye una única TOC limpia auto-sanando residuos previos al primer H1."""
    p_tag = _w_tag("p")
    bm_start_tag = _w_tag("bookmarkStart")
    id_attr = _w_tag("id")
    name_attr = _w_tag("name")

    children = list(body)
    sect_idx = _indice_sectpr(body)
    first_h1_idx = next(
        (
            idx
            for idx in range(sect_idx)
            if children[idx].tag == p_tag
            and _nivel_parrafo_ooxml(children[idx], style_levels) == 1
            and not _es_elemento_residuo_toc_ingles(children[idx], estilo_ids)
            and not _es_titulo_toc_ingles(children[idx])
        ),
        None,
    )
    pre_limit = first_h1_idx if first_h1_idx is not None else sect_idx
    pre_children = children[:pre_limit]
    toc_range = _encontrar_rango_toc(pre_children)
    toc_start, toc_end = toc_range if toc_range is not None else (-1, -1)

    toc_titles_seen = 0
    blank_outside_count = 0
    corrupted_removed = 0
    seen_inside_toc = set()
    to_remove = []

    for idx, el in enumerate(pre_children):
        in_main_toc = toc_start <= idx < toc_end
        if in_main_toc:
            to_remove.append(el)
            if el.tag == _w_tag("sdt"):
                for p in el.iter(p_tag):
                    ptxt = _texto_parrafo_ooxml(p)
                    if _tiene_marcador_toc_roto(p) or (ptxt and ptxt in seen_inside_toc):
                        corrupted_removed += 1
                    elif ptxt:
                        seen_inside_toc.add(ptxt)
            elif el.tag == p_tag:
                ptxt = _texto_parrafo_ooxml(el)
                if _tiene_marcador_toc_roto(el) or (ptxt and ptxt in seen_inside_toc):
                    corrupted_removed += 1
                elif ptxt:
                    seen_inside_toc.add(ptxt)
            continue

        if _es_titulo_toc_ingles(el):
            toc_titles_seen += 1
            if toc_titles_seen > 1:
                corrupted_removed += 1
            to_remove.append(el)
        elif _es_elemento_residuo_toc_ingles(el, estilo_ids):
            corrupted_removed += 1
            to_remove.append(el)
        elif el.tag == p_tag and not _texto_parrafo_ooxml(el) and not _elemento_tiene_contenido_no_textual(el):
            blank_outside_count += 1
            to_remove.append(el)

    if blank_outside_count > 1 and (corrupted_removed > 0 or toc_titles_seen > 1 or toc_range is not None):
        corrupted_removed += blank_outside_count - 1

    for old_el in to_remove:
        if old_el in body:
            body.remove(old_el)

    # Si había una TOC atrapada en medio del documento (por encabezados previos sin estilo), limpiarla también
    while True:
        mid_children = list(body)
        mid_toc = _encontrar_rango_toc(mid_children)
        if not mid_toc:
            break
        m_start, m_end = mid_toc
        if m_start > 0 and _es_titulo_toc_ingles(mid_children[m_start - 1]):
            body.remove(mid_children[m_start - 1])
            corrupted_removed += 1
        for m_el in mid_children[m_start:m_end]:
            if m_el in body:
                body.remove(m_el)
                corrupted_removed += 1

    children = list(body)
    sect_idx = _indice_sectpr(body)
    first_h1_after = next(
        (
            i
            for i in range(sect_idx)
            if children[i].tag == p_tag
            and _nivel_parrafo_ooxml(children[i], style_levels) == 1
        ),
        None,
    )
    body_scan_start = first_h1_after if first_h1_after is not None else 0

    max_id = 0
    max_toc_num = 245632084
    for ch in children[body_scan_start:sect_idx]:
        for elem in ch.iter():
            if elem.tag == bm_start_tag:
                raw_id = elem.attrib.get(id_attr, "")
                if raw_id.isdigit():
                    max_id = max(max_id, int(raw_id))
                bname = elem.attrib.get(name_attr, "")
                if bname.startswith("_Toc") and bname[4:].isdigit():
                    max_toc_num = max(max_toc_num, int(bname[4:]))

    bm_state = [max_id, max_toc_num]

    def _alloc_bm():
        bm_state[0] += 1
        bm_state[1] += 1
        return bm_state[0], f"_Toc{bm_state[1]}"

    toc_entries = []
    for idx in range(body_scan_start, sect_idx):
        child = children[idx]
        if child.tag != p_tag:
            continue
        lvl = _nivel_parrafo_ooxml(child, style_levels)
        if lvl in (1, 2, 3):
            txt = _texto_parrafo_ooxml(child)
            if txt:
                bm_name = _asegurar_bookmark_en_parrafo(child, _alloc_bm)
                toc_entries.append((lvl, txt, bm_name))

    new_toc_ps = [
        _crear_parrafo_toc(lvl, txt, bm_name, estilo_ids, is_first=(i == 0))
        for i, (lvl, txt, bm_name) in enumerate(toc_entries)
    ]
    end_p = _w_el("p")
    if not new_toc_ps:
        r_b = _w_el("r")
        r_b.append(_w_el("fldChar", fldCharType="begin"))
        end_p.append(r_b)
        r_i = _w_el("r")
        it = _w_el("instrText")
        it.attrib[f"{XML_NS}space"] = "preserve"
        it.text = ' TOC \\o "1-3" \\h \\z \\u '
        r_i.append(it)
        end_p.append(r_i)
        r_s = _w_el("r")
        r_s.append(_w_el("fldChar", fldCharType="separate"))
        end_p.append(r_s)
    r_end = _w_el("r")
    r_end.append(_w_el("fldChar", fldCharType="end"))
    end_p.append(r_end)
    new_toc_ps.append(end_p)

    insert_pos = first_h1_after if first_h1_after is not None else min(2, sect_idx)
    toc_title_p = _crear_parrafo_texto(text="Table of Contents", font_size=13, bold_all=True)
    block = [toc_title_p, *new_toc_ps, _w_el("p")]
    for offset, new_el in enumerate(block):
        body.insert(insert_pos + offset, new_el)

    return {
        "corrupted_removed": corrupted_removed,
        "toc_entries_count": len(toc_entries),
        "toc_paragraphs_count": len(new_toc_ps),
    }


def _serializar_documento(doc_root: ET.Element, orig_xml_bytes: bytes) -> bytes:
    orig_str = orig_xml_bytes.decode("utf-8", errors="replace")
    ns_pairs = []
    m_open = re.search(r"<w:document\b([^>]*)>", orig_str)
    if m_open:
        ns_pairs = re.findall(r'\bxmlns:([A-Za-z0-9_]+)="([^"]+)"', m_open.group(1))
        for prefix, uri in ns_pairs:
            if prefix != "xml":
                ET.register_namespace(prefix, uri)
    else:
        ET.register_namespace("w", W_NS_URI)
        ET.register_namespace("r", R_NS_URI)

    xml_out = ET.tostring(doc_root, encoding="unicode")
    m_out_open = re.search(r"<[^:>]+:document\b[^>]*>", xml_out)
    if m_out_open and ns_pairs:
        open_tag = m_out_open.group(0)
        missing_attrs = "".join(
            f' xmlns:{prefix}="{uri}"'
            for prefix, uri in ns_pairs
            if prefix != "xml" and f"xmlns:{prefix}=" not in open_tag
        )
        if missing_attrs:
            xml_out = xml_out.replace(open_tag, open_tag[:-1] + missing_attrs + ">", 1)
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' + xml_out).encode("utf-8")


# ---------------------------------------------------------------------------
# English Notebook formatting, deduplication, and music merging
# ---------------------------------------------------------------------------

def _limpiar_ruido_letra(texto) -> str:
    raw = str(texto or "").replace("\r", "").strip()
    if not raw:
        return ""
    limpias = []
    for line in raw.split("\n"):
        s = line.strip()
        if s and _RE_RUIDO_SUBTITULO_LINEA.match(s):
            continue
        limpias.append(line.rstrip())
    res = re.sub(r"\n{3,}", "\n\n", "\n".join(limpias))
    return res.strip()


def _limpiar_notas_redundantes_cancion(notes_val, lyrics_val="") -> str:
    notes_clean = str(notes_val or "").replace("\r", "").strip()
    if not notes_clean:
        return ""
    has_es = bool(
        re.search(
            r"(?:^|\n)(?:(?:===\s*)?\[es(?:\s*[—/\-][^\]]*)?\](?:\s*===)?|Spanish(?:\s*[—\-:][^\n]*)?)\s*(?:\n|$)",
            str(lyrics_val or ""),
            re.IGNORECASE,
        )
    )
    if has_es:
        notes_clean = _RE_TRADUCCION_ES_EN_NOTAS.sub("\n", notes_clean)
        notes_clean = re.sub(r"(?:\n---\n|\A---\n|\n---\Z)", "\n", notes_clean)
        notes_clean = re.sub(r"\n{3,}", "\n\n", notes_clean).strip()
    return notes_clean


def _deduplicar_lineas_bloque_letra(cuerpo: str) -> str:
    """Elimina estrofas o bloques consecutivos repetidos accidentalmente dentro de un mismo idioma."""
    raw = str(cuerpo or "").replace("\r", "").strip()
    if not raw:
        return ""
    # Separar por estrofas (doble salto) y eliminar estrofas consecutivas idénticas
    stanzas = [st.strip() for st in re.split(r"\n{2,}", raw) if st.strip()]
    clean_stanzas = []
    prev_stanza_norm = ""
    for st in stanzas:
        # También colapsar repeticiones de bloque completo si la segunda mitad es igual a la primera
        lines_in = [ln.rstrip() for ln in st.split("\n") if ln.strip()]
        dedup_lines = []
        for ln in lines_in:
            if dedup_lines and " ".join(dedup_lines[-1].split()).lower() == " ".join(ln.split()).lower():
                continue
            dedup_lines.append(ln)
        st_clean = "\n".join(dedup_lines).strip()
        st_norm = " ".join(st_clean.split()).lower()
        if st_norm and st_norm == prev_stanza_norm:
            continue
        clean_stanzas.append(st_clean)
        prev_stanza_norm = st_norm
    return "\n\n".join(clean_stanzas).strip()


def _dividir_letra_por_idiomas(texto):
    bloques = []
    clave, encabezado, cuerpo = "", "", []
    for raw in str(texto or "").replace("\r", "").split("\n"):
        m = _RE_ENCABEZADO_IDIOMA_LETRA.match(raw.strip())
        if m:
            if encabezado or any(ln.strip() for ln in cuerpo):
                bloques.append((clave, encabezado, _deduplicar_lineas_bloque_letra("\n".join(cuerpo))))
            raw_code = (m.group(1) or m.group(3) or "").lower()
            clave = _LANG_CODE_ALIASES.get(raw_code, raw_code)
            encabezado = _formatear_encabezado_idioma_word(clave, raw.strip())
            cuerpo = []
        else:
            cuerpo.append(raw)
    if encabezado or any(ln.strip() for ln in cuerpo):
        bloques.append((clave, encabezado, _deduplicar_lineas_bloque_letra("\n".join(cuerpo))))
    return bloques


def _combinar_campo_multilinea(prev_val, new_val, append=False) -> str:
    prev_clean = str(prev_val or "").strip()
    new_clean = str(new_val or "").strip()
    if not new_clean:
        return prev_clean
    if not prev_clean:
        return new_clean
    if not append:
        return new_clean
    if new_clean == prev_clean or new_clean in prev_clean:
        return prev_clean
    if prev_clean in new_clean:
        return new_clean
    return f"{prev_clean}\n---\n{new_clean}"


def _combinar_letra_por_idiomas(prev_val, new_val, append=False) -> str:
    prev_clean = _limpiar_ruido_letra(prev_val)
    new_clean = _limpiar_ruido_letra(new_val)
    if not new_clean and not prev_clean:
        return ""
    if not new_clean:
        # Asegurar normalización de encabezados existentes aunque no haya nuevo texto
        prev_blocks = _dividir_letra_por_idiomas(prev_clean)
        if not any(b[1] for b in prev_blocks):
            return _deduplicar_lineas_bloque_letra(prev_clean)
        new_clean = ""

    def norm(s):
        return " ".join(str(s or "").split()).lower()

    if new_clean and not prev_clean:
        new_blocks = _dividir_letra_por_idiomas(new_clean)
        if not any(b[1] for b in new_blocks):
            return _deduplicar_lineas_bloque_letra(new_clean)
    elif new_clean and (norm(new_clean) == norm(prev_clean) or norm(new_clean) in norm(prev_clean)):
        prev_blocks_chk = _dividir_letra_por_idiomas(prev_clean)
        if not any(b[1] for b in prev_blocks_chk):
            return _deduplicar_lineas_bloque_letra(prev_clean)
        new_clean = ""

    prev_blocks = _dividir_letra_por_idiomas(prev_clean) if prev_clean else []
    new_blocks = _dividir_letra_por_idiomas(new_clean) if new_clean else []
    if not any(b[1] for b in prev_blocks) and not any(b[1] for b in new_blocks):
        return _deduplicar_lineas_bloque_letra(_combinar_campo_multilinea(prev_clean, new_clean, append=append))

    ordered_keys = []
    block_map = {}
    for clave, enc, cuerpo in prev_blocks:
        slot = clave if enc else "__base__"
        clean_body = _deduplicar_lineas_bloque_letra(cuerpo)
        if slot not in block_map:
            ordered_keys.append(slot)
            block_map[slot] = (clave, enc, clean_body)
        elif clean_body and norm(clean_body) not in norm(block_map[slot][2]):
            prev_c = block_map[slot][2]
            block_map[slot] = (clave, block_map[slot][1] or enc, _deduplicar_lineas_bloque_letra(f"{prev_c}\n\n{clean_body}".strip() if prev_c else clean_body))

    for clave, enc, cuerpo in new_blocks:
        slot = clave if enc else "__base__"
        clean_body = _deduplicar_lineas_bloque_letra(cuerpo)
        if slot in block_map:
            old_clave, old_enc, old_cuerpo = block_map[slot]
            if slot == "__base__" and append and old_cuerpo and norm(clean_body) != norm(old_cuerpo):
                updated_body = _deduplicar_lineas_bloque_letra(_combinar_campo_multilinea(old_cuerpo, clean_body, append=True))
            else:
                updated_body = clean_body or old_cuerpo
            # Preferir encabezado más descriptivo (ej. Spanish — Traducción IA) sin corchetes
            chosen_enc = enc if (enc and ("—" in enc or len(enc) > len(old_enc or ""))) else (old_enc or enc)
            block_map[slot] = (clave or old_clave, _formatear_encabezado_idioma_word(clave or old_clave, chosen_enc) if (clave or old_clave) else chosen_enc, updated_body)
        else:
            ordered_keys.append(slot)
            block_map[slot] = (clave, _formatear_encabezado_idioma_word(clave, enc) if clave else enc, clean_body)

    canon_order = {"__base__": 0, "original": 1, "ko": 2, "en": 3, "ja": 4, "es": 5}
    ordered_keys = sorted(ordered_keys, key=lambda k: (canon_order.get(k, 6), ordered_keys.index(k)))

    merged, seen_bodies = [], set()
    for slot in ordered_keys:
        clave, enc, cuerpo = block_map[slot]
        h = norm(cuerpo)
        if not enc and not h:
            continue
        if h and h in seen_bodies:
            continue
        if h:
            seen_bodies.add(h)
        pretty_enc = _formatear_encabezado_idioma_word(clave, enc) if clave else enc
        merged.append((pretty_enc, cuerpo))

    return "\n\n".join(f"{enc}\n{cuerpo}".strip() if enc else cuerpo for enc, cuerpo in merged).strip()


def _parsear_album_release_linea(texto):
    limpio = _limpiar_linea(texto)
    if not limpio:
        return "", "", ""
    m = re.match(r"^(.*?)\s*\(([^)]+)\)\s*$", limpio)
    if not m:
        return limpio, "", ""
    nombre = m.group(1).strip()
    partes = [p.strip() for p in m.group(2).split(",") if p.strip()]
    album_type, release_year = "", ""
    for parte in partes:
        if re.fullmatch(r"\d{4}", parte):
            release_year = parte
        elif not album_type:
            album_type = parte
    return nombre, album_type, release_year


def _extraer_campos_bloque_word(lineas_texto, heading_text="") -> dict:
    fields = {
        "song_title": _quitar_prefijo_pista(heading_text).split(" — ", 1)[0].strip() if heading_text else "",
        "track_number": _extraer_numero_pista(heading_text),
        "language": "", "artists_display": "", "album_title": "", "album_type": "",
        "release_year": "", "release_date": "", "playlist_name": "", "yt_music_url": "",
        "focus_summary": "", "stanzas_breakdown": "", "lyrics_study": "",
        "vocabulary_list": "", "pronunciation_notes": "", "practice_quiz": "",
        "notes": "", "added_at": "",
    }
    multiline_keys = {"stanzas_breakdown", "lyrics_study", "vocabulary_list", "pronunciation_notes", "practice_quiz", "notes"}
    current_key = None

    for raw in lineas_texto or []:
        line = str(raw or "").replace("\r", "").strip()
        if not line:
            if current_key in ("lyrics_study", "stanzas_breakdown") and fields.get(current_key):
                if not fields[current_key].endswith("\n\n"):
                    fields[current_key] = fields[current_key].rstrip("\n") + "\n\n"
            continue
        matched_label = False
        for label, key in _WORD_SONG_LABEL_MAP:
            if line.startswith(label):
                val = line[len(label):].strip()
                if key == "album_release":
                    alb_t, alb_ty, rel_y = _parsear_album_release_linea(val)
                    fields["album_title"], fields["album_type"], fields["release_year"] = alb_t, alb_ty, rel_y
                elif key == "track_number":
                    fields["track_number"] = _extraer_numero_pista(val)
                else:
                    fields[key] = val
                current_key = key if key in multiline_keys else None
                matched_label = True
                break
        if not matched_label and current_key:
            prev = fields.get(current_key, "")
            if prev:
                sep = "" if prev.endswith("\n") else "\n"
                fields[current_key] = f"{prev}{sep}{line}"
            else:
                fields[current_key] = line
    return fields


def _elegir_titulo_cancion_canonico(old_title, new_title) -> str:
    old_t = _limpiar_linea(old_title)
    new_t = _limpiar_linea(new_title)
    if not old_t:
        return _quitar_ruido_titulo_cancion(new_t) or new_t or "Untitled Song"
    if not new_t:
        return _quitar_ruido_titulo_cancion(old_t) or old_t or "Untitled Song"
    old_clean = _quitar_ruido_titulo_cancion(old_t) or old_t
    new_clean = _quitar_ruido_titulo_cancion(new_t) or new_t
    old_k = _normalizar_clave_suave(old_clean)
    new_k = _normalizar_clave_suave(new_clean)
    if old_k and new_k and (new_k == old_k or _es_typo_cercano(new_k, old_k)):
        return old_clean
    return new_clean or new_t or old_clean or "Untitled Song"


def _combinar_metadata_cancion_word(existing_fields, new_entry) -> dict:
    old = existing_fields or {}
    append_study = bool(new_entry.get("append_study_fields"))
    combined_lyrics = _combinar_letra_por_idiomas(old.get("lyrics_study"), new_entry.get("lyrics_study"), append=append_study)
    old_notes_clean = _limpiar_notas_redundantes_cancion(old.get("notes"), combined_lyrics)
    new_notes_clean = _limpiar_notas_redundantes_cancion(new_entry.get("notes"), combined_lyrics)
    merged_notes = _limpiar_notas_redundantes_cancion(
        _combinar_campo_multilinea(old_notes_clean, new_notes_clean, append=append_study),
        combined_lyrics,
    )
    return {
        "category": "music",
        "language": _limpiar_linea(new_entry.get("language")) or _limpiar_linea(old.get("language")),
        "song_title": _elegir_titulo_cancion_canonico(old.get("song_title"), new_entry.get("song_title")),
        "artists_display": _limpiar_linea(new_entry.get("artists_display")) or _limpiar_linea(old.get("artists_display")) or "Unknown Artist",
        "album_title": _limpiar_linea(new_entry.get("album_title")) or _limpiar_linea(old.get("album_title")),
        "album_type": _limpiar_linea(new_entry.get("album_type")) or _limpiar_linea(old.get("album_type")),
        "release_year": _limpiar_linea(new_entry.get("release_year")) or _limpiar_linea(old.get("release_year")),
        "release_date": _limpiar_linea(new_entry.get("release_date")) or _limpiar_linea(old.get("release_date")),
        "track_number": _extraer_numero_pista(new_entry.get("track_number")) or _extraer_numero_pista(old.get("track_number")),
        "playlist_name": _limpiar_linea(new_entry.get("playlist_name")) or _limpiar_linea(old.get("playlist_name")),
        "yt_music_url": _limpiar_linea(new_entry.get("yt_music_url")) or _limpiar_linea(old.get("yt_music_url")),
        "focus_summary": _limpiar_linea(new_entry.get("focus_summary")) or _limpiar_linea(old.get("focus_summary")),
        "stanzas_breakdown": _combinar_campo_multilinea(old.get("stanzas_breakdown"), new_entry.get("stanzas_breakdown"), append=append_study),
        "lyrics_study": combined_lyrics,
        "vocabulary_list": _combinar_campo_multilinea(old.get("vocabulary_list"), new_entry.get("vocabulary_list"), append=append_study),
        "pronunciation_notes": _combinar_campo_multilinea(old.get("pronunciation_notes"), new_entry.get("pronunciation_notes"), append=append_study),
        "practice_quiz": _combinar_campo_multilinea(old.get("practice_quiz"), new_entry.get("practice_quiz"), append=append_study),
        "notes": merged_notes,
        "added_at": _limpiar_linea(new_entry.get("added_at")) or _limpiar_linea(old.get("added_at")),
    }


def _normalizar_codigo_idioma_estudio(raw_lang) -> str:
    val = str(raw_lang or "").strip().lower()
    if not val or val in ("english", "en", "inglés", "ingles"):
        return "en"
    if val in ("ko", "kr", "korean", "coreano", "한국어"):
        return "ko"
    if val in ("ja", "jp", "japanese", "japonés", "japones", "日本語"):
        return "ja"
    if val in ("en_ja", "en-ja", "en_jp", "en-jp", "jp_en", "jp-en", "en+jp", "en+ja", "jpop", "j-pop"):
        return "en_ja"
    if "j-pop" in val or "jpop" in val or (("japanese" in val or "japon" in val or "日本" in val) and ("english" in val or "en " in val or "en+" in val or "(en" in val)):
        return "en_ja"
    if val in ("en_ko", "en-kr", "en+kr", "kpop", "k-pop") or "k-pop" in val or "kpop" in val or (("korean" in val or "corean" in val or "한국" in val) and ("english" in val or "en " in val or "en+" in val or "(en" in val)):
        return "en_ko"
    if "korean" in val or "corean" in val or "한국" in val:
        return "ko"
    if "japanese" in val or "japon" in val or "日本" in val:
        return "ja"
    return "en"


def _resolver_idioma_entrada_estudio(entry: dict) -> tuple[str, str, str]:
    primary = " ".join(
        str(entry.get(k) or "").strip() for k in ("word", "title", "verb", "song_title") if entry.get(k)
    )
    body = " ".join(
        str(entry.get(k) or "").strip()
        for k in ("lyrics_study", "notes", "example", "composition_rules", "symbols_table", "alphabet_overview")
        if entry.get(k)
    )
    combined = f"{primary} {body}".strip()
    primary_hangul = bool(_RE_HANGUL_CHAR.search(primary))
    primary_ja = (not primary_hangul) and bool(_RE_JAPANESE_SCRIPT_CHAR.search(primary))
    any_hangul = bool(_RE_HANGUL_CHAR.search(combined))
    any_ja = bool(_RE_JAPANESE_SCRIPT_CHAR.search(combined))
    stripped_primary = re.sub(r"\[[^\]]*\]|\([^)]*\)", "", primary)
    primary_multi_latin = bool(re.search(r"[A-Za-z]{2,}", stripped_primary))

    raw_explicit = _limpiar_linea(entry.get("language_code") or entry.get("language") or entry.get("language_section"))
    norm_explicit = _normalizar_codigo_idioma_estudio(raw_explicit) if raw_explicit else ""

    if entry.get("category") == "music":
        lyrics_txt = str(entry.get("lyrics_study") or "")
        if norm_explicit == "en_ko" or (any_hangul and re.search(r"[A-Za-z]{3,}", lyrics_txt)):
            code = "en_ko"
        elif norm_explicit == "en_ja" or (any_ja and re.search(r"[A-Za-z]{3,}", lyrics_txt)):
            code = "en_ja"
        elif any_hangul:
            code = "ko"
        elif any_ja:
            code = "ja"
        elif raw_explicit:
            code = norm_explicit
        else:
            code = "en"
    elif primary_hangul:
        code = "en_ko" if (norm_explicit == "en_ko" and primary_multi_latin) else "ko"
    elif primary_ja:
        code = "en_ja" if (norm_explicit == "en_ja" and primary_multi_latin) else "ja"
    elif any_hangul:
        code = "en_ko" if (norm_explicit == "en_ko" and primary_multi_latin) else "ko"
    elif any_ja:
        code = "en_ja" if (norm_explicit == "en_ja" and primary_multi_latin) else "ja"
    elif raw_explicit and norm_explicit in ("ko", "ja"):
        code = norm_explicit
    else:
        code = "en"

    lang_label, sec_label = _STUDY_LANGUAGE_META.get(code, _STUDY_LANGUAGE_META["en"])
    return code, lang_label, sec_label


def parsear_entrada_ingles(entry_or_text) -> dict:
    if isinstance(entry_or_text, dict):
        parsed = entry_or_text
    else:
        texto = (entry_or_text or "").strip()
        if not texto:
            raise ValueError("La entrada de inglés está vacía.")
        try:
            parsed = json.loads(texto)
        except (ValueError, TypeError):
            code, lbl, sec = _resolver_idioma_entrada_estudio({"category": "grammar", "notes": texto})
            return {
                "category": "grammar",
                "language": lbl,
                "language_code": code,
                "language_section": sec,
                "title": _limpiar_linea(texto)[:60] or "General English Note",
                "notes": texto,
                "example": "",
            }
        if not isinstance(parsed, dict):
            code, lbl, sec = _resolver_idioma_entrada_estudio({"category": "grammar", "notes": str(parsed)})
            return {
                "category": "grammar",
                "language": lbl,
                "language_code": code,
                "language_section": sec,
                "title": _limpiar_linea(parsed)[:60] or "General English Note",
                "notes": str(parsed),
                "example": "",
            }

    category = str(parsed.get("category", "")).strip().lower()
    if category not in SECCIONES_INGLES:
        category = "grammar"

    if category == "vocabulary":
        item = {
            "category": "vocabulary",
            "language": _limpiar_linea(parsed.get("language")),
            "language_code": _limpiar_linea(parsed.get("language_code")),
            "language_section": _limpiar_linea(parsed.get("language_section")),
            "word": _limpiar_linea(parsed.get("word")),
            "romanization": _limpiar_linea(parsed.get("romanization")),
            "part_of_speech": _limpiar_linea(parsed.get("part_of_speech")),
            "spanish": _limpiar_linea(parsed.get("spanish")),
            "example": str(parsed.get("example") or "").strip(),
            "notes": str(parsed.get("notes") or "").strip(),
        }
    elif category == "phrasal_verb":
        item = {
            "category": "phrasal_verb",
            "language": _limpiar_linea(parsed.get("language")),
            "language_code": _limpiar_linea(parsed.get("language_code")),
            "language_section": _limpiar_linea(parsed.get("language_section")),
            "verb": _limpiar_linea(parsed.get("verb")),
            "grammar_type": _limpiar_linea(parsed.get("grammar_type")),
            "meaning_es": _limpiar_linea(parsed.get("meaning_es")),
            "meaning_en": _limpiar_linea(parsed.get("meaning_en")),
            "example": str(parsed.get("example") or "").strip(),
            "notes": str(parsed.get("notes") or "").strip(),
        }
    elif category == "notes":
        notes_body = str(parsed.get("notes") or parsed.get("text") or "").strip()
        item = {
            "category": "notes",
            "language": _limpiar_linea(parsed.get("language")),
            "language_code": _limpiar_linea(parsed.get("language_code")),
            "language_section": _limpiar_linea(parsed.get("language_section")),
            "title": _limpiar_linea(parsed.get("title")) or _limpiar_linea(notes_body)[:60] or "Personal Note",
            "notes": notes_body,
            "example": str(parsed.get("example") or "").strip(),
        }
    elif category == "alphabet":
        item = {
            "category": "alphabet",
            "language": _limpiar_linea(parsed.get("language")),
            "language_code": _limpiar_linea(parsed.get("language_code")),
            "language_section": _limpiar_linea(parsed.get("language_section")),
            "title": _limpiar_linea(parsed.get("title")) or "Alphabet & Composition Guide",
            "alphabet_overview": str(parsed.get("alphabet_overview") or "").strip(),
            "symbols_table": str(parsed.get("symbols_table") or "").strip(),
            "composition_rules": str(parsed.get("composition_rules") or "").strip(),
            "example": str(parsed.get("example") or "").strip(),
            "notes": str(parsed.get("notes") or "").strip(),
        }
    elif category == "music":
        raw_track = parsed.get("track_number") if parsed.get("track_number") is not None else parsed.get("numero_pista")
        try:
            track_num = int(raw_track) if raw_track not in (None, "", False) else None
            if track_num is not None and track_num <= 0:
                track_num = None
        except (ValueError, TypeError):
            track_num = _extraer_numero_pista(raw_track)
        item = {
            "category": "music",
            "language": _limpiar_linea(parsed.get("language")),
            "language_code": _limpiar_linea(parsed.get("language_code")),
            "song_title": _limpiar_linea(parsed.get("song_title")),
            "artists_display": _limpiar_linea(parsed.get("artists_display")),
            "album_title": _limpiar_linea(parsed.get("album_title")),
            "album_type": _limpiar_linea(parsed.get("album_type")),
            "release_year": _limpiar_linea(parsed.get("release_year")),
            "release_date": _limpiar_linea(parsed.get("release_date")),
            "track_number": track_num,
            "playlist_name": _limpiar_linea(parsed.get("playlist_name")),
            "yt_music_url": _limpiar_linea(parsed.get("yt_music_url")),
            "focus_summary": _limpiar_linea(parsed.get("focus_summary")),
            "stanzas_breakdown": str(parsed.get("stanzas_breakdown") or "").strip(),
            "lyrics_study": str(parsed.get("lyrics_study") or "").strip(),
            "vocabulary_list": str(parsed.get("vocabulary_list") or "").strip(),
            "pronunciation_notes": str(parsed.get("pronunciation_notes") or "").strip(),
            "practice_quiz": str(parsed.get("practice_quiz") or "").strip(),
            "notes": str(parsed.get("notes") or "").strip(),
            "append_study_fields": bool(parsed.get("append_study_fields")),
        }
    else:
        item = {
            "category": "grammar",
            "language": _limpiar_linea(parsed.get("language")),
            "language_code": _limpiar_linea(parsed.get("language_code")),
            "language_section": _limpiar_linea(parsed.get("language_section")),
            "title": _limpiar_linea(parsed.get("title")) or "Grammar Note",
            "notes": str(parsed.get("notes") or "").strip(),
            "example": str(parsed.get("example") or "").strip(),
            "practice_quiz": str(parsed.get("practice_quiz") or "").strip(),
        }

    lang_code, lang_label, sec_label = _resolver_idioma_entrada_estudio(item)
    item["language_code"] = lang_code
    if not item.get("language") or category != "music":
        item["language"] = lang_label
    if category != "music":
        item["language_section"] = item.get("language_section") or sec_label
    return item


def _encabezado_grupo_album(entry: dict) -> str:
    album_title = _limpiar_linea(entry.get("album_title"))
    album_type = _limpiar_linea(entry.get("album_type"))
    release_year = _limpiar_linea(entry.get("release_year"))
    playlist_name = _limpiar_linea(entry.get("playlist_name"))
    artists_display = _limpiar_linea(entry.get("artists_display")) or "Unknown Artist"
    if album_title:
        meta_parts = [p for p in (album_type, release_year) if p]
        return f"{album_title} ({', '.join(meta_parts)})" if meta_parts else album_title
    if playlist_name:
        return f"Playlist: {playlist_name}"
    return f"Singles & Standalone — {artists_display}"


def _clave_grupo_album(heading: str) -> str:
    texto = _limpiar_linea(heading)
    sin_meta = re.sub(
        r"\s*\((?:Album|Mini[\s-]*Album|EP|Single|Digital[\s-]*Single|Collab[\s-]*Single|Mixtape|OST(?:\s*/\s*Soundtrack)?|Soundtrack|Compilation|Repackage|Special[\s-]*Album|Live[\s-]*Album|Deluxe|Playlist)[^)]*\)\s*$",
        "", texto, flags=re.IGNORECASE,
    ).strip()
    return _normalizar_clave_suave(sin_meta or texto)


def _encabezado_pista_cancion(entry: dict) -> str:
    song_title = _limpiar_linea(entry.get("song_title")) or "Untitled Song"
    artists_display = _limpiar_linea(entry.get("artists_display")) or "Unknown Artist"
    track_num = _extraer_numero_pista(entry.get("track_number"))
    base = f"{song_title} — {artists_display}"
    return f"{track_num:02d}. {base}" if track_num else base


def _clave_pista_cancion(song_title: str, artists_display: str = ""):
    titulo = _quitar_ruido_titulo_cancion(_quitar_prefijo_pista(song_title))
    if not artists_display:
        for sep in (" — ", " – "):
            if sep in titulo:
                titulo = titulo.split(sep, 1)[0].strip()
                break
    titulo = _quitar_ruido_titulo_cancion(titulo)
    if " [" in titulo:
        titulo = re.sub(r"\s*\[[^\]]+\]\s*$", "", titulo).strip()
    titulo = _quitar_ruido_titulo_cancion(titulo)
    return (_normalizar_clave_suave(titulo), _normalizar_clave_suave(artists_display))


def _clave_orden_pista(track_number, song_title=""):
    num = _extraer_numero_pista(track_number)
    return (0 if num is not None else 1, num if num is not None else 999999, _normalizar_clave_texto(song_title))


def _agregar_lineas_texto(lineas_spec: list, label: str, raw_text, preserve_stanzas=False):
    if preserve_stanzas:
        normalized_raw = _combinar_letra_por_idiomas("", raw_text) if raw_text else ""
        if not normalized_raw:
            return
        cleaned = []
        pending_blank = False
        for raw_ln in str(normalized_raw).replace("\r", "").split("\n"):
            s = raw_ln.strip()
            if not s:
                if cleaned:
                    pending_blank = True
                continue
            m_hdr = _RE_ENCABEZADO_IDIOMA_LETRA.match(s)
            if m_hdr:
                raw_code = (m_hdr.group(1) or m_hdr.group(3) or "").lower()
                canon_k = _LANG_CODE_ALIASES.get(raw_code, raw_code)
                s = _formatear_encabezado_idioma_word(canon_k, s)
                if cleaned and cleaned[-1] != "":
                    cleaned.append("")
                pending_blank = False
            elif pending_blank and cleaned and cleaned[-1] != "":
                cleaned.append("")
                pending_blank = False
            cleaned.append(s)
        while cleaned and cleaned[-1] == "":
            cleaned.pop()
        if not cleaned:
            return

        # Emitir el título del apartado en su propia línea para evitar "[ORIGINAL]" o "English" pegado al label
        lineas_spec.append({"label": label.rstrip(), "text": "", "size": 11, "bold_all": True, "italic": False, "muted": False})
        for idx, line in enumerate(cleaned):
            is_lang_hdr = bool(line and _RE_ENCABEZADO_IDIOMA_LETRA.match(line))
            if not line:
                lineas_spec.append({"label": "", "text": "", "size": 11, "bold_all": False, "italic": False, "muted": False})
            elif is_lang_hdr:
                lineas_spec.append({"label": "", "text": line, "size": 11, "bold_all": True, "italic": False, "muted": False, "indent_left": 240})
            else:
                lineas_spec.append({"label": "", "text": line, "size": 11, "bold_all": False, "italic": False, "muted": False, "indent_left": 480})
        return
    for idx, line in enumerate(_dividir_lineas_limpias(raw_text)):
        lineas_spec.append({"label": label if idx == 0 else "", "text": line, "size": 11, "bold_all": False, "italic": False, "muted": False})


def formatear_entrada_ingles(entry: dict, fecha_dt=None) -> dict:
    category = entry.get("category") if entry.get("category") in SECCIONES_INGLES else "grammar"
    section_title = SECCIONES_INGLES[category]
    timestamp_str = _limpiar_linea(entry.get("added_at")) or (fecha_dt or datetime.now()).strftime("%Y-%m-%d %H:%M")
    lang_code, default_lang_label, default_sec_label = _resolver_idioma_entrada_estudio(entry)
    lines = []

    if category == "vocabulary":
        language = _limpiar_linea(entry.get("language")) or default_lang_label
        lang_section = _limpiar_linea(entry.get("language_section")) or default_sec_label
        word = _limpiar_linea(entry.get("word")) or "New Word"
        romanization = _limpiar_linea(entry.get("romanization"))
        pos = _limpiar_linea(entry.get("part_of_speech"))
        spanish = _limpiar_linea(entry.get("spanish")) or "(No translation)"
        word_disp = f"{word} [{romanization}]" if romanization else word
        heading = f"{word_disp} ({pos}) — {spanish}" if pos else f"{word_disp} — {spanish}"
        lines.append({"label": "Language: ", "text": language, "size": 10, "italic": True, "muted": True})
        lines.append({"label": "Language Section: ", "text": lang_section, "size": 9, "italic": True, "muted": True})
        lines.append({"label": "Expression: " if language else "English: ", "text": word, "size": 11, "italic": False, "muted": False})
        if romanization:
            lines.append({"label": "Romanization: ", "text": romanization, "size": 11, "italic": False, "muted": False})
        if pos:
            lines.append({"label": "Part of speech: ", "text": pos, "size": 11, "italic": False, "muted": False})
        lines.append({"label": "Meaning: " if language else "Spanish: ", "text": spanish, "size": 11, "italic": False, "muted": False})
        _agregar_lineas_texto(lines, "Example: ", entry.get("example"))
        _agregar_lineas_texto(lines, "Notes: ", entry.get("notes"))

    elif category == "phrasal_verb":
        language = _limpiar_linea(entry.get("language")) or default_lang_label
        lang_section = _limpiar_linea(entry.get("language_section")) or default_sec_label
        verb = _limpiar_linea(entry.get("verb")) or "Phrasal Verb"
        grammar_type = _limpiar_linea(entry.get("grammar_type"))
        meaning_es = _limpiar_linea(entry.get("meaning_es")) or "(No meaning)"
        meaning_en = _limpiar_linea(entry.get("meaning_en"))
        heading = f"{verb} — {meaning_es}"
        lines.append({"label": "Language: ", "text": language, "size": 10, "italic": True, "muted": True})
        lines.append({"label": "Language Section: ", "text": lang_section, "size": 9, "italic": True, "muted": True})
        lines.append({"label": "Phrasal Verb: ", "text": verb, "size": 11, "italic": False, "muted": False})
        if grammar_type:
            lines.append({"label": "Pattern: ", "text": grammar_type, "size": 11, "italic": False, "muted": False})
        lines.append({"label": "Spanish Meaning: ", "text": meaning_es, "size": 11, "italic": False, "muted": False})
        if meaning_en:
            lines.append({"label": "English Definition: ", "text": meaning_en, "size": 11, "italic": False, "muted": False})
        _agregar_lineas_texto(lines, "Example: ", entry.get("example"))
        _agregar_lineas_texto(lines, "Notes: ", entry.get("notes"))

    elif category == "alphabet":
        language = _limpiar_linea(entry.get("language")) or default_lang_label
        lang_section = _limpiar_linea(entry.get("language_section")) or default_sec_label
        heading = _limpiar_linea(entry.get("title")) or f"Alphabet & Composition — {language}"
        lines.append({"label": "Language: ", "text": language, "size": 10, "italic": True, "muted": True})
        lines.append({"label": "Language Section: ", "text": lang_section, "size": 9, "italic": True, "muted": True})
        _agregar_lineas_texto(lines, "Alphabet Overview: ", entry.get("alphabet_overview"))
        _agregar_lineas_texto(lines, "Alphabet & Symbols: ", entry.get("symbols_table"))
        _agregar_lineas_texto(lines, "Composition Rules: ", entry.get("composition_rules"))
        _agregar_lineas_texto(lines, "Examples: ", entry.get("example"))
        _agregar_lineas_texto(lines, "Notes: ", entry.get("notes"))

    elif category == "music":
        language = _limpiar_linea(entry.get("language")) or default_lang_label
        song_title = _limpiar_linea(entry.get("song_title")) or "Untitled Song"
        artists_display = _limpiar_linea(entry.get("artists_display")) or "Unknown Artist"
        album_title = _limpiar_linea(entry.get("album_title"))
        album_type = _limpiar_linea(entry.get("album_type"))
        release_year = _limpiar_linea(entry.get("release_year"))
        release_date = _limpiar_linea(entry.get("release_date"))
        track_num = _extraer_numero_pista(entry.get("track_number"))
        playlist_name = _limpiar_linea(entry.get("playlist_name"))
        yt_music_url = _limpiar_linea(entry.get("yt_music_url"))
        focus_summary = _limpiar_linea(entry.get("focus_summary"))

        meta_parts = [p for p in (album_type, release_year) if p]
        album_label = f"{album_title} ({', '.join(meta_parts)})" if (album_title and meta_parts) else (", ".join(meta_parts) if meta_parts else album_title)
        group_heading = _encabezado_grupo_album(entry)
        track_heading = _encabezado_pista_cancion(entry)
        heading = track_heading

        lines.append({"label": "Song: ", "text": song_title, "size": 11, "italic": False, "muted": False})
        if track_num:
            lines.append({"label": "Track #: ", "text": f"{track_num:02d}", "size": 10, "italic": False, "muted": True})
        if language:
            lines.append({"label": "Language: ", "text": language, "size": 11, "italic": False, "muted": False})
        lines.append({"label": "Artists / Collabs: ", "text": artists_display, "size": 11, "italic": False, "muted": False})
        if album_label:
            lines.append({"label": "Album / Release: ", "text": album_label, "size": 11, "italic": False, "muted": False})
        if release_date:
            lines.append({"label": "Release Date: ", "text": release_date, "size": 10, "italic": False, "muted": True})
        if playlist_name:
            lines.append({"label": "Playlist / List: ", "text": playlist_name, "size": 11, "italic": False, "muted": False})
        if yt_music_url:
            lines.append({"label": "YouTube Music: ", "text": yt_music_url, "size": 10, "italic": False, "muted": True})
        if focus_summary:
            lines.append({"label": "Study Focus: ", "text": focus_summary, "size": 11, "italic": False, "muted": False})

        clean_lyrics = _limpiar_ruido_letra(entry.get("lyrics_study"))
        clean_notes = _limpiar_notas_redundantes_cancion(entry.get("notes"), clean_lyrics)
        _agregar_lineas_texto(lines, "Stanzas Breakdown (Intro / Chorus / Rap): ", entry.get("stanzas_breakdown"), preserve_stanzas=True)
        _agregar_lineas_texto(lines, "Lyrics & Meaning Breakdown: ", clean_lyrics, preserve_stanzas=True)
        _agregar_lineas_texto(lines, "Vocabulary & Expressions: ", entry.get("vocabulary_list"))
        _agregar_lineas_texto(lines, "Pronunciation & Connected Speech: ", entry.get("pronunciation_notes"))
        _agregar_lineas_texto(lines, "Practice & Quiz: ", entry.get("practice_quiz"))
        _agregar_lineas_texto(lines, "Extra Study Notes: ", clean_notes)

    else:
        language = _limpiar_linea(entry.get("language")) or default_lang_label
        lang_section = _limpiar_linea(entry.get("language_section")) or default_sec_label
        heading = _limpiar_linea(entry.get("title")) or "Grammar Note"
        lines.append({"label": "Language: ", "text": language, "size": 10, "italic": True, "muted": True})
        lines.append({"label": "Language Section: ", "text": lang_section, "size": 9, "italic": True, "muted": True})
        _agregar_lineas_texto(lines, "Notes: ", entry.get("notes"))
        _agregar_lineas_texto(lines, "Examples: ", entry.get("example"))
        _agregar_lineas_texto(lines, "Practice & Quiz: ", entry.get("practice_quiz"))

    lines.append({"label": "Added: ", "text": timestamp_str, "size": 9, "italic": True, "muted": True})
    out = {
        "category": category,
        "section_title": section_title,
        "heading": heading,
        "lines": lines,
        "language": _limpiar_linea(entry.get("language")) or default_lang_label,
        "language_code": lang_code,
    }
    if category == "music":
        out["group_heading"] = group_heading
        out["track_heading"] = track_heading
        out["track_number"] = track_num
    return out


def _construir_bloque_elementos(
    heading_text: str,
    heading_style_id: str,
    heading_size: float,
    lines_spec: list,
    outline_level: int | None = None,
) -> list[ET.Element]:
    if outline_level is None:
        low_s = str(heading_style_id or "").lower()
        if "1" in low_s:
            outline_level = 0
        elif "2" in low_s:
            outline_level = 1
        elif "3" in low_s:
            outline_level = 2
    elems = [
        _crear_parrafo_texto(
            style_id=heading_style_id,
            text=heading_text,
            font_size=heading_size,
            bold_all=True,
            outline_level=outline_level,
        )
    ]
    for spec in lines_spec:
        elems.append(
            _crear_parrafo_texto(
                label=spec.get("label", ""),
                text=spec.get("text", ""),
                font_size=spec.get("size", 11),
                bold_all=bool(spec.get("bold_all")),
                italic=bool(spec.get("italic")),
                muted=bool(spec.get("muted")),
                indent_left=spec.get("indent_left"),
            )
        )
    elems.append(_w_el("p"))
    return elems


def _establecer_texto_heading(p_elem: ET.Element, heading_text: str, font_size: float) -> None:
    ppr_tag = _w_tag("pPr")
    bm_start_tag = _w_tag("bookmarkStart")
    bm_end_tag = _w_tag("bookmarkEnd")
    keep_elems = [child for child in list(p_elem) if child.tag in (ppr_tag, bm_start_tag, bm_end_tag)]
    for child in list(p_elem):
        p_elem.remove(child)
    for child in keep_elems:
        p_elem.append(child)
    p_elem.append(_crear_run_texto(heading_text, font_size=font_size, bold=True))


def _cuerpo_normalizado(textos) -> str:
    limpio = [t for t in textos if t and not t.startswith("Added:")]
    return _normalizar_clave_suave(" ".join(limpio))


def _bloque_duplicado(items, sec_start, sec_end, spec: dict) -> bool:
    if sec_start is None:
        return False
    target_heading = _normalizar_clave_texto(spec["heading"])
    target_soft = _normalizar_clave_suave(spec["heading"])
    strict_heading = spec.get("category") in ("vocabulary", "phrasal_verb")
    target_term = _extraer_termino_principal_heading(spec["heading"]) if strict_heading else ""
    target_lang = spec.get("language_code") or ""
    new_body = _cuerpo_normalizado([f"{ln.get('label', '')}{ln.get('text', '')}" for ln in spec["lines"]])
    idx = sec_start + 1
    while idx < sec_end:
        level, text = items[idx]
        if level == 2:
            j = idx + 1
            while j < sec_end and items[j][0] not in (1, 2):
                j += 1
            norm_txt = _normalizar_clave_texto(text)
            soft_txt = _normalizar_clave_suave(text)
            if norm_txt == target_heading or (target_soft and soft_txt == target_soft):
                if strict_heading:
                    return True
                existing = _cuerpo_normalizado([items[k][1] for k in range(idx + 1, j)])
                if existing == new_body:
                    return True
            elif strict_heading and target_term and _extraer_termino_principal_heading(text) == target_term:
                block_texts = [items[k][1] for k in range(idx + 1, j) if items[k][1]]
                existing_lang = _detectar_idioma_bloque_items(text, block_texts)
                if not target_lang or not existing_lang or existing_lang == target_lang:
                    return True
            idx = j
            continue
        idx += 1
    return False


def _agrupar_musica_desde_items(items, sec_start: int, sec_end: int):
    groups = []
    cur_group = None
    idx = sec_start + 1
    while idx < sec_end:
        level, text = items[idx]
        if level == 2:
            if cur_group:
                cur_group["end_idx"] = idx
                groups.append(cur_group)
            cur_group = {"h2_idx": idx, "heading": text, "group_key": _clave_grupo_album(text), "tracks": [], "end_idx": sec_end}
            idx += 1
            continue
        if level == 3 and cur_group is not None:
            j = idx + 1
            while j < sec_end and items[j][0] not in (1, 2, 3):
                j += 1
            song_key, _ = _clave_pista_cancion(text)
            cur_group["tracks"].append({
                "h3_idx": idx, "end_idx": j, "heading": text,
                "track_num": _extraer_numero_pista(text), "song_key": song_key,
            })
            idx = j
            continue
        idx += 1
    if cur_group:
        cur_group["end_idx"] = sec_end
        groups.append(cur_group)
    return groups


def _coincide_cancion_en_bloque(fields: dict, heading_text: str, target_title: str, target_artist: str = "") -> bool:
    heading_clean = _quitar_prefijo_pista(heading_text)
    heading_song = heading_clean
    for sep in (" — ", " – "):
        if sep in heading_clean:
            heading_song = heading_clean.split(sep, 1)[0].strip()
            break
    cand_title = fields.get("song_title") or heading_song
    cand_artist = fields.get("artists_display") or ""
    t_key, a_key = _clave_pista_cancion(target_title, target_artist)
    c_t_key, c_a_key = _clave_pista_cancion(cand_title, cand_artist)
    if not t_key or not c_t_key:
        return False
    if a_key and c_a_key and a_key != c_a_key:
        if a_key not in c_a_key and c_a_key not in a_key:
            return False
    if t_key == c_t_key:
        return True
    return _es_typo_cercano(t_key, c_t_key)


def _detectar_idioma_bloque_items(heading_text: str, body_texts: list[str]) -> str:
    explicit_lang = ""
    for line in body_texts:
        low = line.lower()
        if low.startswith("language section:") or low.startswith("language:"):
            explicit_lang = line.split(":", 1)[1].strip()
            break
    code, _, _ = _resolver_idioma_entrada_estudio({
        "title": heading_text,
        "language": explicit_lang,
        "notes": "\n".join(body_texts),
    })
    return code


def _indice_insercion_agrupado_idioma(items, sec_start: int | None, sec_end: int, target_lang_code: str) -> int:
    if sec_start is None:
        return sec_end
    lang_order = {"en": 0, "ko": 1, "ja": 2, "en_ko": 3, "en_ja": 4}
    target_order = lang_order.get(target_lang_code, 9)
    last_same_end = None
    first_after_idx = None

    idx = sec_start + 1
    while idx < sec_end:
        level, text = items[idx]
        if level == 2 and text:
            j = idx + 1
            while j < sec_end and items[j][0] not in (1, 2):
                j += 1
            block_texts = [items[k][1] for k in range(idx + 1, j) if items[k][1]]
            blk_code = _detectar_idioma_bloque_items(text, block_texts)
            if blk_code == target_lang_code:
                last_same_end = j
            elif first_after_idx is None and lang_order.get(blk_code, 9) > target_order:
                first_after_idx = idx
            idx = j
            continue
        idx += 1

    if last_same_end is not None:
        return last_same_end
    if first_after_idx is not None:
        return first_after_idx
    return sec_end


def update_english_docx_bytes(orig_bytes: bytes | None, raw_entry) -> tuple[bytes, dict]:
    if not orig_bytes:
        orig_bytes = _build_minimal_docx_bytes(mode="english")

    entry = parsear_entrada_ingles(raw_entry)
    with zipfile.ZipFile(io.BytesIO(orig_bytes), "r") as zin:
        estilos = _ooxml_cargar_estilos_mapa(zin)
        orig_doc_bytes = zin.read("word/document.xml")
        orig_styles_bytes = zin.read("word/styles.xml") if "word/styles.xml" in zin.namelist() else None

    style_levels = estilos["levels"]
    estilo_ids = estilos["ids"]
    doc_root = ET.fromstring(orig_doc_bytes)
    body = doc_root.find(_w_tag("body"))
    if body is None:
        raise ValueError("word/document.xml sin elemento w:body")

    repaired_headings = _migrar_estilos_heading_invalidos_y_promover_h1(body, style_levels, estilo_ids)
    merged_dups = _fusionar_secciones_h1_duplicadas(body, style_levels)
    _asegurar_secciones_y_final(body, style_levels, estilo_ids)
    repaired_entries = _reparar_encabezados_entradas_huerfanos(body, style_levels, estilo_ids)
    repaired_music = _reparar_encabezados_musica_huerfanos(body, style_levels, estilo_ids)
    had_structural_repairs = repaired_headings or merged_dups or repaired_entries or repaired_music

    deduplicated = False
    if entry.get("category") == "music":
        toc_range = _encontrar_rango_toc(list(body))
        sec_start, sec_end, items = _buscar_rango_seccion(body, style_levels, "music", toc_range)
        if sec_start is None:
            sec_start = 0
        groups = _agrupar_musica_desde_items(items, sec_start, sec_end)
        target_title = _limpiar_linea(entry.get("song_title"))
        target_artist = _limpiar_linea(entry.get("artists_display"))

        combined_existing = None
        elems_to_remove = []
        body_children = list(body)
        for grp in groups:
            matched_in_grp = 0
            for tr in grp["tracks"]:
                body_lines = [_texto_parrafo_ooxml(body_children[p_i]) for p_i in range(tr["h3_idx"] + 1, tr["end_idx"])]
                existing_fields = _extraer_campos_bloque_word(body_lines, tr["heading"])
                if _coincide_cancion_en_bloque(existing_fields, tr["heading"], target_title, target_artist):
                    matched_in_grp += 1
                    combined_existing = (
                        existing_fields
                        if combined_existing is None
                        else _combinar_metadata_cancion_word(combined_existing, dict(existing_fields, category="music", append_study_fields=True))
                    )
                    elems_to_remove.extend(body_children[tr["h3_idx"]:tr["end_idx"]])
            if matched_in_grp and matched_in_grp == len(grp["tracks"]):
                first_tr_idx = grp["tracks"][0]["h3_idx"]
                has_other = any(_texto_parrafo_ooxml(body_children[p_i]) for p_i in range(grp["h2_idx"] + 1, first_tr_idx))
                if not has_other:
                    elems_to_remove.extend(body_children[grp["h2_idx"]:first_tr_idx])

        for rm_el in elems_to_remove:
            if rm_el in body:
                body.remove(rm_el)

        merged_entry = _combinar_metadata_cancion_word(combined_existing, entry) if combined_existing is not None else dict(entry)
        toc_range = _encontrar_rango_toc(list(body))
        sec_start, sec_end, items = _buscar_rango_seccion(body, style_levels, "music", toc_range)
        if sec_start is None:
            sec_start = 0

        target_group_heading = _encabezado_grupo_album(merged_entry)
        target_group_key = _clave_grupo_album(target_group_heading)
        groups = _agrupar_musica_desde_items(items, sec_start, sec_end)
        matched_group = next((g for g in groups if g["group_key"] == target_group_key), None)

        if matched_group is None:
            body.insert(sec_end, _crear_parrafo_texto(style_id=estilo_ids["heading_2"], text=target_group_heading, font_size=13, bold_all=True, outline_level=1))
            body.insert(sec_end + 1, _w_el("p"))
            toc_range = _encontrar_rango_toc(list(body))
            sec_start, sec_end, items = _buscar_rango_seccion(body, style_levels, "music", toc_range)
            groups = _agrupar_musica_desde_items(items, sec_start or 0, sec_end)
            matched_group = next((g for g in groups if g["group_key"] == target_group_key), None)
        elif len(target_group_heading) > len(matched_group["heading"]):
            _establecer_texto_heading(body[matched_group["h2_idx"]], target_group_heading, 13)

        spec = formatear_entrada_ingles(merged_entry)
        bloque = _construir_bloque_elementos(spec["heading"], estilo_ids["heading_3"], 11.5, spec["lines"], outline_level=2)
        if matched_group is None:
            for offset, el in enumerate(bloque):
                body.insert(sec_end + offset, el)
        else:
            new_sort_key = _clave_orden_pista(spec.get("track_number"), merged_entry.get("song_title"))
            insert_at = matched_group["end_idx"]
            for tr in matched_group["tracks"]:
                if _clave_orden_pista(tr.get("track_num"), tr.get("song_key")) > new_sort_key:
                    insert_at = tr["h3_idx"]
                    break
            for offset, el in enumerate(bloque):
                body.insert(insert_at + offset, el)
    else:
        spec = formatear_entrada_ingles(entry)
        toc_range = _encontrar_rango_toc(list(body))
        sec_start, sec_end, items = _buscar_rango_seccion(body, style_levels, spec["category"], toc_range)
        if _bloque_duplicado(items, sec_start, sec_end, spec):
            deduplicated = True
        else:
            insert_pos = _indice_insercion_agrupado_idioma(items, sec_start, sec_end, spec.get("language_code", "en"))
            bloque = _construir_bloque_elementos(spec["heading"], estilo_ids["heading_2"], 12, spec["lines"], outline_level=1)
            for offset, el in enumerate(bloque):
                body.insert(insert_pos + offset, el)

    if deduplicated and not had_structural_repairs and not _tiene_residuos_toc_corrupta(body, style_levels, estilo_ids):
        return orig_bytes, {
            "category": spec["category"],
            "heading": spec["heading"],
            "language": spec.get("language", ""),
            "languageCode": spec.get("language_code", ""),
            "deduplicated": True,
            "removedTocParagraphs": 0,
        }

    _reparar_encabezados_musica_huerfanos(body, style_levels, estilo_ids)
    _normalizar_saltos_pagina(body, style_levels)
    toc_stats = _reconstruir_toc_con_enlaces(body, style_levels, estilo_ids)
    new_doc_bytes = _serializar_documento(doc_root, orig_doc_bytes)
    new_styles_bytes = _asegurar_estilos_headings_y_toc(orig_styles_bytes, estilo_ids)

    out_buf = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(orig_bytes), "r") as zin, zipfile.ZipFile(out_buf, "w", compression=zipfile.ZIP_DEFLATED) as zout:
        has_styles = False
        for info in zin.infolist():
            if info.filename == "word/document.xml":
                payload = new_doc_bytes
            elif info.filename == "word/styles.xml":
                payload = new_styles_bytes
                has_styles = True
            else:
                payload = zin.read(info.filename)
            zout.writestr(info, payload)
        if not has_styles:
            zout.writestr("word/styles.xml", new_styles_bytes)
    out_bytes = out_buf.getvalue()
    _validar_docx_bytes(out_bytes)
    return out_bytes, {
        "category": spec["category"],
        "heading": spec["heading"],
        "language": spec.get("language", ""),
        "languageCode": spec.get("language_code", ""),
        "deduplicated": deduplicated,
        "removedTocParagraphs": toc_stats["corrupted_removed"],
        "tocEntriesCount": toc_stats["toc_entries_count"],
    }


def _validar_docx_bytes(docx_bytes: bytes) -> None:
    if not docx_bytes or len(docx_bytes) < 64 or not docx_bytes.startswith(b"PK"):
        raise ValueError("Archivo .docx generado inválido (cabecera ZIP ausente).")
    with zipfile.ZipFile(io.BytesIO(docx_bytes), "r") as zf:
        names = set(zf.namelist())
        if "word/document.xml" not in names:
            raise ValueError("Archivo .docx generado sin word/document.xml.")
        doc_root = ET.fromstring(zf.read("word/document.xml"))
        if doc_root.find(_w_tag("body")) is None:
            raise ValueError("word/document.xml generado sin elemento w:body.")
        if "word/styles.xml" in names:
            ET.fromstring(zf.read("word/styles.xml"))


def _contar_entradas_y_secciones_english(body: ET.Element, style_levels: dict) -> tuple[dict, list[str]]:
    toc_range = _encontrar_rango_toc(list(body))
    counts = {cat: 0 for cat in SECCIONES_INGLES}
    sections_present = []
    p_tag = _w_tag("p")
    sect_idx = _indice_sectpr(body)
    for idx, child in enumerate(list(body)[:sect_idx]):
        if toc_range and toc_range[0] <= idx < toc_range[1]:
            continue
        if child.tag == p_tag and _nivel_parrafo_ooxml(child, style_levels) == 1:
            txt = _texto_parrafo_ooxml(child)
            if txt:
                sections_present.append(txt)

    for cat in SECCIONES_INGLES:
        sec_start, sec_end, items = _buscar_rango_seccion(body, style_levels, cat, toc_range)
        if sec_start is None:
            continue
        if cat == "music":
            groups = _agrupar_musica_desde_items(items, sec_start, sec_end)
            counts["music"] = sum(len(g["tracks"]) for g in groups)
        else:
            counts[cat] = sum(1 for i in range(sec_start + 1, sec_end) if items[i][0] == 2 and items[i][1])
    return counts, sections_present


def repair_english_docx_bytes(orig_bytes: bytes) -> tuple[bytes, dict]:
    """Repara en frío un English_Learning_Notebook.docx existente sin insertar entradas ficticias."""
    if not orig_bytes:
        raise ValueError("Se requieren bytes de un archivo English_Learning_Notebook.docx existente.")

    with zipfile.ZipFile(io.BytesIO(orig_bytes), "r") as zin:
        estilos = _ooxml_cargar_estilos_mapa(zin)
        orig_doc_bytes = zin.read("word/document.xml")
        orig_styles_bytes = zin.read("word/styles.xml") if "word/styles.xml" in zin.namelist() else None

    style_levels = estilos["levels"]
    estilo_ids = estilos["ids"]
    doc_root = ET.fromstring(orig_doc_bytes)
    body = doc_root.find(_w_tag("body"))
    if body is None:
        raise ValueError("word/document.xml sin elemento w:body")

    _migrar_estilos_heading_invalidos_y_promover_h1(body, style_levels, estilo_ids)
    _fusionar_secciones_h1_duplicadas(body, style_levels)
    _asegurar_secciones_y_final(body, style_levels, estilo_ids)
    _reparar_encabezados_entradas_huerfanos(body, style_levels, estilo_ids)
    _reparar_encabezados_musica_huerfanos(body, style_levels, estilo_ids)
    _normalizar_saltos_pagina(body, style_levels)
    toc_stats = _reconstruir_toc_con_enlaces(body, style_levels, estilo_ids)

    counts, sections_present = _contar_entradas_y_secciones_english(body, style_levels)
    sections_low = [s.lower() for s in sections_present]
    sections_intact = all(
        any(h.startswith(pref) for h in sections_low)
        for pref in _PREFIJOS_SECCION_INGLES.values()
    )

    new_doc_bytes = _serializar_documento(doc_root, orig_doc_bytes)
    new_styles_bytes = _asegurar_estilos_headings_y_toc(orig_styles_bytes, estilo_ids)

    out_buf = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(orig_bytes), "r") as zin, zipfile.ZipFile(out_buf, "w", compression=zipfile.ZIP_DEFLATED) as zout:
        has_styles = False
        for info in zin.infolist():
            if info.filename == "word/document.xml":
                payload = new_doc_bytes
            elif info.filename == "word/styles.xml":
                payload = new_styles_bytes
                has_styles = True
            else:
                payload = zin.read(info.filename)
            zout.writestr(info, payload)
        if not has_styles:
            zout.writestr("word/styles.xml", new_styles_bytes)

    out_bytes = out_buf.getvalue()
    _validar_docx_bytes(out_bytes)
    return out_bytes, {
        "ok": True,
        "repaired": True,
        "removedTocParagraphs": toc_stats["corrupted_removed"],
        "corruptedTocRemoved": toc_stats["corrupted_removed"],
        "tocEntriesCount": toc_stats["toc_entries_count"],
        "validTocEntries": toc_stats["toc_entries_count"],
        "tocParagraphsCount": toc_stats["toc_paragraphs_count"],
        "sectionsCount": len(sections_present),
        "sectionsIntact": sections_intact,
        "sections": sections_present,
        "counts": counts,
    }


# ---------------------------------------------------------------------------
# Journal password-protected (.docx) writer & daily verifier via msoffcrypto-tool
# ---------------------------------------------------------------------------

NOTHING_TO_REPORT_TEXT = "Nothing to report."
_JOURNAL_EPOCH_DATE = date(2026, 8, 30)
_JOURNAL_EPOCH_D = 500
_MONTH_NAME_TO_NUM = {
    "january": 1, "jan": 1,
    "february": 2, "feb": 2,
    "march": 3, "mar": 3,
    "april": 4, "apr": 4,
    "may": 5,
    "june": 6, "jun": 6,
    "july": 7, "jul": 7,
    "august": 8, "aug": 8,
    "september": 9, "sept": 9, "sep": 9,
    "october": 10, "oct": 10,
    "november": 11, "nov": 11,
    "december": 12, "dec": 12,
}
_RE_JOURNAL_DAY_HEADING = re.compile(
    r"^(January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|"
    r"September|Sept|Sep|October|Oct|November|Nov|December|Dec)"
    r"\s+(\d{1,2})(?:st|nd|rd|th)?\s+D\s*-\s*(-?\d+)$",
    re.IGNORECASE,
)


def _parse_iso_date(val=None) -> date:
    if val is None:
        return datetime.now().date()
    if isinstance(val, datetime):
        return val.date()
    if isinstance(val, date):
        return val
    return datetime.strptime(str(val)[:10], "%Y-%m-%d").date()


def _es_parrafo_toc_journal(p_elem: ET.Element) -> bool:
    if p_elem.tag != _w_tag("p"):
        return False
    ppr = p_elem.find(_w_tag("pPr"))
    if ppr is not None:
        pstyle = ppr.find(_w_tag("pStyle"))
        if pstyle is not None:
            sid = pstyle.attrib.get(_w_tag("val"), "").strip()
            if re.match(r"^(?:toc\d*|tocheading|tabladecontenido.*)$", sid, re.IGNORECASE):
                return True
    instr_tag = _w_tag("instrText")
    for it in p_elem.iter(instr_tag):
        upper = (it.text or "").upper()
        if "TOC" in upper or "PAGEREF" in upper:
            return True
    return False


def parsear_fecha_encabezado_journal(text: str):
    cleaned = " ".join(str(text or "").split()).strip()
    if not cleaned:
        return None
    m = _RE_JOURNAL_DAY_HEADING.match(cleaned)
    if not m:
        return None
    month_num = _MONTH_NAME_TO_NUM.get(m.group(1).lower())
    if not month_num:
        return None
    try:
        day_num = int(m.group(2))
        d_num = int(m.group(3))
    except ValueError:
        return None
    expected = _JOURNAL_EPOCH_DATE + timedelta(days=_JOURNAL_EPOCH_D - d_num)
    if expected.month == month_num and expected.day == day_num:
        return expected
    try:
        candidate = date(expected.year, month_num, day_num)
        if abs((candidate - expected).days) <= 2:
            return candidate
    except ValueError:
        pass
    return None


def _elemento_tiene_contenido_no_textual(el: ET.Element) -> bool:
    if el.tag == _w_tag("tbl"):
        return True
    for node in el.iter():
        local_name = node.tag.split("}")[-1].lower()
        if local_name in {"drawing", "pict", "object", "imagedata"}:
            return True
    return False


def _es_parrafo_vacio_journal(el: ET.Element) -> bool:
    return (
        el.tag == _w_tag("p")
        and not _texto_parrafo_ooxml(el)
        and not _elemento_tiene_contenido_no_textual(el)
    )


def _extraer_secciones_journal(body: ET.Element) -> list[dict]:
    children = list(body)
    sect_idx = _indice_sectpr(body)
    toc_range = _encontrar_rango_toc(children)
    p_tag = _w_tag("p")

    headings = []
    for idx in range(sect_idx):
        if toc_range and toc_range[0] <= idx < toc_range[1]:
            continue
        el = children[idx]
        if el.tag != p_tag or _es_parrafo_toc_journal(el):
            continue
        txt = _texto_parrafo_ooxml(el)
        dt = parsear_fecha_encabezado_journal(txt)
        if dt is not None:
            headings.append((idx, dt, txt))

    sections = []
    for pos, (start_idx, dt, heading_txt) in enumerate(headings):
        end_idx = headings[pos + 1][0] if pos + 1 < len(headings) else sect_idx
        content_indices = []
        content_texts = []
        has_non_text = False
        for idx in range(start_idx + 1, end_idx):
            if toc_range and toc_range[0] <= idx < toc_range[1]:
                continue
            el = children[idx]
            if el.tag == p_tag and _es_parrafo_toc_journal(el):
                continue
            if _elemento_tiene_contenido_no_textual(el):
                has_non_text = True
            if el.tag == p_tag:
                ptxt = _texto_parrafo_ooxml(el)
                if ptxt:
                    content_indices.append(idx)
                    content_texts.append(ptxt)

        if not content_texts and not has_non_text:
            status = "empty"
        elif (
            not has_non_text
            and all(t.strip().lower() == NOTHING_TO_REPORT_TEXT.lower() for t in content_texts)
        ):
            status = "nothing_to_report"
        else:
            status = "filled"

        sections.append(
            {
                "date": dt,
                "date_iso": dt.isoformat(),
                "heading": heading_txt,
                "start_idx": start_idx,
                "end_idx": end_idx,
                "content_indices": content_indices,
                "content_texts": content_texts,
                "has_non_text": has_non_text,
                "status": status,
            }
        )
    return sections


def _agrupar_estado_por_fecha(sections: list[dict]) -> dict[date, str]:
    priority = {"empty": 0, "nothing_to_report": 1, "filled": 2}
    by_date: dict[date, str] = {}
    for sec in sections:
        dt = sec["date"]
        cur = by_date.get(dt)
        if cur is None or priority[sec["status"]] > priority[cur]:
            by_date[dt] = sec["status"]
    return by_date


def _calcular_dias_faltantes_journal(
    sections: list[dict],
    through_date: date,
    fill_if_empty_doc: bool = False,
    max_days: int = 550,
) -> list[date]:
    if not sections:
        return [through_date] if fill_if_empty_doc else []

    by_date = _agrupar_estado_por_fecha(sections)
    first_date = min(by_date.keys())
    if first_date > through_date:
        return []

    window_start = through_date - timedelta(days=max(1, int(max_days)) - 1)
    scan_start = max(first_date, window_start)
    missing: list[date] = []
    cur = scan_start
    while cur <= through_date:
        status = by_date.get(cur)
        if status is None or status == "empty":
            missing.append(cur)
        cur += timedelta(days=1)
    return missing


def _construir_parrafos_texto_journal(estilo_ids: dict, texto_limpio: str) -> list[ET.Element]:
    out: list[ET.Element] = []
    for line in texto_limpio.split("\n"):
        clean_line = line.rstrip()
        if not clean_line.strip():
            out.append(_w_el("p"))
        else:
            out.append(
                _crear_parrafo_texto(
                    style_id=estilo_ids["normal"],
                    text=clean_line,
                    font_size=11,
                    bold_all=False,
                )
            )
    return out


def _insertar_o_actualizar_dia_en_body(
    body: ET.Element,
    estilo_ids: dict,
    target_date: date,
    text: str,
) -> dict:
    texto_limpio = str(text or "").replace("\r", "").strip()
    if not texto_limpio:
        raise ValueError("Journal text cannot be empty.")

    is_ntr = texto_limpio.lower() == NOTHING_TO_REPORT_TEXT.lower()
    if is_ntr:
        texto_limpio = NOTHING_TO_REPORT_TEXT

    encabezado = calcular_encabezado(target_date)
    sections = _extraer_secciones_journal(body)
    matching = [sec for sec in sections if sec["date"] == target_date]
    entry_elems = _construir_parrafos_texto_journal(estilo_ids, texto_limpio)

    if matching:
        sec = matching[-1]
        if is_ntr:
            if sec["status"] in ("filled", "nothing_to_report"):
                return {
                    "heading": sec["heading"] or encabezado,
                    "skipped": True,
                    "replacedPlaceholder": False,
                }
            insert_at = sec["start_idx"] + 1
            for offset, el in enumerate(entry_elems):
                body.insert(insert_at + offset, el)
            return {
                "heading": sec["heading"] or encabezado,
                "skipped": False,
                "replacedPlaceholder": False,
            }

        if sec["status"] == "nothing_to_report" and sec["content_indices"]:
            first_idx = sec["content_indices"][0]
            children = list(body)
            for idx_rem in reversed(sec["content_indices"]):
                body.remove(children[idx_rem])
            for offset, el in enumerate(entry_elems):
                body.insert(first_idx + offset, el)
            return {
                "heading": sec["heading"] or encabezado,
                "skipped": False,
                "replacedPlaceholder": True,
            }

        if sec["status"] == "empty":
            insert_at = sec["start_idx"] + 1
            for offset, el in enumerate(entry_elems):
                body.insert(insert_at + offset, el)
            return {
                "heading": sec["heading"] or encabezado,
                "skipped": False,
                "replacedPlaceholder": False,
            }

        children = list(body)
        insert_at = sec["end_idx"]
        while insert_at > sec["start_idx"] + 1 and _es_parrafo_vacio_journal(children[insert_at - 1]):
            insert_at -= 1
        to_insert: list[ET.Element] = []
        if insert_at > sec["start_idx"] + 1 and not _es_parrafo_vacio_journal(children[insert_at - 1]):
            to_insert.append(_w_el("p"))
        to_insert.extend(entry_elems)
        for offset, el in enumerate(to_insert):
            body.insert(insert_at + offset, el)
        return {
            "heading": sec["heading"] or encabezado,
            "skipped": False,
            "replacedPlaceholder": False,
        }

    later_sec = next((sec for sec in sections if sec["date"] > target_date), None)
    children = list(body)
    heading_el = _crear_parrafo_texto(
        style_id=estilo_ids["heading_1"],
        text=encabezado,
        font_size=16,
        bold_all=True,
        color="000000",
    )

    if later_sec is not None:
        insert_at = later_sec["start_idx"]
        while insert_at > 0 and _es_parrafo_vacio_journal(children[insert_at - 1]):
            insert_at -= 1
        has_content_before = any(
            not _es_parrafo_vacio_journal(children[i]) for i in range(insert_at)
        )
        new_elems: list[ET.Element] = []
        if has_content_before:
            new_elems.append(_w_el("p"))
        new_elems.append(heading_el)
        new_elems.extend(entry_elems)
        if insert_at == later_sec["start_idx"]:
            new_elems.append(_w_el("p"))
    else:
        insert_at = _indice_sectpr(body)
        has_content_before = any(
            not _es_parrafo_vacio_journal(children[i]) for i in range(insert_at)
        )
        prev_is_blank = insert_at > 0 and _es_parrafo_vacio_journal(children[insert_at - 1])
        new_elems = []
        if has_content_before and not prev_is_blank:
            new_elems.append(_w_el("p"))
        new_elems.append(heading_el)
        new_elems.extend(entry_elems)

    for offset, el in enumerate(new_elems):
        body.insert(insert_at + offset, el)
    return {
        "heading": encabezado,
        "skipped": False,
        "replacedPlaceholder": False,
    }


def _construir_resumen_cobertura(
    sections: list[dict],
    today_dt: date,
    recent_window: int = 14,
) -> dict:
    by_date = _agrupar_estado_por_fecha(sections)
    yesterday_dt = today_dt - timedelta(days=1)
    missing_past = _calcular_dias_faltantes_journal(
        sections, yesterday_dt, fill_if_empty_doc=False
    )

    first_date = min(by_date.keys()) if by_date else None
    last_date = max(by_date.keys()) if by_date else None
    filled_count = sum(1 for st in by_date.values() if st == "filled")
    ntr_count = sum(1 for st in by_date.values() if st == "nothing_to_report")
    empty_count = sum(1 for st in by_date.values() if st == "empty")

    win = max(1, min(30, int(recent_window)))
    if first_date is not None:
        strip_start = max(first_date, today_dt - timedelta(days=win - 1))
        if strip_start > today_dt:
            strip_start = today_dt
    else:
        strip_start = today_dt

    recent_days = []
    cur = strip_start
    while cur <= today_dt:
        st = by_date.get(cur, "missing")
        recent_days.append(
            {
                "dateIso": cur.isoformat(),
                "heading": calcular_encabezado(cur),
                "status": st,
                "isToday": cur == today_dt,
            }
        )
        cur += timedelta(days=1)

    return {
        "todayIso": today_dt.isoformat(),
        "todayHeading": calcular_encabezado(today_dt),
        "todayStatus": by_date.get(today_dt, "missing"),
        "yesterdayIso": yesterday_dt.isoformat(),
        "yesterdayHeading": calcular_encabezado(yesterday_dt),
        "yesterdayStatus": by_date.get(yesterday_dt, "missing"),
        "firstDateIso": first_date.isoformat() if first_date else None,
        "lastDateIso": last_date.isoformat() if last_date else None,
        "totalDaysRecorded": len(by_date),
        "filledCount": filled_count,
        "nothingToReportCount": ntr_count,
        "emptyHeadingCount": empty_count,
        "missingPastDates": [d.isoformat() for d in missing_past],
        "missingPastHeadings": [calcular_encabezado(d) for d in missing_past],
        "allPastDaysFilled": len(missing_past) == 0,
        "recentDays": recent_days,
    }


def inspect_journal_docx_bytes(
    plain_bytes: bytes,
    today_date=None,
    recent_window: int = 14,
) -> dict:
    today_dt = _parse_iso_date(today_date)
    with zipfile.ZipFile(io.BytesIO(plain_bytes), "r") as zin:
        orig_doc_bytes = zin.read("word/document.xml")
    doc_root = ET.fromstring(orig_doc_bytes)
    body = doc_root.find(_w_tag("body"))
    if body is None:
        raise ValueError("word/document.xml sin elemento w:body")
    sections = _extraer_secciones_journal(body)
    return _construir_resumen_cobertura(sections, today_dt, recent_window=recent_window)


def verify_and_backfill_journal_docx_bytes(
    plain_bytes: bytes,
    today_date=None,
    through_date=None,
    fill_if_empty_doc: bool = False,
    max_days: int = 550,
) -> tuple[bytes, dict]:
    today_dt = _parse_iso_date(today_date)
    through_dt = _parse_iso_date(through_date) if through_date is not None else (today_dt - timedelta(days=1))

    with zipfile.ZipFile(io.BytesIO(plain_bytes), "r") as zin:
        estilos = _ooxml_cargar_estilos_mapa(zin)
        orig_doc_bytes = zin.read("word/document.xml")

    estilo_ids = estilos["ids"]
    doc_root = ET.fromstring(orig_doc_bytes)
    body = doc_root.find(_w_tag("body"))
    if body is None:
        raise ValueError("word/document.xml sin elemento w:body")

    sections = _extraer_secciones_journal(body)
    missing_dates = _calcular_dias_faltantes_journal(
        sections,
        through_dt,
        fill_if_empty_doc=fill_if_empty_doc,
        max_days=max_days,
    )

    filled_dates: list[str] = []
    filled_headings: list[str] = []
    for dt in missing_dates:
        res = _insertar_o_actualizar_dia_en_body(body, estilo_ids, dt, NOTHING_TO_REPORT_TEXT)
        if not res["skipped"]:
            filled_dates.append(dt.isoformat())
            filled_headings.append(res["heading"])

    if not filled_dates:
        coverage = _construir_resumen_cobertura(sections, today_dt)
        return plain_bytes, {
            "modified": False,
            "filledDates": [],
            "filledHeadings": [],
            "coverage": coverage,
        }

    new_doc_bytes = _serializar_documento(doc_root, orig_doc_bytes)
    out_buf = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(plain_bytes), "r") as zin, zipfile.ZipFile(
        out_buf, "w", compression=zipfile.ZIP_DEFLATED
    ) as zout:
        for info in zin.infolist():
            payload = new_doc_bytes if info.filename == "word/document.xml" else zin.read(info.filename)
            zout.writestr(info, payload)

    updated_sections = _extraer_secciones_journal(body)
    coverage = _construir_resumen_cobertura(updated_sections, today_dt)
    return out_buf.getvalue(), {
        "modified": True,
        "filledDates": filled_dates,
        "filledHeadings": filled_headings,
        "coverage": coverage,
    }


def _append_journal_entry_to_docx_bytes(
    plain_bytes: bytes,
    text: str,
    target_date=None,
    backfill_missing_before: bool = True,
) -> tuple[bytes, dict]:
    texto_limpio = str(text or "").replace("\r", "").strip()
    if not texto_limpio:
        raise ValueError("Journal text cannot be empty.")

    target_dt = _parse_iso_date(target_date)
    with zipfile.ZipFile(io.BytesIO(plain_bytes), "r") as zin:
        estilos = _ooxml_cargar_estilos_mapa(zin)
        orig_doc_bytes = zin.read("word/document.xml")

    estilo_ids = estilos["ids"]
    doc_root = ET.fromstring(orig_doc_bytes)
    body = doc_root.find(_w_tag("body"))
    if body is None:
        raise ValueError("word/document.xml sin elemento w:body")

    backfilled_dates: list[str] = []
    backfilled_headings: list[str] = []
    if backfill_missing_before:
        sections_before = _extraer_secciones_journal(body)
        prev_day = target_dt - timedelta(days=1)
        missing_prior = _calcular_dias_faltantes_journal(
            sections_before,
            prev_day,
            fill_if_empty_doc=False,
        )
        for dt in missing_prior:
            bf_res = _insertar_o_actualizar_dia_en_body(
                body, estilo_ids, dt, NOTHING_TO_REPORT_TEXT
            )
            if not bf_res["skipped"]:
                backfilled_dates.append(dt.isoformat())
                backfilled_headings.append(bf_res["heading"])

    main_res = _insertar_o_actualizar_dia_en_body(body, estilo_ids, target_dt, texto_limpio)
    if main_res["skipped"] and not backfilled_dates:
        return plain_bytes, {
            "heading": main_res["heading"],
            "skipped": True,
            "replacedPlaceholder": False,
            "backfilledDates": [],
            "backfilledHeadings": [],
        }

    new_doc_bytes = _serializar_documento(doc_root, orig_doc_bytes)
    out_buf = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(plain_bytes), "r") as zin, zipfile.ZipFile(
        out_buf, "w", compression=zipfile.ZIP_DEFLATED
    ) as zout:
        for info in zin.infolist():
            payload = new_doc_bytes if info.filename == "word/document.xml" else zin.read(info.filename)
            zout.writestr(info, payload)
    return out_buf.getvalue(), {
        "heading": main_res["heading"],
        "skipped": bool(main_res["skipped"]),
        "replacedPlaceholder": bool(main_res["replacedPlaceholder"]),
        "backfilledDates": backfilled_dates,
        "backfilledHeadings": backfilled_headings,
    }


def _read_encrypted_journal_bytes(target: str, password: str) -> dict:
    try:
        import msoffcrypto
    except ImportError as imp_err:
        return {
            "ok": False,
            "reason": "MSOFFCRYPTO_MISSING",
            "error": f"msoffcrypto-tool not installed: {imp_err}",
        }

    existed = os.path.exists(target) and os.path.getsize(target) > 0
    if not existed:
        return {
            "ok": True,
            "existed": False,
            "was_encrypted": False,
            "raw_bytes": None,
            "plain_bytes": None,
        }

    with open(target, "rb") as fh:
        raw_bytes = fh.read()
    office = msoffcrypto.OfficeFile(io.BytesIO(raw_bytes))
    if office.is_encrypted():
        try:
            office.load_key(password=password, verify_password=True)
        except Exception as pwd_err:
            return {
                "ok": False,
                "reason": "WRONG_PASSWORD",
                "error": f"WORD_PASSWORD rejected by existing Diario.docx: {pwd_err}",
            }
        plain_io = io.BytesIO()
        office.decrypt(plain_io)
        return {
            "ok": True,
            "existed": True,
            "was_encrypted": True,
            "raw_bytes": raw_bytes,
            "plain_bytes": plain_io.getvalue(),
        }

    return {
        "ok": True,
        "existed": True,
        "was_encrypted": False,
        "raw_bytes": raw_bytes,
        "plain_bytes": raw_bytes,
    }


def _encrypt_and_atomic_write_journal(
    target: str,
    password: str,
    updated_plain_bytes: bytes,
    raw_bytes: bytes | None,
    existed: bool,
) -> dict:
    try:
        import msoffcrypto
        from msoffcrypto.format.ooxml import OOXMLFile
    except ImportError as imp_err:
        return {
            "ok": False,
            "reason": "MSOFFCRYPTO_MISSING",
            "error": f"msoffcrypto-tool not installed: {imp_err}",
        }

    parent = os.path.dirname(target)
    if parent:
        os.makedirs(parent, exist_ok=True)
        try:
            os.chmod(parent, 0o700)
        except OSError:
            pass

    enc_io = io.BytesIO()
    OOXMLFile(io.BytesIO(updated_plain_bytes)).encrypt(password, enc_io)
    encrypted_bytes = enc_io.getvalue()

    # Mandatory round-trip decrypt + ZIP XML verification before overwriting disk
    enc_io.seek(0)
    verify_office = msoffcrypto.OfficeFile(enc_io)
    if not verify_office.is_encrypted():
        return {
            "ok": False,
            "reason": "ENCRYPT_VERIFY_FAILED",
            "error": "Output Diario.docx did not report as encrypted.",
        }
    verify_office.load_key(password=password, verify_password=True)
    verify_plain = io.BytesIO()
    verify_office.decrypt(verify_plain)
    verify_plain.seek(0)
    with zipfile.ZipFile(verify_plain, "r") as zchk:
        doc_xml = zchk.read("word/document.xml")
        ET.fromstring(doc_xml)

    if existed and raw_bytes is not None:
        bak_path = f"{target}.bak"
        tmp_bak = f"{bak_path}.tmp.{os.getpid()}"
        fd_bak = os.open(tmp_bak, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(fd_bak, "wb") as fb:
                fb.write(raw_bytes)
                fb.flush()
                os.fsync(fb.fileno())
            os.replace(tmp_bak, bak_path)
            os.chmod(bak_path, 0o600)
        except Exception:
            if os.path.exists(tmp_bak):
                os.remove(tmp_bak)

    tmp_target = f"{target}.tmp.{os.getpid()}"
    fd = os.open(tmp_target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "wb") as fout:
            fout.write(encrypted_bytes)
            fout.flush()
            os.fsync(fout.fileno())
        os.replace(tmp_target, target)
        os.chmod(target, 0o600)
    finally:
        if os.path.exists(tmp_target):
            try:
                os.remove(tmp_target)
            except OSError:
                pass

    return {"ok": True, "bytes": len(encrypted_bytes)}


def write_encrypted_journal_docx(
    docx_path: str,
    password: str,
    text: str,
    target_date=None,
    backfill_missing_before: bool = True,
) -> dict:
    if not password:
        return {
            "ok": False,
            "reason": "PASSWORD_MISSING",
            "error": "WORD_PASSWORD is required for local encrypted Journal.",
        }

    target = os.path.abspath(docx_path)
    read_res = _read_encrypted_journal_bytes(target, password)
    if not read_res.get("ok"):
        return read_res

    existed = read_res["existed"]
    was_encrypted = read_res["was_encrypted"]
    raw_bytes = read_res["raw_bytes"]
    plain_bytes = read_res["plain_bytes"] or _build_minimal_docx_bytes(mode="journal")

    target_dt = _parse_iso_date(target_date)
    updated_plain_bytes, meta = _append_journal_entry_to_docx_bytes(
        plain_bytes,
        text,
        target_date=target_dt,
        backfill_missing_before=backfill_missing_before,
    )
    coverage = inspect_journal_docx_bytes(updated_plain_bytes, today_date=target_dt)

    if meta.get("skipped") and not meta.get("backfilledDates") and existed and was_encrypted:
        return {
            "ok": True,
            "skipped": True,
            "replacedPlaceholder": False,
            "backfilledDates": [],
            "backfilledHeadings": [],
            "encrypted": True,
            "heading": meta["heading"],
            "coverage": coverage,
            "path": target,
        }

    write_res = _encrypt_and_atomic_write_journal(
        target, password, updated_plain_bytes, raw_bytes, existed
    )
    if not write_res.get("ok"):
        return write_res

    return {
        "ok": True,
        "skipped": bool(meta.get("skipped")),
        "replacedPlaceholder": bool(meta.get("replacedPlaceholder")),
        "backfilledDates": meta.get("backfilledDates") or [],
        "backfilledHeadings": meta.get("backfilledHeadings") or [],
        "encrypted": True,
        "heading": meta["heading"],
        "bytes": write_res["bytes"],
        "coverage": coverage,
        "path": target,
    }


def inspect_encrypted_journal_docx(
    docx_path: str,
    password: str,
    today_date=None,
) -> dict:
    if not password:
        return {
            "ok": False,
            "reason": "PASSWORD_MISSING",
            "error": "WORD_PASSWORD is required to inspect local encrypted Journal.",
        }

    target = os.path.abspath(docx_path)
    read_res = _read_encrypted_journal_bytes(target, password)
    if not read_res.get("ok"):
        return read_res

    today_dt = _parse_iso_date(today_date)
    if not read_res["existed"]:
        return {
            "ok": True,
            "exists": False,
            "encrypted": False,
            "path": target,
            "coverage": _construir_resumen_cobertura([], today_dt),
        }

    coverage = inspect_journal_docx_bytes(read_res["plain_bytes"], today_date=today_dt)
    return {
        "ok": True,
        "exists": True,
        "encrypted": bool(read_res["was_encrypted"]),
        "path": target,
        "coverage": coverage,
    }


def verify_encrypted_journal_docx(
    docx_path: str,
    password: str,
    today_date=None,
    through_date=None,
    create_if_missing: bool = False,
    fill_if_empty_doc: bool = False,
) -> dict:
    if not password:
        return {
            "ok": False,
            "reason": "PASSWORD_MISSING",
            "error": "WORD_PASSWORD is required to verify local encrypted Journal.",
        }

    target = os.path.abspath(docx_path)
    read_res = _read_encrypted_journal_bytes(target, password)
    if not read_res.get("ok"):
        return read_res

    today_dt = _parse_iso_date(today_date)
    existed = read_res["existed"]
    if not existed and not create_if_missing:
        return {
            "ok": True,
            "exists": False,
            "encrypted": False,
            "modified": False,
            "filledDates": [],
            "filledHeadings": [],
            "path": target,
            "coverage": _construir_resumen_cobertura([], today_dt),
        }

    plain_bytes = read_res["plain_bytes"] or _build_minimal_docx_bytes(mode="journal")
    updated_plain_bytes, meta = verify_and_backfill_journal_docx_bytes(
        plain_bytes,
        today_date=today_dt,
        through_date=through_date,
        fill_if_empty_doc=fill_if_empty_doc,
    )

    if not meta["modified"] and existed and read_res["was_encrypted"]:
        return {
            "ok": True,
            "exists": True,
            "encrypted": True,
            "modified": False,
            "filledDates": [],
            "filledHeadings": [],
            "path": target,
            "coverage": meta["coverage"],
        }

    if not meta["modified"] and not existed:
        return {
            "ok": True,
            "exists": False,
            "encrypted": False,
            "modified": False,
            "filledDates": [],
            "filledHeadings": [],
            "path": target,
            "coverage": meta["coverage"],
        }

    write_res = _encrypt_and_atomic_write_journal(
        target, password, updated_plain_bytes, read_res["raw_bytes"], existed
    )
    if not write_res.get("ok"):
        return write_res

    return {
        "ok": True,
        "exists": True,
        "encrypted": True,
        "modified": bool(meta["modified"]),
        "filledDates": meta["filledDates"],
        "filledHeadings": meta["filledHeadings"],
        "bytes": write_res["bytes"],
        "path": target,
        "coverage": meta["coverage"],
    }


def _reemplazo_atomico_archivo(target_path: str, payload: bytes) -> None:
    parent = os.path.dirname(target_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    tmp_out = f"{target_path}.tmp.{os.getpid()}"
    try:
        with open(tmp_out, "wb") as fout:
            fout.write(payload)
            fout.flush()
            try:
                os.fsync(fout.fileno())
            except OSError:
                pass
        os.replace(tmp_out, target_path)
    except Exception:
        if os.path.exists(tmp_out):
            try:
                os.unlink(tmp_out)
            except OSError:
                pass
        raise


def main() -> int:
    if hasattr(sys.stdin, "reconfigure"):
        try:
            sys.stdin.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    mode = ""
    cli_docx_path = ""
    cli_no_backup = False
    args = sys.argv[1:]
    for i, a in enumerate(args):
        if a == "--mode" and i + 1 < len(args):
            mode = args[i + 1].strip().lower()
        elif a == "--docx-path" and i + 1 < len(args):
            cli_docx_path = args[i + 1].strip()
        elif a == "--no-backup":
            cli_no_backup = True
    if mode not in ("english", "repair-english", "english-repair", "journal", "journal-inspect", "journal-verify"):
        print(
            json.dumps(
                {
                    "ok": False,
                    "reason": "INVALID_MODE",
                    "error": "Use --mode english|repair-english|journal|journal-inspect|journal-verify",
                }
            )
        )
        return 2

    try:
        if cli_docx_path and sys.stdin.isatty():
            payload = {}
        else:
            raw_stdin = sys.stdin.buffer.read().decode("utf-8") if hasattr(sys.stdin, "buffer") else sys.stdin.read()
            payload = json.loads(raw_stdin or "{}")
        if cli_docx_path and not payload.get("docxPath"):
            payload["docxPath"] = cli_docx_path
        if cli_no_backup:
            payload["backup"] = False
    except Exception as exc:
        print(json.dumps({"ok": False, "reason": "INVALID_JSON", "error": str(exc)}))
        return 1

    try:
        if mode == "english":
            docx_path = os.path.abspath(str(payload.get("docxPath") or ""))
            if not docx_path:
                raise ValueError("Missing docxPath")
            orig = None
            if os.path.exists(docx_path) and os.path.getsize(docx_path) > 0:
                with open(docx_path, "rb") as fh:
                    orig = fh.read()
            try:
                new_bytes, meta = update_english_docx_bytes(orig, payload.get("entry"))
            except (zipfile.BadZipFile, ET.ParseError) as corrupt_exc:
                print(json.dumps({"ok": False, "reason": "CORRUPT_DOCX", "error": str(corrupt_exc)}, ensure_ascii=True))
                return 1
            _reemplazo_atomico_archivo(docx_path, new_bytes)
            print(json.dumps({"ok": True, "bytes": len(new_bytes), **meta}, ensure_ascii=True))
            return 0

        if mode in ("repair-english", "english-repair"):
            docx_path = os.path.abspath(str(payload.get("docxPath") or ""))
            if not docx_path:
                raise ValueError("Missing docxPath")
            if not os.path.exists(docx_path) or os.path.getsize(docx_path) == 0:
                raise FileNotFoundError(f"Missing or empty docxPath: {docx_path}")
            with open(docx_path, "rb") as fh:
                orig = fh.read()
            try:
                new_bytes, stats = repair_english_docx_bytes(orig)
            except (zipfile.BadZipFile, ET.ParseError) as corrupt_exc:
                print(json.dumps({"ok": False, "reason": "CORRUPT_DOCX", "error": str(corrupt_exc)}, ensure_ascii=True))
                return 1
            bak_path = ""
            if payload.get("backup", True):
                bak_path = f"{docx_path}.bak"
                _reemplazo_atomico_archivo(bak_path, orig)
            _reemplazo_atomico_archivo(docx_path, new_bytes)
            print(json.dumps({"bytes": len(new_bytes), "backupPath": bak_path, **stats}, ensure_ascii=True))
            return 0

        if mode == "journal-inspect":
            res = inspect_encrypted_journal_docx(
                docx_path=str(payload.get("docxPath") or ""),
                password=str(payload.get("password") or ""),
                today_date=payload.get("todayIso") or None,
            )
            print(json.dumps(res, ensure_ascii=True))
            return 0 if res.get("ok") else 1

        if mode == "journal-verify":
            res = verify_encrypted_journal_docx(
                docx_path=str(payload.get("docxPath") or ""),
                password=str(payload.get("password") or ""),
                today_date=payload.get("todayIso") or None,
                through_date=payload.get("throughDateIso") or None,
                create_if_missing=bool(payload.get("createIfMissing", False)),
                fill_if_empty_doc=bool(payload.get("fillIfEmptyDoc", False)),
            )
            print(json.dumps(res, ensure_ascii=True))
            return 0 if res.get("ok") else 1

        res = write_encrypted_journal_docx(
            docx_path=str(payload.get("docxPath") or ""),
            password=str(payload.get("password") or ""),
            text=str(payload.get("text") or ""),
            target_date=payload.get("targetDateIso") or None,
            backfill_missing_before=bool(payload.get("backfillMissingBefore", True)),
        )
        print(json.dumps(res, ensure_ascii=True))
        return 0 if res.get("ok") else 1
    except Exception as exc:
        print(json.dumps({"ok": False, "reason": "RUNTIME_ERROR", "error": str(exc)}, ensure_ascii=True))
        return 1


if __name__ == "__main__":
    sys.exit(main())

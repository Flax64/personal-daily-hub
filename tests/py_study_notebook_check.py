# -*- coding: utf-8 -*-
"""Prueba E2E (sin Word ni red): dedup OOXML, sección Notas manuales y visor de solo lectura."""

import io
import json
import os
import sys
import tempfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "sincronitation"))
import sincronizador as s  # noqa: E402

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
STYLES = (
    f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="{W}">'
    + "".join(
        f'<w:style w:type="paragraph" w:styleId="Heading{i}"><w:name w:val="heading {i}"/></w:style>'
        for i in (1, 2, 3)
    )
    + "</w:styles>"
)
DOC = (
    f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="{W}"><w:body>'
    f"<w:sectPr/></w:body></w:document>"
)


def make_docx(path):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
        )
        z.writestr("word/document.xml", DOC)
        z.writestr("word/styles.xml", STYLES)


def main():
    tmp = tempfile.mkdtemp()
    docx = os.path.join(tmp, "English_Learning_Notebook.docx")
    make_docx(docx)
    s.sincronizar_word_estudio_a_drive = lambda *a, **k: True  # sin red

    vocab = {
        "category": "vocabulary",
        "language": "English",
        "word": "drip",
        "part_of_speech": "noun",
        "spanish": "goteo",
    }
    note = s.parsear_entrada_ingles(
        json.dumps(
            {
                "category": "notes",
                "title": "Regla",
                "notes": "Present perfect = have + participio",
            }
        )
    )
    note2 = s.parsear_entrada_ingles(
        json.dumps(
            {"category": "notes", "title": "Regla", "notes": "Otra regla distinta"}
        )
    )
    song = {
        "category": "music",
        "language": "English + Korean",
        "song_title": "Drip",
        "artists_display": "BABYMONSTER",
        "album_title": "Drip",
        "album_type": "Album",
        "release_year": "2024",
        "track_number": 1,
        "lyrics_study": "[EN]\nBaby got that drip\n\n[KO]\n안녕하세요",
    }
    song_es = dict(
        song, lyrics_study="=== [ES — Traducción IA] ===\nBebé tiene ese estilo"
    )
    song_en_only = dict(song, lyrics_study="[EN]\nBaby got that drip")

    for e in (vocab, vocab, note, note, note2, song, song_es, song_en_only, song_es):
        assert s._guardar_entrada_ingles_en_docx_xml(docx, e) is True

    res = s.leer_cuaderno_estudio_word({}, ruta_docx=docx)
    assert res["ok"], res
    assert res["counts"]["vocabulary"] == 1, res["counts"]  # sin duplicar vocab
    assert res["counts"]["notes"] == 2, res[
        "counts"
    ]  # misma nota omitida; distinta contenido sí
    assert res["counts"]["music"] == 1, res["counts"]  # una sola pista
    track = next(e for e in res["entries"] if e["section"] == "music")
    lyr = track["fields"]["lyrics_study"]
    assert (
        "English" in lyr
        and "Korean" in lyr
        and "Spanish" in lyr
        and "[EN]" not in lyr
        and "[KO]" not in lyr
        and "[ES]" not in lyr
        and "안녕하세요" in lyr
        and "Bebé tiene ese estilo" in lyr
    ), lyr
    assert lyr.count("Traducción IA") == 1, lyr
    assert (lyr.startswith("Korean\n") or "\n\nKorean\n" in lyr) and "\n\nEnglish\n" in lyr and "\n\nSpanish" in lyr, repr(lyr)
    with zipfile.ZipFile(docx, "r") as zchk:
        doc_xml = zchk.read("word/document.xml").decode("utf-8", errors="replace")
        assert 'w:ind w:left="480"' in doc_xml, "Verses must be indented under language headers"
        assert "BATTER UP" not in doc_xml and "Drip" in doc_xml and "_Toc" in doc_xml

    filt = s.leer_cuaderno_estudio_word(
        {"section": "music", "artist": "babymonster"}, ruta_docx=docx
    )
    assert filt["total"] == 1 and "BABYMONSTER" in " ".join(
        filt["facets"]["artists"]
    ), filt
    none = s.leer_cuaderno_estudio_word({"q": "inexistente"}, ruta_docx=docx)
    assert none["total"] == 0
    check_drive_pull(tmp, docx)
    print("OK")


def check_drive_pull(tmp, docx):
    """Drive -> PC: pulled / noop / conflict / deferred, sin red ni rclone."""
    import base64
    import hashlib

    s._ENGLISH_WORD_DRIVE_STATE_PATH = os.path.join(tmp, "state.json")
    s.resolver_rutas_word = lambda *a, **k: (None, docx)
    s.obtener_url_aws = lambda ep="": "http://x" + ep
    s._firmar_pc_request = lambda *a, **k: {}
    remote = {"bytes": b"", "mod": "t1"}

    class Resp:
        def __init__(self, payload):
            self.status_code, self._p = 200, payload

        def json(self):
            return self._p

    class Sess:
        def get(self, url, **kw):
            meta = {
                "ok": True,
                "exists": True,
                "remoteTarget": "r:x",
                "remoteSize": len(remote["bytes"]),
                "remoteModTime": remote["mod"],
            }
            if "download=1" in url:
                meta["docxB64"] = base64.b64encode(remote["bytes"]).decode()
            return Resp(meta)

    s._get_http_session = lambda: Sess()
    sha = lambda b: hashlib.sha256(b).hexdigest()
    local = open(docx, "rb").read()

    # 1) Local sin cambios desde la última sync + Drive nuevo => pulled
    s._guardar_ultimo_hash_word_drive(sha(local), "r:x", len(local), True, "t0")
    remote["bytes"] = local + b"\x00" * 10  # contenido distinto (ZIP con relleno)
    assert s._sincronizar_word_desde_drive(force=True) == "pulled"
    assert open(docx, "rb").read() == remote["bytes"]
    # 2) Segunda consulta con mismo remoto => noop
    assert s._sincronizar_word_desde_drive(force=True) == "noop"
    # 3) Ambos cambiaron => conflict, el local se conserva
    mine = open(docx, "rb").read() + b"\x01" * 5
    open(docx, "wb").write(mine)
    remote["bytes"], remote["mod"] = mine + b"\x02" * 7, "t2"
    assert s._sincronizar_word_desde_drive(force=True) == "conflict"
    assert open(docx, "rb").read() == mine
    assert any("drive-conflict" in f for f in os.listdir(tmp))
    # 4) Word abierto (~$) => deferred sin tocar el local
    s._guardar_ultimo_hash_word_drive(sha(mine), "r:x", 1, True, "t2")
    remote["bytes"], remote["mod"] = b"PK" + b"\x03" * 80, "t3"
    lock = os.path.join(tmp, "~$glish_Learning_Notebook.docx")
    open(lock, "w").close()
    assert s._sincronizar_word_desde_drive(force=True) == "deferred"
    assert open(docx, "rb").read() == mine
    os.remove(lock)
    print("DRIVE OK")

    # 5) Limpieza de ruido, etiquetas no-idioma ([Intro]/[Rap]), deduplicación ES y consolidación
    limpia = s._limpiar_ruido_letra(
        "[음악]\n[Intro]\n[Rap]\nHello world\n[\n[歌]\n[音楽]"
    )
    assert (
        "[음악]" not in limpia and "[音楽]" not in limpia and "[歌]" not in limpia
    ), limpia
    assert "[Intro]" in limpia and "[Rap]" in limpia and "Hello world" in limpia, limpia

    comb = s._combinar_letra_por_idiomas(
        "[Intro]\nLine A\n[Rap]\nLine B",
        "=== [ES — Traducción IA] ===\nLínea A\nLínea B",
    )
    assert (
        "[Intro]" in comb
        and "Line A" in comb
        and "Spanish — Traducción IA" in comb
        and "[ES" not in comb
    ), comb

    clean_notes = s._limpiar_notas_redundantes_cancion(
        "Vocab note line\n\n[Traducción ES — Gemini IA]\nLínea A\nLínea B",
        comb,
    )
    assert clean_notes == "Vocab note line", clean_notes

    open(docx, "wb").write(local)
    res_consolidar = s.consolidar_y_deduplicar_cuaderno_word(docx)
    assert res_consolidar.get("ok") is True, res_consolidar
    res_read = s.leer_cuaderno_estudio_word(
        {"section": "music", "limit": 50}, ruta_docx=docx
    )
    assert res_read.get("ok") is True and "songs" in res_read.get(
        "facets", {}
    ), res_read

    five = s._extraer_cinco_apartados_desde_letra(
        "[ORIGINAL]\nBaby got no chill\n눈을 감고 느껴봐\n\n[KO]\nBaby got no chill\n눈을 감고 느껴봐\n\n[EN]\nClose your eyes\n\n[JA]\n目を閉じて感じて\n\n[ES]\nCierra los ojos"
    )
    assert (
        "Baby got no chill" in five["original"]
        and "눈을 감고 느껴봐" in five["original"]
    ), five
    assert five["ko"] == "눈을 감고 느껴봐", five
    assert (
        five["en"] == "Close your eyes"
        and five["ja"] == "目を閉じて感じて"
        and five["es"] == "Cierra los ojos"
    ), five

    # 6) Saltos de página solo en títulos principales (H1, H2/H3 2+ en Música) y continuidad en subtítulos
    import xml.etree.ElementTree as ET
    import yt_lyrics_helper as ylh

    song_album1_t2 = {
        "category": "music",
        "language": "English + Japanese (J-Pop)",
        "song_title": "Midnight Star",
        "artists_display": "YOASOBI",
        "album_title": "Drip",
        "album_type": "Album",
        "release_year": "2024",
        "track_number": 2,
        "lyrics_study": "[ORIGINAL]\nShining bright\n夜空を見上げて\n\n[JA]\nShining bright\n夜空を見上げて",
    }
    song_album2_t1 = {
        "category": "music",
        "language": "Japanese",
        "song_title": "Idol",
        "artists_display": "YOASOBI",
        "album_title": "The Book 3",
        "album_type": "EP",
        "release_year": "2023",
        "track_number": 1,
        "lyrics_study": "[JA]\n誰かの心臓になれたなら",
    }
    assert s._guardar_entrada_ingles_en_docx_xml(docx, song_album1_t2) is True
    assert s._guardar_entrada_ingles_en_docx_xml(docx, song_album2_t1) is True

    # Simular un salto manual <w:br w:type="page"/> en un párrafo normal para validar que --consolidar-word lo limpia
    with zipfile.ZipFile(docx, "r") as zf_in:
        doc_bytes_mod = (
            zf_in.read("word/document.xml")
            .decode("utf-8")
            .replace(
                "<w:t>Present perfect = have + participio</w:t>",
                '<w:br w:type="page"/><w:t>Present perfect = have + participio</w:t>',
                1,
            )
            .encode("utf-8")
        )
        other_entries = {
            inf.filename: zf_in.read(inf.filename)
            for inf in zf_in.infolist()
            if inf.filename != "word/document.xml"
        }
    with zipfile.ZipFile(docx, "w") as zf_out:
        zf_out.writestr("word/document.xml", doc_bytes_mod)
        for fname, data in other_entries.items():
            zf_out.writestr(fname, data)

    res_pb = s.consolidar_y_deduplicar_cuaderno_word(docx)
    assert res_pb.get("ok") is True, res_pb

    with zipfile.ZipFile(docx, "r") as zf_chk:
        st_chk = s._ooxml_cargar_estilos_mapa(zf_chk)
        root_chk = ET.fromstring(zf_chk.read("word/document.xml"))
    body_chk = root_chk.find(s._ooxml_w_tag("body"))
    pb_tag, val_attr, br_tag, type_attr = (
        s._ooxml_w_tag("pageBreakBefore"),
        s._ooxml_w_tag("val"),
        s._ooxml_w_tag("br"),
        s._ooxml_w_tag("type"),
    )
    assert not any(
        b.attrib.get(type_attr) == "page" for b in body_chk.iter(br_tag)
    ), "No debe quedar ningún <w:br w:type='page'/> manual en subtítulos/notas"

    def has_active_pb(p_el):
        for pb in p_el.iter(pb_tag):
            if pb.attrib.get(val_attr, "1") != "0":
                return True
        return False

    headings_info = [
        (
            s._nivel_parrafo_ooxml(p, st_chk["levels"]),
            s._texto_parrafo_ooxml(p),
            has_active_pb(p),
        )
        for p in body_chk
        if p.tag == s._ooxml_w_tag("p")
        and s._nivel_parrafo_ooxml(p, st_chk["levels"]) in (1, 2, 3)
    ]
    # Todas las secciones Heading 1 llevan salto de página
    assert all(pb for lvl, _, pb in headings_info if lvl == 1), headings_info
    # Vocab/Notas (H2 antes de Music) fluyen continuos sin pageBreakBefore
    h1_music_pos = next(
        i
        for i, (lvl, txt, _) in enumerate(headings_info)
        if lvl == 1 and "music" in txt.lower()
    )
    assert all(
        not pb for lvl, _, pb in headings_info[:h1_music_pos] if lvl == 2
    ), headings_info[:h1_music_pos]
    # En Música: 1er álbum False, 2do álbum True; 1ra canción de álbum False, 2da canción True
    music_h = headings_info[h1_music_pos + 1 :]
    album_pbs = [(txt, pb) for lvl, txt, pb in music_h if lvl == 2]
    assert (
        len(album_pbs) >= 2 and album_pbs[0][1] is False and album_pbs[1][1] is True
    ), album_pbs
    assert (
        music_h[1][0] == 3 and music_h[1][2] is False
    ), music_h  # Pista 1 flujo bajo Álbum 1
    assert (
        music_h[2][0] == 3 and music_h[2][2] is True
    ), music_h  # Pista 2 salto de página

    # 7) Segmentación por pausa (>= 2.5s) + bloques largos sin puntuación y soporte JP-EN
    vtt_paused = (
        "WEBVTT\n\n"
        "00:00:01.000 --> 00:00:03.000\n夢を見る夜\n\n"
        "00:00:03.100 --> 00:00:05.000\nShining light\n\n"
        "00:00:09.000 --> 00:00:11.500\n君と踊る\n"
    )
    seg_paused = ylh.clean_caption_text(vtt_paused)
    assert "Shining light\n\n君と踊る" in seg_paused, repr(seg_paused)

    jp_mixed = ylh.build_structured_tracks(
        [{"lang": "ja", "lyrics": "Shining light\n夢を見る\nForever now\n空を見上げて"}]
    )
    assert (
        "Shining light" in jp_mixed["original"] and "夢を見る" in jp_mixed["original"]
    ), jp_mixed
    assert jp_mixed["ja"] == "夢を見る\n空を見上げて", jp_mixed

    check_toc_regression_and_self_heal(tmp)


def check_toc_regression_and_self_heal(tmp):
    """Regresión TOC: 5+ guardados consecutivos sin cascada + auto-sanación de TOC corrupta."""
    import xml.etree.ElementTree as ET

    lib_dir = os.path.join(ROOT, "lib")
    if lib_dir not in sys.path:
        sys.path.insert(0, lib_dir)
    import docx_writer as dw  # noqa: E402

    W = dw.W_NS_URI
    w_tag = dw._w_tag

    def inspect_toc_structure(docx_bytes):
        with zipfile.ZipFile(io.BytesIO(docx_bytes), "r") as zf:
            styles_info = dw._ooxml_cargar_estilos_mapa(zf)
            root = ET.fromstring(zf.read("word/document.xml"))
        body = root.find(w_tag("body"))
        children = list(body)
        p_tag = w_tag("p")
        fld_tag = w_tag("fldChar")
        instr_tag = w_tag("instrText")
        ftype_attr = w_tag("fldCharType")
        hl_tag = w_tag("hyperlink")
        val_attr = w_tag("val")

        body_headings = []
        toc_titles = 0
        toc_instr_count = 0
        toc_style_paras = []
        toc_hyperlinks = []
        broken_markers = []
        depth = 0
        in_toc = False
        outer_toc_closed = 0
        orphan_ends = 0

        for child in children:
            if child.tag != p_tag:
                continue
            txt = dw._texto_parrafo_ooxml(child)
            if txt.strip().lower() in ("table of contents", "tabla de contenido"):
                toc_titles += 1
            ppr = child.find(w_tag("pPr"))
            sid = ""
            if ppr is not None:
                ps = ppr.find(w_tag("pStyle"))
                if ps is not None:
                    sid = ps.attrib.get(val_attr, "")
            if sid.upper().startswith("TOC"):
                toc_style_paras.append(txt)
            if "content not found" in txt.lower() or "bookmark=id" in txt.lower():
                broken_markers.append(txt)
            for hl in child.iter(hl_tag):
                anchor = hl.attrib.get(w_tag("anchor"), "")
                if "bookmark=id" in anchor.lower():
                    broken_markers.append(anchor)
                elif anchor.startswith("_Toc"):
                    toc_hyperlinks.append(
                        "".join(t.text or "" for t in hl.iter(w_tag("t")))
                    )
            for el in child.iter():
                if el.tag == instr_tag:
                    up = (el.text or "").upper()
                    if "TOC \\O" in up or ("TOC" in up and "PAGEREF" not in up):
                        toc_instr_count += 1
                elif el.tag == fld_tag:
                    ft = el.attrib.get(ftype_attr, "")
                    if ft == "begin":
                        depth += 1
                    elif ft == "end":
                        if depth == 0:
                            orphan_ends += 1
                        else:
                            depth -= 1
                            if in_toc and depth == 0:
                                in_toc = False
                                outer_toc_closed += 1
                if el.tag == instr_tag and "TOC" in (el.text or "").upper() and "PAGEREF" not in (el.text or "").upper() and depth == 1:
                    in_toc = True

            lvl = dw._nivel_parrafo_ooxml(child, styles_info["levels"])
            if lvl in (1, 2, 3) and txt:
                body_headings.append((lvl, txt))

        return {
            "toc_titles": toc_titles,
            "toc_instr_count": toc_instr_count,
            "toc_style_paras": toc_style_paras,
            "toc_hyperlinks": toc_hyperlinks,
            "body_headings": body_headings,
            "broken_markers": broken_markers,
            "depth": depth,
            "outer_toc_closed": outer_toc_closed,
            "orphan_ends": orphan_ends,
        }

    # 1) Guardar 6 entradas consecutivas con update_english_docx_bytes
    entries = [
        {"category": "vocabulary", "language": "English", "word": "ephemeral", "part_of_speech": "adjective", "spanish": "efímero"},
        {"category": "vocabulary", "language": "English", "word": "lucid", "part_of_speech": "adjective", "spanish": "lúcido"},
        {"category": "grammar", "language": "English", "title": "Subjunctive Mood", "notes": "If I were you..."},
        {"category": "phrasal_verb", "language": "English", "verb": "carry on", "meaning_es": "continuar"},
        {"category": "notes", "language": "English", "title": "Study Plan", "notes": "Review 15 minutes daily."},
        {"category": "music", "language": "English", "song_title": "Starlight", "artists_display": "Muse", "album_title": "Black Holes", "album_type": "Album", "release_year": "2006", "track_number": 2, "lyrics_study": "[EN]\nHold you in my arms"},
    ]
    doc_bytes = None
    for ent in entries:
        doc_bytes, _ = dw.update_english_docx_bytes(doc_bytes, ent)

    st_clean = inspect_toc_structure(doc_bytes)
    assert st_clean["toc_titles"] == 1, st_clean
    assert st_clean["toc_instr_count"] == 1, st_clean
    assert st_clean["outer_toc_closed"] == 1, st_clean
    assert st_clean["depth"] == 0 and st_clean["orphan_ends"] == 0, st_clean
    assert len(st_clean["toc_style_paras"]) == len(st_clean["body_headings"]), st_clean
    assert len(st_clean["toc_hyperlinks"]) == len(st_clean["body_headings"]), st_clean

    # 2) Corromper severamente el .docx previo al primer Heading 1 y verificar reparación
    with zipfile.ZipFile(io.BytesIO(doc_bytes), "r") as zin:
        orig_xml = zin.read("word/document.xml")
        other_files = {i.filename: zin.read(i.filename) for i in zin.infolist() if i.filename != "word/document.xml"}
    root_c = ET.fromstring(orig_xml)
    body_c = root_c.find(w_tag("body"))
    first_h1_pos = next(
        i for i, ch in enumerate(list(body_c))
        if ch.tag == w_tag("p") and dw._nivel_parrafo_ooxml(ch, {"Heading1": 1}) == 1
    )

    corrupt_nodes = [
        dw._crear_parrafo_texto(text="Table of Contents", font_size=13, bold_all=True),
        dw._crear_parrafo_texto(text="Tabla de contenido", font_size=13, bold_all=True),
        dw._crear_parrafo_toc(1, "1. Glossary & New Words", "_Toc245632085", {"toc_1": "TOC1", "hyperlink": "Hyperlink"}, is_first=False),
        dw._crear_parrafo_toc(2, "ephemeral (adjective) — efímero", "_Toc245632086", {"toc_2": "TOC2", "hyperlink": "Hyperlink"}, is_first=False),
        dw._crear_parrafo_toc(1, "1. Glossary & New Words", "_Toc245632085", {"toc_1": "TOC1", "hyperlink": "Hyperlink"}, is_first=False),
    ]
    # Agregar párrafo con PAGEREF huérfano, cierre fldChar end huérfano y enlace Google Docs roto
    p_orphan_pageref = ET.fromstring(
        f'<w:p xmlns:w="{W}"><w:pPr><w:pStyle w:val="TOC2"/></w:pPr>'
        f'<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
        f'<w:r><w:instrText xml:space="preserve"> PAGEREF _Toc999999 \\h </w:instrText></w:r>'
        f'<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
        f'<w:r><w:t>Content not found</w:t></w:r>'
        f'<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
    )
    p_gdocs_broken = ET.fromstring(
        f'<w:p xmlns:w="{W}"><w:hyperlink w:anchor="bookmark=id.gdocs123">'
        f'<w:r><w:t>#bookmark=id.gdocs123 Content not found</w:t></w:r></w:hyperlink></w:p>'
    )
    p_orphan_end = ET.fromstring(
        f'<w:p xmlns:w="{W}"><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
    )
    corrupt_nodes.extend([p_orphan_pageref, p_gdocs_broken, p_orphan_end, dw._w_el("p"), dw._w_el("p")])
    for off, node in enumerate(corrupt_nodes):
        body_c.insert(first_h1_pos + off, node)

    corrupt_buf = io.BytesIO()
    with zipfile.ZipFile(corrupt_buf, "w", compression=zipfile.ZIP_DEFLATED) as zout:
        for fn, pl in other_files.items():
            zout.writestr(fn, pl)
        zout.writestr("word/document.xml", dw._serializar_documento(root_c, orig_xml))
    corrupt_bytes = corrupt_buf.getvalue()

    # 2a) Reparación en frío con repair_english_docx_bytes
    repaired_bytes, rstats = dw.repair_english_docx_bytes(corrupt_bytes)
    assert rstats["ok"] is True and rstats["repaired"] is True, rstats
    assert rstats["removedTocParagraphs"] >= 8, rstats
    assert rstats["sectionsIntact"] is True, rstats
    assert rstats["counts"]["vocabulary"] == 2, rstats
    assert rstats["counts"]["music"] == 1, rstats

    st_rep = inspect_toc_structure(repaired_bytes)
    assert st_rep["toc_titles"] == 1, st_rep
    assert st_rep["toc_instr_count"] == 1, st_rep
    assert st_rep["outer_toc_closed"] == 1, st_rep
    assert st_rep["depth"] == 0 and st_rep["orphan_ends"] == 0, st_rep
    assert st_rep["broken_markers"] == [], st_rep
    assert len(st_rep["toc_style_paras"]) == len(st_rep["body_headings"]), st_rep
    assert st_rep["body_headings"] == st_clean["body_headings"], (st_rep["body_headings"], st_clean["body_headings"])

    # 2b) Auto-sanación en update_english_docx_bytes incluso con entrada nueva o duplicada
    healed_dup_bytes, hmeta = dw.update_english_docx_bytes(corrupt_bytes, entries[0])
    assert hmeta["deduplicated"] is True and hmeta["removedTocParagraphs"] >= 8, hmeta
    st_hdup = inspect_toc_structure(healed_dup_bytes)
    assert st_hdup["toc_titles"] == 1 and st_hdup["toc_instr_count"] == 1 and st_hdup["broken_markers"] == [], st_hdup

    # 2c) Auto-sanación equivalente en sincronizador._guardar_entrada_ingles_en_docx_xml
    corrupt_sync_path = os.path.join(tmp, "Corrupt_Notebook.docx")
    with open(corrupt_sync_path, "wb") as fh:
        fh.write(corrupt_bytes)
    assert s._guardar_entrada_ingles_en_docx_xml(corrupt_sync_path, {
        "category": "vocabulary", "language": "English", "word": "serene", "part_of_speech": "adjective", "spanish": "sereno"
    }) is True
    with open(corrupt_sync_path, "rb") as fh:
        sync_bytes = fh.read()
    st_sync = inspect_toc_structure(sync_bytes)
    assert st_sync["toc_titles"] == 1 and st_sync["toc_instr_count"] == 1 and st_sync["broken_markers"] == [], st_sync
    assert st_sync["depth"] == 0 and st_sync["orphan_ends"] == 0, st_sync
    assert len(st_sync["toc_style_paras"]) == len(st_sync["body_headings"]), st_sync
    sync_read = s.leer_cuaderno_estudio_word({"limit": 50}, ruta_docx=corrupt_sync_path)
    assert sync_read["ok"] and sync_read["counts"]["vocabulary"] == 3 and sync_read["counts"]["music"] == 1, sync_read
    print("TOC SELF-HEAL OK")


if __name__ == "__main__":
    main()

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const ROOT = path.resolve(__dirname, '..');

function request({ port, method = 'GET', reqPath = '/', headers = {}, body = null }) {
    return new Promise((resolve, reject) => {
        const reqHeaders = { ...headers };
        let payload = null;
        if (body !== null) {
            payload = JSON.stringify(body);
            reqHeaders['Content-Type'] = 'application/json';
            reqHeaders['Content-Length'] = Buffer.byteLength(payload);
        }
        const req = http.request(
            { hostname: '127.0.0.1', port, path: reqPath, method, headers: reqHeaders },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: Buffer.concat(chunks).toString('utf8')
                    });
                });
            }
        );
        req.on('error', reject);
        if (payload !== null) req.write(payload);
        req.end();
    });
}

describe('API y seguridad de server.js (pruebas de integración)', () => {
    let port;
    let capturedServer = null;
    let capturedPoolConfig = null;
    let origLoad;
    let origListen;
    let adminCookie;
    let medicoCookie;

    const queryLog = [];
    const activeAdvisoryLocks = new Set();
    const advisoryLockHistory = [];
    const sessions = new Map();
    const moodInserts = [];
    const sleepInserts = [];
    const crisisInserts = [];
    const agendaInserts = [];
    const syncRevisions = {
        mood: 1,
        sleep: 1,
        crisis: 1,
        agenda: 1,
        planner: 1,
        settings: 1,
        music: 1,
        journal: 1
    };
    const userSettingsMap = new Map();
    const reminderStatesMap = new Map();
    const musicArtists = [];
    const musicAlbums = [];
    const musicSongs = [];
    const musicSongArtists = [];
    const studyLessons = [];

    const testHash = bcrypt.hashSync('ClavePrueba2026!', 4);
    const users = [
        { id: 1, nombre: 'Flavio', email: 'admin@example.com', password_hash: testHash, rol: 'admin', estado: 'activo' },
        { id: 2, nombre: 'Dr. Perez', email: 'medico@example.com', password_hash: testHash, rol: 'psiquiatra', estado: 'activo' },
        { id: 3, nombre: 'Dr. Suspendido', email: 'suspendido@example.com', password_hash: testHash, rol: 'psiquiatra', estado: 'suspendido' }
    ];

    before(async () => {
        process.env.PORT = '0';
        process.env.DB_HOST = 'localhost';
        process.env.DB_USER = 'test';
        process.env.DB_PASSWORD = 'test';
        process.env.DB_NAME = 'test_db';
        process.env.ADMIN_EMAIL = 'admin@example.com';
        process.env.ADMIN_SECRET = 'secreto-test';
        process.env.SMTP_USER = 'smtp@example.com';
        process.env.SMTP_PASS = 'abcdefghijklmnop';
        process.env.DISABLE_REMINDER_SCHEDULER = 'true';
        process.env.RATE_LIMIT_WRITE_MAX = '500';
        process.env.RATE_LIMIT_READ_MAX = '800';
        process.env.RATE_LIMIT_API_MAX = '2000';

        const mockDb = {
            query(sql, paramsOrCb, maybeCb) {
                const params = Array.isArray(paramsOrCb) ? paramsOrCb : [];
                const cb = typeof paramsOrCb === 'function' ? paramsOrCb : maybeCb;
                const normalized = String(sql).replace(/\s+/g, ' ').trim();
                queryLog.push({ sql: normalized, params });

                const finish = (err, rows = []) => {
                    if (cb) process.nextTick(() => cb(err, rows));
                };

                if (normalized.startsWith('INSERT INTO SyncRevisions')) {
                    const sc = String(params[0] || '').trim();
                    if (Object.prototype.hasOwnProperty.call(syncRevisions, sc)) {
                        syncRevisions[sc] = (Number(syncRevisions[sc]) || 1) + 1;
                    }
                    return finish(null, { affectedRows: 1 });
                }

                if (normalized.includes('FROM SyncRevisions')) {
                    const rows = Object.entries(syncRevisions).map(([scope, revision]) => ({ scope, revision }));
                    return finish(null, rows);
                }

                if (normalized.startsWith('SELECT s.id AS sesion_id')) {
                    const [tokenHash, nowSql] = params;
                    const ses = sessions.get(tokenHash);
                    if (!ses || ses.expira_en <= nowSql) return finish(null, []);
                    const u = users.find((x) => x.id === ses.usuario_id);
                    if (!u) return finish(null, []);
                    return finish(null, [{
                        sesion_id: ses.id,
                        expira_en: ses.expira_en,
                        id: u.id,
                        nombre: u.nombre,
                        email: u.email,
                        rol: u.rol,
                        estado: u.estado
                    }]);
                }

                if (normalized.startsWith('SELECT id, nombre, email, COALESCE(estado')) {
                    return finish(null, users.filter((x) => x.rol === 'psiquiatra'));
                }

                if (normalized.startsWith('UPDATE Usuarios SET estado = ?')) {
                    const [estado, id] = params;
                    const u = users.find((x) => x.id === Number(id) && x.rol === 'psiquiatra');
                    if (!u) return finish(null, { affectedRows: 0 });
                    u.estado = estado;
                    return finish(null, { affectedRows: 1 });
                }

                if (normalized.startsWith('DELETE FROM SesionesAuth WHERE usuario_id = ?')) {
                    const targetUserId = Number(params[0]);
                    for (const [k, s] of sessions.entries()) {
                        if (s.usuario_id === targetUserId) sessions.delete(k);
                    }
                    return finish(null, { affectedRows: 1 });
                }

                if (normalized.startsWith('SHOW COLUMNS FROM RegistrosAgenda')) {
                    return finish(null, [
                        { Field: 'tipo' },
                        { Field: 'categoria' },
                        { Field: 'materia_id' },
                        { Field: 'materia_nombre' },
                        { Field: 'estado' },
                        { Field: 'recordatorio_min' },
                        { Field: 'en_progreso_desde' },
                        { Field: 'serie_id' }
                    ]);
                }

                if (normalized.startsWith('SHOW INDEX FROM RegistrosAgenda')) {
                    return finish(null, [{ Key_name: 'idx_agenda_serie_fecha' }]);
                }

                if (normalized.startsWith("SHOW COLUMNS FROM MusicaCanciones LIKE 'anio'")) {
                    return finish(null, [{ Field: 'anio' }]);
                }

                if (normalized.startsWith('SELECT id, rol, estado FROM Usuarios WHERE id = ?')) {
                    const targetId = Number(params[0]);
                    const u = users.find((x) => x.id === targetId);
                    return finish(null, u ? [u] : []);
                }

                if (normalized.includes('FROM Usuarios') && normalized.includes("rol = 'admin'")) {
                    const admins = users.filter((x) => x.rol === 'admin' && (x.estado || 'activo') === 'activo');
                    return finish(null, admins);
                }

                if (normalized.includes('FROM Usuarios') && normalized.includes('WHERE')) {
                    const email = String(params[0] || '').toLowerCase();
                    const u = users.find((x) => x.email === email);
                    return finish(null, u ? [u] : []);
                }

                if (normalized.startsWith('INSERT INTO SesionesAuth')) {
                    const [usuario_id, token_hash, expira_en] = params;
                    sessions.set(token_hash, { id: sessions.size + 1, usuario_id, token_hash, expira_en });
                    return finish(null, { insertId: sessions.size });
                }

                if (normalized.startsWith('DELETE FROM SesionesAuth WHERE token_hash = ?')) {
                    sessions.delete(params[0]);
                    return finish(null, { affectedRows: 1 });
                }

                if (normalized.startsWith('INSERT INTO RegistrosMood')) {
                    moodInserts.push({
                        fecha: params[0],
                        momento_dia: params[1],
                        estado_animo: params[2],
                        color_hex: params[3]
                    });
                    return finish(null, { insertId: moodInserts.length });
                }

                if (normalized.startsWith('SELECT * FROM RegistrosMood WHERE fecha = ?')) {
                    const existing = moodInserts.filter((m) => m.fecha === params[0] && m.momento_dia === params[1]);
                    return finish(null, existing);
                }

                if (normalized.startsWith('SELECT momento_dia FROM RegistrosMood WHERE fecha = ?')) {
                    const existing = moodInserts.filter((m) => m.fecha === params[0]);
                    return finish(null, existing);
                }

                if (normalized.startsWith('SELECT fecha, momento_dia, color_hex FROM RegistrosMood')) {
                    return finish(null, moodInserts);
                }

                if (normalized.startsWith('INSERT INTO RegistrosSleep')) {
                    const row = {
                        id: sleepInserts.length + 1,
                        fecha: params[0],
                        horas: params[1],
                        calidad: params[2],
                        hora_dormir: params[3] || null,
                        hora_despertar: params[4] || null,
                        es_desvelo: params[5] ?? 0,
                        tipo_registro: params[6] || 'normal',
                        motivo_desvelo: params[7] || null,
                        fecha_registro: '2026-11-15 09:00:00'
                    };
                    sleepInserts.push(row);
                    return finish(null, { insertId: row.id });
                }

                if (normalized.includes('FROM RegistrosSleep WHERE id = ?')) {
                    const targetId = Number(params[0]);
                    return finish(null, sleepInserts.filter((s) => s.id === targetId));
                }

                if (normalized.startsWith('UPDATE RegistrosSleep SET')) {
                    const targetId = Number(params[7]);
                    const row = sleepInserts.find((s) => s.id === targetId);
                    if (!row) return finish(null, { affectedRows: 0 });
                    row.hora_dormir = params[0];
                    row.hora_despertar = params[1];
                    row.horas = params[2];
                    row.calidad = params[3];
                    row.es_desvelo = params[4];
                    row.tipo_registro = params[5];
                    row.motivo_desvelo = params[6];
                    return finish(null, { affectedRows: 1 });
                }

                if (normalized.startsWith('DELETE FROM RegistrosSleep WHERE id = ?')) {
                    const idx = sleepInserts.findIndex((s) => s.id === Number(params[0]));
                    if (idx === -1) return finish(null, { affectedRows: 0 });
                    sleepInserts.splice(idx, 1);
                    return finish(null, { affectedRows: 1 });
                }

                if (normalized.includes('FROM RegistrosSleep') && normalized.includes('WHERE fecha IN (?, ?)')) {
                    const existing = sleepInserts.filter((s) => s.fecha === params[0] || s.fecha === params[1]);
                    return finish(null, existing);
                }

                if (normalized.includes('FROM RegistrosSleep WHERE fecha = ?')) {
                    const existing = sleepInserts.filter((s) => s.fecha === params[0]);
                    return finish(null, existing);
                }

                if (normalized.includes('FROM RegistrosSleep')) {
                    if (params.length === 2) {
                        const [begin, end] = params;
                        return finish(null, sleepInserts.filter((s) => s.fecha >= begin && s.fecha <= end));
                    }
                    return finish(null, sleepInserts);
                }

                if (normalized.startsWith('INSERT INTO RegistrosCrisis')) {
                    const row = {
                        id: crisisInserts.length + 1,
                        fecha: params[0],
                        hora: params[1],
                        tipo_crisis: params[2],
                        intensidad: Number(params[3]),
                        motivo: params[4],
                        fecha_registro: '2026-11-14 21:00:00'
                    };
                    crisisInserts.push(row);
                    return finish(null, { insertId: row.id });
                }

                if (normalized.includes('FROM RegistrosCrisis')) {
                    if (params.length === 2) {
                        const [begin, end] = params;
                        return finish(null, crisisInserts.filter((c) => c.fecha >= begin && c.fecha <= end));
                    }
                    return finish(null, [...crisisInserts].reverse());
                }

                if (normalized.startsWith('DELETE FROM RegistrosCrisis WHERE id = ?')) {
                    const idx = crisisInserts.findIndex((c) => c.id === Number(params[0]));
                    if (idx === -1) return finish(null, { affectedRows: 0 });
                    crisisInserts.splice(idx, 1);
                    return finish(null, { affectedRows: 1 });
                }

                if (normalized.startsWith('INSERT INTO RegistrosAgenda')) {
                    const hasEnProgresoCol = normalized.includes('en_progreso_desde');
                    const hasSerieCol = normalized.includes('serie_id');
                    const matOffset = hasEnProgresoCol ? 10 : 9;
                    const newItem = {
                        id: agendaInserts.length + 1,
                        fecha: params[0],
                        bloque: params[1],
                        hora: params[2],
                        actividad: params[3],
                        tipo: params[4] || 'evento',
                        categoria: params[5] || 'personal',
                        estado: params[6] || 'todo',
                        completada: params[7] ?? 0,
                        recordatorio_min: params[8] ?? null,
                        en_progreso_desde: hasEnProgresoCol ? (params[9] ?? null) : null,
                        materia_id: params[matOffset] ?? null,
                        materia_nombre: params[matOffset + 1] ?? null,
                        serie_id: hasSerieCol ? (params[matOffset + 2] ?? null) : null
                    };
                    agendaInserts.push(newItem);
                    return finish(null, { insertId: newItem.id });
                }

                if (normalized.startsWith('SELECT') && normalized.includes('FROM RegistrosAgenda') && normalized.includes('WHERE serie_id IN')) {
                    const wanted = new Set(params.map(p => String(p || '').trim()));
                    return finish(null, agendaInserts.filter(a => a.serie_id && wanted.has(String(a.serie_id).trim())));
                }

                if (normalized.startsWith('SELECT') && normalized.includes('FROM RegistrosAgenda') && normalized.includes('WHERE serie_id = ?')) {
                    const [sid, tid, tFecha, , tHora] = params;
                    return finish(null, agendaInserts.filter(a =>
                        String(a.serie_id || '').trim() === String(sid || '').trim() &&
                        (a.id === Number(tid) || a.fecha > tFecha || (a.fecha === tFecha && String(a.hora || '').slice(0, 5) > String(tHora || '').slice(0, 5)))
                    ));
                }

                if (normalized.startsWith('SELECT') && normalized.includes('FROM RegistrosAgenda') && normalized.includes('WHERE fecha BETWEEN ? AND ?')) {
                    const [begin, end] = params;
                    return finish(null, agendaInserts.filter((a) => a.fecha >= begin && a.fecha <= end));
                }

                if (normalized.startsWith('SELECT') && normalized.includes('FROM RegistrosAgenda') && normalized.includes('WHERE fecha = ?')) {
                    return finish(null, agendaInserts.filter((a) => a.fecha === params[0]));
                }

                if (normalized.startsWith('SELECT') && normalized.includes('FROM RegistrosAgenda') && normalized.includes("WHERE estado = 'in_progress'")) {
                    return finish(null, agendaInserts.filter((a) => a.estado === 'in_progress' && Number(a.completada) === 0));
                }

                if (normalized.startsWith('UPDATE RegistrosAgenda SET fecha = ?, bloque = ?, hora = ?, actividad = ?')) {
                    const id = Number(params[12]);
                    const item = agendaInserts.find((a) => a.id === id);
                    if (!item) return finish(null, { affectedRows: 0 });
                    item.fecha = params[0];
                    item.bloque = params[1];
                    item.hora = params[2];
                    item.actividad = params[3];
                    item.tipo = params[4];
                    item.categoria = params[5];
                    item.estado = params[6];
                    item.completada = params[7];
                    item.recordatorio_min = params[8];
                    item.en_progreso_desde = params[9] ?? null;
                    item.materia_id = params[10] ?? null;
                    item.materia_nombre = params[11] ?? null;
                    return finish(null, { affectedRows: 1 });
                }

                if (normalized.startsWith('UPDATE RegistrosAgenda SET fecha = ?, bloque = ?, hora = ?, estado = ?, completada = ?, en_progreso_desde = ? WHERE id = ?')) {
                    const id = Number(params[6]);
                    const item = agendaInserts.find((a) => a.id === id);
                    if (!item) return finish(null, { affectedRows: 0 });
                    item.fecha = params[0];
                    item.bloque = params[1];
                    item.hora = params[2];
                    item.estado = params[3];
                    item.completada = params[4];
                    item.en_progreso_desde = params[5] ?? null;
                    return finish(null, { affectedRows: 1 });
                }

                if (normalized.startsWith('UPDATE RegistrosAgenda SET fecha = ?, bloque = ?, hora = ? WHERE id = ?')) {
                    const id = Number(params[3]);
                    const item = agendaInserts.find((a) => a.id === id);
                    if (!item) return finish(null, { affectedRows: 0 });
                    item.fecha = params[0];
                    item.bloque = params[1];
                    item.hora = params[2];
                    return finish(null, { affectedRows: 1 });
                }

                if (normalized.startsWith('UPDATE RegistrosAgenda SET fecha = ?, estado = ?, completada = ?, en_progreso_desde = ? WHERE id = ?')) {
                    const id = Number(params[4]);
                    const item = agendaInserts.find((a) => a.id === id);
                    if (!item) return finish(null, { affectedRows: 0 });
                    item.fecha = params[0];
                    item.estado = params[1];
                    item.completada = params[2];
                    item.en_progreso_desde = params[3] ?? null;
                    return finish(null, { affectedRows: 1 });
                }

                if (normalized.startsWith('UPDATE RegistrosAgenda SET estado = ?, completada = ?, en_progreso_desde = ? WHERE id = ?')) {
                    const id = Number(params[3]);
                    const item = agendaInserts.find((a) => a.id === id);
                    if (!item) return finish(null, { affectedRows: 0 });
                    item.estado = params[0];
                    item.completada = params[1];
                    item.en_progreso_desde = params[2] ?? null;
                    return finish(null, { affectedRows: 1 });
                }

                if (normalized.startsWith("UPDATE RegistrosAgenda SET estado = 'done', completada = 1, en_progreso_desde = NULL WHERE id = ?")) {
                    const id = Number(params[0]);
                    const item = agendaInserts.find((a) => a.id === id);
                    if (!item) return finish(null, { affectedRows: 0 });
                    item.estado = 'done';
                    item.completada = 1;
                    item.en_progreso_desde = null;
                    return finish(null, { affectedRows: 1 });
                }

                if (normalized.startsWith("UPDATE RegistrosAgenda SET estado = 'skipped', completada = 0, en_progreso_desde = NULL WHERE id = ?")) {
                    const id = Number(params[0]);
                    const item = agendaInserts.find((a) => a.id === id);
                    if (!item) return finish(null, { affectedRows: 0 });
                    item.estado = 'skipped';
                    item.completada = 0;
                    item.en_progreso_desde = null;
                    return finish(null, { affectedRows: 1 });
                }

                if (normalized.startsWith('SELECT') && normalized.includes('FROM RegistrosAgenda') && normalized.includes('WHERE id = ?')) {
                    const id = Number(params[0]);
                    const item = agendaInserts.find((a) => a.id === id);
                    if (!item) return finish(null, []);
                    return finish(null, [{ ...item }]);
                }

                if (normalized.startsWith('DELETE FROM RegistrosAgenda WHERE serie_id = ?')) {
                    const [sid, tid, tFecha, , tHora] = params;
                    let deleted = 0;
                    for (let i = agendaInserts.length - 1; i >= 0; i--) {
                        const a = agendaInserts[i];
                        if (
                            String(a.serie_id || '').trim() === String(sid || '').trim() &&
                            (a.id === Number(tid) || a.fecha > tFecha || (a.fecha === tFecha && String(a.hora || '').slice(0, 5) > String(tHora || '').slice(0, 5)))
                        ) {
                            agendaInserts.splice(i, 1);
                            deleted += 1;
                        }
                    }
                    return finish(null, { affectedRows: deleted });
                }

                if (normalized.startsWith('DELETE FROM RegistrosAgenda WHERE id = ?')) {
                    const idx = agendaInserts.findIndex((a) => a.id === Number(params[0]));
                    if (idx === -1) return finish(null, { affectedRows: 0 });
                    agendaInserts.splice(idx, 1);
                    return finish(null, { affectedRows: 1 });
                }

                if (normalized.startsWith('SELECT config_json FROM ConfiguracionUsuario WHERE usuario_id = ?')) {
                    const cfg = userSettingsMap.get(Number(params[0]));
                    return finish(null, cfg ? [{ config_json: cfg }] : []);
                }

                if (normalized.startsWith('INSERT INTO ConfiguracionUsuario')) {
                    userSettingsMap.set(Number(params[0]), params[1]);
                    return finish(null, { affectedRows: 1 });
                }

                if (normalized.startsWith('SELECT clave_unica, tipo, titulo, mensaje, estado, snooze_hasta, enviado_push_en FROM RecordatoriosEstado')) {
                    const uid = Number(params[0]);
                    const rows = [...reminderStatesMap.values()].filter((r) => r.usuario_id === uid);
                    return finish(null, rows);
                }

                if (normalized.startsWith('INSERT INTO RecordatoriosEstado')) {
                    const [uid, key, tipo, refId, titulo, mensaje] = params;
                    const isDismiss = normalized.includes("'dismissed'");
                    const isSnooze = normalized.includes("'snoozed'");
                    const estado = isDismiss ? 'dismissed' : (isSnooze ? 'snoozed' : 'active');
                    const snoozeHasta = isSnooze ? params[6] : null;
                    const pushAt = !isDismiss && !isSnooze ? params[6] : null;
                    reminderStatesMap.set(`${uid}:${key}`, {
                        usuario_id: Number(uid),
                        clave_unica: key,
                        tipo,
                        ref_id: refId,
                        titulo,
                        mensaje,
                        estado,
                        snooze_hasta: snoozeHasta,
                        enviado_push_en: pushAt
                    });
                    return finish(null, { affectedRows: 1 });
                }

                if (normalized.startsWith("DELETE FROM RecordatoriosEstado WHERE usuario_id = ? AND clave_unica LIKE CONCAT(?, ':m%')")) {
                    const targetUid = Number(params[0]);
                    const seriesPrefix = `${String(params[1] || '')}:m`;
                    const excludeKey = normalized.includes('AND clave_unica <> ?') ? String(params[2] || '') : null;
                    let deleted = 0;
                    for (const [mapKey, val] of Array.from(reminderStatesMap.entries())) {
                        if (
                            Number(val.usuario_id) === targetUid &&
                            String(val.clave_unica || '').startsWith(seriesPrefix) &&
                            (excludeKey === null || val.clave_unica !== excludeKey)
                        ) {
                            reminderStatesMap.delete(mapKey);
                            deleted += 1;
                        }
                    }
                    return finish(null, { affectedRows: deleted });
                }

                if (normalized.startsWith("UPDATE RecordatoriosEstado SET estado = 'dismissed' WHERE ref_id = ?")) {
                    const targetRefId = Number(params[0]);
                    for (const val of reminderStatesMap.values()) {
                        if (Number(val.ref_id) === targetRefId && val.tipo === 'agenda') {
                            val.estado = 'dismissed';
                        }
                    }
                    return finish(null, { affectedRows: 1 });
                }

                if (normalized.startsWith('DELETE FROM RecordatoriosEstado WHERE ref_id = ?')) {
                    const targetRefId = Number(params[0]);
                    for (const [k, val] of reminderStatesMap.entries()) {
                        if (Number(val.ref_id) === targetRefId && val.tipo === 'agenda') {
                            reminderStatesMap.delete(k);
                        }
                    }
                    return finish(null, { affectedRows: 1 });
                }

                if (normalized.startsWith('SELECT id FROM MusicaArtistas WHERE id = ? AND usuario_id = ?')) {
                    const [artistId, uid] = params;
                    const match = musicArtists.find((a) => a.id === Number(artistId) && a.usuario_id === Number(uid));
                    return finish(null, match ? [{ id: match.id }] : []);
                }

                if (normalized.startsWith('SELECT id FROM MusicaArtistas WHERE usuario_id = ? AND nombre_normalizado = ? AND id <> ?')) {
                    const [uid, norm, excludeId] = params;
                    const match = musicArtists.find(
                        (a) => a.usuario_id === Number(uid) && a.nombre_normalizado === norm && a.id !== Number(excludeId)
                    );
                    return finish(null, match ? [{ id: match.id }] : []);
                }

                if (normalized.startsWith('SELECT id FROM MusicaArtistas WHERE usuario_id = ? AND nombre_normalizado = ?')) {
                    const [uid, norm] = params;
                    const match = musicArtists.find((a) => a.usuario_id === Number(uid) && a.nombre_normalizado === norm);
                    return finish(null, match ? [{ id: match.id }] : []);
                }

                if (normalized.startsWith('UPDATE MusicaArtistas SET nombre = ?, tipo_artista = ? WHERE id = ? AND usuario_id = ?')) {
                    const [nombre, tipo, artistId, uid] = params;
                    const artist = musicArtists.find((a) => a.id === Number(artistId) && a.usuario_id === Number(uid));
                    if (artist) {
                        artist.nombre = nombre;
                        artist.tipo_artista = tipo;
                    }
                    return finish(null, { affectedRows: artist ? 1 : 0 });
                }

                if (normalized.startsWith('UPDATE MusicaArtistas SET nombre = ?, nombre_normalizado = ?, tipo_artista = ?, notas_cortas = ? WHERE id = ? AND usuario_id = ?')) {
                    const [nombre, norm, tipo, notasCortas, artistId, uid] = params;
                    const artist = musicArtists.find((a) => a.id === Number(artistId) && a.usuario_id === Number(uid));
                    if (artist) {
                        artist.nombre = nombre;
                        artist.nombre_normalizado = norm;
                        artist.tipo_artista = tipo;
                        artist.notas_cortas = notasCortas;
                    }
                    return finish(null, { affectedRows: artist ? 1 : 0 });
                }

                if (normalized.startsWith('INSERT INTO MusicaArtistas')) {
                    const [uid, nombre, norm, tipo] = params;
                    const id = musicArtists.length + 1;
                    musicArtists.push({
                        id,
                        usuario_id: Number(uid),
                        nombre,
                        nombre_normalizado: norm,
                        tipo_artista: tipo || 'solo',
                        notas_cortas: null,
                        creado_en: '2026-11-14 16:00:00'
                    });
                    return finish(null, { insertId: id });
                }

                if (normalized.startsWith('SELECT id FROM MusicaAlbumes WHERE id = ? AND usuario_id = ?')) {
                    const [albumId, uid] = params;
                    const match = musicAlbums.find((al) => al.id === Number(albumId) && al.usuario_id === Number(uid));
                    return finish(null, match ? [{ id: match.id }] : []);
                }

                if (normalized.startsWith('SELECT id FROM MusicaAlbumes WHERE usuario_id = ? AND titulo_normalizado = ?')) {
                    const [uid, norm, mainId] = params;
                    const match = musicAlbums.find(
                        (al) =>
                            al.usuario_id === Number(uid) &&
                            al.titulo_normalizado === norm &&
                            Number(al.artista_principal_id || 0) === Number(mainId || 0)
                    );
                    return finish(null, match ? [{ id: match.id }] : []);
                }

                if (normalized.startsWith('UPDATE MusicaAlbumes SET tipo_lanzamiento = ?')) {
                    const [tipo, anio, albumId, uid] = params;
                    const alb = musicAlbums.find((a) => a.id === Number(albumId) && a.usuario_id === Number(uid));
                    if (alb) {
                        alb.tipo_lanzamiento = tipo;
                        if (anio !== null && anio !== undefined) alb.anio = anio;
                    }
                    return finish(null, { affectedRows: alb ? 1 : 0 });
                }

                if (normalized.startsWith('UPDATE MusicaAlbumes SET titulo = ?, titulo_normalizado = ?, tipo_lanzamiento = ?, anio = ? WHERE id = ? AND usuario_id = ?')) {
                    const [titulo, norm, tipo, anio, albumId, uid] = params;
                    const alb = musicAlbums.find((a) => a.id === Number(albumId) && a.usuario_id === Number(uid));
                    if (alb) {
                        alb.titulo = titulo;
                        alb.titulo_normalizado = norm;
                        alb.tipo_lanzamiento = tipo;
                        alb.anio = anio;
                    }
                    return finish(null, { affectedRows: alb ? 1 : 0 });
                }

                if (normalized.startsWith('UPDATE MusicaAlbumes SET notas_cortas = ? WHERE id = ? AND usuario_id = ?')) {
                    const [notas, albumId, uid] = params;
                    const alb = musicAlbums.find((a) => a.id === Number(albumId) && a.usuario_id === Number(uid));
                    if (alb) alb.notas_cortas = notas;
                    return finish(null, { affectedRows: alb ? 1 : 0 });
                }

                if (normalized.startsWith('DELETE FROM MusicaAlbumes WHERE id = ? AND usuario_id = ?')) {
                    const [albumId, uid] = params;
                    const idx = musicAlbums.findIndex((a) => a.id === Number(albumId) && a.usuario_id === Number(uid));
                    if (idx !== -1) musicAlbums.splice(idx, 1);
                    return finish(null, { affectedRows: idx !== -1 ? 1 : 0 });
                }

                if (normalized.startsWith('INSERT INTO MusicaAlbumes')) {
                    const [uid, mainArtistId, titulo, norm, tipo, anio] = params;
                    const id = musicAlbums.length + 1;
                    musicAlbums.push({
                        id,
                        usuario_id: Number(uid),
                        artista_principal_id: mainArtistId || null,
                        titulo,
                        titulo_normalizado: norm,
                        tipo_lanzamiento: tipo || 'album',
                        anio: anio || null,
                        notas_cortas: null,
                        creado_en: '2026-11-14 16:00:00'
                    });
                    return finish(null, { insertId: id });
                }

                if (normalized.startsWith('INSERT INTO MusicaCanciones')) {
                    const hasAnioCol = normalized.includes(', anio,');
                    const uid = params[0];
                    const albumId = params[1];
                    const titulo = params[2];
                    const numPista = params[3];
                    const idioma = params[4];
                    const anio = hasAnioCol ? params[5] : null;
                    const offset = hasAnioCol ? 1 : 0;
                    const ytUrl = params[5 + offset];
                    const ytId = params[6 + offset];
                    const thumb = params[7 + offset];
                    const estado = params[8 + offset];
                    const enfoque = params[9 + offset];
                    const wordSync = params[10 + offset] ? 1 : 0;
                    const id = musicSongs.length + 1;
                    musicSongs.push({
                        id,
                        usuario_id: Number(uid),
                        album_id: albumId || null,
                        titulo,
                        numero_pista: numPista,
                        idioma,
                        anio: anio || null,
                        yt_music_url: ytUrl,
                        yt_video_id: ytId,
                        thumbnail_url: thumb,
                        estado_estudio: estado,
                        enfoque_corto: enfoque,
                        word_sincronizado: wordSync,
                        ultimo_estudio_en: null,
                        creado_en: '2026-11-14 16:00:00',
                        actualizado_en: '2026-11-14 16:00:00'
                    });
                    return finish(null, { insertId: id });
                }

                if (normalized.startsWith('DELETE FROM MusicaCancionArtistas WHERE cancion_id = ?')) {
                    const songId = Number(params[0]);
                    for (let i = musicSongArtists.length - 1; i >= 0; i--) {
                        if (musicSongArtists[i].cancion_id === songId) musicSongArtists.splice(i, 1);
                    }
                    return finish(null, { affectedRows: 1 });
                }

                if (normalized.startsWith('INSERT INTO MusicaCancionArtistas')) {
                    const [songId, artistId, rol, orden] = params;
                    musicSongArtists.push({
                        cancion_id: Number(songId),
                        artista_id: Number(artistId),
                        rol,
                        orden
                    });
                    return finish(null, { affectedRows: 1 });
                }

                if (normalized.startsWith('SELECT id, nombre, tipo_artista, notas_cortas, creado_en FROM MusicaArtistas')) {
                    const uid = Number(params[0]);
                    return finish(
                        null,
                        musicArtists
                            .filter((a) => a.usuario_id === uid)
                            .sort((a, b) => a.nombre.localeCompare(b.nombre))
                    );
                }

                if (normalized.startsWith('SELECT al.id, al.artista_principal_id, ma.nombre AS artista_principal_nombre')) {
                    const uid = Number(params[0]);
                    return finish(
                        null,
                        musicAlbums
                            .filter((al) => al.usuario_id === uid)
                            .map((al) => {
                                const artist = musicArtists.find((a) => a.id === al.artista_principal_id);
                                return { ...al, artista_principal_nombre: artist ? artist.nombre : null };
                            })
                    );
                }

                if (normalized.startsWith('SELECT c.id, c.album_id, al.titulo AS album_titulo')) {
                    const uid = Number(params[0]);
                    return finish(
                        null,
                        musicSongs
                            .filter((c) => c.usuario_id === uid)
                            .map((c) => {
                                const al = musicAlbums.find((a) => a.id === c.album_id);
                                return {
                                    ...c,
                                    album_titulo: al ? al.titulo : null,
                                    album_tipo: al ? al.tipo_lanzamiento : null,
                                    album_anio: (al && al.anio != null) ? al.anio : (c.anio ?? null),
                                    cancion_anio: c.anio ?? null
                                };
                            })
                    );
                }

                if (normalized.startsWith('SELECT mca.cancion_id, mca.artista_id, mca.rol, mca.orden, ma.nombre FROM MusicaCancionArtistas')) {
                    const uid = Number(params[0]);
                    const ownedSongIds = new Set(musicSongs.filter((c) => c.usuario_id === uid).map((c) => c.id));
                    return finish(
                        null,
                        musicSongArtists
                            .filter((l) => ownedSongIds.has(l.cancion_id))
                            .map((l) => {
                                const artist = musicArtists.find((a) => a.id === l.artista_id);
                                return { ...l, nombre: artist ? artist.nombre : '' };
                            })
                    );
                }

                if (normalized.startsWith('SELECT id FROM MusicaCanciones WHERE id = ? AND usuario_id = ?')) {
                    const [songId, uid] = params;
                    const match = musicSongs.find((c) => c.id === Number(songId) && c.usuario_id === Number(uid));
                    return finish(null, match ? [{ id: match.id }] : []);
                }

                if (normalized.startsWith('SELECT id, estado_estudio, word_sincronizado FROM MusicaCanciones WHERE id = ? AND usuario_id = ?')) {
                    const [songId, uid] = params;
                    const match = musicSongs.find((c) => c.id === Number(songId) && c.usuario_id === Number(uid));
                    return finish(null, match ? [{ id: match.id, estado_estudio: match.estado_estudio, word_sincronizado: match.word_sincronizado }] : []);
                }

                if (normalized.startsWith('UPDATE MusicaCanciones SET album_id = NULL WHERE album_id = ? AND usuario_id = ?')) {
                    const [albumId, uid] = params;
                    let count = 0;
                    musicSongs.forEach((s) => {
                        if (s.album_id === Number(albumId) && s.usuario_id === Number(uid)) {
                            s.album_id = null;
                            count++;
                        }
                    });
                    return finish(null, { affectedRows: count });
                }

                if (normalized.startsWith('UPDATE MusicaCanciones SET album_id = ?')) {
                    const hasAnioCol = normalized.includes('anio = ?');
                    const albumId = params[0];
                    const titulo = params[1];
                    const numPista = params[2];
                    const idioma = params[3];
                    const anio = hasAnioCol ? params[4] : null;
                    const off = hasAnioCol ? 1 : 0;
                    const ytUrl = params[4 + off];
                    const ytId = params[5 + off];
                    const thumb = params[6 + off];
                    const estado = params[7 + off];
                    const enfoque = params[8 + off];
                    const songId = params[9 + off];
                    const uid = params[10 + off];
                    const song = musicSongs.find((c) => c.id === Number(songId) && c.usuario_id === Number(uid));
                    if (song) {
                        Object.assign(song, {
                            album_id: albumId || null,
                            titulo,
                            numero_pista: numPista,
                            idioma,
                            ...(hasAnioCol ? { anio: anio || null } : {}),
                            yt_music_url: ytUrl,
                            yt_video_id: ytId,
                            thumbnail_url: thumb,
                            estado_estudio: estado,
                            enfoque_corto: enfoque
                        });
                    }
                    return finish(null, { affectedRows: song ? 1 : 0 });
                }

                if (normalized.startsWith('SELECT id, titulo, idioma, yt_music_url, yt_video_id FROM MusicaCanciones WHERE id = ? AND usuario_id = ?')) {
                    const [songId, uid] = params;
                    const match = musicSongs.find((c) => c.id === Number(songId) && c.usuario_id === Number(uid));
                    return finish(null, match ? [match] : []);
                }

                if (normalized.startsWith('UPDATE MusicaCanciones SET estado_estudio = ?')) {
                    const [estado, wordSynced, ultimoEstudio, songId, uid] = params;
                    const song = musicSongs.find((c) => c.id === Number(songId) && c.usuario_id === Number(uid));
                    if (song) {
                        song.estado_estudio = estado;
                        song.word_sincronizado = wordSynced;
                        song.ultimo_estudio_en = ultimoEstudio;
                    }
                    return finish(null, { affectedRows: song ? 1 : 0 });
                }

                if (normalized.startsWith('SELECT id, album_id, numero_pista FROM MusicaCanciones WHERE id = ? AND usuario_id = ?')) {
                    const [songId, uid] = params;
                    const match = musicSongs.find((c) => c.id === Number(songId) && c.usuario_id === Number(uid));
                    return finish(null, match ? [{ id: match.id, album_id: match.album_id, numero_pista: match.numero_pista }] : []);
                }

                if (normalized.startsWith('UPDATE MusicaCanciones SET numero_pista = COALESCE')) {
                    const [trackNum, songId, uid] = params;
                    const song = musicSongs.find((c) => c.id === Number(songId) && c.usuario_id === Number(uid));
                    if (song && !song.numero_pista) song.numero_pista = trackNum;
                    return finish(null, { affectedRows: song ? 1 : 0 });
                }

                if (normalized.startsWith('UPDATE MusicaAlbumes SET anio = COALESCE')) {
                    const [anio, albumId, uid] = params;
                    const alb = musicAlbums.find((a) => a.id === Number(albumId) && a.usuario_id === Number(uid));
                    if (alb && !alb.anio) alb.anio = anio;
                    return finish(null, { affectedRows: alb ? 1 : 0 });
                }

                if (normalized.startsWith('UPDATE MusicaAlbumes SET fecha_lanzamiento = COALESCE')) {
                    const [fecha, albumId, uid] = params;
                    const alb = musicAlbums.find((a) => a.id === Number(albumId) && a.usuario_id === Number(uid));
                    if (alb && !alb.fecha_lanzamiento) alb.fecha_lanzamiento = fecha;
                    return finish(null, { affectedRows: alb ? 1 : 0 });
                }

                if (normalized.startsWith('SELECT id, codigo_leccion, idioma, nombre_practica, orden_secuencia, completada, word_leido_en, completada_en FROM EstudioLecciones')) {
                    const uid = Number(params[0]);
                    return finish(null, studyLessons.filter((l) => l.usuario_id === uid).sort((a, b) => a.orden_secuencia - b.orden_secuencia));
                }

                if (normalized.startsWith('INSERT IGNORE INTO EstudioLecciones')) {
                    const uid = Number(params[0]);
                    if (!studyLessons.some((l) => l.usuario_id === uid)) {
                        const defs = [
                            ['en', 'EN-01', 'EN · Bloque A1: Fonética y 10 palabras activas (EN -> ES)', 1],
                            ['en', 'EN-02', 'EN · Bloque A2: Modal Verbs & Idioms en contexto (EN -> ES)', 2],
                            ['en', 'EN-03', 'EN · Bloque A3: Desglose de canción + pronunciación', 3],
                            ['ko', 'KO-01', 'KO · Block B1: Hangul Phonics & Core Vocab (KO -> EN)', 4],
                            ['ko', 'KO-02', 'KO · Block B2: Everyday Patterns & Particles (KO -> EN)', 5],
                            ['ko', 'KO-03', 'KO · Block B3: K-Pop Mixed Verses & Rapid Practice', 6]
                        ];
                        defs.forEach(([idioma, codigo, nombre, orden]) => {
                            studyLessons.push({
                                id: studyLessons.length + 1,
                                usuario_id: uid,
                                idioma,
                                codigo_leccion: codigo,
                                nombre_practica: nombre,
                                orden_secuencia: orden,
                                completada: 0,
                                word_leido_en: null,
                                completada_en: null
                            });
                        });
                    }
                    return finish(null, { affectedRows: studyLessons.length });
                }

                if (normalized.startsWith('SELECT id, codigo_leccion, idioma, nombre_practica, orden_secuencia, completada, word_leido_en FROM EstudioLecciones')) {
                    const uid = Number(params[0]);
                    const targetId = Number(params[1]);
                    return finish(null, studyLessons.filter((l) => l.usuario_id === uid && (!targetId || l.id === targetId)).sort((a, b) => a.orden_secuencia - b.orden_secuencia));
                }

                if (normalized.startsWith('UPDATE EstudioLecciones SET word_leido_en = COALESCE')) {
                    const [ts, id, uid] = params;
                    const row = studyLessons.find((l) => l.id === Number(id) && l.usuario_id === Number(uid));
                    if (row && !row.word_leido_en) row.word_leido_en = ts;
                    return finish(null, { affectedRows: row ? 1 : 0 });
                }

                if (normalized.startsWith('UPDATE EstudioLecciones SET completada = 1')) {
                    const [tsRead, tsDone, id, uid] = params;
                    const row = studyLessons.find((l) => l.id === Number(id) && l.usuario_id === Number(uid));
                    if (row) {
                        row.completada = 1;
                        if (!row.word_leido_en) row.word_leido_en = tsRead;
                        row.completada_en = tsDone;
                    }
                    return finish(null, { affectedRows: row ? 1 : 0 });
                }

                if (normalized.startsWith('DELETE FROM MusicaCanciones WHERE id = ? AND usuario_id = ?')) {
                    const [songId, uid] = params;
                    const idx = musicSongs.findIndex((c) => c.id === Number(songId) && c.usuario_id === Number(uid));
                    if (idx === -1) return finish(null, { affectedRows: 0 });
                    musicSongs.splice(idx, 1);
                    for (let i = musicSongArtists.length - 1; i >= 0; i--) {
                        if (musicSongArtists[i].cancion_id === Number(songId)) musicSongArtists.splice(i, 1);
                    }
                    return finish(null, { affectedRows: 1 });
                }

                return finish(null, []);
            },
            getConnection(cb) {
                cb(null, {
                    query(sql, paramsOrCb, maybeCb) {
                        const params = Array.isArray(paramsOrCb) ? paramsOrCb : [];
                        const queryCb = typeof paramsOrCb === 'function' ? paramsOrCb : maybeCb;
                        const normalized = String(sql).replace(/\s+/g, ' ').trim();
                        if (normalized.startsWith('SELECT GET_LOCK(')) {
                            const lockName = String(params[0] || '');
                            const acquired = activeAdvisoryLocks.has(lockName) ? 0 : 1;
                            if (acquired === 1) activeAdvisoryLocks.add(lockName);
                            advisoryLockHistory.push({ op: 'acquire', lockName, result: acquired });
                            return process.nextTick(() => queryCb(null, [{ acquired }]));
                        }
                        if (normalized.startsWith('SELECT RELEASE_LOCK(')) {
                            const lockName = String(params[0] || '');
                            const released = activeAdvisoryLocks.delete(lockName) ? 1 : 0;
                            advisoryLockHistory.push({ op: 'release', lockName, result: released });
                            return process.nextTick(() => queryCb(null, [{ released }]));
                        }
                        return mockDb.query(sql, params, queryCb);
                    },
                    release() {}
                });
            },
            end(cb) {
                if (cb) cb();
            }
        };

        origLoad = Module._load;
        Module._load = function (requestName) {
            if (requestName === 'dotenv') return { config: () => ({ parsed: {} }) };
            if (requestName === 'mysql2') {
                return {
                    createPool(cfg) {
                        capturedPoolConfig = cfg;
                        return mockDb;
                    }
                };
            }
            if (requestName === 'nodemailer') {
                return { createTransport: () => ({ async sendMail() { return { messageId: 'mock' }; } }) };
            }
            return origLoad.apply(this, arguments);
        };

        origListen = http.Server.prototype.listen;
        http.Server.prototype.listen = function (...args) {
            capturedServer = this;
            return origListen.apply(this, args);
        };

        const serverPath = path.join(ROOT, 'server.js');
        delete require.cache[require.resolve(serverPath)];
        require(serverPath);

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timeout esperando server.listen')), 5000);
            const wait = () => {
                if (capturedServer && capturedServer.listening) {
                    clearTimeout(timeout);
                    resolve();
                } else {
                    setTimeout(wait, 15);
                }
            };
            wait();
        });

        port = capturedServer.address().port;

        // Crear sesión directa para psiquiatra (no expira en 24h)
        const medicoRaw = crypto.randomBytes(24).toString('hex');
        const medicoHash = crypto.createHash('sha256').update(medicoRaw).digest('hex');
        const exp = new Date(Date.now() + 24 * 3600 * 1000);
        const pad = (n) => String(n).padStart(2, '0');
        const expSql = `${exp.getFullYear()}-${pad(exp.getMonth() + 1)}-${pad(exp.getDate())} ${pad(exp.getHours())}:${pad(exp.getMinutes())}:${pad(exp.getSeconds())}`;
        sessions.set(medicoHash, { id: 99, usuario_id: 2, token_hash: medicoHash, expira_en: expSql });
        medicoCookie = `mt_session=${medicoRaw}`;
    });

    after(async () => {
        if (origLoad) Module._load = origLoad;
        if (origListen) http.Server.prototype.listen = origListen;
        if (capturedServer && capturedServer.listening) {
            await new Promise((resolve) => capturedServer.close(resolve));
        }
    });

    it('configura pool MySQL de bajo consumo para t3.micro', () => {
        assert.strictEqual(capturedPoolConfig.connectionLimit, 4);
        assert.strictEqual(capturedPoolConfig.maxIdle, 2);
        assert.strictEqual(capturedPoolConfig.idleTimeout, 60000);
        assert.strictEqual(capturedPoolConfig.enableKeepAlive, false);
    });

    it('envía cabeceras de seguridad HTTP y caché estático con ETag', async () => {
        const res = await request({ port, reqPath: '/index.html' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers['x-powered-by'], undefined);
        assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
        assert.strictEqual(res.headers['x-frame-options'], 'DENY');
        assert.strictEqual(res.headers['referrer-policy'], 'strict-origin-when-cross-origin');
        assert.strictEqual(res.headers['permissions-policy'], 'geolocation=(self), microphone=(self), camera=()');
        assert.strictEqual(res.headers['cross-origin-opener-policy'], 'same-origin');
        assert.strictEqual(res.headers['cross-origin-resource-policy'], 'same-origin');
        assert.strictEqual(res.headers['x-permitted-cross-domain-policies'], 'none');
        assert.strictEqual(res.headers['x-dns-prefetch-control'], 'off');
        assert.ok(String(res.headers['content-security-policy'] || '').includes("default-src 'self'"));
        assert.ok(String(res.headers['content-security-policy'] || '').includes("form-action 'self'"));
        assert.ok(res.headers.etag);
        assert.ok(String(res.headers['cache-control'] || '').includes('max-age=600'));

        for (const assetPath of ['/frontend.js', '/style.css']) {
            const assetRes = await request({ port, reqPath: assetPath });
            assert.strictEqual(assetRes.status, 200);
            assert.ok(assetRes.headers.etag, `${assetPath} debe enviar ETag`);
            assert.match(
                String(assetRes.headers['cache-control'] || ''),
                /max-age=0,\s*must-revalidate/,
                `${assetPath} debe revalidar caché tras despliegues`
            );
        }
    });

    it('bloquea rutas protegidas sin sesión, valida bcrypt y limpia registros vencidos al hacer login', async () => {
        const unauth = await request({ port, reqPath: '/api/auth/me' });
        assert.strictEqual(unauth.status, 401);

        const wrongPass = await request({
            port,
            method: 'POST',
            reqPath: '/api/auth/login',
            body: { email: 'admin@example.com', password: 'IncorrectaPassword1!' }
        });
        assert.strictEqual(wrongPass.status, 401);

        const qBefore = queryLog.length;
        const okLogin = await request({
            port,
            method: 'POST',
            reqPath: '/api/auth/login',
            body: { email: 'admin@example.com', password: 'ClavePrueba2026!' }
        });
        assert.strictEqual(okLogin.status, 200);
        const setCookie = (okLogin.headers['set-cookie'] || []).join('; ');
        assert.match(setCookie, /HttpOnly/i);
        const tokenMatch = setCookie.match(/mt_session=([^;]+)/);
        assert.ok(tokenMatch, 'Debe entregar cookie mt_session');
        adminCookie = `mt_session=${tokenMatch[1]}`;

        await new Promise((r) => setTimeout(r, 40));
        const loginSqls = queryLog.slice(qBefore).map((q) => q.sql);
        assert.ok(loginSqls.some((s) => s.startsWith('DELETE FROM SesionesAuth WHERE expira_en <=')));
        assert.ok(loginSqls.some((s) => s.startsWith('DELETE FROM CodigosSeguridad WHERE')));

        const me = await request({ port, reqPath: '/api/auth/me', headers: { Cookie: adminCookie } });
        assert.strictEqual(me.status, 200);
        assert.strictEqual(JSON.parse(me.body).user.rol, 'admin');
    });

    it('aplica RBAC: psiquiatra solo puede leer ánimo y sueño y recibe 403 al editar', async () => {
        for (const reqOpts of [
            { method: 'POST', reqPath: '/api/insert-mood', body: { fecha: '2026-11-14', momento_dia: 'Madrugada', estado_animo: 'Feliz', color_hex: '#4caf50' } },
            { method: 'POST', reqPath: '/api/insert-sleep', body: { fecha: '2026-11-14', horas: 7.5, calidad: 'Good' } },
            { method: 'GET', reqPath: '/api/get-agenda?begin=2026-11-01&end=2026-11-14' },
            { method: 'POST', reqPath: '/api/insert-agenda', body: { fecha: '2026-11-14', bloque: 'manana', hora: '08:00', actividad: 'Leer' } },
            { method: 'POST', reqPath: '/api/send-to-pc', body: { texto: 'cifrado' } },
            { method: 'POST', reqPath: '/api/send-english', body: { texto: 'cifrado-english' } }
        ]) {
            const res = await request({ port, headers: { Cookie: medicoCookie }, ...reqOpts });
            assert.strictEqual(res.status, 403, `${reqOpts.reqPath} debe responder 403 para psiquiatra`);
        }

        const readMoods = await request({
            port,
            reqPath: '/api/get-moods?begin=2026-11-01&end=2026-11-14',
            headers: { Cookie: medicoCookie }
        });
        assert.strictEqual(readMoods.status, 200);

        const readSleep = await request({
            port,
            reqPath: '/api/get-sleep?begin=2026-11-01&end=2026-11-14',
            headers: { Cookie: medicoCookie }
        });
        assert.strictEqual(readSleep.status, 200);
    });

    it('valida fechas, campos de ánimo (incluyendo Madrugada), sueño y agenda', async () => {
        for (const ep of ['/api/get-moods', '/api/get-sleep']) {
            const missing = await request({ port, reqPath: ep, headers: { Cookie: adminCookie } });
            assert.strictEqual(missing.status, 400);
            const bad = await request({ port, reqPath: `${ep}?begin=14-11-2026&end=2026-11-14`, headers: { Cookie: adminCookie } });
            assert.strictEqual(bad.status, 400);
        }

        const badHex = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-mood',
            headers: { Cookie: adminCookie },
            body: { fecha: '2026-11-14', momento_dia: 'Madrugada', estado_animo: 'Tranquilo', color_hex: 'verde' }
        });
        assert.strictEqual(badHex.status, 400);

        const okMood = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-mood',
            headers: { Cookie: adminCookie },
            body: { fecha: '2026-11-14', momento_dia: 'Madrugada', estado_animo: 'Tranquilo', color_hex: '#4caf50' }
        });
        assert.strictEqual(okMood.status, 200);
        assert.strictEqual(moodInserts.length, 1);
        assert.strictEqual(moodInserts[0].momento_dia, 'Madrugada');

        const badSleep = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-sleep',
            headers: { Cookie: adminCookie },
            body: { fecha: '2026-11-14', horas: 30, calidad: 'Good' }
        });
        assert.strictEqual(badSleep.status, 400);

        const okSleep = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-sleep',
            headers: { Cookie: adminCookie },
            body: { fecha: '2026-11-14', horas: 7.5, calidad: 'Good' }
        });
        assert.strictEqual(okSleep.status, 200);

        const badAgenda = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-agenda',
            headers: { Cookie: adminCookie },
            body: { fecha: '2026-11-14', bloque: 'invalido', hora: '08:00', actividad: 'Test' }
        });
        assert.strictEqual(badAgenda.status, 400);

        const okAgenda = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-agenda',
            headers: { Cookie: adminCookie },
            body: { fecha: '2026-11-14', bloque: 'manana', hora: '08:00', actividad: 'Meditar' }
        });
        assert.strictEqual(okAgenda.status, 201);
        assert.strictEqual(JSON.parse(okAgenda.body).item.bloque, 'manana');
    });

    it('acota la cola /api/send-to-pc a 100 elementos y devuelve arreglo JSON compatible con sincronizador.py en /api/pull-text', async () => {
        for (let i = 1; i <= 100; i++) {
            const res = await request({
                port,
                method: 'POST',
                reqPath: '/api/send-to-pc',
                headers: { Cookie: adminCookie },
                body: { texto: `cipher-${i}` }
            });
            assert.strictEqual(res.status, 200, `Item ${i} debe aceptarse`);
        }

        const overflow = await request({
            port,
            method: 'POST',
            reqPath: '/api/send-to-pc',
            headers: { Cookie: adminCookie },
            body: { texto: 'cipher-101' }
        });
        assert.strictEqual(overflow.status, 429);

        const pull1 = await request({ port, reqPath: '/api/pull-text' });
        assert.strictEqual(pull1.status, 200);
        const list1 = JSON.parse(pull1.body);
        assert.strictEqual(Array.isArray(list1), true);
        assert.strictEqual(list1.length, 100);
        assert.strictEqual(list1[0], 'cipher-1');

        const pull2 = await request({ port, reqPath: '/api/pull-text' });
        assert.strictEqual(pull2.status, 200);
        assert.deepStrictEqual(JSON.parse(pull2.body), []);

        const afterDrain = await request({
            port,
            method: 'POST',
            reqPath: '/api/send-to-pc',
            headers: { Cookie: adminCookie },
            body: { texto: 'after-drain' }
        });
        assert.strictEqual(afterDrain.status, 200);
    });

    it('acota la cola /api/send-english a 100 elementos, aísla del journal y drena en /api/pull-english', async () => {
        const unauth = await request({
            port,
            method: 'POST',
            reqPath: '/api/send-english',
            body: { texto: 'unauth' }
        });
        assert.strictEqual(unauth.status, 401);

        const emptyPayload = await request({
            port,
            method: 'POST',
            reqPath: '/api/send-english',
            headers: { Cookie: adminCookie },
            body: {}
        });
        assert.strictEqual(emptyPayload.status, 400);

        for (let i = 1; i <= 100; i++) {
            const res = await request({
                port,
                method: 'POST',
                reqPath: '/api/send-english',
                headers: { Cookie: adminCookie },
                body: { texto: `english-cipher-${i}` }
            });
            assert.strictEqual(res.status, 200, `Item inglés ${i} debe aceptarse`);
        }

        const overflow = await request({
            port,
            method: 'POST',
            reqPath: '/api/send-english',
            headers: { Cookie: adminCookie },
            body: { texto: 'english-cipher-101' }
        });
        assert.strictEqual(overflow.status, 429);

        // La cola /api/pull-english NO debe mezclarse con /api/pull-text (solo tiene 'after-drain')
        const journalPull = await request({ port, reqPath: '/api/pull-text' });
        assert.strictEqual(journalPull.status, 200);
        assert.deepStrictEqual(JSON.parse(journalPull.body), ['after-drain']);

        const pull1 = await request({ port, reqPath: '/api/pull-english' });
        assert.strictEqual(pull1.status, 200);
        const list1 = JSON.parse(pull1.body);
        assert.strictEqual(Array.isArray(list1), true);
        assert.strictEqual(list1.length, 100);
        assert.strictEqual(list1[0], 'english-cipher-1');

        const pull2 = await request({ port, reqPath: '/api/pull-english' });
        assert.strictEqual(pull2.status, 200);
        assert.deepStrictEqual(JSON.parse(pull2.body), []);
    });

    it('evita envíos duplicados, aplica X-Idempotency-Key, detecta cola repetida y bloquea concurrencia en vuelo', async () => {
        // 1. Sleep: replay con misma X-Idempotency-Key devuelve 200 cacheado sin duplicar inserción y 409 sin clave
        const sleepCountBefore = sleepInserts.length;
        const sleepPayload = { fecha: '2026-11-15', horas: 8.25, calidad: 'Good' };

        const s1 = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-sleep',
            headers: { Cookie: adminCookie, 'X-Idempotency-Key': 'sleep-idem-key-1' },
            body: sleepPayload
        });
        assert.strictEqual(s1.status, 200);
        assert.strictEqual(sleepInserts.length, sleepCountBefore + 1);

        const sReplay = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-sleep',
            headers: { Cookie: adminCookie, 'X-Idempotency-Key': 'sleep-idem-key-1' },
            body: sleepPayload
        });
        assert.strictEqual(sReplay.status, 200);
        assert.strictEqual(sReplay.headers['x-idempotent-replay'], 'true');
        assert.strictEqual(sleepInserts.length, sleepCountBefore + 1);

        const sMismatch = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-sleep',
            headers: { Cookie: adminCookie, 'X-Idempotency-Key': 'sleep-idem-key-1' },
            body: { fecha: '2026-11-15', horas: 6, calidad: 'Regular' }
        });
        assert.strictEqual(sMismatch.status, 409);

        const sDup = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-sleep',
            headers: { Cookie: adminCookie, 'X-Idempotency-Key': 'sleep-idem-key-2' },
            body: sleepPayload
        });
        assert.strictEqual(sDup.status, 409);
        assert.strictEqual(sleepInserts.length, sleepCountBefore + 1);

        // 2. Agenda: replay 201 cacheado y bloqueo 409 de actividad idéntica repetida
        const agendaCountBefore = agendaInserts.length;
        const agendaPayload = { fecha: '2026-11-15', bloque: 'tarde', hora: '16:00', actividad: 'Practice Speaking' };

        const a1 = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-agenda',
            headers: { Cookie: adminCookie, 'X-Idempotency-Key': 'agenda-idem-key-1' },
            body: agendaPayload
        });
        assert.strictEqual(a1.status, 201);
        assert.strictEqual(agendaInserts.length, agendaCountBefore + 1);

        const aReplay = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-agenda',
            headers: { Cookie: adminCookie, 'X-Idempotency-Key': 'agenda-idem-key-1' },
            body: agendaPayload
        });
        assert.strictEqual(aReplay.status, 201);
        assert.strictEqual(aReplay.headers['x-idempotent-replay'], 'true');
        assert.strictEqual(agendaInserts.length, agendaCountBefore + 1);

        const aDup = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-agenda',
            headers: { Cookie: adminCookie },
            body: agendaPayload
        });
        assert.strictEqual(aDup.status, 409);
        assert.strictEqual(agendaInserts.length, agendaCountBefore + 1);

        // 3. Colas E2EE (/api/send-to-pc y /api/send-english): replay 200 y rechazo 409 de duplicados
        const pc1 = await request({
            port,
            method: 'POST',
            reqPath: '/api/send-to-pc',
            headers: { Cookie: adminCookie, 'X-Idempotency-Key': 'pc-idem-1' },
            body: { texto: 'cipher-unique-note' }
        });
        assert.strictEqual(pc1.status, 200);

        const pcReplay = await request({
            port,
            method: 'POST',
            reqPath: '/api/send-to-pc',
            headers: { Cookie: adminCookie, 'X-Idempotency-Key': 'pc-idem-1' },
            body: { texto: 'cipher-unique-note' }
        });
        assert.strictEqual(pcReplay.status, 200);
        assert.strictEqual(pcReplay.headers['x-idempotent-replay'], 'true');

        const pcDup = await request({
            port,
            method: 'POST',
            reqPath: '/api/send-to-pc',
            headers: { Cookie: adminCookie, 'X-Idempotency-Key': 'pc-idem-2' },
            body: { texto: 'cipher-unique-note' }
        });
        assert.strictEqual(pcDup.status, 409);

        const pcPull = await request({ port, reqPath: '/api/pull-text' });
        assert.deepStrictEqual(JSON.parse(pcPull.body), ['cipher-unique-note']);

        const eng1 = await request({
            port,
            method: 'POST',
            reqPath: '/api/send-english',
            headers: { Cookie: adminCookie, 'X-Idempotency-Key': 'eng-idem-1' },
            body: { texto: 'english-unique-entry' }
        });
        assert.strictEqual(eng1.status, 200);

        const engDup = await request({
            port,
            method: 'POST',
            reqPath: '/api/send-english',
            headers: { Cookie: adminCookie, 'X-Idempotency-Key': 'eng-idem-2' },
            body: { texto: 'english-unique-entry' }
        });
        assert.strictEqual(engDup.status, 409);

        const engPull = await request({ port, reqPath: '/api/pull-english' });
        assert.deepStrictEqual(JSON.parse(engPull.body), ['english-unique-entry']);

        // 4. Concurrencia simultánea en vuelo (bcrypt async): solo 1 procede y la 2ª recibe 409
        const medicoPayload = { nombre: 'Dra. Concurrencia', email: 'concurrencia@example.com', password: 'ClaveMedico2026!' };
        const [concA, concB] = await Promise.all([
            request({ port, method: 'POST', reqPath: '/api/auth/create-medico', headers: { Cookie: adminCookie }, body: medicoPayload }),
            request({ port, method: 'POST', reqPath: '/api/auth/create-medico', headers: { Cookie: adminCookie }, body: medicoPayload })
        ]);
        assert.deepStrictEqual([concA.status, concB.status].sort(), [200, 409]);

        // Cierre de sesión limpia la cookie y elimina sesión
        const logout = await request({ port, method: 'POST', reqPath: '/api/auth/logout', headers: { Cookie: adminCookie } });
        assert.strictEqual(logout.status, 200);
        const meAfterLogout = await request({ port, reqPath: '/api/auth/me', headers: { Cookie: adminCookie } });
        assert.strictEqual(meAfterLogout.status, 401);
    });

    it('cumple Checklist U2: estado de cuenta, anti-enumeración, validación estricta y errores controlados', async () => {
        // Re-iniciar sesión de admin para pruebas autenticadas
        const reLogin = await request({
            port,
            method: 'POST',
            reqPath: '/api/auth/login',
            body: { email: 'admin@example.com', password: 'ClavePrueba2026!' }
        });
        assert.strictEqual(reLogin.status, 200);
        const reCookie = `mt_session=${(reLogin.headers['set-cookie'] || []).join('; ').match(/mt_session=([^;]+)/)[1]}`;

        // 1. Manejo controlado de errores (JSON malformado -> 400, ruta inexistente -> 404 sin stack trace)
        const malformedJson = await new Promise((resolve, reject) => {
            const badPayload = '{maljson';
            const req = http.request(
                {
                    hostname: '127.0.0.1',
                    port,
                    path: '/api/auth/login',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(badPayload) }
                },
                (res) => {
                    const chunks = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
                }
            );
            req.on('error', reject);
            req.write(badPayload);
            req.end();
        });
        assert.strictEqual(malformedJson.status, 400);
        assert.strictEqual(malformedJson.body, 'Invalid JSON payload.');

        const notFoundApi = await request({ port, reqPath: '/api/ruta-inexistente' });
        assert.strictEqual(notFoundApi.status, 404);
        assert.strictEqual(notFoundApi.body, 'API endpoint not found.');

        // 2. Validación de campos vacíos, arreglo en vez de objeto, correo inválido y contraseña débil
        const emptyObj = await request({ port, method: 'POST', reqPath: '/api/auth/login', body: {} });
        assert.strictEqual(emptyObj.status, 400);

        const arrayBody = await request({ port, method: 'POST', reqPath: '/api/auth/login', body: ['a'] });
        assert.strictEqual(arrayBody.status, 400);

        const badEmail = await request({
            port,
            method: 'POST',
            reqPath: '/api/auth/create-medico',
            headers: { Cookie: reCookie },
            body: { nombre: 'Dr. Test', email: 'correo-invalido', password: 'Password2026!' }
        });
        assert.strictEqual(badEmail.status, 400);

        for (const weakPw of ['1234567', 'abcdefgh', '12345678']) {
            const weakRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/auth/create-medico',
                headers: { Cookie: reCookie },
                body: { nombre: 'Dr. Test', email: 'nuevo@example.com', password: weakPw }
            });
            assert.strictEqual(weakRes.status, 400, `Contraseña débil "${weakPw}" debe rechazarse`);
        }

        // 3. Anti-enumeración en login y forgot-password
        const nonExistentLogin = await request({
            port,
            method: 'POST',
            reqPath: '/api/auth/login',
            body: { email: 'noexiste@example.com', password: 'ClavePrueba2026!' }
        });
        const wrongPassLogin = await request({
            port,
            method: 'POST',
            reqPath: '/api/auth/login',
            body: { email: 'admin@example.com', password: 'WrongPassword1!' }
        });
        assert.strictEqual(nonExistentLogin.status, 401);
        assert.strictEqual(wrongPassLogin.status, 401);
        assert.strictEqual(nonExistentLogin.body, wrongPassLogin.body);

        const forgotKnown = await request({
            port,
            method: 'POST',
            reqPath: '/api/auth/forgot-password',
            body: { email: 'admin@example.com' }
        });
        const forgotUnknown = await request({
            port,
            method: 'POST',
            reqPath: '/api/auth/forgot-password',
            body: { email: 'desconocido@example.com' }
        });
        assert.strictEqual(forgotKnown.status, 200);
        assert.strictEqual(forgotUnknown.status, 200);
        assert.strictEqual(JSON.parse(forgotKnown.body).message, JSON.parse(forgotUnknown.body).message);

        // 4. Validación del estado de cuenta (suspendido/inactivo bloquea login y revoca sesiones vivas)
        const suspendedLogin = await request({
            port,
            method: 'POST',
            reqPath: '/api/auth/login',
            body: { email: 'suspendido@example.com', password: 'ClavePrueba2026!' }
        });
        assert.strictEqual(suspendedLogin.status, 403);

        const suspendMedico = await request({
            port,
            method: 'PATCH',
            reqPath: '/api/auth/medicos/2/estado',
            headers: { Cookie: reCookie },
            body: { estado: 'suspendido' }
        });
        assert.strictEqual(suspendMedico.status, 200);

        const medicoMeAfterSuspend = await request({ port, reqPath: '/api/auth/me', headers: { Cookie: medicoCookie } });
        assert.notStrictEqual(medicoMeAfterSuspend.status, 200);

        const medicoLoginWhileSuspended = await request({
            port,
            method: 'POST',
            reqPath: '/api/auth/login',
            body: { email: 'medico@example.com', password: 'ClavePrueba2026!' }
        });
        assert.strictEqual(medicoLoginWhileSuspended.status, 403);

        const reactivateMedico = await request({
            port,
            method: 'PATCH',
            reqPath: '/api/auth/medicos/2/estado',
            headers: { Cookie: reCookie },
            body: { estado: 'activo' }
        });
        assert.strictEqual(reactivateMedico.status, 200);

        const medicoLoginAfterReactivate = await request({
            port,
            method: 'POST',
            reqPath: '/api/auth/login',
            body: { email: 'medico@example.com', password: 'ClavePrueba2026!' }
        });
        assert.strictEqual(medicoLoginAfterReactivate.status, 200);
    });

    it('soporta Agenda Event/Task, categorías University/Personal, estados Jira (To Do/In Progress/Done), Configuración y Recordatorios con Snooze', async () => {
        // Re-iniciar sesión de admin limpio para pruebas de agenda/settings/reminders
        const reLogin = await request({
            port,
            method: 'POST',
            reqPath: '/api/auth/login',
            body: { email: 'admin@example.com', password: 'ClavePrueba2026!' }
        });
        assert.strictEqual(reLogin.status, 200);
        const tokenMatch = (reLogin.headers['set-cookie'] || []).join('; ').match(/mt_session=([^;]+)/);
        assert.ok(tokenMatch);
        adminCookie = `mt_session=${tokenMatch[1]}`;

        const medicoReLogin = await request({
            port,
            method: 'POST',
            reqPath: '/api/auth/login',
            body: { email: 'medico@example.com', password: 'ClavePrueba2026!' }
        });
        assert.strictEqual(medicoReLogin.status, 200);
        const medTokenMatch = (medicoReLogin.headers['set-cookie'] || []).join('; ').match(/mt_session=([^;]+)/);
        assert.ok(medTokenMatch);
        medicoCookie = `mt_session=${medTokenMatch[1]}`;

        // 1. Psiquiatra no debe acceder a settings ni reminders (RBAC 403)
        for (const restrictedPath of ['/api/settings', '/api/reminders/active']) {
            const forb = await request({ port, reqPath: restrictedPath, headers: { Cookie: medicoCookie } });
            assert.strictEqual(forb.status, 403, `${restrictedPath} debe bloquear a psiquiatra`);
        }

        // 2. Agenda: rechaza tipo/categoria/estado inválidos
        const badCat = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-agenda',
            headers: { Cookie: adminCookie },
            body: {
                fecha: '2026-11-16',
                bloque: 'cole',
                hora: '09:00',
                actividad: 'Test clase',
                tipo: 'evento',
                categoria: 'trabajo'
            }
        });
        assert.strictEqual(badCat.status, 400);

        const badJira = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-agenda',
            headers: { Cookie: adminCookie },
            body: {
                fecha: '2026-11-16',
                bloque: 'cole',
                hora: '09:00',
                actividad: 'Test tarea',
                tipo: 'tarea',
                categoria: 'universidad',
                estado: 'blocked'
            }
        });
        assert.strictEqual(badJira.status, 400);

        // 3. Crear tarea de Universidad (To Do) y transicionar Jira: todo -> in_progress -> done -> todo
        const createdTask = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-agenda',
            headers: { Cookie: adminCookie, 'X-Idempotency-Key': 'agenda-task-jira-1' },
            body: {
                fecha: '2026-11-16',
                bloque: 'cole',
                hora: '10:30',
                actividad: 'Finish Cloud Architecture Lab',
                tipo: 'tarea',
                categoria: 'universidad',
                estado: 'todo',
                recordatorio_min: 15
            }
        });
        assert.strictEqual(createdTask.status, 201);
        const taskJson = JSON.parse(createdTask.body);
        assert.strictEqual(taskJson.item.tipo, 'tarea');
        assert.strictEqual(taskJson.item.categoria, 'universidad');
        assert.strictEqual(taskJson.item.estado, 'todo');
        assert.strictEqual(taskJson.item.completada, 0);
        const taskId = taskJson.item.id;

        const toInProgress = await request({
            port,
            method: 'PATCH',
            reqPath: `/api/toggle-agenda/${taskId}`,
            headers: { Cookie: adminCookie },
            body: { estado: 'in_progress' }
        });
        assert.strictEqual(toInProgress.status, 200);
        assert.strictEqual(JSON.parse(toInProgress.body).estado, 'in_progress');
        assert.strictEqual(JSON.parse(toInProgress.body).completada, 0);

        const toDone = await request({
            port,
            method: 'PATCH',
            reqPath: `/api/toggle-agenda/${taskId}`,
            headers: { Cookie: adminCookie },
            body: { estado: 'done' }
        });
        assert.strictEqual(toDone.status, 200);
        assert.strictEqual(JSON.parse(toDone.body).estado, 'done');
        assert.strictEqual(JSON.parse(toDone.body).completada, 1);

        const toggleEmptyToTodo = await request({
            port,
            method: 'PATCH',
            reqPath: `/api/toggle-agenda/${taskId}`,
            headers: { Cookie: adminCookie },
            body: {}
        });
        assert.strictEqual(toggleEmptyToTodo.status, 200);
        assert.strictEqual(JSON.parse(toggleEmptyToTodo.body).estado, 'todo');
        assert.strictEqual(JSON.parse(toggleEmptyToTodo.body).completada, 0);

        const toggleEmptyBackDone = await request({
            port,
            method: 'PATCH',
            reqPath: `/api/toggle-agenda/${taskId}`,
            headers: { Cookie: adminCookie },
            body: {}
        });
        assert.strictEqual(toggleEmptyBackDone.status, 200);
        assert.strictEqual(JSON.parse(toggleEmptyBackDone.body).estado, 'done');
        assert.strictEqual(JSON.parse(toggleEmptyBackDone.body).completada, 1);

        const weekRead = await request({
            port,
            reqPath: '/api/get-agenda?begin=2026-11-16&end=2026-11-16',
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(weekRead.status, 200);
        const itemsList = JSON.parse(weekRead.body);
        const savedTask = itemsList.find((i) => i.id === taskId);
        assert.ok(savedTask);
        assert.strictEqual(savedTask.tipo, 'tarea');
        assert.strictEqual(savedTask.categoria, 'universidad');
        assert.strictEqual(savedTask.estado, 'done');

        // 3b. Estado Skip (skipped), Posponer (+días y fecha calendario) y fechas_repeticion
        const repCreate = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-agenda',
            headers: { Cookie: adminCookie, 'X-Idempotency-Key': 'agenda-repeat-dates-1' },
            body: {
                fecha: '2026-11-18',
                bloque: 'tarde',
                hora: '16:00',
                titulo: 'Repaso Algoritmos',
                descripcion: 'Aula R11',
                tipo: 'tarea',
                categoria: 'universidad',
                fechas_repeticion: ['2026-11-18', '2026-11-20', '2026-11-22']
            }
        });
        assert.strictEqual(repCreate.status, 201);
        const repJson = JSON.parse(repCreate.body);
        assert.strictEqual(repJson.repeatedCount, 3);
        assert.deepStrictEqual(repJson.createdDates, ['2026-11-18', '2026-11-20', '2026-11-22']);
        const repTaskId = repJson.item.id;

        const toSkipped = await request({
            port,
            method: 'PATCH',
            reqPath: `/api/toggle-agenda/${repTaskId}`,
            headers: { Cookie: adminCookie },
            body: { estado: 'skipped' }
        });
        assert.strictEqual(toSkipped.status, 200);
        assert.strictEqual(JSON.parse(toSkipped.body).estado, 'skipped');
        assert.strictEqual(JSON.parse(toSkipped.body).completada, 0);

        const postponePlus1 = await request({
            port,
            method: 'PATCH',
            reqPath: `/api/postpone-agenda/${repTaskId}`,
            headers: { Cookie: adminCookie },
            body: { days: 1 }
        });
        assert.strictEqual(postponePlus1.status, 200);
        const p1Json = JSON.parse(postponePlus1.body);
        assert.strictEqual(p1Json.previousFecha, '2026-11-18');
        assert.strictEqual(p1Json.fecha, '2026-11-19');
        assert.strictEqual(p1Json.estado, 'todo', 'Posponer una tarea omitida debe reactivarla en todo en la nueva fecha');

        const postponeTargetDate = await request({
            port,
            method: 'PATCH',
            reqPath: `/api/postpone-agenda/${repTaskId}`,
            headers: { Cookie: adminCookie },
            body: { targetDate: '2026-11-25' }
        });
        assert.strictEqual(postponeTargetDate.status, 200);
        assert.strictEqual(JSON.parse(postponeTargetDate.body).fecha, '2026-11-25');

        // 3c. Drag & Drop preventBackdate en PUT /api/update-agenda/:id (permite futuro + nueva hora, rechaza fecha anterior sin modificar)
        const addDaysIso = (delta) => {
            const d = new Date(Date.now() + (delta * 24 * 60 * 60 * 1000));
            return d.toISOString().slice(0, 10);
        };
        const dndSourceDate = addDaysIso(2);
        const dndFutureDate = addDaysIso(5);
        const dndEarlierDate = addDaysIso(1);

        const dndCreated = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-agenda',
            headers: { Cookie: adminCookie, 'X-Idempotency-Key': 'agenda-dnd-create-1' },
            body: {
                fecha: dndSourceDate,
                bloque: 'escuela',
                hora: '10:00',
                titulo: 'Entrega Arquitectura Cloud',
                descripcion: 'Laboratorio Sistemas',
                tipo: 'tarea',
                categoria: 'universidad',
                materia_nombre: 'Arquitectura de Computadoras',
                estado: 'in_progress',
                recordatorio_min: 30
            }
        });
        assert.strictEqual(dndCreated.status, 201);
        const dndItem = JSON.parse(dndCreated.body).item;
        assert.ok(dndItem && dndItem.id);

        const dndMoveForward = await request({
            port,
            method: 'PUT',
            reqPath: `/api/update-agenda/${dndItem.id}`,
            headers: { Cookie: adminCookie },
            body: {
                fecha: dndFutureDate,
                bloque: 'escuela',
                hora: '16:45',
                titulo: 'Entrega Arquitectura Cloud',
                descripcion: 'Laboratorio Sistemas',
                tipo: 'tarea',
                categoria: 'universidad',
                materia_nombre: 'Arquitectura de Computadoras',
                estado: 'in_progress',
                recordatorio_min: 30,
                preventBackdate: true
            }
        });
        assert.strictEqual(dndMoveForward.status, 200);
        const dndMovedBody = JSON.parse(dndMoveForward.body);
        assert.strictEqual(dndMovedBody.item.fecha, dndFutureDate);
        assert.strictEqual(dndMovedBody.item.hora, '16:45');
        assert.strictEqual(dndMovedBody.item.categoria, 'universidad');
        assert.strictEqual(dndMovedBody.item.materia_nombre, 'Arquitectura de Computadoras');
        assert.strictEqual(dndMovedBody.item.estado, 'in_progress');

        // Reordenamiento en el mismo día hacia hora más temprana y más tardía con preventBackdate: true
        const dndSameDayEarlier = await request({
            port,
            method: 'PUT',
            reqPath: `/api/update-agenda/${dndItem.id}`,
            headers: { Cookie: adminCookie },
            body: {
                fecha: dndFutureDate,
                bloque: 'escuela',
                hora: '08:20',
                titulo: 'Entrega Arquitectura Cloud',
                descripcion: 'Laboratorio Sistemas',
                tipo: 'tarea',
                categoria: 'universidad',
                materia_nombre: 'Arquitectura de Computadoras',
                estado: 'in_progress',
                recordatorio_min: 30,
                preventBackdate: true
            }
        });
        assert.strictEqual(dndSameDayEarlier.status, 200);
        const dndSameDayEarlierBody = JSON.parse(dndSameDayEarlier.body);
        assert.strictEqual(dndSameDayEarlierBody.item.fecha, dndFutureDate);
        assert.strictEqual(dndSameDayEarlierBody.item.hora, '08:20');

        const dndSameDayLater = await request({
            port,
            method: 'PUT',
            reqPath: `/api/update-agenda/${dndItem.id}`,
            headers: { Cookie: adminCookie },
            body: {
                fecha: dndFutureDate,
                bloque: 'escuela',
                hora: '16:45',
                titulo: 'Entrega Arquitectura Cloud',
                descripcion: 'Laboratorio Sistemas',
                tipo: 'tarea',
                categoria: 'universidad',
                materia_nombre: 'Arquitectura de Computadoras',
                estado: 'in_progress',
                recordatorio_min: 30,
                preventBackdate: true
            }
        });
        assert.strictEqual(dndSameDayLater.status, 200);
        const dndSameDayLaterBody = JSON.parse(dndSameDayLater.body);
        assert.strictEqual(dndSameDayLaterBody.item.fecha, dndFutureDate);
        assert.strictEqual(dndSameDayLaterBody.item.hora, '16:45');

        const dndMoveBackwards = await request({
            port,
            method: 'PUT',
            reqPath: `/api/update-agenda/${dndItem.id}`,
            headers: { Cookie: adminCookie },
            body: {
                fecha: dndEarlierDate,
                bloque: 'escuela',
                hora: '09:15',
                titulo: 'Entrega Arquitectura Cloud',
                descripcion: 'Laboratorio Sistemas',
                tipo: 'tarea',
                categoria: 'universidad',
                materia_nombre: 'Arquitectura de Computadoras',
                estado: 'in_progress',
                recordatorio_min: 30,
                preventBackdate: true
            }
        });
        assert.strictEqual(dndMoveBackwards.status, 400);

        const dndVerifyUnchanged = await request({
            port,
            reqPath: `/api/get-agenda?begin=${dndEarlierDate}&end=${dndFutureDate}`,
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(dndVerifyUnchanged.status, 200);
        const persistedDnd = JSON.parse(dndVerifyUnchanged.body).find((r) => r.id === dndItem.id);
        assert.ok(persistedDnd, 'La actividad debe seguir existiendo en RegistrosAgenda');
        assert.strictEqual(persistedDnd.fecha, dndFutureDate, 'Un intento rechazado con preventBackdate no debe alterar la fecha');
        assert.strictEqual(persistedDnd.hora, '16:45', 'Un intento rechazado con preventBackdate no debe alterar la hora');
        assert.strictEqual(persistedDnd.categoria, 'universidad');
        assert.strictEqual(persistedDnd.materia_nombre, 'Arquitectura de Computadoras');

        // 4. Configuración: verifica valores por defecto (English OFF, Madrugada OFF, Desktop OFF)
        const getDefaults = await request({ port, reqPath: '/api/settings', headers: { Cookie: adminCookie } });
        assert.strictEqual(getDefaults.status, 200);
        const defSettings = JSON.parse(getDefaults.body).settings;
        assert.strictEqual(defSettings.englishReminderEnabled, false);
        assert.strictEqual(defSettings.moodIncludeLateNight, false);
        assert.strictEqual(defSettings.desktopNotificationsEnabled, false);
        assert.strictEqual(defSettings.moodRemindersEnabled, true);
        assert.strictEqual(defSettings.sleepReminderEnabled, true);
        assert.strictEqual(defSettings.wordEodReminderEnabled, true);

        // Rechaza URLs SSRF / locales o habilitar ntfy sin tópico
        for (const badSettings of [
            { phoneNotificationsEnabled: true, ntfyTopic: '' },
            { ntfyServerUrl: 'http://ntfy.sh' },
            { ntfyServerUrl: 'https://127.0.0.1/topic' },
            { ntfyServerUrl: 'https://localhost/topic' },
            { timezone: 'Mars/Olympus_Mons' }
        ]) {
            const badRes = await request({
                port,
                method: 'PUT',
                reqPath: '/api/settings',
                headers: { Cookie: adminCookie },
                body: badSettings
            });
            assert.strictEqual(badRes.status, 400);
        }

        // Elegir dinámicamente una zona horaria IANA cuya hora local actual esté entre 08:00 y 12:59
        const candidateTzs = [
            'UTC', 'America/Mexico_City', 'America/Los_Angeles', 'Pacific/Honolulu',
            'America/Sao_Paulo', 'Asia/Dubai', 'Asia/Bangkok', 'Asia/Tokyo', 'Pacific/Auckland'
        ];
        const getTzHourAndDate = (tz) => {
            const parts = new Intl.DateTimeFormat('en-CA', {
                timeZone: tz,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23'
            }).formatToParts(new Date());
            const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
            return {
                tz,
                hour: Number(map.hour),
                dateStr: `${map.year}-${map.month}-${map.day}`
            };
        };
        const chosenTz = candidateTzs.map(getTzHourAndDate).find((x) => x.hour >= 8 && x.hour <= 12) || getTzHourAndDate('UTC');
        const dynamicEnglishTime = `${String(chosenTz.hour).padStart(2, '0')}:00`;
        const backupSleeps = sleepInserts.splice(0, sleepInserts.length);

        try {
            // Guardar configuración válida (activando English configurable en la hora local actual para prueba determinista)
            const saveSettingsRes = await request({
                port,
                method: 'PUT',
                reqPath: '/api/settings',
                headers: { Cookie: adminCookie },
                body: {
                    phoneNotificationsEnabled: false,
                    ntfyTopic: 'hub_flavio_test_99',
                    desktopNotificationsEnabled: false,
                    moodRemindersEnabled: true,
                    moodIncludeLateNight: false,
                    sleepReminderEnabled: true,
                    sleepReminderTime: '00:00',
                    wordEodReminderEnabled: true,
                    wordEodReminderTime: '00:00',
                    englishReminderEnabled: true,
                    englishReminderTime: dynamicEnglishTime,
                    englishReminderDays: [0, 1, 2, 3, 4, 5, 6],
                    englishReminderTopic: 'Practice 5 phrasal verbs',
                    defaultAgendaCategory: 'universidad',
                    youtubePlatformMode: 'auto',
                    timezone: chosenTz.tz
                }
            });
            assert.strictEqual(saveSettingsRes.status, 200);
            const savedSettings = JSON.parse(saveSettingsRes.body).settings;
            assert.strictEqual(savedSettings.englishReminderEnabled, true);
            assert.strictEqual(savedSettings.defaultAgendaCategory, 'universidad');
            assert.strictEqual(savedSettings.youtubePlatformMode, 'auto');

            const badYtModeRes = await request({
                port,
                method: 'PUT',
                reqPath: '/api/settings',
                headers: { Cookie: adminCookie },
                body: { youtubePlatformMode: 'invalid_mode' }
            });
            assert.strictEqual(badYtModeRes.status, 400);

            // 5. Recordatorios activos + Snooze (posponer) + seguridad de token de acción
            const activeRes = await request({ port, reqPath: '/api/reminders/active', headers: { Cookie: adminCookie } });
            assert.strictEqual(activeRes.status, 200);
            const remData = JSON.parse(activeRes.body);
            assert.ok(Array.isArray(remData.active));
            assert.ok(Array.isArray(remData.snoozed));
            const sleepRem = remData.active.find((r) => r.type === 'sleep');
            const wordRem = remData.active.find((r) => r.type === 'word');
            const engRem = remData.active.find((r) => r.type === 'english');
            assert.ok(sleepRem, `Debe aparecer recordatorio de sueño configurable (tz=${chosenTz.tz}, hour=${chosenTz.hour})`);
            assert.ok(wordRem, 'Debe aparecer recordatorio de cierre del día para notas Word');
            assert.ok(engRem, 'Debe aparecer recordatorio personalizado de inglés al activarlo');

            const snoozeRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/reminders/snooze',
                headers: { Cookie: adminCookie },
                body: {
                    key: sleepRem.key,
                    action: 'snooze',
                    minutes: 30,
                    type: sleepRem.type,
                    title: sleepRem.title,
                    message: sleepRem.message
                }
            });
            assert.strictEqual(snoozeRes.status, 200);

            const afterSnoozeRes = await request({ port, reqPath: '/api/reminders/active', headers: { Cookie: adminCookie } });
            assert.strictEqual(afterSnoozeRes.status, 200);
            const afterSnooze = JSON.parse(afterSnoozeRes.body);
            assert.ok(afterSnooze.snoozed.some((s) => s.key === sleepRem.key), 'El recordatorio pospuesto debe pasar a snoozed');
            assert.equal(afterSnooze.active.some((a) => a.key === sleepRem.key), false, 'El recordatorio pospuesto no debe seguir activo');

            const badActionToken = await request({
                port,
                method: 'POST',
                reqPath: '/api/reminders/action?token=forged-token-123'
            });
            assert.strictEqual(badActionToken.status, 401);

            // 6. Envío push de prueba vía ntfy JSON API (evita error ByteString en headers y genera click/actions desde publicBaseUrl)
            const originalFetch = globalThis.fetch;
            let capturedPush = null;
            globalThis.fetch = async (url, options) => {
                capturedPush = { url, options };
                return {
                    ok: true,
                    status: 200,
                    text: async () => '{"id":"test123"}'
                };
            };
            try {
                const testPushRes = await request({
                    port,
                    method: 'POST',
                    reqPath: '/api/settings/test-notification',
                    headers: { Cookie: adminCookie },
                    body: {
                        ntfyServerUrl: 'https://ntfy.sh',
                        ntfyTopic: 'hub_flavio_test_99',
                        ntfyPriority: 4,
                        publicBaseUrl: 'http://203.0.113.10:3000'
                    }
                });
                assert.strictEqual(testPushRes.status, 200);
                assert.ok(capturedPush, 'Debe invocar fetch hacia ntfy');
                assert.strictEqual(capturedPush.url, 'https://ntfy.sh/');
                assert.strictEqual(capturedPush.options.method, 'POST');
                for (const [hdrName, hdrVal] of Object.entries(capturedPush.options.headers || {})) {
                    const strVal = String(hdrVal);
                    for (let i = 0; i < strVal.length; i++) {
                        assert.ok(strVal.charCodeAt(i) <= 255, `Header ${hdrName} debe ser ByteString ASCII/Latin1`);
                    }
                }
                const pushBody = JSON.parse(capturedPush.options.body);
                assert.strictEqual(pushBody.topic, 'hub_flavio_test_99');
                assert.strictEqual(pushBody.title, 'Personal Daily Hub - Phone Connected');
                assert.strictEqual(pushBody.priority, 4);
                assert.strictEqual(pushBody.click, 'http://203.0.113.10:3000/#settings');
                assert.ok(Array.isArray(pushBody.actions) && pushBody.actions.length === 3, 'ntfy debe mostrar Open App, Snooze 15m y Skip');
                assert.strictEqual(pushBody.actions[0].url, 'http://203.0.113.10:3000/#settings');
                assert.strictEqual(pushBody.actions[1].label, 'Snooze 15m');
                assert.strictEqual(pushBody.actions[1].action, 'http');
                assert.strictEqual(pushBody.actions[2].label, 'Skip');
                assert.strictEqual(pushBody.actions[2].action, 'http');

                // Simular clic en Snooze 15m y Skip directamente sobre /api/reminders/action desde el celular
                const snoozeUrlObj = new URL(pushBody.actions[1].url);
                const snoozeActRes = await request({
                    port,
                    method: 'POST',
                    reqPath: `${snoozeUrlObj.pathname}${snoozeUrlObj.search}`
                });
                assert.strictEqual(snoozeActRes.status, 200);
                assert.strictEqual(JSON.parse(snoozeActRes.body).action, 'snoozed');

                const skipUrlObj = new URL(pushBody.actions[2].url);
                const skipActRes = await request({
                    port,
                    method: 'POST',
                    reqPath: `${skipUrlObj.pathname}${skipUrlObj.search}`
                });
                assert.strictEqual(skipActRes.status, 200);
                assert.strictEqual(JSON.parse(skipActRes.body).action, 'skipped');

                // También verificar Snooze + Skip desde /api/reminders/snooze sobre un recordatorio activo
                const sleepKey = sleepRem.key;
                const skipInAppRes = await request({
                    port,
                    method: 'POST',
                    reqPath: '/api/reminders/snooze',
                    headers: { Cookie: adminCookie },
                    body: {
                        key: sleepKey,
                        action: 'skip',
                        type: 'sleep',
                        title: sleepRem.title || 'Sleep Reminder'
                    }
                });
                assert.strictEqual(skipInAppRes.status, 200);
                assert.strictEqual(JSON.parse(skipInAppRes.body).action, 'skipped');
            } finally {
                globalThis.fetch = originalFetch;
            }
        } finally {
            sleepInserts.push(...backupSleeps);
        }
    });

    it('recalcula hora/fecha/bloque al posponer por minutos/horas en Agenda y recorre tareas reales al hacer snooze en notificaciones', async () => {
        const formatTzParts = (dt, tz) => {
            const parts = new Intl.DateTimeFormat('en-US', {
                timeZone: tz,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            }).formatToParts(dt);
            const map = {};
            parts.forEach((p) => { map[p.type] = p.value; });
            const h = Number(map.hour) % 24;
            const m = Number(map.minute) || 0;
            return {
                fecha: `${map.year}-${map.month}-${map.day}`,
                hora: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
                hour: h
            };
        };

        const testTz = 'America/Monterrey';
        await request({
            port,
            method: 'PUT',
            reqPath: '/api/settings',
            headers: { Cookie: adminCookie },
            body: {
                timezone: testTz,
                agendaRemindersEnabled: true,
                agendaNotifyTasks: true
            }
        });

        const nowLocal = formatTzParts(new Date(), testTz);

        // 1. Tarea personal de hoy pospuesta +30 min desde /api/postpone-agenda/:id
        const createTodayPersonal = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-agenda',
            headers: { Cookie: adminCookie, 'X-Idempotency-Key': 'agenda-postpone-mins-1' },
            body: {
                fecha: nowLocal.fecha,
                bloque: 'manana',
                hora: '08:00',
                titulo: 'Llamada bancaria',
                tipo: 'tarea',
                categoria: 'personal'
            }
        });
        assert.strictEqual(createTodayPersonal.status, 201);
        const personalTaskId = JSON.parse(createTodayPersonal.body).item.id;

        const beforePostpone = Date.now();
        const postpone30 = await request({
            port,
            method: 'PATCH',
            reqPath: `/api/postpone-agenda/${personalTaskId}`,
            headers: { Cookie: adminCookie },
            body: { offsetMinutes: 30 }
        });
        const afterPostpone = Date.now();
        assert.strictEqual(postpone30.status, 200);
        const p30Json = JSON.parse(postpone30.body);

        const exp1 = formatTzParts(new Date(beforePostpone + 30 * 60 * 1000), testTz);
        const exp2 = formatTzParts(new Date(afterPostpone + 30 * 60 * 1000), testTz);
        assert.ok(p30Json.hora === exp1.hora || p30Json.hora === exp2.hora, `hora esperada ${exp1.hora}/${exp2.hora}, obtenida ${p30Json.hora}`);
        assert.ok(p30Json.fecha === exp1.fecha || p30Json.fecha === exp2.fecha);
        const expectedHour = Number(p30Json.hora.split(':')[0]);
        const expectedPersonalBlock = expectedHour < 12 ? 'manana' : (expectedHour < 19 ? 'tarde' : 'noche');
        assert.strictEqual(p30Json.bloque, expectedPersonalBlock);

        // 2. Tarea futura a las 23:30 pospuesta +90 min cruza medianoche al día siguiente a las 01:00
        const futureBaseDt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
        const futureDateStr = formatTzParts(futureBaseDt, testTz).fecha;
        const futureNextStr = formatTzParts(new Date(futureBaseDt.getTime() + 24 * 60 * 60 * 1000), testTz).fecha;

        const createFuturePersonal = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-agenda',
            headers: { Cookie: adminCookie, 'X-Idempotency-Key': 'agenda-postpone-mins-future' },
            body: {
                fecha: futureDateStr,
                bloque: 'noche',
                hora: '23:30',
                titulo: 'Lectura nocturna',
                tipo: 'tarea',
                categoria: 'personal'
            }
        });
        assert.strictEqual(createFuturePersonal.status, 201);
        const futureTaskId = JSON.parse(createFuturePersonal.body).item.id;

        const postponeCrossMidnight = await request({
            port,
            method: 'PATCH',
            reqPath: `/api/postpone-agenda/${futureTaskId}`,
            headers: { Cookie: adminCookie },
            body: { offsetMinutes: 90 }
        });
        assert.strictEqual(postponeCrossMidnight.status, 200);
        const crossJson = JSON.parse(postponeCrossMidnight.body);
        assert.strictEqual(crossJson.fecha, futureNextStr);
        assert.strictEqual(crossJson.hora, '01:00');
        assert.strictEqual(crossJson.bloque, 'manana');

        // 3. POST /api/reminders/snooze sobre recordatorio tipo agenda recorre la tarea real en RegistrosAgenda
        const beforeSnooze = Date.now();
        const remSnoozeRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/reminders/snooze',
            headers: { Cookie: adminCookie },
            body: {
                key: `agenda:${personalTaskId}:${p30Json.fecha}`,
                action: 'snooze',
                minutes: 15,
                type: 'agenda',
                refId: personalTaskId,
                title: '[Personal Task] Llamada bancaria',
                message: 'Llamada bancaria'
            }
        });
        const afterSnooze = Date.now();
        assert.strictEqual(remSnoozeRes.status, 200);
        const remSnoozeJson = JSON.parse(remSnoozeRes.body);
        assert.strictEqual(remSnoozeJson.action, 'snoozed');
        assert.strictEqual(remSnoozeJson.rescheduled, true);

        const sExp1 = formatTzParts(new Date(beforeSnooze + 15 * 60 * 1000), testTz);
        const sExp2 = formatTzParts(new Date(afterSnooze + 15 * 60 * 1000), testTz);
        assert.ok(remSnoozeJson.newHora === sExp1.hora || remSnoozeJson.newHora === sExp2.hora);
        assert.ok(remSnoozeJson.newFecha === sExp1.fecha || remSnoozeJson.newFecha === sExp2.fecha);

        const persistedPersonal = agendaInserts.find((a) => a.id === personalTaskId);
        assert.strictEqual(persistedPersonal.hora, remSnoozeJson.newHora);
        assert.strictEqual(persistedPersonal.fecha, remSnoozeJson.newFecha);
        assert.strictEqual(persistedPersonal.bloque, remSnoozeJson.newBloque);
        assert.strictEqual(reminderStatesMap.get(`1:agenda:${personalTaskId}:${remSnoozeJson.newFecha}`)?.estado, 'snoozed');

        // 4. POST /api/reminders/action (action=snooze) sobre tarea universitaria preserva categoria/escuela/materia
        const createUniTask = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-agenda',
            headers: { Cookie: adminCookie, 'X-Idempotency-Key': 'agenda-postpone-uni-1' },
            body: {
                fecha: nowLocal.fecha,
                bloque: 'escuela',
                hora: '10:00',
                titulo: 'Entrega Proyecto Redes',
                tipo: 'tarea',
                categoria: 'universidad',
                materia_nombre: 'Redes Avanzadas'
            }
        });
        assert.strictEqual(createUniTask.status, 201);
        const uniTaskId = JSON.parse(createUniTask.body).item.id;

        const beforeActionSnooze = Date.now();
        const actionSnoozeRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/reminders/action',
            headers: { Cookie: adminCookie },
            body: {
                key: `agenda:${uniTaskId}:${nowLocal.fecha}`,
                action: 'snooze',
                minutes: 15,
                type: 'agenda',
                refId: uniTaskId,
                title: '[Redes Avanzadas Task] Entrega Proyecto Redes',
                message: 'Entrega Proyecto Redes'
            }
        });
        const afterActionSnooze = Date.now();
        assert.strictEqual(actionSnoozeRes.status, 200);
        const actionJson = JSON.parse(actionSnoozeRes.body);
        assert.strictEqual(actionJson.action, 'snoozed');
        assert.strictEqual(actionJson.rescheduled, true);

        const uExp1 = formatTzParts(new Date(beforeActionSnooze + 15 * 60 * 1000), testTz);
        const uExp2 = formatTzParts(new Date(afterActionSnooze + 15 * 60 * 1000), testTz);
        assert.ok(actionJson.newHora === uExp1.hora || actionJson.newHora === uExp2.hora);
        assert.strictEqual(actionJson.newBloque, 'escuela');

        const persistedUni = agendaInserts.find((a) => a.id === uniTaskId);
        assert.strictEqual(persistedUni.categoria, 'universidad');
        assert.strictEqual(persistedUni.bloque, 'escuela');
        assert.strictEqual(persistedUni.materia_nombre, 'Redes Avanzadas');
        assert.strictEqual(persistedUni.hora, actionJson.newHora);
    });

    it('gestiona catálogo Learn with Music por artistas/colaboraciones/mini álbumes, valida YouTube Music y aísla notas en Word E2EE', async () => {
        // 1. RBAC: psiquiatra no puede acceder al módulo personal de English Music
        const psychCatalogRes = await request({ port, reqPath: '/api/english/music/catalog', headers: { Cookie: medicoCookie } });
        assert.strictEqual(psychCatalogRes.status, 403);

        const psychCreateRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/english/music/songs',
            headers: { Cookie: medicoCookie },
            body: { titulo: 'DRIP', mainArtist: 'BABYMONSTER' }
        });
        assert.strictEqual(psychCreateRes.status, 403);

        // 2. Búsqueda asistida hacia la cuenta del usuario en YouTube Music + bloqueo SSRF en resolve
        const searchRes = await request({
            port,
            reqPath: '/api/english/music/search?q=BABYMONSTER%20DRIP',
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(searchRes.status, 200);
        const searchJson = JSON.parse(searchRes.body);
        assert.strictEqual(searchJson.ytMusicSearchUrl, 'https://music.youtube.com/search?q=BABYMONSTER%20DRIP');
        assert.strictEqual(searchJson.ytMusicLibraryUrl, 'https://music.youtube.com/library');
        assert.strictEqual(searchJson.youtubeSearchUrl, 'https://www.youtube.com/results?search_query=BABYMONSTER%20DRIP');
        assert.strictEqual(searchJson.youtubeHomeUrl, 'https://www.youtube.com/');

        // 2b. Despojar &list=... de un track para nunca alterar playlists personales y devolver ambas URLs (PC vs Móvil)
        const trackWithListRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/english/music/resolve',
            headers: { Cookie: adminCookie },
            body: { url: 'https://music.youtube.com/watch?v=ekr2nIex040&list=PL_user_personal_playlist_123' }
        });
        assert.strictEqual(trackWithListRes.status, 200);
        const trackWithList = JSON.parse(trackWithListRes.body);
        assert.strictEqual(trackWithList.ytMusicUrl, 'https://music.youtube.com/watch?v=ekr2nIex040');
        assert.strictEqual(trackWithList.youtubeUrl, 'https://www.youtube.com/watch?v=ekr2nIex040');

        const ssrfResolveRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/english/music/resolve',
            headers: { Cookie: adminCookie },
            body: { url: 'https://evil.example.com/watch?v=ekr2nIex040' }
        });
        assert.strictEqual(ssrfResolveRes.status, 400);

        const credUrlRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/english/music/resolve',
            headers: { Cookie: adminCookie },
            body: { url: 'https://user:pass@music.youtube.com/watch?v=ekr2nIex040' }
        });
        assert.strictEqual(credUrlRes.status, 400);

        const strippedBrowseRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/english/music/resolve',
            headers: { Cookie: adminCookie },
            body: { url: 'https://music.youtube.com/browse/MPREb_test?authuser=0&si=secrettracking' }
        });
        assert.strictEqual(strippedBrowseRes.status, 200);
        assert.strictEqual(JSON.parse(strippedBrowseRes.body).ytMusicUrl, 'https://music.youtube.com/browse/MPREb_test');

        // 3. Guardrail anti-letras en MySQL (>255 chars o >4 líneas rechazado en metadatos)
        const lyricsInDbAttempt = await request({
            port,
            method: 'POST',
            reqPath: '/api/english/music/songs',
            headers: { Cookie: adminCookie },
            body: {
                titulo: 'Test Lyrics Guard',
                mainArtist: 'BLACKPINK',
                enfoqueCorto: 'A'.repeat(260)
            }
        });
        assert.strictEqual(lyricsInDbAttempt.status, 400);

        // 4. Registrar colaboración (ROSÉ x Bruno Mars) y Mini Álbum (BABYMONSTER - BABYMONS7ER)
        const createCollabRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/english/music/songs',
            headers: { Cookie: adminCookie },
            body: {
                titulo: 'APT.',
                mainArtist: 'ROSÉ',
                artistType: 'solo',
                collaborators: 'Bruno Mars',
                albumTitle: 'APT.',
                albumType: 'collab_single',
                albumYear: 2024,
                ytMusicUrl: 'https://youtu.be/ekr2nIex040',
                enfoqueCorto: 'Slang & casual phrases in fast conversation'
            }
        });
        assert.strictEqual(createCollabRes.status, 201);
        const createdCollab = JSON.parse(createCollabRes.body);
        assert.strictEqual(createdCollab.ytMusicUrl, 'https://music.youtube.com/watch?v=ekr2nIex040');
        assert.strictEqual(createdCollab.youtubeUrl, 'https://www.youtube.com/watch?v=ekr2nIex040');

        const createMiniAlbumRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/english/music/songs',
            headers: { Cookie: adminCookie },
            body: {
                titulo: 'SHEESH',
                mainArtist: 'BABYMONSTER',
                artistType: 'group',
                albumTitle: 'BABYMONS7ER',
                albumType: 'mini_album',
                albumYear: 2024,
                trackNumber: 2,
                ytMusicUrl: 'https://www.youtube.com/watch?v=2wA_b6YHjqQ',
                enfoqueCorto: 'Expressions of surprise & confident idioms'
            }
        });
        assert.strictEqual(createMiniAlbumRes.status, 201);
        const miniSongId = JSON.parse(createMiniAlbumRes.body).songId;

        // 5. Consultar catálogo y verificar artistas, colaboraciones y mini álbum
        const catalogRes = await request({ port, reqPath: '/api/english/music/catalog', headers: { Cookie: adminCookie } });
        assert.strictEqual(catalogRes.status, 200);
        const catalog = JSON.parse(catalogRes.body);
        assert.strictEqual(catalog.stats.totalSongs, 2);
        assert.strictEqual(catalog.stats.totalArtists, 3);
        const aptSong = catalog.songs.find((s) => s.titulo === 'APT.');
        assert.ok(aptSong);
        assert.strictEqual(aptSong.yt_music_url, 'https://music.youtube.com/watch?v=ekr2nIex040');
        assert.strictEqual(aptSong.youtube_url, 'https://www.youtube.com/watch?v=ekr2nIex040');
        assert.strictEqual(aptSong.artists.length, 2);
        assert.ok(aptSong.artists.some((a) => a.nombre === 'ROSÉ' && a.rol === 'main'));
        assert.ok(aptSong.artists.some((a) => a.nombre === 'Bruno Mars' && a.rol === 'collab'));
        const sheeshSong = catalog.songs.find((s) => s.id === miniSongId);
        assert.ok(sheeshSong);
        assert.strictEqual(sheeshSong.album_tipo, 'mini_album');

        // 6. Actualizar estado + Word synced y enviar notas largas cifradas E2EE solo a cola Word (no MySQL)
        const patchRes = await request({
            port,
            method: 'PATCH',
            reqPath: `/api/english/music/songs/${miniSongId}/status`,
            headers: { Cookie: adminCookie },
            body: { estadoEstudio: 'mastered', wordSynced: true }
        });
        assert.strictEqual(patchRes.status, 200);
        const patched = JSON.parse(patchRes.body);
        assert.strictEqual(patched.estado_estudio, 'mastered');
        assert.strictEqual(patched.word_sincronizado, true);

        const e2eeCipher = 'ivhex123:encrypted-song-lyrics-and-meaning-notes';
        const queueRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/send-english',
            headers: { Cookie: adminCookie },
            body: { texto: e2eeCipher }
        });
        assert.strictEqual(queueRes.status, 200);

        const pullRes = await request({ port, reqPath: '/api/pull-english' });
        assert.strictEqual(pullRes.status, 200);
        const pulled = JSON.parse(pullRes.body);
        assert.ok(pulled.includes(e2eeCipher));

        // 7. Editar metadatos y eliminar canción del catálogo
        const updateRes = await request({
            port,
            method: 'PUT',
            reqPath: `/api/english/music/songs/${miniSongId}`,
            headers: { Cookie: adminCookie },
            body: {
                titulo: 'SHEESH (Live Encore)',
                mainArtist: 'BABYMONSTER',
                artistType: 'group',
                collaborators: 'feat. Rami',
                albumTitle: 'BABYMONS7ER',
                albumType: 'mini_album',
                albumYear: 2024
            }
        });
        assert.strictEqual(updateRes.status, 200);

        const delRes = await request({
            port,
            method: 'DELETE',
            reqPath: `/api/english/music/songs/${miniSongId}`,
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(delRes.status, 200);

        const afterDelRes = await request({ port, reqPath: '/api/english/music/catalog', headers: { Cookie: adminCookie } });
        const afterDel = JSON.parse(afterDelRes.body);
        assert.strictEqual(afterDel.stats.totalSongs, 1);
    });

    it('gestiona Horario ITS por semestre, croquis de aulas (R02/R11/N21), vacaciones, residencias, trabajo, auto-bloque de agenda y rutas con tráfico', async () => {
        // 1. RBAC: psiquiatra no puede acceder al planificador académico/laboral
        const psychPlannerRes = await request({ port, reqPath: '/api/planner', headers: { Cookie: medicoCookie } });
        assert.strictEqual(psychPlannerRes.status, 403);

        // 2. Obtener planificador inicial limpio (sin materias precargadas ni mindboxPreset) y directorio del croquis
        const getPlannerRes = await request({ port, reqPath: '/api/planner', headers: { Cookie: adminCookie } });
        assert.strictEqual(getPlannerRes.status, 200);
        const plannerBody = JSON.parse(getPlannerRes.body);
        assert.ok(plannerBody.planner);
        assert.ok(plannerBody.campusDirectory);
        assert.ok(plannerBody.campusDirectory.principal);
        assert.ok(plannerBody.campusDirectory.miravalle);
        assert.ok(plannerBody.campusDirectory.boillot);
        assert.strictEqual(plannerBody.planner.activeSemesterId, 'sem-9no-2026');
        assert.strictEqual(plannerBody.planner.semesters[0].courses.length, 0, 'El planificador inicial debe iniciar sin materias precargadas');
        assert.strictEqual(plannerBody.mindboxPreset, undefined, 'GET /api/planner no debe exponer mindboxPreset');

        // 3. Resolver aulas del croquis oficial del ITS (R02/R11 -> Boillot CTO-004, N21 -> Miravalle CTO-003, S14 -> Principal CTO-002)
        const roomR02Res = await request({
            port,
            method: 'POST',
            reqPath: '/api/planner/resolve-room',
            headers: { Cookie: adminCookie },
            body: { room: 'R02' }
        });
        assert.strictEqual(roomR02Res.status, 200);
        const r02 = JSON.parse(roomR02Res.body).resolved;
        assert.strictEqual(r02.campusKey, 'boillot');
        assert.strictEqual(r02.croquisCode, 'CTO-004');

        const roomN21Res = await request({
            port,
            method: 'POST',
            reqPath: '/api/planner/resolve-room',
            headers: { Cookie: adminCookie },
            body: { room: 'N21' }
        });
        assert.strictEqual(roomN21Res.status, 200);
        const n21 = JSON.parse(roomN21Res.body).resolved;
        assert.strictEqual(n21.campusKey, 'miravalle');
        assert.strictEqual(n21.croquisCode, 'CTO-003');

        // 4. Calcular tiempo de traslado en carro y escalonamiento inteligente (En Casa / Lejos vs Cerca)
        // 4a. Lejos de Casa y lejos del campus (away -> [T + 30, T + 25, ..., >0])
        const farLocRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/planner/location',
            headers: { Cookie: adminCookie },
            body: { mapsUrl: '25.380000, -101.020000', label: 'Punto Externo Sur Saltillo' }
        });
        assert.strictEqual(farLocRes.status, 200);
        const farData = JSON.parse(farLocRes.body);
        assert.ok(Array.isArray(farData.commutes) && farData.commutes.length >= 3);
        const farPrincipal = farData.commutes.find((c) => c.campusKey === 'principal');
        assert.strictEqual(farPrincipal.isNearCampus, false);
        assert.strictEqual(farPrincipal.commuteZone, 'away');
        const expectedFarSeq = [];
        for (let m = farPrincipal.driveMinutesWithTraffic + 30; m > 0; m -= 5) expectedFarSeq.push(m);
        assert.deepStrictEqual(farPrincipal.alertMilestones, expectedFarSeq);
        assert.strictEqual(farPrincipal.recommendedLeadMinutes, farPrincipal.driveMinutesWithTraffic + 30);
        assert.ok(farPrincipal.mapsDirectionsUrl.includes('google.com/maps/dir/'));

        // 4b. En Casa (home -> [T + 30, T + 25, ..., >0])
        const homeLocRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/planner/location',
            headers: { Cookie: adminCookie },
            body: { target: 'home', mapsUrl: '25.380000, -101.020000', label: 'Mi Casa Sur' }
        });
        assert.strictEqual(homeLocRes.status, 200);
        const homeData = JSON.parse(homeLocRes.body);
        const homePrincipal = homeData.commutes.find((c) => c.campusKey === 'principal');
        const homeDriveT = homePrincipal.driveMinutesWithTraffic;
        assert.strictEqual(homePrincipal.commuteZone, 'home');
        assert.strictEqual(homePrincipal.isAtHome, true);
        const expectedHomeSeq = [];
        for (let m = homeDriveT + 30; m > 0; m -= 5) expectedHomeSeq.push(m);
        assert.deepStrictEqual(homePrincipal.alertMilestones, expectedHomeSeq);
        assert.strictEqual(homePrincipal.recommendedLeadMinutes, homeDriveT + 30);

        // 4c. Cerca del campus (near -> únicamente [20, 15, 10], recommendedLeadMinutes = 20)
        const nearLocRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/planner/location',
            headers: { Cookie: adminCookie },
            body: { lat: 25.4438, lng: -100.9939, label: 'En el Tec de Saltillo' }
        });
        assert.strictEqual(nearLocRes.status, 200);
        const nearData = JSON.parse(nearLocRes.body);
        assert.strictEqual(nearData.planner.locations.current.label, 'En el Tec de Saltillo');
        const nearPrincipal = nearData.commutes.find((c) => c.campusKey === 'principal');
        assert.strictEqual(nearPrincipal.isNearCampus, true);
        assert.strictEqual(nearPrincipal.commuteZone, 'near');
        assert.deepStrictEqual(nearPrincipal.alertMilestones, [20, 15, 10]);
        assert.strictEqual(nearPrincipal.recommendedLeadMinutes, 20, 'Si ya está en o cerca del ITS debe notificar a los 20, 15 y 10 minutos antes');

        const embedMapsRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/planner/location',
            headers: { Cookie: adminCookie },
            body: {
                mapsUrl: 'https://www.google.com/maps/place/ITS/@25.443706,-100.993845,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d25.44395!4d-100.98965',
                label: 'Campus Boillot'
            }
        });
        assert.strictEqual(embedMapsRes.status, 200);

        // 5. Agenda: separación de título y descripción + auto-selección de bloque del día a partir de la hora
        const insertSeparatedRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-agenda',
            headers: { Cookie: adminCookie },
            body: {
                fecha: '2026-11-16',
                hora: '14:30',
                titulo: 'Software Engineering Sprint Review',
                descripcion: 'Present continuous deployment pipeline in room LC2',
                tipo: 'tarea',
                categoria: 'universidad',
                estado: 'todo'
            }
        });
        assert.strictEqual(insertSeparatedRes.status, 201);
        const insertedBody = JSON.parse(insertSeparatedRes.body).item;
        assert.strictEqual(insertedBody.bloque, 'cole', 'Con hora 14:30 y categoría universidad debe auto-seleccionar bloque cole');
        assert.strictEqual(insertedBody.titulo, 'Software Engineering Sprint Review');
        assert.strictEqual(insertedBody.descripcion, 'Present continuous deployment pipeline in room LC2');
        assert.ok(insertedBody.actividad.includes('Software Engineering Sprint Review — Present continuous deployment pipeline'));

        // Guardar materias de prueba para validar sincronización semanal, vacaciones y vínculo materia_id
        const plannerBeforeCourses = JSON.parse((await request({ port, reqPath: '/api/planner', headers: { Cookie: adminCookie } })).body).planner;
        plannerBeforeCourses.semesters[0].courses = [
            {
                id: 'its-test-1',
                code: 'ACA0910',
                name: 'Taller de Investigación II',
                teacher: 'Docente Prueba',
                group: 'B',
                room: 'R02',
                campusId: 'boillot',
                days: [1, 2, 3, 4],
                startTime: '09:00',
                endTime: '10:00'
            },
            {
                id: 'its-test-2',
                code: 'DED2504',
                name: 'Integración y Despliegue Continuos',
                teacher: 'Docente Prueba 2',
                group: 'A',
                room: 'R11',
                campusId: 'boillot',
                days: [1, 2, 3, 4, 5],
                startTime: '14:00',
                endTime: '15:00'
            }
        ];
        const seedCoursesRes = await request({
            port,
            method: 'PUT',
            reqPath: '/api/planner',
            headers: { Cookie: adminCookie },
            body: { planner: plannerBeforeCourses }
        });
        assert.strictEqual(seedCoursesRes.status, 200);

        // 6. Sincronizar horario ITS a la Agenda Semanal (respetando vacaciones)
        const syncRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/planner/sync-agenda',
            headers: { Cookie: adminCookie },
            body: { weekStartDate: '2026-11-16' }
        });
        assert.strictEqual(syncRes.status, 200);
        const syncBody = JSON.parse(syncRes.body);
        assert.ok(syncBody.inserted >= 5, 'Debe sincronizar las clases de la semana a la agenda');

        // Si sincronizamos en semana de vacaciones (2026-03-30 Semana Santa), no debe insertar clases
        const syncVacRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/planner/sync-agenda',
            headers: { Cookie: adminCookie },
            body: { weekStartDate: '2026-03-30' }
        });
        assert.strictEqual(syncVacRes.status, 200);
        const syncVacBody = JSON.parse(syncVacRes.body);
        assert.strictEqual(syncVacBody.inserted, 0, 'Durante periodo de vacaciones no debe programar clases');

        // 7. Vincular tarea universitaria con clase actual y limpiar automáticamente si cambia a Personal
        const plannerForTask = JSON.parse((await request({ port, reqPath: '/api/planner', headers: { Cookie: adminCookie } })).body).planner;
        const activeCourse = plannerForTask.semesters[0].courses[0];
        assert.ok(activeCourse && activeCourse.id && activeCourse.name);

        const badClassTask = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-agenda',
            headers: { Cookie: adminCookie },
            body: {
                fecha: '2026-11-18',
                hora: '11:00',
                titulo: 'Entrega Unidad 2',
                tipo: 'tarea',
                categoria: 'universidad',
                materia_id: 'curso-inexistente-999'
            }
        });
        assert.strictEqual(badClassTask.status, 400);

        const classTaskRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-agenda',
            headers: { Cookie: adminCookie },
            body: {
                fecha: '2026-11-18',
                hora: '11:15',
                titulo: 'Práctica de Laboratorio 2',
                tipo: 'tarea',
                categoria: 'universidad',
                materia_id: activeCourse.id,
                estado: 'todo'
            }
        });
        assert.strictEqual(classTaskRes.status, 201);
        const classTaskItem = JSON.parse(classTaskRes.body).item;
        assert.strictEqual(classTaskItem.materia_id, activeCourse.id);
        assert.strictEqual(classTaskItem.materia_nombre, activeCourse.name);

        const readClassAgenda = JSON.parse((await request({
            port,
            reqPath: '/api/get-agenda?begin=2026-11-18&end=2026-11-18',
            headers: { Cookie: adminCookie }
        })).body);
        const fetchedClassTask = readClassAgenda.find((i) => i.id === classTaskItem.id);
        assert.ok(fetchedClassTask);
        assert.strictEqual(fetchedClassTask.materia_id, activeCourse.id);
        assert.strictEqual(fetchedClassTask.materia_nombre, activeCourse.name);

        const toPersonalRes = await request({
            port,
            method: 'PUT',
            reqPath: `/api/update-agenda/${classTaskItem.id}`,
            headers: { Cookie: adminCookie },
            body: {
                fecha: '2026-11-18',
                bloque: 'tarde',
                hora: '18:00',
                titulo: 'Mandado personal',
                tipo: 'tarea',
                categoria: 'personal',
                materia_id: activeCourse.id,
                materia_nombre: activeCourse.name,
                estado: 'todo'
            }
        });
        assert.strictEqual(toPersonalRes.status, 200);
        const personalItem = JSON.parse(toPersonalRes.body).item;
        assert.strictEqual(personalItem.categoria, 'personal');
        assert.strictEqual(personalItem.materia_id, null);
        assert.strictEqual(personalItem.materia_nombre, null);

        // 8. Crear un segundo semestre y luego eliminarlo vía PUT /api/planner, validando activeSemesterId y fallback si queda vacío
        const baseForSemOps = JSON.parse((await request({ port, reqPath: '/api/planner', headers: { Cookie: adminCookie } })).body).planner;
        const withTwoSemesters = {
            ...baseForSemOps,
            activeSemesterId: 'sem-10mo-2027',
            semesters: [
                baseForSemOps.semesters[0],
                {
                    id: 'sem-10mo-2027',
                    name: '10mo Semestre · Residencias',
                    termCode: '2027-1',
                    startDate: '2027-01-18',
                    endDate: '2027-06-04',
                    active: true,
                    courses: []
                }
            ]
        };
        const addSemRes = await request({
            port,
            method: 'PUT',
            reqPath: '/api/planner',
            headers: { Cookie: adminCookie },
            body: { planner: withTwoSemesters }
        });
        assert.strictEqual(addSemRes.status, 200);

        const afterAddSem = JSON.parse((await request({ port, reqPath: '/api/planner', headers: { Cookie: adminCookie } })).body).planner;
        assert.strictEqual(afterAddSem.semesters.length, 2);
        assert.strictEqual(afterAddSem.activeSemesterId, 'sem-10mo-2027');

        const afterDeletePayload = {
            ...afterAddSem,
            activeSemesterId: afterAddSem.semesters[0].id,
            semesters: [afterAddSem.semesters[0]]
        };
        const delSemRes = await request({
            port,
            method: 'PUT',
            reqPath: '/api/planner',
            headers: { Cookie: adminCookie },
            body: { planner: afterDeletePayload }
        });
        assert.strictEqual(delSemRes.status, 200);

        const afterDelSem = JSON.parse((await request({ port, reqPath: '/api/planner', headers: { Cookie: adminCookie } })).body).planner;
        assert.strictEqual(afterDelSem.semesters.length, 1);
        assert.strictEqual(afterDelSem.activeSemesterId, 'sem-9no-2026');
        assert.strictEqual(afterDelSem.semesters[0].courses.length, 2, 'Al eliminar el 2° semestre debe conservar las materias del semestre restante');

        // Si se envía semesters: [] el backend asegura el semestre por defecto vacío y activeSemesterId válido
        const emptySemRes = await request({
            port,
            method: 'PUT',
            reqPath: '/api/planner',
            headers: { Cookie: adminCookie },
            body: { planner: { ...afterDelSem, semesters: [] } }
        });
        assert.strictEqual(emptySemRes.status, 200);
        const afterEmptySem = JSON.parse((await request({ port, reqPath: '/api/planner', headers: { Cookie: adminCookie } })).body).planner;
        assert.strictEqual(afterEmptySem.semesters.length, 1);
        assert.strictEqual(afterEmptySem.semesters[0].courses.length, 0);
        assert.strictEqual(afterEmptySem.activeSemesterId, afterEmptySem.semesters[0].id);

        // 9. Flujo ntfy OK (action=ack) y reemplazo automático de etapas previas en traslado a clases
        const candidateTzs = [
            'UTC', 'America/Monterrey', 'Europe/London', 'Europe/Berlin', 'Asia/Dubai',
            'Asia/Karachi', 'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Tokyo',
            'Pacific/Auckland', 'America/Anchorage', 'America/Los_Angeles', 'America/Sao_Paulo'
        ];
        const getTzMinOfDay = (tz) => {
            const parts = new Intl.DateTimeFormat('en-US', {
                timeZone: tz,
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23'
            }).formatToParts(new Date());
            const hr = Number(parts.find((p) => p.type === 'hour')?.value || 0);
            const mn = Number(parts.find((p) => p.type === 'minute')?.value || 0);
            return (hr * 60) + mn;
        };
        const safeMiddayTz =
            candidateTzs.find((tz) => {
                const m = getTzMinOfDay(tz);
                return (m >= 9 * 60 + 20 && m <= 12 * 60 + 10) || (m >= 15 * 60 + 20 && m <= 16 * 60 + 40);
            }) ||
            candidateTzs.find((tz) => {
                const m = getTzMinOfDay(tz);
                return m >= 8 * 60 && m <= 20 * 60;
            }) ||
            'UTC';
        const prevSettingsForAck = JSON.parse((await request({ port, reqPath: '/api/settings', headers: { Cookie: adminCookie } })).body).settings || {};
        await request({
            port,
            method: 'PUT',
            reqPath: '/api/settings',
            headers: { Cookie: adminCookie },
            body: {
                timezone: safeMiddayTz,
                phoneNotificationsEnabled: true,
                ntfyServerUrl: 'https://ntfy.sh',
                ntfyTopic: 'hub_commute_ack_test',
                publicBaseUrl: 'http://203.0.113.10:3000'
            }
        });

        // Limpiar GPS en vivo para que el origen sea Casa guardada (zona 'home' -> [T+20, T+10, T, 10])
        const resetHomeRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/planner/location',
            headers: { Cookie: adminCookie },
            body: { target: 'clear_current' }
        });
        assert.strictEqual(resetHomeRes.status, 200);
        const baseCommuteInfo = JSON.parse(resetHomeRes.body).commutes.find((c) => c.campusKey === 'principal');
        const driveT = baseCommuteInfo.driveMinutesWithTraffic;

        const nowProbeRes = await request({ port, reqPath: '/api/reminders/active', headers: { Cookie: adminCookie } });
        const localNowInfo = JSON.parse(nowProbeRes.body).localNow;
        const toHHMM = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

        // Etapa 1: faltan (driveT + 28) min -> activa el hito (driveT + 30)
        const stage1StartMin = localNowInfo.minutesOfDay + driveT + 28;
        const plannerStage1 = JSON.parse(resetHomeRes.body).planner;
        plannerStage1.classRemindersEnabled = true;
        plannerStage1.vacations = [];
        plannerStage1.semesters[0].startDate = '2020-01-01';
        plannerStage1.semesters[0].endDate = '2030-12-31';
        plannerStage1.semesters[0].courses = [{
            id: 'ack-course-1',
            code: 'ITS901',
            name: 'Arquitectura Cloud',
            room: 'A01',
            campusId: 'principal',
            days: [0, 1, 2, 3, 4, 5, 6],
            startTime: toHHMM(stage1StartMin),
            endTime: toHHMM(stage1StartMin + 60)
        }];
        await request({
            port,
            method: 'PUT',
            reqPath: '/api/planner',
            headers: { Cookie: adminCookie },
            body: { planner: plannerStage1 }
        });

        const origFetchAck = globalThis.fetch;
        const pushedPayloads = [];
        globalThis.fetch = async (url, options) => {
            pushedPayloads.push({ url, body: JSON.parse(options.body) });
            return { ok: true, status: 200, text: async () => '{"id":"ok1"}' };
        };
        try {
            const remStage1Res = await request({
                port,
                reqPath: '/api/reminders/active?dispatchPush=1',
                headers: { Cookie: adminCookie }
            });
            assert.strictEqual(remStage1Res.status, 200);
            const remStage1 = JSON.parse(remStage1Res.body).active.find((r) => r.type === 'class' && r.ackKey?.includes('ack-course-1'));
            assert.ok(remStage1, 'Debe emitir recordatorio de traslado en el primer hito');
            assert.strictEqual(remStage1.stageMin, driveT + 30);
            assert.ok(remStage1.key.endsWith(`:m${driveT + 30}`));

            const classPush1 = pushedPayloads.find((p) => p.body.title && p.body.title.includes('Arquitectura Cloud'));
            assert.ok(classPush1, 'Debe enviar push ntfy para la clase');
            assert.strictEqual(classPush1.body.actions[0].label, 'OK');
            assert.strictEqual(classPush1.body.actions[0].action, 'http');
            assert.ok(classPush1.body.actions[0].url.includes('action=ack'));
            assert.strictEqual(classPush1.body.actions[1].label, 'Google Maps Route');
            assert.strictEqual(classPush1.body.actions[2].label, 'Open App');

            // Etapa 2 (sin pulsar OK): faltan (driveT + 22) min -> avanza al siguiente hito (driveT + 25) y borra el anterior
            const stage2LeadOffset = driveT + 22;
            const expectedStage2 = driveT + 25;
            plannerStage1.semesters[0].courses[0].startTime = toHHMM(localNowInfo.minutesOfDay + stage2LeadOffset);
            plannerStage1.semesters[0].courses[0].endTime = toHHMM(localNowInfo.minutesOfDay + stage2LeadOffset + 60);
            await request({
                port,
                method: 'PUT',
                reqPath: '/api/planner',
                headers: { Cookie: adminCookie },
                body: { planner: plannerStage1 }
            });

            pushedPayloads.length = 0;
            const remStage2Res = await request({
                port,
                reqPath: '/api/reminders/active?dispatchPush=1',
                headers: { Cookie: adminCookie }
            });
            assert.strictEqual(remStage2Res.status, 200);
            const classActives2 = JSON.parse(remStage2Res.body).active.filter((r) => r.type === 'class' && r.ackKey?.includes('ack-course-1'));
            assert.strictEqual(classActives2.length, 1, 'Solo debe existir la notificación del hito actual');
            assert.strictEqual(classActives2[0].stageMin, expectedStage2);
            assert.strictEqual(reminderStatesMap.has(`1:${remStage1.key}`), false, 'El hito anterior debe eliminarse automáticamente de RecordatoriosEstado');
            assert.strictEqual(reminderStatesMap.has(`1:${classActives2[0].key}`), true);
            assert.ok(pushedPayloads.some((p) => p.body.title && p.body.title.includes('Arquitectura Cloud')), 'Al no pulsar OK debe enviar push del nuevo hito');

            // Etapa 3: usuario pulsa botón OK desde ntfy -> silencia todos los hitos restantes hoy
            const okUrlObj = new URL(classPush1.body.actions[0].url);
            const ackHttpRes = await request({
                port,
                method: 'POST',
                reqPath: `${okUrlObj.pathname}${okUrlObj.search}`
            });
            assert.strictEqual(ackHttpRes.status, 200);
            const ackBody = JSON.parse(ackHttpRes.body);
            assert.strictEqual(ackBody.action, 'acknowledged');

            // Incluso acercando la clase a 5 min (hito 10 min), ya no notifica ni aparece en activos
            plannerStage1.semesters[0].courses[0].startTime = toHHMM(localNowInfo.minutesOfDay + 5);
            plannerStage1.semesters[0].courses[0].endTime = toHHMM(localNowInfo.minutesOfDay + 65);
            await request({
                port,
                method: 'PUT',
                reqPath: '/api/planner',
                headers: { Cookie: adminCookie },
                body: { planner: plannerStage1 }
            });

            pushedPayloads.length = 0;
            const remAfterAckRes = await request({
                port,
                reqPath: '/api/reminders/active?dispatchPush=1',
                headers: { Cookie: adminCookie }
            });
            assert.strictEqual(remAfterAckRes.status, 200);
            const classAfterAck = JSON.parse(remAfterAckRes.body).active.filter((r) => r.type === 'class' && r.ackKey?.includes('ack-course-1'));
            assert.strictEqual(classAfterAck.length, 0, 'Tras confirmar OK no debe volver a mostrar ni enviar avisos para esa clase hoy');
            assert.strictEqual(pushedPayloads.some((p) => p.body.title && p.body.title.includes('Arquitectura Cloud')), false);

            // Dejar planificador limpio sin materias para los siguientes tests
            plannerStage1.semesters[0].courses = [];
            await request({
                port,
                method: 'PUT',
                reqPath: '/api/planner',
                headers: { Cookie: adminCookie },
                body: { planner: plannerStage1 }
            });
        } finally {
            globalThis.fetch = origFetchAck;
            await request({
                port,
                method: 'PUT',
                reqPath: '/api/settings',
                headers: { Cookie: adminCookie },
                body: {
                    timezone: prevSettingsForAck.timezone || 'America/Monterrey',
                    phoneNotificationsEnabled: Boolean(prevSettingsForAck.phoneNotificationsEnabled),
                    ntfyServerUrl: prevSettingsForAck.ntfyServerUrl || 'https://ntfy.sh',
                    ntfyTopic: prevSettingsForAck.ntfyTopic || '',
                    publicBaseUrl: prevSettingsForAck.publicBaseUrl || ''
                }
            });
        }
    });

    it('soporta túnel de transporte cifrado X25519 + AES-256-CTR + HMAC-SHA256 para grandes volúmenes, rechaza manipulación/replay y expone Studio Multilingüe EN/KR/K-Pop', async () => {
        const clientTC = require('../public/transport-crypto');
        const tunnel = clientTC.createClientTunnel();
        const kp = clientTC.generateX25519KeyPair();

        // 1. Handshake asimétrico X25519 efímero con el servidor HTTP
        const hsRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/transport/handshake',
            body: { clientPub: Buffer.from(kp.publicKey).toString('base64') }
        });
        assert.strictEqual(hsRes.status, 200);
        const hsJson = JSON.parse(hsRes.body);
        assert.strictEqual(hsJson.protocol, 'x25519-aes256ctr-hmac-v1');
        tunnel.deriveSessionFromHandshake(kp.privateKey, hsJson);

        // 2. Payload grande (192 KB) viajando cifrado en petición Y respuesta (sin texto plano en red)
        const bigText = 'K-POP-ENCRYPTED-STREAM-'.repeat(8550); // ~196 KB
        assert.ok(bigText.length >= 190000);
        const envBig = tunnel.encryptText(JSON.stringify({ samplePayload: bigText, echo: false }));
        assert.ok(!envBig.ct.includes('K-POP-ENCRYPTED-STREAM'), 'El texto plano no debe viajar visible en ciphertext');

        const benchRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/transport/benchmark',
            headers: {
                Cookie: adminCookie,
                'X-Transport-Session': hsJson.kid,
                'X-Transport-Accept-Enc': '1'
            },
            body: envBig
        });
        assert.strictEqual(benchRes.status, 200);
        assert.strictEqual(benchRes.headers['x-transport-encrypted'], 'x25519-aes256ctr-hmac-v1');
        const encBenchEnv = JSON.parse(benchRes.body);
        assert.strictEqual(encBenchEnv.__enc, 'x25519-aes256ctr-hmac-v1');
        const decBench = JSON.parse(tunnel.decryptEnvelope(encBenchEnv, 's2c'));
        assert.strictEqual(decBench.encryptedIn, true);
        assert.ok(decBench.payloadBytes >= 190000);

        // 3. Defensa Encrypt-then-MAC contra manipulación del paquete (MITM bit-flip) y Replay
        const tamperedEnv = { ...envBig, ct: `${envBig.ct.slice(0, -4)}AAAA` };
        const tamperedRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/transport/benchmark',
            headers: { Cookie: adminCookie, 'X-Transport-Session': hsJson.kid },
            body: tamperedEnv
        });
        assert.strictEqual(tamperedRes.status, 400);
        assert.strictEqual(JSON.parse(tamperedRes.body).code, 'TRANSPORT_MAC_INVALID');

        const replayRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/transport/benchmark',
            headers: { Cookie: adminCookie, 'X-Transport-Session': hsJson.kid },
            body: envBig
        });
        assert.strictEqual(replayRes.status, 409);
        assert.strictEqual(JSON.parse(replayRes.body).code, 'TRANSPORT_REPLAY');

        // 4. Registro multilingüe, Romanización Hangul algorítmica y Analizador K-Pop EN+KR cifrado en tránsito
        const regRes = await request({
            port,
            reqPath: '/api/language/registry',
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(regRes.status, 200);
        const regJson = JSON.parse(regRes.body);
        assert.ok(regJson.languages.some((l) => l.id === 'ko'));
        assert.ok(regJson.languages.some((l) => l.id === 'en_ko'));

        const romRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/language/romanize',
            headers: { Cookie: adminCookie },
            body: { text: '사랑해 마음에 없어' }
        });
        assert.strictEqual(romRes.status, 200);
        assert.strictEqual(JSON.parse(romRes.body).romanization, 'saranghae maeume eopseo');

        const analyzeEnv = tunnel.encryptText(JSON.stringify({
            text: "I wanna hold on\n영원히 너의 마음에",
            language: 'en_ko',
            songTitle: 'Golden Hour',
            mode: 'offline'
        }));
        const analyzeRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/language/analyze',
            headers: {
                Cookie: adminCookie,
                'X-Transport-Session': hsJson.kid,
                'X-Transport-Accept-Enc': '1'
            },
            body: analyzeEnv
        });
        assert.strictEqual(analyzeRes.status, 200);
        const analyzeJson = JSON.parse(tunnel.decryptEnvelope(JSON.parse(analyzeRes.body), 's2c'));
        assert.strictEqual(analyzeJson.engine, 'local-linguistic');
        assert.strictEqual(analyzeJson.language, 'en_ko');
        assert.ok(analyzeJson.lines.some((l) => l.romanization.includes('yeongwonhi')));
        assert.ok(analyzeJson.vocabulary.some((v) => v.term === 'hold on' || v.term === '영원히'));
        assert.ok(analyzeJson.languageMemory && Array.isArray(analyzeJson.languageMemory.terms));
        assert.ok(analyzeJson.languageMemory.terms.length >= 1, 'Debe guardar vocabulario aprendido en languageMemory');

        // 4b. Consistencia de memoria de IA: al volver a estudiar una palabra ya vista, la recuerda de languageMemory
        const addMemRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/language/memory',
            headers: { Cookie: adminCookie },
            body: {
                terms: [{
                    term: '별빛',
                    romanization: 'byeolbit',
                    meaning: 'Starlight / Luz de las estrellas (saved by student)',
                    category: 'vocabulary',
                    language: 'ko'
                }]
            }
        });
        assert.strictEqual(addMemRes.status, 200);

        const secondAnalyzeRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/language/analyze',
            headers: { Cookie: adminCookie },
            body: {
                text: '밤하늘의 별빛 아래에서 hold on',
                language: 'en_ko',
                mode: 'offline'
            }
        });
        assert.strictEqual(secondAnalyzeRes.status, 200);
        const secondAnalyzeJson = JSON.parse(secondAnalyzeRes.body);
        assert.ok(
            Array.isArray(secondAnalyzeJson.recognizedFromMemory) &&
            secondAnalyzeJson.recognizedFromMemory.some((m) => m.term === '별빛' && m.meaning.includes('Starlight')),
            'La IA debe recordar términos aprendidos previamente y mantener su definición consistente'
        );
        assert.ok(
            secondAnalyzeJson.vocabulary.some((v) => v.term === '별빛' && v.learnedPreviously === true),
            'El vocabulario devuelto debe marcar learnedPreviously=true para palabras ya estudiadas'
        );

        // 4c. Recordatorios activos incluyen targetDate y targetMoment para autoseleccionar fecha y bloque al tocar la notificación
        const remCheckRes = await request({
            port,
            method: 'GET',
            reqPath: '/api/reminders/active',
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(remCheckRes.status, 200);
        const remCheckJson = JSON.parse(remCheckRes.body);
        if (Array.isArray(remCheckJson.active)) {
            for (const rem of remCheckJson.active) {
                if (rem.type === 'mood') {
                    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(rem.targetDate), 'Mood reminder debe incluir targetDate YYYY-MM-DD');
                    assert.ok(rem.targetMoment, 'Mood reminder debe incluir targetMoment');
                }
            }
        }

        // 5. Gemini API Key se guarda en ConfiguracionUsuario pero nunca se devuelve en texto plano en GET/PUT settings
        const saveAiSettingsRes = await request({
            port,
            method: 'PUT',
            reqPath: '/api/settings',
            headers: { Cookie: adminCookie },
            body: {
                preferredStudyLanguage: 'ko',
                geminiModel: 'gemini-2.5-pro',
                geminiApiKey: 'AIzaSyFakeIntegrationKey987654'
            }
        });
        assert.strictEqual(saveAiSettingsRes.status, 200);
        const savedSetJson = JSON.parse(saveAiSettingsRes.body).settings;
        assert.strictEqual(savedSetJson.preferredStudyLanguage, 'ko');
        assert.strictEqual(savedSetJson.geminiModel, 'gemini-2.5-pro');
        assert.strictEqual(savedSetJson.geminiApiKeyConfigured, true);
        assert.strictEqual(savedSetJson.geminiApiKey, undefined, 'La API key cruda nunca debe exponerse al cliente');
        assert.ok(savedSetJson.geminiApiKeyHint.startsWith('AIza'));
    });

    it('permite registrar crisis en español, las expone en modo solo lectura al psiquiatra y reconoce el repertorio musical en la IA', async () => {
        // 1. Admin registra crisis con fecha, hora, tipo, intensidad y motivo en español
        const createCrisisRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-crisis',
            headers: { Cookie: adminCookie },
            body: {
                fecha: '2026-11-14',
                hora: '21:15',
                tipoCrisis: 'Estrés',
                intensidad: 4,
                motivo: 'Sobrecarga por entregas de proyecto y falta de descanso.'
            }
        });
        assert.strictEqual(createCrisisRes.status, 200);
        const createdCrisis = JSON.parse(createCrisisRes.body);
        assert.strictEqual(createdCrisis.ok, true);
        assert.ok(createdCrisis.id > 0);

        // 2. Tanto admin como psiquiatra (solo lectura) pueden consultar las crisis de la semana
        const medicoCrisisRes = await request({
            port,
            method: 'GET',
            reqPath: '/api/get-crisis?begin=2026-11-08&end=2026-11-14',
            headers: { Cookie: medicoCookie }
        });
        assert.strictEqual(medicoCrisisRes.status, 200);
        const medicoCrisisList = JSON.parse(medicoCrisisRes.body);
        assert.ok(
            Array.isArray(medicoCrisisList) &&
            medicoCrisisList.some((c) => c.tipo_crisis === 'Estrés' && c.motivo.includes('Sobrecarga por entregas')),
            'El psiquiatra debe poder leer las crisis registradas'
        );

        // 3. Psiquiatra no puede insertar ni borrar crisis (RBAC 403)
        const medicoWriteCrisisRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-crisis',
            headers: { Cookie: medicoCookie },
            body: {
                fecha: '2026-11-14',
                hora: '21:30',
                tipoCrisis: 'Ira / Rabia',
                intensidad: 3,
                motivo: 'Intento bloqueado por RBAC'
            }
        });
        assert.strictEqual(medicoWriteCrisisRes.status, 403);

        const medicoDelCrisisRes = await request({
            port,
            method: 'DELETE',
            reqPath: `/api/delete-crisis/${createdCrisis.id}`,
            headers: { Cookie: medicoCookie }
        });
        assert.strictEqual(medicoDelCrisisRes.status, 403);

        // 4. IA de idiomas reconoce canciones ya registradas en el catálogo musical del usuario
        const addSongRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/english/music/songs',
            headers: { Cookie: adminCookie },
            body: {
                titulo: 'DRIP',
                mainArtist: 'BABYMONSTER',
                mainArtistType: 'group',
                albumTitle: 'DRIP',
                albumType: 'album',
                albumYear: 2024,
                idioma: 'English + Korean (K-Pop)',
                enfoqueCorto: 'Chorus idioms & rapid transitions'
            }
        });
        assert.ok([200, 201].includes(addSongRes.status));

        const aiRepertoireRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/language/analyze',
            headers: { Cookie: adminCookie },
            body: {
                text: 'BABYMONSTER DRIP\n너의 마음에 닿기를',
                question: 'Explain this song from my repertoire',
                language: 'en_ko',
                mode: 'offline'
            }
        });
        assert.strictEqual(aiRepertoireRes.status, 200);
        const aiRepJson = JSON.parse(aiRepertoireRes.body);
        assert.ok(
            Array.isArray(aiRepJson.matchedRepertoireSongs) &&
            aiRepJson.matchedRepertoireSongs.some((s) => s.titulo === 'DRIP'),
            'La IA debe reconocer canciones registradas en el repertorio del usuario'
        );

        // 5. Idempotencia / anti-doble-click en crisis y eliminación del registro
        const crisisIdemKey = `crisis-idem-${Date.now()}`;
        const crisisIdemBody = {
            fecha: '2026-11-14',
            hora: '22:10',
            tipoCrisis: 'Estrés',
            intensidad: 3,
            motivo: 'Prueba idempotencia en episodio.'
        };
        const crisis1 = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-crisis',
            headers: { Cookie: adminCookie, 'X-Idempotency-Key': crisisIdemKey },
            body: crisisIdemBody
        });
        assert.strictEqual(crisis1.status, 200);
        const crisisReplay = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-crisis',
            headers: { Cookie: adminCookie, 'X-Idempotency-Key': crisisIdemKey },
            body: crisisIdemBody
        });
        assert.strictEqual(crisisReplay.status, 200);
        assert.strictEqual(crisisReplay.headers['x-idempotent-replay'], 'true');
        const crisisDupSameWindow = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-crisis',
            headers: { Cookie: adminCookie },
            body: crisisIdemBody
        });
        assert.strictEqual(crisisDupSameWindow.status, 409);

        const delCrisisRes = await request({
            port,
            method: 'DELETE',
            reqPath: `/api/delete-crisis/${createdCrisis.id}`,
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(delCrisisRes.status, 200);
    });

    it('permite configurar crisisEpisodeTypes vía PUT /api/settings, preserva tipos al guardar otros ajustes y los acepta en POST /api/insert-crisis', async () => {
        const beforeRes = await request({ port, reqPath: '/api/settings', headers: { Cookie: adminCookie } });
        assert.strictEqual(beforeRes.status, 200);
        const prevSettings = JSON.parse(beforeRes.body).settings;
        const originalTypes = Array.isArray(prevSettings.crisisEpisodeTypes) ? prevSettings.crisisEpisodeTypes : [];
        assert.ok(originalTypes.length >= 10, 'Debe existir catálogo inicial predeterminado de crisisEpisodeTypes');

        const customTypeLabel = 'Sobrecarga Sensorial Test';
        const updatedTypes = [
            ...originalTypes,
            { id: 'sobrecarga_sensorial_test', label: customTypeLabel, icon: '😵' }
        ];

        const saveCustomRes = await request({
            port,
            method: 'PUT',
            reqPath: '/api/settings',
            headers: { Cookie: adminCookie },
            body: { crisisEpisodeTypes: updatedTypes }
        });
        assert.strictEqual(saveCustomRes.status, 200);
        const savedSettings = JSON.parse(saveCustomRes.body).settings;
        assert.ok(
            Array.isArray(savedSettings.crisisEpisodeTypes) &&
            savedSettings.crisisEpisodeTypes.some((t) => t.label === customTypeLabel && t.icon === '😵'),
            'PUT /api/settings debe guardar el tipo de crisis personalizado'
        );

        // Guardar otro ajuste general sin enviar crisisEpisodeTypes no debe borrar el tipo personalizado
        const partialSaveRes = await request({
            port,
            method: 'PUT',
            reqPath: '/api/settings',
            headers: { Cookie: adminCookie },
            body: { agendaShowWeekend: true }
        });
        assert.strictEqual(partialSaveRes.status, 200);
        const partialSettings = JSON.parse(partialSaveRes.body).settings;
        assert.ok(
            partialSettings.crisisEpisodeTypes.some((t) => t.label === customTypeLabel),
            'Guardar otros ajustes no debe sobrescribir crisisEpisodeTypes'
        );

        // Registrar episodio usando el nuevo tipo personalizado
        const insertCustomRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-crisis',
            headers: { Cookie: adminCookie },
            body: {
                fecha: '2026-11-15',
                hora: '18:45',
                tipoCrisis: customTypeLabel,
                intensidad: 4,
                motivo: 'Ruido intenso en entorno de prueba.'
            }
        });
        assert.strictEqual(insertCustomRes.status, 200);
        const insertedJson = JSON.parse(insertCustomRes.body);
        assert.strictEqual(insertedJson.tipo_crisis, customTypeLabel);

        const getCustomRes = await request({
            port,
            method: 'GET',
            reqPath: '/api/get-crisis?begin=2026-11-15&end=2026-11-15',
            headers: { Cookie: medicoCookie }
        });
        assert.strictEqual(getCustomRes.status, 200);
        const listCustom = JSON.parse(getCustomRes.body);
        assert.ok(
            Array.isArray(listCustom) && listCustom.some((c) => c.tipo_crisis === customTypeLabel),
            'GET /api/get-crisis debe incluir el episodio registrado con el tipo personalizado'
        );

        // Limpieza: borrar registro de prueba y restaurar tipos originales
        if (insertedJson.id) {
            await request({
                port,
                method: 'DELETE',
                reqPath: `/api/delete-crisis/${insertedJson.id}`,
                headers: { Cookie: adminCookie }
            });
        }
        await request({
            port,
            method: 'PUT',
            reqPath: '/api/settings',
            headers: { Cookie: adminCookie },
            body: { crisisEpisodeTypes: originalTypes }
        });
    });

    it('permite editar canciones existentes, artistas y álbumes en el catálogo musical con validación de duplicados', async () => {
        // 1. Crear canción con artista y álbum únicos para esta prueba
        const createFirst = await request({
            port,
            method: 'POST',
            reqPath: '/api/english/music/songs',
            headers: { Cookie: adminCookie },
            body: {
                titulo: 'Strategy',
                mainArtist: 'twice',
                artistType: 'group',
                albumTitle: 'STRATEGY',
                albumType: 'mini_album',
                albumYear: 2024,
                idioma: 'English + Korean (K-Pop)'
            }
        });
        assert.strictEqual(createFirst.status, 201);
        const createdFirst = JSON.parse(createFirst.body);

        // Crear un segundo artista para probar detección 409 de duplicados al renombrar
        const createSecond = await request({
            port,
            method: 'POST',
            reqPath: '/api/english/music/songs',
            headers: { Cookie: adminCookie },
            body: {
                titulo: 'ABCD',
                mainArtist: 'NAYEON',
                artistType: 'solo',
                albumTitle: 'NA',
                albumType: 'mini_album',
                albumYear: 2024,
                idioma: 'English + Korean (K-Pop)'
            }
        });
        assert.strictEqual(createSecond.status, 201);

        // 2. PUT /api/english/music/songs/:id actualiza metadatos de la canción y formato/capitalización del artista
        const updateSongRes = await request({
            port,
            method: 'PUT',
            reqPath: `/api/english/music/songs/${createdFirst.songId}`,
            headers: { Cookie: adminCookie },
            body: {
                titulo: 'Strategy (Extended Ver.)',
                mainArtist: 'TWICE',
                artistType: 'duo',
                albumTitle: 'STRATEGY',
                albumType: 'mini_album',
                albumYear: 2024,
                idioma: 'English + Korean (K-Pop)',
                estadoEstudio: 'in_progress',
                enfoqueCorto: 'Updated chorus idioms'
            }
        });
        assert.strictEqual(updateSongRes.status, 200);

        const catalogAfterSongEdit = await request({
            port,
            reqPath: '/api/english/music/catalog',
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(catalogAfterSongEdit.status, 200);
        const catJson1 = JSON.parse(catalogAfterSongEdit.body);
        const targetArtist = catJson1.artists.find((a) => a.nombre === 'TWICE');
        const targetAlbum = catJson1.albums.find((al) => al.titulo === 'STRATEGY');
        const targetSong = catJson1.songs.find((s) => s.id === createdFirst.songId);
        assert.ok(targetArtist, 'Debe actualizar capitalización del artista existente');
        assert.strictEqual(targetArtist.tipo_artista, 'duo');
        assert.ok(targetAlbum);
        assert.strictEqual(targetSong.titulo, 'Strategy (Extended Ver.)');
        assert.strictEqual(targetSong.estado_estudio, 'in_progress');

        // 3. PATCH /api/english/music/artists/:id rechaza renombrado duplicado (409) y guarda edición válida
        const conflictArtistRes = await request({
            port,
            method: 'PATCH',
            reqPath: `/api/english/music/artists/${targetArtist.id}`,
            headers: { Cookie: adminCookie },
            body: { nombre: 'NAYEON', tipoArtista: 'group' }
        });
        assert.strictEqual(conflictArtistRes.status, 409);

        const patchArtistRes = await request({
            port,
            method: 'PATCH',
            reqPath: `/api/english/music/artists/${targetArtist.id}`,
            headers: { Cookie: adminCookie },
            body: {
                nombre: 'TWICE Official',
                tipoArtista: 'group',
                notasCortas: '9-member JYP girl group'
            }
        });
        assert.strictEqual(patchArtistRes.status, 200);

        // 4. PATCH /api/english/music/albums/:id edita título, tipo y año de lanzamiento
        const patchAlbumRes = await request({
            port,
            method: 'PATCH',
            reqPath: `/api/english/music/albums/${targetAlbum.id}`,
            headers: { Cookie: adminCookie },
            body: {
                titulo: 'STRATEGY (14th Mini Album)',
                tipoLanzamiento: 'mini_album',
                anio: 2025
            }
        });
        assert.strictEqual(patchAlbumRes.status, 200);

        const finalCatalog = await request({
            port,
            reqPath: '/api/english/music/catalog',
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(finalCatalog.status, 200);
        const finalJson = JSON.parse(finalCatalog.body);
        const updatedArtist = finalJson.artists.find((a) => a.id === targetArtist.id);
        const updatedSong = finalJson.songs.find((s) => s.id === createdFirst.songId);
        assert.strictEqual(updatedArtist.nombre, 'TWICE Official');
        assert.strictEqual(updatedArtist.tipo_artista, 'group');
        assert.strictEqual(updatedArtist.notas_cortas, '9-member JYP girl group');
        assert.strictEqual(updatedSong.album_titulo, 'STRATEGY (14th Mini Album)');
        assert.strictEqual(updatedSong.album_anio, 2025);
        assert.ok(updatedSong.artists.some((a) => a.nombre === 'TWICE Official'));

        // 5. Prevención de duplicados y typos en canciones/álbumes (ruido YouTube, acentos, puntuación, 1-2 letras de diferencia)
        const songCountBeforeDedup = finalJson.songs.length;
        const dupYoutubeNoiseRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/english/music/songs',
            headers: { Cookie: adminCookie },
            body: {
                titulo: 'Strategy (Extended Ver.) (Official M/V)!',
                mainArtist: 'twice official',
                artistType: 'group',
                albumTitle: 'STRATEGY (14th Mini Album)',
                albumType: 'mini_album'
            }
        });
        assert.strictEqual(dupYoutubeNoiseRes.status, 200);
        const dupYoutubeNoise = JSON.parse(dupYoutubeNoiseRes.body);
        assert.strictEqual(dupYoutubeNoise.deduplicated, true);
        assert.strictEqual(dupYoutubeNoise.songId, createdFirst.songId);

        const aptRow = finalJson.songs.find((s) => s.titulo === 'APT.');
        assert.ok(aptRow);
        const dupAccentRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/english/music/songs',
            headers: { Cookie: adminCookie },
            body: {
                titulo: 'APT!',
                mainArtist: 'ROSE',
                ytMusicUrl: 'https://music.youtube.com/watch?v=ekr2nIex040'
            }
        });
        assert.strictEqual(dupAccentRes.status, 200);
        const dupAccentJson = JSON.parse(dupAccentRes.body);
        assert.strictEqual(dupAccentJson.deduplicated, true);
        assert.strictEqual(dupAccentJson.songId, aptRow.id);

        const typoSongRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/english/music/songs',
            headers: { Cookie: adminCookie },
            body: {
                titulo: 'Strategy (Extnded Ver.)',
                mainArtist: 'TWICE Official',
                artistType: 'group'
            }
        });
        assert.strictEqual(typoSongRes.status, 409);

        const createExtraAlbumRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/english/music/albums',
            headers: { Cookie: adminCookie },
            body: {
                mainArtist: 'TWICE Official',
                artistType: 'group',
                albumTitle: 'Between 1&2',
                albumType: 'mini_album',
                albumYear: 2022
            }
        });
        assert.strictEqual(createExtraAlbumRes.status, 201);
        const extraAlbumId = JSON.parse(createExtraAlbumRes.body).album.id;
        const conflictAlbumRenameRes = await request({
            port,
            method: 'PATCH',
            reqPath: `/api/english/music/albums/${extraAlbumId}`,
            headers: { Cookie: adminCookie },
            body: {
                titulo: 'strategy (14th mini album)',
                tipoLanzamiento: 'mini_album',
                anio: 2025
            }
        });
        assert.strictEqual(conflictAlbumRenameRes.status, 409);

        const afterDedupCatalog = await request({
            port,
            reqPath: '/api/english/music/catalog',
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(JSON.parse(afterDedupCatalog.body).songs.length, songCountBeforeDedup);
    });

    it('registra desvelos, dormir a las 3 AM y trasnoches (0 hrs) y los muestra en modo solo lectura al psiquiatra', async () => {
        // 1. Dormir a las 03:00 AM auto-detecta es_desvelo=1 y tipo_registro='desvelo_tarde'
        const lateSleepRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-sleep',
            headers: { Cookie: adminCookie },
            body: {
                fecha: '2026-11-16',
                horaDormir: '03:00',
                horaDespertar: '08:30',
                horas: 5.5,
                calidad: 'Regular',
                motivoDesvelo: 'Me dormí a las 3 de la mañana terminando un proyecto'
            }
        });
        assert.strictEqual(lateSleepRes.status, 200);

        // 2. Desvelo en curso (03:00 AM sin despertar aún) + PATCH al despertar
        const pendingBedRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-sleep',
            headers: { Cookie: adminCookie },
            body: {
                fecha: '2026-11-17',
                horaDormir: '03:00',
                horaDespertar: '',
                horas: 0,
                calidad: 'Regular',
                tipoRegistro: 'desvelo_tarde'
            }
        });
        assert.strictEqual(pendingBedRes.status, 200);

        // 3. Desvelo total (0 hrs sin dormir)
        const allNighterRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-sleep',
            headers: { Cookie: adminCookie },
            body: {
                fecha: '2026-11-18',
                horaDormir: '03:00',
                horas: 0,
                calidad: 'Bad',
                tipoRegistro: 'desvelo_total',
                motivoDesvelo: 'Insomnio agudo, pasé la noche en vela'
            }
        });
        assert.strictEqual(allNighterRes.status, 200);

        // 4. El psiquiatra consulta GET /api/get-sleep y ve todos los campos de desvelo en solo lectura
        const psychReadRes = await request({
            port,
            reqPath: '/api/get-sleep?begin=2026-11-16&end=2026-11-18',
            headers: { Cookie: medicoCookie }
        });
        assert.strictEqual(psychReadRes.status, 200);
        const rows = JSON.parse(psychReadRes.body);
        const rowLate = rows.find((r) => r.fecha === '2026-11-16');
        const rowPending = rows.find((r) => r.fecha === '2026-11-17');
        const rowTotal = rows.find((r) => r.fecha === '2026-11-18');
        assert.ok(rowLate && rowPending && rowTotal);
        assert.strictEqual(rowLate.hora_dormir, '03:00');
        assert.strictEqual(rowLate.hora_despertar, '08:30');
        assert.strictEqual(Number(rowLate.es_desvelo), 1);
        assert.strictEqual(rowLate.tipo_registro, 'desvelo_tarde');
        assert.strictEqual(rowTotal.tipo_registro, 'desvelo_total');
        assert.strictEqual(Number(rowTotal.horas), 0);
        assert.match(rowTotal.motivo_desvelo, /Insomnio/i);

        // 5. Psiquiatra recibe 403 al intentar actualizar o eliminar sueño
        const psychPatch = await request({
            port,
            method: 'PATCH',
            reqPath: `/api/update-sleep/${rowPending.id}`,
            headers: { Cookie: medicoCookie },
            body: { horaDespertar: '09:00', horas: 6, calidad: 'Good' }
        });
        assert.strictEqual(psychPatch.status, 403);

        const psychDel = await request({
            port,
            method: 'DELETE',
            reqPath: `/api/delete-sleep/${rowPending.id}`,
            headers: { Cookie: medicoCookie }
        });
        assert.strictEqual(psychDel.status, 403);

        // 6. Admin completa hora de despertar del registro de las 3:00 AM y puede eliminar un registro
        const adminPatch = await request({
            port,
            method: 'PATCH',
            reqPath: `/api/update-sleep/${rowPending.id}`,
            headers: { Cookie: adminCookie },
            body: {
                horaDespertar: '09:00',
                horas: 6,
                calidad: 'Good',
                motivoDesvelo: 'Desperté a las 9 AM tras dormirme a las 3 AM'
            }
        });
        assert.strictEqual(adminPatch.status, 200);

        const psychAfterPatch = await request({
            port,
            reqPath: '/api/get-sleep?begin=2026-11-17&end=2026-11-17',
            headers: { Cookie: medicoCookie }
        });
        const updatedRow = JSON.parse(psychAfterPatch.body)[0];
        assert.strictEqual(updatedRow.hora_despertar, '09:00');
        assert.strictEqual(Number(updatedRow.horas), 6);
        assert.strictEqual(Number(updatedRow.es_desvelo), 1);

        const adminDel = await request({
            port,
            method: 'DELETE',
            reqPath: `/api/delete-sleep/${rowPending.id}`,
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(adminDel.status, 200);
    });

    it('aplica reglas configurables de sueño/desvelo en Ajustes, soporta siestas sin desvelo y recuerda despertar de sueño normal pendiente', async () => {
        const backupSleeps = sleepInserts.splice(0, sleepInserts.length);
        const origSettingsRes = await request({ port, reqPath: '/api/settings', headers: { Cookie: adminCookie } });
        assert.strictEqual(origSettingsRes.status, 200);
        const origSettings = JSON.parse(origSettingsRes.body).settings;

        try {
            // 1. Guardar y recuperar sleepDesveloBedtimeTime y sleepMinNormalHours (con redondeo a 0.5) y rechazar rangos inválidos (400)
            for (const badSleepSettings of [
                { sleepDesveloBedtimeTime: '25:99' },
                { sleepMinNormalHours: 2 },
                { sleepMinNormalHours: 13 },
                { sleepMinNormalHours: 'abc' },
                { sleepMinNormalHours: null }
            ]) {
                const badRes = await request({
                    port,
                    method: 'PUT',
                    reqPath: '/api/settings',
                    headers: { Cookie: adminCookie },
                    body: badSleepSettings
                });
                assert.strictEqual(badRes.status, 400, `Debe rechazar ajuste inválido: ${JSON.stringify(badSleepSettings)}`);
            }

            const putValidRes = await request({
                port,
                method: 'PUT',
                reqPath: '/api/settings',
                headers: { Cookie: adminCookie },
                body: {
                    sleepDesveloBedtimeTime: '01:00',
                    sleepMinNormalHours: 7.2
                }
            });
            assert.strictEqual(putValidRes.status, 200);
            assert.strictEqual(JSON.parse(putValidRes.body).settings.sleepMinNormalHours, 7);

            const putCustomRes = await request({
                port,
                method: 'PUT',
                reqPath: '/api/settings',
                headers: { Cookie: adminCookie },
                body: {
                    sleepDesveloBedtimeTime: '01:00',
                    sleepMinNormalHours: 7
                }
            });
            assert.strictEqual(putCustomRes.status, 200);
            const getSaved = JSON.parse((await request({ port, reqPath: '/api/settings', headers: { Cookie: adminCookie } })).body).settings;
            assert.strictEqual(getSaved.sleepDesveloBedtimeTime, '01:00');
            assert.strictEqual(getSaved.sleepMinNormalHours, 7);

            // 2. Dormirse a la 01:15 con 7.5 hrs -> auto-marca es_desvelo=1 y tipo_registro='desvelo_tarde'
            const lateGoodDurRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/insert-sleep',
                headers: { Cookie: adminCookie },
                body: {
                    fecha: '2026-11-19',
                    horaDormir: '01:15',
                    horaDespertar: '08:45',
                    horas: 7.5,
                    calidad: 'Good',
                    tipoRegistro: 'normal'
                }
            });
            assert.strictEqual(lateGoodDurRes.status, 200);
            const lateRow = sleepInserts.find((r) => r.fecha === '2026-11-19');
            assert.ok(lateRow);
            assert.strictEqual(Number(lateRow.es_desvelo), 1);
            assert.strictEqual(lateRow.tipo_registro, 'desvelo_tarde');

            // 3. Dormirse a las 22:00 con 5.5 hrs (< 7 hrs) -> auto-marca es_desvelo=1 y tipo_registro='desvelo_tarde'
            const shortSleepRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/insert-sleep',
                headers: { Cookie: adminCookie },
                body: {
                    fecha: '2026-11-20',
                    horaDormir: '22:00',
                    horaDespertar: '03:30',
                    horas: 5.5,
                    calidad: 'Regular',
                    tipoRegistro: 'normal'
                }
            });
            assert.strictEqual(shortSleepRes.status, 200);
            const shortRow = sleepInserts.find((r) => r.fecha === '2026-11-20');
            assert.ok(shortRow);
            assert.strictEqual(Number(shortRow.es_desvelo), 1);
            assert.strictEqual(shortRow.tipo_registro, 'desvelo_tarde');

            // 4. Dormirse a las 22:00 con 7.5 hrs (>= 7 hrs y antes de 01:00) -> es_desvelo=0 y tipo_registro='normal'
            const normalSleepRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/insert-sleep',
                headers: { Cookie: adminCookie },
                body: {
                    fecha: '2026-11-21',
                    horaDormir: '22:00',
                    horaDespertar: '05:30',
                    horas: 7.5,
                    calidad: 'Good',
                    tipoRegistro: 'normal'
                }
            });
            assert.strictEqual(normalSleepRes.status, 200);
            const normalRow = sleepInserts.find((r) => r.fecha === '2026-11-21');
            assert.ok(normalRow);
            assert.strictEqual(Number(normalRow.es_desvelo), 0);
            assert.strictEqual(normalRow.tipo_registro, 'normal');

            // 5. Registrar tipoRegistro: 'siesta' (15:00-16:30 y 02:00-03:00) -> siempre es_desvelo=0 y tipo_registro='siesta'
            const afternoonNapRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/insert-sleep',
                headers: { Cookie: adminCookie },
                body: {
                    fecha: '2026-11-22',
                    horaDormir: '15:00',
                    horaDespertar: '16:30',
                    horas: 1.5,
                    calidad: 'Good',
                    tipoRegistro: 'siesta'
                }
            });
            assert.strictEqual(afternoonNapRes.status, 200);

            const lateNapRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/insert-sleep',
                headers: { Cookie: adminCookie },
                body: {
                    fecha: '2026-11-22',
                    horaDormir: '02:00',
                    horaDespertar: '03:00',
                    horas: 1,
                    calidad: 'Regular',
                    tipoRegistro: 'siesta',
                    esDesvelo: true
                }
            });
            assert.strictEqual(lateNapRes.status, 200);
            const napRows = sleepInserts.filter((r) => r.fecha === '2026-11-22');
            assert.strictEqual(napRows.length, 2);
            for (const nr of napRows) {
                assert.strictEqual(Number(nr.es_desvelo), 0);
                assert.strictEqual(nr.tipo_registro, 'siesta');
            }

            // 6. Sueño normal pendiente desde anoche -> recordatorio matutino sleep-wakeup + PATCH normal vs corto
            const candidateTzs = [
                'UTC', 'America/Mexico_City', 'America/Los_Angeles', 'Pacific/Honolulu',
                'America/Sao_Paulo', 'Asia/Dubai', 'Asia/Bangkok', 'Asia/Tokyo', 'Pacific/Auckland'
            ];
            const getTzInfo = (tz) => {
                const parts = new Intl.DateTimeFormat('en-CA', {
                    timeZone: tz,
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    hourCycle: 'h23'
                }).formatToParts(new Date());
                const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
                return { tz, hour: Number(map.hour), dateStr: `${map.year}-${map.month}-${map.day}` };
            };
            const morningTz = candidateTzs.map(getTzInfo).find((x) => x.hour >= 8 && x.hour <= 13) || getTzInfo('UTC');
            const [ty, tm, td] = morningTz.dateStr.split('-').map(Number);
            const yesterdayStr = new Date(Date.UTC(ty, tm - 1, td - 1)).toISOString().slice(0, 10);

            const remSettingsRes = await request({
                port,
                method: 'PUT',
                reqPath: '/api/settings',
                headers: { Cookie: adminCookie },
                body: {
                    sleepReminderEnabled: true,
                    sleepReminderTime: '00:00',
                    sleepDesveloBedtimeTime: '01:00',
                    sleepMinNormalHours: 7,
                    timezone: morningTz.tz
                }
            });
            assert.strictEqual(remSettingsRes.status, 200);

            // Una siesta registrada hoy NO suprime el recordatorio matutino de sueño nocturno
            await request({
                port,
                method: 'POST',
                reqPath: '/api/insert-sleep',
                headers: { Cookie: adminCookie },
                body: {
                    fecha: morningTz.dateStr,
                    horaDormir: '11:00',
                    horaDespertar: '11:30',
                    horas: 0.5,
                    calidad: 'Good',
                    tipoRegistro: 'siesta'
                }
            });

            const pendingNormalRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/insert-sleep',
                headers: { Cookie: adminCookie },
                body: {
                    fecha: yesterdayStr,
                    horaDormir: '22:30',
                    horaDespertar: '',
                    horas: 0,
                    calidad: 'Good',
                    tipoRegistro: 'normal'
                }
            });
            assert.strictEqual(pendingNormalRes.status, 200);
            assert.match(pendingNormalRes.body, /Bedtime \(22:30\) saved! We will remind you at 00:00/i);

            const pendingNormalRow = sleepInserts.find((r) => r.fecha === yesterdayStr && r.hora_dormir === '22:30');
            assert.ok(pendingNormalRow);
            assert.strictEqual(Number(pendingNormalRow.es_desvelo), 0);
            assert.strictEqual(pendingNormalRow.tipo_registro, 'normal');

            if (morningTz.hour < 14) {
                const activeRemRes = await request({ port, reqPath: '/api/reminders/active', headers: { Cookie: adminCookie } });
                assert.strictEqual(activeRemRes.status, 200);
                const remPayload = JSON.parse(activeRemRes.body);
                const wakeupRem = remPayload.active.find((r) => r.key === `sleep-wakeup:${morningTz.dateStr}`);
                assert.ok(wakeupRem, 'Debe dispararse sleep-wakeup con el registro normal pendiente de anoche');
                assert.strictEqual(Number(wakeupRem.refId), pendingNormalRow.id);
                assert.strictEqual(wakeupRem.targetDate, yesterdayStr);
                assert.strictEqual(wakeupRem.targetView, 'sueno');
            }

            // Completar con 7.5 hrs -> queda normal (es_desvelo = 0)
            const patchGoodRes = await request({
                port,
                method: 'PATCH',
                reqPath: `/api/update-sleep/${pendingNormalRow.id}`,
                headers: { Cookie: adminCookie },
                body: { horaDespertar: '06:00', horas: 7.5, calidad: 'Good', tipoRegistro: 'normal' }
            });
            assert.strictEqual(patchGoodRes.status, 200);
            assert.strictEqual(Number(pendingNormalRow.es_desvelo), 0);
            assert.strictEqual(pendingNormalRow.tipo_registro, 'normal');

            // Nuevo pendiente normal de noche que al despertar solo durmió 5.5 hrs -> pasa a desvelo_tarde (es_desvelo = 1)
            const pendingShortRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/insert-sleep',
                headers: { Cookie: adminCookie },
                body: {
                    fecha: '2026-11-23',
                    horaDormir: '22:30',
                    horaDespertar: '',
                    horas: 0,
                    calidad: 'Regular',
                    tipoRegistro: 'normal'
                }
            });
            assert.strictEqual(pendingShortRes.status, 200);
            const pendingShortRow = sleepInserts.find((r) => r.fecha === '2026-11-23' && r.hora_dormir === '22:30');
            assert.ok(pendingShortRow);
            assert.strictEqual(Number(pendingShortRow.es_desvelo), 0);

            const patchShortRes = await request({
                port,
                method: 'PATCH',
                reqPath: `/api/update-sleep/${pendingShortRow.id}`,
                headers: { Cookie: adminCookie },
                body: { horaDespertar: '04:00', horas: 5.5, calidad: 'Regular', tipoRegistro: 'normal' }
            });
            assert.strictEqual(patchShortRes.status, 200);
            assert.strictEqual(Number(pendingShortRow.es_desvelo), 1);
            assert.strictEqual(pendingShortRow.tipo_registro, 'desvelo_tarde');
        } finally {
            sleepInserts.splice(0, sleepInserts.length, ...backupSleeps);
            await request({
                port,
                method: 'PUT',
                reqPath: '/api/settings',
                headers: { Cookie: adminCookie },
                body: {
                    sleepReminderEnabled: origSettings.sleepReminderEnabled,
                    sleepReminderTime: origSettings.sleepReminderTime,
                    sleepDesveloBedtimeTime: origSettings.sleepDesveloBedtimeTime,
                    sleepMinNormalHours: origSettings.sleepMinNormalHours,
                    timezone: origSettings.timezone
                }
            });
        }
    });

    it('rechaza coordenadas Null Island (0,0), soporta Casa/direcciones y webhook GPS HTTP del teléfono con token rotativo', async () => {
        // 1. Null Island (0,0) debe rechazarse con 400 en /api/planner/location
        for (const badBody of [
            { target: 'home', lat: 0, lng: 0 },
            { target: 'current', mapsUrl: '0.000000, 0.000000' },
            { target: 'current', mapsUrl: 'https://www.google.com/maps?q=0,0' }
        ]) {
            const badRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/planner/location',
                headers: { Cookie: adminCookie },
                body: badBody
            });
            assert.strictEqual(badRes.status, 400, `Debe rechazar coordenadas inválidas (0,0): ${JSON.stringify(badBody)}`);
        }

        // 2. PUT /api/planner sanea lat=0,lng=0 heredados a null y nunca genera origin=0,0 en Maps
        const plannerBase = JSON.parse((await request({ port, reqPath: '/api/planner', headers: { Cookie: adminCookie } })).body).planner;
        plannerBase.locations.home = {
            label: 'Mi Casa',
            address: 'Margarita Maza de Juárez 924, Saltillo',
            mapsUrl: '',
            lat: 0,
            lng: 0
        };
        plannerBase.locations.current = {
            label: 'Ubicación actual',
            lat: 0,
            lng: 0,
            updatedAt: null,
            source: 'gps'
        };
        const sanitizedPut = await request({
            port,
            method: 'PUT',
            reqPath: '/api/planner',
            headers: { Cookie: adminCookie },
            body: { planner: plannerBase }
        });
        assert.strictEqual(sanitizedPut.status, 200);
        const putData = JSON.parse(sanitizedPut.body);
        assert.strictEqual(putData.planner.locations.home.lat, null);
        assert.strictEqual(putData.planner.locations.home.lng, null);
        assert.strictEqual(putData.planner.locations.current.lat, null);
        assert.strictEqual(putData.planner.locations.current.lng, null);
        for (const c of putData.commutePreview.commutes) {
            assert.ok(!c.mapsDirectionsUrl.includes('origin=0'), `No debe generar origin=0,0 en Maps: ${c.mapsDirectionsUrl}`);
        }

        // 3. Prioridad exacta !3d!4d sobre @ viewport al guardar Casa y decodificación de %2C
        const saveHomeRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/planner/location',
            headers: { Cookie: adminCookie },
            body: {
                target: 'home',
                label: 'Mi Casa Saltillo',
                address: 'Margarita Maza de Juárez 924, Saltillo',
                mapsUrl: 'https://www.google.com/maps/place/Casa/@25.440000,-101.010000,15z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d25.431683!4d-100.992006?entry=ttu'
            }
        });
        assert.strictEqual(saveHomeRes.status, 200);
        const savedHomeBody = JSON.parse(saveHomeRes.body);
        assert.strictEqual(savedHomeBody.planner.locations.home.lat, 25.431683);
        assert.strictEqual(savedHomeBody.planner.locations.home.lng, -100.992006);
        assert.strictEqual(savedHomeBody.planner.locations.home.label, 'Mi Casa Saltillo');

        // Clear current GPS -> origen vuelve a Casa guardada
        const clearRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/planner/location',
            headers: { Cookie: adminCookie },
            body: { target: 'clear_current' }
        });
        assert.strictEqual(clearRes.status, 200);
        const clearBody = JSON.parse(clearRes.body);
        assert.strictEqual(clearBody.commutePreview.originKind, 'home');
        assert.strictEqual(clearBody.commutePreview.originCoords.lat, 25.431683);
        assert.strictEqual(clearBody.commutePreview.originSource, 'Mi Casa Saltillo');

        // %2C encoded Maps query URL
        const encodedUrlRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/planner/location',
            headers: { Cookie: adminCookie },
            body: { target: 'current', mapsUrl: 'https://www.google.com/maps?q=25.432100%2C-100.991234', label: 'Encoded Link' }
        });
        assert.strictEqual(encodedUrlRes.status, 200);
        assert.strictEqual(JSON.parse(encodedUrlRes.body).planner.locations.current.lat, 25.4321);

        // 4. Phone GPS HTTP Webhook: RBAC, token secreto (no expuesto en /api/planner), GET/POST y rotación
        const psychTokenRes = await request({ port, reqPath: '/api/planner/phone-gps-token', headers: { Cookie: medicoCookie } });
        assert.strictEqual(psychTokenRes.status, 403);

        const plannerCheckRes = await request({ port, reqPath: '/api/planner', headers: { Cookie: adminCookie } });
        const plannerCheckBody = JSON.parse(plannerCheckRes.body);
        assert.strictEqual(plannerCheckBody.planner.phoneGpsNonce, undefined, 'No debe exponer el nonce raw al cliente');

        const tokenRes = await request({ port, reqPath: '/api/planner/phone-gps-token', headers: { Cookie: adminCookie } });
        assert.strictEqual(tokenRes.status, 200);
        const tokenBody = JSON.parse(tokenRes.body);
        assert.ok(tokenBody.token && tokenBody.webhookPostUrl.includes('/api/planner/phone-location?token='));

        const badPhoneZero = await request({
            port,
            method: 'GET',
            reqPath: `/api/planner/phone-location?token=${encodeURIComponent(tokenBody.token)}&lat=0&lng=0`
        });
        assert.strictEqual(badPhoneZero.status, 400);

        const okPhoneGet = await request({
            port,
            method: 'GET',
            reqPath: `/api/planner/phone-location?token=${encodeURIComponent(tokenBody.token)}&lat=25.439123&lng=-100.995456`
        });
        assert.strictEqual(okPhoneGet.status, 200);
        const phoneGetBody = JSON.parse(okPhoneGet.body);
        assert.strictEqual(phoneGetBody.ok, true);
        assert.strictEqual(phoneGetBody.location.lat, 25.439123);
        assert.strictEqual(phoneGetBody.location.lng, -100.995456);
        assert.strictEqual(phoneGetBody.commutePreview.originKind, 'current');

        const okPhonePost = await request({
            port,
            method: 'POST',
            reqPath: `/api/planner/phone-location?token=${encodeURIComponent(tokenBody.token)}`,
            body: { lat: 25.441234, lng: -100.994321, label: 'OPPO A79 GPS', source: 'macrodroid_gps' }
        });
        assert.strictEqual(okPhonePost.status, 200);
        assert.strictEqual(JSON.parse(okPhonePost.body).location.source, 'macrodroid_gps');

        // Rotación revoca token anterior
        const rotateRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/planner/phone-gps-token/rotate',
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(rotateRes.status, 200);
        const rotateBody = JSON.parse(rotateRes.body);
        assert.notStrictEqual(rotateBody.token, tokenBody.token);

        const revokedAttempt = await request({
            port,
            method: 'POST',
            reqPath: `/api/planner/phone-location?token=${encodeURIComponent(tokenBody.token)}`,
            body: { lat: 25.441, lng: -100.994 }
        });
        assert.strictEqual(revokedAttempt.status, 401);

        const newTokenAttempt = await request({
            port,
            method: 'POST',
            reqPath: `/api/planner/phone-location?token=${encodeURIComponent(rotateBody.token)}`,
            body: { lat: 25.442, lng: -100.993 }
        });
        assert.strictEqual(newTokenAttempt.status, 200);

        // Ping sin ntfy configurado debe responder 400 claro
        const pingNoNtfyRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/planner/request-phone-gps',
            headers: { Cookie: adminCookie },
            body: {}
        });
        assert.strictEqual(pingNoNtfyRes.status, 400);
    });

    it('crea álbum/mini álbum, agrega canción al álbum, edita nombre/vínculo y elimina álbum preservando canciones', async () => {
        // 1. Crear Mini Álbum vacío primero
        const createAlbumRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/english/music/albums',
            headers: { Cookie: adminCookie },
            body: {
                mainArtist: 'AESPA',
                artistType: 'group',
                albumTitle: 'Whiplash',
                albumType: 'mini_album',
                albumYear: 2024,
                notasCortas: '5th Mini Album'
            }
        });
        assert.strictEqual(createAlbumRes.status, 201);
        const createdAlbumJson = JSON.parse(createAlbumRes.body);
        const albumId = createdAlbumJson.album.id;
        assert.ok(albumId);
        assert.strictEqual(createdAlbumJson.album.tipo_lanzamiento, 'mini_album');

        // Catálogo debe mostrar el Mini Álbum aún vacío
        const emptyCatRes = await request({
            port,
            reqPath: '/api/english/music/catalog',
            headers: { Cookie: adminCookie }
        });
        const emptyCatJson = JSON.parse(emptyCatRes.body);
        const createdAlbRow = emptyCatJson.albums.find((a) => a.id === albumId);
        assert.ok(createdAlbRow);
        assert.strictEqual(createdAlbRow.notas_cortas, '5th Mini Album');

        // 2. Agregar canción directamente al Mini Álbum creado
        const addSongRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/english/music/songs',
            headers: { Cookie: adminCookie },
            body: {
                titulo: 'Whiplsh Draft',
                mainArtist: 'AESPA',
                artistType: 'group',
                albumTitle: 'Whiplash',
                albumType: 'mini_album',
                albumYear: 2024,
                trackNumber: 1,
                idioma: 'English + Korean (K-Pop)',
                ytMusicUrl: 'https://music.youtube.com/watch?v=dQw4w9WgXcQ'
            }
        });
        assert.strictEqual(addSongRes.status, 201);
        const { songId } = JSON.parse(addSongRes.body);

        // 3. Editar título y vínculo YouTube de la canción (CRUD completo)
        const editSongRes = await request({
            port,
            method: 'PUT',
            reqPath: `/api/english/music/songs/${songId}`,
            headers: { Cookie: adminCookie },
            body: {
                titulo: 'Whiplash',
                mainArtist: 'AESPA',
                artistType: 'group',
                albumTitle: 'Whiplash',
                albumType: 'mini_album',
                albumYear: 2024,
                trackNumber: 1,
                idioma: 'English + Korean (K-Pop)',
                ytMusicUrl: 'https://www.youtube.com/watch?v=jWQx2f-CErU'
            }
        });
        assert.strictEqual(editSongRes.status, 200);

        const afterEditRes = await request({
            port,
            reqPath: '/api/english/music/catalog',
            headers: { Cookie: adminCookie }
        });
        const afterEditSong = JSON.parse(afterEditRes.body).songs.find((s) => s.id === songId);
        assert.strictEqual(afterEditSong.titulo, 'Whiplash');
        assert.strictEqual(afterEditSong.yt_video_id, 'jWQx2f-CErU');

        // 4. Eliminar álbum conserva la canción como track suelto
        const delAlbumRes = await request({
            port,
            method: 'DELETE',
            reqPath: `/api/english/music/albums/${albumId}`,
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(delAlbumRes.status, 200);

        const afterDelRes = await request({
            port,
            reqPath: '/api/english/music/catalog',
            headers: { Cookie: adminCookie }
        });
        const afterDelCat = JSON.parse(afterDelRes.body);
        assert.ok(!afterDelCat.albums.some((a) => a.id === albumId));
        const preservedSong = afterDelCat.songs.find((s) => s.id === songId);
        assert.ok(preservedSong);
        assert.strictEqual(preservedSong.album_id, null);
    });

    it('traduce inglés->español y coreano->inglés desde POST /api/language/translate y alimenta la memoria', async () => {
        // 1. Validación texto vacío -> 400
        const emptyRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/language/translate',
            headers: { Cookie: adminCookie },
            body: { text: '   ', direction: 'en_es', mode: 'offline' }
        });
        assert.strictEqual(emptyRes.status, 400);

        // 2. Inglés -> Español (frase / vocabulario)
        const enEsRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/language/translate',
            headers: { Cookie: adminCookie },
            body: { text: 'break through', direction: 'en_es', mode: 'offline' }
        });
        assert.strictEqual(enEsRes.status, 200);
        const enEsJson = JSON.parse(enEsRes.body);
        assert.strictEqual(enEsJson.direction, 'en_es');
        assert.match(enEsJson.translatedText, /abrirse paso|superar/i);
        assert.ok(enEsJson.spanishMeaning);

        // 3. Coreano -> English (con romanización y explicación en español para hablante nativo)
        const koEnRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/language/translate',
            headers: { Cookie: adminCookie },
            body: { text: '사랑해요', direction: 'ko_en', mode: 'offline' }
        });
        assert.strictEqual(koEnRes.status, 200);
        const koEnJson = JSON.parse(koEnRes.body);
        assert.strictEqual(koEnJson.direction, 'ko_en');
        assert.match(koEnJson.translatedText, /I love you/i);
        assert.match(koEnJson.spanishMeaning, /Te amo|Te quiero/i);
        assert.ok(koEnJson.romanization);
        assert.ok(koEnJson.memoryTotalTerms >= 2, 'Debe recordar los términos traducidos en languageMemory');

        // 4. Modo Auto detectando Hangul
        const autoKoRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/language/translate',
            headers: { Cookie: adminCookie },
            body: { text: '마음', direction: 'auto', mode: 'offline' }
        });
        assert.strictEqual(autoKoRes.status, 200);
        const autoKoJson = JSON.parse(autoKoRes.body);
        assert.ok(autoKoJson.romanization);
        assert.match(autoKoJson.translatedText, /heart|corazón/i);
    });

    it('auto-recupera Gemini HTTP 404 vía /v1beta/models, evita memory poisoning, autocorrige Hangul en en_es y prueba POST /api/language/test-gemini', async () => {
        const langStudio = require('../lib/language-studio');

        // 1. Limpieza unitaria de memoria envenenada heredada
        assert.strictEqual(
            langStudio.isPoisonedMemoryMeaning('Activa Google Gemini API en Settings (0 MB RAM) para traducciones ilimitadas'),
            true
        );
        assert.strictEqual(
            langStudio.isPoisonedMemoryMeaning('Sin traducción exacta en diccionario local (Gemini HTTP 404)'),
            true
        );
        const cleanedMem = langStudio.sanitizeLanguageMemory({
            terms: [
                { term: '한국어', meaning: 'Activa Google Gemini API en Settings (0 MB RAM)', language: 'ko' },
                { term: '마음', meaning: 'heart / mind (corazón, mente)', language: 'ko' }
            ],
            grammarNotes: [
                'Sin traducción exacta en diccionario local (Gemini HTTP 404)',
                'Use -는/-은 for topic marking'
            ]
        });
        assert.strictEqual(cleanedMem.terms.length, 1);
        assert.strictEqual(cleanedMem.terms[0].term, '마음');
        assert.deepStrictEqual(cleanedMem.grammarNotes, ['Use -는/-은 for topic marking']);

        // 2. Configurar modelo obsoleto (gemini-2.0-flash) para verificar auto-cambio transparente en runtime
        const prepSet = await request({
            port,
            method: 'PUT',
            reqPath: '/api/settings',
            headers: { Cookie: adminCookie },
            body: {
                geminiModel: 'gemini-2.0-flash',
                geminiApiKey: 'AIzaSyFakeIntegrationKey987654'
            }
        });
        assert.strictEqual(prepSet.status, 200);

        const origFetch = global.fetch;
        try {
            // 3. Simular 404 en modelo viejo + descubrimiento de gemini-2.5-flash en /v1beta/models
            global.fetch = async (url, opts = {}) => {
                const target = String(url);
                assert.strictEqual(target.includes('key='), false, 'La API key no debe enviarse en query string');
                assert.strictEqual(opts?.headers?.['x-goog-api-key'], 'AIzaSyFakeIntegrationKey987654');
                if (target.endsWith('/v1beta/models')) {
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({
                            models: [
                                { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
                                { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }
                            ]
                        })
                    };
                }
                if (target.includes('/models/gemini-2.0-flash:generateContent')) {
                    const errBody = JSON.stringify({ error: { message: 'models/gemini-2.0-flash is not found' } });
                    return {
                        ok: false,
                        status: 404,
                        text: async () => errBody,
                        json: async () => JSON.parse(errBody)
                    };
                }
                if (target.includes('/models/gemini-2.5-flash:generateContent')) {
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({
                            candidates: [{
                                content: {
                                    parts: [{
                                        text: JSON.stringify({
                                            detectedSourceLanguage: 'Korean',
                                            translatedText: 'Korean language',
                                            spanishMeaning: 'Idioma coreano',
                                            englishBridge: 'Korean language',
                                            romanization: 'han-gu-geo',
                                            partOfSpeech: 'noun',
                                            literalMeaning: 'Han country language',
                                            explanationEs: 'Nombre del idioma coreano.',
                                            alternatives: ['한국말'],
                                            examples: [{ source: '한국어를 배워요.', translation: 'Aprendo coreano.' }]
                                        })
                                    }]
                                }
                            }]
                        })
                    };
                }
                throw new Error(`Unexpected fetch URL in test: ${target}`);
            };

            const recoveredRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/language/translate',
                headers: { Cookie: adminCookie },
                body: { text: '한국어', direction: 'en_es', mode: 'gemini' }
            });
            assert.strictEqual(recoveredRes.status, 200);
            const recoveredJson = JSON.parse(recoveredRes.body);
            assert.strictEqual(recoveredJson.engine, 'gemini');
            assert.strictEqual(recoveredJson.model, 'gemini-2.5-flash');
            assert.match(recoveredJson.autoSwitchedNote || '', /gemini-2\.5-flash/);
            assert.strictEqual(recoveredJson.spanishMeaning, 'Idioma coreano');

            // 4. Endpoint de diagnóstico POST /api/language/test-gemini (RBAC + OK)
            const psychDenied = await request({
                port,
                method: 'POST',
                reqPath: '/api/language/test-gemini',
                headers: { Cookie: medicoCookie },
                body: {}
            });
            assert.strictEqual(psychDenied.status, 403);

            const diagOk = await request({
                port,
                method: 'POST',
                reqPath: '/api/language/test-gemini',
                headers: { Cookie: adminCookie },
                body: { model: 'gemini-2.0-flash' }
            });
            assert.strictEqual(diagOk.status, 200);
            const diagJson = JSON.parse(diagOk.body);
            assert.strictEqual(diagJson.ok, true);
            assert.strictEqual(diagJson.suggestedModel, 'gemini-2.5-flash');
            assert.ok(Array.isArray(diagJson.availableModels) && diagJson.availableModels.includes('gemini-2.5-flash'));

            // 4b. Multi-hop fallback: omite modelos -tts y recupera en el 3er candidato vivo (gemini-flash-latest)
            global.fetch = async (url) => {
                const target = String(url);
                if (target.endsWith('/v1beta/models')) {
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({
                            models: [
                                { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
                                { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
                                { name: 'models/gemini-2.5-pro-preview-tts', supportedGenerationMethods: ['generateContent'] },
                                { name: 'models/gemini-flash-latest', supportedGenerationMethods: ['generateContent'] }
                            ]
                        })
                    };
                }
                if (target.includes('/models/gemini-flash-latest:generateContent')) {
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({
                            candidates: [{ content: { parts: [{ text: 'OK' }] } }]
                        })
                    };
                }
                const errBody = JSON.stringify({ error: { message: 'Model unavailable for generateContent' } });
                return { ok: false, status: 404, text: async () => errBody, json: async () => JSON.parse(errBody) };
            };
            const multiHopDiag = await request({
                port,
                method: 'POST',
                reqPath: '/api/language/test-gemini',
                headers: { Cookie: adminCookie },
                body: { model: 'gemini-2.5-flash-lite' }
            });
            assert.strictEqual(multiHopDiag.status, 200);
            const multiHopJson = JSON.parse(multiHopDiag.body);
            assert.strictEqual(multiHopJson.ok, true);
            assert.strictEqual(multiHopJson.suggestedModel, 'gemini-flash-latest');
            assert.strictEqual(multiHopJson.availableModels.some(m => m.includes('-tts')), false);

            // 4c. Recuperación ante TimeoutError en primer intento (p.ej. modelo lento / IPv6 stall)
            global.fetch = async (url) => {
                const target = String(url);
                if (target.endsWith('/v1beta/models')) {
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({
                            models: [
                                { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
                                { name: 'models/gemini-flash-latest', supportedGenerationMethods: ['generateContent'] }
                            ]
                        })
                    };
                }
                if (target.includes('/models/gemini-2.5-pro:generateContent')) {
                    const err = new Error('The operation was aborted due to timeout');
                    err.name = 'TimeoutError';
                    throw err;
                }
                if (target.includes('/models/gemini-flash-latest:generateContent')) {
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({
                            candidates: [{ content: { parts: [{ text: 'OK' }] } }]
                        })
                    };
                }
                const errBody = JSON.stringify({ error: { message: 'Not found' } });
                return { ok: false, status: 404, text: async () => errBody, json: async () => JSON.parse(errBody) };
            };
            const timeoutRecDiag = await request({
                port,
                method: 'POST',
                reqPath: '/api/language/test-gemini',
                headers: { Cookie: adminCookie },
                body: { model: 'gemini-2.5-pro' }
            });
            assert.strictEqual(timeoutRecDiag.status, 200);
            const timeoutRecJson = JSON.parse(timeoutRecDiag.body);
            assert.strictEqual(timeoutRecJson.ok, true);
            assert.strictEqual(timeoutRecJson.suggestedModel, 'gemini-flash-latest');

            // 5. Si Gemini falla completamente con 404 en palabra desconocida, cae a local SIN envenenar languageMemory
            global.fetch = async (url) => {
                const target = String(url);
                if (target.endsWith('/v1beta/models')) {
                    return { ok: true, status: 200, json: async () => ({ models: [] }) };
                }
                return {
                    ok: false,
                    status: 404,
                    text: async () => JSON.stringify({ error: { message: 'Model unavailable' } }),
                    json: async () => ({ error: { message: 'Model unavailable' } })
                };
            };

            const failKoRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/language/translate',
                headers: { Cookie: adminCookie },
                body: { text: '컴퓨터', direction: 'ko_es', mode: 'gemini' }
            });
            assert.strictEqual(failKoRes.status, 200);
            const failKoJson = JSON.parse(failKoRes.body);
            assert.strictEqual(failKoJson.engine, 'local-linguistic');
            assert.strictEqual(failKoJson.rememberable, false);

            const failEnRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/language/translate',
                headers: { Cookie: adminCookie },
                body: { text: 'ephemeral', direction: 'en_es', mode: 'gemini' }
            });
            assert.strictEqual(failEnRes.status, 200);
            const failEnJson = JSON.parse(failEnRes.body);
            assert.strictEqual(failEnJson.engine, 'local-linguistic');
            assert.strictEqual(failEnJson.rememberable, false);

            const settingsAfter = await request({
                port,
                reqPath: '/api/settings',
                headers: { Cookie: adminCookie }
            });
            assert.strictEqual(settingsAfter.status, 200);
            const savedMem = JSON.parse(settingsAfter.body).languageMemory || { terms: [] };
            assert.strictEqual(
                savedMem.terms.some(t => t.term === '컴퓨터' || t.term === 'ephemeral' || langStudio.isPoisonedMemoryMeaning(t.meaning)),
                false,
                'Nunca debe guardar errores de Gemini o instrucciones de Settings en languageMemory'
            );

            // 6. Escribir Hangul ('한국어') con selector en en_es en modo offline autocorrige dirección a ko_es
            const hangulAutoDirRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/language/translate',
                headers: { Cookie: adminCookie },
                body: { text: '한국어', direction: 'en_es', mode: 'offline' }
            });
            assert.strictEqual(hangulAutoDirRes.status, 200);
            const hangulAutoDirJson = JSON.parse(hangulAutoDirRes.body);
            assert.strictEqual(hangulAutoDirJson.direction, 'ko_es');
            assert.match(hangulAutoDirJson.translatedText, /Coreano/i);
        } finally {
            global.fetch = origFetch;
            await request({
                port,
                method: 'PUT',
                reqPath: '/api/settings',
                headers: { Cookie: adminCookie },
                body: { geminiModel: 'gemini-2.5-flash' }
            });
        }
    });

    it('resuelve metadatos completos (álbum, año, artista y embeddable) desde POST /api/english/music/resolve', async () => {
        // Creamos mini álbum único para probar emparejamiento con catálogo incluso sin bloque "Provided to YouTube"
        const albRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/english/music/albums',
            headers: { Cookie: adminCookie },
            body: {
                mainArtist: 'BABYMONSTER',
                artistType: 'group',
                albumTitle: 'We go up',
                albumType: 'mini_album',
                albumYear: 2025
            }
        });
        assert.strictEqual(albRes.status, 201);

        const origFetch = global.fetch;
        global.fetch = async (url) => {
            const target = String(url);
            if (target.includes('youtube.com/oembed')) {
                const isWeGoUp = target.includes('wgu98765432');
                return {
                    ok: true,
                    json: async () => ({
                        title: isWeGoUp ? "BABYMONSTER - 'WE GO UP' M/V" : "BABYMONSTER - 'DRIP' M/V",
                        author_name: 'BABYMONSTER'
                    })
                };
            }
            if (target.includes('youtube.com/watch?v=Zp-Jhuhq0bQ')) {
                const playerResp = {
                    videoDetails: {
                        title: "BABYMONSTER - 'DRIP' M/V",
                        author: 'BABYMONSTER',
                        shortDescription: 'Provided to YouTube by YG PLUS\n\nDRIP · BABYMONSTER\n\nDRIP\n\nReleased on: 2024-11-01'
                    },
                    playabilityStatus: { status: 'OK', playableInEmbed: false }
                };
                return {
                    ok: true,
                    text: async () => `<script>var ytInitialPlayerResponse = ${JSON.stringify(playerResp)};</script>`
                };
            }
            if (target.includes('youtube.com/watch?v=wgu98765432')) {
                const playerResp = {
                    videoDetails: {
                        title: "BABYMONSTER - 'WE GO UP' M/V",
                        author: 'BABYMONSTER',
                        shortDescription: 'Official Music Video'
                    },
                    playabilityStatus: { status: 'OK', playableInEmbed: true }
                };
                return {
                    ok: true,
                    text: async () => `<script>var ytInitialPlayerResponse = ${JSON.stringify(playerResp)};</script>`
                };
            }
            return { ok: false };
        };

        try {
            const resolveRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/english/music/resolve',
                headers: { Cookie: adminCookie },
                body: { url: 'https://music.youtube.com/watch?v=Zp-Jhuhq0bQ&list=RDAMVMZp-Jhuhq0bQ' }
            });
            assert.strictEqual(resolveRes.status, 200);
            const data = JSON.parse(resolveRes.body);
            assert.strictEqual(data.videoId, 'Zp-Jhuhq0bQ');
            assert.strictEqual(data.ytMusicUrl, 'https://music.youtube.com/watch?v=Zp-Jhuhq0bQ');
            assert.strictEqual(data.youtubeUrl, 'https://www.youtube.com/watch?v=Zp-Jhuhq0bQ');
            assert.strictEqual(data.suggestedTitle, 'DRIP');
            assert.strictEqual(data.suggestedArtist, 'BABYMONSTER');
            assert.strictEqual(data.suggestedAlbumTitle, 'DRIP');
            assert.strictEqual(data.suggestedAlbumType, 'album');
            assert.strictEqual(data.suggestedAlbumYear, 2024);
            assert.strictEqual(data.embeddable, false);

            const resolveWguRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/english/music/resolve',
                headers: { Cookie: adminCookie },
                body: { url: 'https://www.youtube.com/watch?v=wgu98765432' }
            });
            assert.strictEqual(resolveWguRes.status, 200);
            const wguData = JSON.parse(resolveWguRes.body);
            assert.strictEqual(wguData.suggestedTitle, 'WE GO UP');
            assert.strictEqual(wguData.suggestedArtist, 'BABYMONSTER');
            assert.strictEqual(wguData.suggestedAlbumTitle, 'We go up');
            assert.strictEqual(wguData.suggestedAlbumType, 'mini_album');
            assert.strictEqual(wguData.suggestedAlbumYear, 2025);
            assert.strictEqual(wguData.embeddable, true);
        } finally {
            global.fetch = origFetch;
        }
    });

    it('persiste año sin álbum, pasa artista vinculado al resolver letras sin álbum e integra InnerTube+iTunes en resolve', async () => {
        const ytdlpService = require(path.join(ROOT, 'lib', 'ytdlp-service'));
        const origExtract = ytdlpService.extractSongLyrics;
        const origFetch = global.fetch;

        try {
            // 1. Crear canción CON año (2019) y SIN álbum (albumTitle vacío)
            const createNoAlbum = await request({
                port,
                method: 'POST',
                reqPath: '/api/english/music/songs',
                headers: { Cookie: adminCookie },
                body: {
                    titulo: 'Blueming',
                    mainArtist: 'IU',
                    artistType: 'solo',
                    albumTitle: '',
                    albumType: 'single',
                    albumYear: 2019,
                    idioma: 'English + Korean (K-Pop)',
                    ytMusicUrl: 'https://www.youtube.com/watch?v=D1PvIWdJ8xo'
                }
            });
            assert.strictEqual(createNoAlbum.status, 201);
            const { songId: noAlbumSongId } = JSON.parse(createNoAlbum.body);
            assert.ok(noAlbumSongId);

            // Verificar que el catálogo devuelve album_anio=2019 aunque album_titulo sea null
            const catRes = await request({
                port,
                reqPath: '/api/english/music/catalog',
                headers: { Cookie: adminCookie }
            });
            assert.strictEqual(catRes.status, 200);
            const catJson = JSON.parse(catRes.body);
            const savedNoAlbum = catJson.songs.find((s) => Number(s.id) === Number(noAlbumSongId));
            assert.ok(savedNoAlbum);
            assert.strictEqual(savedNoAlbum.album_titulo, null);
            assert.strictEqual(savedNoAlbum.album_anio, 2019);

            // 2. Resolver letras sobre canción SIN álbum -> extractSongLyrics recibe trackArtist='IU' y useExternalFallbacks=true
            let capturedExtractOpts = null;
            ytdlpService.extractSongLyrics = async (opts) => {
                capturedExtractOpts = opts;
                return {
                    ok: true,
                    videoId: opts.videoId,
                    lyrics: '[KO]\n뭐해라는 두 글자에\n[EN]\nI feel blue',
                    source: 'lrclib',
                    language: 'ko,en',
                    tracks: { original: '', ko: '뭐해라는 두 글자에', en: 'I feel blue', ja: '', es: '' },
                    trackList: [],
                    ytdlpAvailable: true,
                    availableLangs: []
                };
            };

            const resLyrics = await request({
                port,
                method: 'POST',
                reqPath: `/api/english/music/songs/${noAlbumSongId}/resolve-lyrics`,
                headers: { Cookie: adminCookie },
                body: { forceExtract: true }
            });
            assert.strictEqual(resLyrics.status, 200);
            const resLyricsJson = JSON.parse(resLyrics.body);
            assert.strictEqual(resLyricsJson.ok, true);
            assert.strictEqual(resLyricsJson.source, 'lrclib');
            assert.ok(capturedExtractOpts);
            assert.strictEqual(capturedExtractOpts.trackArtist, 'IU');
            assert.strictEqual(capturedExtractOpts.useExternalFallbacks, true);

            // 3. Auto-fill POST /api/english/music/resolve integrando YT Music InnerTube + iTunes (lyric video 2025 de canción de 2019)
            global.fetch = async (url) => {
                const target = String(url);
                if (target.includes('youtube.com/oembed')) {
                    return {
                        ok: true,
                        json: async () => ({
                            title: '[MV] IU(아이유) _ Blueming(블루밍)',
                            author_name: '1theK (원더케이)'
                        })
                    };
                }
                if (target.includes('youtube.com/watch?v=lyr2025vid1')) {
                    const playerResp = {
                        videoDetails: {
                            title: 'Blueming (Color Coded Lyrics Eng/Rom/Han)',
                            author: 'Jaeguchi',
                            shortDescription: 'Lyric video uploaded in 2025'
                        },
                        microformat: {
                            playerMicroformatRenderer: { publishDate: '2025-02-10' }
                        },
                        playabilityStatus: { status: 'OK', playableInEmbed: true }
                    };
                    return {
                        ok: true,
                        text: async () => `<script>var ytInitialPlayerResponse = ${JSON.stringify(playerResp)};</script>`
                    };
                }
                if (target.includes('music.youtube.com/youtubei/v1/next')) {
                    return {
                        ok: true,
                        json: async () => ({
                            contents: {
                                singleColumnMusicWatchNextResultsRenderer: {
                                    tabbedRenderer: {
                                        watchNextTabbedResultsRenderer: {
                                            tabs: [{
                                                tabRenderer: {
                                                    content: {
                                                        musicQueueRenderer: {
                                                            content: {
                                                                playlistPanelRenderer: {
                                                                    contents: [{
                                                                        playlistPanelVideoRenderer: {
                                                                            videoId: 'lyr2025vid1',
                                                                            title: { runs: [{ text: 'Blueming' }] },
                                                                            longBylineText: {
                                                                                runs: [
                                                                                    { text: 'IU' },
                                                                                    { text: ' • ' },
                                                                                    { text: 'Blueming - Single' },
                                                                                    { text: ' • ' },
                                                                                    { text: '2019' }
                                                                                ]
                                                                            }
                                                                        }
                                                                    }]
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }]
                                        }
                                    }
                                }
                            }
                        })
                    };
                }
                if (target.includes('itunes.apple.com/search')) {
                    return {
                        ok: true,
                        json: async () => ({
                            results: [{
                                trackName: 'Blueming',
                                artistName: 'IU',
                                collectionName: 'Blueming - Single',
                                releaseDate: '2019-11-18T08:00:00Z',
                                trackNumber: 1,
                                primaryGenreName: 'K-Pop',
                                trackTimeMillis: 217000
                            }]
                        })
                    };
                }
                return { ok: false };
            };

            const extResolveRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/english/music/resolve',
                headers: { Cookie: adminCookie },
                body: { url: 'https://www.youtube.com/watch?v=lyr2025vid1' }
            });
            assert.strictEqual(extResolveRes.status, 200);
            const extJson = JSON.parse(extResolveRes.body);
            assert.strictEqual(extJson.suggestedTitle, 'Blueming');
            assert.strictEqual(extJson.suggestedArtist, 'IU');
            assert.strictEqual(extJson.suggestedAlbumYear, 2019);
            assert.strictEqual(extJson.suggestedLanguage, 'English + Korean (K-Pop)');
            assert.strictEqual(extJson.suggestedArtistType, 'solo');
            assert.strictEqual(extJson.suggestedAlbumIsSingleDuplicate, true);
        } finally {
            ytdlpService.extractSongLyrics = origExtract;
            global.fetch = origFetch;
        }
    });

    it('soporta puente E2EE en RAM PC <-> EC2 (HMAC), extracción sin BD y streaming media 206 seguro', async () => {
        const nodeCrypto = require('node:crypto');
        const ytdlpService = require(path.join(ROOT, 'lib', 'ytdlp-service'));
        const origExtract = ytdlpService.extractSongLyrics;
        const origStream = ytdlpService.resolvePlayableMediaStream;
        const origFetch = global.fetch;

        const signPcBridge = (method, reqPath, encryptedBlob = '') => {
            const secret = process.env.JOURNAL_SECRET_KEY || process.env.ADMIN_SECRET;
            const cleanPath = reqPath.split('?')[0];
            const ts = String(Math.floor(Date.now() / 1000));
            const bodyHash = nodeCrypto.createHash('sha256').update(encryptedBlob, 'utf8').digest('hex');
            const canonical = `${method.toUpperCase()}:${cleanPath}:${ts}:${bodyHash}`;
            const sig = nodeCrypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
            return { 'X-PC-Timestamp': ts, 'X-PC-Signature': sig };
        };

        // 1. RBAC: solo admin puede consultar estado yt-dlp
        const medicoStatus = await request({
            port,
            reqPath: '/api/english/music/ytdlp-status',
            headers: { Cookie: medicoCookie }
        });
        assert.strictEqual(medicoStatus.status, 403);

        const adminStatusInitial = await request({
            port,
            reqPath: '/api/english/music/ytdlp-status',
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(adminStatusInitial.status, 200);
        const statusInitJson = JSON.parse(adminStatusInitial.body);
        assert.strictEqual(typeof statusInitJson.available, 'boolean');
        assert.strictEqual(statusInitJson.jsRuntime, 'node');
        assert.strictEqual(statusInitJson.pcOnline, false);

        // 2. Registrar canción para extraer letras y probar puente PC / stream
        const createRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/english/music/songs',
            headers: { Cookie: adminCookie },
            body: {
                titulo: 'FOREVER',
                mainArtist: 'BABYMONSTER',
                artistType: 'group',
                albumTitle: 'Drip',
                albumType: 'album',
                albumYear: 2024,
                numeroPista: 7,
                idioma: 'English + Korean',
                ytMusicUrl: 'https://www.youtube.com/watch?v=eJCHKjt0MPw'
            }
        });
        assert.strictEqual(createRes.status, 201);
        const { songId } = JSON.parse(createRes.body);
        assert.ok(songId);

        ytdlpService.extractSongLyrics = async ({ videoId }) => ({
            ok: true,
            videoId,
            lyrics: 'Forever ever never fade\n영원히 빛나',
            source: 'yt-dlp:en',
            language: 'en',
            ytdlpAvailable: true,
            availableLangs: ['en', 'ko'],
            suggestedCommand: `python sincronitation/yt_lyrics_helper.py "https://www.youtube.com/watch?v=${videoId}" --clip`
        });

        ytdlpService.resolvePlayableMediaStream = async ({ videoId }) => ({
            ok: true,
            videoId,
            streamUrl: 'https://rr1---sn-test.googlevideo.com/videoplayback?id=forever',
            contentType: 'video/mp4',
            headers: { 'User-Agent': 'MockPlayerUA/1.0' }
        });

        global.fetch = async (url, opts) => {
            if (String(url).includes('googlevideo.com/videoplayback')) {
                assert.strictEqual(opts.headers.Range, 'bytes=0-9');
                return new Response(Buffer.from('0123456789'), {
                    status: 206,
                    headers: {
                        'Content-Type': 'video/mp4',
                        'Content-Length': '10',
                        'Content-Range': 'bytes 0-9/100'
                    }
                });
            }
            return origFetch(url, opts);
        };

        try {
            // 3. Extracción fallback sin almacenar en DB ni disco (storedInDb: false)
            const extractRes = await request({
                port,
                method: 'POST',
                reqPath: `/api/english/music/songs/${songId}/lyrics/extract`,
                headers: { Cookie: adminCookie },
                body: {}
            });
            assert.strictEqual(extractRes.status, 200);
            const extJson = JSON.parse(extractRes.body);
            assert.strictEqual(extJson.ok, true);
            assert.strictEqual(extJson.storedInDb, false);
            assert.strictEqual(extJson.source, 'yt-dlp:en');
            assert.match(extJson.lyrics, /Forever ever never fade/);

            // 3b. Resolución autónoma en la nube (Tiers 1-3) con PC apagada (pcOnline: false)
            const resolveRes = await request({
                port,
                method: 'POST',
                reqPath: `/api/english/music/songs/${songId}/resolve-lyrics`,
                headers: { Cookie: adminCookie },
                body: { forceExtract: true }
            });
            assert.strictEqual(resolveRes.status, 200);
            const resolveJson = JSON.parse(resolveRes.body);
            assert.strictEqual(resolveJson.ok, true);
            assert.ok(resolveJson.tier === 2 || resolveJson.tier === 3, `Se esperaba Tier 2 o 3, recibido ${resolveJson.tier}`);
            assert.strictEqual(resolveJson.tokensUsed, 0);
            assert.strictEqual(resolveJson.storedInDb, false);
            assert.strictEqual(resolveJson.pcOnline, false);
            assert.match(String(resolveJson.lyrics || ''), /Forever ever never fade/);

            // 4. Catálogo NO expone ni guarda letras en MySQL
            const catRes = await request({
                port,
                reqPath: '/api/english/music/catalog',
                headers: { Cookie: adminCookie }
            });
            assert.strictEqual(catRes.status, 200);
            const catData = JSON.parse(catRes.body);
            const savedSong = catData.songs.find((s) => Number(s.id) === Number(songId));
            assert.ok(savedSong);
            assert.strictEqual(savedSong.lyrics_text, undefined);
            assert.strictEqual(savedSong.lyrics_source, undefined);

            // 5. El endpoint antiguo PUT /lyrics en BD fue retirado
            const removedPutRes = await request({
                port,
                method: 'PUT',
                reqPath: `/api/english/music/songs/${songId}/lyrics`,
                headers: { Cookie: adminCookie },
                body: { lyrics: 'should not persist in DB' }
            });
            assert.strictEqual(removedPutRes.status, 404);

            // 6. Puente E2EE Site-to-Site PC <-> EC2 RAM (HMAC + purga inmediata en RAM)
            const unsignedPoll = await request({
                port,
                reqPath: '/api/english/music/pc-jobs/poll?waitMs=0'
            });
            assert.strictEqual(unsignedPoll.status, 401);

            const signedEmptyPoll = await request({
                port,
                reqPath: '/api/english/music/pc-jobs/poll?waitMs=0',
                headers: signPcBridge('GET', '/api/english/music/pc-jobs/poll')
            });
            assert.strictEqual(signedEmptyPoll.status, 200);
            assert.deepStrictEqual(JSON.parse(signedEmptyPoll.body).jobs, []);

            // Tras el poll de la PC, ytdlp-status reporta pcOnline: true
            const adminStatusOnline = await request({
                port,
                reqPath: '/api/english/music/ytdlp-status',
                headers: { Cookie: adminCookie }
            });
            assert.strictEqual(JSON.parse(adminStatusOnline.body).pcOnline, true);

            const medicoPostJob = await request({
                port,
                method: 'POST',
                reqPath: '/api/english/music/pc-jobs',
                headers: { Cookie: medicoCookie },
                body: { encryptedRequest: 'deadbeef:abc' }
            });
            assert.strictEqual(medicoPostJob.status, 403);

            const encryptedReqBlob = '00112233445566778899aabbccddeeff:ENCRYPTED_REQUEST_PAYLOAD';
            const postJobRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/english/music/pc-jobs',
                headers: { Cookie: adminCookie },
                body: { encryptedRequest: encryptedReqBlob }
            });
            assert.strictEqual(postJobRes.status, 201);
            const postJobJson = JSON.parse(postJobRes.body);
            assert.strictEqual(postJobJson.ok, true);
            assert.strictEqual(postJobJson.pcOnline, true);
            assert.match(postJobJson.jobId, /^[0-9a-f]{32}$/);

            const signedJobPoll = await request({
                port,
                reqPath: '/api/english/music/pc-jobs/poll?waitMs=0',
                headers: signPcBridge('GET', '/api/english/music/pc-jobs/poll')
            });
            assert.strictEqual(signedJobPoll.status, 200);
            const polledJobs = JSON.parse(signedJobPoll.body).jobs;
            assert.strictEqual(polledJobs.length, 1);
            assert.strictEqual(polledJobs[0].jobId, postJobJson.jobId);
            assert.strictEqual(polledJobs[0].encryptedRequest, encryptedReqBlob);

            const encryptedResultBlob = 'ffeeddccbbaa99887766554433221100:ENCRYPTED_LYRICS_RESULT';
            const unsignedResult = await request({
                port,
                method: 'POST',
                reqPath: `/api/english/music/pc-jobs/${postJobJson.jobId}/result`,
                body: { encryptedResult: encryptedResultBlob }
            });
            assert.strictEqual(unsignedResult.status, 401);

            const signedResult = await request({
                port,
                method: 'POST',
                reqPath: `/api/english/music/pc-jobs/${postJobJson.jobId}/result`,
                headers: signPcBridge('POST', `/api/english/music/pc-jobs/${postJobJson.jobId}/result`, encryptedResultBlob),
                body: { encryptedResult: encryptedResultBlob }
            });
            assert.strictEqual(signedResult.status, 200);

            const medicoGetJob = await request({
                port,
                reqPath: `/api/english/music/pc-jobs/${postJobJson.jobId}`,
                headers: { Cookie: medicoCookie }
            });
            assert.strictEqual(medicoGetJob.status, 403);

            const adminGetJob = await request({
                port,
                reqPath: `/api/english/music/pc-jobs/${postJobJson.jobId}`,
                headers: { Cookie: adminCookie }
            });
            assert.strictEqual(adminGetJob.status, 200);
            const adminJobJson = JSON.parse(adminGetJob.body);
            assert.strictEqual(adminJobJson.status, 'completed');
            assert.strictEqual(adminJobJson.encryptedResult, encryptedResultBlob);

            // Al entregarlo al navegador, el trabajo se purga inmediatamente de la RAM EC2
            const purgedGetJob = await request({
                port,
                reqPath: `/api/english/music/pc-jobs/${postJobJson.jobId}`,
                headers: { Cookie: adminCookie }
            });
            assert.strictEqual(purgedGetJob.status, 404);

            // 7. Media streaming 206 Range passthrough + RBAC 403
            const medicoMedia = await request({
                port,
                reqPath: `/api/english/music/songs/${songId}/media`,
                headers: { Cookie: medicoCookie }
            });
            assert.strictEqual(medicoMedia.status, 403);

            const mediaRes = await request({
                port,
                reqPath: `/api/english/music/songs/${songId}/media`,
                headers: { Cookie: adminCookie, Range: 'bytes=0-9' }
            });
            assert.strictEqual(mediaRes.status, 206);
            assert.strictEqual(mediaRes.headers['content-type'], 'video/mp4');
            assert.strictEqual(mediaRes.headers['accept-ranges'], 'bytes');
            assert.strictEqual(mediaRes.headers['content-range'], 'bytes 0-9/100');
            assert.strictEqual(mediaRes.body, '0123456789');

            // 8. Defensa SSRF: URL CDN no permitida debe bloquearse con 502
            ytdlpService.resolvePlayableMediaStream = async ({ videoId }) => ({
                ok: true,
                videoId,
                streamUrl: 'http://169.254.169.254/latest/meta-data/'
            });
            const ssrfRes = await request({
                port,
                reqPath: `/api/english/music/songs/${songId}/media`,
                headers: { Cookie: adminCookie }
            });
            assert.strictEqual(ssrfRes.status, 502);
        } finally {
            ytdlpService.extractSongLyrics = origExtract;
            ytdlpService.resolvePlayableMediaStream = origStream;
            global.fetch = origFetch;
        }
    });

    it('soporta entrega instantánea vía long-poll (?waitMs=...) en /api/pull-english y traduce letras completas a español con RBAC', async () => {
        // 1. Long-poll /api/pull-english?waitMs=2500 despierta al instante cuando /api/send-english recibe un payload
        const t0 = Date.now();
        const pollPromise = request({
            port,
            reqPath: '/api/pull-english?waitMs=2500'
        });

        await new Promise((resolve) => setTimeout(resolve, 75));
        const cipherEntry = 'E2EE::{"category":"music","song_title":"SHEESH","lyrics_study":"Test"}';
        const sendRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/send-english',
            headers: { Cookie: adminCookie },
            body: { texto: cipherEntry }
        });
        assert.strictEqual(sendRes.status, 200);

        const pollRes = await pollPromise;
        const elapsedMs = Date.now() - t0;
        assert.strictEqual(pollRes.status, 200);
        const pulledItems = JSON.parse(pollRes.body);
        assert.deepStrictEqual(pulledItems, [cipherEntry]);
        assert.ok(elapsedMs < 1800, `Se esperaba entrega casi instantánea por long-poll (<1800ms), tardó ${elapsedMs}ms`);

        // Con queue vacía y waitMs=0 sigue devolviendo [] de inmediato
        const immediateEmpty = await request({ port, reqPath: '/api/pull-english' });
        assert.strictEqual(immediateEmpty.status, 200);
        assert.deepStrictEqual(JSON.parse(immediateEmpty.body), []);

        // 2. RBAC & traducción completa de letra a español vía Gemini mockeado + modo offline
        const unauthTr = await request({
            port,
            method: 'POST',
            reqPath: '/api/english/music/translate-lyrics',
            body: { lyrics: 'We go up like a rocket' }
        });
        assert.strictEqual(unauthTr.status, 401);

        const medicoTr = await request({
            port,
            method: 'POST',
            reqPath: '/api/english/music/translate-lyrics',
            headers: { Cookie: medicoCookie },
            body: { lyrics: 'We go up like a rocket' }
        });
        assert.strictEqual(medicoTr.status, 403);

        const origFetch = global.fetch;
        try {
            global.fetch = async (url) => {
                if (String(url).includes('generativelanguage.googleapis.com')) {
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({
                            candidates: [{
                                content: {
                                    parts: [{
                                        text: JSON.stringify({
                                            spanishLyrics: '[Coro]\nSubimos como un cohete\nMíranos brillar en la noche',
                                            detectedLanguages: ['English']
                                        })
                                    }]
                                }
                            }]
                        })
                    };
                }
                return origFetch(url);
            };

            const aiRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/english/music/translate-lyrics',
                headers: { Cookie: adminCookie },
                body: {
                    lyrics: '[Chorus]\nWe go up like a rocket\nWatch us glow in the night',
                    songTitle: 'FOREVER',
                    artistName: 'BABYMONSTER',
                    language: 'English + Korean',
                    apiKey: 'AIzaSyFakeTestKeyForUnitMock123456'
                }
            });
            assert.strictEqual(aiRes.status, 200);
            const aiBody = JSON.parse(aiRes.body);
            assert.strictEqual(aiBody.ok, true);
            assert.strictEqual(aiBody.usedGemini, true);
            assert.match(aiBody.spanishLyrics, /Subimos como un cohete/);
            assert.match(aiBody.formattedSection, /=== \[ES — Traducción IA\] ===/);

            const offlineRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/english/music/translate-lyrics',
                headers: { Cookie: adminCookie },
                body: {
                    lyrics: '영원할 것처럼\nWe rise together',
                    mode: 'offline'
                }
            });
            assert.strictEqual(offlineRes.status, 200);
            const offBody = JSON.parse(offlineRes.body);
            assert.strictEqual(offBody.ok, true);
            assert.strictEqual(offBody.usedGemini, false);
            assert.ok(offBody.spanishLyrics.length > 10);
        } finally {
            global.fetch = origFetch;
        }
    });

    it('valida Fases 1-5 E2E: TecNM Saltillo, Crisis 250c, Lecciones Secuenciales, Gemini Activo, 503 PC Offline y Drive 2 aislado', async () => {
        // 1. TecNM Saltillo coordenadas exactas en /api/planner
        const plannerRes = await request({
            port,
            reqPath: '/api/planner',
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(plannerRes.status, 200);
        const dir = JSON.parse(plannerRes.body).campusDirectory;
        assert.strictEqual(dir.principal.lat, 25.4414);
        assert.strictEqual(dir.principal.lng, -100.9922);
        assert.strictEqual(dir.boillot.lat, 25.4385);
        assert.strictEqual(dir.boillot.lng, -100.9940);
        assert.strictEqual(dir.miravalle.lat, 25.4194);
        assert.strictEqual(dir.miravalle.lng, -101.0232);

        // 2. Crisis > 250 chars rechazado y Otro requiere detalle/motivo; motivo vacío permitido cuando tipo != Otro
        const longCrisis = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-crisis',
            headers: { Cookie: adminCookie },
            body: { fecha: '2026-11-16', hora: '10:00', tipoCrisis: 'Estrés', intensidad: 3, motivo: 'x'.repeat(251) }
        });
        assert.strictEqual(longCrisis.status, 400);

        const quickCrisis = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-crisis',
            headers: { Cookie: adminCookie },
            body: { fecha: '2026-11-16', hora: '10:05', tipoCrisis: 'Ansiedad', intensidad: 2, motivo: '', allowOptionalMotivo: true }
        });
        assert.strictEqual(quickCrisis.status, 200);

        const customOtroCrisis = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-crisis',
            headers: { Cookie: adminCookie },
            body: {
                fecha: '2026-11-16',
                hora: '10:15',
                tipoCrisis: 'Otro',
                detalleOtro: 'Frustración, rabia y odio',
                intensidad: 4,
                motivo: 'Estafaron a mi cuñado'
            }
        });
        assert.strictEqual(customOtroCrisis.status, 200);
        const customOtroBody = JSON.parse(customOtroCrisis.body);
        assert.strictEqual(customOtroBody.tipo_crisis, 'Frustración, rabia y odio');
        assert.strictEqual(customOtroBody.motivo, 'Estafaron a mi cuñado');
        assert.strictEqual(customOtroBody.motivo.includes('['), false, 'El motivo de crisis Otro no debe incluir corchetes');

        // 3. Modelos Gemini activos solamente + Toggle aprendizaje secuencial + Word inactivity + Contrato ligero
        const prevEnvGemini = process.env.GEMINI_API_KEY;
        delete process.env.GEMINI_API_KEY;
        await request({
            port,
            method: 'PUT',
            reqPath: '/api/settings',
            headers: { Cookie: adminCookie },
            body: { clearGeminiApiKey: true, geminiMode: 'fast' }
        });
        try {
            const regRes = await request({
                port,
                reqPath: '/api/language/registry',
                headers: { Cookie: adminCookie }
            });
            assert.strictEqual(regRes.status, 200);
            const regBody = JSON.parse(regRes.body);
            assert.deepStrictEqual(regBody.geminiModels, [], 'Sin API key activa no debe listar modelos ficticios');
        } finally {
            if (prevEnvGemini !== undefined) process.env.GEMINI_API_KEY = prevEnvGemini;
        }

        const toggleRes = await request({
            port,
            method: 'PATCH',
            reqPath: '/api/language/learning-toggle',
            headers: { Cookie: adminCookie },
            body: { active: true, topic: 'Práctica diaria 15 min' }
        });
        assert.strictEqual(toggleRes.status, 200);
        assert.strictEqual(JSON.parse(toggleRes.body).languageLearningActive, true);

        const lessonsRes = await request({
            port,
            reqPath: '/api/language/lessons',
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(lessonsRes.status, 200);
        const lessonsJson = JSON.parse(lessonsRes.body);
        assert.ok(Array.isArray(lessonsJson.lessons) && lessonsJson.lessons.length >= 6);
        assert.strictEqual(lessonsJson.lessons[0].lesson_name, lessonsJson.lessons[0].nombre);
        assert.strictEqual(typeof lessonsJson.lessons[0].completed, 'boolean');
        assert.strictEqual(lessonsJson.lessons[1].locked, true, 'La 2da lección permanece bloqueada hasta completar la 1ra');

        // Intentar completar sin leer Word bloquea por inactividad / falta de lectura en Word
        const firstLessonId = lessonsJson.lessons[0].id;
        const blockedComplete = await request({
            port,
            method: 'PATCH',
            reqPath: `/api/language/lessons/${firstLessonId}/complete`,
            headers: { Cookie: adminCookie },
            body: { wordReadConfirmed: false }
        });
        assert.strictEqual(blockedComplete.status, 409);

        const actRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/language/word-activity',
            headers: { Cookie: adminCookie },
            body: { action: 'word_review_test' }
        });
        assert.strictEqual(actRes.status, 200);

        const unlockedComplete = await request({
            port,
            method: 'PATCH',
            reqPath: `/api/language/lessons/${firstLessonId}/complete`,
            headers: { Cookie: adminCookie },
            body: { wordReadConfirmed: true }
        });
        assert.strictEqual(unlockedComplete.status, 200);

        const lessonsAfter = JSON.parse((await request({ port, reqPath: '/api/language/lessons', headers: { Cookie: adminCookie } })).body);
        assert.strictEqual(lessonsAfter.lessons[0].completed, true);
        assert.strictEqual(lessonsAfter.lessons[1].locked, false);

        // 4. Puente Drive 2 aislado rechaza Journal (403) y acepta sync-metadata en canción existente
        const signPcBridge = (method, reqPath, encryptedBlob = '') => {
            const secret = process.env.JOURNAL_SECRET_KEY || process.env.ADMIN_SECRET;
            const cleanPath = reqPath.split('?')[0];
            const ts = String(Math.floor(Date.now() / 1000));
            const bodyHash = crypto.createHash('sha256').update(encryptedBlob, 'utf8').digest('hex');
            const canonical = `${method.toUpperCase()}:${cleanPath}:${ts}:${bodyHash}`;
            const sig = crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
            return { 'X-PC-Timestamp': ts, 'X-PC-Signature': sig };
        };
        const badDriveJournal = await request({
            port,
            method: 'POST',
            reqPath: '/api/english/music/pc-word-drive-sync',
            headers: signPcBridge('POST', '/api/english/music/pc-word-drive-sync', 'abc'),
            body: { target: 'journal', encryptedDocxB64: 'abc' }
        });
        assert.strictEqual(badDriveJournal.status, 403);

        // Sin STUDY_RCLONE_CONF_B64, el Word debe enrutar al Drive principal ya configurado (RCLONE_REMOTE/RCLONE_BACKUP_DIR)
        const prevStudyRemote = process.env.STUDY_RCLONE_REMOTE;
        const prevStudyConf = process.env.STUDY_RCLONE_CONF_B64;
        const prevRcloneConf = process.env.RCLONE_CONFIG;
        delete process.env.STUDY_RCLONE_REMOTE;
        delete process.env.STUDY_RCLONE_CONF_B64;
        process.env.RCLONE_CONFIG = '/tmp/nonexistent_rclone_test_cfg.conf';
        try {
            const fakeDocxB64 = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(80, 0x41)]).toString('base64');
            const envelopeB64 = Buffer.from(JSON.stringify({ filename: 'English_Learning_Notebook.docx', docxB64: fakeDocxB64 }), 'utf8').toString('base64');
            const driveFallbackRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/english/music/pc-word-drive-sync',
                headers: signPcBridge('POST', '/api/english/music/pc-word-drive-sync', envelopeB64),
                body: { encryptedResult: envelopeB64 }
            });
            assert.strictEqual(driveFallbackRes.status, 200);
            const driveJson = JSON.parse(driveFallbackRes.body);
            assert.strictEqual(driveJson.remoteTarget, 'gdrive:RespaldosApp/NotasIdiomas/English_Learning_Notebook.docx');
        } finally {
            if (prevStudyRemote !== undefined) process.env.STUDY_RCLONE_REMOTE = prevStudyRemote;
            if (prevStudyConf !== undefined) process.env.STUDY_RCLONE_CONF_B64 = prevStudyConf;
            if (prevRcloneConf === undefined) delete process.env.RCLONE_CONFIG;
            else process.env.RCLONE_CONFIG = prevRcloneConf;
        }

        // Agenda > 1 mes consulta transparencia hacia Drive RAM sin error ni inserción a BD
        const oldAgendaRes = await request({
            port,
            reqPath: '/api/get-agenda?begin=2025-01-01&end=2025-01-07',
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(oldAgendaRes.status, 200);
        assert.ok(Array.isArray(JSON.parse(oldAgendaRes.body)));

        const songForMeta = await request({
            port,
            method: 'POST',
            reqPath: '/api/english/music/songs',
            headers: { Cookie: adminCookie },
            body: {
                titulo: 'LOVE, MAYBE',
                mainArtist: 'BABYMONSTER',
                albumTitle: 'DRIP',
                albumType: 'album',
                albumYear: '2024'
            }
        });
        assert.strictEqual(songForMeta.status, 201);
        const metaSongId = JSON.parse(songForMeta.body).songId;
        const syncMetaRes = await request({
            port,
            method: 'POST',
            reqPath: `/api/english/music/songs/${metaSongId}/sync-metadata`,
            headers: { Cookie: adminCookie },
            body: { releaseDate: '2024-11-01', releaseYear: 2024, trackNumber: 6 }
        });
        assert.strictEqual(syncMetaRes.status, 200);
        assert.strictEqual(JSON.parse(syncMetaRes.body).releaseDate, '2024-11-01');
    });

    it('expone GET /api/english/study-notebook con RBAC y evita llamadas redundantes a Gemini mediante caché de memoria/letras', async () => {
        const unauthNb = await request({ port, reqPath: '/api/english/study-notebook' });
        assert.strictEqual(unauthNb.status, 401);

        const nbRes = await request({
            port,
            reqPath: '/api/english/study-notebook?section=music',
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(nbRes.status, 200);
        const nbData = JSON.parse(nbRes.body);
        assert.strictEqual(nbData.ok, true);
        assert.ok(nbData.counts && typeof nbData.counts.total === 'number');
        assert.ok(nbData.facets && Array.isArray(nbData.facets.artists) && Array.isArray(nbData.facets.albums) && Array.isArray(nbData.facets.songs));
        assert.ok(Array.isArray(nbData.entries));

        // Verificar que POST /api/language/analyze sin "direction" no lanza ReferenceError y responde 200 con memoria/caché
        const memRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/language/memory',
            headers: { Cookie: adminCookie },
            body: {
                terms: [{
                    term: 'serendipity_cache_probe',
                    meaning: 'serendipia verificada en caché',
                    language: 'en',
                    category: 'vocabulary'
                }]
            }
        });
        assert.strictEqual(memRes.status, 200, memRes.body);
        const analyzeHitRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/language/analyze',
            headers: { Cookie: adminCookie },
            body: {
                text: 'serendipity_cache_probe',
                language: 'en',
                mode: 'auto'
            }
        });
        assert.strictEqual(analyzeHitRes.status, 200, analyzeHitRes.body);
        const analyzeHit = JSON.parse(analyzeHitRes.body);
        assert.strictEqual(analyzeHit.ok, true, analyzeHitRes.body);
        assert.strictEqual(analyzeHit.usedGemini, false, analyzeHitRes.body);
        assert.strictEqual(analyzeHit.cacheHit, true, analyzeHitRes.body);
        assert.match(String(analyzeHit.translatedText || ''), /serendipia verificada en caché/i);

        // Verificar que translate-lyrics extrae sección [ES] ya presente sin invocar Gemini
        const embLyricsRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/english/music/translate-lyrics',
            headers: { Cookie: adminCookie },
            body: {
                songTitle: 'Synthetic Cached Track',
                artistName: 'Test Artist',
                lyrics: '[EN]\nShine bright tonight\n\n=== [ES — Traducción IA] ===\nBrilla fuerte esta noche',
                mode: 'gemini',
                apiKey: 'AIzaFakeKeyShouldNotBeCalled'
            }
        });
        assert.strictEqual(embLyricsRes.status, 200);
        const embLyricsData = JSON.parse(embLyricsRes.body);
        assert.strictEqual(embLyricsData.usedGemini, false);
        assert.strictEqual(embLyricsData.cacheHit, true);
        assert.match(String(embLyricsData.spanishLyrics || ''), /Brilla fuerte esta noche/);

        // Verificar ahorro de tokens con pista nativa `tracks.es` de YouTube
        const ytCapsEsRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/english/music/translate-lyrics',
            headers: { Cookie: adminCookie },
            body: {
                songTitle: 'Track With Native Spanish Captions',
                artistName: 'Test Artist',
                lyrics: 'Baby got no chill',
                tracks: {
                    original: 'Baby got no chill',
                    es: 'Cierra los ojos ahora'
                },
                mode: 'gemini',
                apiKey: 'AIzaFakeKeyShouldNotBeCalled'
            }
        });
        assert.strictEqual(ytCapsEsRes.status, 200);
        const ytCapsEsData = JSON.parse(ytCapsEsRes.body);
        assert.strictEqual(ytCapsEsData.usedGemini, false);
        assert.strictEqual(ytCapsEsData.source, 'yt-captions');
        assert.strictEqual(ytCapsEsData.tokensUsed, 0);
        assert.match(String(ytCapsEsData.spanishLyrics || ''), /Cierra los ojos ahora/);
    });

    it('aplica REQUIRE_HTTPS, /healthz, CORS estricto y REQUIRE_PC_BRIDGE_AUTH en /api/pull-*', async () => {
        // 1. /healthz responde 200 OK aun bajo REQUIRE_HTTPS=true y sin TLS
        const prevReqHttps = process.env.REQUIRE_HTTPS;
        const prevPcAuth = process.env.REQUIRE_PC_BRIDGE_AUTH;
        const prevSecretKey = process.env.JOURNAL_SECRET_KEY;
        try {
            process.env.REQUIRE_HTTPS = 'true';
            process.env.REQUIRE_PC_BRIDGE_AUTH = 'true';
            process.env.JOURNAL_SECRET_KEY = '12345678901234567890123456789012';

            const healthRes = await request({ port, reqPath: '/healthz' });
            assert.strictEqual(healthRes.status, 200);
            const healthBody = JSON.parse(healthRes.body);
            assert.strictEqual(healthBody.ok, true);
            assert.ok(String(healthBody.slot || '').trim().length > 0);
            assert.ok(String(healthBody.replicaId || '').trim().length > 0);
            assert.ok(String(healthBody.version || '').trim().length > 0);

            // 2. API por HTTP plano sin TLS devuelve 426 Upgrade Required
            const plainApi = await request({ port, reqPath: '/api/auth/me' });
            assert.strictEqual(plainApi.status, 426);

            // 3. Navegador por HTTP plano redirige 308 -> https://
            const plainHtml = await request({ port, reqPath: '/index.html' });
            assert.strictEqual(plainHtml.status, 308);
            assert.match(String(plainHtml.headers.location || ''), /^https:\/\//);

            // 4. Con X-Forwarded-Proto: https sirve 200 + HSTS + upgrade-insecure-requests en CSP
            const httpsHtml = await request({
                port,
                reqPath: '/index.html',
                headers: { 'X-Forwarded-Proto': 'https' }
            });
            assert.strictEqual(httpsHtml.status, 200);
            assert.match(String(httpsHtml.headers['strict-transport-security'] || ''), /max-age=31536000/);
            assert.match(String(httpsHtml.headers['content-security-policy'] || ''), /upgrade-insecure-requests/);

            // 5. CORS estricto: rechaza orígenes externos hostiles y permite *.ts.net (Tailscale)
            const evilCors = await request({
                port,
                reqPath: '/api/auth/me',
                headers: { 'X-Forwarded-Proto': 'https', Origin: 'https://evil.example' }
            });
            assert.strictEqual(evilCors.headers['access-control-allow-origin'], undefined);
            assert.strictEqual(evilCors.headers['access-control-allow-credentials'], undefined);

            const tailscaleCors = await request({
                port,
                reqPath: '/api/auth/me',
                headers: { 'X-Forwarded-Proto': 'https', Origin: 'https://dailyhub-srv.tail1234.ts.net' }
            });
            assert.strictEqual(tailscaleCors.headers['access-control-allow-origin'], 'https://dailyhub-srv.tail1234.ts.net');
            assert.strictEqual(tailscaleCors.headers['access-control-allow-credentials'], 'true');

            // 6. Con REQUIRE_PC_BRIDGE_AUTH=true, /api/pull-text y /api/pull-english rechazan peticiones sin HMAC (401)
            const pullTextUnauth = await request({
                port,
                reqPath: '/api/pull-text',
                headers: { 'X-Forwarded-Proto': 'https' }
            });
            assert.strictEqual(pullTextUnauth.status, 401);

            const pullEngUnauth = await request({
                port,
                reqPath: '/api/pull-english',
                headers: { 'X-Forwarded-Proto': 'https' }
            });
            assert.strictEqual(pullEngUnauth.status, 401);

            // Y permiten petición firmada con HMAC-SHA256 válido
            const tsSec = String(Math.floor(Date.now() / 1000));
            const emptyBodyHash = crypto.createHash('sha256').update('', 'utf8').digest('hex');
            const canonical = `GET:/api/pull-text:${tsSec}:${emptyBodyHash}`;
            const sig = crypto.createHmac('sha256', process.env.JOURNAL_SECRET_KEY).update(canonical, 'utf8').digest('hex');
            const pullTextSigned = await request({
                port,
                reqPath: '/api/pull-text',
                headers: {
                    'X-Forwarded-Proto': 'https',
                    'x-pc-timestamp': tsSec,
                    'x-pc-signature': sig
                }
            });
            assert.strictEqual(pullTextSigned.status, 200);
        } finally {
            if (prevReqHttps === undefined) delete process.env.REQUIRE_HTTPS; else process.env.REQUIRE_HTTPS = prevReqHttps;
            if (prevPcAuth === undefined) delete process.env.REQUIRE_PC_BRIDGE_AUTH; else process.env.REQUIRE_PC_BRIDGE_AUTH = prevPcAuth;
            if (prevSecretKey === undefined) delete process.env.JOURNAL_SECRET_KEY; else process.env.JOURNAL_SECRET_KEY = prevSecretKey;
        }
    });

    it('expone GET /api/version autenticado con versión actual e historial SemVer 2.0.0', async () => {
        const unauthRes = await request({ port, reqPath: '/api/version' });
        assert.strictEqual(unauthRes.status, 401);

        const authRes = await request({
            port,
            reqPath: '/api/version',
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(authRes.status, 200);
        const body = JSON.parse(authRes.body);
        assert.match(String(body.currentVersion), /^\d+\.\d+\.\d+$/);
        assert.strictEqual(body.tag, `v${body.currentVersion}`);
        assert.match(String(body.standard), /SemVer 2\.0\.0/i);
        assert.ok(Array.isArray(body.history) && body.history.length >= 1);
        assert.strictEqual(body.history[0].version, body.currentVersion);
    });

    it('procesa notas autónomas en servidor (/api/send-english -> docx + caché) y expone estado/descarga RBAC del Journal local', async () => {
        const fs = require('node:fs');
        const os = require('node:os');
        const serverNotes = require('../lib/server-notes-service');
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdh-auto-notes-'));
        const prevKey = process.env.JOURNAL_SECRET_KEY;
        const prevEngPath = process.env.ENGLISH_WORD_FILE_PATH;
        const prevJrnPath = process.env.JOURNAL_LOCAL_PATH;
        const testKey = '0123456789abcdef0123456789abcdef';

        try {
            process.env.JOURNAL_SECRET_KEY = testKey;
            process.env.ENGLISH_WORD_FILE_PATH = path.join(tmpDir, 'English_Learning_Notebook.docx');
            process.env.JOURNAL_LOCAL_PATH = path.join(tmpDir, 'Diario.docx');

            const unauthStatus = await request({ port, reqPath: '/api/journal/local-status' });
            assert.strictEqual(unauthStatus.status, 401);

            const medicoStatus = await request({
                port,
                reqPath: '/api/journal/local-status',
                headers: { Cookie: medicoCookie }
            });
            assert.strictEqual(medicoStatus.status, 403);

            const adminStatus = await request({
                port,
                reqPath: '/api/journal/local-status',
                headers: { Cookie: adminCookie }
            });
            assert.strictEqual(adminStatus.status, 200);
            const jStatus = JSON.parse(adminStatus.body);
            assert.strictEqual(jStatus.ok, true);
            assert.strictEqual(jStatus.autonomousEnabled, true);
            assert.strictEqual(jStatus.exists, false);

            const medicoDl = await request({
                port,
                reqPath: '/api/journal/download',
                headers: { Cookie: medicoCookie }
            });
            assert.strictEqual(medicoDl.status, 403);

            const missingDl = await request({
                port,
                reqPath: '/api/journal/download',
                headers: { Cookie: adminCookie }
            });
            assert.strictEqual(missingDl.status, 404);

            const ytdlpStatusRes = await request({
                port,
                reqPath: '/api/english/music/ytdlp-status',
                headers: { Cookie: adminCookie }
            });
            assert.strictEqual(ytdlpStatusRes.status, 200);
            assert.strictEqual(JSON.parse(ytdlpStatusRes.body).serverAutonomous, true);

            // Rechaza payload E2EE cifrado con llave errónea en /api/send-to-pc
            const badJournalCipher = serverNotes.encryptClientE2ee('Secret journal text', 'ffffffffffffffffffffffffffffffff');
            const badJournalRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/send-to-pc',
                headers: { Cookie: adminCookie },
                body: { texto: badJournalCipher }
            });
            assert.strictEqual(badJournalRes.status, 400);

            // Envía entrada cifrada E2EE real a /api/send-english -> se guarda directo sin esperar pull de PC
            const engCipher = serverNotes.encryptClientE2ee(JSON.stringify({
                category: 'vocabulary',
                language: 'English',
                word: 'Autonomous',
                spanish: 'Autónomo',
                example: 'Ubuntu server updates the notebook autonomously.'
            }), testKey);
            const sendEngRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/send-english',
                headers: { Cookie: adminCookie },
                body: { texto: engCipher }
            });
            assert.strictEqual(sendEngRes.status, 200);
            assert.strictEqual(fs.existsSync(process.env.ENGLISH_WORD_FILE_PATH), true);

            // La cola /api/pull-english permanece vacía porque el servidor ya procesó la nota
            const pullAfter = await request({ port, reqPath: '/api/pull-english' });
            assert.strictEqual(pullAfter.status, 200);
            assert.deepStrictEqual(JSON.parse(pullAfter.body), []);

            // Y GET /api/english/study-notebook refleja la entrada nueva inmediatamente
            const nbRes = await request({
                port,
                reqPath: '/api/english/study-notebook?refresh=1',
                headers: { Cookie: adminCookie }
            });
            assert.strictEqual(nbRes.status, 200);
            const nbData = JSON.parse(nbRes.body);
            assert.strictEqual(nbData.ok, true);
            assert.strictEqual(nbData.available, true);
            assert.ok(nbData.entries.some((e) => /Autonomous/i.test(e.title || e.text || '')));

            // Consulta de logs del sistema protegida estrictamente por RBAC (admin only)
            const unauthLogs = await request({ port, reqPath: '/api/system/logs' });
            assert.strictEqual(unauthLogs.status, 401);
            const medicoLogs = await request({
                port,
                reqPath: '/api/system/logs',
                headers: { Cookie: medicoCookie }
            });
            assert.strictEqual(medicoLogs.status, 403);
            const adminLogs = await request({
                port,
                reqPath: '/api/system/logs?kind=server&lines=20',
                headers: { Cookie: adminCookie }
            });
            assert.strictEqual(adminLogs.status, 200);
            assert.strictEqual(JSON.parse(adminLogs.body).ok, true);
        } finally {
            if (prevKey === undefined) delete process.env.JOURNAL_SECRET_KEY; else process.env.JOURNAL_SECRET_KEY = prevKey;
            if (prevEngPath === undefined) delete process.env.ENGLISH_WORD_FILE_PATH; else process.env.ENGLISH_WORD_FILE_PATH = prevEngPath;
            if (prevJrnPath === undefined) delete process.env.JOURNAL_LOCAL_PATH; else process.env.JOURNAL_LOCAL_PATH = prevJrnPath;
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('expone estado de cobertura diaria, verificación y marcado Nothing to report. con RBAC', async () => {
        const fs = require('node:fs');
        const os = require('node:os');
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdh-jrn-cov-'));
        const prevJrnPath = process.env.JOURNAL_LOCAL_PATH;
        const prevWordPass = process.env.WORD_PASSWORD;

        try {
            process.env.JOURNAL_LOCAL_PATH = path.join(tmpDir, 'Diario.docx');
            delete process.env.WORD_PASSWORD;

            // 1. RBAC en GET /api/journal/daily-status, POST /api/journal/verify-days y POST /api/journal/nothing-to-report
            assert.strictEqual((await request({ port, reqPath: '/api/journal/daily-status' })).status, 401);
            assert.strictEqual((await request({ port, reqPath: '/api/journal/daily-status', headers: { Cookie: medicoCookie } })).status, 403);
            assert.strictEqual((await request({ port, method: 'POST', reqPath: '/api/journal/verify-days', body: {} })).status, 401);
            assert.strictEqual((await request({ port, method: 'POST', reqPath: '/api/journal/verify-days', headers: { Cookie: medicoCookie }, body: {} })).status, 403);
            assert.strictEqual((await request({ port, method: 'POST', reqPath: '/api/journal/nothing-to-report', body: {} })).status, 401);
            assert.strictEqual((await request({ port, method: 'POST', reqPath: '/api/journal/nothing-to-report', headers: { Cookie: medicoCookie }, body: {} })).status, 403);

            // 2. Sin WORD_PASSWORD -> daily-status reporta coverageAvailable=false; verify-days y nothing-to-report devuelven 409
            const noPwdStatus = await request({ port, reqPath: '/api/journal/daily-status', headers: { Cookie: adminCookie } });
            assert.strictEqual(noPwdStatus.status, 200);
            const noPwdData = JSON.parse(noPwdStatus.body);
            assert.strictEqual(noPwdData.ok, true);
            assert.strictEqual(noPwdData.coverageAvailable, false);
            assert.strictEqual(noPwdData.reason, 'PASSWORD_MISSING');
            assert.match(noPwdData.todayIso, /^\d{4}-\d{2}-\d{2}$/);
            assert.ok(noPwdData.todayHeading);

            const noPwdVerify = await request({ port, method: 'POST', reqPath: '/api/journal/verify-days', headers: { Cookie: adminCookie }, body: {} });
            assert.strictEqual(noPwdVerify.status, 409);

            const noPwdNtr = await request({ port, method: 'POST', reqPath: '/api/journal/nothing-to-report', headers: { Cookie: adminCookie }, body: {} });
            assert.strictEqual(noPwdNtr.status, 409);
            assert.strictEqual(JSON.parse(noPwdNtr.body).fallbackToPcQueue, true);

            // 3. Validaciones de targetDateIso en /api/journal/nothing-to-report
            const badDateNtr = await request({
                port,
                method: 'POST',
                reqPath: '/api/journal/nothing-to-report',
                headers: { Cookie: adminCookie },
                body: { targetDateIso: 'bad-date' }
            });
            assert.strictEqual(badDateNtr.status, 400);

            const futureDateNtr = await request({
                port,
                method: 'POST',
                reqPath: '/api/journal/nothing-to-report',
                headers: { Cookie: adminCookie },
                body: { targetDateIso: '2099-12-31' }
            });
            assert.strictEqual(futureDateNtr.status, 400);

            // 4. Con WORD_PASSWORD y sin Diario.docx creado aún -> coverageAvailable=true, exists=false, allPastDaysFilled=true
            process.env.WORD_PASSWORD = 'TestWordPassword2026!';
            const readyStatus = await request({ port, reqPath: '/api/journal/daily-status', headers: { Cookie: adminCookie } });
            assert.strictEqual(readyStatus.status, 200);
            const readyData = JSON.parse(readyStatus.body);
            assert.strictEqual(readyData.ok, true);
            assert.strictEqual(readyData.coverageAvailable, true);
            assert.strictEqual(readyData.exists, false);
            assert.strictEqual(readyData.coverage.allPastDaysFilled, true);

            const missingVerify = await request({ port, method: 'POST', reqPath: '/api/journal/verify-days', headers: { Cookie: adminCookie }, body: {} });
            assert.strictEqual(missingVerify.status, 200);
            const missingVerifyData = JSON.parse(missingVerify.body);
            assert.strictEqual(missingVerifyData.ok, true);
            assert.strictEqual(missingVerifyData.exists, false);
            assert.strictEqual(missingVerifyData.modified, false);
        } finally {
            if (prevJrnPath === undefined) delete process.env.JOURNAL_LOCAL_PATH; else process.env.JOURNAL_LOCAL_PATH = prevJrnPath;
            if (prevWordPass === undefined) delete process.env.WORD_PASSWORD; else process.env.WORD_PASSWORD = prevWordPass;
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('sirve crypto-js local sin CDN, aplica cookie Secure solo bajo HTTPS (Tailscale) y respeta DB_RETENTION_DAYS=0', async () => {
        // 1. Asset vendor/crypto-js.min.js accesible localmente y CSP sin cdnjs.cloudflare.com
        const vendorRes = await request({ port, reqPath: '/vendor/crypto-js.min.js' });
        assert.strictEqual(vendorRes.status, 200);
        assert.ok(vendorRes.body.length > 30000 && vendorRes.body.includes('CryptoJS'));

        const htmlRes = await request({ port, reqPath: '/index.html' });
        assert.strictEqual(htmlRes.status, 200);
        const csp = String(htmlRes.headers['content-security-policy'] || '');
        assert.equal(csp.includes('cdnjs.cloudflare.com'), false);
        assert.ok(csp.includes("script-src 'self'"));

        // 2. Cookie de sesión con Tailscale HTTPS (X-Forwarded-Proto: https) incluye Secure; HTTP plano la omite
        const httpLogin = await request({
            port,
            method: 'POST',
            reqPath: '/api/auth/login',
            body: { email: 'admin@example.com', password: 'ClavePrueba2026!' }
        });
        assert.strictEqual(httpLogin.status, 200);
        const httpCookies = [].concat(httpLogin.headers['set-cookie'] || []).join('; ');
        assert.ok(httpCookies.includes('HttpOnly'));
        assert.equal(/;\s*Secure\b/i.test(httpCookies), false, 'HTTP local no debe marcar Secure');

        const httpsLogin = await request({
            port,
            method: 'POST',
            reqPath: '/api/auth/login',
            headers: { 'X-Forwarded-Proto': 'https' },
            body: { email: 'admin@example.com', password: 'ClavePrueba2026!' }
        });
        assert.strictEqual(httpsLogin.status, 200);
        const httpsCookies = [].concat(httpsLogin.headers['set-cookie'] || []).join('; ');
        assert.ok(/;\s*Secure\b/i.test(httpsCookies), 'Tailscale HTTPS debe marcar cookie Secure');

        const httpsCookiePair = (httpsLogin.headers['set-cookie'] || []).find((c) => c.startsWith('mt_session=')).split(';')[0];

        // 3. DB_RETENTION_DAYS=0 por defecto (ilimitado) y rango ampliado hasta 120 meses en /api/archive/drive-range
        const prevRet = process.env.DB_RETENTION_DAYS;
        const prevRclone = process.env.RCLONE_CONFIG;
        try {
            delete process.env.DB_RETENTION_DAYS;
            process.env.RCLONE_CONFIG = path.join(require('node:os').tmpdir(), `nonexistent-rclone-${Date.now()}.conf`);
            const rangeRes = await request({
                port,
                reqPath: '/api/archive/drive-range?months=120&begin=2020-01-01&end=2026-11-18',
                headers: { Cookie: httpsCookiePair }
            });
            assert.strictEqual(rangeRes.status, 200);
            const rangeData = JSON.parse(rangeRes.body);
            assert.strictEqual(rangeData.ok, true);
            assert.strictEqual(rangeData.localRetentionDays, 0);
            assert.strictEqual(rangeData.monthsRequested, 120);
            assert.strictEqual(rangeData.source, 'mysql_local_full');

            process.env.DB_RETENTION_DAYS = '90';
            const cappedRes = await request({
                port,
                reqPath: '/api/archive/drive-range?months=6&begin=2020-01-01&end=2026-11-18',
                headers: { Cookie: httpsCookiePair }
            });
            assert.strictEqual(cappedRes.status, 200);
            const cappedData = JSON.parse(cappedRes.body);
            assert.strictEqual(cappedData.localRetentionDays, 90);
            assert.strictEqual(cappedData.source, 'mysql_local_90d');

            const oldMoods = await request({
                port,
                reqPath: '/api/get-moods?begin=2020-01-01&end=2020-01-07',
                headers: { Cookie: httpsCookiePair }
            });
            assert.strictEqual(oldMoods.status, 200);
        } finally {
            if (prevRet === undefined) delete process.env.DB_RETENTION_DAYS; else process.env.DB_RETENTION_DAYS = prevRet;
            if (prevRclone === undefined) delete process.env.RCLONE_CONFIG; else process.env.RCLONE_CONFIG = prevRclone;
        }

        const httpsLogout = await request({
            port,
            method: 'POST',
            reqPath: '/api/auth/logout',
            headers: { Cookie: httpsCookiePair, 'X-Forwarded-Proto': 'https' }
        });
        assert.strictEqual(httpsLogout.status, 200);
        const logoutCookies = [].concat(httpsLogout.headers['set-cookie'] || []).join('; ');
        assert.ok(/;\s*Secure\b/i.test(logoutCookies), 'Logout HTTPS también debe limpiar cookie con atributo Secure');
    });

    it('expone X-Replica-Id en /healthz y coordina escrituras .docx con advisory locks distribuidos en MySQL', async () => {
        const fs = require('node:fs');
        const os = require('node:os');

        const healthRes = await request({ port, reqPath: '/healthz' });
        assert.strictEqual(healthRes.status, 200);
        const healthBody = JSON.parse(healthRes.body);
        assert.strictEqual(healthBody.ok, true);
        assert.ok(String(healthBody.slot || '').trim().length > 0, '/healthz debe incluir slot');
        assert.ok(String(healthBody.replicaId || '').trim().length > 0, '/healthz debe incluir replicaId');
        assert.ok(String(healthBody.version || '').trim().length > 0, '/healthz debe incluir version');
        assert.ok(String(healthRes.headers['x-replica-id'] || '').trim().length > 0, '/healthz debe incluir header X-Replica-Id');
        assert.ok(String(healthRes.headers['x-app-version'] || '').trim().length > 0, '/healthz debe incluir header X-App-Version');

        const logsRes = await request({
            port,
            reqPath: '/api/system/logs?kind=server&lines=5',
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(logsRes.status, 200);
        assert.ok(String(JSON.parse(logsRes.body).replicaId || '').trim().length > 0);

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdh-lock-int-'));
        const prevKey = process.env.JOURNAL_SECRET_KEY;
        const prevEngPath = process.env.ENGLISH_WORD_FILE_PATH;
        const prevJrnPath = process.env.JOURNAL_LOCAL_PATH;
        const prevWordPass = process.env.WORD_PASSWORD;
        const prevRclone = process.env.RCLONE_CONFIG;
        const startHistoryLen = advisoryLockHistory.length;

        try {
            const secretKey = '0123456789abcdef0123456789abcdef';
            process.env.JOURNAL_SECRET_KEY = secretKey;
            process.env.ENGLISH_WORD_FILE_PATH = path.join(tmpDir, 'English_Learning_Notebook.docx');
            process.env.JOURNAL_LOCAL_PATH = path.join(tmpDir, 'Diario.docx');
            process.env.WORD_PASSWORD = 'LockWordPass2026!';
            process.env.RCLONE_CONFIG = path.join(tmpDir, 'nonexistent-rclone.conf');

            const encryptEnvelope = (plainText) => {
                const keyBuf = Buffer.from(secretKey, 'utf8');
                const iv = crypto.randomBytes(16);
                const cipher = crypto.createCipheriv('aes-256-cbc', keyBuf, iv);
                const enc = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
                return `${iv.toString('hex')}:${enc.toString('base64')}`;
            };

            const engEntryJson = JSON.stringify({
                section: 'vocabulary',
                dateStr: '2026-11-19',
                title: 'resilient',
                fields: { meaning: 'able to recover quickly', example: 'Load-balanced replicas stay resilient.' }
            });
            const engRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/send-english',
                headers: { Cookie: adminCookie },
                body: { texto: encryptEnvelope(engEntryJson) }
            });
            assert.strictEqual(engRes.status, 200);

            const jrnRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/send-to-pc',
                headers: { Cookie: adminCookie },
                body: { texto: encryptEnvelope('Locked journal entry across replicas.') }
            });
            assert.strictEqual(jrnRes.status, 200);

            const recentLocks = advisoryLockHistory.slice(startHistoryLen);
            assert.ok(recentLocks.some((e) => e.op === 'acquire' && e.lockName === 'pdh_docx_english' && e.result === 1));
            assert.ok(recentLocks.some((e) => e.op === 'release' && e.lockName === 'pdh_docx_english' && e.result === 1));
            assert.ok(recentLocks.some((e) => e.op === 'acquire' && e.lockName === 'pdh_docx_journal' && e.result === 1));
            assert.ok(recentLocks.some((e) => e.op === 'release' && e.lockName === 'pdh_docx_journal' && e.result === 1));
            assert.strictEqual(activeAdvisoryLocks.size, 0);
        } finally {
            if (prevKey === undefined) delete process.env.JOURNAL_SECRET_KEY; else process.env.JOURNAL_SECRET_KEY = prevKey;
            if (prevEngPath === undefined) delete process.env.ENGLISH_WORD_FILE_PATH; else process.env.ENGLISH_WORD_FILE_PATH = prevEngPath;
            if (prevJrnPath === undefined) delete process.env.JOURNAL_LOCAL_PATH; else process.env.JOURNAL_LOCAL_PATH = prevJrnPath;
            if (prevWordPass === undefined) delete process.env.WORD_PASSWORD; else process.env.WORD_PASSWORD = prevWordPass;
            if (prevRclone === undefined) delete process.env.RCLONE_CONFIG; else process.env.RCLONE_CONFIG = prevRclone;
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('acepta notas del Diario cifradas con pdh-j2 (salt + PBKDF2 + HMAC) en /api/send-to-pc y rechaza sobres manipulados o con llave errónea', async () => {
        const fs = require('node:fs');
        const os = require('node:os');
        const serverNotes = require('../lib/server-notes-service');
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdh-jrn-salted-'));
        const prevKey = process.env.JOURNAL_SECRET_KEY;
        const prevJrnPath = process.env.JOURNAL_LOCAL_PATH;
        const prevWordPass = process.env.WORD_PASSWORD;
        const testKey = '0123456789abcdef0123456789abcdef';
        const wrongKey = 'ffffffffffffffffffffffffffffffff';

        try {
            process.env.JOURNAL_SECRET_KEY = testKey;
            process.env.JOURNAL_LOCAL_PATH = path.join(tmpDir, 'Diario.docx');
            process.env.WORD_PASSWORD = 'SaltedJournalPass2026!';

            // Limpiar cola pendiente antes de la prueba
            await request({ port, reqPath: '/api/pull-text' });

            // 1. Envío válido cifrado con pdh-j2 (guardado directo en Diario.docx si msoffcrypto está disponible, o encolado si MSOFFCRYPTO_MISSING)
            const validSalted = serverNotes.encryptJournalSaltedE2ee('Hoy practiqué respiración profunda y me sentí más tranquilo 🦉', testKey);
            const okRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/send-to-pc',
                headers: { Cookie: adminCookie },
                body: { texto: validSalted }
            });
            assert.strictEqual(okRes.status, 200);
            if (fs.existsSync(process.env.JOURNAL_LOCAL_PATH)) {
                assert.match(okRes.body, /Note encrypted with password and saved locally/i);
                const magic = fs.readFileSync(process.env.JOURNAL_LOCAL_PATH).subarray(0, 4);
                assert.strictEqual(magic.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])), true, 'Diario.docx debe estar cifrado con OLE2');
            } else {
                assert.match(okRes.body, /queued for your PC/i);
                const pulled = JSON.parse((await request({ port, reqPath: '/api/pull-text' })).body);
                assert.ok(Array.isArray(pulled) && pulled.includes(validSalted), 'Si falta msoffcrypto-tool, el sobre pdh-j2 válido debe pasar verificación y quedar en cola PC');
            }

            // 2. Rechazo 400 si el MAC fue manipulado en 1 carácter (no debe escribir ni encolar)
            const parts = validSalted.split(':');
            parts[4] = (parts[4][0] === 'a' ? 'b' : 'a') + parts[4].slice(1);
            const tamperedMacRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/send-to-pc',
                headers: { Cookie: adminCookie },
                body: { texto: parts.join(':') }
            });
            assert.strictEqual(tamperedMacRes.status, 400);
            assert.match(tamperedMacRes.body, /integrity check failed/i);

            // 3. Rechazo 400 si se cifró con llave incorrecta (no debe escribir ni encolar)
            const wrongKeySalted = serverNotes.encryptJournalSaltedE2ee('Llave incorrecta en pdh-j2', wrongKey);
            const wrongKeyRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/send-to-pc',
                headers: { Cookie: adminCookie },
                body: { texto: wrongKeySalted }
            });
            assert.strictEqual(wrongKeyRes.status, 400);
            assert.match(wrongKeyRes.body, /integrity check failed/i);

            const pulledAfterRejected = JSON.parse((await request({ port, reqPath: '/api/pull-text' })).body);
            assert.deepStrictEqual(pulledAfterRejected, [], 'Sobres pdh-j2 rechazados nunca deben entrar a la cola');
        } finally {
            if (prevKey === undefined) delete process.env.JOURNAL_SECRET_KEY; else process.env.JOURNAL_SECRET_KEY = prevKey;
            if (prevJrnPath === undefined) delete process.env.JOURNAL_LOCAL_PATH; else process.env.JOURNAL_LOCAL_PATH = prevJrnPath;
            if (prevWordPass === undefined) delete process.env.WORD_PASSWORD; else process.env.WORD_PASSWORD = prevWordPass;
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('permite personalizar los 3 campus ITS, buscar/geocodificar en mapa y restaurar coordenadas oficiales del croquis', async () => {
        // 1. Personalizar Campus Principal (y verificar sincronía con university), Miravalle y Boillot
        const prinRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/planner/location',
            headers: { Cookie: adminCookie },
            body: {
                target: 'campus_principal',
                lat: 25.4428,
                lng: -100.9905,
                label: 'Campus Principal (Acceso Norte)',
                address: 'Blvd. V. Carranza #2400 Norte, Saltillo',
                source: 'map_picker'
            }
        });
        assert.strictEqual(prinRes.status, 200);
        const prinBody = JSON.parse(prinRes.body);
        assert.strictEqual(prinBody.campusDirectory.principal.isCustom, true);
        assert.strictEqual(prinBody.campusDirectory.principal.lat, 25.4428);
        assert.strictEqual(prinBody.campusDirectory.principal.lng, -100.9905);
        assert.strictEqual(prinBody.planner.locations.university.lat, 25.4428);
        assert.strictEqual(prinBody.planner.locations.university.lng, -100.9905);

        const miraRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/planner/location',
            headers: { Cookie: adminCookie },
            body: { target: 'campus_miravalle', lat: 25.4205, lng: -101.0215, source: 'map_picker' }
        });
        assert.strictEqual(miraRes.status, 200);
        assert.strictEqual(JSON.parse(miraRes.body).campusDirectory.miravalle.isCustom, true);

        const boilRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/planner/location',
            headers: { Cookie: adminCookie },
            body: { target: 'campus_boillot', lat: 25.4392, lng: -100.9931, source: 'map_picker' }
        });
        assert.strictEqual(boilRes.status, 200);
        assert.strictEqual(JSON.parse(boilRes.body).campusDirectory.boillot.isCustom, true);

        // 2. GET /api/planner y POST /api/planner/resolve-room reflejan las coordenadas personalizadas
        const plannerRes = await request({
            port,
            reqPath: '/api/planner',
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(plannerRes.status, 200);
        const plannerBody = JSON.parse(plannerRes.body);
        assert.strictEqual(plannerBody.campusDirectory.principal.lat, 25.4428);
        assert.strictEqual(plannerBody.campusDirectory.miravalle.lat, 25.4205);
        assert.strictEqual(plannerBody.campusDirectory.boillot.lat, 25.4392);
        assert.strictEqual(plannerBody.commutePreview.campuses.boillot.lat, 25.4392);

        const roomRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/planner/resolve-room',
            headers: { Cookie: adminCookie },
            body: { room: 'R11' }
        });
        assert.strictEqual(roomRes.status, 200);
        const roomBody = JSON.parse(roomRes.body);
        assert.strictEqual(roomBody.resolved.campusId, 'boillot');
        assert.strictEqual(roomBody.resolved.lat, 25.4392);
        assert.strictEqual(roomBody.resolved.lng, -100.9931);

        // 3. Búsqueda geográfica local/OSM y geocodificación inversa para selector en mapa
        const badSearch = await request({
            port,
            reqPath: '/api/planner/geocode-search?q=a',
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(badSearch.status, 400);

        const searchRes = await request({
            port,
            reqPath: '/api/planner/geocode-search?q=Tec+Saltillo',
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(searchRes.status, 200);
        const searchBody = JSON.parse(searchRes.body);
        assert.strictEqual(searchBody.ok, true);
        assert.ok(Array.isArray(searchBody.results) && searchBody.results.length >= 1);
        assert.ok(Number.isFinite(Number(searchBody.results[0].lat)) && Number.isFinite(Number(searchBody.results[0].lng)));

        const badRev = await request({
            port,
            reqPath: '/api/planner/reverse-geocode?lat=0&lng=0',
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(badRev.status, 400);

        const revRes = await request({
            port,
            reqPath: '/api/planner/reverse-geocode?lat=25.4414&lng=-100.9922',
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(revRes.status, 200);
        const revBody = JSON.parse(revRes.body);
        assert.strictEqual(revBody.ok, true);
        assert.ok(typeof revBody.displayName === 'string' && revBody.displayName.length > 4);

        // 4. Restaurar los 3 campus a coordenadas oficiales del Croquis TecNM Saltillo
        for (const [resetTarget, key, expLat, expLng] of [
            ['reset_campus_principal', 'principal', 25.4414, -100.9922],
            ['reset_campus_miravalle', 'miravalle', 25.4194, -101.0232],
            ['reset_campus_boillot', 'boillot', 25.4385, -100.9940]
        ]) {
            const rstRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/planner/location',
                headers: { Cookie: adminCookie },
                body: { target: resetTarget }
            });
            assert.strictEqual(rstRes.status, 200);
            const rstBody = JSON.parse(rstRes.body);
            assert.strictEqual(rstBody.campusDirectory[key].isCustom, false);
            assert.strictEqual(rstBody.campusDirectory[key].lat, expLat);
            assert.strictEqual(rstBody.campusDirectory[key].lng, expLng);
        }

        // Confirmar CSP estricta intacta
        const htmlRes = await request({ port, reqPath: '/index.html' });
        assert.strictEqual(htmlRes.status, 200);
        const csp = String(htmlRes.headers['content-security-policy'] || '');
        assert.ok(csp.includes("script-src 'self'") && csp.includes("connect-src 'self'"));
        assert.ok(csp.includes('https://tile.openstreetmap.org'));
    });

    it('soporta CRUD completo de campus/edificios y salones personalizados en /api/planner y /api/planner/resolve-room', async () => {
        const baseRes = await request({ port, reqPath: '/api/planner', headers: { Cookie: adminCookie } });
        assert.strictEqual(baseRes.status, 200);
        const baseData = JSON.parse(baseRes.body);
        const basePlanner = baseData.planner;

        // 1. Renombrar campus miravalle, asignarle salones personalizados (["N11", "R14"]) y fijar coordenadas
        const renamedCampuses = {
            ...basePlanner.locations.campuses,
            miravalle: {
                ...basePlanner.locations.campuses.miravalle,
                id: 'miravalle',
                name: 'Campus Miravalle Sistemas',
                label: 'Campus Miravalle Sistemas',
                plano: 'CTO-003-M',
                address: 'Blvd. Vito Alessio Robles Km 2, Saltillo',
                lat: 25.4218,
                lng: -101.0195,
                rooms: ['N11', ' r14 ', 'n11']
            }
        };
        const updMiraRes = await request({
            port,
            method: 'PUT',
            reqPath: '/api/planner',
            headers: { Cookie: adminCookie },
            body: {
                planner: {
                    ...basePlanner,
                    locations: {
                        ...basePlanner.locations,
                        campuses: renamedCampuses
                    }
                }
            }
        });
        assert.strictEqual(updMiraRes.status, 200);
        const updMiraBody = JSON.parse(updMiraRes.body);
        assert.strictEqual(updMiraBody.campusDirectory.miravalle.name, 'Campus Miravalle Sistemas');
        assert.deepStrictEqual(updMiraBody.campusDirectory.miravalle.rooms, ['N11', 'R14']);

        for (const customRoom of ['N11', 'R14']) {
            const rrRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/planner/resolve-room',
                headers: { Cookie: adminCookie },
                body: { room: customRoom }
            });
            assert.strictEqual(rrRes.status, 200);
            const resolved = JSON.parse(rrRes.body).resolved;
            assert.strictEqual(resolved.campusId, 'miravalle', `El salón personalizado ${customRoom} debe resolver a miravalle`);
            assert.strictEqual(resolved.campusName, 'Campus Miravalle Sistemas');
            assert.strictEqual(resolved.lat, 25.4218);
            assert.strictEqual(resolved.lng, -101.0195);
        }

        // 2. Crear nuevo campus/edificio personalizado ('edif-sistemas'), asignar una materia y verificar commutePreview + location update
        const withNewCampus = {
            ...updMiraBody.planner,
            locations: {
                ...updMiraBody.planner.locations,
                campuses: {
                    ...updMiraBody.planner.locations.campuses,
                    'edif-sistemas': {
                        id: 'edif-sistemas',
                        name: 'Edificio 78 Sistemas',
                        label: 'Edificio 78 Sistemas',
                        plano: 'EDIF-78',
                        address: 'Av. Universidad Sur #120, Saltillo',
                        lat: 25.4375,
                        lng: -100.9965,
                        rooms: ['LC3', 'S99']
                    }
                }
            },
            semesters: [
                {
                    ...updMiraBody.planner.semesters[0],
                    courses: [
                        {
                            id: 'course-custom-edif',
                            code: 'DED2599',
                            name: 'Arquitectura Cloud',
                            teacher: 'Docente Sistemas',
                            group: 'A',
                            room: 'LC3',
                            campusId: 'edif-sistemas',
                            days: [1, 3],
                            startTime: '11:00',
                            endTime: '12:00'
                        }
                    ]
                }
            ]
        };
        const addCampusRes = await request({
            port,
            method: 'PUT',
            reqPath: '/api/planner',
            headers: { Cookie: adminCookie },
            body: { planner: withNewCampus }
        });
        assert.strictEqual(addCampusRes.status, 200);
        const addCampusBody = JSON.parse(addCampusRes.body);
        assert.ok(addCampusBody.campusDirectory['edif-sistemas']);
        assert.strictEqual(addCampusBody.campusDirectory['edif-sistemas'].name, 'Edificio 78 Sistemas');
        assert.strictEqual(addCampusBody.planner.semesters[0].courses[0].campusId, 'edif-sistemas');
        assert.ok(addCampusBody.commutePreview.campuses['edif-sistemas']);
        assert.ok(addCampusBody.commutePreview.commutes.some(c => c.campusKey === 'edif-sistemas' && c.target === 'Edificio 78 Sistemas'));

        const resolveLc3Res = await request({
            port,
            method: 'POST',
            reqPath: '/api/planner/resolve-room',
            headers: { Cookie: adminCookie },
            body: { room: 'LC3' }
        });
        assert.strictEqual(resolveLc3Res.status, 200);
        assert.strictEqual(JSON.parse(resolveLc3Res.body).resolved.campusId, 'edif-sistemas');

        const locCustomRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/planner/location',
            headers: { Cookie: adminCookie },
            body: { target: 'campus_edif-sistemas', lat: 25.4379, lng: -100.9961, address: 'Acceso Principal Edif. 78', source: 'map_picker' }
        });
        assert.strictEqual(locCustomRes.status, 200);
        assert.strictEqual(JSON.parse(locCustomRes.body).campusDirectory['edif-sistemas'].lat, 25.4379);

        // 3. Eliminar el campus personalizado y un campus predeterminado (boillot) y confirmar que no reaparecen en GET /api/planner
        const latestPlanner = JSON.parse((await request({ port, reqPath: '/api/planner', headers: { Cookie: adminCookie } })).body).planner;
        const prunedCampuses = { ...latestPlanner.locations.campuses };
        delete prunedCampuses['edif-sistemas'];
        delete prunedCampuses.boillot;

        const delCampusRes = await request({
            port,
            method: 'PUT',
            reqPath: '/api/planner',
            headers: { Cookie: adminCookie },
            body: {
                planner: {
                    ...latestPlanner,
                    locations: {
                        ...latestPlanner.locations,
                        campuses: prunedCampuses
                    }
                }
            }
        });
        assert.strictEqual(delCampusRes.status, 200);

        const afterDeleteRes = await request({ port, reqPath: '/api/planner', headers: { Cookie: adminCookie } });
        assert.strictEqual(afterDeleteRes.status, 200);
        const afterDeleteBody = JSON.parse(afterDeleteRes.body);
        assert.strictEqual(afterDeleteBody.campusDirectory['edif-sistemas'], undefined);
        assert.strictEqual(afterDeleteBody.campusDirectory.boillot, undefined);
        assert.ok(afterDeleteBody.campusDirectory.principal && afterDeleteBody.campusDirectory.miravalle);
        assert.strictEqual(afterDeleteBody.commutePreview.campuses.boillot, undefined);

        // Verificar que resolve-room no falla cuando falta un campus predeterminado (boillot)
        const r02FallbackRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/planner/resolve-room',
            headers: { Cookie: adminCookie },
            body: { room: 'R02' }
        });
        assert.strictEqual(r02FallbackRes.status, 200);
        assert.ok(afterDeleteBody.campusDirectory[JSON.parse(r02FallbackRes.body).resolved.campusId]);
    });

    it('proxy GET /api/planner/map-tile valida auth/coordenadas/magic-bytes, usa OSM->Esri fallback y cache LRU v2', async () => {
        // 1. Requiere sesión autenticada
        const unauthRes = await request({ port, reqPath: '/api/planner/map-tile/15/7191/13946.png' });
        assert.strictEqual(unauthRes.status, 401);

        // 2. Coordenadas fuera de rango o malformadas -> 400 Bad Request
        for (const badPath of [
            '/api/planner/map-tile/99/0/0.png',
            '/api/planner/map-tile/9/1/1.png',
            '/api/planner/map-tile/15/-1/100.png',
            '/api/planner/map-tile/15/999999/100.png',
            '/api/planner/map-tile/15/abc/100.png'
        ]) {
            const badRes = await request({ port, reqPath: badPath, headers: { Cookie: adminCookie } });
            assert.strictEqual(badRes.status, 400, `Se esperaba 400 para ${badPath}`);
        }

        // 3. Sin ALLOW_TEST_MAP_TILES en entorno de prueba devuelve 502 offline limpio
        const offlineRes = await request({
            port,
            reqPath: '/api/planner/map-tile/15/7191/13946.png',
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(offlineRes.status, 502);

        // 4. Con ALLOW_TEST_MAP_TILES=true: valida magic bytes, > 100 bytes y cadena OSM -> Esri Streets -> Esri Topo / World Imagery
        const validPad = Buffer.from('DAILY_HUB_TEST_TILE_PADDING_'.repeat(5)); // 140 bytes
        const fakeOsmPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), validPad]);
        const fakeEsriStreetsPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from('ESRI_STREETS_'), validPad]);
        const fakeEsriTopoPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from('ESRI_TOPO_'), validPad]);
        const fakeSatJpg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), validPad]);
        const tinyPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47]), Buffer.from('TINY_TILE_UNDER_100B')]);
        const corruptBody = Buffer.from('<html><body>API KEY REQUIRED fake 200 payload ' + 'X'.repeat(120) + '</body></html>');

        const origFetch = global.fetch;
        const origAllow = process.env.ALLOW_TEST_MAP_TILES;
        const fetchedUrls = [];
        const fetchedUserAgents = [];
        let allowTinyTileRecovery = false;
        process.env.ALLOW_TEST_MAP_TILES = 'true';
        global.fetch = async (url, opts = {}) => {
            const urlStr = String(url);
            fetchedUrls.push(urlStr);
            fetchedUserAgents.push(opts?.headers?.['User-Agent'] || '');

            // Coord 7191: OSM devuelve 200 pero magic bytes inválidos -> debe caer a Esri World Street Map
            if (urlStr.includes('tile.openstreetmap.org/15/7191/13946.png')) {
                return {
                    ok: true,
                    status: 200,
                    headers: new Map([['content-type', 'image/png']]),
                    arrayBuffer: async () => corruptBody
                };
            }
            if (urlStr.includes('World_Street_Map/MapServer/tile/15/13946/7191')) {
                return {
                    ok: true,
                    status: 200,
                    headers: new Map([['content-type', 'image/png']]),
                    arrayBuffer: async () => fakeEsriStreetsPng
                };
            }
            // Coord 7193: OSM directo OK
            if (urlStr.includes('tile.openstreetmap.org/15/7193/13946.png')) {
                return {
                    ok: true,
                    status: 200,
                    headers: new Map([['content-type', 'image/png']]),
                    arrayBuffer: async () => fakeOsmPng
                };
            }
            // Coord 7194: OSM 429 + Esri Streets 503 -> Esri World Topo OK
            if (urlStr.includes('tile.openstreetmap.org/15/7194/13946.png')) {
                return {
                    ok: false,
                    status: 429,
                    headers: new Map([['content-type', 'text/plain']]),
                    arrayBuffer: async () => Buffer.from('rate limited')
                };
            }
            if (urlStr.includes('World_Street_Map/MapServer/tile/15/13946/7194')) {
                return {
                    ok: false,
                    status: 503,
                    headers: new Map([['content-type', 'text/plain']]),
                    arrayBuffer: async () => Buffer.from('unavailable')
                };
            }
            if (urlStr.includes('World_Topo_Map/MapServer/tile/15/13946/7194')) {
                return {
                    ok: true,
                    status: 200,
                    headers: new Map([['content-type', 'image/png']]),
                    arrayBuffer: async () => fakeEsriTopoPng
                };
            }
            // Satélite coord 7192: Esri World Imagery (z/y/x)
            if (urlStr.includes('World_Imagery/MapServer/tile/15/13946/7192')) {
                return {
                    ok: true,
                    status: 200,
                    headers: new Map([['content-type', 'image/jpeg']]),
                    arrayBuffer: async () => fakeSatJpg
                };
            }
            // Coord 7195: primero todos <= 100 bytes (no cachea fallo), luego se recupera
            if (urlStr.includes('/7195/') || urlStr.endsWith('/7195')) {
                if (allowTinyTileRecovery && urlStr.includes('tile.openstreetmap.org')) {
                    return {
                        ok: true,
                        status: 200,
                        headers: new Map([['content-type', 'image/png']]),
                        arrayBuffer: async () => fakeOsmPng
                    };
                }
                return {
                    ok: true,
                    status: 200,
                    headers: new Map([['content-type', 'image/png']]),
                    arrayBuffer: async () => tinyPng
                };
            }
            return {
                ok: false,
                status: 500,
                headers: new Map([['content-type', 'text/plain']]),
                arrayBuffer: async () => Buffer.from('error')
            };
        };

        try {
            const getRawTile = (reqPath) => new Promise((resolve, reject) => {
                const req = http.request(
                    { hostname: '127.0.0.1', port, path: reqPath, method: 'GET', headers: { Cookie: adminCookie } },
                    (res) => {
                        const chunks = [];
                        res.on('data', (c) => chunks.push(c));
                        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks) }));
                    }
                );
                req.on('error', reject);
                req.end();
            });

            // A) Rechaza 200 con magic bytes inválidos en OSM y cae a esri-streets
            const fallbackRes = await getRawTile('/api/planner/map-tile/15/7191/13946.png?layer=streets&v=2');
            assert.strictEqual(fallbackRes.status, 200);
            assert.strictEqual(fallbackRes.headers['content-type'], 'image/png');
            assert.strictEqual(fallbackRes.headers['x-map-tile-provider'], 'esri-streets');
            assert.strictEqual(fallbackRes.headers['x-map-tile-cache'], 'miss');
            assert.ok(fallbackRes.raw.equals(fakeEsriStreetsPng));
            assert.strictEqual(fetchedUrls.length, 2);
            assert.ok(fetchedUrls[0].includes('tile.openstreetmap.org/15/7191/13946.png'));
            assert.ok(fetchedUrls[1].includes('World_Street_Map/MapServer/tile/15/13946/7191'));
            assert.ok(fetchedUrls.every((u) => !u.includes('basemaps.cartocdn.com')));
            assert.ok(fetchedUserAgents.every((ua) => ua.includes('PersonalDailyHub/1.21')));

            // B) Segundo hit idéntico responde desde caché LRU v2 sin volver a llamar a fetch
            const cachedRes = await request({
                port,
                reqPath: '/api/planner/map-tile/15/7191/13946.png?layer=streets&v=2',
                headers: { Cookie: adminCookie }
            });
            assert.strictEqual(cachedRes.status, 200);
            assert.strictEqual(cachedRes.headers['x-map-tile-cache'], 'hit-mem');
            assert.strictEqual(fetchedUrls.length, 2);

            // C) Hit directo válido a OpenStreetMap Standard
            const osmRes = await getRawTile('/api/planner/map-tile/15/7193/13946.png?layer=streets&v=2');
            assert.strictEqual(osmRes.status, 200);
            assert.strictEqual(osmRes.headers['x-map-tile-provider'], 'osm');
            assert.ok(osmRes.raw.equals(fakeOsmPng));
            assert.strictEqual(fetchedUrls.length, 3);

            // D) Cascada completa OSM 429 -> Esri Streets 503 -> Esri World Topo 200
            const topoRes = await getRawTile('/api/planner/map-tile/15/7194/13946.png?layer=streets&v=2');
            assert.strictEqual(topoRes.status, 200);
            assert.strictEqual(topoRes.headers['x-map-tile-provider'], 'esri-topo');
            assert.ok(topoRes.raw.equals(fakeEsriTopoPng));
            assert.strictEqual(fetchedUrls.length, 6);

            // E) Capa satélite usa Esri World Imagery con orden z/y/x
            const satRes = await getRawTile('/api/planner/map-tile/15/7192/13946.png?layer=satellite&v=2');
            assert.strictEqual(satRes.status, 200);
            assert.strictEqual(satRes.headers['content-type'], 'image/jpeg');
            assert.strictEqual(satRes.headers['x-map-tile-provider'], 'esri-imagery');
            assert.ok(satRes.raw.equals(fakeSatJpg));

            // F) Payloads <= 100 bytes fallan con 502 y no se cachean
            const failTinyRes = await request({
                port,
                reqPath: '/api/planner/map-tile/15/7195/13946.png?layer=streets&v=2',
                headers: { Cookie: adminCookie }
            });
            assert.strictEqual(failTinyRes.status, 502);
            allowTinyTileRecovery = true;
            const retryValidRes = await getRawTile('/api/planner/map-tile/15/7195/13946.png?layer=streets&v=2');
            assert.strictEqual(retryValidRes.status, 200);
            assert.strictEqual(retryValidRes.headers['x-map-tile-provider'], 'osm');
            assert.strictEqual(retryValidRes.headers['x-map-tile-cache'], 'miss');
        } finally {
            global.fetch = origFetch;
            if (origAllow === undefined) delete process.env.ALLOW_TEST_MAP_TILES;
            else process.env.ALLOW_TEST_MAP_TILES = origAllow;
        }
    });

    it('expone /api/sync/revisions y /api/sync/stream autenticados e incrementa revisiones tras mutaciones', async () => {
        const unauthRevs = await request({ port, reqPath: '/api/sync/revisions' });
        assert.strictEqual(unauthRevs.status, 401);

        const unauthStream = await request({ port, reqPath: '/api/sync/stream' });
        assert.strictEqual(unauthStream.status, 401);

        const adminBeforeRes = await request({ port, reqPath: '/api/sync/revisions', headers: { Cookie: adminCookie } });
        assert.strictEqual(adminBeforeRes.status, 200);
        const adminBefore = JSON.parse(adminBeforeRes.body).revisions;
        assert.ok(adminBefore && typeof adminBefore.mood === 'number' && typeof adminBefore.agenda === 'number');

        const psychRevsRes = await request({ port, reqPath: '/api/sync/revisions', headers: { Cookie: medicoCookie } });
        assert.strictEqual(psychRevsRes.status, 200);
        const psychRevs = JSON.parse(psychRevsRes.body).revisions;
        assert.ok(typeof psychRevs.mood === 'number' && typeof psychRevs.sleep === 'number' && typeof psychRevs.crisis === 'number');
        assert.strictEqual(psychRevs.agenda, undefined);
        assert.strictEqual(psychRevs.journal, undefined);

        const moodRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-mood',
            headers: { Cookie: adminCookie },
            body: {
                fecha: '2026-11-23',
                momento_dia: 'Night',
                estado_animo: 'Tranquilo',
                color_hex: '#4caf50'
            }
        });
        assert.strictEqual(moodRes.status, 200);

        const agendaRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-agenda',
            headers: { Cookie: adminCookie },
            body: {
                fecha: '2026-11-23',
                bloque: 'noche',
                hora: '21:00',
                actividad: 'Sync revision test'
            }
        });
        assert.strictEqual(agendaRes.status, 201);

        const adminAfterRes = await request({ port, reqPath: '/api/sync/revisions', headers: { Cookie: adminCookie } });
        assert.strictEqual(adminAfterRes.status, 200);
        const adminAfter = JSON.parse(adminAfterRes.body).revisions;
        assert.ok(adminAfter.mood > adminBefore.mood, 'La revisión de mood debe incrementar tras POST /api/insert-mood');
        assert.ok(adminAfter.agenda > adminBefore.agenda, 'La revisión de agenda debe incrementar tras POST /api/insert-agenda');
    });

    it('protege y exporta Diario.docx cifrado con salt (pdh-j2) en GET/POST /api/journal/download-encrypted manteniendo /api/journal/download intacto', async () => {
        const fs = require('node:fs');
        const os = require('node:os');
        const { spawnSync } = require('node:child_process');
        const serverNotes = require('../lib/server-notes-service');

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdh-jrn-dl-int-'));
        const prevKey = process.env.JOURNAL_SECRET_KEY;
        const prevJrnPath = process.env.JOURNAL_LOCAL_PATH;
        const prevWordPass = process.env.WORD_PASSWORD;
        const prevPyPath = process.env.PYTHONPATH;

        const pyCmd = (process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python']).find((c) => {
            const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
            return !r.error && r.status === 0;
        });
        assert.ok(pyCmd, 'Python 3 debe estar disponible');

        try {
            // Si falta msoffcrypto en el entorno de test, inyectar shim puro Python en PYTHONPATH para probar flujo completo
            const probe = spawnSync(pyCmd, ['-c', 'import msoffcrypto'], { encoding: 'utf8' });
            if (probe.error || probe.status !== 0) {
                const shimRoot = path.join(tmpDir, 'py_shim');
                const pkgDir = path.join(shimRoot, 'msoffcrypto');
                const fmtDir = path.join(pkgDir, 'format');
                fs.mkdirSync(fmtDir, { recursive: true });
                fs.writeFileSync(path.join(pkgDir, '__init__.py'), [
                    'import hashlib, hmac',
                    'OLE2_MAGIC = b"\\xd0\\xcf\\x11\\xe0\\xa1\\xb1\\x1a\\xe1"',
                    'SHIM_TAG = b"PDH_SHIM_OLE2_V1"',
                    'def _derive(pwd: str, salt: bytes):',
                    '    d = hashlib.pbkdf2_hmac("sha256", pwd.encode("utf-8"), salt, 10000, 64)',
                    '    return d[:32], d[32:]',
                    'def _xor_stream(enc_key: bytes, salt: bytes, data: bytes) -> bytes:',
                    '    out = bytearray(len(data)); blk = 0; pos = 0',
                    '    while pos < len(data):',
                    '        ks = hashlib.sha256(enc_key + salt + blk.to_bytes(4, "big")).digest()',
                    '        chunk = data[pos:pos+32]',
                    '        for i, b in enumerate(chunk): out[pos + i] = b ^ ks[i]',
                    '        pos += len(chunk); blk += 1',
                    '    return bytes(out)',
                    'class OfficeFile:',
                    '    def __init__(self, f):',
                    '        f.seek(0); self.raw = f.read(); self._key = None',
                    '    def is_encrypted(self):',
                    '        return len(self.raw) >= 8 + len(SHIM_TAG) + 48 and self.raw[:8] == OLE2_MAGIC and self.raw[8:8+len(SHIM_TAG)] == SHIM_TAG',
                    '    def load_key(self, password="", verify_password=True):',
                    '        if not self.is_encrypted(): raise ValueError("Not encrypted")',
                    '        off = 8 + len(SHIM_TAG); salt = self.raw[off:off+16]; mac = self.raw[off+16:off+48]; ct = self.raw[off+48:]',
                    '        enc_k, mac_k = _derive(password, salt)',
                    '        if verify_password and not hmac.compare_digest(mac, hmac.new(mac_k, salt + ct, hashlib.sha256).digest()): raise ValueError("Invalid password")',
                    '        self._key = (enc_k, salt, ct)',
                    '    def decrypt(self, out_io):',
                    '        enc_k, salt, ct = self._key; out_io.write(_xor_stream(enc_k, salt, ct))'
                ].join('\n'), 'utf8');
                fs.writeFileSync(path.join(fmtDir, '__init__.py'), '', 'utf8');
                fs.writeFileSync(path.join(fmtDir, 'ooxml.py'), [
                    'import hashlib, hmac, os',
                    'from .. import OLE2_MAGIC, SHIM_TAG, _derive, _xor_stream',
                    'class OOXMLFile:',
                    '    def __init__(self, f): f.seek(0); self.plain = f.read()',
                    '    def encrypt(self, password: str, out_io):',
                    '        salt = os.urandom(16); enc_k, mac_k = _derive(password, salt); ct = _xor_stream(enc_k, salt, self.plain)',
                    '        out_io.write(OLE2_MAGIC + SHIM_TAG + salt + hmac.new(mac_k, salt + ct, hashlib.sha256).digest() + ct)'
                ].join('\n'), 'utf8');
                process.env.PYTHONPATH = prevPyPath ? `${shimRoot}${path.delimiter}${prevPyPath}` : shimRoot;
            }

            const journalPath = path.join(tmpDir, 'Diario.docx');
            const secretKey = '0123456789abcdef0123456789abcdef';
            process.env.JOURNAL_SECRET_KEY = secretKey;
            process.env.JOURNAL_LOCAL_PATH = journalPath;
            process.env.WORD_PASSWORD = 'WordExportPassword2026!';

            // Asegurar estado limpio de contraseña de descarga en settings
            await request({
                port,
                method: 'PUT',
                reqPath: '/api/settings',
                headers: { Cookie: adminCookie },
                body: { clearJournalDownloadPassword: true }
            });

            // 1. RBAC (401 sin sesión, 403 psiquiatra) y 404 cuando aún no existe Diario.docx
            assert.strictEqual((await request({ port, reqPath: '/api/journal/download-encrypted' })).status, 401);
            assert.strictEqual((await request({ port, method: 'POST', reqPath: '/api/journal/download-encrypted', body: { password: 'MiPassword2026!' } })).status, 401);
            assert.strictEqual((await request({ port, reqPath: '/api/journal/download-encrypted', headers: { Cookie: medicoCookie } })).status, 403);
            assert.strictEqual((await request({ port, method: 'POST', reqPath: '/api/journal/download-encrypted', headers: { Cookie: medicoCookie }, body: { password: 'MiPassword2026!' } })).status, 403);

            const missingGet = await request({ port, reqPath: '/api/journal/download-encrypted', headers: { Cookie: adminCookie } });
            assert.strictEqual(missingGet.status, 404);
            const missingPost = await request({ port, method: 'POST', reqPath: '/api/journal/download-encrypted', headers: { Cookie: adminCookie }, body: { password: 'MiPassword2026!' } });
            assert.strictEqual(missingPost.status, 404);

            // 2. Crear Diario.docx cifrado vía /api/send-to-pc y comprobar 409 DOWNLOAD_PASSWORD_NOT_CONFIGURED sin contraseña previa
            const noteEnvelope = serverNotes.encryptJournalSaltedE2ee('Hoy probamos la descarga cifrada E2EE del Diario.', secretKey);
            const sendRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/send-to-pc',
                headers: { Cookie: adminCookie },
                body: { texto: noteEnvelope }
            });
            assert.strictEqual(sendRes.status, 200, sendRes.body);
            assert.strictEqual(fs.existsSync(journalPath), true);

            const notCfgRes = await request({ port, reqPath: '/api/journal/download-encrypted', headers: { Cookie: adminCookie } });
            assert.strictEqual(notCfgRes.status, 409);
            assert.strictEqual(JSON.parse(notCfgRes.body).reason, 'DOWNLOAD_PASSWORD_NOT_CONFIGURED');

            // 3. Configurar journalDownloadPassword vía PUT /api/settings, verificar GET /api/settings (sin texto plano) y GET /api/journal/download-encrypted
            const savedDlPwd = 'MiClaveDescarga2026!';
            const putSettingsRes = await request({
                port,
                method: 'PUT',
                reqPath: '/api/settings',
                headers: { Cookie: adminCookie },
                body: { journalDownloadPassword: savedDlPwd }
            });
            assert.strictEqual(putSettingsRes.status, 200);
            const putSettingsJson = JSON.parse(putSettingsRes.body).settings;
            assert.strictEqual(putSettingsJson.journalDownloadPasswordConfigured, true);
            assert.strictEqual(putSettingsJson.journalDownloadPassword, undefined);

            const getSettingsRes = await request({ port, reqPath: '/api/settings', headers: { Cookie: adminCookie } });
            assert.strictEqual(getSettingsRes.status, 200);
            const getSettingsJson = JSON.parse(getSettingsRes.body).settings;
            assert.strictEqual(getSettingsJson.journalDownloadPasswordConfigured, true);
            assert.strictEqual(getSettingsJson.journalDownloadPassword, undefined);
            assert.equal(getSettingsRes.body.includes(savedDlPwd), false, 'GET /api/settings jamás debe exponer la contraseña en texto plano');

            const storedRawSettings = userSettingsMap.get(1) || '';
            assert.equal(storedRawSettings.includes(savedDlPwd), false, 'userSettings en BD debe cifrar journalDownloadPassword en reposo');

            const lockHistStart = advisoryLockHistory.length;
            const dlGetRes = await request({
                port,
                reqPath: '/api/journal/download-encrypted',
                headers: { Cookie: adminCookie }
            });
            assert.strictEqual(dlGetRes.status, 200, dlGetRes.body);
            assert.match(String(dlGetRes.headers['cache-control'] || ''), /no-store/i);
            const dlGetJson = JSON.parse(dlGetRes.body);
            assert.strictEqual(dlGetJson.ok, true);
            assert.match(dlGetJson.filename, /^Diario_\d{4}-\d{2}-\d{2}\.docx$/);
            assert.strictEqual(dlGetJson.scheme, 'pdh-j2-pbkdf2-hmac-binary');
            assert.ok(dlGetJson.encryptedDocx.startsWith('pdh-j2:120000:'));

            const decGet = serverNotes.decryptJournalSaltedBytesE2ee(dlGetJson.encryptedDocx, savedDlPwd);
            assert.strictEqual(decGet.ok, true);
            assert.strictEqual(decGet.buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])), true);

            const locksAfterGet = advisoryLockHistory.slice(lockHistStart);
            assert.ok(locksAfterGet.some((e) => e.op === 'acquire' && e.lockName === 'pdh_docx_journal' && e.result === 1));
            assert.ok(locksAfterGet.some((e) => e.op === 'release' && e.lockName === 'pdh_docx_journal' && e.result === 1));
            assert.strictEqual(activeAdvisoryLocks.size, 0);

            // 4. POST /api/journal/download-encrypted con contraseña ingresada al momento (uso único, no sobrescribe settings)
            const badPostRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/journal/download-encrypted',
                headers: { Cookie: adminCookie },
                body: { password: 'short' }
            });
            assert.strictEqual(badPostRes.status, 400);

            const oneTimePwd = 'ClaveUnicaMomento99!';
            const dlPostRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/journal/download-encrypted',
                headers: { Cookie: adminCookie },
                body: { password: oneTimePwd }
            });
            assert.strictEqual(dlPostRes.status, 200, dlPostRes.body);
            const dlPostJson = JSON.parse(dlPostRes.body);
            assert.strictEqual(dlPostJson.ok, true);
            const decPost = serverNotes.decryptJournalSaltedBytesE2ee(dlPostJson.encryptedDocx, oneTimePwd);
            assert.strictEqual(decPost.ok, true);
            assert.strictEqual(decPost.buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])), true);

            // La contraseña guardada previamente sigue intacta
            const dlGetStillSaved = await request({
                port,
                reqPath: '/api/journal/download-encrypted',
                headers: { Cookie: adminCookie }
            });
            assert.strictEqual(dlGetStillSaved.status, 200);
            assert.strictEqual(
                serverNotes.decryptJournalSaltedBytesE2ee(JSON.parse(dlGetStillSaved.body).encryptedDocx, savedDlPwd).ok,
                true
            );

            // 5. GET /api/journal/download previo sigue intacto devolviendo el archivo OLE2 crudo cifrado
            const rawDlRes = await request({
                port,
                reqPath: '/api/journal/download',
                headers: { Cookie: adminCookie }
            });
            assert.strictEqual(rawDlRes.status, 200);
            assert.ok(rawDlRes.body.length > 0);
            assert.strictEqual(fs.readFileSync(journalPath).subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])), true);

            // Borrar contraseña de descarga con clearJournalDownloadPassword
            const clearRes = await request({
                port,
                method: 'PUT',
                reqPath: '/api/settings',
                headers: { Cookie: adminCookie },
                body: { clearJournalDownloadPassword: true }
            });
            assert.strictEqual(clearRes.status, 200);
            assert.strictEqual(JSON.parse(clearRes.body).settings.journalDownloadPasswordConfigured, false);
        } finally {
            if (prevKey === undefined) delete process.env.JOURNAL_SECRET_KEY; else process.env.JOURNAL_SECRET_KEY = prevKey;
            if (prevJrnPath === undefined) delete process.env.JOURNAL_LOCAL_PATH; else process.env.JOURNAL_LOCAL_PATH = prevJrnPath;
            if (prevWordPass === undefined) delete process.env.WORD_PASSWORD; else process.env.WORD_PASSWORD = prevWordPass;
            if (prevPyPath === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = prevPyPath;
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('verifica y reemplaza letras inconsistentes con POST /api/english/music/verify-replace-lyrics (RBAC + replaced/unchanged/409)', async () => {
        const fs = require('node:fs');
        const os = require('node:os');
        const serverNotes = require('../lib/server-notes-service');
        const langStudio = require('../lib/language-studio');
        const ytdlpService = require(path.join(ROOT, 'lib', 'ytdlp-service'));
        const origExtract = ytdlpService.extractSongLyrics;

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdh-verify-replace-'));
        const prevKey = process.env.JOURNAL_SECRET_KEY;
        const prevEngPath = process.env.ENGLISH_WORD_FILE_PATH;
        const prevJrnPath = process.env.JOURNAL_LOCAL_PATH;
        const prevRclone = process.env.RCLONE_CONFIG;
        const testKey = '0123456789abcdef0123456789abcdef';

        const ADDICTED_LINES = [
            'Now you got me so addicted',
            'Spinning slowly in the midnight glow',
            'Every echo keeps me waiting here',
            'Shadows dancing on the avenue',
            'Counting signals till the morning comes',
            'Silver ribbons in the quiet room'
        ].join('\n');

        const SUN_LINES = [
            'Oh, hey now, come outside',
            'Raindrops shimmer on the garden stone',
            'Golden puddles under open skies',
            'Warm breeze carries every quiet tone',
            'Step into the brightness after rain',
            'Clouds are drifting past the tallest trees'
        ].join('\n');

        const FLOWER_LINES = [
            'Petals open in the early frost',
            'Crimson velvet by the windowsill',
            'Footsteps fading down the gravel road',
            'Lanterns flicker on the distant hill',
            'Pages turning in the winter breeze',
            'Starlight settles on the silent lake'
        ].join('\n');

        try {
            process.env.JOURNAL_SECRET_KEY = testKey;
            process.env.ENGLISH_WORD_FILE_PATH = path.join(tmpDir, 'English_Learning_Notebook.docx');
            process.env.JOURNAL_LOCAL_PATH = path.join(tmpDir, 'Diario.docx');
            process.env.RCLONE_CONFIG = path.join(tmpDir, 'nonexistent-rclone.conf');

            // Sembrar Sun Showers (con letra errónea de otra canción en Original) y Flower
            const seedSun = await request({
                port,
                method: 'POST',
                reqPath: '/api/send-english',
                headers: { Cookie: adminCookie },
                body: {
                    texto: serverNotes.encryptClientE2ee(JSON.stringify({
                        category: 'music',
                        language: 'English',
                        song_title: 'Sun Showers (From "The Angry Birds Movie 3")',
                        artists_display: 'JISOO',
                        yt_music_url: 'https://music.youtube.com/watch?v=REUpBcmDbTE',
                        lyrics_study: `Original\n${ADDICTED_LINES}`
                    }), testKey)
                }
            });
            assert.strictEqual(seedSun.status, 200);

            const seedFlower = await request({
                port,
                method: 'POST',
                reqPath: '/api/send-english',
                headers: { Cookie: adminCookie },
                body: {
                    texto: serverNotes.encryptClientE2ee(JSON.stringify({
                        category: 'music',
                        language: 'English',
                        song_title: 'Flower',
                        artists_display: 'JISOO',
                        lyrics_study: FLOWER_LINES
                    }), testKey)
                }
            });
            assert.strictEqual(seedFlower.status, 200);

            // /api/send-english debe rechazar con 409 si otra canción intenta guardar letra duplicada
            const dupSaveRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/send-english',
                headers: { Cookie: adminCookie },
                body: {
                    texto: serverNotes.encryptClientE2ee(JSON.stringify({
                        category: 'music',
                        language: 'English',
                        song_title: 'Butterfly',
                        artists_display: 'JISOO',
                        lyrics_study: FLOWER_LINES
                    }), testKey)
                }
            });
            assert.strictEqual(dupSaveRes.status, 409);

            const verifyPayload = {
                songTitle: 'Sun Showers (From "The Angry Birds Movie 3")',
                artistName: 'JISOO',
                ytMusicUrl: 'https://music.youtube.com/watch?v=REUpBcmDbTE',
                language: 'English'
            };

            // RBAC: sin sesión -> 401; médico no admin -> 403
            const unauthVerify = await request({
                port,
                method: 'POST',
                reqPath: '/api/english/music/verify-replace-lyrics',
                body: verifyPayload
            });
            assert.strictEqual(unauthVerify.status, 401);

            const medicoVerify = await request({
                port,
                method: 'POST',
                reqPath: '/api/english/music/verify-replace-lyrics',
                headers: { Cookie: medicoCookie },
                body: verifyPayload
            });
            assert.strictEqual(medicoVerify.status, 403);

            // 1) Letra en Word no coincide -> reemplaza limpiamente con la letra verificada (limpiando [music])
            ytdlpService.extractSongLyrics = async () => ({
                ok: true,
                videoId: 'REUpBcmDbTE',
                lyrics: SUN_LINES.replace('Oh, hey now, come outside', 'Oh, hey [music] now, come outside\n[Music]'),
                source: 'youtube:asr-captions'
            });

            const replacedRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/english/music/verify-replace-lyrics',
                headers: { Cookie: adminCookie },
                body: verifyPayload
            });
            assert.strictEqual(replacedRes.status, 200, replacedRes.body);
            const replacedJson = JSON.parse(replacedRes.body);
            assert.strictEqual(replacedJson.ok, true);
            assert.strictEqual(replacedJson.action, 'replaced');

            const docxAfterReplace = fs.readFileSync(process.env.ENGLISH_WORD_FILE_PATH);
            const parsedAfter = langStudio.parseStudyNotebookDocxBuffer(docxAfterReplace, { includeAllEntries: true, includeAll: true });
            assert.strictEqual(parsedAfter.ok, true);
            const musicAfter = (parsedAfter.allEntries || parsedAfter.entries).filter((e) => e.section === 'music');
            assert.strictEqual(musicAfter.length, 2);

            const updatedSun = langStudio.findNotebookSongEntry(parsedAfter, { songTitle: 'Sun Showers', artistName: 'JISOO' });
            assert.ok(updatedSun);
            assert.ok(updatedSun.lyrics.includes('Oh, hey now, come outside'));
            assert.ok(!/\[music\]/i.test(updatedSun.lyrics));
            assert.ok(!/addicted/i.test(updatedSun.lyrics));

            const intactFlower = langStudio.findNotebookSongEntry(parsedAfter, { songTitle: 'Flower', artistName: 'JISOO' });
            assert.ok(intactFlower);
            assert.ok(intactFlower.lyrics.includes('Petals open in the early frost'));

            // 2) Segunda llamada cuando ya coincide -> action: 'unchanged' sin modificar el archivo
            const shaAfterReplace = crypto.createHash('sha256').update(docxAfterReplace).digest('hex');
            ytdlpService.extractSongLyrics = async () => ({
                ok: true,
                videoId: 'REUpBcmDbTE',
                lyrics: SUN_LINES,
                source: 'youtube:asr-captions'
            });

            const unchangedRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/english/music/verify-replace-lyrics',
                headers: { Cookie: adminCookie },
                body: verifyPayload
            });
            assert.strictEqual(unchangedRes.status, 200, unchangedRes.body);
            const unchangedJson = JSON.parse(unchangedRes.body);
            assert.strictEqual(unchangedJson.ok, true);
            assert.strictEqual(unchangedJson.action, 'unchanged');
            assert.strictEqual(
                crypto.createHash('sha256').update(fs.readFileSync(process.env.ENGLISH_WORD_FILE_PATH)).digest('hex'),
                shaAfterReplace
            );

            // 3) Si la letra candidata duplica otra canción del cuaderno (Flower) -> 409 y no modifica el archivo
            ytdlpService.extractSongLyrics = async () => ({
                ok: true,
                videoId: 'REUpBcmDbTE',
                lyrics: FLOWER_LINES,
                source: 'ytmusic:innertube:song'
            });

            const dupRejectRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/english/music/verify-replace-lyrics',
                headers: { Cookie: adminCookie },
                body: verifyPayload
            });
            assert.strictEqual(dupRejectRes.status, 409, dupRejectRes.body);
            const dupRejectJson = JSON.parse(dupRejectRes.body);
            assert.strictEqual(dupRejectJson.ok, false);
            assert.strictEqual(dupRejectJson.reason, 'DUPLICATE_OTHER_SONG');
            assert.strictEqual(dupRejectJson.matchedSong, 'Flower');
            assert.strictEqual(
                crypto.createHash('sha256').update(fs.readFileSync(process.env.ENGLISH_WORD_FILE_PATH)).digest('hex'),
                shaAfterReplace
            );
        } finally {
            ytdlpService.extractSongLyrics = origExtract;
            if (prevKey === undefined) delete process.env.JOURNAL_SECRET_KEY; else process.env.JOURNAL_SECRET_KEY = prevKey;
            if (prevEngPath === undefined) delete process.env.ENGLISH_WORD_FILE_PATH; else process.env.ENGLISH_WORD_FILE_PATH = prevEngPath;
            if (prevJrnPath === undefined) delete process.env.JOURNAL_LOCAL_PATH; else process.env.JOURNAL_LOCAL_PATH = prevJrnPath;
            if (prevRclone === undefined) delete process.env.RCLONE_CONFIG; else process.env.RCLONE_CONFIG = prevRclone;
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('limpia apartado Inglés redundante en canción en inglés existente al llamar /api/english/music/verify-replace-lyrics sin duplicar ni corromper el .docx', async () => {
        const fs = require('node:fs');
        const os = require('node:os');
        const { spawnSync } = require('node:child_process');
        const langStudio = require('../lib/language-studio');
        const ytdlpService = require(path.join(ROOT, 'lib', 'ytdlp-service'));
        const origExtract = ytdlpService.extractSongLyrics;

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdh-clean-redundant-en-'));
        const docxPath = path.join(tmpDir, 'English_Learning_Notebook.docx');
        const prevKey = process.env.JOURNAL_SECRET_KEY;
        const prevEngPath = process.env.ENGLISH_WORD_FILE_PATH;
        const prevJrnPath = process.env.JOURNAL_LOCAL_PATH;
        const prevRclone = process.env.RCLONE_CONFIG;

        const SUN_LINES = [
            'Oh, hey now, come outside',
            'Raindrops shimmer on the garden stone',
            'Golden puddles under open skies',
            'Warm breeze carries every quiet tone',
            'Step into the brightness after rain',
            'Clouds are drifting past the tallest trees'
        ].join('\n');

        try {
            process.env.JOURNAL_SECRET_KEY = '0123456789abcdef0123456789abcdef';
            process.env.ENGLISH_WORD_FILE_PATH = docxPath;
            process.env.JOURNAL_LOCAL_PATH = path.join(tmpDir, 'Diario.docx');
            process.env.RCLONE_CONFIG = path.join(tmpDir, 'nonexistent-rclone.conf');

            const pyBin = process.platform === 'win32' ? 'python' : 'python3';
            // Construir .docx heredado con Language: English y secciones redundantes Original + English
            const pySeed = spawnSync(
                pyBin,
                [
                    '-c',
                    [
                        'import io, sys, zipfile',
                        `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'lib'))})`,
                        'import docx_writer as dw',
                        'b = dw._build_minimal_docx_bytes(mode="english")',
                        'out, _ = dw.update_english_docx_bytes(b, {"category":"music","language":"English","song_title":"Sun Showers","artists_display":"JISOO","yt_music_url":"https://music.youtube.com/watch?v=REUpBcmDbTE","notes":"Nota personal intacta","vocabulary_list":"stone = piedra","lyrics_study": sys.argv[2]})',
                        '# Inyectar sección heredada English (como ocurría antes de la regla por idioma)',
                        'extra_xml = "".join([',
                        '    "Clouds are drifting past the tallest trees</w:t></w:r></w:p>",',
                        '    "<w:p><w:r><w:t></w:t></w:r></w:p>",',
                        '    "<w:p><w:r><w:t>English</w:t></w:r></w:p>",',
                        '    "<w:p><w:r><w:t>Oh, hey [music] now, come outside</w:t></w:r></w:p>",',
                        '    "<w:p><w:r><w:t>Raindrops shimmer on the garden stone</w:t></w:r></w:p>",',
                        '    "<w:p><w:r><w:t>Golden puddles under open skies</w:t></w:r></w:p>",',
                        '    "<w:p><w:r><w:t>Warm breeze carries every quiet tone</w:t></w:r></w:p>",',
                        '    "<w:p><w:r><w:t>Step into the brightness after rain</w:t></w:r></w:p>",',
                        '    "<w:p><w:r><w:t>Clouds are drifting past the tallest trees</w:t>"',
                        '])',
                        'with zipfile.ZipFile(io.BytesIO(out), "r") as zin:',
                        '    doc_xml = zin.read("word/document.xml").decode("utf-8")',
                        '    assert "Clouds are drifting past the tallest trees</w:t>" in doc_xml',
                        '    doc_xml = doc_xml.replace("Clouds are drifting past the tallest trees</w:t>", extra_xml, 1)',
                        '    ob = io.BytesIO()',
                        '    with zipfile.ZipFile(ob, "w", zipfile.ZIP_DEFLATED) as zout:',
                        '        for info in zin.infolist():',
                        '            zout.writestr(info, doc_xml.encode("utf-8") if info.filename == "word/document.xml" else zin.read(info.filename))',
                        'with open(sys.argv[1], "wb") as f:',
                        '    f.write(ob.getvalue())'
                    ].join('\n'),
                    docxPath,
                    SUN_LINES
                ],
                { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } }
            );
            assert.strictEqual(pySeed.status, 0, pySeed.stderr || pySeed.stdout);

            const beforeParsed = langStudio.parseStudyNotebookDocxBuffer(fs.readFileSync(docxPath), { includeAllEntries: true });
            const beforeSong = langStudio.findNotebookSongEntry(beforeParsed, { songTitle: 'Sun Showers', artistName: 'JISOO' });
            assert.ok(beforeSong && beforeSong.lyrics.includes('English\n'));

            ytdlpService.extractSongLyrics = async () => ({
                ok: true,
                videoId: 'REUpBcmDbTE',
                lyrics: `[ORIGINAL]\n${SUN_LINES}\n\n[EN]\n${SUN_LINES}`,
                source: 'youtube:asr-captions'
            });

            const cleanRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/english/music/verify-replace-lyrics',
                headers: { Cookie: adminCookie },
                body: {
                    songTitle: 'Sun Showers',
                    artistName: 'JISOO',
                    ytMusicUrl: 'https://music.youtube.com/watch?v=REUpBcmDbTE',
                    language: 'English'
                }
            });
            assert.strictEqual(cleanRes.status, 200, cleanRes.body);
            const cleanJson = JSON.parse(cleanRes.body);
            assert.strictEqual(cleanJson.ok, true);
            assert.strictEqual(cleanJson.action, 'replaced');

            const afterBytes = fs.readFileSync(docxPath);
            const afterParsed = langStudio.parseStudyNotebookDocxBuffer(afterBytes, { includeAllEntries: true });
            const musicAfter = (afterParsed.allEntries || afterParsed.entries).filter((e) => e.section === 'music');
            assert.strictEqual(musicAfter.length, 1);
            const afterSong = langStudio.findNotebookSongEntry(afterParsed, { songTitle: 'Sun Showers', artistName: 'JISOO' });
            assert.ok(afterSong);
            assert.ok(afterSong.lyrics.includes('Oh, hey now, come outside'));
            assert.strictEqual(/\bEnglish\n/i.test(afterSong.lyrics), false, 'Debe eliminar el apartado redundante English del .docx');
            assert.ok(String(afterSong.fields?.notes || '').includes('Nota personal intacta'));
            assert.ok(String(afterSong.fields?.vocabulary_list || '').includes('stone = piedra'));

            // Segunda verificación debe reportar unchanged
            const secondRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/english/music/verify-replace-lyrics',
                headers: { Cookie: adminCookie },
                body: {
                    songTitle: 'Sun Showers',
                    artistName: 'JISOO',
                    ytMusicUrl: 'https://music.youtube.com/watch?v=REUpBcmDbTE',
                    language: 'English'
                }
            });
            assert.strictEqual(secondRes.status, 200, secondRes.body);
            assert.strictEqual(JSON.parse(secondRes.body).action, 'unchanged');
        } finally {
            ytdlpService.extractSongLyrics = origExtract;
            if (prevKey === undefined) delete process.env.JOURNAL_SECRET_KEY; else process.env.JOURNAL_SECRET_KEY = prevKey;
            if (prevEngPath === undefined) delete process.env.ENGLISH_WORD_FILE_PATH; else process.env.ENGLISH_WORD_FILE_PATH = prevEngPath;
            if (prevJrnPath === undefined) delete process.env.JOURNAL_LOCAL_PATH; else process.env.JOURNAL_LOCAL_PATH = prevJrnPath;
            if (prevRclone === undefined) delete process.env.RCLONE_CONFIG; else process.env.RCLONE_CONFIG = prevRclone;
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('pausa recordatorios por materia y guarda promedio, silencia tareas en_progreso hasta 1h y aplica nuevas reglas Smart Commute en Ajustes', async () => {
        const serverExports = require('../server');
        assert.strictEqual(typeof serverExports.computeSmartCommuteAlertSchedule, 'function');

        // 1. Prueba unitaria pura de computeSmartCommuteAlertSchedule
        const homeSeq = serverExports.computeSmartCommuteAlertSchedule({
            zone: 'home',
            routeMinutes: 11,
            extraBufferMinutes: 30,
            repeatEveryMinutes: 5
        });
        assert.deepStrictEqual(homeSeq.milestones, [41, 36, 31, 26, 21, 16, 11, 6, 1]);
        assert.strictEqual(homeSeq.recommendedLeadMinutes, 41);

        const awaySeq = serverExports.computeSmartCommuteAlertSchedule({
            zone: 'away',
            routeMinutes: 11,
            extraBufferMinutes: 30,
            repeatEveryMinutes: 5
        });
        assert.deepStrictEqual(awaySeq.milestones, [41, 36, 31, 26, 21, 16, 11, 6, 1]);

        const nearSeq = serverExports.computeSmartCommuteAlertSchedule({
            zone: 'near',
            routeMinutes: 11,
            extraBufferMinutes: 30,
            repeatEveryMinutes: 5,
            nearAlertMinutes: [20, 15, 10]
        });
        assert.deepStrictEqual(nearSeq.milestones, [20, 15, 10]);

        const ackedHome = serverExports.computeSmartCommuteAlertSchedule({
            zone: 'home',
            routeMinutes: 11,
            extraBufferMinutes: 30,
            repeatEveryMinutes: 5,
            acknowledged: true
        });
        assert.deepStrictEqual(ackedHome.milestones, []);

        // 2. Guardar y recuperar configuración Smart Commute en /api/settings y verificar sincronización con /api/planner
        const origSettings = JSON.parse((await request({ port, reqPath: '/api/settings', headers: { Cookie: adminCookie } })).body).settings;
        const origPlanner = JSON.parse((await request({ port, reqPath: '/api/planner', headers: { Cookie: adminCookie } })).body).planner;

        try {
            const badCommuteRes = await request({
                port,
                method: 'PUT',
                reqPath: '/api/settings',
                headers: { Cookie: adminCookie },
                body: { commuteExtraBufferMinutes: 2 }
            });
            assert.strictEqual(badCommuteRes.status, 400);

            const saveCommuteRes = await request({
                port,
                method: 'PUT',
                reqPath: '/api/settings',
                headers: { Cookie: adminCookie },
                body: {
                    uiLanguage: 'es',
                    timezone: 'UTC',
                    agendaRemindersEnabled: true,
                    agendaNotifyTasks: true,
                    agendaNotifyEvents: true,
                    agendaNotifyPendingTasks: true,
                    agendaLeadMinutes: 10,
                    commuteRemindersEnabled: true,
                    commuteExtraBufferMinutes: 30,
                    commuteRepeatEveryMinutes: 5,
                    commuteNearAlertMinutes: [20, 15, 10],
                    commuteNearRadiusKm: 0.5
                }
            });
            assert.strictEqual(saveCommuteRes.status, 200);
            const savedCommuteSettings = JSON.parse(saveCommuteRes.body).settings;
            assert.strictEqual(savedCommuteSettings.commuteRemindersEnabled, true);
            assert.strictEqual(savedCommuteSettings.commuteExtraBufferMinutes, 30);
            assert.strictEqual(savedCommuteSettings.commuteRepeatEveryMinutes, 5);
            assert.deepStrictEqual(savedCommuteSettings.commuteNearAlertMinutes, [20, 15, 10]);
            assert.strictEqual(savedCommuteSettings.commuteNearRadiusKm, 0.5);

            const getCommutePlanner = JSON.parse((await request({ port, reqPath: '/api/planner', headers: { Cookie: adminCookie } })).body).planner;
            assert.strictEqual(getCommutePlanner.commuteExtraBufferMinutes, 30);
            assert.strictEqual(getCommutePlanner.commuteRepeatEveryMinutes, 5);
            assert.deepStrictEqual(getCommutePlanner.commuteNearAlertMinutes, [20, 15, 10]);
            assert.strictEqual(getCommutePlanner.nearRadiusKm, 0.5);

            // 3. Guardar materia pausada/completada con promedio 95.5 y otra activa; verificar scheduler
            await request({
                port,
                method: 'POST',
                reqPath: '/api/planner/location',
                headers: { Cookie: adminCookie },
                body: { lat: 25.4414, lng: -100.9922, label: 'En Campus Principal' }
            });

            const nowPartsRes = await request({ port, reqPath: '/api/reminders/active', headers: { Cookie: adminCookie } });
            const localNow = JSON.parse(nowPartsRes.body).localNow;
            const toHHMM = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
            const safeBaseMin = Math.min(localNow.minutesOfDay + 12, 23 * 60 + 40);

            const plannerTestPayload = JSON.parse((await request({ port, reqPath: '/api/planner', headers: { Cookie: adminCookie } })).body).planner;
            plannerTestPayload.vacations = [];
            plannerTestPayload.semesters[0].startDate = '2020-01-01';
            plannerTestPayload.semesters[0].endDate = '2030-12-31';
            plannerTestPayload.semesters[0].courses = [
                {
                    id: 'paused-course-1',
                    code: 'DED2504',
                    name: 'Integración y Despliegue Continuos',
                    room: 'R11',
                    campusId: 'principal',
                    days: [0, 1, 2, 3, 4, 5, 6],
                    startTime: toHHMM(safeBaseMin),
                    endTime: toHHMM(safeBaseMin + 50),
                    remindersPaused: true,
                    completed: true,
                    finalGrade: 95.5
                },
                {
                    id: 'active-course-1',
                    code: 'DSG1001',
                    name: 'Desarrollo Seguro',
                    room: 'R02',
                    campusId: 'principal',
                    days: [0, 1, 2, 3, 4, 5, 6],
                    startTime: toHHMM(safeBaseMin),
                    endTime: toHHMM(safeBaseMin + 50),
                    remindersPaused: false,
                    completed: false,
                    finalGrade: null
                }
            ];

            const putPlannerRes = await request({
                port,
                method: 'PUT',
                reqPath: '/api/planner',
                headers: { Cookie: adminCookie },
                body: { planner: plannerTestPayload }
            });
            assert.strictEqual(putPlannerRes.status, 200);

            const reloadedPlanner = JSON.parse((await request({ port, reqPath: '/api/planner', headers: { Cookie: adminCookie } })).body).planner;
            const reloadedPaused = reloadedPlanner.semesters[0].courses.find((c) => c.id === 'paused-course-1');
            assert.ok(reloadedPaused);
            assert.strictEqual(reloadedPaused.remindersPaused, true);
            assert.strictEqual(reloadedPaused.completed, true);
            assert.strictEqual(reloadedPaused.finalGrade, 95.5);

            const activeAfterCourses = JSON.parse((await request({ port, reqPath: '/api/reminders/active', headers: { Cookie: adminCookie } })).body).active;
            assert.strictEqual(
                activeAfterCourses.some((r) => r.type === 'class' && r.ackKey?.includes('paused-course-1')),
                false,
                'Una materia pausada/completada no debe generar alertas de clase/traslado'
            );
            assert.strictEqual(
                activeAfterCourses.some((r) => r.type === 'class' && r.ackKey?.includes('active-course-1')),
                true,
                'Otra materia activa sí debe generar su alerta de clase/traslado'
            );

            // 4. Tareas en estado 'in_progress' (en_progreso): silenciosas < 60 min y 1 seguimiento >= 60 min
            const createTaskRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/insert-agenda',
                headers: { Cookie: adminCookie, 'X-Idempotency-Key': 'agenda-inprog-1h-test' },
                body: {
                    fecha: localNow.dateStr,
                    bloque: 'cole',
                    hora: toHHMM(Math.max(0, localNow.minutesOfDay - 5)),
                    titulo: 'Configurar Pipeline CI/CD',
                    tipo: 'tarea',
                    categoria: 'universidad',
                    estado: 'todo',
                    recordatorio_min: 15
                }
            });
            assert.strictEqual(createTaskRes.status, 201);
            const inProgTaskId = JSON.parse(createTaskRes.body).item.id;

            const activeWhileTodo = JSON.parse((await request({ port, reqPath: '/api/reminders/active', headers: { Cookie: adminCookie } })).body).active;
            assert.strictEqual(
                activeWhileTodo.some((r) => Number(r.refId) === inProgTaskId && r.key.startsWith('agenda:')),
                true,
                'Mientras está en todo debe generar recordatorio normal'
            );

            const moveInProgRes = await request({
                port,
                method: 'PATCH',
                reqPath: `/api/toggle-agenda/${inProgTaskId}`,
                headers: { Cookie: adminCookie },
                body: { estado: 'en_progreso' }
            });
            assert.strictEqual(moveInProgRes.status, 200);
            const moveInProgJson = JSON.parse(moveInProgRes.body);
            assert.strictEqual(moveInProgJson.estado, 'in_progress');
            assert.ok(moveInProgJson.en_progreso_desde, 'Debe registrar en_progreso_desde al pasar a in_progress');

            const storedRow = agendaInserts.find((a) => a.id === inProgTaskId);
            assert.ok(storedRow && storedRow.en_progreso_desde);

            // Recién puesta en progreso (< 60 min): NO debe haber aviso normal ni de seguimiento
            const activeJustStarted = JSON.parse((await request({ port, reqPath: '/api/reminders/active', headers: { Cookie: adminCookie } })).body).active;
            assert.strictEqual(
                activeJustStarted.some((r) => Number(r.refId) === inProgTaskId),
                false,
                'En progreso < 60 min debe silenciar avisos normales y no disparar seguimiento aún'
            );

            // Simular que transcurrieron 65 minutos en progreso
            const sixtyFiveMinAgo = new Date(Date.now() - 65 * 60 * 1000);
            storedRow.en_progreso_desde = sixtyFiveMinAgo.toISOString();

            const activeAfter1h = JSON.parse((await request({ port, reqPath: '/api/reminders/active', headers: { Cookie: adminCookie } })).body).active;
            const followUpRem = activeAfter1h.find((r) => Number(r.refId) === inProgTaskId && r.key.startsWith('task-inprog:'));
            assert.ok(followUpRem, 'Después de >= 60 min en progreso debe disparar seguimiento');
            assert.ok(followUpRem.title.includes('Llevas 1 hora en progreso'));

            // Posponer 30m respeta snooze_hasta sin mover fecha/hora ni reaparecer inmediatamente
            const snoozeInProgRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/reminders/snooze',
                headers: { Cookie: adminCookie },
                body: {
                    key: followUpRem.key,
                    action: 'snooze',
                    minutes: 30,
                    type: 'agenda',
                    refId: inProgTaskId,
                    title: followUpRem.title,
                    message: followUpRem.message
                }
            });
            assert.strictEqual(snoozeInProgRes.status, 200);
            const afterSnoozeInProg = JSON.parse((await request({ port, reqPath: '/api/reminders/active', headers: { Cookie: adminCookie } })).body);
            assert.strictEqual(afterSnoozeInProg.active.some((r) => r.key === followUpRem.key), false);
            assert.strictEqual(afterSnoozeInProg.snoozed.some((r) => r.key === followUpRem.key), true);

            // Al volver a 'todo', limpia en_progreso_desde y reanuda recordatorio normal
            const backToTodoRes = await request({
                port,
                method: 'PATCH',
                reqPath: `/api/toggle-agenda/${inProgTaskId}`,
                headers: { Cookie: adminCookie },
                body: { estado: 'todo' }
            });
            assert.strictEqual(backToTodoRes.status, 200);
            assert.strictEqual(JSON.parse(backToTodoRes.body).en_progreso_desde, null);
            assert.strictEqual(storedRow.en_progreso_desde, null);
        } finally {
            await request({
                port,
                method: 'PUT',
                reqPath: '/api/planner',
                headers: { Cookie: adminCookie },
                body: { planner: origPlanner }
            });
            await request({
                port,
                method: 'PUT',
                reqPath: '/api/settings',
                headers: { Cookie: adminCookie },
                body: {
                    uiLanguage: origSettings.uiLanguage || 'en',
                    timezone: origSettings.timezone || 'America/Monterrey',
                    agendaRemindersEnabled: origSettings.agendaRemindersEnabled !== false,
                    agendaNotifyTasks: origSettings.agendaNotifyTasks !== false,
                    agendaNotifyEvents: origSettings.agendaNotifyEvents !== false,
                    agendaNotifyPendingTasks: origSettings.agendaNotifyPendingTasks !== false,
                    agendaLeadMinutes: origSettings.agendaLeadMinutes ?? 10,
                    commuteRemindersEnabled: origSettings.commuteRemindersEnabled !== false,
                    commuteExtraBufferMinutes: origSettings.commuteExtraBufferMinutes ?? 30,
                    commuteRepeatEveryMinutes: origSettings.commuteRepeatEveryMinutes ?? 5,
                    commuteNearAlertMinutes: origSettings.commuteNearAlertMinutes ?? [20, 15, 10],
                    commuteNearRadiusKm: origSettings.commuteNearRadiusKm ?? 0.5
                }
            });
        }
    });

    it('persiste y sincroniza uiLanguage (en/es) en Ajustes, bandeja #reminderTray y notificaciones push ntfy', async () => {
        const invalidPatchRes = await request({
            port,
            method: 'PATCH',
            reqPath: '/api/settings/language',
            headers: { Cookie: adminCookie },
            body: { uiLanguage: 'pt' }
        });
        assert.strictEqual(invalidPatchRes.status, 400);

        const prevSettings = JSON.parse((await request({ port, reqPath: '/api/settings', headers: { Cookie: adminCookie } })).body).settings || {};

        // 1. Cambiar a Español vía PATCH /api/settings/language
        const patchEsRes = await request({
            port,
            method: 'PATCH',
            reqPath: '/api/settings/language',
            headers: { Cookie: adminCookie },
            body: { uiLanguage: 'es' }
        });
        assert.strictEqual(patchEsRes.status, 200);
        const patchEsData = JSON.parse(patchEsRes.body);
        assert.strictEqual(patchEsData.uiLanguage, 'es');
        assert.strictEqual(patchEsData.settings.uiLanguage, 'es');

        // Habilitar ntfy y recordatorios de tareas para probar bandeja + push en ambos idiomas
        const saveNtfyEs = await request({
            port,
            method: 'PUT',
            reqPath: '/api/settings',
            headers: { Cookie: adminCookie },
            body: {
                uiLanguage: 'es',
                phoneNotificationsEnabled: true,
                ntfyServerUrl: 'https://ntfy.sh',
                ntfyTopic: 'hub_flavio_biling_99',
                ntfyPriority: 4,
                agendaRemindersEnabled: true,
                agendaNotifyTasks: true,
                agendaLeadMinutes: 15
            }
        });
        assert.strictEqual(saveNtfyEs.status, 200);

        const localNow = JSON.parse((await request({ port, reqPath: '/api/reminders/pending', headers: { Cookie: adminCookie } })).body).localNow;
        const minsNow = Math.max(0, Number(localNow?.minutesOfDay || 10) - 5);
        const hhmm = `${String(Math.floor(minsNow / 60)).padStart(2, '0')}:${String(minsNow % 60).padStart(2, '0')}`;

        const addTaskRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-agenda',
            headers: { Cookie: adminCookie, 'X-Idempotency-Key': 'bilingual-rem-task-1' },
            body: {
                fecha: localNow.dateStr,
                bloque: 'manana',
                hora: hhmm,
                titulo: 'Entrega Final E2EE',
                tipo: 'tarea',
                categoria: 'personal',
                estado: 'todo',
                recordatorio_min: 15
            }
        });
        assert.strictEqual(addTaskRes.status, 201);
        const taskId = JSON.parse(addTaskRes.body).item.id;

        const originalFetch = globalThis.fetch;
        const capturedPushes = [];
        globalThis.fetch = async (url, options) => {
            capturedPushes.push({ url, options });
            return { ok: true, status: 200, text: async () => '{"id":"ntfy_biling_1"}' };
        };
        try {
            // 2. Bandeja y test push en Español
            const pendingEs = JSON.parse((await request({ port, reqPath: '/api/reminders/pending', headers: { Cookie: adminCookie } })).body);
            assert.strictEqual(pendingEs.uiLanguage, 'es');
            const taskRemEs = (pendingEs.pending || []).find(r => Number(r.refId) === Number(taskId));
            assert.ok(taskRemEs, 'Debe incluir la tarea pendiente en /api/reminders/pending');
            assert.ok(taskRemEs.title.includes('[Personal · Tarea]'), `Título esperado en español, recibió: ${taskRemEs.title}`);
            assert.ok(taskRemEs.message.includes('Entrega Final E2EE'), 'Nunca debe traducir el título escrito por el usuario');

            const testPushEsRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/reminders/test-push',
                headers: { Cookie: adminCookie },
                body: { publicBaseUrl: 'http://203.0.113.20:3000' }
            });
            assert.strictEqual(testPushEsRes.status, 200);
            assert.ok(capturedPushes.length >= 1);
            const pushEs = JSON.parse(capturedPushes[capturedPushes.length - 1].options.body);
            assert.strictEqual(pushEs.title, 'Personal Daily Hub - Celular Conectado');
            assert.ok(pushEs.actions.some(a => a.label === 'Abrir App'));
            assert.ok(pushEs.actions.some(a => a.label === 'Posponer 15m'));
            assert.ok(pushEs.actions.some(a => a.label === 'Omitir'));

            // 3. Cambiar a Inglés y verificar que /api/reminders/pending y test-push cambien al instante
            const patchEnRes = await request({
                port,
                method: 'PATCH',
                reqPath: '/api/settings/language',
                headers: { Cookie: adminCookie },
                body: { uiLanguage: 'en' }
            });
            assert.strictEqual(patchEnRes.status, 200);
            assert.strictEqual(JSON.parse(patchEnRes.body).uiLanguage, 'en');

            const pendingEn = JSON.parse((await request({ port, reqPath: '/api/reminders/pending', headers: { Cookie: adminCookie } })).body);
            assert.strictEqual(pendingEn.uiLanguage, 'en');
            const taskRemEn = (pendingEn.pending || []).find(r => Number(r.refId) === Number(taskId));
            assert.ok(taskRemEn);
            assert.ok(taskRemEn.title.includes('[Personal Task]'), `Título esperado en inglés, recibió: ${taskRemEn.title}`);
            assert.ok(taskRemEn.message.includes('Entrega Final E2EE'));

            const testPushEnRes = await request({
                port,
                method: 'POST',
                reqPath: '/api/reminders/test-push',
                headers: { Cookie: adminCookie },
                body: { publicBaseUrl: 'http://203.0.113.20:3000' }
            });
            assert.strictEqual(testPushEnRes.status, 200);
            const pushEn = JSON.parse(capturedPushes[capturedPushes.length - 1].options.body);
            assert.strictEqual(pushEn.title, 'Personal Daily Hub - Phone Connected');
            assert.ok(pushEn.actions.some(a => a.label === 'Open App'));
            assert.ok(pushEn.actions.some(a => a.label === 'Snooze 15m'));
            assert.ok(pushEn.actions.some(a => a.label === 'Skip'));

            // 4. Respuesta de /api/reminders/action respetando lang=es con token firmado real
            const snoozeUrlObj = new URL(pushEn.actions[1].url);
            const actionResEs = await request({
                port,
                method: 'POST',
                reqPath: `${snoozeUrlObj.pathname}${snoozeUrlObj.search}&lang=es`
            });
            assert.strictEqual(actionResEs.status, 200);
            assert.ok(JSON.parse(actionResEs.body).message.includes('Notificación de prueba pospuesta 15 minutos.'));
        } finally {
            globalThis.fetch = originalFetch;
            await request({
                port,
                method: 'PATCH',
                reqPath: `/api/toggle-agenda/${taskId}`,
                headers: { Cookie: adminCookie },
                body: { estado: 'done' }
            });
            await request({
                port,
                method: 'PUT',
                reqPath: '/api/settings',
                headers: { Cookie: adminCookie },
                body: {
                    uiLanguage: prevSettings.uiLanguage || 'en',
                    phoneNotificationsEnabled: Boolean(prevSettings.phoneNotificationsEnabled),
                    ntfyTopic: prevSettings.ntfyTopic || ''
                }
            });
        }
    });

    it('crea series repetitivas estilo Google Calendar con serie_id, elimina solo esta o las siguientes y bloquea borrar anteriores', async () => {
        // 1. Crear actividad repetitiva de 4 días con repeatDays: 4
        const createSeriesRes = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-agenda',
            headers: { Cookie: adminCookie, 'X-Idempotency-Key': 'agenda-gcal-series-4days' },
            body: {
                fecha: '2026-12-01',
                bloque: 'manana',
                hora: '09:30',
                titulo: 'Lectura matutina',
                descripcion: '20 minutos diarios',
                tipo: 'tarea',
                categoria: 'personal',
                estado: 'todo',
                repeatDays: 4
            }
        });
        assert.strictEqual(createSeriesRes.status, 201);
        const createdSeries = JSON.parse(createSeriesRes.body);
        assert.strictEqual(createdSeries.ok, true);
        assert.strictEqual(createdSeries.createdCount, 4);
        assert.strictEqual(createdSeries.repeatedCount, 4);
        assert.ok(createdSeries.serie_id && typeof createdSeries.serie_id === 'string');
        assert.deepStrictEqual(createdSeries.createdDates, ['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04']);

        const seriesRows = agendaInserts.filter((a) => a.serie_id === createdSeries.serie_id);
        assert.strictEqual(seriesRows.length, 4, 'Deben existir 4 filas en RegistrosAgenda compartiendo el mismo serie_id');
        assert.deepStrictEqual(
            seriesRows.map((r) => r.fecha).sort(),
            ['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04']
        );

        // GET /api/get-agenda debe incluir serie_id y followingCount exactos
        const listRes = await request({
            port,
            reqPath: '/api/get-agenda?begin=2026-12-01&end=2026-12-07',
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(listRes.status, 200);
        const listed = JSON.parse(listRes.body)
            .filter((r) => r.serie_id === createdSeries.serie_id)
            .sort((a, b) => a.fecha.localeCompare(b.fecha));
        assert.strictEqual(listed.length, 4);
        assert.deepStrictEqual(listed.map((r) => r.followingCount), [3, 2, 1, 0]);

        const day1 = listed[0];
        const day2 = listed[1];

        // 2. Eliminar ocurrencia del día 2 con scope=following: borra días 2, 3 y 4; día 1 queda 100% intacto
        const delFollowingRes = await request({
            port,
            method: 'DELETE',
            reqPath: `/api/delete-agenda/${day2.id}?scope=following`,
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(delFollowingRes.status, 200);
        const delFollowingJson = JSON.parse(delFollowingRes.body);
        assert.strictEqual(delFollowingJson.ok, true);
        assert.strictEqual(delFollowingJson.scope, 'following');
        assert.strictEqual(delFollowingJson.deletedCount, 3);
        assert.strictEqual(delFollowingJson.deletedIds.length, 3);

        const remainingAfterFollowing = agendaInserts.filter((a) => a.serie_id === createdSeries.serie_id);
        assert.strictEqual(remainingAfterFollowing.length, 1);
        assert.strictEqual(remainingAfterFollowing[0].id, day1.id);
        assert.strictEqual(remainingAfterFollowing[0].fecha, '2026-12-01');

        // 3. Intentar borrar con scope=previous o scope=all devuelve HTTP 400 y no borra nada
        for (const forbiddenScope of ['previous', 'all']) {
            const badScopeRes = await request({
                port,
                method: 'DELETE',
                reqPath: `/api/delete-agenda/${day1.id}?scope=${forbiddenScope}`,
                headers: { Cookie: adminCookie }
            });
            assert.strictEqual(badScopeRes.status, 400);
            assert.match(badScopeRes.body, /Past recurring occurrences cannot be deleted/i);
        }
        const badBodyScopeRes = await request({
            port,
            method: 'DELETE',
            reqPath: `/api/delete-agenda/${day1.id}`,
            headers: { Cookie: adminCookie },
            body: { scope: 'previous' }
        });
        assert.strictEqual(badBodyScopeRes.status, 400);
        assert.strictEqual(
            agendaInserts.some((a) => a.id === day1.id),
            true,
            'El día 1 debe permanecer intacto tras rechazar scope=previous/all'
        );

        // 4. Crear otra serie de 3 días y borrar el día 2 con scope=single: solo borra día 2
        const createSeries2Res = await request({
            port,
            method: 'POST',
            reqPath: '/api/insert-agenda',
            headers: { Cookie: adminCookie, 'X-Idempotency-Key': 'agenda-gcal-series-single-3days' },
            body: {
                fecha: '2026-12-10',
                bloque: 'tarde',
                hora: '16:00',
                titulo: 'Práctica de Inglés',
                tipo: 'tarea',
                categoria: 'personal',
                repeatDays: 3
            }
        });
        assert.strictEqual(createSeries2Res.status, 201);
        const series2 = JSON.parse(createSeries2Res.body);
        const series2Rows = agendaInserts
            .filter((a) => a.serie_id === series2.serie_id)
            .sort((a, b) => a.fecha.localeCompare(b.fecha));
        assert.strictEqual(series2Rows.length, 3);

        const delSingleRes = await request({
            port,
            method: 'DELETE',
            reqPath: `/api/delete-agenda/${series2Rows[1].id}?scope=single`,
            headers: { Cookie: adminCookie }
        });
        assert.strictEqual(delSingleRes.status, 200);
        const delSingleJson = JSON.parse(delSingleRes.body);
        assert.strictEqual(delSingleJson.ok, true);
        assert.strictEqual(delSingleJson.scope, 'single');
        assert.strictEqual(delSingleJson.deletedCount, 1);

        const remainingSeries2 = agendaInserts
            .filter((a) => a.serie_id === series2.serie_id)
            .sort((a, b) => a.fecha.localeCompare(b.fecha));
        assert.deepStrictEqual(
            remainingSeries2.map((r) => r.fecha),
            ['2026-12-10', '2026-12-12']
        );
    });

    it('aplica rate limit contra fuerza bruta en login y saturación DoS en endpoints API', async () => {
        // 1. Fuerza bruta en login (10 intentos fallidos -> el 11° devuelve 429 con Retry-After)
        let blockedLoginRes = null;
        for (let i = 1; i <= 12; i++) {
            const res = await request({
                port,
                method: 'POST',
                reqPath: '/api/auth/login',
                body: { email: 'medico@example.com', password: `WrongAttempt${i}!` }
            });
            if (res.status === 429) {
                blockedLoginRes = res;
                break;
            }
            assert.strictEqual(res.status, 401);
        }
        assert.ok(blockedLoginRes, 'Debe activar 429 Too Many Requests tras múltiples intentos fallidos de login');
        assert.ok(Number(blockedLoginRes.headers['retry-after']) >= 1, 'Debe incluir cabecera Retry-After');
        assert.ok(blockedLoginRes.headers['x-ratelimit-limit'], 'Debe incluir X-RateLimit-Limit');
        assert.strictEqual(blockedLoginRes.headers['x-ratelimit-remaining'], '0');

        // 2. Protección contra saturación en /api/pull-text (pcPullLimiter = 60 req/min por IP)
        let blockedPullRes = null;
        for (let i = 1; i <= 65; i++) {
            const res = await request({ port, reqPath: '/api/pull-text' });
            if (res.status === 429) {
                blockedPullRes = res;
                break;
            }
            assert.strictEqual(res.status, 200);
        }
        assert.ok(blockedPullRes, 'Debe devolver 429 al exceder el límite de peticiones en /api/pull-text');
        assert.ok(Number(blockedPullRes.headers['retry-after']) >= 1);
        assert.strictEqual(blockedPullRes.headers['x-ratelimit-remaining'], '0');
    });
});

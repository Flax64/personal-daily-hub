/* ==========================================================================
   lib/server-i18n.js — Backend Bilingual Engine (English <-> Español)
   Zero external dependencies. Keeps all DB enum keys and user-written text intact.
   ========================================================================== */
'use strict';

const SUPPORTED_UI_LANGS = ['en', 'es'];

function isValidStrictUiLang(raw) {
    if (typeof raw !== 'string') return false;
    const clean = raw.trim().toLowerCase();
    return clean === 'en' || clean === 'es';
}

function normalizeUiLang(raw, fallback = 'en') {
    const cleanFallback = fallback === 'es' ? 'es' : 'en';
    if (typeof raw !== 'string') return cleanFallback;
    const clean = raw.trim().toLowerCase();
    if (!clean) return cleanFallback;
    if (clean === 'es' || clean.startsWith('es-') || clean.startsWith('es_')) return 'es';
    if (clean === 'en' || clean.startsWith('en-') || clean.startsWith('en_')) return 'en';
    return cleanFallback;
}

function resolveRequestUiLang({ settings = null, req = null, explicitLang = null, hasSavedSettings = true } = {}) {
    if (isValidStrictUiLang(explicitLang)) {
        return normalizeUiLang(explicitLang);
    }
    if (req && req.query && isValidStrictUiLang(req.query.lang)) {
        return normalizeUiLang(req.query.lang);
    }
    if (hasSavedSettings !== false && settings && isValidStrictUiLang(settings.uiLanguage)) {
        return normalizeUiLang(settings.uiLanguage);
    }
    const headerLang = req && req.headers ? (req.headers['x-ui-lang'] || req.headers['X-UI-Lang']) : null;
    if (isValidStrictUiLang(headerLang)) {
        return normalizeUiLang(headerLang);
    }
    if (settings && isValidStrictUiLang(settings.uiLanguage)) {
        return normalizeUiLang(settings.uiLanguage);
    }
    return 'en';
}

const DICTIONARIES = {
    en: {
        // --- Push & Tray Actions ---
        'action.ok': 'OK',
        'action.mark_done': 'Mark done',
        'action.snooze_15m': 'Snooze 15m',
        'action.snooze_30m': 'Snooze 30m',
        'action.snooze_1h': 'Snooze 1h',
        'action.skip': 'Skip',
        'action.dismiss': 'Dismiss',
        'action.ok_dismiss': 'OK / Dismiss',
        'action.open_app': 'Open App',
        'action.open_agenda': 'Open Agenda',
        'action.open_schedule': 'Open Schedule',
        'action.open_journal': 'Open Journal',
        'action.open_english': 'Open Language Studio',
        'action.log_mood': 'Log Mood',
        'action.log_sleep': 'Log Sleep',
        'action.update_gps': 'Update GPS',
        'action.maps_route': 'Google Maps Route',

        // --- Category Labels ---
        'category.mood': 'Mood',
        'category.sleep': 'Sleep',
        'category.agenda': 'Agenda',
        'category.class': 'Class',
        'category.residencias': 'Internships',
        'category.work': 'Work',
        'category.word': 'Journal',
        'category.english': 'Languages',
        'category.test': 'Test',
        'category.general': 'Reminder',

        // --- Mood Windows & Reminders ---
        'mood.moment.Morning': 'Morning',
        'mood.moment.Noon': 'Noon',
        'mood.moment.Afternoon': 'Afternoon',
        'mood.moment.Night': 'Night',
        'mood.moment.Madrugada': 'Late Night',
        'mood.mid_title': 'Mood Check-in ({moment})',
        'mood.mid_message': 'Mid-{momentLower} check-in: log how you feel right now in Daily Hub.',
        'mood.pending_title': 'Pending Mood Check-in ({moments})',
        'mood.pending_message': 'You still have unlogged mood block(s) for today ({moments}). Tap to record your mood in Daily Hub.',

        // --- Sleep Reminders ---
        'sleep.wakeup_title': 'Finish Morning Sleep Log',
        'sleep.wakeup_desvelo_message': 'You logged bedtime at {bedtime} (Desvelo). Tap to record when you woke up.',
        'sleep.wakeup_normal_message': 'You logged bedtime at {bedtime}. Tap to record when you woke up.',
        'sleep.morning_title': 'Morning Sleep Log',
        'sleep.morning_message': 'Remember to log last night’s bedtime, wake-up time, and rest quality. You can snooze if needed.',

        // --- Agenda Reminders & 1h In-Progress Follow-up ---
        'agenda.cat.universidad': 'University',
        'agenda.cat.personal': 'Personal',
        'agenda.type.task': 'Task',
        'agenda.type.pending_task': 'Pending Task',
        'agenda.type.event': 'Event',
        'agenda.item_title': '[{category} {typeLabel}] {time}',
        'agenda.starts_at_suffix': ' (starts at {time})',
        'agenda.overdue_suffix': ' — Pending completion',
        'agenda.pending_title': '[Pending {category} Task] {when}',
        'agenda.pending_message': '{activity} (To Do — tap Mark done when finished)',
        'agenda.in_progress_title': '⏳ 1 hour in progress: {activity}',
        'agenda.in_progress_message': '⏳ 1 hour in progress: {activity}. Have you finished it or need to snooze it?',
        'agenda.default_task_name': 'Task',

        // --- Commute & ITS Class / Internships / Work ---
        'commute.origin_room': 'Room {room} ({campus})',
        'commute.origin_gps': 'your live GPS location',
        'commute.origin_home': 'your Home',
        'commute.origin_campus': 'ITS Campus',
        'commute.origin_generic': 'your location',
        'commute.route_near': 'On campus / nearby (~{walkMin} min walk from {origin})',
        'commute.route_drive': 'From {origin}: ~{driveMin} min drive ({traffic}, {distanceKm} km)',
        'commute.class_title': '[ITS Class {time}] {course} · Room {room}',
        'commute.class_message': '{campus} ({plano} · {building}). {route}. Alert {stageMin} min before.',
        'commute.residencias_default_place': 'Professional Internships',
        'commute.residencias_title': '[Internships {time}] {place}',
        'commute.residencias_remote': 'Remote mode — get ready to sign in.',
        'commute.residencias_near': 'Near {place} (~{walkMin} min walk). Alert {stageMin} min before.',
        'commute.residencias_drive': 'Car commute: ~{driveMin} min ({traffic}) to {place}. Alert {stageMin} min before.',
        'commute.work_default_place': 'Work',
        'commute.work_shift_full': 'Full-Time',
        'commute.work_shift_part': 'Part-Time',
        'commute.work_shift_rot': 'Shift',
        'commute.work_title': '[Work {shiftType} {time}] {company}',
        'commute.work_remote': 'Remote shift starting soon.',
        'commute.work_near': 'Near {company} (~{walkMin} min walk). Alert {stageMin} min before.',
        'commute.work_drive': 'Drive route: ~{driveMin} min ({traffic}) to {company}. Alert {stageMin} min before.',

        // --- End-of-Day Word Notes & Language Study ---
        'word.eod_title': 'End-of-Day Word Notes Check',
        'word.eod_pending_message': 'You have {journalCount} Journal and {englishCount} Language note(s) waiting for PC Word sync.',
        'word.eod_clear_message': 'End-of-day check: verify your Journal and Language Word documents or add any final notes before bed.',
        'english.study_title': 'Language Study Session',
        'english.default_topic': 'Practice vocabulary, grammar notes, and phrasal verbs.',

        // --- Test Push & Phone GPS Request ---
        'test_push.title': 'Personal Daily Hub - Phone Connected',
        'test_push.message': 'Test alert delivered! Reminders for Mood, Sleep, Agenda, Word Notes, and Language Study will appear here.',
        'test_push.sent_response': 'Test notification sent to your phone notification channel.',
        'gps_ping.title': '📍 Send Your Phone GPS to Daily Hub',
        'gps_ping.message': 'Tap to capture your OPPO A79 location (or paste a Maps link) and update campus commute times.',
        'gps_ping.sent_response': 'GPS request sent to your phone via ntfy! Tap the notification on your phone to send its location.',

        // --- Settings & Reminder Action Responses ---
        'error.invalid_ui_language': 'Interface language must be "en" or "es".',
        'response.settings_saved': 'Settings saved successfully.',
        'response.lang_saved': 'Interface language updated.',
        'reminder.default_title': 'Reminder',
        'reminder.ack_success': 'Got it (OK). No more alerts will be sent for this class/shift today.',
        'reminder.skipped': 'Reminder skipped.',
        'reminder.dismissed': 'Reminder dismissed.',
        'reminder.postponed': 'Reminder postponed for {minutes} minutes.',
        'reminder.postponed_short': 'Postponed for {minutes} minutes.',
        'reminder.complete_agenda': 'Agenda item marked as Done.',
        'reminder.test_skipped': 'Test notification skipped.',
        'reminder.test_snoozed': 'Test notification snoozed for {minutes} minutes.',
        'reminder.invalid_token': 'Invalid or expired reminder action token.',
        'reminder.invalid_key': 'Invalid reminder key.',
        'reminder.unauthorized': 'Account not authorized for this action.',
        'reminder.action_error': 'Error applying reminder action.',
        'reminder.state_error': 'Error updating reminder state.'
    },
    es: {
        // --- Acciones Push y Bandeja ---
        'action.ok': 'OK',
        'action.mark_done': 'Marcar hecha',
        'action.snooze_15m': 'Posponer 15m',
        'action.snooze_30m': 'Posponer 30m',
        'action.snooze_1h': 'Posponer 1h',
        'action.skip': 'Omitir',
        'action.dismiss': 'Ocultar',
        'action.ok_dismiss': 'OK / Ocultar',
        'action.open_app': 'Abrir App',
        'action.open_agenda': 'Abrir Agenda',
        'action.open_schedule': 'Abrir Horario',
        'action.open_journal': 'Abrir Diario',
        'action.open_english': 'Abrir Idiomas',
        'action.log_mood': 'Registrar Ánimo',
        'action.log_sleep': 'Registrar Sueño',
        'action.update_gps': 'Actualizar GPS',
        'action.maps_route': 'Ruta Google Maps',

        // --- Categorías ---
        'category.mood': 'Ánimo',
        'category.sleep': 'Sueño',
        'category.agenda': 'Agenda',
        'category.class': 'Clase',
        'category.residencias': 'Residencias',
        'category.work': 'Trabajo',
        'category.word': 'Diario',
        'category.english': 'Idiomas',
        'category.test': 'Prueba',
        'category.general': 'Aviso',

        // --- Estado de Ánimo ---
        'mood.moment.Morning': 'Mañana',
        'mood.moment.Noon': 'Mediodía',
        'mood.moment.Afternoon': 'Tarde',
        'mood.moment.Night': 'Noche',
        'mood.moment.Madrugada': 'Madrugada',
        'mood.mid_title': 'Registro de Ánimo ({moment})',
        'mood.mid_message': 'Recordatorio de {momentLower}: registra cómo te sientes ahora en Daily Hub.',
        'mood.pending_title': 'Ánimo pendiente por registrar ({moments})',
        'mood.pending_message': 'Aún tienes bloque(s) sin registrar hoy ({moments}). Toca aquí para registrar tu ánimo en Daily Hub.',

        // --- Control de Sueño ---
        'sleep.wakeup_title': 'Completar Registro Matutino de Sueño',
        'sleep.wakeup_desvelo_message': 'Registraste tu hora de dormir a las {bedtime} (Desvelo). Toca para registrar a qué hora despertaste.',
        'sleep.wakeup_normal_message': 'Registraste tu hora de dormir a las {bedtime}. Toca para registrar a qué hora despertaste.',
        'sleep.morning_title': 'Registro Matutino de Sueño',
        'sleep.morning_message': 'Recuerda registrar a qué hora te dormiste anoche, cuándo despertaste y la calidad de tu descanso.',

        // --- Agenda y Seguimiento de 1h En Progreso ---
        'agenda.cat.universidad': 'Universidad',
        'agenda.cat.personal': 'Personal',
        'agenda.type.task': 'Tarea',
        'agenda.type.pending_task': 'Tarea Pendiente',
        'agenda.type.event': 'Evento',
        'agenda.item_title': '[{category} · {typeLabel}] {time}',
        'agenda.starts_at_suffix': ' (inicia a las {time})',
        'agenda.overdue_suffix': ' — Pendiente por completar',
        'agenda.pending_title': '[Tarea Pendiente · {category}] {when}',
        'agenda.pending_message': '{activity} (Por hacer — toca Marcar hecha al terminar)',
        'agenda.in_progress_title': '⏳ Llevas 1 hora en progreso: {activity}',
        'agenda.in_progress_message': '⏳ Llevas 1 hora en progreso: {activity}. ¿Ya la terminaste o necesitas posponerla?',
        'agenda.default_task_name': 'Tarea',

        // --- Traslado Inteligente, Clases ITS, Residencias y Trabajo ---
        'commute.origin_room': 'Aula {room} ({campus})',
        'commute.origin_gps': 'tu ubicación GPS actual',
        'commute.origin_home': 'tu Casa',
        'commute.origin_campus': 'Campus ITS',
        'commute.origin_generic': 'tu ubicación',
        'commute.route_near': 'En el Tec / cerca (~{walkMin} min caminando desde {origin})',
        'commute.route_drive': 'Desde {origin}: ~{driveMin} min en carro ({traffic}, {distanceKm} km)',
        'commute.class_title': '[Clase ITS {time}] {course} · Aula {room}',
        'commute.class_message': '{campus} ({plano} · {building}). {route}. Aviso {stageMin} min antes.',
        'commute.residencias_default_place': 'Residencias Profesionales',
        'commute.residencias_title': '[Residencias {time}] {place}',
        'commute.residencias_remote': 'Modalidad remota — prepárate para iniciar sesión.',
        'commute.residencias_near': 'Cerca de {place} (~{walkMin} min caminando). Aviso {stageMin} min antes.',
        'commute.residencias_drive': 'Traslado en carro: ~{driveMin} min ({traffic}) hacia {place}. Aviso {stageMin} min antes.',
        'commute.work_default_place': 'Trabajo',
        'commute.work_shift_full': 'Tiempo Completo',
        'commute.work_shift_part': 'Medio Tiempo',
        'commute.work_shift_rot': 'Por Turnos',
        'commute.work_title': '[Trabajo {shiftType} {time}] {company}',
        'commute.work_remote': 'Turno remoto por iniciar.',
        'commute.work_near': 'Cerca de {company} (~{walkMin} min caminando). Aviso {stageMin} min antes.',
        'commute.work_drive': 'Ruta en carro: ~{driveMin} min ({traffic}) hacia {company}. Aviso {stageMin} min antes.',

        // --- Revisión Word e Idiomas ---
        'word.eod_title': 'Revisión Nocturna de Notas Word',
        'word.eod_pending_message': 'Tienes {journalCount} nota(s) de Diario y {englishCount} de Idiomas pendientes de sincronizar en Word.',
        'word.eod_clear_message': 'Revisión nocturna: verifica tus documentos Word de Diario e Idiomas o agrega tus últimas notas antes de dormir.',
        'english.study_title': 'Sesión de Estudio de Idiomas',
        'english.default_topic': 'Practica vocabulario, notas de gramática y phrasal verbs.',

        // --- Push de Prueba y Petición GPS ---
        'test_push.title': 'Personal Daily Hub - Celular Conectado',
        'test_push.message': '¡Alerta de prueba entregada! Aquí aparecerán tus avisos de Ánimo, Sueño, Agenda, Diario e Idiomas.',
        'test_push.sent_response': 'Notificación de prueba enviada al canal de tu celular.',
        'gps_ping.title': '📍 Envía el GPS de tu Celular a Daily Hub',
        'gps_ping.message': 'Toca para capturar tu ubicación en OPPO A79 (o pega un enlace de Maps) y actualizar los traslados al campus.',
        'gps_ping.sent_response': '¡Solicitud GPS enviada a tu celular vía ntfy! Toca la notificación en tu teléfono para enviar su ubicación.',

        // --- Respuestas de Ajustes y Acciones de Recordatorio ---
        'error.invalid_ui_language': 'El idioma de la interfaz debe ser "en" o "es".',
        'response.settings_saved': 'Ajustes guardados correctamente.',
        'response.lang_saved': 'Idioma de la interfaz actualizado.',
        'reminder.default_title': 'Recordatorio',
        'reminder.ack_success': 'Entendido (OK). No se enviarán más avisos para esta clase/turno hoy.',
        'reminder.skipped': 'Recordatorio omitido.',
        'reminder.dismissed': 'Recordatorio ocultado.',
        'reminder.postponed': 'Recordatorio pospuesto por {minutes} minutos.',
        'reminder.postponed_short': 'Pospuesto por {minutes} minutos.',
        'reminder.complete_agenda': 'Actividad marcada como Completada.',
        'reminder.test_skipped': 'Notificación de prueba omitida.',
        'reminder.test_snoozed': 'Notificación de prueba pospuesta {minutes} minutos.',
        'reminder.invalid_token': 'Token de acción de recordatorio inválido o expirado.',
        'reminder.invalid_key': 'Clave de recordatorio inválida.',
        'reminder.unauthorized': 'Cuenta no autorizada para esta acción.',
        'reminder.action_error': 'Error al aplicar la acción del recordatorio.',
        'reminder.state_error': 'Error al actualizar el estado del recordatorio.'
    }
};

function tServer(lang, key, vars = {}) {
    const cleanLang = normalizeUiLang(lang, 'en');
    const dict = DICTIONARIES[cleanLang] || DICTIONARIES.en;
    const rawTemplate = Object.prototype.hasOwnProperty.call(dict, key)
        ? dict[key]
        : (Object.prototype.hasOwnProperty.call(DICTIONARIES.en, key) ? DICTIONARIES.en[key] : String(key || ''));
    return String(rawTemplate).replace(/\{([a-zA-Z0-9_]+)\}/g, (_, token) => {
        if (vars && Object.prototype.hasOwnProperty.call(vars, token) && vars[token] !== undefined && vars[token] !== null) {
            return String(vars[token]);
        }
        return '';
    });
}

function getReminderCategoryLabel(lang, type) {
    const cleanType = String(type || 'general').trim().toLowerCase();
    const mapKey = Object.prototype.hasOwnProperty.call(DICTIONARIES.en, `category.${cleanType}`)
        ? `category.${cleanType}`
        : 'category.general';
    return tServer(lang, mapKey);
}

const TRAFFIC_LABEL_MAP = {
    low: { en: 'Light traffic', es: 'Tráfico ligero' },
    'tráfico ligero': { en: 'Light traffic', es: 'Tráfico ligero' },
    high: { en: 'Rush-hour traffic', es: 'Tráfico hora pico' },
    'tráfico hora pico': { en: 'Rush-hour traffic', es: 'Tráfico hora pico' },
    moderate: { en: 'Moderate traffic', es: 'Tráfico moderado' },
    'tráfico moderado': { en: 'Moderate traffic', es: 'Tráfico moderado' },
    'tráfico fluido': { en: 'Smooth traffic', es: 'Tráfico fluido' },
    'ruta estándar': { en: 'Standard route', es: 'Ruta estándar' },
    'en campus / cerca': { en: 'On campus / nearby', es: 'En campus / cerca' },
    'estimado desde casa (sin gps activo)': { en: 'Estimated from home (no live GPS)', es: 'Estimado desde casa (sin GPS activo)' }
};

function localizeTrafficLabel(lang, levelOrLabel) {
    const uiLang = normalizeUiLang(lang, 'en');
    const raw = String(levelOrLabel || '').trim();
    const hit = TRAFFIC_LABEL_MAP[raw.toLowerCase()];
    if (hit) return hit[uiLang];
    return raw || (uiLang === 'es' ? 'Tráfico moderado' : 'Moderate traffic');
}

const DEFAULT_ORIGIN_LABELS = {
    'tu ubicación gps actual': { en: 'your live GPS location', es: 'tu ubicación GPS actual' },
    'your live gps location': { en: 'your live GPS location', es: 'tu ubicación GPS actual' },
    'ubicación actual': { en: 'current location', es: 'Ubicación actual' },
    'current location': { en: 'current location', es: 'Ubicación actual' },
    'tu casa': { en: 'your Home', es: 'tu Casa' },
    'your home': { en: 'your Home', es: 'tu Casa' },
    'mi casa': { en: 'My Home', es: 'Mi Casa' },
    'my home': { en: 'My Home', es: 'Mi Casa' },
    'campus its': { en: 'ITS Campus', es: 'Campus ITS' },
    'its campus': { en: 'ITS Campus', es: 'Campus ITS' },
    'tu ubicación': { en: 'your location', es: 'tu ubicación' },
    'your location': { en: 'your location', es: 'tu ubicación' },
    'teléfono gps (http webhook)': { en: 'Phone GPS (HTTP Webhook)', es: 'Teléfono GPS (HTTP Webhook)' },
    'phone/browser gps': { en: 'Phone/Browser GPS', es: 'GPS del Celular/Navegador' }
};

function localizeOriginLabel(lang, rawLabel) {
    const uiLang = normalizeUiLang(lang, 'en');
    const raw = String(rawLabel || '').trim();
    const hit = DEFAULT_ORIGIN_LABELS[raw.toLowerCase()];
    return hit ? hit[uiLang] : raw;
}

function localizeItsBuildingLabel(lang, rawBuilding) {
    const uiLang = normalizeUiLang(lang, 'en');
    const raw = String(rawBuilding || '').trim();
    if (!raw || uiLang === 'es') return raw;
    if (raw === 'Salón personalizado') return 'Custom classroom';
    let out = raw
        .replace(/^Edif\.\s*(\d+)\s*Sistemas y Computación/i, 'Bldg. $1 Systems & Computing')
        .replace(/^Edif\.\s*(\d+)\s*Ingeniería Mecatrónica/i, 'Bldg. $1 Mechatronics Eng.')
        .replace(/^Edif\.\s*(\d+)\s*Educación a Distancia/i, 'Bldg. $1 Distance Education')
        .replace(/^Edif\.\s*(\d+)\s*Gestión Tecnológica y Vinculación/i, 'Bldg. $1 Tech Management & Outreach')
        .replace(/^Edif\.\s*([\d-]+)\b/i, 'Bldg. $1')
        .replace(/Laboratorios y Aulas Especializadas Campus Miravalle/i, 'Miravalle Campus Specialized Labs & Classrooms')
        .replace(/Campus Principal ITS/i, 'ITS Main Campus')
        .replace(/\bAulas\b/g, 'Rooms')
        .replace(/\bPiso\s+(\d+)/gi, 'Floor $1')
        .replace(/\b(\w+-\d+)\s+a\s+(\w+-\d+)\b/gi, '$1 to $2');
    return out;
}

module.exports = {
    SUPPORTED_UI_LANGS,
    DICTIONARIES,
    isValidStrictUiLang,
    normalizeUiLang,
    resolveRequestUiLang,
    tServer,
    getReminderCategoryLabel,
    localizeTrafficLabel,
    localizeOriginLabel,
    localizeItsBuildingLabel
};

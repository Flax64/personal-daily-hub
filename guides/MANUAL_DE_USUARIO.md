# 📖 Manual de Usuario — Personal Daily Hub

> **Guía rápida operativa (en modo oscuro permanente).** Tus datos viajan bajo HTTPS + túnel cifrado (`X25519 + AES-256-CTR`), las entradas del Diario usan cifrado `pdh-j2` con salt, y el estado entre PC y celular se sincroniza en tiempo real mediante **SSE**.

---

## 📑 Índice

1. [Inicio Rápido, Sincronización en Tiempo Real y Navegación](#1-inicio-rápido-sincronización-en-tiempo-real-y-navegación)
2. [Registros Diarios (Ánimo, Sueño/Siestas y Crisis)](#2-registros-diarios-ánimo-sueñosiestas-y-crisis)
3. [Diario Personal E2EE, Descarga Word Cifrada y Estudio de Idiomas](#3-diario-personal-e2ee-descarga-word-cifrada-y-estudio-de-idiomas)
4. [Agenda Semanal, Horario ITS, CRUD Campus/Salones y Alertas Maps](#4-agenda-semanal-horario-its-crud-campussalones-y-alertas-maps)
5. [Resumen Semanal (Lunes–Domingo), Vista Médica y Drive en RAM](#5-resumen-semanal-lunesdomingo-vista-médica-y-drive-en-ram)
6. [Ajustes (`Settings`), Notificaciones `ntfy` (`OK`) y Atajos](#6-ajustes-settings-notificaciones-ntfy-ok-y-atajos)

---

## 1. Inicio Rápido, Sincronización en Tiempo Real y Navegación

| Rol | Qué puede hacer | Caducidad de sesión |
| :--- | :--- | :--- |
| **Propietario (`admin`)** | Control total de todos los módulos, Word, Planner, IA y Ajustes. | Automática cada **Domingo 00:00**. |
| **Psiquiatra / Médico** | **Solo lectura** en `📈 Resumen Semanal` (Ánimo, Sueño/Desvelos y Crisis). | Automática cada **Domingo 00:00**. |

* **Sync en tiempo real (PC ↔ Celular):** Los cambios que guardes en un dispositivo (incluyendo idioma `EN`/`ES`) se reflejan automáticamente en tus sesiones abiertas vía **SSE** (`SyncRevisions`). Si la pestaña pasa a segundo plano, pausa la conexión para ahorrar batería y re-sincroniza al regresar.
* **Idioma EN / ES 100% sincronizado:** Cambia al instante entre Inglés y Español con `🌐 EN / ES` (cabecera o barra lateral) o en `#view-settings`; el idioma elegido se guarda en el servidor para traducir también `#reminderTray` y las notificaciones push `ntfy`.
* **Navegación fluida en móvil y PC:**
  * Desliza con el dedo hacia la izquierda sobre el menú lateral para cerrarlo (*swipe-to-close*).
  * El botón **Atrás** del navegador/celular navega entre vistas (`history.pushState`) y recargar la página regresa siempre limpio a **Inicio**.
  * Los modales y el traductor flotante bloquean el scroll del fondo automáticamente.
* **Pestaña única y límite de sesiones:** Máximo **3 sesiones activas** por cuenta; si abres una segunda pestaña en el mismo navegador, puedes transferir el control en 1 clic (**`Usar aquí`**).

---

## 2. Registros Diarios (Ánimo, Sueño/Siestas y Crisis)

### 🧠 Mood Tracker (`#view-mood`)
1. Elige **Fecha** y **Bloque del día** (*Madrugada 00:00–05:59, Morning, Noon, Afternoon, Night*).
2. Toca tu **Emoción** (16 opciones con color) y pulsa **Guardar**.

### 🌙 Sueño Nocturno, Siestas y Desvelo (`#view-sueno`)
* **🛌 Sueño nocturno (con despertar pendiente):** Al irte a dormir puedes registrar solo la hora de acostarte dejando pendiente la hora de despertar; al despertar, edita ese registro en un toque para calcular automáticamente las horas dormidas.
* **😴 Siesta (`siesta`):** Registra siestas diurnas aparte sin sobrescribir ni alterar la clasificación de tu sueño nocturno.
* **🦉 Desvelo automático y total:** Si duermes menos del mínimo configurado (`< 7h` por defecto) o te acuestas de madrugada (`>= 01:00`), se marca como **desvelo** (`desvelo_tarde`), o puedes registrar **Desvelo Total (`0 hrs`)** con motivo opcional.

### ⚠️ Bitácora de Crisis (`#view-crisis`)
1. Pulsa `⏱️ Now` para capturar fecha y hora actual (`HH:MM`).
2. Elige el **Tipo de episodio** e **Intensidad (`1` a `5`)**. Si eliges `📝 Otro`, escribe tu categoría libre: se guardará limpia **sin corchetes** alrededor del texto.
3. Escribe el detonante en español (**máx. 250 caracteres**) y presiona `Ctrl + Enter`.

---

## 3. Diario Personal E2EE, Descarga Word Cifrada y Estudio de Idiomas

### 🖋️ Diario E2EE (`#view-journal`) y Descarga Segura en `.docx`
* **Privacidad estricta:** Tu diario nunca se guarda en MySQL ni se sube a Google Drive; reside cifrado en `Diario.docx` (`WORD_PASSWORD`).
* **Guardar entrada:** Pulsa `🔑 E2EE Key` (llave de 32 caracteres) la primera vez, redacta tu nota y envíala cifrada con salto criptográfico `pdh-j2`.
* **⬇️ Descargar Word del Diario (Cifrado E2EE en Tránsito):**
  1. Presiona **Descargar Word** dentro de **Notas de Diario (`#view-journal`)**.
  2. Si ya configuraste una **contraseña propia de descarga (8–128 caracteres)** en `⚙️ Settings`, la descarga inicia de inmediato; de lo contrario, ingrésala en el modal que aparece.
  3. El servidor descifra en RAM, re-cifra los bytes en tránsito (`pdh-j2`) y tu navegador descifra el archivo en tu propio dispositivo entregando un `Diario.docx` normal listo para abrir en Microsoft Word (PC o celular). *(También sigue disponible la descarga del `.docx` OLE2 en crudo).*

### 📖 Language Studio y Visor Simplificado (`#view-english`)
* **Idiomas:** `🇺🇸 Inglés (EN → ES)`, `🇰🇷 Coreano (KO → EN)` con Romanización Hangul automática y `🎵 K-Pop (EN + KR)`.
* **Visor del Cuaderno Simplificado:** Consulta rápidamente `English_Learning_Notebook.docx` usando únicamente el **selector de sección**, el **buscador de texto** y el botón de actualización (ícono circular), sin filtros redundantes.
* **🌐 Traductor Flotante (`Alt + T`) y Ventana Independiente (`/translator-popup.html`):** Arrastra la barra superior (`⋮⋮`) a cualquier parte de la pantalla o ábrelo en ventana aparte.
* **🎵 Learn with Music:** Navegación por carpetas estilo Windows 11 (`Artista → Álbum → Canción`), visor de letras por idioma en solo lectura y extracción/respaldo sin saturar la base de datos.

---

## 4. Agenda Semanal, Horario ITS, CRUD Campus/Salones y Alertas Maps

### 🗓️ Agenda Semanal (`#view-agenda`)
* Crea **Eventos** o **Tareas** divididos en **🎓 Universidad** y **👤 Personal** con flujo tipo Jira (**To Do**, **In Progress**, **Done**, **Skipped**), tareas repetitivas (`🔁 Repetir cada X días`) y recordatorios anticipados.
* **Arrastre desde toda la tarjeta:** En PC arrastra cualquier tarjeta desde su título, cuerpo, fondo o agarre `⋮⋮` (los botones `✓`, `⏳`, `⏭`, `✏`, `🗑` y el selector de estado siguen clicables normalmente); en móvil/tablet usa `⋮⋮` de inmediato o mantén presionada `220 ms` cualquier zona libre de la tarjeta sin bloquear el scroll.
* **Tareas «En progreso» silenciosas por 1 hora:** Al pasar una tarea a *En progreso*, se silencian avisos normales y solo recibirás 1 seguimiento al cumplirse 1 hora.

### 🎓 Horario ITS, Materias (Pausa/Promedio) y Alertas Maps (`#view-horario` + `#view-settings`)
* **Gestión manual de Campus y Materias:** Administra tus **campus y salones** desde la guía de clases/croquis, pausa o reanuda avisos individuales por materia (`🔕 Pausar avisos` / `🔔 Reanudar avisos`), marca materias completadas y captura su calificación final (`0–100`) para ver automáticamente el **Promedio del semestre**.
* **Alertas inteligentes por zona GPS (configurables en `#view-settings`):**
  * **En Casa o Lejos:** avisa desde `tiempo en auto + 30 min` y repite cada `5 min` hasta presionar `OK` o iniciar la clase/turno.
  * **Cerca del campus (radio `<= 0.5 km`):** recuerda en `20, 15, 10` min antes del inicio.
* **Confirmación rápida (`OK`):** Tocar **`OK`** en `ntfy` o en `#reminderTray` silencia avisos restantes de esa clase/turno hoy y reemplaza alertas previas equivalentes.

---

## 5. Resumen Semanal (Lunes–Domingo), Vista Médica y Drive en RAM

* **Semana fija Lunes–Domingo (`#view-resumen`):** Selecciona cualquier fecha en el calendario o navega con `◀ Semana Ant.` / `Semana Sig. ▶` para visualizar siempre el bloque exacto de **Lunes a Domingo**.
* **Consulta histórica Drive en RAM:** Si archivaste historial en Google Drive, selecciona el rango (`3`, `6` o `12` meses) para combinar temporalmente en memoria RAM `historico_completo.json.gz` con tu base local MySQL (la cual conserva por defecto historial ilimitado cuando `DB_RETENTION_DAYS=0`).

---

## 6. Ajustes (`Settings`), Notificaciones `ntfy` (`OK`) y Atajos

* **Bloqueo anti-autofill:** Todos los campos de llaves/contraseñas sensibles en **Settings** bloquean el autocompletado del navegador para evitar que gestores de contraseñas sobreescriban tus claves.
* **Contraseña de descarga del Diario:** Configura, reemplaza o limpia tu contraseña propia (8–128 chars) para descargas E2EE de `Diario.docx` desde **Settings** (nunca regresa visible en respuestas del servidor).
* **Push móvil con `ntfy`:** Genera tu tópico privado en **Settings**, suscríbete en la app **ntfy** (Android/iOS) y usa las acciones **`Open App`**, **`Snooze 15m`**, **`Snooze 30m`** o **`OK`** directamente desde la barra de notificaciones.

| Atajo | Acción rápida |
| :--- | :--- |
| `Alt + T` | Abrir / cerrar el **Traductor Flotante**. |
| `Ctrl + Enter` | Guardar al instante en **Crisis**, **Desvelo** o **Análisis de Letras IA**. |
| `Enter` | Enviar consulta al Tutor IA (`Shift + Enter` = nueva línea). |
| `Esc` | Cerrar cualquier modal, menú lateral o traductor abierto. |

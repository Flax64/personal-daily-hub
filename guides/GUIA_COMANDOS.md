# 🛠️ Guía Completa de Comandos Operativos — Personal Daily Hub

> Manual técnico-operativo detallado por entorno (**Git Bash en Windows** y **Linux / Ubuntu Server 8 GB RAM**). Cada comando incluye su propósito, cuándo utilizarlo y una tabla exacta con sus parámetros y banderas.

---

## 📑 Índice

1. [Entorno 1: Git Bash (Windows / Desarrollo Local)](#entorno-1-git-bash-windows--desarrollo-local)
   - [1.1 Git, ramas, tags SemVer y flujo diario](#11-git-ramas-tags-semver-y-flujo-diario)
   - [1.2 Pruebas automatizadas y validación de sintaxis](#12-pruebas-automatizadas-y-validación-de-sintaxis)
   - [1.3 Bóveda local (`.env` ↔ `.env.enc`) y Windows DPAPI](#13-bóveda-local-env--envenc-y-windows-dpapi)
   - [1.4 Sincronizador Word en PC (`sincronitation/`) y `WINWORD.EXE`](#14-sincronizador-word-en-pc-sincronitation-y-winwordexe)
2. [Entorno 2: Linux / Ubuntu Server (SSH / WSL / Producción)](#entorno-2-linux--ubuntu-server-ssh--wsl--producción)
   - [2.1 Arquitectura Blue-Green, Docker Compose y Caddy](#21-arquitectura-blue-green-docker-compose-y-caddy)
   - [2.2 Diagnóstico del servidor (RAM, Swap, Disco, Puertos y Salud)](#22-diagnóstico-del-servidor-ram-swap-disco-puertos-y-salud)
   - [2.3 Tailscale y Red Privada (HTTPS Serve sin colisiones)](#23-tailscale-y-red-privada-https-serve-sin-colisiones)
   - [2.4 Base de datos MySQL y Respaldos Dual Drive (`rclone`)](#24-base-de-datos-mysql-y-respaldos-dual-drive-rclone)
   - [2.5 Seguridad del host (`ufw`, `systemd`, `fail2ban`, `auditd`, `env-vault.sh`)](#25-seguridad-del-host-ufw-systemd-fail2ban-auditd-env-vaultsh)

---

## Entorno 1: Git Bash (Windows / Desarrollo Local)

### ⚡ Inicio Rápido (1ª página): Reinicio de `sincronizador.py` y Autoinicio DPAPI

```bash
# Reiniciar sincronizador Word en segundo plano (detiene instancia previa con Stop-Process y relanza oculto)
powershell.exe -NoProfile -Command 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*sincronizador.py*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Start-Process -FilePath pythonw.exe -WorkingDirectory (Get-Location).Path -ArgumentList "sincronitation\sincronizador.py" -WindowStyle Hidden'

# Configurar o comprobar autoinicio Windows DPAPI sin .env plano en disco
python sincronitation/sincronizador.py --configurar-autoinicio
python sincronitation/sincronizador.py --probar-autoinicio
```

### 1.1 Git, ramas, tags SemVer y flujo diario

#### Inspección de estado e historial (`git status`, `git log`, `git tag`)
* **Qué hace:** Muestra archivos modificados/no rastreados, rama actual, historial resumido de commits y etiquetas SemVer 2.0.0 (`vX.Y.Z`) generadas automáticamente en despliegues.
* **Cuándo usarlo:** Antes de empezar cambios, antes de hacer `commit` o al auditar qué versión está desplegada para preparar un rollback.

```bash
git status -sb
git log --oneline -n 20
git tag -l "v*" --sort=-v:refname
```

| Parámetro / Bandera | Para qué sirve |
| :--- | :--- |
| `-sb` (`--short --branch`) | Resume en 1 línea la rama actual, su diferencia contra `origin` y el estado compacto de archivos. |
| `--oneline` | Muestra cada commit en una sola línea (hash corto + título). |
| `-n 20` | Limita la salida a los últimos 20 commits. |
| `-l "v*"` | Filtra etiquetas que inicien con `v` (releases SemVer del proyecto). |
| `--sort=-v:refname` | Ordena las versiones numéricamente de la más reciente a la más antigua (`v1.17.0` antes que `v1.9.0`). |

#### Cambio y creación de ramas (`git switch`, `git checkout -b`, `git fetch --prune`, `git pull`)
* **Qué hace:** Sincroniza referencias remotas limpiando ramas ya borradas en GitHub, actualiza `main` o abre una nueva rama de trabajo sin tocar `main` protegida.
* **Cuándo usarlo:** Al iniciar una nueva funcionalidad o corrección, y tras fusionar un Pull Request en GitHub.

```bash
git fetch --prune origin
git switch main
git pull --ff-only origin main
git checkout -b feat/mi-nueva-mejora
```

| Parámetro / Bandera | Para qué sirve |
| :--- | :--- |
| `fetch --prune origin` | Descarga referencias del remoto `origin` y elimina referencias locales obsoletas (`origin/...`) de ramas ya cerradas. |
| `switch main` | Cambia de forma segura a la rama local `main`. |
| `pull --ff-only origin main` | Actualiza `main` únicamente por *fast-forward*, evitando commits de mezcla accidentales. |
| `checkout -b <rama>` | Crea la rama `<rama>` desde el HEAD actual y cambia a ella en un solo paso. |

#### Commits desglosados y publicación (`git commit`, `git push`)
* **Qué hace:** Registra cambios siguiendo **Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:`) con título y cuerpo desglosado para que [`scripts/release-version.js`](../scripts/release-version.js) calcule correctamente el siguiente incremento SemVer (`MINOR` o `PATCH`), y sube la rama al remoto.
* **Cuándo usarlo:** Al finalizar un bloque lógico de código o documentación listo para PR hacia `main`.

```bash
git add README.md guides/GUIA_COMANDOS.md
git commit -m "docs: actualizar guías operativas y arquitectura Blue-Green" \
           -m "- Detalla comandos por entorno y tablas de parámetros" \
           -m "- Actualiza diagrama Blue-Green, SSE y descarga cifrada"
git push -u origin feat/mi-nueva-mejora
```

| Parámetro / Bandera | Para qué sirve |
| :--- | :--- |
| `-m "<título>"` | Primer `-m` define el asunto del commit; `feat:` incrementa `MINOR`, `fix:`/`docs:`/`chore:` incrementan `PATCH`. |
| `-m "<cuerpo>"` | Cada `-m` adicional añade un párrafo separado debajo del título para desglosar los cambios. |
| `-u` (`--set-upstream`) | Asocia tu rama local con la rama homóloga en `origin` para futuros `git push` / `git pull`. |

#### Limpieza masiva de ramas locales sobrantes (conservando `main` y la rama actual)
* **Qué hace:** Lista todas las ramas locales, excluye la rama activa (`*`) y `main`, y elimina las ramas ya fusionadas (o todas si usas `-D`).
* **Cuándo usarlo:** Después de fusionar varios Pull Requests y querer dejar limpio tu repositorio local.

```bash
# Limpieza segura (solo elimina ramas ya fusionadas en main/HEAD)
git branch | grep -vE '^\*|(\s+main$)' | xargs -r git branch -d

# Limpieza forzada (elimina ramas no fusionadas excepto main y la actual)
git branch | grep -vE '^\*|(\s+main$)' | xargs -r git branch -D
```

| Parámetro / Bandera | Para qué sirve |
| :--- | :--- |
| `grep -vE` | Invierte coincidencia (`-v`) usando regex extendida (`-E`) para excluir la rama activa (`*`) y `main`. |
| `xargs -r` | Ejecuta el comando siguiente únicamente si hay ramas en la entrada (`--no-run-if-empty`). |
| `git branch -d` | Borra ramas solo si sus commits ya están integrados (modo seguro). |
| `git branch -D` | Fuerza el borrado de la rama local aunque no se haya fusionado (`--delete --force`). |

---

### 1.2 Pruebas automatizadas y validación de sintaxis

#### Suite completa de pruebas (`npm test` / `npm.cmd test`)
* **Qué hace:** Ejecuta `node --test tests/*.test.js`, validando rutas HTTP, RBAC, cifrado `X25519`/`pdh-j2`, lock distribuido, sintaxis SQL/HTML/CSS, y reglas de documentación sin requerir un MySQL vivo.
* **Cuándo usarlo:** Obligatoriamente antes de cada `commit` y antes de abrir Pull Request hacia `main`.

```bash
# En Git Bash:
npm test

# En Windows PowerShell (evita bloqueo de ExecutionPolicy sobre npm.ps1):
npm.cmd test
```

| Parámetro / Bandera | Para qué sirve |
| :--- | :--- |
| `--test` (`node --test`) | Ejecuta el corredor nativo de pruebas de Node.js 20 sin frameworks externos. |
| `--test-reporter=spec` | Muestra el desglose jerárquico prueba por prueba (útil al depurar un test puntual). |
| `npm.cmd` | Ejecuta el binario `.cmd` directo en PowerShell cuando `npm.ps1` está restringido por políticas de Windows. |

#### Verificación de sintaxis JS, Bash y simulación SemVer (`node --check`, `bash -n`, `release-version.js`)
* **Qué hace:** Comprueba que no existan errores de sintaxis en archivos JavaScript ni scripts Bash, y simula qué versión calcularía el auto-versionador según los commits desde el último tag.
* **Cuándo usarlo:** Tras editar código servidor, scripts `.sh` o mensajes de commit.

```bash
node --check server.js
node --check public/frontend.js
node --check lib/server-notes-service.js
bash -n scripts/*.sh
node scripts/release-version.js
```

| Parámetro / Bandera | Para qué sirve |
| :--- | :--- |
| `node --check <archivo>` | Valida la sintaxis JavaScript mediante el parser de V8 sin ejecutar el módulo. |
| `bash -n <script.sh>` | Lee y verifica la sintaxis Bash (`noexec`) sin ejecutar ninguna instrucción. |
| `release-version.js` *(sin flags)* | Modo simulación (*dry-run*): imprime versión actual, tipo de bump (`major`/`minor`/`patch`) y nueva versión sin editar archivos. |
| `--apply` *(en `release-version.js`)* | Aplica la nueva versión en `package.json`, `package-lock.json`, `version-history.json` y `CHANGELOG.md` (usado por `deploy.yml`). |

---

### 1.3 Bóveda local (`.env` ↔ `.env.enc`) y Windows DPAPI

> [!TIP]
> **Terminal interactiva en Git Bash (`mintty`):** Si ejecutas Git Bash clásico fuera de VS Code y el prompt oculto de contraseña no responde, antepón `winpty` (ejemplo: `winpty node scripts/local-vault.js decrypt`).

#### Gestión de secretos locales (`scripts/local-vault.js`)
* **Qué hace:** Cifra `.env` en `.env.enc` con **OpenSSL PBKDF2-HMAC-SHA256 (600,000 iteraciones) + AES-256-CBC** usando solo módulos nativos de Node.js, y sobrescribe `.env` con ceros antes de borrarlo.
* **Cuándo usarlo:** Para ver si tienes `.env` expuesto, editar variables localmente, re-sellar o ejecutar el servidor/scripts en RAM sin escribir `.env` en disco.

```bash
node scripts/local-vault.js status
node scripts/local-vault.js decrypt
node scripts/local-vault.js encrypt
node scripts/local-vault.js lock
node scripts/local-vault.js run node server.js
```

| Subcomando | Para qué sirve |
| :--- | :--- |
| `status` | Informa si `.env` plano existe (`EXPUESTO`) o si solo existe `.env.enc` (`SELLADO`). |
| `decrypt` | Pide tu contraseña maestra y recrea temporalmente `.env` en disco para editarlo. |
| `encrypt` | Pide y verifica contraseña, cifra `.env` → `.env.enc`, valida descifrado y destruye `.env` plano sobrescribiéndolo con ceros. |
| `lock` | Si solo consultaste `.env` sin editarlo, destruye `.env` sobrescribiéndolo con ceros conservando `.env.enc` (no pide contraseña). |
| `run <comando...>` | Descifra `.env.enc` **únicamente en memoria RAM** del proceso hijo e inyecta sus variables para ejecutar `<comando...>` sin crear `.env`. |

#### Autoinicio silencioso en Windows con DPAPI (`sincronitation/sincronizador.py`)
* **Qué hace:** Guarda o prueba tu contraseña maestra de `.env.enc` cifrada mediante **Windows DPAPI** (`%LOCALAPPDATA%\mood-tracker\vault.dpapi`, vinculada únicamente a tu usuario de Windows) para que `sincronizador.py` arranque al encender la PC sin `.env` plano.
* **Cuándo usarlo:** La primera vez en una PC Windows, tras cambiar la contraseña maestra de `.env.enc` o para consolidar entradas del Diario Word.

```bash
python sincronitation/sincronizador.py --configurar-autoinicio
python sincronitation/sincronizador.py --probar-autoinicio
python sincronitation/sincronizador.py --quitar-autoinicio
python sincronitation/sincronizador.py --consolidar-word
```

| Parámetro / Bandera | Para qué sirve |
| :--- | :--- |
| `--configurar-autoinicio` | Solicita la contraseña maestra de `.env.enc`, verifica que descifra y la guarda cifrada con Windows DPAPI. |
| `--probar-autoinicio` | Comprueba que Windows DPAPI descifra `.env.enc` en RAM correctamente sin pedir contraseña manual. |
| `--quitar-autoinicio` | Elimina `vault.dpapi` para exigir nuevamente contraseña manual al arrancar el sincronizador. |
| `--consolidar-word` | Ejecuta una consolidación/limpieza estructural del documento Word diario usando `WORD_PASSWORD`. |

---

### 1.4 Sincronizador Word en PC (`sincronitation/`) y `WINWORD.EXE`

#### Ejecución en consola vs segundo plano (`pythonw.exe`) y reinicio limpio
* **Qué hace:** Inicia el cliente Word local en primer plano (viendo logs en vivo) o totalmente oculto en segundo plano (`pythonw.exe`), o detiene procesos colgados de `sincronizador.py` / `WINWORD.EXE`.
* **Cuándo usarlo:** Tras actualizar `sincronizador.py`, cuando Word COM queda bloqueado o para diagnosticar sincronización hacia `.docx`.

```bash
# 1) Ejecutar en consola visible para diagnóstico en tiempo real
python sincronitation/sincronizador.py

# 2) Detener cualquier instancia previa de sincronizador.py en Windows
powershell.exe -NoProfile -Command 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*sincronizador.py*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; "Detenido PID: $($_.ProcessId)" }'

# 3) Iniciar en segundo plano sin ventana (usa DPAPI)
powershell.exe -NoProfile -Command 'Start-Process -FilePath pythonw.exe -WorkingDirectory (Get-Location).Path -ArgumentList "sincronitation\sincronizador.py" -WindowStyle Hidden'

# 4) Ver procesos Word activos o cerrar instancia huérfana de Microsoft Word
tasklist /FI "IMAGENAME eq WINWORD.EXE"
taskkill /F /IM WINWORD.EXE
```

| Parámetro / Bandera | Para qué sirve |
| :--- | :--- |
| `pythonw.exe` | Intérprete Python de Windows que ejecuta scripts sin abrir ventana de consola. |
| `-WindowStyle Hidden` | Garantiza ejecución silenciosa en segundo plano al lanzar con `Start-Process`. |
| `-WorkingDirectory (Get-Location).Path` | Fija la raíz del repo como directorio de trabajo para hallar `.env.enc` y `english-notes/`. |
| `/FI "IMAGENAME eq WINWORD.EXE"` | Filtra la lista de procesos de Windows mostrando únicamente instancias de Microsoft Word. |
| `/F /IM WINWORD.EXE` | Termina de forma forzada procesos `WINWORD.EXE` huérfanos que bloqueen el archivo `.docx`. |

#### Extractor local de subtítulos y letras (`sincronitation/yt_lyrics_helper.py`)
* **Qué hace:** Resuelve `yt-dlp` desde `PATH` o desde la GitHub Variable `YT_DLP_PATH`, descarga subtítulos (`CC`) sin descargar video completo, limpia timestamps `.vtt`/`.srt`/`.lrc` y copia la letra en UTF-8 al portapapeles o archivo.
* **Cuándo usarlo:** Para extraer letras de canciones desde tu PC sin consumir recursos del servidor o limpiar subtítulos descargados manualmente.

```bash
python sincronitation/yt_lyrics_helper.py --check-yt-dlp --refresh-github-var
python sincronitation/yt_lyrics_helper.py "https://www.youtube.com/watch?v=VIDEO_ID" --all-langs --langs ko,en,es --clip
python sincronitation/yt_lyrics_helper.py --clean-file subtitulos.vtt --out letra.txt
```

| Parámetro / Bandera | Para qué sirve |
| :--- | :--- |
| `--check-yt-dlp` | Muestra la ruta exacta y versión de `yt-dlp` detectada (PATH o GitHub Variable `YT_DLP_PATH`). |
| `--refresh-github-var` | Fuerza consulta inmediata a GitHub API para actualizar la caché local `.last_yt_dlp_path.json`. |
| `--all-langs` | Combina en orden todas las pistas de idioma encontradas en el video. |
| `--langs ko,en,es` | Lista priorizada de códigos de idioma a extraer. |
| `--clip` | Copia la letra limpia en UTF-8 directamente al portapapeles de Windows. |
| `--clean-file <archivo>` | Limpia timestamps y etiquetas XML/VTT de un archivo local sin conexión a internet. |
| `--out <archivo.txt>` | Escribe el resultado limpio en el archivo de salida indicado. |

---

## Entorno 2: Linux / Ubuntu Server (SSH / WSL / Producción)

### 2.1 Arquitectura Blue-Green, Docker Compose y Caddy

#### Estado de contenedores, consumo en vivo y logs (`docker ps`, `docker stats`, `docker logs`)
* **Qué hace:** Muestra los 4 contenedores del stack (`mood_db`, `mood_app_blue`, `mood_app_green`, `mood_proxy`), su estado de salud, uso de CPU/RAM en vivo y trazas recientes.
* **Cuándo usarlo:** Al verificar un despliegue, investigar un error 502/500 o confirmar que ambos slots (`blue` y `green`) están saludables.

```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}" mood_db mood_app_blue mood_app_green mood_proxy
docker logs -f --tail 100 mood_app_blue
docker logs -f --tail 100 mood_proxy
```

| Parámetro / Bandera | Para qué sirve |
| :--- | :--- |
| `--format "table ..."` | Formatea columnas específicas eliminando campos largos innecesarios. |
| `--no-stream` | Imprime una instantánea puntual de CPU y memoria en lugar de refrescar en bucle infinito. |
| `-f` (`--follow`) | Mantiene la terminal conectada mostrando nuevas líneas de log en tiempo real. |
| `--tail 100` | Muestra solo las últimas 100 líneas históricas antes de seguir en vivo. |

#### Control del tráfico Blue-Green y rollback (`scripts/blue-green.sh` y Caddy)
* **Qué hace:** Inspecciona qué slot (`blue` o `green`) recibe tráfico real de Caddy, inicializa el directorio de estado `./data/deploy-state/`, cambia atómicamente `upstream.caddy` hacia el otro slot y recarga Caddy **sin cortar conexiones activas**, o revierte en 1 comando al slot previo.
* **Cuándo usarlo:** Para verificar cuál réplica está activa (recuerda que solo el slot activo corre recordatorios y limpieza), hacer un corte manual controlado o ejecutar rollback de emergencia.

```bash
./scripts/blue-green.sh status
./scripts/blue-green.sh init-state blue
./scripts/blue-green.sh switch green v1.17.0
./scripts/blue-green.sh rollback
docker exec mood_proxy caddy reload --config /etc/caddy/Caddyfile
```

| Subcomando / Parámetro | Para qué sirve |
| :--- | :--- |
| `status` | Imprime slot activo, versión desplegada, puerto loopback (`3001` o `3002`), contenido de `upstream.caddy` y estado de contenedores. |
| `init-state [blue\|green]` | Crea `data/deploy-state/{active-slot,upstream.caddy,state.json}` apuntando al slot inicial si aún no existe. |
| `switch <blue\|green> [version]` | Verifica salud HTTP del slot destino, escribe atómicamente `active-slot` + `upstream.caddy` + `state.json` y recarga Caddy sin downtime. |
| `rollback` | Detecta automáticamente el slot opuesto al activo, valida su `/healthz` y devuelve todo el tráfico a ese slot en segundos. |
| `caddy reload --config ...` | Recarga la configuración en caliente dentro de `mood_proxy` sin reiniciar el proceso ni tirar conexiones en curso. |

#### Limpieza segura de imágenes y caché Docker (`docker image prune`, `docker builder prune`)
* **Qué hace:** Elimina capas huérfanas y caché de compilación antigua **sin borrar** las últimas versiones etiquetadas para rollback rápido ni los volúmenes de MySQL/Caddy.
* **Cuándo usarlo:** Periódicamente para liberar espacio en disco después de múltiples despliegues.

```bash
docker image prune -f
docker builder prune -f --filter "until=168h"
```

| Parámetro / Bandera | Para qué sirve |
| :--- | :--- |
| `-f` (`--force`) | Omite la confirmación interactiva (útil en automatización o SSH rápido). |
| `--filter "until=168h"` | Conserva caché de compilación de los últimos 7 días (168 horas) para acelerar despliegues frecuentes y borra solo lo más antiguo. |

---

### 2.2 Diagnóstico del servidor (RAM, Swap, Disco, Puertos y Salud)

#### Auditoría completa del servidor (`scripts/verify-ubuntu-local.sh`)
* **Qué hace:** Ejecuta 10 bloques de verificación (`[1/10]` a `[10/10]`): CPU/RAM/HDD/`vm.swappiness`, Blue-Green + tuning InnoDB, puertos exclusivamente en `127.0.0.1`, UFW, Tailscale Serve, Node `tzdata`, Python `msoffcrypto` en RAM, `yt-dlp --js-runtimes node` + `ffmpeg`, HSTS/CORS/CSP sin CDN, permisos de volúmenes, Drive `rclone` + crons, y hardening kernel/SSH/fail2ban/`hidepid=2`.
* **Cuándo usarlo:** Después de cada despliegue, cambio de configuración de red o mantenimiento del sistema operativo.

```bash
cd ~/projects/mood-tracker
./scripts/verify-ubuntu-local.sh
```

| Resultado en salida | Significado |
| :--- | :--- |
| `[PASS]` | Comprobación superada correctamente. |
| `[WARN]` | Advertencia no bloqueante (por ejemplo slot standby aún detenido en primer deploy o sin `rclone` remoto configurado). |
| `[FAIL]` | Falla crítica (puerto expuesto en `0.0.0.0`, desfase de zona horaria, contenedor caído); devuelve código de salida `1`. |

#### Memoria, disco, puertos en escucha, procesos, hora y crons
* **Qué hace:** Revisa consumo físico de RAM/Swap, espacio disponible en discos/particiones, sockets abiertos con proceso propietario, top consumidores de memoria, reloj del sistema y tareas programadas del usuario.
* **Cuándo usarlo:** Ante lentitud, alertas de disco, verificación de horario de recordatorios/backups o para comprobar que ningún puerto está expuesto en `0.0.0.0`.

```bash
free -h
df -h / ~/projects/mood-tracker
sudo ss -tulpn
top -b -n 1 | head -n 20
ps -eo pid,user,%mem,rss,cmd --sort=-rss | head -n 15
timedatectl
crontab -l
```

| Comando / Bandera | Para qué sirve |
| :--- | :--- |
| `free -h` | Muestra RAM total, usada, caché/buffers (`available`) y uso de `/swapfile` en formato legible (`Mi`/`Gi`). |
| `df -h` | Muestra tamaño, usado, libre (`Avail`) y porcentaje de ocupación por punto de montaje. |
| `sudo ss -tulpn` | Lista sockets TCP (`-t`), UDP (`-u`) en escucha (`-l`), puertos numéricos (`-n`) y nombre/PID del proceso (`-p`). Confirmar siempre `127.0.0.1:3001/3002/3306/8080`. |
| `top -b -n 1` | Ejecuta `top` en modo lote (`-b`) por 1 sola iteración (`-n 1`), ideal para inspeccionar sin bloquear la terminal. |
| `ps -eo ... --sort=-rss` | Lista procesos ordenados descendentemente por RAM física residente (`rss` en KB). |
| `timedatectl` | Verifica hora local, UTC y zona horaria activa (`America/Monterrey`). |
| `crontab -l` | Lista tareas `cron` programadas para el usuario actual (respaldo diario `30 3 * * *` y actualización semanal de `yt-dlp`). |

---

### 2.3 Tailscale y Red Privada (HTTPS Serve sin colisiones)

#### Verificar túnel, MagicDNS y rutas Serve (`tailscale status`, `tailscale serve`)
* **Qué hace:** Muestra el estado de conectividad WireGuard en tu tailnet, las rutas HTTPS publicadas hacia `127.0.0.1` y permite publicar tu proxy Caddy en un puerto HTTPS específico de tu máquina Tailscale.
* **Cuándo usarlo:** Al verificar que la URL `https://<tu-servidor>.<tu-tailnet>.ts.net` enruta hacia `http://127.0.0.1:8080` o al diagnosticar conectividad con otros proyectos coexistentes en el mismo servidor.

```bash
tailscale status
tailscale serve status
sudo tailscale serve --bg --https=443 http://127.0.0.1:8080
```

| Parámetro / Bandera | Para qué sirve |
| :--- | :--- |
| `tailscale status` | Lista el nodo local y pares conectados en la tailnet con su IP `100.x.y.z` y estado directo/relay. |
| `tailscale serve status` | Imprime la tabla exacta de puertos HTTPS publicados por Tailscale y sus destinos `127.0.0.1:<puerto>`. |
| `--bg` | Aplica la regla de Tailscale Serve en segundo plano de forma persistente aunque cierres la sesión SSH. |
| `--https=<puerto>` | Expone el servicio bajo TLS válido `https://<servidor>.ts.net:<puerto>` (por defecto `443`, u otro puerto exclusivo como `8443` / `9443` si coexiste otra app). |

> [!CAUTION]
> **Convivencia multiproducto en Ubuntu Server (p. ej. `proyecto-clara`):** **NUNCA ejecutes `sudo tailscale serve reset`** manualmente en un servidor compartido. Ese comando borra *todas* las rutas HTTPS de todos los proyectos activos en ese host. Para añadir o cambiar el puerto de un proyecto específico sin afectar a otros, usa siempre `sudo tailscale serve --bg --https=<puerto> http://127.0.0.1:<puerto>` con su propio puerto asignado.

---

### 2.4 Base de datos MySQL y Respaldos Dual Drive (`rclone`)

#### Respaldo manual, retención local y Drive (`scripts/backup.sh`, `scripts/restore.sh`)
* **Qué hace:** Genera `respaldo_mood_tracker.sql.gz`, mantiene copias rotativas diarias en `~/projects/respaldos/`, actualiza en RAM `historico_completo.json.gz`, conserva instantáneas mensuales en `historico_sql/` y sube a Google Drive (`gdrive`); `restore.sh` inicializa o restaura desde Drive.
* **Cuándo usarlo:** Antes de un mantenimiento riesgoso, para probar conectividad real de `rclone`, o para restaurar una base vacía/dañada.

```bash
# Respaldo manual completo (modo sellado si no hay .env en disco)
./scripts/backup.sh
./scripts/backup.sh --require-drive

# Restaurar SOLO si las tablas principales están vacías (requiere ENV_FILE o vault)
./scripts/env-vault.sh restore --if-empty
./scripts/restore.sh --if-empty

# Restauración forzada en servidor sellado sin dejar .env plano en disco
rclone copyto "gdrive:RespaldosApp/respaldo_mood_tracker.sql.gz" /dev/shm/restore_manual.sql.gz \
  && gunzip -c /dev/shm/restore_manual.sql.gz | docker exec -i mood_db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -u root "$MYSQL_DATABASE"' \
  && rm -f /dev/shm/restore_manual.sql.gz
```

| Script / Bandera | Para qué sirve |
| :--- | :--- |
| `--require-drive` (`backup.sh`) | Aborta con código `1` si `rclone` o el remoto de Google Drive fallan o no están configurados. |
| `--if-empty` (`restore.sh`) | Solo descarga e importa desde Drive si la suma de registros principales en MySQL es `0`. |
| `--force` (`restore.sh`) | Sobrescribe los datos actuales de la BD con el respaldo almacenado en Google Drive. |
| `/dev/shm/restore_manual.sql.gz` | Usa RAM (`tmpfs`) en lugar de disco para acelerar la descompresión y no dejar restos en disco tras `rm -f`. |

#### Verificación de `rclone`, exportación Base64 y consultas rápidas en `mood_db`
* **Qué hace:** Lista remotos configurados, inspecciona archivos subidos en Google Drive (incluyendo el remoto separado `STUDY_RCLONE_REMOTE` si lo usas), codifica `rclone.conf` en una sola línea Base64 para actualizar `RCLONE_CONF_B64` / `STUDY_RCLONE_CONF_B64`, y consulta conteos vivos dentro de MySQL sin exponer contraseñas en `ps`.
* **Cuándo usarlo:** Tras renovar OAuth en `rclone`, para verificar backups en la nube o auditar cantidad de registros por tabla.

```bash
rclone listremotes
rclone lsf "gdrive:RespaldosApp" --max-depth 2
base64 -w 0 ~/.config/rclone/rclone.conf && echo ""

docker exec mood_db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -u root "$MYSQL_DATABASE" -e "SELECT scope, revision FROM SyncRevisions; SELECT COUNT(*) AS mood_rows FROM RegistrosMood; SELECT COUNT(*) AS sleep_rows FROM RegistrosSleep;"'
```

| Parámetro / Bandera | Para qué sirve |
| :--- | :--- |
| `listremotes` | Confirma exactamente qué nombres de remoto (`gdrive:`, `gdrive_study:`) existen en `~/.config/rclone/rclone.conf`. |
| `lsf <remoto:ruta> --max-depth 2` | Lista nombres de archivos y subcarpetas (`historico_sql/`) de forma limpia y parseable. |
| `base64 -w 0` | Codifica sin saltos de línea (`--wrap=0`) para copiar/pegar limpio en GitHub Secrets (`RCLONE_CONF_B64`). |
| `MYSQL_PWD="$MYSQL_ROOT_PASSWORD"` | Lee la contraseña viva del entorno interno de `mood_db` dentro del subshell, evitando que quede visible en argumentos externos. |

---

### 2.5 Seguridad del host (`ufw`, `systemd`, `fail2ban`, `auditd`, `env-vault.sh`)

#### Firewall UFW, servicios `systemd`, `fail2ban` y auditoría `auditd`
* **Qué hace:** Revisa reglas activas de firewall, controla servicios del sistema (`docker`, `tailscaled`, `ssh`, `fail2ban`, `cron`), consulta IPs baneadas por intentos SSH fallidos y revisa registros de auditoría sobre archivos críticos (`Diario.docx`, `authorized_keys`, `rclone.conf`, `sudoers.d`).
* **Cuándo usarlo:** Durante auditorías de seguridad, bloqueos por error en SSH o validación post-instalación.

```bash
sudo ufw status verbose
sudo systemctl status docker tailscaled fail2ban auditd --no-pager
sudo fail2ban-client status sshd
sudo auditctl -l
chmod 700 ~/.ssh ~/projects/respaldos ~/.config/rclone
chmod 600 ~/.ssh/authorized_keys ~/.config/rclone/rclone.conf ~/projects/mood-tracker/data/journal/Diario.docx
```

| Comando / Bandera | Para qué sirve |
| :--- | :--- |
| `ufw status verbose` | Muestra política por defecto (`deny incoming`), reglas por interfaz (`tailscale0`) y estado de registro. |
| `systemctl status\|enable\|disable\|restart` | Inspecciona (`status`), habilita al arranque (`enable`), deshabilita (`disable`) o reinicia un daemon del sistema. |
| `--no-pager` | Evita que `systemctl` pause la salida dentro de `less` al revisar varios servicios juntos. |
| `fail2ban-client status sshd` | Reporta intentos fallidos actuales y lista de IPs baneadas en la jail `sshd`. |
| `sudo auditctl -l` | Lista reglas activas del kernel `auditd` que vigilan lecturas/escrituras sobre rutas sensibles. |
| `chmod 700` / `chmod 600` | Restringe directorios (`rwx------`) y archivos sensibles (`rw-------`) exclusivamente al propietario. |

#### Bóveda de entorno en servidor Linux (`scripts/env-vault.sh`)
* **Qué hace:** Equivalente Linux de `local-vault.js`: cifra `.env` en `.env.enc` con `openssl` (PBKDF2 600,000 iter + AES-256-CBC), guarda metadatos no sensibles en `.backup.meta`, y descifra solo en RAM (`/dev/shm`) al levantar contenedores (`up`), respaldar (`backup`) o restaurar (`restore`).
* **Cuándo usarlo:** En despliegues manuales por SSH cuando no quieres dejar `.env` plano en disco entre reinicios.

```bash
./scripts/env-vault.sh status
./scripts/env-vault.sh encrypt
./scripts/env-vault.sh decrypt
./scripts/env-vault.sh lock
./scripts/env-vault.sh up
./scripts/env-vault.sh backup --require-drive
./scripts/env-vault.sh restore --if-empty
```

| Subcomando | Para qué sirve |
| :--- | :--- |
| `status` | Verifica si `.env` está ausente/sellado en disco o expuesto en texto plano. |
| `encrypt` | Cifra `.env` → `.env.enc`, actualiza `.backup.meta` sin secretos y destruye `.env` plano con `shred`. |
| `decrypt` | Pide contraseña maestra y restaura temporalmente `.env` para edición manual. |
| `lock` | Destruye `.env` plano con `shred` sin tocar `.env.enc` (cuando no hubo edición). |
| `up` | Descifra `.env.enc` en `/dev/shm`, ejecuta `docker compose --env-file ... up -d` y borra el temporal de RAM al salir. |
| `backup` / `restore` | Descifra temporalmente en `/dev/shm` y lanza `scripts/backup.sh` o `scripts/restore.sh` reenviando sus argumentos (`--require-drive`, `--if-empty`, `--force`). |

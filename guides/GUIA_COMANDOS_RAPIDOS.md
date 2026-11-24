# ⚡ Guía de Comandos Rápidos (Copy-Paste) — Personal Daily Hub

> Cheatsheet directo de **puros comandos** listos para copiar y pegar. Para explicación detallada de parámetros y banderas, consulta [GUIA_COMANDOS.md](./GUIA_COMANDOS.md).

---

## 📑 Índice

1. [Git Bash — Ramas, commits, limpieza y pruebas](#1-git-bash--ramas-commits-limpieza-y-pruebas)
2. [Ubuntu Server — Blue-Green, Docker, Caddy y Rollback manual](#2-ubuntu-server--blue-green-docker-caddy-y-rollback-manual)
3. [Tailscale y verificación de puertos/servicios](#3-tailscale-y-verificación-de-puertosservicios)
4. [MySQL, Backups y `rclone` (Google Drive)](#4-mysql-backups-y-rclone-google-drive)
5. [Bóveda `.env.enc` (PC y Servidor)](#5-bóveda-envenc-pc-y-servidor)
6. [Diagnóstico rápido de RAM, CPU, Disco, Procesos y Logs (Linux / WSL)](#6-diagnóstico-rápido-de-ram-cpu-disco-procesos-y-logs-linux--wsl)
7. [Sincronizador local Python / `yt-dlp` en Windows](#7-sincronizador-local-python--yt-dlp-en-windows)

---

## 1. Git Bash — Ramas, commits, limpieza y pruebas

```bash
# Ver estado de archivos y rama actual
git status -sb

# Actualizar main y crear nueva rama de trabajo
git fetch --prune origin && git switch main && git pull --ff-only origin main && git checkout -b feat/cambio

# Commit desglosado siguiendo Conventional Commits (calcula SemVer automático)
git add . && git commit -m "feat: título del cambio" -m "- Detalle 1" -m "- Detalle 2"

# Subir rama nueva a origin
git push -u origin "$(git branch --show-current)"

# Limpiar todas las ramas locales ya fusionadas dejando solo main y la rama actual
git branch | grep -vE '^\*|(\s+main$)' | xargs -r git branch -d

# Limpieza forzada de ramas locales sobrantes (deja solo main y la actual)
git branch | grep -vE '^\*|(\s+main$)' | xargs -r git branch -D

# Ver últimos commits y últimos tags SemVer desplegados
git log --oneline -n 15 && git tag -l "v*" --sort=-v:refname | head -n 10

# Ejecutar toda la suite de pruebas en Git Bash (en PowerShell usa: npm.cmd test)
npm test

# Validar sintaxis JS, Bash y simular siguiente versión SemVer (sin modificar archivos)
node --check server.js && node --check public/frontend.js && node --check lib/server-notes-service.js && bash -n scripts/*.sh && node scripts/release-version.js
```

---

## 2. Ubuntu Server — Blue-Green, Docker, Caddy y Rollback manual

```bash
# Ver estado de contenedores y puertos enlazados
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# Ver slot Blue-Green activo, versión y upstream de Caddy
./scripts/blue-green.sh status

# Inicializar estado Blue-Green en instalación limpia apuntando a blue
./scripts/blue-green.sh init-state blue

# Cambiar tráfico atómicamente al slot opuesto (ejemplo: pasar a green)
./scripts/blue-green.sh switch green

# Rollback instantáneo al slot standby anterior sin recompilar ni tirar conexiones
./scripts/blue-green.sh rollback

# Recargar Caddy en caliente sin reiniciar mood_proxy
docker exec mood_proxy caddy reload --config /etc/caddy/Caddyfile

# Ver logs en vivo de los slots Blue-Green y del proxy Caddy
docker logs -f --tail 100 mood_app_blue
docker logs -f --tail 100 mood_app_green
docker logs -f --tail 100 mood_proxy

# Limpiar imágenes huérfanas y caché viejo (> 7 días) conservando tags de rollback
docker image prune -f && docker builder prune -f --filter "until=168h"
```

---

## 3. Tailscale y verificación de puertos/servicios

```bash
# Ver nodos conectados en tu tailnet e IP Tailscale
tailscale status && tailscale ip -4

# Ver rutas HTTPS activas publicadas por Tailscale Serve
tailscale serve status

# Exponer el balanceador Caddy local por HTTPS privado (NO ejecutar tailscale serve reset en servidor compartido)
sudo tailscale serve --bg --https=443 http://127.0.0.1:8080

# Verificar que 3001, 3002, 3306 y 8080 escuchan únicamente en 127.0.0.1 (nunca 0.0.0.0)
sudo ss -tulpn | grep -E ':3001|:3002|:3306|:8080'

# Auditoría integral [1/10] a [10/10] de hardware, Docker, TLS, Drive y seguridad
./scripts/verify-ubuntu-local.sh

# Verificar firewall UFW, Fail2ban, servicios del sistema y reglas auditd
sudo ufw status verbose && sudo fail2ban-client status sshd && sudo systemctl is-active docker tailscaled fail2ban auditd
```

---

## 4. MySQL, Backups y `rclone` (Google Drive)

```bash
# Generar respaldo completo + historico_completo.json.gz y validar subida en Google Drive
./scripts/backup.sh --require-drive

# Restaurar desde Drive únicamente si la BD está vacía (usando vault en RAM)
./scripts/env-vault.sh restore --if-empty

# Restaurar manualmente en servidor sellado sin crear .env en disco
rclone copyto "gdrive:RespaldosApp/respaldo_mood_tracker.sql.gz" /dev/shm/restore_manual.sql.gz && gunzip -c /dev/shm/restore_manual.sql.gz | docker exec -i mood_db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -u root "$MYSQL_DATABASE"' && rm -f /dev/shm/restore_manual.sql.gz

# Verificar remotos rclone, listar archivos en Drive y ver logs de backup cron
rclone listremotes && rclone lsf "gdrive:RespaldosApp" --max-depth 2 && tail -n 30 ~/projects/respaldos/backup.log

# Exportar rclone.conf en Base64 de una sola línea para GitHub Secrets (RCLONE_CONF_B64)
base64 -w 0 ~/.config/rclone/rclone.conf && echo ""

# Consultar conteo rápido de registros y SyncRevisions en mood_db
docker exec mood_db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -u root "$MYSQL_DATABASE" -e "SELECT scope, revision FROM SyncRevisions; SELECT (SELECT COUNT(*) FROM RegistrosMood) AS mood, (SELECT COUNT(*) FROM RegistrosSleep) AS sleep, (SELECT COUNT(*) FROM RegistrosCrisis) AS crisis, (SELECT COUNT(*) FROM RegistrosAgenda) AS agenda;"'
```

---

## 5. Bóveda `.env.enc` (PC y Servidor)

```bash
# --- En Windows / Git Bash (local-vault.js) ---
# Ver si .env está sellado o expuesto en disco
node scripts/local-vault.js status

# Descifrar .env temporalmente para editarlo (en mintty anteponer winpty)
node scripts/local-vault.js decrypt

# Cifrar cambios a .env.enc y sobrescribir/borrar .env plano
node scripts/local-vault.js encrypt

# Destruir .env plano sin cambios manteniendo .env.enc intacto
node scripts/local-vault.js lock

# Ejecutar proceso cargando .env.enc únicamente en memoria RAM
node scripts/local-vault.js run node server.js

# --- En Ubuntu Server (env-vault.sh) ---
# Ver estado de bóveda en servidor Linux
./scripts/env-vault.sh status

# Cifrar .env -> .env.enc y destruir .env con shred
./scripts/env-vault.sh encrypt

# Descifrar temporalmente .env en servidor / re-sellar sin cambios
./scripts/env-vault.sh decrypt
./scripts/env-vault.sh lock

# Levantar contenedores o respaldar descifrando solo en /dev/shm (RAM)
./scripts/env-vault.sh up && ./scripts/env-vault.sh backup --require-drive
```

---

## 6. Diagnóstico rápido de RAM, CPU, Disco, Procesos y Logs (Linux / WSL)

```bash
# Ver uso de RAM y Swap
free -h

# Ver espacio libre en particiones y carpeta del proyecto
df -h / ~/projects/mood-tracker

# Consumo CPU/RAM en vivo de los 4 contenedores Docker
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}" mood_db mood_app_blue mood_app_green mood_proxy

# Top 15 procesos que más memoria física (RSS) consumen en el host
ps -eo pid,user,%mem,rss,cmd --sort=-rss | head -n 15

# Instantánea CPU + carga promedio del sistema
top -b -n 1 | head -n 20

# Verificar zona horaria del host y tareas cron configuradas
timedatectl && crontab -l && cat /etc/cron.d/dailyhub-sys-update 2>/dev/null || true

# Ver últimas líneas de logs persistentes en host de cada slot Blue-Green
tail -n 50 logs/blue/*.log logs/green/*.log 2>/dev/null || true
```

---

## 7. Sincronizador local Python / `yt-dlp` en Windows

```bash
# Configurar, probar o quitar autoinicio Windows DPAPI sin .env plano en disco
python sincronitation/sincronizador.py --configurar-autoinicio
python sincronitation/sincronizador.py --probar-autoinicio
python sincronitation/sincronizador.py --quitar-autoinicio

# Consolidar estructura del Diario Word local y ver log en vivo
python sincronitation/sincronizador.py --consolidar-word && tail -n 30 sincronitation/historial.log

# Detener instancias previas y reiniciar sincronizador.py en segundo plano oculto (Git Bash -> PowerShell)
powershell.exe -NoProfile -Command 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*sincronizador.py*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Start-Process -FilePath pythonw.exe -WorkingDirectory (Get-Location).Path -ArgumentList "sincronitation\sincronizador.py" -WindowStyle Hidden'

# Verificar o cerrar procesos huérfanos de Microsoft Word en Windows
tasklist /FI "IMAGENAME eq WINWORD.EXE"
taskkill /F /IM WINWORD.EXE

# Validar yt-dlp local (PATH o GitHub Variable YT_DLP_PATH) y extraer subtítulos limpios al portapapeles
python sincronitation/yt_lyrics_helper.py --check-yt-dlp --refresh-github-var
python sincronitation/yt_lyrics_helper.py "https://www.youtube.com/watch?v=VIDEO_ID" --all-langs --langs ko,en,es --clip
python sincronitation/yt_lyrics_helper.py --clean-file subtitulos.vtt --out letra.txt
```

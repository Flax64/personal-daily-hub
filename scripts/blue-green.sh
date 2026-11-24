#!/bin/bash
set -euo pipefail

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

STATE_DIR="$PROJECT_DIR/data/deploy-state"
ACTIVE_SLOT_FILE="$STATE_DIR/active-slot"
UPSTREAM_CADDY_FILE="$STATE_DIR/upstream.caddy"
STATE_JSON_FILE="$STATE_DIR/state.json"

BLUE_PORT="${BLUE_PORT:-3001}"
GREEN_PORT="${GREEN_PORT:-3002}"
PROXY_HTTP_PORT="${PROXY_HTTP_PORT:-8080}"

resolve_docker_cmd() {
    if docker info >/dev/null 2>&1; then
        printf 'docker'
    elif command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
        printf 'sudo docker'
    elif [ -n "${SUDO_ASKPASS:-}" ] && command -v sudo >/dev/null 2>&1; then
        printf 'sudo -A docker'
    else
        printf 'docker'
    fi
}

DOCKER_CMD="$(resolve_docker_cmd)"

validate_slot() {
    local slot="$1"
    if [ "$slot" != "blue" ] && [ "$slot" != "green" ]; then
        echo "ERROR: Slot inválido '$slot' (esperado: blue | green)." >&2
        exit 1
    fi
}

opposite_slot() {
    if [ "$1" = "blue" ]; then
        printf 'green'
    else
        printf 'blue'
    fi
}

slot_port() {
    if [ "$1" = "blue" ]; then
        printf '%s' "$BLUE_PORT"
    else
        printf '%s' "$GREEN_PORT"
    fi
}

slot_container() {
    printf 'mood_app_%s' "$1"
}

atomic_write_file() {
    local target_file="$1"
    local tmp_file
    mkdir -p "$(dirname "$target_file")"
    chmod 755 "$STATE_DIR" 2>/dev/null || true
    tmp_file="$(mktemp "${STATE_DIR}/.tmp.$(basename "$target_file").XXXXXX")"
    cat > "$tmp_file"
    chmod 644 "$tmp_file"
    mv -f "$tmp_file" "$target_file"
}

write_upstream_caddy() {
    local slot="$1"
    validate_slot "$slot"
    local svc="app_${slot}"
    atomic_write_file "$UPSTREAM_CADDY_FILE" <<EOF
reverse_proxy ${svc}:{\$PORT:3000} {
    health_uri /healthz
    health_interval 15s
    health_timeout 5s
    health_status 200
    fail_duration 30s
    max_fails 3
}
EOF
}

read_active_slot() {
    if [ -r "$ACTIVE_SLOT_FILE" ]; then
        local val
        val="$(tr -d ' \t\r\n' < "$ACTIVE_SLOT_FILE" 2>/dev/null || true)"
        if [ "$val" = "blue" ] || [ "$val" = "green" ]; then
            printf '%s' "$val"
            return 0
        fi
    fi
    return 1
}

read_json_field() {
    local field="$1"
    if [ ! -r "$STATE_JSON_FILE" ]; then
        return 0
    fi
    if command -v python3 >/dev/null 2>&1; then
        python3 -c 'import json,sys
try:
  with open(sys.argv[1], encoding="utf-8") as fh:
    d = json.load(fh)
  print(str(d.get(sys.argv[2], "") or ""))
except Exception:
  pass' "$STATE_JSON_FILE" "$field" 2>/dev/null || true
    else
        sed -n "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$STATE_JSON_FILE" | head -n 1 || true
    fi
}

write_state_json() {
    local active_slot="$1"
    local active_version="$2"
    local previous_slot="$3"
    local previous_version="$4"
    local switched_at
    switched_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date)"
    atomic_write_file "$STATE_JSON_FILE" <<EOF
{
  "activeSlot": "${active_slot}",
  "activeVersion": "${active_version}",
  "previousSlot": "${previous_slot}",
  "previousVersion": "${previous_version}",
  "switchedAt": "${switched_at}"
}
EOF
}

container_state() {
    $DOCKER_CMD inspect -f '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1" 2>/dev/null || echo 'missing|none'
}

wait_for_slot_healthy() {
    local slot="$1"
    local max_attempts="${2:-15}"
    local cname
    local port
    cname="$(slot_container "$slot")"
    port="$(slot_port "$slot")"

    for _attempt in $(seq 1 "$max_attempts"); do
        local st
        st="$(container_state "$cname")"
        if [ "$st" = "running|healthy" ] && curl -fsS --max-time 4 "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
            return 0
        fi
        sleep 3
    done
    return 1
}

probe_slot_version() {
    local port="$1"
    local ver=""
    local hdrs
    hdrs="$(curl -fsS -D - -o /dev/null --max-time 4 "http://127.0.0.1:${port}/healthz" 2>/dev/null || true)"
    ver="$(printf '%s\n' "$hdrs" | grep -i '^X-App-Version:' | head -n 1 | cut -d: -f2- | tr -d ' \t\r\n' || true)"
    if [ -n "$ver" ]; then
        case "$ver" in
            v*) printf '%s' "$ver" ;;
            *) printf 'v%s' "$ver" ;;
        esac
        return 0
    fi
    printf 'unknown'
}

reload_or_start_proxy() {
    local proxy_state
    proxy_state="$(container_state "mood_proxy")"
    if [[ "$proxy_state" == running\|* ]]; then
        $DOCKER_CMD exec mood_proxy caddy reload --config /etc/caddy/Caddyfile --force >/dev/null
    else
        local compose_env_args=()
        if [ -n "${ENV_FILE_OVERRIDE:-}" ] && [ -f "$ENV_FILE_OVERRIDE" ]; then
            compose_env_args=(--env-file "$ENV_FILE_OVERRIDE")
        fi
        $DOCKER_CMD compose "${compose_env_args[@]}" up -d --no-deps --no-build proxy
    fi
}

cmd_init_state() {
    local default_slot="${1:-blue}"
    validate_slot "$default_slot"
    mkdir -p "$STATE_DIR"
    chmod 755 "$STATE_DIR"

    local current_slot=""
    if current_slot="$(read_active_slot)"; then
        default_slot="$current_slot"
    else
        printf '%s\n' "$default_slot" | atomic_write_file "$ACTIVE_SLOT_FILE"
    fi

    if [ ! -s "$UPSTREAM_CADDY_FILE" ]; then
        write_upstream_caddy "$default_slot"
    else
        chmod 644 "$UPSTREAM_CADDY_FILE" 2>/dev/null || true
    fi

    if [ ! -s "$STATE_JSON_FILE" ]; then
        local opp
        opp="$(opposite_slot "$default_slot")"
        write_state_json "$default_slot" "unknown" "$opp" "none"
    fi

    echo "Estado Blue-Green inicializado: activeSlot=${default_slot} ($STATE_DIR)."
}

cmd_status() {
    local active_slot="unset"
    local standby_slot="unset"
    if active_slot="$(read_active_slot)"; then
        standby_slot="$(opposite_slot "$active_slot")"
    fi

    echo "=== Estado Blue-Green (Personal Daily Hub) ==="
    echo "Slot activo:    ${active_slot}"
    echo "Slot standby:   ${standby_slot}"
    if [ -r "$STATE_JSON_FILE" ]; then
        echo "Versión activa: $(read_json_field activeVersion)"
        echo "Slot previo:    $(read_json_field previousSlot) ($(read_json_field previousVersion))"
        echo "Último corte:   $(read_json_field switchedAt)"
    fi
    echo "Contenedores:"
    for cname in mood_db mood_app_blue mood_app_green mood_proxy; do
        printf '  - %-16s %s\n' "$cname" "$(container_state "$cname")"
    done
    echo "Imágenes versionadas disponibles (personal-daily-hub-app):"
    $DOCKER_CMD images personal-daily-hub-app --format '  - {{.Repository}}:{{.Tag}} ({{.CreatedSince}}, {{.Size}})' 2>/dev/null || true
}

cmd_switch() {
    local target_slot="${1:-}"
    local target_version="${2:-}"
    validate_slot "$target_slot"

    local target_cname
    local target_port
    target_cname="$(slot_container "$target_slot")"
    target_port="$(slot_port "$target_slot")"

    local prev_slot=""
    if ! prev_slot="$(read_active_slot)"; then
        prev_slot="$(opposite_slot "$target_slot")"
    fi
    local prev_version
    prev_version="$(read_json_field activeVersion)"
    [ -z "$prev_version" ] && prev_version="none"

    echo "🔍 Verificando salud de ${target_cname} (127.0.0.1:${target_port}/healthz) antes de conmutar tráfico..."
    if ! wait_for_slot_healthy "$target_slot" 10; then
        echo "ERROR: ${target_cname} no está running (healthy) ni responde HTTP 200 en loopback ${target_port}. Se aborta el corte." >&2
        exit 1
    fi

    if [ -z "$target_version" ]; then
        target_version="$(probe_slot_version "$target_port")"
    fi

    write_upstream_caddy "$target_slot"
    printf '%s\n' "$target_slot" | atomic_write_file "$ACTIVE_SLOT_FILE"
    reload_or_start_proxy

    local proxy_verified=0
    local proxy_replica=""
    for _i in 1 2 3 4 5; do
        local hdrs code
        hdrs="$(curl -s -D - -o /dev/null -w '\n%{http_code}' --max-time 4 "http://127.0.0.1:${PROXY_HTTP_PORT}/healthz" 2>/dev/null || true)"
        code="$(printf '%s\n' "$hdrs" | tail -n 1)"
        proxy_replica="$(printf '%s\n' "$hdrs" | grep -i '^X-Replica-Id:' | head -n 1 | cut -d: -f2- | tr -d ' \t\r\n' || true)"
        if [ "$code" = "200" ] && [ "$proxy_replica" = "$target_slot" ]; then
            proxy_verified=1
            break
        fi
        sleep 2
    done

    if [ "$proxy_verified" -ne 1 ]; then
        echo "ERROR: Caddy (127.0.0.1:${PROXY_HTTP_PORT}/healthz) no confirmó X-Replica-Id=${target_slot} (obtenido '${proxy_replica}')." >&2
        exit 1
    fi

    write_state_json "$target_slot" "$target_version" "$prev_slot" "$prev_version"
    echo "✅ Tráfico conmutado de forma atómica a slot '${target_slot}' (${target_version}) con cero tiempo de inactividad."
}

cmd_rollback() {
    local current_slot=""
    if ! current_slot="$(read_active_slot)"; then
        echo "ERROR: No existe active-slot configurado en $ACTIVE_SLOT_FILE; imposible determinar standby para rollback." >&2
        exit 1
    fi

    local standby_slot
    local standby_cname
    local standby_port
    standby_slot="$(opposite_slot "$current_slot")"
    standby_cname="$(slot_container "$standby_slot")"
    standby_port="$(slot_port "$standby_slot")"

    echo "🔄 Iniciando rollback: slot activo '${current_slot}' -> slot standby '${standby_slot}'..."
    local standby_state
    standby_state="$(container_state "$standby_cname")"

    if [[ "$standby_state" != running\|* ]]; then
        if ! $DOCKER_CMD image inspect "personal-daily-hub-app:${standby_slot}" >/dev/null 2>&1; then
            echo "ERROR: El contenedor ${standby_cname} no está corriendo y no existe imagen local personal-daily-hub-app:${standby_slot}. El tráfico en '${current_slot}' se mantiene intacto." >&2
            exit 1
        fi
        echo "🚀 Levantando slot standby ${standby_cname} sin reconstruir..."
        if [ "$standby_state" != "missing|none" ]; then
            $DOCKER_CMD start "$standby_cname" >/dev/null 2>&1 || true
        fi
        standby_state="$(container_state "$standby_cname")"
        if [[ "$standby_state" != running\|* ]]; then
            local compose_env_args=()
            if [ -n "${ENV_FILE_OVERRIDE:-}" ] && [ -f "$ENV_FILE_OVERRIDE" ]; then
                compose_env_args=(--env-file "$ENV_FILE_OVERRIDE")
            fi
            $DOCKER_CMD compose "${compose_env_args[@]}" up -d --no-deps --no-build "app_${standby_slot}"
        fi
    fi

    if ! wait_for_slot_healthy "$standby_slot" 15; then
        echo "ERROR: El slot standby ${standby_cname} no alcanzó running (healthy) en 45s. Se aborta rollback sin tocar producción ('${current_slot}')." >&2
        exit 1
    fi

    local restored_version
    restored_version="$(probe_slot_version "$standby_port")"
    if [ "$restored_version" = "unknown" ] || [ -z "$restored_version" ]; then
        local prev_json_ver
        prev_json_ver="$(read_json_field previousVersion)"
        [ -n "$prev_json_ver" ] && [ "$prev_json_ver" != "none" ] && restored_version="$prev_json_ver"
    fi

    cmd_switch "$standby_slot" "$restored_version"
    echo "✅ Rollback completado: activo='${standby_slot}' | versión restaurada='${restored_version}' (previo='${current_slot}')."
}

ACTION="${1:-status}"
shift || true

case "$ACTION" in
    status)
        cmd_status "$@"
        ;;
    init-state)
        cmd_init_state "${1:-blue}"
        ;;
    switch)
        cmd_switch "${1:-}" "${2:-}"
        ;;
    rollback)
        cmd_rollback "$@"
        ;;
    *)
        echo "Uso: $0 {status|init-state [blue|green]|switch <blue|green> [version]|rollback}" >&2
        exit 1
        ;;
esac

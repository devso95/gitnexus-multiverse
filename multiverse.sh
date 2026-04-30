#!/bin/bash
# GitNexus Multiverse — start/stop/status
# Usage: ./multiverse.sh start|stop|restart|status|log

DIR="$(cd "$(dirname "$0")/gitnexus" && pwd)"
PIDFILE="$DIR/.multiverse.pid"
LOGFILE="$DIR/multiverse.log"
ENV_FILE="$DIR/../.env"

load_env() {
  if [ -f "$ENV_FILE" ]; then
    set -a; source "$ENV_FILE"; set +a
  fi
}

get_ip() {
  echo "${MV_IP:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
}

get_port() {
  local p=$(grep -oP 'running on http://[^:]+:\K[0-9]+' "$LOGFILE" 2>/dev/null | tail -1)
  echo "${p:-3003}"
}

do_start() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "⚡ Multiverse already running (PID $(cat "$PIDFILE"))"
    return 1
  fi

  load_env

  if [ ! -f "$DIR/dist/cli/index.js" ]; then
    echo "📦 Building backend..."
    (cd "$DIR" && npm run build) || { echo "❌ Build failed"; return 1; }
  fi

  if [ ! -d "$DIR/../packages/multiverse-web/dist" ]; then
    echo "📦 Building Admin UI..."
    (cd "$DIR/../packages/multiverse-web" && npm install --silent && npm run build) || true
  fi

  echo "⚡ Starting Multiverse..."
  cd "$DIR"
  set -a; source "$ENV_FILE" 2>/dev/null; set +a
  nohup node dist/cli/index.js multiverse > "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  sleep 3

  if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "✅ Multiverse started (PID $(cat "$PIDFILE"))"
    echo "   Log:  $LOGFILE"
    echo "   URL:  http://$(get_ip):$(get_port)"
  else
    echo "❌ Failed to start. Check log:"
    rm -f "$PIDFILE"
    tail -20 "$LOGFILE"
    return 1
  fi
}

do_stop() {
  if [ ! -f "$PIDFILE" ]; then
    echo "⚡ Multiverse not running"
    return 0
  fi
  PID=$(cat "$PIDFILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "⚡ Stopping Multiverse (PID $PID)..."
    kill "$PID"; sleep 2
    kill -0 "$PID" 2>/dev/null && kill -9 "$PID"
    echo "✅ Stopped"
  else
    echo "⚡ Process already dead"
  fi
  rm -f "$PIDFILE"
}

do_status() {
  load_env
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "⚡ Multiverse running (PID $(cat "$PIDFILE")) — http://$(get_ip):$(get_port)"
    curl -sf "http://127.0.0.1:$(get_port)/api/ops/health" 2>/dev/null || echo "   (health check failed)"
  else
    echo "⚡ Multiverse not running"
  fi
}

case "${1:-start}" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_stop; sleep 1; do_start ;;
  status)  do_status ;;
  log)     tail -f "$LOGFILE" ;;
  *)       echo "Usage: $0 {start|stop|restart|status|log}" ;;
esac

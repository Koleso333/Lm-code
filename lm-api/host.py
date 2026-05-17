import http.server
import json
import os
import time
import urllib.parse
import socketserver
import subprocess
import sys
import threading

CLI_MODULE = "cli"
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))

_lock = threading.Lock()
_queue_changed = threading.Condition(_lock)
_inject_queue = []
_response_queue = []
_current_status = ""
_retry_blocked = False
_httpd = None

# --- Addition (расширение) heartbeat ---
_addition_lock = threading.Lock()
_addition_last_heartbeat = 0.0  # time.time() последнего heartbeat
_ADDITION_ALIVE_TIMEOUT = 10  # секунд без heartbeat = не готово


def _pop_pending(queue_name, timeout_seconds=0):
    queue = _inject_queue if queue_name == "inject" else _response_queue
    with _queue_changed:
        if timeout_seconds > 0 and not queue:
            _queue_changed.wait(timeout_seconds)
        if queue:
            return queue.pop(0)
    return None


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(f"[lm-api] {args[0]}")

    def _send_json(self, status_code, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        try:
            self.wfile.write(body)
            self.wfile.flush()
        except (ConnectionAbortedError, BrokenPipeError):
            pass

    def do_OPTIONS(self):
        self._send_json(200, {})

    def do_GET(self):
        global _current_status
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path == "/status":
            self._send_json(200, {"status": "ok"})
        elif path == "/shutdown":
            self._send_json(200, {"status": "shutting down"})
            print("[lm-api] Shutdown requested.")
            threading.Thread(target=lambda: _httpd.shutdown() if _httpd else None, daemon=True).start()
        elif path == "/pending_inject":
            timeout_seconds = self._parse_timeout(query)
            msg = _pop_pending("inject", timeout_seconds)
            if msg is not None:
                self._send_json(200, {"pending": True, "text": msg})
                return
            self._send_json(200, {"pending": False})
        elif path == "/pending_response":
            timeout_seconds = self._parse_timeout(query)
            msg = _pop_pending("response", timeout_seconds)
            if msg is not None:
                text = msg.get("text", "") if isinstance(msg, dict) else msg
                model = msg.get("model", "") if isinstance(msg, dict) else ""
                self._send_json(200, {"pending": True, "text": text, "model": model})
                return
            self._send_json(200, {"pending": False})
        elif path == "/pending_status":
            timeout_seconds = self._parse_timeout(query)
            since = query.get("since", [""])[0]
            with _queue_changed:
                if _current_status == since and timeout_seconds > 0:
                    _queue_changed.wait(timeout_seconds)
                status = _current_status
            self._send_json(200, {"status": status})
        elif path == "/retry_blocked":
            with _queue_changed:
                blocked = _retry_blocked
            self._send_json(200, {"blocked": blocked})
        elif path == "/addition_status":
            with _addition_lock:
                last = _addition_last_heartbeat
            elapsed = time.time() - last
            ready = elapsed < _ADDITION_ALIVE_TIMEOUT and last > 0
            self._send_json(200, {
                "ready": ready,
                "last_heartbeat": last,
                "elapsed": round(elapsed, 1),
            })
        else:
            self._send_json(404, {"error": "not found"})

    def _parse_timeout(self, query):
        raw = query.get("timeout", ["0"])[0]
        try:
            timeout = float(raw)
        except (TypeError, ValueError):
            return 0
        return max(0, min(timeout, 30))

    def do_POST(self):
        global _current_status, _retry_blocked, _addition_last_heartbeat
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8")
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            self._send_json(400, {"error": "invalid json"})
            return

        if self.path == "/execute":
            self._handle_execute(payload)
        elif self.path == "/parse":
            self._handle_parse(payload)
        elif self.path == "/queue_inject":
            text = payload.get("text", "")
            with _queue_changed:
                _inject_queue.append(text)
                _current_status = "sending"
                _retry_blocked = False
                _queue_changed.notify_all()
            print(f"[lm-api] Queued inject: {text[:60]}...")
            self._send_json(200, {"queued": True})
        elif self.path == "/cancel_inject":
            with _queue_changed:
                _inject_queue.clear()
                _response_queue.clear()
                _retry_blocked = True
                _current_status = ""
                _queue_changed.notify_all()
            print("[lm-api] cancel_inject: queues cleared, retry blocked")
            self._send_json(200, {"ok": True})
        elif self.path == "/flush_queues":
            with _queue_changed:
                dropped = len(_inject_queue) + len(_response_queue)
                _inject_queue.clear()
                _response_queue.clear()
                _current_status = ""
                _queue_changed.notify_all()
            if dropped:
                print(f"[lm-api] flush_queues: dropped {dropped} stale items")
            self._send_json(200, {"ok": True})
        elif self.path == "/ai_response":
            text = payload.get("text", "")
            model = payload.get("model", "")
            with _queue_changed:
                _response_queue.append({"text": text, "model": model})
                _current_status = ""
                _queue_changed.notify_all()
            print(f"[lm-api] AI response received (model={model}): {text[:60]}...")
            self._send_json(200, {"received": True})
        elif self.path == "/ai_status":
            status = payload.get("status", "")
            with _queue_changed:
                _current_status = status
                _queue_changed.notify_all()
            self._send_json(200, {"ok": True})
        elif self.path == "/addition_heartbeat":
            with _addition_lock:
                _addition_last_heartbeat = time.time()
            self._send_json(200, {"ok": True})
        elif self.path == "/filter":
            self._handle_filter(payload)
        else:
            self._send_json(404, {"error": "not found"})

    def _handle_execute(self, payload):
        raw = payload.get("raw", "")
        if not raw.endswith("\n"):
            raw += "\n"
        try:
            proc = subprocess.run(
                [sys.executable, "cli.py"],
                input=raw,
                capture_output=True,
                text=True,
                cwd=PROJECT_ROOT,
                encoding="utf-8",
                errors="replace",
                env={**os.environ, "PYTHONIOENCODING": "utf-8"},
            )
            stdout = proc.stdout
            stderr = proc.stderr
        except Exception as exc:
            print(f"[lm-api] Failed to execute command: {exc}")
            self._send_json(500, {"error": str(exc)})
            return

        if stderr:
            for line in stderr.strip().splitlines():
                print(f"[lm-api] {line}")

        print(f"[lm-api] Forwarded to CLI, stdout size: {len(stdout)} chars")
        self._send_json(200, {"stdout": stdout})

    def _handle_parse(self, payload):
        text = payload.get("text", "")
        try:
            from parser import extract_commands
            commands = extract_commands(text)
            result = []
            for cmd in commands:
                result.append({
                    "name": cmd.name,
                    "arg": cmd.arg,
                    "has_content": cmd.content is not None,
                })
            self._send_json(200, {"commands": result, "count": len(result)})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def _handle_filter(self, payload):
        text = payload.get("text", "")
        try:
            from parser import extract_commands
            commands = extract_commands(text)
            lines = text.splitlines()
            actions = {
                "FILELIST": "Смотрю",
                "READFILE": "Смотрю",
                "READLINES": "Смотрю",
                "WRITEFILE": "Редактирую",
                "APPENDFILE": "Добавляю в",
                "DELETEFILE": "Удаляю",
                "RUN": "Выполняю",
                "SEARCH": "Ищу",
                "EDITLINES": "Редактирую",
                "EDIT": "Редактирую",
            }
            to_remove = set()
            replacements = {}
            for cmd in commands:
                action = actions.get(cmd.name, "Выполняю")
                replacements[cmd.start_line] = f"{action}: {cmd.arg}"
                for i in range(cmd.start_line + 1, cmd.end_line + 1):
                    to_remove.add(i)
            result_lines = []
            for i, line in enumerate(lines):
                if i in to_remove:
                    continue
                if i in replacements:
                    result_lines.append(replacements[i])
                else:
                    result_lines.append(line)

            # Убрать оставшиеся markdown-разделители и схлопнуть пустые строки
            cleaned = [ln for ln in result_lines if not ln.strip().startswith("```")]
            final_lines = []
            prev_empty = False
            for line in cleaned:
                is_empty = not line.strip()
                if is_empty and prev_empty:
                    continue
                final_lines.append(line)
                prev_empty = is_empty
            filtered = "\n".join(final_lines)
            self._send_json(200, {"filtered": filtered})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})


PORT = 11856

def main():
    port = PORT
    print(f"lm-api started on: http://localhost:{port}")
    print("[lm-api] Endpoints:")
    print("  GET  /status")
    print("  GET  /pending_inject")
    print("  GET  /pending_response")
    print("  GET  /addition_status")
    print("  POST /execute")
    print("  POST /parse")
    print("  POST /queue_inject")
    print("  POST /ai_response")
    print("  POST /addition_heartbeat")
    print("[lm-api] Press Ctrl+C to stop")
    print("")
    global _httpd
    with socketserver.ThreadingTCPServer(("127.0.0.1", port), Handler) as httpd:
        _httpd = httpd
        httpd.daemon_threads = True
        httpd.serve_forever()
        _httpd = None


if __name__ == "__main__":
    main()

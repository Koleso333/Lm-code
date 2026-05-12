import itertools
import ctypes
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request

try:
    import msvcrt
    _HAS_MSVCRT = True
except ImportError:
    _HAS_MSVCRT = False

HOST = "http://127.0.0.1:11856"


def _project_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_version():
    manifest_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "manifest.json")
    try:
        with open(manifest_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data.get("version", "1.0.0")
    except Exception:
        return "1.0.0"


def _set_console_title(title):
    try:
        ctypes.windll.kernel32.SetConsoleTitleW(title)
    except Exception:
        pass


def _is_host_running():
    try:
        req = urllib.request.Request(f"{HOST}/status", method="GET")
        with urllib.request.urlopen(req, timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False


def _is_addition_ready():
    """Проверяет, жив ли addition (расширение) по heartbeat."""
    try:
        req = urllib.request.Request(f"{HOST}/addition_status", method="GET")
        with urllib.request.urlopen(req, timeout=3) as resp:
            body = resp.read().decode("utf-8")
            data = json.loads(body)
            return data.get("ready", False)
    except Exception:
        return False


def _kill_existing_host():
    if not _is_host_running():
        return
    try:
        req = urllib.request.Request(f"{HOST}/shutdown", method="GET")
        with urllib.request.urlopen(req, timeout=5) as resp:
            pass
    except Exception:
        pass
    for _ in range(20):
        if not _is_host_running():
            return
        time.sleep(0.2)


def start_host():
    _kill_existing_host()

    lm_api_dir = os.path.join(_project_root(), "lm-api")
    env = {**os.environ, "PYTHONPATH": lm_api_dir + os.pathsep + os.environ.get("PYTHONPATH", "")}

    proc = subprocess.Popen(
        [sys.executable, "host.py"],
        cwd=lm_api_dir,
        creationflags=subprocess.CREATE_NO_WINDOW,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=env,
    )

    for attempt in range(40):
        if _is_host_running():
            return proc
        time.sleep(0.3)

    print("ОШИБКА: lm-api не запустился вовремя.")
    proc.terminate()
    sys.exit(1)


def stop_host():
    try:
        req = urllib.request.Request(f"{HOST}/shutdown", method="GET")
        with urllib.request.urlopen(req, timeout=5) as resp:
            pass
    except Exception:
        pass


def post(path, payload):
    url = f"{HOST}{path}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        print(f"HTTP ошибка {e.code}: {body}")
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            return {"error": f"HTTP {e.code}: {body}"}
    except Exception as exc:
        print(f"Ошибка запроса: {exc}")
        return {"error": str(exc)}


def get(path):
    url = f"{HOST}{path}"
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=35) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body)
    except Exception as exc:
        print(f"Ошибка запроса: {exc}")
        return {"error": str(exc)}


def _spinner(stop_event, phase, cancel_event, captcha_flag):
    labels = {"sending": "Sending", "thinking": "Thinking", "generating": "Generating"}
    captcha_shown = False
    for dots in itertools.cycle([".", "..", "..."]):
        if stop_event.is_set() or cancel_event.is_set():
            break

        # Показать сообщение о CAPTCHA один раз
        if captcha_flag[0] and not captcha_shown:
            sys.stdout.write("\r" + " " * 60 + "\r")
            sys.stdout.flush()
            print("Обнаружена CAPTCHA. Пожалуйста, перейдите в окно браузера и подтвердите капчу.")
            captcha_shown = True

        label = labels.get(phase[0], "Waiting")
        sys.stdout.write(f"\r{label}{dots}   ")
        sys.stdout.flush()
        time.sleep(0.5)
    sys.stdout.write("\r" + " " * 60 + "\r")
    sys.stdout.flush()


def _key_listener(cancel_event, stop_event):
    """Слушает Ctrl+P для отмены текущего запроса."""
    if not _HAS_MSVCRT:
        return
    while not stop_event.is_set():
        if msvcrt.kbhit():
            ch = msvcrt.getch()
            if ch == b'\x10':  # Ctrl+P
                cancel_event.set()
                return
        stop_event.wait(0.1)


def wait_for_response():
    """Ожидает ответ от AI.

    Возвращает (text, model, True) при успехе.
    Возвращает ("", "", False) если отменено через Ctrl+P.
    """
    phase = ["sending"]
    captcha_flag = [False]
    stop_event = threading.Event()
    cancel_event = threading.Event()

    def _poll_status():
        last_status = ""
        while not stop_event.is_set():
            status_data = get(f"/pending_status?since={last_status}&timeout=25")
            if not status_data.get("error"):
                new_status = status_data.get("status", "")
                last_status = new_status
                if new_status == "captcha":
                    captcha_flag[0] = True
                elif new_status:
                    captcha_flag[0] = False
                    phase[0] = new_status
                else:
                    captcha_flag[0] = False
            else:
                stop_event.wait(1)

    t_spinner = threading.Thread(target=_spinner, args=(stop_event, phase, cancel_event, captcha_flag))
    t_status = threading.Thread(target=_poll_status, daemon=True)
    t_keys = threading.Thread(target=_key_listener, args=(cancel_event, stop_event), daemon=True)
    t_spinner.start()
    t_status.start()
    t_keys.start()
    try:
        while True:
            if cancel_event.is_set():
                return "", "", False
            data = get("/pending_response?timeout=3")
            if data.get("error"):
                if cancel_event.is_set():
                    return "", "", False
                time.sleep(0.5)
                continue
            if data.get("pending"):
                return data.get("text", ""), data.get("model", ""), True
    finally:
        stop_event.set()
        t_spinner.join()


def show_response(text, model=""):
    print()
    print("===========")
    if model:
        print(f"{model}:")
    else:
        print("Ответ ИИ:")
    print()
    print(text)
    print()
    print("===========")


def has_commands(text):
    result = post("/parse", {"text": text})
    if result.get("error"):
        return False
    return bool(result.get("commands", []))


def filter_commands(text):
    result = post("/filter", {"text": text})
    if result.get("error"):
        return text
    return result.get("filtered", text)


ASCII_ART = r"""
 /$$                              /$$$$$$                  /$$
| $$                             /$$__  $$                | $$
| $$       /$$$$$$/$$$$         | $$  \__/  /$$$$$$   /$$$$$$$  /$$$$$$
| $$      | $$_  $$_  $$ /$$$$$$| $$       /$$__  $$ /$$__  $$ /$$__  $$
| $$      | $$ \ $$ \ $$|______/| $$      | $$  \ $$| $$  | $$| $$$$$$$$
| $$      | $$ | $$ | $$        | $$    $$| $$  | $$| $$  | $$| $$_____/
| $$$$$$$$| $$ | $$ | $$        |  $$$$$$/|  $$$$$$/|  $$$$$$$|  $$$$$$$
|________/|__/ |__/ |__/         \______/  \______/  \_______/ \_______/
"""


def _cli_dir():
    return os.path.dirname(os.path.abspath(__file__))


def cmd_ai_sendprotocol():
    path = os.path.join(_cli_dir(), "send_protocol.txt")
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        print(f"Ошибка: файл не найден: {path}")
        return None
    except Exception as exc:
        print(f"Ошибка чтения файла: {exc}")
        return None


def _wmic(query):
    """Run a wmic query and return non-header lines."""
    try:
        proc = subprocess.run(
            ["wmic"] + query.split(),
            capture_output=True, text=True, timeout=5,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        lines = [l.strip() for l in proc.stdout.strip().splitlines() if l.strip()]
        return [l for l in lines[1:]] if len(lines) > 1 else []
    except Exception:
        return []


def cmd_ai_sendstatus():
    import platform
    import datetime
    import shutil

    lines = []
    lines.append("=== SYSTEM STATUS ===")
    lines.append("")

    # Time
    now = datetime.datetime.now()
    lines.append(f"Current time: {now.strftime('%Y-%m-%d %H:%M:%S')}")
    tz = time.strftime("%z") or "unknown"
    lines.append(f"Timezone: {time.tzname[0]} (UTC{tz})")
    lines.append("")

    # OS
    lines.append(f"OS: {platform.system()} {platform.release()} (build {platform.version()})")
    lines.append(f"Architecture: {platform.machine()}")
    lines.append(f"Hostname: {platform.node()}")
    lines.append(f"User: {os.getlogin()}")
    lines.append("")

    # Python
    lines.append(f"Python: {platform.python_version()} ({sys.executable})")
    lines.append("")

    # CPU
    cpu = _wmic("cpu get name")
    lines.append(f"CPU: {cpu[0] if cpu else platform.processor()}")
    lines.append(f"CPU cores: {os.cpu_count()} (logical)")
    lines.append("")

    # RAM
    ram = _wmic("computersystem get totalphysicalmemory")
    if ram:
        try:
            ram_gb = int(ram[0]) / (1024 ** 3)
            lines.append(f"RAM: {ram_gb:.1f} GB")
        except ValueError:
            lines.append("RAM: unknown")
    else:
        lines.append("RAM: unknown")
    lines.append("")

    # GPU
    gpus = _wmic("path win32_videocontroller get name")
    if gpus:
        for gpu in gpus:
            lines.append(f"GPU: {gpu}")
    else:
        lines.append("GPU: unknown")
    lines.append("")

    # Disk
    try:
        total, used, free = shutil.disk_usage(os.getcwd())
        lines.append(f"Disk ({os.path.splitdrive(os.getcwd())[0]}): "
                     f"{total / (1024**3):.1f} GB total, "
                     f"{free / (1024**3):.1f} GB free")
    except Exception:
        pass
    lines.append("")

    # User home directory
    lines.append(f"Home directory: {os.path.expanduser('~')}")
    lines.append("")

    # Shell
    lines.append(f"Shell: {os.environ.get('COMSPEC', 'unknown')}")
    lines.append(f"PATH dirs: {len(os.environ.get('PATH', '').split(os.pathsep))}")
    lines.append("")
    lines.append("=== END STATUS ===")

    return "\n".join(lines)


def cmd_clear():
    os.system("cls" if os.name == "nt" else "clear")
    version = _load_version()
    print(ASCII_ART)
    print("Порт хоста: " + HOST)
    print("Введи промпт и нажми Enter")
    print("P.S. Ctrl+C — выход, Ctrl+P — отмена запроса.\n")
    return None


def cmd_help():
    print("Доступные команды:")
    print("  /ai/send_protocol — отправить содержимое send_protocol.txt в AI")
    print("  /ai/send_status   — отправить информацию о системе и времени в AI")
    print("  /clear             — очистить консоль")
    print("  /help              — показать это сообщение")
    return None


COMMANDS = {
    ("ai", "send_protocol"): cmd_ai_sendprotocol,
    ("ai", "send_status"): cmd_ai_sendstatus,
    ("clear",): cmd_clear,
    ("help",): cmd_help,
}


def handle_cli_command(text):
    parts = text[1:].split("/")
    parts = [p for p in parts if p]
    if not parts:
        print("Ошибка: пустая команда. Используй /help")
        return None

    key = tuple(parts)
    handler = COMMANDS.get(key)
    if handler is None:
        print(f"Ошибка: неизвестная команда: /{'/'.join(parts)}")
        print("Используй /help для списка команд.")
        return None

    return handler()


def framed_input():
    width = 27
    print("-" * width)
    try:
        text = input("> ")
    except EOFError:
        return None
    print("-" * width)
    return text.strip()


def main():
    host_proc = start_host()

    version = _load_version()
    _set_console_title(f"Lm-code > v{version} > Cli")

    print(ASCII_ART)
    print("Порт хоста: " + HOST)
    print("Введи промпт и нажми Enter")
    print("P.S. Ctrl+C — выход, Ctrl+P — отмена запроса.\n")

    try:
        while True:
            text = framed_input()
            if text is None:
                return
            if not text:
                continue
            if text.lower() == "quit":
                return

            if text.startswith("/"):
                prompt_text = handle_cli_command(text)
                if prompt_text is None:
                    continue
                current_text = prompt_text
            else:
                current_text = text

            while True:
                # Проверяем готовность addition перед отправкой
                if not _is_addition_ready():
                    print("ОШИБКА: Addition (расширение) не подключено или отключено.")
                    print("Убедитесь, что расширение lm-addition включено в браузере.")
                    break

                result = post("/queue_inject", {"text": current_text})
                if result.get("error"):
                    print(f"Ошибка отправки: {result['error']}")
                    break

                response_text, model, ok = wait_for_response()
                if not ok:
                    print("\nЗапрос отменён (Ctrl+P).")
                    break

                filtered = filter_commands(response_text)
                show_response(filtered, model)

                if not has_commands(response_text):
                    break

                exec_result = post("/execute", {"raw": response_text})
                if exec_result.get("error"):
                    print(f"Ошибка выполнения: {exec_result['error']}")
                    break

                stdout = exec_result.get("stdout", "")
                if stdout and stdout.strip():
                    current_text = stdout
                    continue
                break
    finally:
        if host_proc is not None:
            stop_host()
            try:
                host_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                host_proc.terminate()
                try:
                    host_proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    host_proc.kill()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nПока.")
        sys.exit(0)
    except Exception as exc:
        log_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "error.log")
        with open(log_path, "w", encoding="utf-8") as f:
            import traceback
            traceback.print_exc(file=f)
        print(f"\nКРИТИЧЕСКАЯ ОШИБКА. Лог записан в: {log_path}")
        input("Нажми Enter для выхода...")
        sys.exit(1)

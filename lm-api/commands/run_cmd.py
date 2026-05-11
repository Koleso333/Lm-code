from __future__ import annotations

import subprocess

from responses import build_answer, build_error
from utils.paths import normalize_display

DEFAULT_TIMEOUT = 60


def cmd_run(arg: str) -> str:
    if not arg:
        return build_error({
            "command": "RUN",
            "cmd": "(none)",
            "error_type": "InvalidArguments",
            "error_message": "Missing command argument in RUN(command)",
        })

    display_cmd = normalize_display(arg)

    try:
        result = subprocess.run(
            arg,
            shell=True,
            capture_output=True,
            text=True,
            timeout=DEFAULT_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return build_error({
            "command": "RUN",
            "cmd": display_cmd,
            "error_type": "Timeout",
            "error_message": f"Command timed out after {DEFAULT_TIMEOUT} seconds",
        })
    except OSError as exc:
        return build_error({
            "command": "RUN",
            "cmd": display_cmd,
            "error_type": "RunError",
            "error_message": f"Failed to execute command: {exc}",
        })

    fields = {
        "command": "RUN",
        "cmd": display_cmd,
        "exit_code": str(result.returncode),
    }
    body_sections = {
        "stdout": result.stdout,
        "stderr": result.stderr,
    }
    return build_answer(fields, body_sections=body_sections)

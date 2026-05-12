from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Optional

from responses import build_answer, build_error
from utils.paths import resolve_path, normalize_display


def _lines_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:6]


def _parse_editlines_args(arg: str) -> tuple[str, int, int]:
    parts = arg.rsplit(",", 2)
    if len(parts) < 3:
        raise ValueError("Expected three arguments: path, from, to")
    path = parts[0].strip()
    try:
        from_line = int(parts[1].strip())
        to_line = int(parts[2].strip())
    except ValueError:
        raise ValueError("Line numbers must be integers")
    if from_line < 1:
        raise ValueError("from-line must be >= 1")
    if to_line < from_line:
        raise ValueError("to-line must be >= from-line")
    return path, from_line, to_line


def cmd_editlines(arg: str, expect_hash: Optional[str], content: Optional[str]) -> str:
    if not arg:
        return build_error({
            "command": "EDITLINES",
            "path": "(none)",
            "error_type": "InvalidArguments",
            "error_message": "Missing arguments in EDITLINES(path, from, to)",
        })

    try:
        path_str, from_line, to_line = _parse_editlines_args(arg)
    except ValueError as exc:
        return build_error({
            "command": "EDITLINES",
            "path": "(none)",
            "error_type": "InvalidArguments",
            "error_message": str(exc),
        })

    display_path = normalize_display(path_str)
    try:
        target = resolve_path(path_str)
    except ValueError:
        return build_error({
            "command": "EDITLINES",
            "path": display_path,
            "error_type": "InvalidArguments",
            "error_message": "Path must be absolute",
        })

    if not target.exists():
        return build_error({
            "command": "EDITLINES",
            "path": display_path,
            "error_type": "FileNotFound",
            "error_message": "File not found",
        })

    if not target.is_file():
        return build_error({
            "command": "EDITLINES",
            "path": display_path,
            "error_type": "NotAFile",
            "error_message": "Path is not a file",
        })

    if content is None:
        return build_error({
            "command": "EDITLINES",
            "path": display_path,
            "error_type": "ParseError",
            "error_message": "Missing content block for EDITLINES",
        })

    try:
        file_text = target.read_text(encoding="utf-8")
    except PermissionError:
        return build_error({
            "command": "EDITLINES",
            "path": display_path,
            "error_type": "PermissionDenied",
            "error_message": "Permission denied",
        })
    except UnicodeDecodeError:
        return build_error({
            "command": "EDITLINES",
            "path": display_path,
            "error_type": "DecodeError",
            "error_message": "File is not valid UTF-8",
        })

    lines = file_text.splitlines(keepends=True)
    total_lines = len(lines)

    if from_line > total_lines:
        return build_error({
            "command": "EDITLINES",
            "path": display_path,
            "error_type": "OutOfRange",
            "error_message": f"from-line {from_line} exceeds file length ({total_lines} lines)",
        })

    actual_to = min(to_line, total_lines)
    old_slice = lines[from_line - 1 : actual_to]
    old_text = "".join(old_slice)
    old_text_stripped = old_text.rstrip("\n").rstrip("\r\n")
    actual_hash = _lines_hash(old_text_stripped)

    if expect_hash and expect_hash != actual_hash:
        return build_error({
            "command": "EDITLINES",
            "path": display_path,
            "error_type": "HashMismatch",
            "error_message": (
                f"Expected hash {expect_hash} but got {actual_hash}. "
                f"Lines {from_line}-{actual_to} have been modified."
            ),
        })

    new_lines = content.splitlines(keepends=True)
    if new_lines and not new_lines[-1].endswith("\n"):
        if actual_to < total_lines:
            new_lines[-1] += "\n"

    result_lines = lines[: from_line - 1] + new_lines + lines[actual_to:]
    new_text = "".join(result_lines)

    try:
        target.write_text(new_text, encoding="utf-8")
        written = target.stat().st_size
    except PermissionError:
        return build_error({
            "command": "EDITLINES",
            "path": display_path,
            "error_type": "WriteError",
            "error_message": "Permission denied",
        })
    except OSError as exc:
        return build_error({
            "command": "EDITLINES",
            "path": display_path,
            "error_type": "WriteError",
            "error_message": f"Failed to write file: {exc}",
        })

    return build_answer({
        "command": "EDITLINES",
        "path": display_path,
        "status": "OK",
        "lines_replaced": f"{from_line}-{actual_to}",
        "old_hash": actual_hash,
        "written_bytes": str(written),
    })


def cmd_edit(arg: str, old_content: Optional[str], new_content: Optional[str]) -> str:
    if not arg:
        return build_error({
            "command": "EDIT",
            "path": "(none)",
            "error_type": "InvalidArguments",
            "error_message": "Missing path argument in EDIT(path)",
        })

    display_path = normalize_display(arg)
    try:
        target = resolve_path(arg)
    except ValueError:
        return build_error({
            "command": "EDIT",
            "path": display_path,
            "error_type": "InvalidArguments",
            "error_message": "Path must be absolute",
        })

    if not target.exists():
        return build_error({
            "command": "EDIT",
            "path": display_path,
            "error_type": "FileNotFound",
            "error_message": "File not found",
        })

    if not target.is_file():
        return build_error({
            "command": "EDIT",
            "path": display_path,
            "error_type": "NotAFile",
            "error_message": "Path is not a file",
        })

    if old_content is None or new_content is None:
        return build_error({
            "command": "EDIT",
            "path": display_path,
            "error_type": "ParseError",
            "error_message": "Missing OLD_START/OLD_END or NEW_START/NEW_END block",
        })

    try:
        file_text = target.read_text(encoding="utf-8")
    except PermissionError:
        return build_error({
            "command": "EDIT",
            "path": display_path,
            "error_type": "PermissionDenied",
            "error_message": "Permission denied",
        })
    except UnicodeDecodeError:
        return build_error({
            "command": "EDIT",
            "path": display_path,
            "error_type": "DecodeError",
            "error_message": "File is not valid UTF-8",
        })

    count = file_text.count(old_content)

    if count == 0:
        return build_error({
            "command": "EDIT",
            "path": display_path,
            "error_type": "ContentNotFound",
            "error_message": "Old content not found in file",
        })

    if count > 1:
        return build_error({
            "command": "EDIT",
            "path": display_path,
            "error_type": "AmbiguousMatch",
            "error_message": f"Old content matches {count} locations; must be unique",
        })

    new_text = file_text.replace(old_content, new_content, 1)

    try:
        target.write_text(new_text, encoding="utf-8")
        written = target.stat().st_size
    except PermissionError:
        return build_error({
            "command": "EDIT",
            "path": display_path,
            "error_type": "WriteError",
            "error_message": "Permission denied",
        })
    except OSError as exc:
        return build_error({
            "command": "EDIT",
            "path": display_path,
            "error_type": "WriteError",
            "error_message": f"Failed to write file: {exc}",
        })

    return build_answer({
        "command": "EDIT",
        "path": display_path,
        "status": "OK",
        "written_bytes": str(written),
    })

from __future__ import annotations

import os
from pathlib import Path

from responses import build_answer, build_error
from utils.paths import resolve_path, normalize_display
from utils.sizes import format_size


def cmd_filelist(arg: str) -> str:
    if not arg:
        return build_error({
            "command": "FILELIST",
            "path": "(none)",
            "error_type": "InvalidArguments",
            "error_message": "Missing path argument in FILELIST(path)",
        })

    display_path = normalize_display(arg)
    try:
        target = resolve_path(arg)
    except ValueError:
        return build_error({
            "command": "FILELIST",
            "path": display_path,
            "error_type": "InvalidArguments",
            "error_message": "Path must be absolute",
        })

    if not target.exists():
        return build_error({
            "command": "FILELIST",
            "path": display_path,
            "error_type": "PathNotFound",
            "error_message": "Directory not found",
        })

    if not target.is_dir():
        return build_error({
            "command": "FILELIST",
            "path": display_path,
            "error_type": "NotADirectory",
            "error_message": "Path is not a directory",
        })

    try:
        entries = sorted(target.iterdir(), key=lambda e: e.name)
    except PermissionError:
        return build_error({
            "command": "FILELIST",
            "path": display_path,
            "error_type": "PermissionDenied",
            "error_message": "Permission denied",
        })

    items_lines: list[str] = []
    for i, entry in enumerate(entries, start=1):
        if entry.is_dir():
            kind = "folder"
            try:
                total = sum(
                    f.stat().st_size
                    for f in entry.rglob("*")
                    if f.is_file()
                )
            except (PermissionError, OSError):
                total = 0
        else:
            kind = "file"
            try:
                total = entry.stat().st_size
            except OSError:
                total = 0
        items_lines.append(f"{i}. {entry.name} ({kind}): {format_size(total)}")

    fields = {
        "command": "FILELIST",
        "path": display_path,
        "items_count": str(len(entries)),
        "items": "\n" + "\n".join(items_lines) if items_lines else "\n(empty)",
    }
    return build_answer(fields)


def cmd_readfile(arg: str) -> str:
    if not arg:
        return build_error({
            "command": "READFILE",
            "path": "(none)",
            "error_type": "InvalidArguments",
            "error_message": "Missing path argument in READFILE(path)",
        })

    display_path = normalize_display(arg)
    try:
        target = resolve_path(arg)
    except ValueError:
        return build_error({
            "command": "READFILE",
            "path": display_path,
            "error_type": "InvalidArguments",
            "error_message": "Path must be absolute",
        })

    if not target.exists():
        return build_error({
            "command": "READFILE",
            "path": display_path,
            "error_type": "FileNotFound",
            "error_message": "File not found",
        })

    if not target.is_file():
        return build_error({
            "command": "READFILE",
            "path": display_path,
            "error_type": "NotAFile",
            "error_message": "Path is not a file",
        })

    try:
        content = target.read_text(encoding="utf-8")
        size = target.stat().st_size
    except PermissionError:
        return build_error({
            "command": "READFILE",
            "path": display_path,
            "error_type": "PermissionDenied",
            "error_message": "Permission denied",
        })
    except UnicodeDecodeError:
        return build_error({
            "command": "READFILE",
            "path": display_path,
            "error_type": "DecodeError",
            "error_message": "File is not valid UTF-8",
        })

    fields = {
        "command": "READFILE",
        "path": display_path,
        "encoding": "utf-8",
        "size_bytes": str(size),
    }
    return build_answer(fields, body_sections={"content": content})


def _parse_readlines_args(arg: str) -> tuple[str, int, int]:
    parts = arg.rsplit(",", 2)
    if len(parts) < 3:
        raise ValueError("Expected three arguments: path, start, count")
    path = parts[0].strip()
    try:
        start_line = int(parts[1].strip())
        count = int(parts[2].strip())
    except ValueError:
        raise ValueError("Start and count must be integers")
    if start_line < 1:
        raise ValueError("start must be >= 1")
    if count < 1:
        raise ValueError("count must be >= 1")
    return path, start_line, count


def cmd_readlines(arg: str) -> str:
    if not arg:
        return build_error({
            "command": "READLINES",
            "path": "(none)",
            "error_type": "InvalidArguments",
            "error_message": "Missing arguments in READLINES(path, start, count)",
        })

    try:
        path_str, start_line, count = _parse_readlines_args(arg)
    except ValueError as exc:
        return build_error({
            "command": "READLINES",
            "path": "(none)",
            "error_type": "InvalidArguments",
            "error_message": str(exc),
        })

    display_path = normalize_display(path_str)
    try:
        target = resolve_path(path_str)
    except ValueError:
        return build_error({
            "command": "READLINES",
            "path": display_path,
            "error_type": "InvalidArguments",
            "error_message": "Path must be absolute",
        })

    if not target.exists():
        return build_error({
            "command": "READLINES",
            "path": display_path,
            "error_type": "FileNotFound",
            "error_message": "File not found",
        })

    if not target.is_file():
        return build_error({
            "command": "READLINES",
            "path": display_path,
            "error_type": "NotAFile",
            "error_message": "Path is not a file",
        })

    try:
        file_text = target.read_text(encoding="utf-8")
        size = target.stat().st_size
    except PermissionError:
        return build_error({
            "command": "READLINES",
            "path": display_path,
            "error_type": "PermissionDenied",
            "error_message": "Permission denied",
        })
    except UnicodeDecodeError:
        return build_error({
            "command": "READLINES",
            "path": display_path,
            "error_type": "DecodeError",
            "error_message": "File is not valid UTF-8",
        })

    lines = file_text.splitlines(keepends=True)
    total_lines = len(lines)

    if start_line > total_lines:
        return build_error({
            "command": "READLINES",
            "path": display_path,
            "error_type": "OutOfRange",
            "error_message": f"start {start_line} exceeds file length ({total_lines} lines)",
        })

    end_line = min(start_line + count - 1, total_lines)
    selected = lines[start_line - 1 : end_line]
    content = "".join(selected)

    fields = {
        "command": "READLINES",
        "path": display_path,
        "start_line": str(start_line),
        "end_line": str(end_line),
        "lines_returned": str(len(selected)),
        "total_lines": str(total_lines),
        "encoding": "utf-8",
        "size_bytes": str(size),
    }
    return build_answer(fields, body_sections={"content": content})


def cmd_writefile(arg: str, content: str | None) -> str:
    if not arg:
        return build_error({
            "command": "WRITEFILE",
            "path": "(none)",
            "error_type": "InvalidArguments",
            "error_message": "Missing path argument in WRITEFILE(path)",
        })

    display_path = normalize_display(arg)
    try:
        target = resolve_path(arg)
    except ValueError:
        return build_error({
            "command": "WRITEFILE",
            "path": display_path,
            "error_type": "InvalidArguments",
            "error_message": "Path must be absolute",
        })

    if content is None:
        return build_error({
            "command": "WRITEFILE",
            "path": display_path,
            "error_type": "ParseError",
            "error_message": "Missing content block for WRITEFILE",
        })

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        written = target.stat().st_size
    except PermissionError:
        return build_error({
            "command": "WRITEFILE",
            "path": display_path,
            "error_type": "WriteError",
            "error_message": "Permission denied",
        })
    except OSError as exc:
        return build_error({
            "command": "WRITEFILE",
            "path": display_path,
            "error_type": "WriteError",
            "error_message": f"Failed to write file: {exc}",
        })

    return build_answer({
        "command": "WRITEFILE",
        "path": display_path,
        "status": "OK",
        "written_bytes": str(written),
    })


def cmd_appendfile(arg: str, content: str | None) -> str:
    if not arg:
        return build_error({
            "command": "APPENDFILE",
            "path": "(none)",
            "error_type": "InvalidArguments",
            "error_message": "Missing path argument in APPENDFILE(path)",
        })

    display_path = normalize_display(arg)
    try:
        target = resolve_path(arg)
    except ValueError:
        return build_error({
            "command": "APPENDFILE",
            "path": display_path,
            "error_type": "InvalidArguments",
            "error_message": "Path must be absolute",
        })

    if content is None:
        return build_error({
            "command": "APPENDFILE",
            "path": display_path,
            "error_type": "ParseError",
            "error_message": "Missing content block for APPENDFILE",
        })

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        with open(target, "a", encoding="utf-8") as f:
            f.write(content)
        appended = len(content.encode("utf-8"))
    except PermissionError:
        return build_error({
            "command": "APPENDFILE",
            "path": display_path,
            "error_type": "AppendError",
            "error_message": "Permission denied",
        })
    except OSError as exc:
        return build_error({
            "command": "APPENDFILE",
            "path": display_path,
            "error_type": "AppendError",
            "error_message": f"Failed to append to file: {exc}",
        })

    return build_answer({
        "command": "APPENDFILE",
        "path": display_path,
        "status": "OK",
        "appended_bytes": str(appended),
    })


def cmd_deletefile(arg: str) -> str:
    if not arg:
        return build_error({
            "command": "DELETEFILE",
            "path": "(none)",
            "error_type": "InvalidArguments",
            "error_message": "Missing path argument in DELETEFILE(path)",
        })

    display_path = normalize_display(arg)
    try:
        target = resolve_path(arg)
    except ValueError:
        return build_error({
            "command": "DELETEFILE",
            "path": display_path,
            "error_type": "InvalidArguments",
            "error_message": "Path must be absolute",
        })

    if not target.exists():
        return build_error({
            "command": "DELETEFILE",
            "path": display_path,
            "error_type": "FileNotFound",
            "error_message": "File does not exist",
        })

    if not target.is_file():
        return build_error({
            "command": "DELETEFILE",
            "path": display_path,
            "error_type": "NotAFile",
            "error_message": "Path is not a file",
        })

    try:
        target.unlink()
    except PermissionError:
        return build_error({
            "command": "DELETEFILE",
            "path": display_path,
            "error_type": "PermissionDenied",
            "error_message": "Permission denied",
        })
    except OSError as exc:
        return build_error({
            "command": "DELETEFILE",
            "path": display_path,
            "error_type": "DeleteError",
            "error_message": f"Failed to delete file: {exc}",
        })

    return build_answer({
        "command": "DELETEFILE",
        "path": display_path,
        "status": "OK",
    })

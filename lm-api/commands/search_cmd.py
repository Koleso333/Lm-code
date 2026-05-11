from __future__ import annotations

import re
from pathlib import Path

from responses import build_answer, build_error
from utils.paths import resolve_path, normalize_display


def _parse_search_args(arg: str) -> tuple[str, str]:
    parts = arg.split(",", 1)
    if len(parts) < 2:
        raise ValueError("Expected two arguments: pattern, glob")
    pattern = parts[0].strip()
    glob_pattern = parts[1].strip()
    if not pattern:
        raise ValueError("Empty pattern")
    if not glob_pattern:
        raise ValueError("Empty glob")
    return pattern, glob_pattern


def cmd_search(arg: str) -> str:
    if not arg:
        return build_error({
            "command": "SEARCH",
            "error_type": "InvalidArguments",
            "error_message": "Missing arguments in SEARCH(pattern, glob)",
        })

    try:
        pattern, glob_pattern = _parse_search_args(arg)
    except ValueError as exc:
        return build_error({
            "command": "SEARCH",
            "error_type": "InvalidArguments",
            "error_message": str(exc),
        })

    try:
        regex = re.compile(pattern)
    except re.error as exc:
        return build_error({
            "command": "SEARCH",
            "pattern": pattern,
            "error_type": "InvalidPattern",
            "error_message": f"Bad regex: {exc}",
        })

    base = Path(".").resolve()
    matched_files = sorted(base.glob(glob_pattern))
    matched_files = [f for f in matched_files if f.is_file()]

    results: list[str] = []
    files_with_matches = 0

    for filepath in matched_files:
        try:
            text = filepath.read_text(encoding="utf-8")
        except (UnicodeDecodeError, PermissionError, OSError):
            continue

        file_matches: list[str] = []
        for lineno, line in enumerate(text.splitlines(), start=1):
            if regex.search(line):
                file_matches.append(f"  {lineno}: {line}")

        if file_matches:
            files_with_matches += 1
            try:
                rel = filepath.relative_to(base)
                display = ".\\" + str(rel).replace("/", "\\")
            except ValueError:
                display = str(filepath)
            results.append(display)
            results.extend(file_matches)

    body = "\n".join(results) if results else "(no matches)"

    fields = {
        "command": "SEARCH",
        "pattern": pattern,
        "glob": glob_pattern,
        "files_scanned": str(len(matched_files)),
        "files_matched": str(files_with_matches),
    }
    return build_answer(fields, body_sections={"results": body})

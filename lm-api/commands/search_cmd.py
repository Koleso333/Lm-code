from __future__ import annotations

import re
from pathlib import Path

from responses import build_answer, build_error
from utils.paths import normalize_display


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


def _split_absolute_glob(glob_pattern: str) -> tuple[Path, str]:
    """Split an absolute glob like S:\\src\\project\\**\\*.py into
    a base directory (S:\\src\\project) and a relative glob part (**/*.py).

    Walks path parts left-to-right; the first part containing a glob
    character (* ? [) marks where the glob portion begins.
    """
    normalised = glob_pattern.replace("\\", "/")
    parts = Path(normalised).parts  # e.g. ('S:\\', 'src', 'project', '**', '*.py')

    base_parts: list[str] = []
    glob_parts: list[str] = []
    in_glob = False
    for part in parts:
        if in_glob or any(c in part for c in ("*", "?", "[")):
            in_glob = True
            glob_parts.append(part)
        else:
            base_parts.append(part)

    if not base_parts:
        raise ValueError("Glob pattern must start with an absolute path (e.g. S:\\src\\project\\**\\*.py)")

    base = Path(*base_parts)
    rel_glob = "/".join(glob_parts) if glob_parts else "*"
    return base, rel_glob


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

    try:
        base, rel_glob = _split_absolute_glob(glob_pattern)
    except ValueError as exc:
        return build_error({
            "command": "SEARCH",
            "pattern": pattern,
            "glob": glob_pattern,
            "error_type": "InvalidGlob",
            "error_message": str(exc),
        })

    try:
        matched_files = sorted(base.glob(rel_glob))
    except (NotImplementedError, ValueError) as exc:
        return build_error({
            "command": "SEARCH",
            "pattern": pattern,
            "glob": glob_pattern,
            "error_type": "InvalidGlob",
            "error_message": f"Unsupported glob pattern: {exc}",
        })

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
            results.append(str(filepath))
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

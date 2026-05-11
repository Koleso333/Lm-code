from pathlib import Path


def resolve_path(path_str: str) -> Path:
    return Path(path_str).resolve()


def normalize_display(path_str: str) -> str:
    return path_str.strip()

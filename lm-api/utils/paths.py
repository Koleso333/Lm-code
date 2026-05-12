from pathlib import Path


def resolve_path(path_str: str) -> Path:
    normalized = normalize_display(path_str)
    path = Path(normalized)
    if not path.is_absolute():
        raise ValueError("Path must be absolute")
    return path.resolve()


def normalize_display(path_str: str) -> str:
    return path_str.strip()

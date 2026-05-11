from __future__ import annotations

import json
import os
from pathlib import Path

DEFAULT_CONFIG = {
    "auto_copy_to_clipboard": False,
}

_config: dict | None = None


def _config_path() -> Path:
    return Path(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))) / "config.json"


def load_config() -> dict:
    global _config
    path = _config_path()
    if path.exists():
        try:
            with open(path, "r", encoding="utf-8") as f:
                _config = {**DEFAULT_CONFIG, **json.load(f)}
        except (json.JSONDecodeError, OSError):
            _config = dict(DEFAULT_CONFIG)
    else:
        _config = dict(DEFAULT_CONFIG)
    return _config


def get_config() -> dict:
    if _config is None:
        return load_config()
    return _config

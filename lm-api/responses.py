from __future__ import annotations

from typing import Optional


def _wrap_block(body: str) -> str:
    return f"```txt\n{body}\n```"


def build_answer(
    fields: dict[str, str],
    body_sections: Optional[dict[str, str]] = None,
) -> str:
    lines: list[str] = ["ANSWER{"]
    for key, value in fields.items():
        lines.append(f"{key}: {value}")
    if body_sections:
        for key, content in body_sections.items():
            lines.append(f"{key}:")
            lines.append("----")
            if content:
                lines.append(content)
            lines.append("----")
    lines.append("}")
    return _wrap_block("\n".join(lines))


def build_error(fields: dict[str, str]) -> str:
    lines: list[str] = ["ANSWER_ERROR{"]
    for key, value in fields.items():
        lines.append(f"{key}: {value}")
    lines.append("}")
    return _wrap_block("\n".join(lines))

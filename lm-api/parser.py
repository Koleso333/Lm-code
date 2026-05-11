from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional


CONTENT_COMMANDS = {"WRITEFILE", "APPENDFILE"}
KNOWN_COMMANDS = {
    "FILELIST", "READFILE", "WRITEFILE", "APPENDFILE", "DELETEFILE",
    "RUN", "SEARCH", "EDITLINES", "EDIT",
}


@dataclass
class ParsedCommand:
    name: str
    arg: str
    content: Optional[str] = None
    expect_hash: Optional[str] = None
    old_content: Optional[str] = None
    new_content: Optional[str] = None
    start_line: int = 0
    end_line: int = 0


class ParseError(Exception):
    def __init__(self, message: str, command: str = "(unknown)", arg: str = "(none)"):
        super().__init__(message)
        self.command = command
        self.arg = arg


def parse_command_line(line: str) -> tuple[str, str]:
    line = line.strip()
    if not line:
        raise ParseError("Empty command line")

    paren_open = line.find("(")
    if paren_open == -1 or not line.endswith(")"):
        raise ParseError(f"Invalid command syntax: {line}")

    name = line[:paren_open].strip()
    arg = line[paren_open + 1 : -1]

    if not name:
        raise ParseError(f"Missing command name: {line}")
    if name not in KNOWN_COMMANDS:
        raise ParseError(f"Unknown command: {name}", command=name, arg=arg)

    return name, arg


def read_content_block(read_line: Callable[[], Optional[str]]) -> str:
    marker = read_line()
    if marker is None:
        raise ParseError("Unexpected EOF, expected CONTENT_START")
    if marker.strip() != "CONTENT_START":
        raise ParseError(f"Expected CONTENT_START, got: {marker.strip()}")

    lines: list[str] = []
    while True:
        line = read_line()
        if line is None:
            raise ParseError("Unexpected EOF before CONTENT_END")
        if line.strip() == "CONTENT_END":
            break
        lines.append(line)

    return "\n".join(lines)


def _read_delimited_block(
    read_line: Callable[[], Optional[str]],
    start_marker: str,
    end_marker: str,
) -> str:
    marker = read_line()
    if marker is None:
        raise ParseError(f"Unexpected EOF, expected {start_marker}")
    if marker.strip() != start_marker:
        raise ParseError(f"Expected {start_marker}, got: {marker.strip()}")

    lines: list[str] = []
    while True:
        line = read_line()
        if line is None:
            raise ParseError(f"Unexpected EOF before {end_marker}")
        if line.strip() == end_marker:
            break
        lines.append(line)

    return "\n".join(lines)


def _read_editlines_extra(
    read_line: Callable[[], Optional[str]],
    command: str,
    arg: str,
) -> tuple[str, str]:
    hash_line = read_line()
    if hash_line is None:
        raise ParseError("Unexpected EOF, expected EXPECT_HASH", command=command, arg=arg)
    stripped = hash_line.strip()
    if not stripped.startswith("EXPECT_HASH:"):
        raise ParseError(
            f"Expected EXPECT_HASH: <hash>, got: {stripped}",
            command=command, arg=arg,
        )
    expect_hash = stripped.split(":", 1)[1].strip()
    content = read_content_block(read_line)
    return expect_hash, content


def _read_edit_extra(
    read_line: Callable[[], Optional[str]],
    command: str,
    arg: str,
) -> tuple[str, str]:
    old_content = _read_delimited_block(read_line, "OLD_START", "OLD_END")
    new_content = _read_delimited_block(read_line, "NEW_START", "NEW_END")
    return old_content, new_content


def parse_command(
    first_line: str, read_line: Callable[[], Optional[str]]
) -> ParsedCommand:
    name, arg = parse_command_line(first_line)
    content: Optional[str] = None
    expect_hash: Optional[str] = None
    old_content: Optional[str] = None
    new_content: Optional[str] = None

    if name in CONTENT_COMMANDS:
        content = read_content_block(read_line)
    elif name == "EDITLINES":
        expect_hash, content = _read_editlines_extra(read_line, name, arg)
    elif name == "EDIT":
        old_content, new_content = _read_edit_extra(read_line, name, arg)

    return ParsedCommand(
        name=name, arg=arg, content=content,
        expect_hash=expect_hash,
        old_content=old_content, new_content=new_content,
    )


def extract_commands(text: str) -> list[ParsedCommand]:
    lines = text.splitlines()
    commands: list[ParsedCommand] = []
    idx = 0

    def read_line() -> Optional[str]:
        nonlocal idx
        if idx >= len(lines):
            return None
        line = lines[idx]
        idx += 1
        return line

    while idx < len(lines):
        start_line = idx
        line = lines[idx]
        stripped = line.strip()
        idx += 1

        paren = stripped.find("(")
        if paren == -1 or not stripped.endswith(")"):
            continue

        name = stripped[:paren].strip()
        if name not in KNOWN_COMMANDS:
            continue

        try:
            cmd = parse_command(stripped, read_line)
            cmd.start_line = start_line
            cmd.end_line = idx - 1
            commands.append(cmd)
        except ParseError:
            pass

    return commands

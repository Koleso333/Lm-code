from __future__ import annotations

import subprocess
import sys

from commands.file_ops import (
    cmd_filelist,
    cmd_readfile,
    cmd_readlines,
    cmd_writefile,
    cmd_appendfile,
    cmd_deletefile,
)
from commands.run_cmd import cmd_run
from commands.search_cmd import cmd_search
from commands.edit_ops import cmd_editlines, cmd_edit
from parser import parse_command, ParseError, extract_commands, KNOWN_COMMANDS
from responses import build_error


DISPATCH = {
    "FILELIST": lambda cmd: cmd_filelist(cmd.arg),
    "READFILE": lambda cmd: cmd_readfile(cmd.arg),
    "READLINES": lambda cmd: cmd_readlines(cmd.arg),
    "WRITEFILE": lambda cmd: cmd_writefile(cmd.arg, cmd.content),
    "APPENDFILE": lambda cmd: cmd_appendfile(cmd.arg, cmd.content),
    "DELETEFILE": lambda cmd: cmd_deletefile(cmd.arg),
    "RUN": lambda cmd: cmd_run(cmd.arg),
    "SEARCH": lambda cmd: cmd_search(cmd.arg),
    "EDITLINES": lambda cmd: cmd_editlines(cmd.arg, cmd.expect_hash, cmd.content),
    "EDIT": lambda cmd: cmd_edit(cmd.arg, cmd.old_content, cmd.new_content),
}


def _read_line(stdin) -> str | None:
    line = stdin.readline()
    if not line:
        return None
    return line.rstrip("\r\n")


def _emit(output: str) -> None:
    try:
        print(output, flush=True)
    except UnicodeEncodeError:
        sys.stdout.buffer.write(output.encode("utf-8", errors="replace"))
        sys.stdout.buffer.write(b"\n")
        sys.stdout.buffer.flush()


def main() -> None:
    while True:
        raw = _read_line(sys.stdin)
        if raw is None:
            break

        stripped = raw.strip()
        if not stripped:
            continue

        paren = stripped.find("(")
        if paren == -1 or not stripped.endswith(")"):
            continue
        name = stripped[:paren].strip()
        if name not in KNOWN_COMMANDS:
            continue

        try:
            cmd = parse_command(raw, lambda: _read_line(sys.stdin))
        except ParseError as exc:
            output = build_error({
                "command": exc.command,
                "path": exc.arg,
                "error_type": "ParseError",
                "error_message": str(exc),
            })
            _emit(output)
            continue

        handler = DISPATCH.get(cmd.name)
        if handler is None:
            output = build_error({
                "command": cmd.name,
                "error_type": "UnknownCommand",
                "error_message": f"No handler for command: {cmd.name}",
            })
        else:
            output = handler(cmd)

        _emit(output)


if __name__ == "__main__":
    main()

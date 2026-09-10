#!/usr/bin/env python3
"""Salvage a stored DSH session transcript into readable Markdown.

Read-only: decompresses the log through `zstdcat` and never touches the
original file. Use it when a session refuses to load (e.g. a DSH 0.1.5 V3
migration refusal — see dsh-module/INTEGRATION-NOTES.md §19) and the content
still needs to be readable.

    python3 scripts/salvage-session.py ~/.dsh/sessions/<ws>/session-<id>/session.jsonl.zstd out.md

Messages are deduplicated the way the surface does (one user message per id,
one assistant message per turn/step), split answers are joined, and mosaic's
own fold notices are dropped.
"""
from __future__ import annotations

import datetime
import json
import subprocess
import sys


def text_of(message: dict) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    parts = []
    if isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            kind = block.get("type")
            if kind == "text":
                parts.append(block.get("text", ""))
            elif kind == "tool_use":
                parts.append(f"[tool:{block.get('name')}]")
            elif kind == "tool_result":
                parts.append("[tool result]")
    return "\n".join(parts)


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__.strip().splitlines()[0])
        print("usage: salvage-session.py <session.jsonl.zstd> <out.md>")
        return 2
    src, out = argv[1], argv[2]
    raw = subprocess.run(["zstdcat", src], capture_output=True, check=True).stdout
    lines = raw.decode("utf-8", "replace").splitlines()

    seen: set[tuple] = set()
    blocks: list[str] = []
    stats = {"user": 0, "assistant": 0, "tool": 0, "dedup": 0, "notice": 0}
    for index, line in enumerate(lines):
        if index == 0 or not line.strip():
            continue  # row 0 is the session header
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind = event.get("type")
        if kind not in ("user/message", "assistant/message", "tool/result"):
            continue
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        message = data.get("message") if isinstance(data.get("message"), dict) else {}
        if kind == "user/message":
            key = ("user", data.get("id") or json.dumps(data.get("content"), ensure_ascii=False)[:80])
            if not message:
                message = {"role": "user", "content": data.get("content")}
        else:
            key = (kind, data.get("turn"), data.get("step"))
        if key in seen:
            stats["dedup"] += 1
            continue
        seen.add(key)
        text = text_of(message).strip()
        if not text:
            continue
        if "[MosaicMemory]" in text:
            stats["notice"] += 1
            continue
        stamp = datetime.datetime.fromtimestamp((event.get("time") or 0) / 1000).strftime("%m-%d %H:%M")
        if kind == "user/message":
            stats["user"] += 1
            blocks.append(f"\n## 👤 user · {stamp}\n\n{text[:4000]}")
        elif kind == "assistant/message":
            stats["assistant"] += 1
            blocks.append(f"\n### 🤖 assistant · {stamp}\n\n{text[:4000]}")
        else:
            stats["tool"] += 1

    with open(out, "w", encoding="utf-8") as handle:
        handle.write("\n".join(blocks) + "\n")
    print(f"{out}: user={stats['user']} assistant={stats['assistant']} "
          f"tool={stats['tool']} dedup_skip={stats['dedup']} mosaic_notice_skip={stats['notice']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

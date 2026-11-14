#!/usr/bin/env python3
"""给 index.html 里的脚本 / 样式地址加上内容指纹（?v=xxxxxxxx）。

GitHub Pages 会让浏览器缓存文件约 10 分钟。文件内容一变，指纹就变，地址跟着变，
浏览器就不会把「新页面」配上「旧脚本」。修改 src/ 里的文件之后、提交之前运行一次：

    python3 scripts/stamp.py

Adds a content fingerprint (?v=...) to the script / stylesheet URLs in index.html so browsers never
mix a new page with a cached old script. Run it after editing files in src/, before committing.
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"
FILES = ["src/config.js", "src/i18n.js", "src/app.js", "src/styles.css"]


def main() -> None:
    html = INDEX.read_text(encoding="utf-8")
    changed = 0
    for rel in FILES:
        digest = hashlib.sha1((ROOT / rel).read_bytes()).hexdigest()[:8]
        pattern = re.compile(r'((?:src|href)=")' + re.escape(rel) + r'(?:\?v=[0-9a-f]+)?(")')
        html, n = pattern.subn(lambda m: f"{m.group(1)}{rel}?v={digest}{m.group(2)}", html)
        if n == 0:
            raise SystemExit(f"index.html 里找不到 {rel} 的引用 / reference to {rel} not found in index.html")
        changed += n
        print(f"{rel}  ->  ?v={digest}")
    INDEX.write_text(html, encoding="utf-8")
    print(f"done ({changed} references updated)")


if __name__ == "__main__":
    main()

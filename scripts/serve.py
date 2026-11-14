#!/usr/bin/env python3
"""本地静态服务：托管 PopoutX 页面。

用法:  python3 scripts/serve.py [端口]      # 然后浏览器打开 http://127.0.0.1:47831/
只监听 127.0.0.1，不接收也不转发任何图片：抠图和导出都在浏览器里完成，图片不会离开你的电脑。
Local static server for PopoutX. Listens on 127.0.0.1 only; photos never leave your machine.
"""
from __future__ import annotations

import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 47831
# 只开放这些目录里的文件（防止通过路径读取到项目外的内容）
PUBLIC_DIRS = ("assets", "models", "vendor", "src")
TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".svg": "image/svg+xml", ".onnx": "application/octet-stream",
    ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json",
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        headers: list[tuple[str, str]] = []
        if path in ("/", "/index.html"):
            data = (ROOT / "index.html").read_bytes()
            headers = [("Content-Type", "text/html; charset=utf-8"), ("Cache-Control", "no-store")]
        elif path.startswith(tuple(f"/{d}/" for d in PUBLIC_DIRS)):
            f = (ROOT / path.lstrip("/")).resolve()
            if not any((ROOT / d).resolve() in f.parents for d in PUBLIC_DIRS) or not f.is_file():
                self.send_error(404)
                return
            data = f.read_bytes()
            headers = [("Content-Type", TYPES.get(f.suffix.lower(), "application/octet-stream"))]
            if path.startswith("/src/"):
                headers.append(("Cache-Control", "no-store"))   # 改了代码刷新即生效
        else:
            self.send_error(404)
            return
        self.send_response(200)
        for k, v in headers:
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args) -> None:
        pass


if __name__ == "__main__":
    print(f"PopoutX 已启动 / running: http://127.0.0.1:{PORT}/   (Ctrl+C 退出 / quit)")
    try:
        ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        pass

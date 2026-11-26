"""개발용 로컬 서버.

PC에서 실행하면 같은 와이파이의 태블릿에서도 접속해 볼 수 있다.
    python server.py          (기본 포트 8080)
    python server.py 9000
"""
import http.server
import socket
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".webmanifest": "application/manifest+json",
        ".png": "image/png",
        ".svg": "image/svg+xml",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


if __name__ == "__main__":
    print(f"PC에서:     http://localhost:{PORT}")
    print(f"태블릿에서: http://{lan_ip()}:{PORT}  (같은 와이파이)")
    http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()

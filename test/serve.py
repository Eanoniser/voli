#!/usr/bin/env python3
"""Dev server: serves web/ at / and test/packs at /packs/ with HTTP Range support (like the Android shell)."""
import http.server
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "..", "web")
PACKS = os.environ.get("VT_PACKS") or os.path.join(ROOT, "packs")
TYPES = {".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json",
         ".pbf": "application/x-protobuf", ".pmtiles": "application/octet-stream", ".gz": "application/octet-stream", ".svg": "image/svg+xml"}


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        path = self.path.split("?")[0]
        from urllib.parse import unquote
        path = unquote(path)
        if path.startswith("/packs-remote/"):
            fp = os.path.join(ROOT, "packs-remote", os.path.basename(path))
        elif path.startswith("/packs/"):
            fp = os.path.join(PACKS, os.path.basename(path))
        else:
            fp = os.path.join(WEB, path.lstrip("/") or "index.html")
        if os.path.isdir(fp):
            fp = os.path.join(fp, "index.html")
        if not os.path.isfile(fp):
            self.send_response(404)
            self.end_headers()
            return
        size = os.path.getsize(fp)
        rng = self.headers.get("Range")
        ctype = TYPES.get(os.path.splitext(fp)[1], "application/octet-stream")
        with open(fp, "rb") as f:
            m = re.match(r"bytes=(\d+)-(\d*)", rng or "")
            if m:
                a = int(m.group(1))
                b = min(int(m.group(2)) if m.group(2) else size - 1, size - 1)
                f.seek(a)
                data = f.read(b - a + 1)
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {a}-{b}/{size}")
            else:
                data = f.read()
                self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            self.wfile.write(data)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()

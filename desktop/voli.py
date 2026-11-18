#!/usr/bin/env python3
"""Voli for Linux and Raspberry Pi.

Runs a small local web server (127.0.0.1 only) that serves the Voli web app and the offline
map packs, downloads packs, and reads a USB GPS receiver (through gpsd, or directly from the
serial port as NMEA). Then it opens the app in Chromium (app window) or Firefox.

Python standard library only. Nothing is sent anywhere except map downloads you start.

Usage: voli.py [--no-browser] [--port N] [--data DIR] [--gps DEVICE]
"""
import argparse
import glob
import json
import os
import queue
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web") if os.path.isdir(os.path.join(HERE, "web")) else os.path.join(HERE, "..", "web")
VERSION = "0.1"
TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
    ".webp": "image/webp", ".pbf": "application/x-protobuf", ".pmtiles": "application/octet-stream",
    ".gz": "application/octet-stream", ".geojson": "application/json",
}
RANGE = re.compile(r"bytes=(\d+)-(\d*)")
UF = re.compile(r"^[a-z]{2}$")


def default_data_dir():
    base = os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    return os.path.join(base, "voli")


def load_config():
    cfg = {"packsBaseUrl": "https://github.com/OWNER/voli/releases/download/maps/"}
    path = os.path.join(HERE, "config.json")
    if os.path.isfile(path):
        try:
            cfg.update(json.load(open(path)))
        except ValueError:
            pass
    return cfg


# --------------------------------------------------------------------------- events (Server-Sent Events)
class Events:
    def __init__(self):
        self.clients = set()
        self.lock = threading.Lock()
        self.last_gps = None

    def subscribe(self):
        q = queue.Queue(maxsize=200)
        with self.lock:
            self.clients.add(q)
        if self.last_gps:
            q.put(("gps", self.last_gps))
        return q

    def unsubscribe(self, q):
        with self.lock:
            self.clients.discard(q)

    def emit(self, name, data):
        if name == "gps":
            self.last_gps = data
        with self.lock:
            for q in list(self.clients):
                try:
                    q.put_nowait((name, data))
                except queue.Full:
                    pass


EVENTS = Events()


# --------------------------------------------------------------------------- GPS
def parse_nmea_coord(value, hemi):
    if not value:
        return None
    dot = value.index(".")
    deg = float(value[: dot - 2])
    minutes = float(value[dot - 2:])
    v = deg + minutes / 60
    return -v if hemi in ("S", "W") else v


def nmea_checksum_ok(line):
    if "*" not in line:
        return False
    body, cs = line[1:].split("*", 1)
    calc = 0
    for ch in body:
        calc ^= ord(ch)
    try:
        return calc == int(cs[:2], 16)
    except ValueError:
        return False


class NmeaState:
    """Combines RMC (position, speed, course) and GGA (altitude, fix quality, HDOP) sentences."""

    def __init__(self):
        self.alt = None
        self.hdop = None
        self.sats = None

    def feed(self, line):
        line = line.strip()
        if not line.startswith("$") or not nmea_checksum_ok(line):
            return None
        f = line.split("*")[0].split(",")
        kind = f[0][3:]
        try:
            if kind == "GGA":
                if f[6] and f[6] != "0":
                    self.alt = float(f[9]) if f[9] else None
                    self.hdop = float(f[8]) if f[8] else None
                    self.sats = int(f[7]) if f[7] else None
                return None
            if kind == "RMC":
                if f[2] != "A":
                    return {"fix": False}
                lat = parse_nmea_coord(f[3], f[4])
                lon = parse_nmea_coord(f[5], f[6])
                speed = float(f[7]) * 0.514444 if f[7] else None
                course = float(f[8]) if f[8] else None
                acc = round(self.hdop * 5, 1) if self.hdop else 15.0  # rough metres from HDOP
                return {"fix": True, "lat": lat, "lon": lon, "alt": self.alt, "speed": speed, "heading": course,
                        "accuracy": acc, "sats": self.sats, "source": "nmea"}
        except (ValueError, IndexError):
            return None
        return None


class GpsReader(threading.Thread):
    """Reads position from gpsd (localhost:2947) or, if gpsd is not running, directly from a USB GPS."""

    def __init__(self, device=None):
        super().__init__(daemon=True)
        self.device = device
        self.status = "procurando"

    def run(self):
        while True:
            if not self.device:
                try:
                    self.read_gpsd()
                except OSError:
                    pass
            dev = self.device or self.find_serial()
            if dev:
                try:
                    self.read_serial(dev)
                except OSError as e:
                    self.status = f"erro no GPS {dev}: {e.strerror or e}"
            else:
                self.status = "nenhum GPS encontrado"
            EVENTS.emit("gpsStatus", {"status": self.status})
            time.sleep(5)

    def read_gpsd(self):
        with socket.create_connection(("127.0.0.1", 2947), timeout=3) as s:
            s.settimeout(30)
            s.sendall(b'?WATCH={"enable":true,"json":true}\n')
            self.status = "gpsd"
            EVENTS.emit("gpsStatus", {"status": "conectado ao gpsd"})
            buf = b""
            while True:
                chunk = s.recv(4096)
                if not chunk:
                    return
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    try:
                        msg = json.loads(line)
                    except ValueError:
                        continue
                    if msg.get("class") != "TPV":
                        continue
                    if msg.get("mode", 0) < 2 or "lat" not in msg:
                        EVENTS.emit("gps", {"fix": False})
                        continue
                    acc = msg.get("eph") or max(msg.get("epx", 0) or 0, msg.get("epy", 0) or 0) or 15
                    EVENTS.emit("gps", {
                        "fix": True, "lat": msg["lat"], "lon": msg["lon"], "alt": msg.get("altMSL", msg.get("alt")),
                        "speed": msg.get("speed"), "heading": msg.get("track"), "accuracy": round(acc, 1), "source": "gpsd",
                    })

    @staticmethod
    def find_serial():
        for pattern in ("/dev/ttyACM*", "/dev/ttyUSB*", "/dev/serial0"):
            for dev in sorted(glob.glob(pattern)):
                if os.access(dev, os.R_OK):
                    return dev
        return None

    def read_serial(self, dev):
        if dev.startswith("/dev/") and shutil.which("stty"):
            subprocess.run(["stty", "-F", dev, "9600", "raw", "-echo"], stderr=subprocess.DEVNULL, check=False)
        state = NmeaState()
        self.status = f"GPS em {dev}"
        EVENTS.emit("gpsStatus", {"status": self.status})
        with open(dev, "rb", buffering=0) as f:
            buf = b""
            while True:
                chunk = f.read(256)
                if not chunk:
                    if not dev.startswith("/dev/"):
                        return  # test files end
                    time.sleep(0.2)
                    continue
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    fix = state.feed(line.decode("ascii", "replace"))
                    if fix:
                        EVENTS.emit("gps", fix)


# --------------------------------------------------------------------------- packs
class Packs:
    def __init__(self, data_dir):
        self.dir = os.path.join(data_dir, "packs")
        os.makedirs(self.dir, exist_ok=True)
        self.downloads = {}

    def list(self):
        out = {}
        names = os.listdir(self.dir)
        for n in names:
            if not n.endswith(".meta.json"):
                continue
            uf = n[: -len(".meta.json")]
            files = {g: os.path.getsize(os.path.join(self.dir, g)) for g in names
                     if not g.endswith(".meta.json") and (g.startswith(uf + ".") or g.startswith(uf + "-"))}
            try:
                meta = json.load(open(os.path.join(self.dir, n)))
            except ValueError:
                meta = {}
            out[uf] = {"meta": meta, "files": files}
        return out

    def delete(self, uf):
        if not UF.match(uf):
            return False
        for n in os.listdir(self.dir):
            if n.startswith(uf + ".") or n.startswith(uf + "-"):
                os.remove(os.path.join(self.dir, n))
        return True

    def start(self, uf, files, meta):
        if not UF.match(uf) or uf in self.downloads:
            return
        cancel = threading.Event()
        self.downloads[uf] = cancel
        threading.Thread(target=self._download, args=(uf, files, meta, cancel), daemon=True).start()

    def cancel(self, uf):
        ev = self.downloads.get(uf)
        if ev:
            ev.set()

    def _download(self, uf, files, meta, cancel):
        tmp = os.path.join(self.dir, ".tmp-" + uf)
        os.makedirs(tmp, exist_ok=True)
        total = sum(int(f.get("size") or 0) for f in files)
        done_before = 0
        last = 0
        try:
            for f in files:
                name = os.path.basename(f["name"])
                expected = int(f.get("size") or -1)
                out = os.path.join(tmp, name)
                have = os.path.getsize(out) if os.path.isfile(out) else 0
                if expected > 0 and have == expected:
                    done_before += have
                    continue
                req = urllib.request.Request(f["url"], headers={"User-Agent": f"Voli/{VERSION} (Linux)"})
                if have:
                    req.add_header("Range", f"bytes={have}-")
                with urllib.request.urlopen(req, timeout=60) as r:
                    append = r.status == 206 and have > 0
                    got = have if append else 0
                    with open(out, "ab" if append else "wb") as w:
                        while True:
                            if cancel.is_set():
                                raise InterruptedError("cancelado")
                            chunk = r.read(256 * 1024)
                            if not chunk:
                                break
                            w.write(chunk)
                            got += len(chunk)
                            now = time.time()
                            if now - last > 0.5:
                                last = now
                                EVENTS.emit("progress", {"uf": uf, "file": name, "done": done_before + got, "total": total})
                if expected > 0 and got != expected:
                    raise IOError(f"arquivo incompleto: {name}")
                done_before += got
            for f in files:
                name = os.path.basename(f["name"])
                os.replace(os.path.join(tmp, name), os.path.join(self.dir, name))
            with open(os.path.join(self.dir, uf + ".meta.json"), "w") as m:
                json.dump(meta, m)
            shutil.rmtree(tmp, ignore_errors=True)
            EVENTS.emit("downloaded", {"uf": uf})
        except Exception as e:  # noqa: BLE001 - report every failure to the UI
            if cancel.is_set():
                shutil.rmtree(tmp, ignore_errors=True)
            EVENTS.emit("downloadError", {"uf": uf, "message": "cancelado" if cancel.is_set() else str(e)})
        finally:
            self.downloads.pop(uf, None)


# --------------------------------------------------------------------------- system helpers
def is_wifi_or_cable():
    """True when connected by Wi-Fi or cable (not a phone's mobile data over USB, which shows as usb*/wwan*)."""
    for path in glob.glob("/sys/class/net/*"):
        name = os.path.basename(path)
        if name == "lo" or name.startswith(("wwan", "usb", "ppp", "rmnet")):
            continue
        try:
            if open(os.path.join(path, "operstate")).read().strip() == "up":
                return True
        except OSError:
            continue
    return False


def speak(text):
    for cmd in (["spd-say", "-l", "pt-BR", "-w", text], ["espeak-ng", "-v", "pt-br", text], ["espeak", "-v", "pt", text]):
        if shutil.which(cmd[0]):
            subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True
    return False


# --------------------------------------------------------------------------- HTTP server
class Handler(BaseHTTPRequestHandler):
    server_version = "Voli"
    packs = None
    config = None

    def log_message(self, *a):
        pass

    # --- helpers
    def send_json(self, obj, status=200):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def send_file(self, path, inject=False):
        if not os.path.isfile(path):
            self.send_error(404)
            return
        ctype = TYPES.get(os.path.splitext(path)[1], "application/octet-stream")
        if inject:  # add the desktop bridge to index.html
            html = open(path, encoding="utf-8").read().replace(
                '<script type="module" src="js/app.js"></script>',
                '<script src="/desktop-bridge.js"></script>\n  <script type="module" src="js/app.js"></script>')
            data = html.encode()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)
            return
        size = os.path.getsize(path)
        m = RANGE.match(self.headers.get("Range") or "")
        with open(path, "rb") as f:
            if m:
                a = int(m.group(1))
                b = min(int(m.group(2)) if m.group(2) else size - 1, size - 1)
                if a >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.end_headers()
                    return
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
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)

    # --- routes
    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(url.path)
        qs = urllib.parse.parse_qs(url.query)
        if path == "/api/config":
            return self.send_json({**self.config, "appVersion": VERSION, "platform": "linux"})
        if path == "/api/packs":
            return self.send_json(self.packs.list())
        if path == "/api/free":
            return self.send_json({"bytes": shutil.disk_usage(self.packs.dir).free})
        if path == "/api/wifi":
            return self.send_json({"ok": is_wifi_or_cable()})
        if path == "/api/fetch":
            target = qs.get("url", [""])[0]
            allow_http = os.environ.get("VOLI_ALLOW_HTTP") == "1"  # tests only
            if not (target.startswith("https://") or (allow_http and target.startswith("http://127.0.0.1"))):
                return self.send_json({"ok": False, "error": "url inválida"}, 400)
            try:
                req = urllib.request.Request(target, headers={"User-Agent": f"Voli/{VERSION} (Linux)"})
                with urllib.request.urlopen(req, timeout=30) as r:
                    return self.send_json({"ok": True, "status": r.status, "body": r.read().decode("utf-8")})
            except Exception as e:  # noqa: BLE001
                return self.send_json({"ok": False, "error": str(e)})
        if path == "/api/events":
            return self.events()
        if path == "/desktop-bridge.js":
            return self.send_file(os.path.join(HERE, "desktop-bridge.js"))
        if path.startswith("/packs/"):
            name = os.path.basename(path)
            if name.startswith("."):
                return self.send_error(404)
            return self.send_file(os.path.join(self.packs.dir, name))
        rel = os.path.normpath(path.lstrip("/") or "index.html")
        if rel.startswith(".."):
            return self.send_error(404)
        full = os.path.join(WEB, rel)
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        return self.send_file(full, inject=full.endswith(os.sep + "index.html") and rel in ("index.html", "."))

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        body = self.read_json()
        if path == "/api/download":
            self.packs.start(body.get("uf", ""), body.get("files", []), body.get("meta", {}))
            return self.send_json({"ok": True})
        if path == "/api/cancel":
            self.packs.cancel(body.get("uf", ""))
            return self.send_json({"ok": True})
        if path == "/api/delete":
            return self.send_json({"ok": self.packs.delete(body.get("uf", ""))})
        if path == "/api/speak":
            return self.send_json({"ok": speak(str(body.get("text", ""))[:300])})
        self.send_error(404)

    def events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        q = EVENTS.subscribe()
        try:
            self.wfile.write(b": ok\n\n")
            self.wfile.flush()
            while True:
                try:
                    name, data = q.get(timeout=15)
                    self.wfile.write(f"event: {name}\ndata: {json.dumps(data)}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            EVENTS.unsubscribe(q)


def open_browser(url, profile):
    """Returns the browser process when closing its window should also stop Voli (own Chromium profile)."""
    for name in ("chromium", "chromium-browser", "google-chrome", "brave-browser", "microsoft-edge"):
        exe = shutil.which(name)
        if exe:
            return subprocess.Popen([exe, f"--app={url}", f"--user-data-dir={profile}", "--no-first-run",
                                     "--no-default-browser-check", "--disable-features=Translate", "--window-size=1100,800"])
    for name in ("firefox", "firefox-esr"):
        exe = shutil.which(name)
        if exe:
            subprocess.Popen([exe, "--new-window", url])
            return None
    if shutil.which("xdg-open"):
        subprocess.Popen(["xdg-open", url])
        return None
    print("Abra no navegador:", url)
    return None


def main():
    ap = argparse.ArgumentParser(description="Voli: mapas offline para Linux e Raspberry Pi")
    ap.add_argument("--port", type=int, default=8737)
    ap.add_argument("--data", default=default_data_dir())
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--gps", help="dispositivo do GPS USB (ex.: /dev/ttyACM0). Padrão: gpsd ou detecção automática")
    args = ap.parse_args()

    os.makedirs(args.data, exist_ok=True)
    Handler.packs = Packs(args.data)
    Handler.config = load_config()
    port = args.port
    for _ in range(20):
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            port += 1
    else:
        sys.exit("Não foi possível abrir uma porta local.")
    httpd.daemon_threads = True
    GpsReader(args.gps).start()
    url = f"http://127.0.0.1:{port}/index.html"
    print(f"Voli rodando em {url}  (mapas em {Handler.packs.dir})", flush=True)
    browser = None if args.no_browser else open_browser(url, os.path.join(args.data, "browser"))
    if browser:
        threading.Thread(target=lambda: (browser.wait(), time.sleep(1), os._exit(0)), daemon=True).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

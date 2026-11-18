#!/usr/bin/env python3
"""End-to-end test of the Linux / Raspberry Pi build:
installs it into a fake home, serves a real pipeline pack from a local "release", fakes gpsd,
then drives the app in headless Chromium: download a state, see the map, get the GPS position."""
import json
import os
import shutil
import socket
import subprocess
import sys
import tarfile
import threading
import time

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACK_SRC = os.environ.get("VT_PACKS", "/tmp/pipeout")  # output of pipeline/build_state.sh
WORK = "/tmp/voli-desktop-test"
shutil.rmtree(WORK, ignore_errors=True)
os.makedirs(WORK)
HOME = os.path.join(WORK, "home")
os.makedirs(HOME)
REMOTE_PORT, APP_PORT = 8851, 8850
LON0, LAT0 = -46.40, -23.50

# 1. Build the Linux package exactly like the GitHub workflow
dist = os.path.join(WORK, "dist", "voli-linux")
os.makedirs(dist)
shutil.copytree(os.path.join(ROOT, "web"), os.path.join(dist, "web"))
for f in ("voli.py", "desktop-bridge.js", "voli.png", "install.sh", "uninstall.sh", "README.txt"):
    shutil.copy(os.path.join(ROOT, "desktop", f), dist)
json.dump({"packsBaseUrl": f"http://127.0.0.1:{REMOTE_PORT}/"}, open(os.path.join(dist, "config.json"), "w"))
with tarfile.open(os.path.join(WORK, "voli-linux.tar.gz"), "w:gz") as t:
    t.add(dist, arcname="voli-linux")
print("package:", os.path.getsize(os.path.join(WORK, "voli-linux.tar.gz")) // 1024, "KB")

# 2. Install into a fake home (answer "no" to the optional questions)
env = dict(os.environ, HOME=HOME, XDG_DATA_HOME=os.path.join(HOME, ".local", "share"))
r = subprocess.run(["bash", os.path.join(dist, "install.sh")], input="n\nn\n", text=True, env=env, capture_output=True)
print(r.stdout.strip().splitlines()[-1] if r.stdout else r.stderr)
assert os.path.isfile(os.path.join(HOME, ".local", "bin", "voli")), "launcher missing"
assert os.path.isfile(os.path.join(HOME, ".local", "share", "applications", "voli.desktop")), "menu entry missing"

# 3. A local "GitHub release" with the real pack built by the pipeline + manifest
remote = os.path.join(WORK, "remote")
os.makedirs(remote)
for n in os.listdir(PACK_SRC):
    if n.startswith("sp"):
        shutil.copy(os.path.join(PACK_SRC, n), remote)
subprocess.check_call([sys.executable, os.path.join(ROOT, "pipeline", "make_manifest.py"), remote, os.path.join(remote, "manifest.json")])
remote_srv = subprocess.Popen([sys.executable, "-m", "http.server", str(REMOTE_PORT), "--bind", "127.0.0.1"], cwd=remote,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

# 4. Fake gpsd on port 2947 walking along "Rua 2" of the synthetic town
def fake_gpsd():
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 2947))
    srv.listen(1)
    while True:
        c, _ = srv.accept()
        c.recv(1024)
        c.sendall(b'{"class":"VERSION","release":"3.25"}\n')
        i = 0
        try:
            while True:
                tpv = {"class": "TPV", "mode": 3, "lat": LAT0 + 0.0014, "lon": LON0 + 0.0016 + i * 0.00002,
                       "altMSL": 742.5, "speed": 1.2, "track": 90.0, "eph": 4.2}
                c.sendall((json.dumps(tpv) + "\n").encode())
                i += 1
                time.sleep(0.5)
        except OSError:
            c.close()


threading.Thread(target=fake_gpsd, daemon=True).start()

# 5. Start Voli (installed launcher) without opening a browser
app = subprocess.Popen([os.path.join(HOME, ".local", "bin", "voli"), "--no-browser", "--port", str(APP_PORT)],
                       env=dict(env, VOLI_ALLOW_HTTP="1"), stdout=subprocess.PIPE, text=True)
print(app.stdout.readline().strip())

shots = os.path.join(ROOT, "test", "shots-linux")
os.makedirs(shots, exist_ok=True)
errors = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        ctx = b.new_context(viewport={"width": 1100, "height": 760}, locale="pt-BR")
        ctx.add_init_script("localStorage.setItem('vt.disclaimer','1');")
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))
        page.goto(f"http://127.0.0.1:{APP_PORT}/index.html")
        page.wait_for_function("window.__vt && window.__vt.map", timeout=40000)
        page.wait_for_timeout(3000)
        # Maps panel opens by itself when nothing is installed; the manifest comes from the local release
        page.wait_for_selector("text=São Paulo (SP)", timeout=20000)
        page.wait_for_timeout(1000)
        page.screenshot(path=os.path.join(shots, "1-mapas.png"))
        page.locator(".list-item", has_text="São Paulo (SP)").locator("button", has_text="Baixar").click()
        page.wait_for_function("window.VoliNative && JSON.parse(window.VoliNative.listPacks()).sp", timeout=60000)
        print("installed:", sorted(json.loads(page.evaluate("window.VoliNative.listPacks()"))["sp"]["files"]))
        page.wait_for_timeout(4000)
        page.click("#bottombar button[data-panel=survival]")
        page.wait_for_timeout(1500)
        live = page.inner_text("#surv-live")
        print("survival panel:", " | ".join(live.split("\n")[:6]))
        page.screenshot(path=os.path.join(shots, "2-gps-usb.png"))
        page.click("#bottombar button[data-panel=survival]")
        page.click("#btn-locate")
        page.wait_for_timeout(2500)
        page.fill("#search-input", "hospital")
        page.wait_for_timeout(1200)
        page.click("#search-results .result")
        page.wait_for_timeout(3000)
        print("route:", page.inner_text("#sheet-content")[:120].replace("\n", " | "))
        page.screenshot(path=os.path.join(shots, "3-rota.png"))
        b.close()
finally:
    app.terminate()
    remote_srv.terminate()
print("\n".join(errors) if errors else "no page errors")

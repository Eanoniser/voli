#!/usr/bin/env python3
"""End-to-end smoke test in headless Chromium with the synthetic pack. Saves screenshots to test/shots/."""
import json
import os
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, "shots")
os.makedirs(SHOTS, exist_ok=True)
PORT = 8765
LON0, LAT0 = -46.40, -23.50
ME = {"longitude": LON0 + 0.0016 * 1 + 0.0002, "latitude": LAT0 + 0.0014 * 1}

server = subprocess.Popen([sys.executable, os.path.join(HERE, "serve.py"), str(PORT)])
time.sleep(0.8)
errors = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        ctx = b.new_context(viewport={"width": 412, "height": 860}, device_scale_factor=2, geolocation=ME, permissions=["geolocation"], locale="pt-BR")
        packs = {"sp": {"meta": {"date": "2026-11-08T00:00:00Z", "uf": "sp"}, "files": {
            "sp.pmtiles": 1, "sp-terrain.pmtiles": 1, "sp.route.gz": 1, "sp.search.json.gz": 1}}}
        ctx.add_init_script(f"""
            localStorage.setItem('vt.devPacks', {json.dumps(json.dumps(packs))});
            localStorage.setItem('vt.disclaimer', '1');
            localStorage.setItem('vt.settings', JSON.stringify({{theme: 'day'}}));
            localStorage.setItem('vt.view', JSON.stringify({{center: [{LON0 + 0.008}, {LAT0 + 0.007}], zoom: 14.5}}));
        """)
        page = ctx.new_page()
        page.on("console", lambda m: m.type in ("error", "warning") and errors.append(f"{m.type}: {m.text}"))
        page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
        page.goto(f"http://127.0.0.1:{PORT}/index.html")
        page.wait_for_function("window.__vt && window.__vt.map && window.__vt.map.loaded()", timeout=30000)
        page.wait_for_timeout(2500)
        page.screenshot(path=os.path.join(SHOTS, "01-map-day.png"))
        page.evaluate("window.__vt.map.jumpTo({center: [-50, -12], zoom: 1.6, pitch: 0, bearing: 0})")
        page.wait_for_timeout(3500)
        page.screenshot(path=os.path.join(SHOTS, "00a-world-globe.png"))
        page.evaluate("window.__vt.map.jumpTo({center: [-52, -14.5], zoom: 3.4})")
        page.wait_for_timeout(3500)
        page.screenshot(path=os.path.join(SHOTS, "00b-brazil.png"))
        page.click("#bottombar button[data-panel=settings]")
        page.wait_for_timeout(800)
        page.screenshot(path=os.path.join(SHOTS, "00c-settings.png"))
        page.evaluate("document.querySelector('#sheet').scrollTop = 1400")
        page.wait_for_timeout(400)
        page.screenshot(path=os.path.join(SHOTS, "00d-settings-2.png"))
        page.click("#bottombar button[data-panel=settings]")
        page.evaluate(f"window.__vt.map.jumpTo({{center: [{LON0 + 0.008}, {LAT0 + 0.007}], zoom: 14.5}})")
        page.wait_for_timeout(2500)

        # Search
        page.fill("#search-input", "hospital")
        page.wait_for_timeout(900)
        page.screenshot(path=os.path.join(SHOTS, "02-search.png"))
        page.click("#search-results .result")
        page.wait_for_timeout(2500)
        page.screenshot(path=os.path.join(SHOTS, "03-route-summary.png"))
        r = page.evaluate("window.__vt.route && {d: window.__vt.route.distance, steps: window.__vt.route.steps.map(s => s.text)}")
        print("route to hospital:", r)

        # Route to the farm (dirt road + ford) -> should warn or refuse
        page.evaluate(f"window.__vt.chooseDestination({LON0 + 0.008 + 0.0015}, {LAT0 + 0.0126 + 0.006}, 'Fazenda', 'teste', true)")
        page.wait_for_timeout(2000)
        page.screenshot(path=os.path.join(SHOTS, "04-farm-route.png"))
        print("farm sheet:", page.inner_text("#sheet-content")[:300].replace("\n", " | "))

        # Highway destination and navigation in 3D
        page.evaluate(f"window.__vt.chooseDestination({LON0 + 0.0144 + 0.05}, {LAT0 + 0.0056 + 0.0085}, 'Povoado Leste', 'teste', true)")
        page.wait_for_timeout(2000)
        print("east sheet:", page.inner_text("#sheet-content")[:200].replace("\n", " | "))
        page.evaluate("window.__vt.startNavigation()")
        page.wait_for_timeout(3500)
        page.screenshot(path=os.path.join(SHOTS, "05-navigation-3d.png"))
        page.click("#nav-stop")
        page.wait_for_timeout(800)

        # Survival panel
        page.click("#bottombar button[data-panel=survival]")
        page.wait_for_timeout(1200)
        page.screenshot(path=os.path.join(SHOTS, "06-survival.png"))

        # Packs panel
        page.click("#bottombar button[data-panel=packs]")
        page.wait_for_timeout(1500)
        page.screenshot(path=os.path.join(SHOTS, "07-packs.png"))
        page.click("#bottombar button[data-panel=packs]")

        # Night + 3D terrain view of the hills
        page.evaluate("window.__vt.setTheme('night')")
        page.wait_for_timeout(1500)
        page.evaluate(f"window.__vt.map.jumpTo({{center: [{LON0 + 0.01}, {LAT0 + 0.012}], zoom: 13.6, pitch: 65, bearing: 20}})")
        page.wait_for_timeout(3500)
        page.screenshot(path=os.path.join(SHOTS, "08-night-3d.png"))

        # SOS
        page.click("#bottombar button[data-panel=survival]")
        page.wait_for_timeout(600)
        page.click("text=SOS / Emergência")
        page.wait_for_timeout(500)
        page.screenshot(path=os.path.join(SHOTS, "09-sos.png"))
        b.close()
finally:
    server.terminate()

print("\n".join(errors) if errors else "no console errors")

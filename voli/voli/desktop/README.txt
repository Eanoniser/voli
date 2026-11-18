Voli for Linux and Raspberry Pi
================================

Install:   ./install.sh        (then open "Voli" from the applications menu, or run: voli)
Uninstall: ./uninstall.sh      (add --all to also delete downloaded maps)

Requirements: Python 3 (already included in most Linux systems) and a web browser.
Optional (free, run only on your device, send no data):
  - chromium   opens Voli in its own window (otherwise Firefox is used)
  - espeak-ng  speaks turn-by-turn instructions
  - gpsd       reads the USB GPS (Voli can also read most USB GPS receivers directly)

GPS: computers and the Raspberry Pi usually have no GPS. Plug in a USB GPS receiver
(u-blox and similar NMEA receivers work). Voli finds it on /dev/ttyACM* or /dev/ttyUSB*,
or uses gpsd when it is running. To choose a device: voli --gps /dev/ttyACM0

Maps are stored in ~/.local/share/voli/packs

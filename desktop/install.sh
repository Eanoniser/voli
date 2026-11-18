#!/usr/bin/env bash
# Install Voli for the current user (no root needed for the app itself).
# Works on Ubuntu, Debian, Fedora, Arch, Raspberry Pi OS and other desktop Linux systems.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
APP="${XDG_DATA_HOME:-$HOME/.local/share}/voli/app"
BIN="$HOME/.local/bin"
DESK="${XDG_DATA_HOME:-$HOME/.local/share}/applications"

command -v python3 >/dev/null || { echo "Voli precisa do Python 3. Instale com: sudo apt install python3"; exit 1; }

echo "Instalando o Voli em $APP"
mkdir -p "$APP" "$BIN" "$DESK"
rm -rf "$APP"/web
cp -r "$SRC"/web "$SRC"/voli.py "$SRC"/desktop-bridge.js "$SRC"/voli.png "$APP"/
[ -f "$SRC/config.json" ] && cp "$SRC/config.json" "$APP"/

cat > "$BIN/voli" <<LAUNCH
#!/usr/bin/env bash
exec python3 "$APP/voli.py" "\$@"
LAUNCH
chmod +x "$BIN/voli"

cat > "$DESK/voli.desktop" <<ENTRY
[Desktop Entry]
Type=Application
Name=Voli
GenericName=Mapas offline
Comment=Mapas offline de sobrevivência com rotas, relevo 3D e GPS
Exec=$BIN/voli
Icon=$APP/voli.png
Terminal=false
Categories=Utility;Maps;Geography;
Keywords=mapa;gps;offline;rota;navegação;
ENTRY
command -v update-desktop-database >/dev/null && update-desktop-database "$DESK" >/dev/null 2>&1 || true

echo
echo "Pronto! Abra o Voli pelo menu de aplicativos ou digitando: voli"
echo

# Optional extras (asked, never forced)
if command -v apt-get >/dev/null; then
  missing=()
  command -v chromium >/dev/null || command -v chromium-browser >/dev/null || missing+=("chromium")
  command -v espeak-ng >/dev/null || command -v spd-say >/dev/null || missing+=("espeak-ng")
  if [ ${#missing[@]} -gt 0 ]; then
    echo "Opcional: ${missing[*]}"
    echo "  chromium  = abre o Voli numa janela própria (senão usa o Firefox)"
    echo "  espeak-ng = fala as instruções da rota em voz alta"
    read -r -p "Instalar agora com apt? (precisa da senha de administrador) [s/N] " ans || ans=n
    if [[ "$ans" =~ ^[sSyY] ]]; then sudo apt-get install -y "${missing[@]}" || true; fi
  fi
fi

# USB GPS access: the serial port belongs to the "dialout" group
if getent group dialout >/dev/null && ! id -nG "$USER" | grep -qw dialout; then
  echo
  echo "Para ler um GPS USB, seu usuário precisa estar no grupo 'dialout'."
  read -r -p "Adicionar agora? (precisa da senha de administrador; vale depois de sair e entrar de novo) [s/N] " ans || ans=n
  if [[ "$ans" =~ ^[sSyY] ]]; then sudo usermod -aG dialout "$USER" && echo "Feito. Saia da sessão e entre de novo."; fi
fi

#!/usr/bin/env bash
# Remove Voli. Downloaded maps are kept unless you pass --all.
set -euo pipefail
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/voli"
rm -f "$HOME/.local/bin/voli" "${XDG_DATA_HOME:-$HOME/.local/share}/applications/voli.desktop"
rm -rf "$DATA/app"
if [ "${1:-}" = "--all" ]; then rm -rf "$DATA"; echo "Voli e mapas removidos."; else echo "Voli removido. Mapas mantidos em $DATA/packs (use --all para apagar)."; fi

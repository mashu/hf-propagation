#!/usr/bin/env bash
#
# HF Propagation – GNOME Shell extension installer
#
#   ./install.sh              install or update for the current user
#   ./install.sh --pack       build hf-propagation@mashu.github.io.shell-extension.zip
#   ./install.sh --uninstall  remove the extension
#
set -euo pipefail

UUID="hf-propagation@mashu.github.io"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
DEST="$EXT_ROOT/$UUID"

FILES=(extension.js prefs.js metadata.json stylesheet.css stylesheet-light.css)
DIRS=(lib icons schemas)

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  \033[36m•\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

shell_major() {
    gnome-shell --version 2>/dev/null | sed -n 's/^GNOME Shell \([0-9]*\).*/\1/p'
}

check_version() {
    local major
    major="$(shell_major)"
    if [[ -z "$major" ]]; then
        warn "Could not determine the GNOME Shell version"
        return
    fi
    info "GNOME Shell $major detected"
    if ! grep -q "\"$major\"" "$SRC_DIR/metadata.json"; then
        warn "GNOME Shell $major is not listed in metadata.json; the extension may be marked as out of date"
    fi
}

pack() {
    bold "Packing $UUID"
    command -v gnome-extensions >/dev/null || die "gnome-extensions tool not found"
    gnome-extensions pack "$SRC_DIR" --force --out-dir="$SRC_DIR" \
        --extra-source=lib --extra-source=icons
    ok "Created $SRC_DIR/$UUID.shell-extension.zip"
    info "Install it with: gnome-extensions install --force $UUID.shell-extension.zip"
}

uninstall() {
    bold "Removing $UUID"
    gnome-extensions disable "$UUID" 2>/dev/null || true
    rm -rf "$DEST"
    ok "Removed $DEST"
}

install() {
    bold "Installing HF Propagation"
    check_version

    for f in "${FILES[@]}"; do
        [[ -f "$SRC_DIR/$f" ]] || die "Missing $f – run this script from the repository"
    done
    for d in "${DIRS[@]}"; do
        [[ -d "$SRC_DIR/$d" ]] || die "Missing $d/ – run this script from the repository"
    done
    command -v glib-compile-schemas >/dev/null || die "glib-compile-schemas not found (install glib2 / libglib2.0-bin)"

    rm -rf "$DEST"
    mkdir -p "$DEST"
    for f in "${FILES[@]}"; do
        cp "$SRC_DIR/$f" "$DEST/"
    done
    for d in "${DIRS[@]}"; do
        cp -r "$SRC_DIR/$d" "$DEST/"
    done
    rm -f "$DEST/schemas/gschemas.compiled"
    glib-compile-schemas "$DEST/schemas"
    ok "Files installed to $DEST"

    if gnome-extensions enable "$UUID" 2>/dev/null; then
        ok "Extension enabled"
    else
        warn "GNOME Shell has not seen the extension yet"
    fi

    echo
    if gnome-extensions info "$UUID" 2>/dev/null | grep -qE 'State: (ACTIVE|ENABLED)'; then
        ok "HF Propagation is running – look for the antenna icon in the top bar"
    else
        bold "Almost done"
        info "GNOME Shell on Wayland only discovers new extensions at login."
        info "Log out and back in, then run:  gnome-extensions enable $UUID"
        info "(or use the Extensions app). Updating an already loaded extension also needs a re-login."
    fi
    echo
    info "Settings: gnome-extensions prefs $UUID"
    info "Logs:     journalctl -f -o cat /usr/bin/gnome-shell | grep 'HF Propagation'"
}

case "${1:-}" in
    --pack) pack ;;
    --uninstall) uninstall ;;
    ""|--install) install ;;
    -h|--help) sed -n '3,8p' "$0" | sed 's/^# \{0,1\}//' ;;
    *) die "Unknown option: $1 (try --help)" ;;
esac

#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2025 Mateusz Kaduk
# SPDX-License-Identifier: GPL-3.0-or-later
#
# HF Propagation – GNOME Shell extension installer
#
#   ./install.sh              install or update for the current user
#   ./install.sh --pack       build hf-propagation@mashu.github.io.shell-extension.zip
#   ./install.sh --uninstall  remove the extension
#   ./install.sh --status     show what the running GNOME Shell has loaded
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
    status
    echo
    info "Settings: gnome-extensions prefs $UUID"
    info "Logs:     journalctl -f -o cat /usr/bin/gnome-shell | grep 'HF Propagation'"
}

metadata_version() {
    sed -n 's/^ *"version": *\([0-9][0-9]*\).*/\1/p' "$1" | head -n 1
}

# Report what the running GNOME Shell has actually loaded. GNOME Shell reads
# extension files only at login, so after an update it keeps running the old
# copy (and its old shell-version list) until the user logs out and back in.
status() {
    local want major info state loaded loaded_num path supported other
    want="$(metadata_version "$SRC_DIR/metadata.json")"
    major="$(shell_major)"
    supported="$(tr -d ' \n' < "$SRC_DIR/metadata.json" | sed -n 's/.*"shell-version":\[\([^]]*\)\].*/\1/p' | tr -d '"' | sed 's/,/, /g')"

    bold "Status"
    info "GNOME Shell ${major:-unknown}, this extension supports ${supported}"

    while IFS= read -r other; do
        [[ -n "$other" ]] && warn "Another copy is installed at $other"
    done < <(other_copies)

    info="$(gnome-extensions info "$UUID" 2>/dev/null || true)"
    state="$(sed -n 's/^ *State: *//p' <<< "$info" | head -n 1)"
    loaded="$(sed -n 's/^ *Version: *//p' <<< "$info" | head -n 1)"
    path="$(sed -n 's/^ *Path: *//p' <<< "$info" | head -n 1)"
    if [[ "$loaded" =~ \(([0-9]+)\) ]]; then
        loaded_num="${BASH_REMATCH[1]}"
    else
        loaded_num="${loaded//[^0-9]/}"
    fi

    if [[ -z "$state" ]]; then
        warn "GNOME Shell has not discovered the extension yet"
        info "Log out and back in, then run:  gnome-extensions enable $UUID"
        return
    fi

    info "Loaded by GNOME Shell: version ${loaded:-?}, state $state"
    if [[ -n "$path" && "$path" != "$DEST" ]]; then
        warn "GNOME Shell is using the copy in $path, not $DEST"
    fi

    if [[ -n "$loaded_num" && -n "$want" && "$loaded_num" != "$want" ]]; then
        warn "GNOME Shell is still running version $loaded_num, loaded at your last login"
        info "Log out and back in to load version $want. GNOME Shell only reads extensions at login,"
        info "so until then it keeps the old copy and its old list of supported GNOME versions."
        return
    fi

    case "$state" in
        ACTIVE|ENABLED)
            ok "HF Propagation is running – look for the antenna icon in the top bar" ;;
        "OUT OF DATE")
            warn "GNOME Shell ${major:-?} is not in this extension's supported versions ($supported)" ;;
        ERROR)
            warn "The extension failed to start; see: journalctl -b -o cat /usr/bin/gnome-shell | grep -A5 'HF Propagation'" ;;
        *)
            info "Enable it with:  gnome-extensions enable $UUID" ;;
    esac
}

other_copies() {
    local d dirs=(/usr/share /usr/local/share)
    local IFS=:
    for d in ${XDG_DATA_DIRS:-}; do
        dirs+=("$d")
    done
    for d in "${dirs[@]}"; do
        d="${d%/}/gnome-shell/extensions/$UUID"
        [[ -d "$d" && "$d" != "$DEST" ]] && echo "$d"
    done | sort -u
}

case "${1:-}" in
    --pack) pack ;;
    --uninstall) uninstall ;;
    --status) status ;;
    ""|--install) install ;;
    -h|--help) sed -n 's/^#   \(\.\/install\.sh\)/\1/p' "$0" ;;
    *) die "Unknown option: $1 (try --help)" ;;
esac

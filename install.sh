#!/bin/bash

# HF Propagation GNOME Extension Installer
# Run this script in the directory containing the extension files

EXTENSION_UUID="hf-propagation@mashu.github.io"
EXTENSIONS_DIR="$HOME/.local/share/gnome-shell/extensions"
EXTENSION_DIR="$EXTENSIONS_DIR/$EXTENSION_UUID"

echo "HF Propagation Extension Installer"
echo "=================================="
echo ""

# Check GNOME Shell version
echo "Checking GNOME Shell version..."
GNOME_VERSION=$(gnome-shell --version 2>/dev/null)
if [ $? -eq 0 ]; then
    echo "Found: $GNOME_VERSION"
else
    echo "WARNING: Could not determine GNOME Shell version"
fi
echo ""

# Check if extension directory exists
if [ -d "$EXTENSION_DIR" ]; then
    echo "Extension directory already exists."
    read -p "Do you want to remove it and reinstall? (y/n): " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        rm -rf "$EXTENSION_DIR"
        echo "Removed existing extension directory."
    else
        echo "Aborting installation."
        exit 1
    fi
fi

# Create extension directory
echo "Creating extension directory..."
mkdir -p "$EXTENSION_DIR"

# Copy files
echo "Installing extension files..."
cp extension.js "$EXTENSION_DIR/" 2>/dev/null || echo "WARNING: extension.js not found"
cp metadata.json "$EXTENSION_DIR/" 2>/dev/null || echo "WARNING: metadata.json not found"
cp stylesheet.css "$EXTENSION_DIR/" 2>/dev/null || echo "WARNING: stylesheet.css not found"

# Check if files were copied
if [ ! -f "$EXTENSION_DIR/extension.js" ] || [ ! -f "$EXTENSION_DIR/metadata.json" ]; then
    echo "ERROR: Required files not found in current directory!"
    echo "Make sure extension.js and metadata.json are in the current directory."
    exit 1
fi

echo "Files installed successfully."
echo ""

# Disable extension first (if enabled)
echo "Disabling extension (if currently enabled)..."
gnome-extensions disable "$EXTENSION_UUID" 2>/dev/null

# Check for Wayland vs X11
SESSION_TYPE=$(echo $XDG_SESSION_TYPE)
echo "Session type: $SESSION_TYPE"

if [ "$SESSION_TYPE" = "x11" ]; then
    echo ""
    echo "Restarting GNOME Shell..."
    # Send Alt+F2, r, Return
    busctl --user call org.gnome.Shell /org/gnome/Shell org.gnome.Shell Eval s 'Meta.restart("Restarting...")' 2>/dev/null || {
        echo "Could not restart GNOME Shell automatically."
        echo "Please press Alt+F2, type 'r', and press Enter."
        read -p "Press Enter after restarting GNOME Shell..."
    }
else
    echo ""
    echo "Running on Wayland - GNOME Shell restart not available."
    echo "The extension will be loaded without restart."
fi

echo ""
echo "Enabling extension..."
gnome-extensions enable "$EXTENSION_UUID"

# Check if extension is enabled
sleep 1
if gnome-extensions info "$EXTENSION_UUID" 2>/dev/null | grep -q "State: ENABLED"; then
    echo "✓ Extension is ENABLED"
else
    echo "✗ Extension is NOT enabled"
    echo ""
    echo "Troubleshooting:"
    echo "1. Check for errors:"
    echo "   journalctl -f -o cat /usr/bin/gnome-shell"
    echo ""
    echo "2. Try enabling manually:"
    echo "   gnome-extensions enable $EXTENSION_UUID"
    echo ""
    echo "3. Or use GNOME Extensions app"
    echo ""
    echo "4. On Wayland, you may need to log out and log back in"
fi

echo ""
echo "Installation complete!"
echo ""
echo "Quick Commands:"
echo "  View logs:     journalctl -f -o cat /usr/bin/gnome-shell"
echo "  Enable:        gnome-extensions enable $EXTENSION_UUID"
echo "  Disable:       gnome-extensions disable $EXTENSION_UUID"
echo "  Reset:         gnome-extensions reset $EXTENSION_UUID"
echo "  Info:          gnome-extensions info $EXTENSION_UUID"
echo ""
echo "The extension should appear in your top panel showing HF propagation data."

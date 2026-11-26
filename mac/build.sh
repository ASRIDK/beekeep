#!/bin/bash
# Builds the Mac app. Usage: build.sh <path to Beekeep.app>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
app="${1:?where to put Beekeep.app}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/Beekeep.app/Contents/MacOS" "$work/Beekeep.app/Contents/Resources"
swiftc -O -swift-version 5 "$here/Beekeep.swift" -o "$work/Beekeep.app/Contents/MacOS/Beekeep"
# The hive command on the path outlives any one copy of the code, so prefer it.
launcher="$HOME/.local/bin/beekeep"
[ -x "$launcher" ] || launcher="$(cd "$here/.." && pwd)/bin/beekeep"
echo "$launcher" > "$work/Beekeep.app/Contents/Resources/hive-path.txt"
cat > "$work/Beekeep.app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Beekeep</string>
  <key>CFBundleIdentifier</key><string>local.beekeep.window</string>
  <key>CFBundleExecutable</key><string>Beekeep</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.2</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
codesign --force --sign - "$work/Beekeep.app" >/dev/null 2>&1 || true
if [ -e "$app" ] && ! grep -q local.beekeep.window "$app/Contents/Info.plist" 2>/dev/null; then
  echo "$app exists and is not this app. Nothing was changed." >&2
  exit 1
fi
mkdir -p "$(dirname "$app")"
rm -rf "$app"
mv "$work/Beekeep.app" "$app"
echo "Built $app"

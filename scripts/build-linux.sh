#!/usr/bin/env bash
# Build the Linux Core host. Example: scripts/build-linux.sh --debug --no-bundle
# Packagers can pass Tauri build options such as --bundles deb.
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(uname -s)" != Linux ]]; then
  echo 'Run this script on Linux with the Tauri Linux build prerequisites installed.' >&2
  exit 1
fi
cd "$project_root"
if ! pkg-config --exists gtk+-3.0 webkit2gtk-4.1 fontconfig; then
  echo 'Install the GTK 3, WebKitGTK 4.1 and Fontconfig development packages for your distribution.' >&2
  exit 1
fi
export VITE_EDITION=core
export VITE_APP_PLATFORM=linux
export EPUB_READER_EXPECTED_EDITION=core
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$project_root/src-tauri/target/linux-core}"

echo "Linux Core, WebKitGTK $(pkg-config --modversion webkit2gtk-4.1)"
echo "Cargo output: $CARGO_TARGET_DIR"
exec node node_modules/@tauri-apps/cli/tauri.js build --features core \
  --config src-tauri/tauri.core.conf.json \
  --config src-tauri/tauri.linux-core.conf.json "$@"

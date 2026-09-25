#!/usr/bin/env bash
# Android Core build entry point (BK-0).
#
# Scope: Linux / WSL only. Never copies sources to Windows and never invokes
# PowerShell or Windows tools. Builds the Core edition into an isolated Cargo
# target directory. Debug APK on aarch64 is the default.
#
# Usage:
#   scripts/build-android.sh env                 # print resolved tool versions
#   scripts/build-android.sh init                # create src-tauri/gen/android once
#   scripts/build-android.sh build [options]     # init when needed, then build (runs the Core gate)
#   scripts/build-android.sh devices             # adb device list
#   scripts/build-android.sh install <apk>       # adb install -r
#
# build options:
#   --release            release build (default: debug)
#   --aab                build an AAB instead of an APK
#   --target <abi>       aarch64 (default) | armv7 | i686 | x86_64
#
# Environment overrides (all optional):
#   ANDROID_TOOLCHAIN_ROOT  dir holding jdk-* and sdk/ (default: <workspace>/.android-toolchain)
#   JAVA_HOME ANDROID_HOME NDK_HOME ANDROID_NDK_VERSION
#   RUST_TOOLCHAIN_BIN      dir with cargo/rustc (default: <workspace>/rust-toolchain/bin)
#   CARGO_HOME              default: <workspace>/.cargo when it already has a registry
#   CARGO_TARGET_DIR        default: <project>/src-tauri/target-android-core
#   ANDROID_USER_HOME GRADLE_USER_HOME
#   TAURI_CLI_NODE          node executable handed to the Gradle BuildTask (default: node on PATH)
#   TAURI_CLI_JS            project-local CLI script handed to Gradle (default: node_modules/@tauri-apps/cli/tauri.js)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_ROOT="$(cd "$PROJECT_ROOT/.." && pwd)"
TAURI_CLI="$PROJECT_ROOT/node_modules/@tauri-apps/cli/tauri.js"

fail() { printf 'build-android: %s\n' "$*" >&2; exit 1; }

# Version of the project-local CLI; the outer and inner (Gradle) invocations
# must both resolve this one.
outer_cli_version() {
  node -p "require('$PROJECT_ROOT/node_modules/@tauri-apps/cli/package.json').version" 2>/dev/null || echo unknown
}

# --- toolchain roots -------------------------------------------------------
ANDROID_TOOLCHAIN_ROOT="${ANDROID_TOOLCHAIN_ROOT:-}"
if [ -z "$ANDROID_TOOLCHAIN_ROOT" ]; then
  for candidate in "$WORKSPACE_ROOT/.android-toolchain" "$HOME/.android-toolchain"; do
    if [ -d "$candidate" ]; then ANDROID_TOOLCHAIN_ROOT="$candidate"; break; fi
  done
fi

if [ -z "${JAVA_HOME:-}" ] && [ -n "$ANDROID_TOOLCHAIN_ROOT" ]; then
  JAVA_HOME="$(find "$ANDROID_TOOLCHAIN_ROOT" -maxdepth 1 -type d -name 'jdk-*' | sort | tail -1)"
  export JAVA_HOME
fi

if [ -z "${ANDROID_HOME:-}" ] && [ -n "$ANDROID_TOOLCHAIN_ROOT" ]; then
  export ANDROID_HOME="$ANDROID_TOOLCHAIN_ROOT/sdk"
fi

ANDROID_NDK_VERSION="${ANDROID_NDK_VERSION:-28.2.13676358}"
if [ -z "${NDK_HOME:-}" ] && [ -n "${ANDROID_HOME:-}" ]; then
  export NDK_HOME="$ANDROID_HOME/ndk/$ANDROID_NDK_VERSION"
fi

RUST_TOOLCHAIN_BIN="${RUST_TOOLCHAIN_BIN:-$WORKSPACE_ROOT/rust-toolchain/bin}"
if ! command -v cargo >/dev/null 2>&1 && [ -x "$RUST_TOOLCHAIN_BIN/cargo" ]; then
  PATH="$RUST_TOOLCHAIN_BIN:$PATH"
fi

if [ -z "${CARGO_HOME:-}" ] && [ -d "$WORKSPACE_ROOT/.cargo/registry" ]; then
  export CARGO_HOME="$WORKSPACE_ROOT/.cargo"
fi

# Android tooling refuses to start when $HOME is not writable, so keep the
# mutable homes inside the workspace. Explicit values always win.
export ANDROID_USER_HOME="${ANDROID_USER_HOME:-$WORKSPACE_ROOT/.cache/android-user-home}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$WORKSPACE_ROOT/.cache/android-gradle-home}"
# The generated Gradle BuildTask shells out to `pnpm dlx @tauri-apps/cli`, and
# pnpm writes its dlx cache under $XDG_CACHE_HOME/pnpm. Point that inside the
# workspace and reuse the project store so the Gradle-driven build can resolve
# the CLI without touching a read-only $HOME.
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$WORKSPACE_ROOT/.cache}"
export npm_config_store_dir="${npm_config_store_dir:-$PROJECT_ROOT/.pnpm-store}"
# adb 37 still creates $HOME/.android even when ANDROID_USER_HOME is set, so a
# read-only $HOME aborts `adb devices`/`install`. Redirect only in that case;
# a normal writable WSL home is left untouched.
if [ ! -w "$HOME" ]; then
  export HOME="$WORKSPACE_ROOT/.cache/android-home"
fi
mkdir -p "$ANDROID_USER_HOME" "$GRADLE_USER_HOME" "$XDG_CACHE_HOME" "$HOME"

export VITE_EDITION=core
export EPUB_READER_EXPECTED_EDITION=core
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PROJECT_ROOT/src-tauri/target-android-core}"

export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

tauri() { node "$TAURI_CLI" "$@"; }
TAURI_ARGS=(--config src-tauri/tauri.core.conf.json)

# The generated Gradle BuildTask runs the Tauri CLI for the Rust step. Hand it
# the same project-local CLI (pinned by package.json/pnpm-lock.yaml) and the
# node executable that is running this script, so the Android build no longer
# needs `pnpm dlx` (which would resolve the newest published CLI over the network).
TAURI_CLI_NODE="${TAURI_CLI_NODE:-$(command -v node 2>/dev/null || echo node)}"
export TAURI_CLI_NODE
TAURI_CLI_JS="${TAURI_CLI_JS:-$TAURI_CLI}"
export TAURI_CLI_JS

# --- commands --------------------------------------------------------------
print_env() {
  echo "PROJECT_ROOT=$PROJECT_ROOT"
  echo "WORKSPACE_ROOT=$WORKSPACE_ROOT"
  echo "JAVA_HOME=$JAVA_HOME"
  echo "ANDROID_HOME=$ANDROID_HOME"
  echo "NDK_HOME=$NDK_HOME"
  echo "ANDROID_USER_HOME=$ANDROID_USER_HOME"
  echo "GRADLE_USER_HOME=$GRADLE_USER_HOME"
  echo "CARGO_HOME=${CARGO_HOME:-<default>}"
  echo "CARGO_TARGET_DIR=$CARGO_TARGET_DIR"
  echo "VITE_EDITION=$VITE_EDITION EPUB_READER_EXPECTED_EDITION=$EPUB_READER_EXPECTED_EDITION"
  echo "tauri cli: $TAURI_CLI (v$(outer_cli_version)); TAURI_CLI_NODE=$TAURI_CLI_NODE; TAURI_CLI_JS=$TAURI_CLI_JS"
  echo "--- versions ---"
  node --version
  pnpm --version
  cargo -V
  rustc -vV | sed -n '1p;/host/p'
  rustc --print target-list | grep -x 'aarch64-linux-android' >/dev/null \
    && echo "rust target aarch64-linux-android: known"
  ls "$RUST_TOOLCHAIN_BIN/../lib/rustlib" 2>/dev/null | grep -q '^aarch64-linux-android$' \
    && echo "rust-std aarch64-linux-android: installed" \
    || echo "rust-std aarch64-linux-android: MISSING"
  java -version 2>&1 | sed -n '1p'
  sdkmanager --version 2>/dev/null | tail -1 || true
  echo "platform-tools: $(cat "$ANDROID_HOME/platform-tools/source.properties" 2>/dev/null | tr '\n' ' ')"
  echo "platforms: $(ls "$ANDROID_HOME/platforms" 2>/dev/null | tr '\n' ' ')"
  echo "build-tools: $(ls "$ANDROID_HOME/build-tools" 2>/dev/null | tr '\n' ' ')"
  echo "ndk: $(ls "$ANDROID_HOME/ndk" 2>/dev/null | tr '\n' ' ')"
  echo "gradlew: $([ -x "$PROJECT_ROOT/src-tauri/gen/android/gradlew" ] && echo present || echo missing)"
}

do_init() {
  [ -f "$TAURI_CLI" ] || fail "Tauri CLI missing at $TAURI_CLI (run pnpm install)"
  if [ -x "$PROJECT_ROOT/src-tauri/gen/android/gradlew" ]; then
    echo "Android project already initialised; not re-running init."
    return 0
  fi
  ( cd "$PROJECT_ROOT" && tauri android init --ci --skip-targets-install "${TAURI_ARGS[@]}" )
}

do_build() {
  local mode="debug" bundle="--apk" target="aarch64"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --release) mode="release" ;;
      --debug) mode="debug" ;;
      --apk) bundle="--apk" ;;
      --aab) bundle="--aab" ;;
      --target) shift; target="${1:?--target needs a value}" ;;
      *) fail "unknown build option: $1" ;;
    esac
    shift
  done
  do_init
  local args=(android build --features core "$bundle" --target "$target" "${TAURI_ARGS[@]}")
  [ "$mode" = "debug" ] && args+=(--debug)
  echo "tauri CLI (outer): $TAURI_CLI v$(outer_cli_version) via $TAURI_CLI_NODE"
  ( cd "$PROJECT_ROOT" && tauri "${args[@]}" )
  echo "--- artifacts ---"
  find "$PROJECT_ROOT/src-tauri/gen/android/app/build/outputs" -type f \
    \( -name '*.apk' -o -name '*.aab' \) -printf '%p  %s bytes\n' 2>/dev/null | sort
}

case "${1:-build}" in
  env) print_env ;;
  init) do_init ;;
  build) shift || true; do_build "$@" ;;
  devices) adb devices -l ;;
  install)
    shift
    apk="${1:?usage: build-android.sh install <apk>}"
    adb install -r "$apk"
    ;;
  *) fail "usage: build-android.sh {env|init|build|devices|install <apk>}" ;;
esac

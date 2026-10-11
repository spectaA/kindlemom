#!/usr/bin/env sh
# Builds the WebAssembly engine into web/pkg/.
# Requires: rustup target wasm32-unknown-unknown, wasm-bindgen-cli 0.2.108.
set -eu
cd "$(dirname "$0")"
cargo build --manifest-path core/Cargo.toml --release --target wasm32-unknown-unknown
wasm-bindgen --target web --no-typescript --out-dir web/pkg \
  core/target/wasm32-unknown-unknown/release/kindlemom_core.wasm
if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Os --enable-bulk-memory --enable-nontrapping-float-to-int \
    web/pkg/kindlemom_core_bg.wasm -o web/pkg/kindlemom_core_bg.wasm
fi
ls -l web/pkg

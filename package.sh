#!/usr/bin/env bash
set -euo pipefail

NAME="$(node -p "require('./manifest.json').id")"
VERSION="$(node -p "require('./manifest.json').version")"

pnpm run build

PACKAGE_DIR="dist"
ZIP_FILE="${NAME}-${VERSION}.zip"

rm -rf "$PACKAGE_DIR"
mkdir -p "$PACKAGE_DIR"

FILES=(
    manifest.json
    main.js
    styles.css
    sql-wasm-browser.wasm
)

for file in "${FILES[@]}"; do
    [[ -f "$file" ]] && cp "$file" "$PACKAGE_DIR/"
done

(cd "$PACKAGE_DIR" && zip -r "../$ZIP_FILE" .)

echo "created $ZIP_FILE"

#!/bin/sh
# Builds self-contained binaries for all platforms into ./dist (needs Go 1.22 or newer).
set -e
mkdir -p dist
for t in linux/amd64:linux-x64 linux/arm64:linux-arm64 \
         windows/amd64:windows-x64.exe windows/arm64:windows-arm64.exe \
         darwin/amd64:macos-intel darwin/arm64:macos-apple-silicon; do
  target=${t%%:*}; name=${t#*:}
  GOOS=${target%/*} GOARCH=${target#*/} CGO_ENABLED=0 \
    go build -trimpath -ldflags="-s -w" -o "dist/opticfilm-$name" .
  echo "built dist/opticfilm-$name"
done

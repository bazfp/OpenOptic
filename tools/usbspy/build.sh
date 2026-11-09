#!/bin/sh
# Builds libusbspy.dylib (macOS arm64 + x86_64) next to this script.
cd "$(dirname "$0")" && clang -dynamiclib -O1 -Wall -arch arm64 -arch x86_64 usbspy.c -framework IOKit -framework CoreFoundation -o libusbspy.dylib

# Build and test. Requires Go 1.24+ and Node.js 20+.
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: build dist test test-go test-js vet clean

build:
	CGO_ENABLED=0 go build -trimpath -ldflags="$(LDFLAGS)" -o opticfilm .

dist:
	VERSION=$(VERSION) sh ./build.sh

test: vet test-go test-js

vet:
	go vet ./...

test-go:
	go test ./...

test-js:
	@set -e; for t in tests/*.test.cjs; do echo "== $$t"; node $$t; done

clean:
	rm -rf dist opticfilm opticfilm.exe

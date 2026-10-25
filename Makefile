.PHONY: run build vet test check js-test e2e
run:
	go run .
build:
	go build ./...
vet:
	go vet ./...
test:
	go test ./... -race
js-test:
	node --test assets/*.test.mjs
check: build vet test js-test
# Browser end-to-end checks: needs the server running (make run) and Chrome. Not part of `make check`.
e2e:
	cd e2e && npm ci && node run-all.mjs

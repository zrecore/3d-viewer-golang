.PHONY: run build vet test check js-test
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

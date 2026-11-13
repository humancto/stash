# stash build entry points. The web UI lives in web/ (Vite + React + TS) and is
# embedded into the release binary from web/dist.

.PHONY: web build test run

web:
	npm --prefix web ci
	npm --prefix web run build

# rust-embed only tracks files that existed when it last expanded, so touch
# the embedding module to make cargo pick up a fresh web/dist.
build: web
	touch src/web.rs
	cargo build --release

test:
	cargo test
	npm --prefix web test

run: build
	cargo run --release

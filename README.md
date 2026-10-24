# 3D Viewer (Go)

A 3D viewer written in Go (Gin) with a WebGPU front end. It lists STL files from `assets/stl/`, renders them in the browser with an orbit camera and lighting, and lets signed-in users upload new models.

## Clone

This repository uses a git submodule (`assets/fmto`).

```bash
git clone --recurse-submodules git@github.com:zrecore/3d-viewer-golang.git
# or, in an existing checkout:
git submodule update --init --recursive
```

## Run

With Docker Compose:

```bash
docker compose up server
```

Or locally (Go 1.23+, run from the repository root):

```bash
go run .
```

Open http://localhost:8080/.

The browser needs WebGPU: current Chrome or Edge, Safari 26+, or Firefox where WebGPU is enabled.

## Configuration

Environment variables (see `.env.example`; Compose reads `.env` automatically):

| Variable | Default | Purpose |
|---|---|---|
| `ADDR` | `:8080` | Listen address |
| `ASSETS_DIR` | `./assets` | Static assets; models live in `$ASSETS_DIR/stl` |
| `TEMPLATES_DIR` | `./templates` | HTML templates |
| `MAX_UPLOAD_MB` | `50` | Upload size limit |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URL` | unset | OpenID Connect login (Authorization Code + PKCE). If `OIDC_ISSUER` is unset, uploads return 503. |
| `SESSION_SECRET` | unset | Cookie signing key, at least 32 bytes; required when OIDC is configured |
| `COOKIE_SECURE` | `true` | Set `false` only for plain-http local development |

## Development

```bash
make check      # build, vet, Go tests, JS parser tests
```

A production-style image is available with `docker compose --profile prod up --build viewer`.

## License

See LICENSE file.

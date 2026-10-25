# 3D Viewer (Go)

A 3D viewer written in Go (Gin) with a WebGPU front end. It renders STL files in the browser with an orbit camera and lighting. Anyone can open an `.stl` file with the toolbar's Upload button: the viewer shows it and remembers the last one in their own browser (IndexedDB). Nothing is shown until a model has been opened. There are no accounts or sign-in, and the file never leaves the browser. The Go server is read-only: it serves the page, the static assets and the example models in `assets/stl/` (available through the API but not listed in the page).

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

## Controls

| Action | Mouse | Touch |
|---|---|---|
| Orbit | drag | one finger |
| Pan | shift/right/middle drag | two fingers |
| Zoom | wheel | pinch (zooms toward your fingers) |
| Twist | | turn two fingers |
| Reset view | toolbar button | toolbar button or double-tap |

A quick flick of an orbit or pan drag keeps the model coasting for a moment, with the mouse as well as with a finger (the wheel does not coast). Coasting is skipped when the system asks for reduced motion.

## Configuration

Environment variables (see `.env.example`; Compose reads `.env` automatically):

| Variable | Default | Purpose |
|---|---|---|
| `ADDR` | `:8080` | Listen address |
| `ASSETS_DIR` | `./assets` | Static assets; models live in `$ASSETS_DIR/stl` |
| `TEMPLATES_DIR` | `./templates` | HTML templates |

Every variable is optional.

## Server API

Read-only. The server has no sign-in, sessions, cookies or write routes (a test checks that those routes stay gone).

| Route | Returns |
|---|---|
| `GET /` | The viewer page |
| `GET /api/models` (alias `/api/load-entries`) | `[{name, size, modTime}]` for the example STL files, `[]` when there are none |
| `GET /api/models/:name` | The raw STL (`application/sla`) |
| `GET /assets/...` | Static files under `ASSETS_DIR` |

The browser upload is separate: it is read in the page, validated and kept in IndexedDB (the last file only). Nothing is posted anywhere.

## Development

```bash
make check      # build, vet, Go tests, JS tests (all the unit tests)
make e2e        # browser end-to-end checks (server running + Chrome; see e2e/README.md)
```

A production-style image is available with `docker compose --profile prod up --build viewer`.

## License

See LICENSE file.

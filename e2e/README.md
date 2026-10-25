# End-to-end checks

Browser tests that drive the real page in headless Chrome with software WebGPU (swiftshader), so the viewer
genuinely renders. They cover what the node unit tests cannot: real pointer, touch and layout behaviour.

They are **not run by CI** (they need Chrome and take a few minutes); run them before changing the controls,
the toolbar or the layout.

## Run

```bash
go run .                       # in one terminal: the server under test (http://localhost:8080)

cd e2e
npm ci                         # once: installs puppeteer-core (no browser download, it uses your Chrome)
node run-all.mjs               # everything
node run-all.mjs touch layout  # only scripts whose name contains one of these
node mouse-inertia.mjs         # or a single script
```

`make e2e` does the same from the repository root.

Environment: `BASE_URL` (default `http://localhost:8080`), `CHROME_PATH` (default: the usual macOS and Linux
locations). Screenshots land in `e2e/out/` (git-ignored). Each script prints `PASS`/`FAIL` lines and exits non-zero on
any failure, or with 2 if Chrome or the server cannot be found.

## What is here

| Script | Checks |
|---|---|
| `desktop-golden.mjs` | Mouse drags (left, shift, right, middle), wheel zoom and Reset against `golden-desktop.json`, exact to 9 decimals. Guards the desktop controls. |
| `mouse-inertia.mjs` | Flicks coast and settle; slow drags, pauses and clicks do not; shift/right/middle flicks coast as pans; wheel, a new press, Reset view and reduced motion stop or skip it. |
| `portrait.mjs` | Model fits a phone-shaped viewport, landscape framing is unchanged, rotating keeps the user's zoom. |
| `layout-mobile.mjs` | Phone layouts (390x844, 360x640, 844x390): 44px touch targets, info line vs toolbar, Help fit, first-visit collapse; desktop keeps its compact sizes. |
| `safe-area.mjs` | Notch and home-indicator insets (portrait and landscape) for the toolbar, info line, toast and progress bar, including dragging. |
| `touch.mjs` | Real multi-touch through Chrome DevTools: orbit, flick, pinch toward the fingers, two-finger pan, twist (both above and below the horizon), a third finger, lifting a finger, cancel, blur, double-tap. |

The scripts read camera state through `window.__stlViewerDebug`, which the page only exposes with `?debug` in the URL.

## Notes

- **Re-recording the golden file** (only when the drag maths is *meant* to change): `node desktop-golden.mjs record`,
  then review the diff of `golden-desktop.json`. The script pauses before releasing the mouse so that mouse inertia
  does not make the recording depend on timing.
- **Chrome's touch API:** in `Input.dispatchTouchEvent`, `touchEnd` lists the points being *released*, not the ones
  that remain, and a point id that was released starts a new touch if it moves again.
- **Closing the browser can hang** after touch emulation, so the scripts exit through `finish()` in `lib.mjs`.
- Real phones are not covered. WebGPU needs a secure context there: on Android use `chrome://inspect` port forwarding
  to `localhost:8080`; on iOS use an https tunnel (Safari 26 or later).

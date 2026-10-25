# End-to-end checks

Browser tests that drive the real page in headless Chrome with software WebGPU (swiftshader), so the viewer
genuinely renders. They cover what the node unit tests cannot: real pointer, touch and layout behaviour.

Two engines: **Chrome** (your own installed Chrome) and **WebKit**, the engine Safari is built on (Playwright's
headless build, which has WebGPU on macOS). The scripts use two tools: puppeteer-core for the Chrome-only scripts,
and Playwright for `cross-browser.mjs`, which runs the *same* checks on both engines. Safari.app itself has no headless mode, and its
`safaridriver` needs a visible window plus a "Allow remote automation" switch, so the WebKit build is the practical
automated stand-in. It is not Safari proper: see "What WebKit does and does not cover" below.

They are **not run by CI** (they need Chrome and take a few minutes); run them before changing the controls,
the toolbar or the layout.

## Run

```bash
go run .                       # in one terminal: the server under test (http://localhost:8080)

cd e2e
npm ci                         # once: installs puppeteer-core and playwright-core (no browser download)
npm run install-webkit         # once, optional: downloads Playwright's headless WebKit (about 100 MB, cached in ~/Library/Caches/ms-playwright)
node run-all.mjs               # everything
node run-all.mjs touch layout  # only scripts whose name contains one of these
node run-all.mjs webkit        # one engine of the cross-browser suite (or: chrome)
node cross-browser.mjs chrome  # run that suite directly on one engine (chrome or webkit)
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
| `mouse-inertia.mjs` | Flicks coast and settle; the coast distance matches the release velocity measured from the page's real event stream (fast, medium and casual swipes); a brief pause before releasing still coasts, a long one does not; slow drags and clicks do not; shift/right/middle flicks coast as pans; wheel, a new press, Reset view and reduced motion stop or skip it. |
| `cross-browser.mjs` | The same Playwright checks on each engine (`chrome` or `webkit`): WebGPU, rendering, the recorded mouse sequence, mouse coasting measured against the browser's own event stream (including that `event.timeStamp` and `requestAnimationFrame` share one clock), Help and toolbar, iPhone emulation (layout, 44px targets, real double-tap), and the two-finger gestures. The WebKit run is skipped (not failed) when WebKit is not installed. |
| `portrait.mjs` | Model fits a phone-shaped viewport, landscape framing is unchanged, rotating keeps the user's zoom. |
| `layout-mobile.mjs` | Phone layouts (390x844, 360x640, 844x390): 44px touch targets, info line vs toolbar, Help fit, first-visit collapse; desktop keeps its compact sizes. |
| `safe-area.mjs` | Notch and home-indicator insets (portrait and landscape) for the toolbar, info line, toast and progress bar, including dragging. |
| `touch.mjs` | Real multi-touch through Chrome DevTools: orbit, flick, pinch toward the fingers, two-finger pan, twist (both above and below the horizon), a third finger, lifting a finger, cancel, blur, double-tap. |

The scripts read camera state through `window.__stlViewerDebug`, which the page only exposes with `?debug` in the URL.

## What the cross-browser suite does and does not cover

`cross-browser.mjs` runs the real page on both engines, so a difference between the two is a real cross-engine difference. On WebKit it catches WebKit-specific JavaScript, event and layout
differences, including the event-clock question that matters for coasting (it reports `event.timeStamp` and
`requestAnimationFrame` sharing one timebase). Playwright's WebKit has **no multi-touch input**, so on both engines the pinch,
pan, twist and extra-finger checks send synthetic pointer events into the page: that exercises the real gesture code
under each engine's JavaScript and event model, but not a real touchscreen (Chrome's real multi-touch is `touch.mjs`). Real taps (the double-tap check) do go through Playwright's touchscreen.

Not covered: Safari.app's own UI and quirks, iOS Safari (URL-bar resizing, rubber-banding, real multi-touch), and
anything that depends on Apple-only builds. Those need a real device.

## Notes

- **Re-recording the golden file** (only when the drag maths is *meant* to change): `node desktop-golden.mjs record`,
  then review the diff of `golden-desktop.json`. The script pauses before releasing the mouse so that mouse inertia
  does not make the recording depend on timing.
- **Chrome's touch API:** in `Input.dispatchTouchEvent`, `touchEnd` lists the points being *released*, not the ones
  that remain, and a point id that was released starts a new touch if it moves again.
- **Closing the browser can hang** after touch emulation, so the scripts exit through `finish()` in `lib.mjs`.
- Real phones are not covered by the scripts. WebGPU needs a secure context there: on Android use `chrome://inspect` port forwarding
  to `localhost:8080`; on iOS use an https tunnel (Safari 26 or later).

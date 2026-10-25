/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

// The same checks on each engine: `node cross-browser.mjs chrome` and `node cross-browser.mjs webkit`.
// Chrome is your installed Chrome; WebKit is Playwright's headless build (Safari's engine, with WebGPU, but not
// Safari.app itself). The checks are identical, so a difference between the two is a real cross-engine difference.
//
// Desktop: WebGPU, rendering, the recorded mouse sequence (golden-desktop.json), mouse coasting measured against
// the browser's own event stream, wheel, toolbar and Help.
// iPhone emulation: coarse pointer, layout, touch targets, double-tap with real taps.
// Two-finger gestures: Playwright's WebKit has no multi-touch input, so on both engines these are synthetic
// pointer events dispatched in the page. That still runs the real gesture code under each engine's JavaScript
// and event model (Chrome's real multi-touch is covered separately by touch.mjs).
//
// Needs the server running (go run .). WebKit also needs, once, `npm run install-webkit`; without it that run
// exits 3 (skipped).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BASE_URL, launchEngine, wait, fixture, out } from './lib.mjs'
import { MOUSE, TOUCH } from '../assets/gestures.mjs' // the tuning under test (pure module, no DOM)

const engine = process.argv[2] || 'webkit'
const { browser, devices, label } = await launchEngine(engine)
console.log(`Running the cross-browser checks on ${label}`)
const golden = JSON.parse(readFileSync(fileURLToPath(new URL('./golden-desktop.json', import.meta.url)), 'utf8'))

let failures = 0
const check = (name, ok, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  ' + detail : '')); if (!ok) failures++ }
const near = (a, b, eps) => Math.abs(a - b) <= eps
const errors = []

async function open(contextOptions = {}, path = '/?debug') {
  const context = await browser.newContext(contextOptions)
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(BASE_URL + path, { waitUntil: 'networkidle' })
  if (path.includes('debug')) await page.waitForFunction(() => window.__stlViewerDebug && window.__stlViewerDebug.state().controls, null, { timeout: 20000 })
  return { context, page }
}
const stateOf = (page) => page.evaluate(() => window.__stlViewerDebug.state())
const camOf = async (page) => { const s = await stateOf(page); return { az: s.azimuth, el: s.elevation, d: s.distance, t: s.target, epoch: s.epoch, inertia: s.controls.inertia, touches: s.controls.touches, mode: s.controls.mode } }
const resetView = async (page) => { await page.evaluate(() => document.getElementById('btnResetView').click()); await wait(150) }

// ====================================================================================================
// Desktop
// ====================================================================================================
{
  const { context, page } = await open({ viewport: { width: 1280, height: 800 } })
  const ua = await page.evaluate(() => navigator.userAgent)
  console.log('      ' + ua)

  // ---- the recorded mouse sequence: identical camera numbers to Chrome's recording.
  // It runs before any upload: a restored model would reset the camera asynchronously and make it timing-dependent.
  const round = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'number' ? Number(v.toFixed(9)) : v)))
  const cam = async () => { const s = await stateOf(page); return { azimuth: s.azimuth, elevation: s.elevation, distance: s.distance, target: s.target, eye: s.eye } }
  const drag = async (x0, y0, x1, y1, opts = {}) => { await page.mouse.move(x0, y0); await page.mouse.down(opts); await page.mouse.move(x1, y1, { steps: 6 }); await wait(130); await page.mouse.up(opts) }
  const steps = {}
  steps.initial = await cam()
  await drag(400, 400, 500, 440); steps.leftDrag = await cam()
  await page.keyboard.down('Shift'); await drag(400, 400, 440, 380); await page.keyboard.up('Shift'); steps.shiftDrag = await cam()
  await drag(400, 400, 360, 430, { button: 'right' }); steps.rightDrag = await cam()
  await drag(400, 400, 430, 400, { button: 'middle' }); steps.middleDrag = await cam()
  await page.mouse.move(600, 400); await page.mouse.wheel(0, -300); await wait(300); steps.wheelIn = await cam()
  await page.mouse.wheel(0, 500); await wait(300); steps.wheelOut = await cam()
  await drag(500, 300, 500, 780); steps.orbitToClamp = await cam()
  await page.click('#btnResetView'); await wait(250); steps.reset = await cam()
  await drag(300, 400, 380, 400); await page.mouse.wheel(0, 120); await wait(300); steps.afterReset = await cam()
  const res = round(steps)
  const differing = Object.keys(golden).filter((k) => JSON.stringify(golden[k]) !== JSON.stringify(res[k]))
  check('the recorded mouse sequence (orbit, shift/right/middle pan, wheel, clamp, reset) matches Chrome exactly', differing.length === 0, differing.length ? 'differs at: ' + differing.join(', ') : `${Object.keys(golden).length} steps identical`)

  // ---- WebGPU and rendering
  const gpu = await page.evaluate(async () => {
    if (!('gpu' in navigator)) return { present: false }
    const a = await navigator.gpu.requestAdapter()
    return { present: true, adapter: !!a }
  })
  check('WebGPU is available with an adapter', gpu.present && gpu.adapter, JSON.stringify(gpu))
  await page.setInputFiles('#uploadFile', fixture('cube.stl')); await wait(1500)
  const info = await page.evaluate(() => document.getElementById('viewerInfo').textContent)
  const rendered = await stateOf(page)
  check('uploading a model shows it and the renderer draws', /12 triangles/.test(info) && rendered.frames > 0, `"${info}", frames ${rendered.frames}, canvas ${rendered.canvas.width}x${rendered.canvas.height}`)
  check('the toolbar starts expanded on a desktop-size window', !(await page.evaluate(() => document.documentElement.classList.contains('toolbar-collapsed'))))

  // ---- mouse coasting, judged against this browser's own event stream
  await page.evaluate(() => {
    window.__ev = []
    const c = document.getElementById('viewerCanvas')
    for (const t of ['pointermove', 'pointerup']) c.addEventListener(t, (e) => window.__ev.push({ t: e.type, ts: e.timeStamp, x: e.clientX, now: performance.now() }), true)
    requestAnimationFrame((ts) => { window.__rafOffset = performance.now() - ts })
  })
  async function measured(pxPerStep, ms, stallMs = 0) {
    await resetView(page); await page.evaluate(() => { window.__ev = [] })
    const start = await camOf(page)
    await page.mouse.move(300, 400); await page.mouse.down()
    let x = 300; const t0 = Date.now()
    while (Date.now() - t0 < ms) { x += pxPerStep; await page.mouse.move(x, 400); await wait(2) }
    if (stallMs) await wait(stallMs)
    await page.mouse.up()
    const atRelease = await camOf(page)
    await page.waitForFunction(() => window.__stlViewerDebug.state().controls.inertia === false, null, { timeout: 12000 }).catch(() => {})
    await wait(300)
    const end = await camOf(page)
    const ev = await page.evaluate(() => window.__ev)
    const up = ev.filter((e) => e.t === 'pointerup').pop(), mv = ev.filter((e) => e.t === 'pointermove')
    const last = mv[mv.length - 1]; let first = last
    for (let i = mv.length - 2; i >= 0 && last.ts - mv[i].ts <= MOUSE.VELOCITY_WINDOW_MS; i--) first = mv[i]
    const dt = last.ts - first.ts, v = dt >= MOUSE.MIN_SAMPLE_DT_MS ? (last.x - first.x) / dt : 0
    const coasts = (up.ts - last.ts) <= MOUSE.VELOCITY_STALE_MS && Math.abs(v) >= MOUSE.START_SPEED
    const predictedPx = coasts ? (Math.min(Math.abs(v) * MOUSE.GAIN, MOUSE.MAX_SPEED) - TOUCH.MIN_SPEED) * MOUSE.ORBIT_TAU_MS : 0
    return { v, coasts, predictedPx, actualPx: Math.abs(end.az - atRelease.az) / 0.005, dragPx: Math.abs(atRelease.az - start.az) / 0.005, settled: !end.inertia, stale: up.ts - last.ts }
  }
  for (const [label, step, ms] of [['fast', 14, 300], ['medium', 8, 400], ['casual', 4, 500]]) {
    const r = await measured(step, ms)
    check(`${label} mouse swipe (${r.v.toFixed(2)} px/ms): coasts as far as its release velocity predicts and settles`,
      r.settled && Math.abs(r.actualPx - r.predictedPx) <= Math.max(6, 0.12 * r.predictedPx), `predicted ${r.predictedPx.toFixed(0)}px, actual ${r.actualPx.toFixed(0)}px after a ${r.dragPx.toFixed(0)}px drag`)
  }
  const paused = await measured(10, 300, 220)
  check('a long pause before releasing the button means no coast', paused.actualPx < 1, `${paused.actualPx.toFixed(1)}px (${paused.stale.toFixed(0)}ms between the last move and the release)`)

  // The coast takes its release velocity from event timestamps and animates on requestAnimationFrame timestamps, so the
  // two must share a clock. The last trial's events are still recorded in the page.
  const clocks = await page.evaluate(() => ({ lags: window.__ev.map((e) => e.now - e.ts), raf: window.__rafOffset }))
  const lagsSorted = [...clocks.lags].sort((x, y) => x - y), medianLag = lagsSorted[Math.floor(lagsSorted.length / 2)]
  check('event.timeStamp and requestAnimationFrame share one clock', clocks.lags.length > 0 && medianLag > -20 && medianLag < 250 && typeof clocks.raf === 'number' && Math.abs(clocks.raf) < 250,
    `event.timeStamp lags performance.now() by ${medianLag.toFixed(1)} ms (median of ${clocks.lags.length}); rAF timestamp offset ${Number(clocks.raf).toFixed(1)} ms`)

  // wheel, press and Reset interrupt a coast
  const flick = async () => { await page.mouse.move(500, 400); await page.mouse.down(); for (let i = 1; i <= 5; i++) { await page.mouse.move(500 + 20 * i, 400); await wait(16) } await page.mouse.up() }
  await resetView(page); await flick(); await wait(60)
  await page.mouse.wheel(0, 100); await wait(100)
  let a = await camOf(page); await wait(500); let c = await camOf(page)
  check('a wheel turn stops a coast', a.az === c.az && !c.inertia)
  await resetView(page); await flick(); await wait(60)
  await page.mouse.down(); await wait(100); a = await camOf(page); await wait(400); c = await camOf(page); await page.mouse.up()
  check('pressing the mouse stops a coast', a.az === c.az && !c.inertia)
  await resetView(page); await flick(); await wait(80)
  await page.evaluate(() => document.getElementById('btnResetView').click()); await wait(150)
  a = await camOf(page); await wait(500); c = await camOf(page)
  check('Reset view during a coast restores the home view for good', near(a.az, -Math.PI / 4, 1e-9) && a.az === c.az && !c.inertia)

  // ---- page chrome: Help, toolbar collapse and drag
  await page.click('#btnHelp'); await wait(300)
  const help = await page.evaluate(() => { const e = document.getElementById('help'), r = e.getBoundingClientRect(); return { hidden: e.classList.contains('hidden'), r: [r.left, r.top, r.right, r.bottom], title: document.getElementById('helpTitle').textContent, links: [...e.querySelectorAll('a')].map((l) => l.href) } })
  check('Help opens, titled "3D STL Viewer", with the author and repository links', !help.hidden && help.title === '3D STL Viewer' && help.links.includes('https://github.com/zrecore') && help.links.includes('https://github.com/zrecore/3d-viewer-golang'))
  await page.keyboard.press('Escape'); await wait(200)
  check('Escape closes Help', await page.evaluate(() => document.getElementById('help').classList.contains('hidden')))
  await page.click('#btnToggleToolbar'); await wait(200)
  await page.reload({ waitUntil: 'networkidle' }); await wait(500)
  check('the collapsed toolbar stays collapsed after a reload', await page.evaluate(() => document.documentElement.classList.contains('toolbar-collapsed')))
  const handle = await page.locator('#toolbarHandle').boundingBox()
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down()
  await page.mouse.move(-2000, 3000, { steps: 8 }); await page.mouse.up(); await wait(200)
  const tb = await page.evaluate(() => { const r = document.getElementById('toolbar').getBoundingClientRect(); return { l: r.left, b: r.bottom, w: innerWidth, h: innerHeight } })
  check('dragging the toolbar to a corner stops at the window edges', near(tb.l, 0, 1) && near(tb.b, tb.h, 1), `left ${tb.l.toFixed(1)}, bottom gap ${(tb.h - tb.b).toFixed(1)}`)
  await context.close()
}

// ====================================================================================================
// iPhone emulation (touch, coarse pointer): layout and real taps
// ====================================================================================================
// the descriptor's defaultBrowserType is for Playwright's own runner and is not a context option
const { defaultBrowserType: _ignored, ...phone } = devices['iPhone 15']
{
  const { context, page } = await open({ ...phone })
  const e = await page.evaluate(() => ({ coarse: matchMedia('(pointer: coarse)').matches, collapsed: document.documentElement.classList.contains('toolbar-collapsed'), w: innerWidth, h: innerHeight }))
  check('iPhone emulation: coarse pointer, and the toolbar starts collapsed on a first visit', e.coarse && e.collapsed, JSON.stringify(e))
  await page.setInputFiles('#uploadFile', fixture('cube.stl')); await wait(1500)
  const sizes = await page.evaluate(() => ['#btnToggleToolbar', '#btnUpload', '#btnResetView', '#btnHelp'].map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [s, r.width, r.height] }))
  check('every toolbar button is at least 44x44', sizes.every(([, w, h]) => w >= 43.5 && h >= 43.5), sizes.map(([s, w, h]) => `${s} ${w.toFixed(0)}x${h.toFixed(0)}`).join(', '))
  const overlap = await page.evaluate(() => { const a = document.getElementById('viewerInfo').getBoundingClientRect(), b = document.getElementById('toolbar').getBoundingClientRect(); return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top })
  check('the info line does not run under the toolbar', !overlap)
  await page.click('#btnHelp'); await wait(400)
  const hf = await page.evaluate(() => { const r = document.getElementById('help').getBoundingClientRect(), b = document.querySelector('.help-body'); return { fits: r.left >= -0.5 && r.top >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5, xOverflow: b.scrollWidth > b.clientWidth + 1, close: document.getElementById('btnCloseHelp').getBoundingClientRect().width } })
  check('Help fits the phone screen, with no sideways scrolling and a 44px close button', hf.fits && !hf.xOverflow && hf.close >= 43.5, JSON.stringify(hf))
  await page.click('#btnCloseHelp'); await wait(200)

  // real touch taps: a double-tap resets; a single tap does not
  await page.evaluate(async () => {   // move the camera first (synthetic one-finger drag)
    const el = document.getElementById('viewerCanvas')
    const fire = (type, x) => el.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: 400, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }))
    fire('pointerdown', 100); for (let i = 1; i <= 8; i++) { fire('pointermove', 100 + i * 6); await new Promise((r) => setTimeout(r, 16)) }
    await new Promise((r) => setTimeout(r, 150)); fire('pointerup', 148)
  })
  const before = await camOf(page)
  await page.touchscreen.tap(195, 560); await wait(700)
  const afterOne = await camOf(page)
  check('a single real tap does not reset the view', afterOne.epoch === before.epoch)
  await page.touchscreen.tap(195, 560); await wait(80); await page.touchscreen.tap(198, 563); await wait(300)
  const afterDouble = await camOf(page)
  check('a double-tap with real touch taps resets the view', afterDouble.epoch === before.epoch + 1 && near(afterDouble.az, -Math.PI / 4, 1e-9), `epoch ${before.epoch} -> ${afterDouble.epoch}`)
  await context.close()
}

// ====================================================================================================
// Two-finger gestures as synthetic pointer events (no multi-touch input in Playwright's WebKit; same on both engines)
// ====================================================================================================
{
  const { context, page } = await open({ ...phone })
  await page.evaluate(() => {
    const el = document.getElementById('viewerCanvas')
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const fire = (type, id, x, y) => el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 1, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1, bubbles: true, cancelable: true }))
    window.__sim = {
      fire, frame, sleep,
      // one finger, then a pause (no fling)
      async drag1(x0, y0, x1, y1, steps = 10, gap = 24, hold = 160) {
        fire('pointerdown', 1, x0, y0)
        for (let i = 1; i <= steps; i++) { fire('pointermove', 1, x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps); await sleep(gap) }
        await sleep(hold); fire('pointerup', 1, x1, y1); await frame()
      },
      // two fingers interpolated between pair A and pair B, both moved in the same frame
      async two(A, B, { steps = 10, gap = 24, hold = 160, lift = true } = {}) {
        fire('pointerdown', 1, ...A[0]); fire('pointerdown', 2, ...A[1])
        for (let i = 1; i <= steps; i++) {
          const k = i / steps, mix = (p, q) => [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k]
          fire('pointermove', 1, ...mix(A[0], B[0])); fire('pointermove', 2, ...mix(A[1], B[1])); await sleep(gap)
        }
        await sleep(hold)
        if (lift) { fire('pointerup', 2, ...B[1]); fire('pointerup', 1, ...B[0]); await frame() }
      },
    }
  })
  const sim = (fn, ...args) => page.evaluate(([f, a]) => window.__sim[f](...a), [fn, args])
  const pair = (cx, cy, r, ang = 0) => [[cx - Math.cos(ang) * r, cy - Math.sin(ang) * r], [cx + Math.cos(ang) * r, cy + Math.sin(ang) * r]]

  await resetView(page)
  let a = await camOf(page)
  await sim('drag1', 100, 500, 200, 540)
  let c = await camOf(page)
  check('one finger orbits exactly like the mouse (dAz -0.5, dEl +0.2)', near(c.az - a.az, -0.5, 1e-6) && near(c.el - a.el, 0.2, 1e-6), `dAz=${(c.az - a.az).toFixed(4)} dEl=${(c.el - a.el).toFixed(4)}`)

  // flick coasts, then settles
  await resetView(page); a = await camOf(page)
  await page.evaluate(async () => { const s = window.__sim; s.fire('pointerdown', 1, 100, 500); for (let i = 1; i <= 5; i++) { s.fire('pointermove', 1, 100 + i * 20, 500); await s.sleep(16) } s.fire('pointerup', 1, 200, 500) })
  const at = await camOf(page)
  await page.waitForFunction(() => window.__stlViewerDebug.state().controls.inertia === false, null, { timeout: 12000 })
  c = await camOf(page)
  check('a touch flick keeps coasting after release, then settles', at.inertia === true && c.az < at.az - 0.05 && !c.inertia, `az ${at.az.toFixed(3)} -> ${c.az.toFixed(3)}`)

  // pinch toward the fingers
  await resetView(page); a = await camOf(page)
  const centre = [195, 560]
  const anchor = await page.evaluate(([x, y]) => window.__stlViewerDebug.focalPoint(x, y), centre)
  await sim('two', pair(...centre, 40), pair(...centre, 100))
  c = await camOf(page)
  const scr = await page.evaluate((p) => window.__stlViewerDebug.project(p), anchor)
  check('pinch: distance follows the finger ratio', near(c.d / (a.d * Math.exp(Math.log(40 / 100) + 0.04)), 1, 0.03), `${a.d.toFixed(3)} -> ${c.d.toFixed(3)}`)
  check('pinch: the point between the fingers stays under them', near(scr[0], centre[0], 0.5) && near(scr[1], centre[1], 0.5), `at ${scr[0].toFixed(2)},${scr[1].toFixed(2)} wanted ${centre}`)

  // two-finger pan: the model follows the fingers one for one
  await resetView(page)
  const t0 = await page.evaluate(() => window.__stlViewerDebug.project([0, 0, 0]))
  await sim('two', pair(150, 560, 50), pair(210, 530, 50))
  const t1 = await page.evaluate(() => window.__stlViewerDebug.project([0, 0, 0]))
  check('two-finger pan: the model follows the fingers (+60,-30 px)', near(t1[0] - t0[0], 60, 1) && near(t1[1] - t0[1], -30, 1), `moved ${(t1[0] - t0[0]).toFixed(2)},${(t1[1] - t0[1]).toFixed(2)}`)

  // twist: clockwise fingers turn the model clockwise on screen, above and below the horizon
  const screenAngle = () => page.evaluate(() => { const d = window.__stlViewerDebug, o = d.project([0, 0, 0]), q = d.project([1, 0, 0]); return Math.atan2(q[1] - o[1], q[0] - o[0]) })
  for (const [label, dy] of [['above', 400], ['below', -250]]) {
    await resetView(page)
    await sim('drag1', 60, 300, 60, 300 + dy, 12, 20)
    const before = await screenAngle(), az0 = (await camOf(page)).az
    await sim('two', pair(195, 560, 80, 0), pair(195, 560, 80, (40 * Math.PI) / 180))
    let delta = (await screenAngle()) - before
    while (delta > Math.PI) delta -= 2 * Math.PI
    while (delta < -Math.PI) delta += 2 * Math.PI
    check(`twist ${label} the horizon: clockwise fingers turn the model clockwise on screen`, delta > 0.3, `+${((delta * 180) / Math.PI).toFixed(1)}deg, dAz ${((await camOf(page)).az - az0).toFixed(3)}`)
  }

  // a third finger holds; lifting one finger does not orbit; cancel clears
  await resetView(page)
  await page.evaluate(() => { const s = window.__sim; s.fire('pointerdown', 1, 100, 560); s.fire('pointerdown', 2, 200, 560); s.fire('pointerdown', 3, 300, 560) })
  await wait(80)
  a = await camOf(page)
  await page.evaluate(async () => { const s = window.__sim; for (let i = 1; i <= 6; i++) { s.fire('pointermove', 1, 100 - i * 8, 560 - i * 20); s.fire('pointermove', 2, 200 + i * 15, 560 + i * 15); s.fire('pointermove', 3, 300, 560 + i * 25); await s.sleep(24) } await s.frame() })
  c = await camOf(page)
  check('three fingers: the camera holds still', near(c.az, a.az, 1e-9) && near(c.d, a.d, 1e-9) && c.t.every((v, i) => near(v, a.t[i], 1e-9)) && c.mode === 'hold', `mode ${c.mode}`)
  await page.evaluate(async () => { const s = window.__sim; s.fire('pointerup', 3, 300, 710); s.fire('pointerup', 2, 290, 650); s.fire('pointerup', 1, 52, 440); await s.frame() })
  await resetView(page)
  await page.evaluate(() => { const s = window.__sim; s.fire('pointerdown', 1, 120, 560); s.fire('pointerdown', 2, 220, 560) })
  await wait(60)
  await page.evaluate(() => window.__sim.fire('pointerup', 1, 120, 560)); await wait(60)
  a = await camOf(page)
  await page.evaluate(async () => { const s = window.__sim; for (let i = 1; i <= 6; i++) { s.fire('pointermove', 2, 220 + i * 15, 560 + i * 10); await s.sleep(24) } await s.frame() })
  c = await camOf(page)
  check('after one pinch finger lifts, the other does not orbit', near(c.az, a.az, 1e-9) && near(c.el, a.el, 1e-9) && c.mode === 'settle', `mode ${c.mode}`)
  await page.evaluate(() => window.__sim.fire('pointercancel', 2, 0, 0)); await wait(60)
  c = await camOf(page)
  check('pointercancel clears the gesture', c.touches === 0 && c.mode === 'idle', JSON.stringify({ touches: c.touches, mode: c.mode }))
  await context.close()
}

await takeScreenshot()
check(`no console errors in ${label}`, errors.length === 0, JSON.stringify(errors))
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
await browser.close()
process.exit(failures ? 1 : 0)

// A screenshot of the viewer, for a quick visual look (e2e/out is git-ignored).
async function takeScreenshot() {
  const { context, page } = await open({ viewport: { width: 1100, height: 760 } })
  await page.setInputFiles('#uploadFile', fixture('cube.stl')); await wait(1500)
  await page.click('#btnHelp'); await wait(300)
  await page.screenshot({ path: out(`${engine}.png`) })
  await context.close()
}

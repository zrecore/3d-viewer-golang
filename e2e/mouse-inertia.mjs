/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

// Mouse inertia in a real desktop browser: a flick coasts and settles, slow drags and pauses do not,
// shift/right-drag coast as pans, and the wheel, a new press, Reset view and reduced motion all stop or skip it.
// Needs the server running (go run .). See README.md.
import { BASE_URL, launch, finish, watchErrors } from './lib.mjs'
import { MOUSE, TOUCH } from '../assets/gestures.mjs' // the tuning under test (pure module, no DOM)

const b = await launch()
const page = await b.newPage()
const errors = []
watchErrors(page, errors)
const w = (ms = 100) => new Promise(r => setTimeout(r, ms))
let failures = 0
const check = (name, ok, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  ' + detail : '')); if (!ok) failures++ }
const near = (a, b2, eps) => Math.abs(a - b2) <= eps

await page.setViewport({ width: 1280, height: 800 })
await page.goto(`${BASE_URL}/?debug`, { waitUntil: 'networkidle0' }); await w(2000)
const cam = async () => { const s = await page.evaluate(() => window.__stlViewerDebug.state()); return { az: s.azimuth, el: s.elevation, d: s.distance, t: s.target, epoch: s.epoch, inertia: s.controls.inertia } }
const reset = async () => { await page.evaluate(() => document.getElementById('btnResetView').click()); await w(150) }

// a quick drag that is released while still moving (about 1.25 px/ms)
async function flick(x0 = 500, y0 = 400, dx = 20, dy = 0, steps = 5, opts = {}) {
  await page.mouse.move(x0, y0); await page.mouse.down(opts)
  for (let i = 1; i <= steps; i++) { await page.mouse.move(x0 + dx * i, y0 + dy * i); await w(16) }
  await page.mouse.up(opts)
}
// a drag that stops and waits before letting go (no momentum)
async function drag(x0, y0, x1, y1, opts = {}) {
  await page.mouse.move(x0, y0); await page.mouse.down(opts); await page.mouse.move(x1, y1, { steps: 8 }); await w(130); await page.mouse.up(opts)
}
const settles = async () => { const a = await cam(); await w(2800); const c = await cam(); await w(400); const d = await cam(); return { a, c, d, stopped: c.az === d.az && c.t.every((v, i) => v === d.t[i]) && !d.inertia } }

// --- orbit flick
await reset()
let a = await cam()
await flick()
let r0 = await cam(); await w(150); let r1 = await cam()
check('a flick keeps turning after release', r1.az < r0.az - 1e-3 && r0.inertia === true, `az ${r0.az.toFixed(3)} -> ${r1.az.toFixed(3)} (inertia ${r0.inertia})`)
check('...in the direction of the drag (rightward drag lowers the azimuth)', r1.az < a.az)
let s = await settles()
check('...and then settles by itself', s.stopped, `final az ${s.d.az.toFixed(3)}, inertia ${s.d.inertia}`)
check('...elevation is untouched by a horizontal flick', near(s.d.el, a.el, 1e-9))

// --- the coast is what the release velocity says it should be (measured from the page's real event stream)
// Scripted drags cannot be given an exact speed (every move crosses the DevTools protocol), so instead of
// asserting a speed we record the events the page actually received and predict the coast from them.
await page.evaluate(() => {
  window.__ev = []
  const c = document.getElementById('viewerCanvas')
  for (const t of ['pointermove', 'pointerup']) c.addEventListener(t, (e) => window.__ev.push({ t: e.type, ts: e.timeStamp, x: e.clientX }), true)
})
async function measuredTrial(pxPerStep, ms, stallMs = 0) {
  await reset(); await page.evaluate(() => { window.__ev = [] })
  const start = await cam()
  await page.mouse.move(300, 400); await page.mouse.down()
  let x = 300; const t0 = Date.now()
  while (Date.now() - t0 < ms) { x += pxPerStep; await page.mouse.move(x, 400); await w(2) }
  if (stallMs) await w(stallMs)
  await page.mouse.up()
  const atRelease = await cam(); await w(4200); const end = await cam()
  const ev = await page.evaluate(() => window.__ev)
  const up = ev.filter(e => e.t === 'pointerup').pop(), mv = ev.filter(e => e.t === 'pointermove')
  const last = mv[mv.length - 1]; let first = last
  for (let i = mv.length - 2; i >= 0 && last.ts - mv[i].ts <= MOUSE.VELOCITY_WINDOW_MS; i--) first = mv[i]
  const dt = last.ts - first.ts, v = dt >= MOUSE.MIN_SAMPLE_DT_MS ? (last.x - first.x) / dt : 0
  const coasts = (up.ts - last.ts) <= MOUSE.VELOCITY_STALE_MS && Math.abs(v) >= MOUSE.START_SPEED
  const predictedPx = coasts ? (Math.min(Math.abs(v) * MOUSE.GAIN, MOUSE.MAX_SPEED) - TOUCH.MIN_SPEED) * MOUSE.ORBIT_TAU_MS : 0
  return { v, predictedPx, actualPx: Math.abs(end.az - atRelease.az) / 0.005, dragPx: Math.abs(atRelease.az - start.az) / 0.005, stall: up.ts - last.ts }
}
for (const [label, step, ms] of [['fast', 14, 300], ['medium', 8, 400], ['casual', 4, 500]]) {
  const r = await measuredTrial(step, ms)
  check(`${label} swipe (${r.v.toFixed(2)} px/ms at release): coasts as far as its release velocity predicts`,
    Math.abs(r.actualPx - r.predictedPx) <= Math.max(6, 0.12 * r.predictedPx), `predicted ${r.predictedPx.toFixed(0)}px, actual ${r.actualPx.toFixed(0)}px (the drag itself was ${r.dragPx.toFixed(0)}px)`)
  check(`...and that is a visible glide (at least a third of the drag)`, r.actualPx >= r.dragPx / 3, `${r.actualPx.toFixed(0)}px after a ${r.dragPx.toFixed(0)}px drag`)
}
const brief = await measuredTrial(10, 300, 70)
check('a brief pause (about 70ms) before releasing the button still coasts', brief.stall > TOUCH.VELOCITY_STALE_MS && brief.actualPx > 40, `${brief.stall.toFixed(0)}ms between the last movement and the release, coasted ${brief.actualPx.toFixed(0)}px`)
const longPause = await measuredTrial(10, 300, 220)
check('a long pause (over 200ms) before releasing means no coast', longPause.actualPx < 1, `${longPause.actualPx.toFixed(1)}px`)

// --- vertical flick stops at the pole
await reset()
await flick(500, 300, 0, 40, 5)
s = await settles()
check('a hard downward flick coasts to the pole and stops there', s.stopped && s.d.el <= (89 * Math.PI) / 180 + 1e-9, `el ${(s.d.el * 180 / Math.PI).toFixed(1)}deg`)

// --- no momentum when slow, paused, or just a click
await reset(); a = await cam()
await drag(400, 400, 500, 440)
let c = await cam()
check('a slow drag with a pause before release has exact mouse numbers (dAz -0.5, dEl +0.2)', near(c.az - a.az, -0.5, 1e-6) && near(c.el - a.el, 0.2, 1e-6), `dAz=${(c.az - a.az).toFixed(4)} dEl=${(c.el - a.el).toFixed(4)}`)
await w(400); const afterPause = await cam()
check('...and does not coast', afterPause.az === c.az && !afterPause.inertia)
await reset(); a = await cam()
await page.mouse.move(500, 400); await page.mouse.down(); await page.mouse.up(); await w(300)
check('a plain click does not move the camera', (await cam()).az === a.az)

// --- shift / right / middle flicks coast as pans
for (const [label, opts, shift] of [['shift', {}, true], ['right-button', { button: 'right' }, false], ['middle-button', { button: 'middle' }, false]]) {
  await reset(); a = await cam()
  if (shift) await page.keyboard.down('Shift')
  await flick(500, 400, 20, -6, 5, opts)
  if (shift) await page.keyboard.up('Shift')
  r0 = await cam(); await w(150); r1 = await cam()
  check(`${label} flick keeps panning after release`, r1.t.some((v, i) => Math.abs(v - r0.t[i]) > 1e-4) && r0.inertia, `target moved ${r1.t.map((v, i) => (v - r0.t[i]).toFixed(4))}`)
  s = await settles()
  check(`...settles, and never orbits (${label})`, s.stopped && near(s.d.az, a.az, 1e-9) && near(s.d.el, a.el, 1e-9) && s.d.d === a.d)
}

// --- the wheel stops a coast
await reset()
await flick(); await w(60)
await page.mouse.wheel({ deltaY: 100 }); await w(100)
const afterWheel = await cam(); await w(500); const laterWheel = await cam()
check('a wheel turn stops the coast', afterWheel.az === laterWheel.az && !laterWheel.inertia && laterWheel.d > 4, `inertia ${laterWheel.inertia}`)

// --- pressing the model stops it dead
await reset()
await flick(); await w(60)
await page.mouse.down(); await w(100)
const held = await cam(); await w(400); const heldLater = await cam()
await page.mouse.up()
check('pressing a mouse button stops the coast', held.az === heldLater.az && !heldLater.inertia)

// --- Reset view mid-coast ends it at the home view
await reset()
await flick(); await w(80)
await page.evaluate(() => document.getElementById('btnResetView').click()); await w(150)
const home = await cam(); await w(500); const homeLater = await cam()
check('Reset view during a coast restores the home view and it stays there', near(home.az, -Math.PI / 4, 1e-9) && home.az === homeLater.az && !homeLater.inertia, `az ${homeLater.az.toFixed(4)}`)

// --- prefers-reduced-motion: no momentum at all
await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
await page.reload({ waitUntil: 'networkidle0' }); await w(2000)
await reset(); a = await cam()
await flick(); await w(200)
const rm = await cam()
check('with prefers-reduced-motion the flick does not coast', !rm.inertia && near(rm.az - a.az, -0.5, 0.2) && (await (async () => { await w(400); return (await cam()).az === rm.az })()), `inertia ${rm.inertia}`)

check('no console errors', errors.length === 0, JSON.stringify(errors))
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
await finish(b, failures)

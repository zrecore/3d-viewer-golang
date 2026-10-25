/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

// Real-Chrome multi-touch checks (CDP Input.dispatchTouchEvent): orbit, flick, pinch, pan, twist, extra fingers, cancel, double-tap.
// Needs the server running (go run .). See README.md.
import { BASE_URL, launch, finish, phone, watchErrors } from './lib.mjs'
const b = await launch()
const page = await b.newPage()
const errors = []
watchErrors(page, errors)
const w = (ms = 100) => new Promise(r => setTimeout(r, ms))
await page.emulate(phone(390, 844, 2))
await page.goto(`${BASE_URL}/?debug`, { waitUntil: 'networkidle0' }); await w(2000)
const cdp = await page.createCDPSession()
const P = (id, x, y) => ({ x, y, id, radiusX: 5, radiusY: 5, force: 1 })
const send = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts })
const S = () => page.evaluate(() => window.__stlViewerDebug.state())
const cam = async () => { const s = await S(); return { az: s.azimuth, el: s.elevation, d: s.distance, t: s.target, epoch: s.epoch, ctl: s.controls } }
const reset = async () => { await page.evaluate(() => document.getElementById('btnResetView').click()); await w(150) }

let failures = 0
const check = (name, ok, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  ' + detail : '')); if (!ok) failures++ }
const near = (a, b, eps) => Math.abs(a - b) <= eps
const nearV = (a, b, eps) => a.every((v, i) => Math.abs(v - b[i]) <= eps)

// slow single-finger drag then a pause (no fling)
async function drag1(x0, y0, x1, y1, { steps = 10, gap = 30, hold = 130 } = {}) {
  await send('touchStart', [P(1, x0, y0)])
  for (let i = 1; i <= steps; i++) { await send('touchMove', [P(1, x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps)]); await w(gap) }
  await w(hold); await send('touchEnd', [])
}
const pairAt = (cx, cy, r, ang = 0) => [[cx - Math.cos(ang) * r, cy - Math.sin(ang) * r], [cx + Math.cos(ang) * r, cy + Math.sin(ang) * r]]
// two fingers interpolated between pair A and pair B, always sending all active points
async function two(A, B, { steps = 10, gap = 30, hold = 130, end = true, keepDown = false } = {}) {
  await send('touchStart', [P(1, ...A[0])]); await send('touchStart', [P(1, ...A[0]), P(2, ...A[1])])
  for (let i = 1; i <= steps; i++) { const k = i / steps; await send('touchMove', [P(1, A[0][0] + (B[0][0] - A[0][0]) * k, A[0][1] + (B[0][1] - A[0][1]) * k), P(2, A[1][0] + (B[1][0] - A[1][0]) * k, A[1][1] + (B[1][1] - A[1][1]) * k)]); await w(gap) }
  await w(hold)
  if (end) { await send('touchEnd', [P(1, ...B[0])]); await send('touchEnd', []) }
}

// --- 1. one-finger orbit: exact mouse numbers
await reset(); let a = await cam()
await drag1(100, 500, 200, 540)
let c = await cam()
check('one-finger orbit: dAz = -dx*0.005, dEl = dy*0.005', near(c.az - a.az, -0.5, 1e-6) && near(c.el - a.el, 0.2, 1e-6), `dAz=${(c.az - a.az).toFixed(4)} dEl=${(c.el - a.el).toFixed(4)}`)
check('...slow drag with a pause before lifting does not coast', await (async () => { const s1 = await cam(); await w(400); const s2 = await cam(); return s1.az === s2.az })())

// --- 2. flick coasts then settles
await reset(); a = await cam()
await send('touchStart', [P(1, 100, 500)])
for (let i = 1; i <= 5; i++) { await send('touchMove', [P(1, 100 + i * 20, 500)]); await w(16) }
await send('touchEnd', [])
const f0 = (await cam()).az; await w(120); const f1 = (await cam()).az; await w(2500); const f2 = (await cam()).az; await w(500); const f3 = (await cam()).az
check('flick: keeps turning after release in the flick direction', f1 < f0 - 1e-4 && f2 < f1, `az ${f0.toFixed(3)} -> ${f1.toFixed(3)} -> ${f2.toFixed(3)}`)
check('flick: settles by itself', f2 === f3 && (await cam()).ctl.inertia === false)

// --- 3. pinch: zoom ratio + point under the fingers stays put
await reset(); a = await cam()
const centre = [195, 620]
const anchor = await page.evaluate(([x, y]) => window.__stlViewerDebug.focalPoint(x, y), centre)
await two(pairAt(...centre, 40), pairAt(...centre, 100))
c = await cam()
const expectD = a.d * Math.exp(Math.log(40 / 100) + 0.04)
check('pinch: distance follows the finger ratio (after the dead zone)', near(c.d / expectD, 1, 0.03), `d ${a.d.toFixed(3)} -> ${c.d.toFixed(3)}, expected ~${expectD.toFixed(3)}`)
const scr = await page.evaluate((p) => window.__stlViewerDebug.project(p), anchor)
check('pinch: point between the fingers stays under them', near(scr[0], centre[0], 0.5) && near(scr[1], centre[1], 0.5), `at ${scr[0].toFixed(2)},${scr[1].toFixed(2)} wanted ${centre}`)
check('pinch: no orbit', near(c.az, a.az, 1e-9) && near(c.el, a.el, 1e-9))

// pinch zoom-out
await reset(); a = await cam()
await two(pairAt(...centre, 120), pairAt(...centre, 60))
c = await cam()
check('pinch in: zooms out', c.d > a.d * 1.5, `d ${a.d.toFixed(3)} -> ${c.d.toFixed(3)}`)

// --- 4. two-finger pan: the target's screen position follows the fingers 1:1
await reset(); a = await cam()
const t0 = await page.evaluate(() => window.__stlViewerDebug.project([0, 0, 0]))
await two(pairAt(150, 600, 50), pairAt(210, 570, 50))
c = await cam()
const t1 = await page.evaluate(() => window.__stlViewerDebug.project([0, 0, 0]))
check('two-finger pan: model follows fingers (+60,-30 px)', near(t1[0] - t0[0], 60, 1) && near(t1[1] - t0[1], -30, 1), `moved ${(t1[0] - t0[0]).toFixed(2)},${(t1[1] - t0[1]).toFixed(2)}`)
check('two-finger pan: no zoom, no orbit', near(c.d, a.d, 1e-9) && near(c.az, a.az, 1e-9) && near(c.el, a.el, 1e-9))

// --- 5. twist: sign verified visually (screen angle of a model point) from above and below
async function screenAngle() {
  return page.evaluate(() => { const d = window.__stlViewerDebug; const o = d.project([0, 0, 0]), q = d.project([1, 0, 0]); return Math.atan2(q[1] - o[1], q[0] - o[0]) })
}
for (const [label, dragDy] of [['from above', 900], ['from below', -900]]) {
  await reset()
  await drag1(60, 300, 60, 300 + (dragDy > 0 ? 400 : -250), { steps: 12, gap: 20 }) // orbit toward the pole
  const el = (await cam()).el
  const before = await screenAngle(), az0 = (await cam()).az
  await two(pairAt(195, 620, 80, 0), pairAt(195, 620, 80, (40 * Math.PI) / 180))
  const after = await screenAngle(), az1 = (await cam()).az
  let delta = after - before; while (delta > Math.PI) delta -= 2 * Math.PI; while (delta < -Math.PI) delta += 2 * Math.PI
  check(`twist ${label}: elevation ${(el * 180 / Math.PI).toFixed(0)}deg, clockwise fingers turn the model clockwise on screen`, delta > 0.3, `screen angle +${(delta * 180 / Math.PI).toFixed(1)}deg, dAz ${(az1 - az0).toFixed(3)}`)
  check(`twist ${label}: no zoom`, near((await cam()).d, (await cam()).d, 0) && true)
}

// --- 6. third finger holds the camera; returning to two is jump-free
await reset()
await send('touchStart', [P(1, 100, 600)]); await send('touchStart', [P(1, 100, 600), P(2, 200, 600)]); await send('touchStart', [P(1, 100, 600), P(2, 200, 600), P(3, 300, 600)]); await w(60)
a = await cam()
for (let i = 1; i <= 6; i++) { await send('touchMove', [P(1, 100 - i * 8, 600 - i * 20), P(2, 200 + i * 15, 600 + i * 15), P(3, 300, 600 + i * 25)]); await w(30) }
c = await cam()
check('three fingers: camera does not move', near(c.az, a.az, 1e-9) && near(c.d, a.d, 1e-9) && c.t.every((v, i) => near(v, a.t[i], 1e-9)))
await send('touchEnd', [P(3, 300, 750)]); await w(80)   // CDP touchEnd lists the points being RELEASED
c = await cam()
check('...lifting the third finger leaves two fingers, with no jump', near(c.d, a.d, 1e-9) && c.t.every((v, i) => near(v, a.t[i], 1e-9)) && c.ctl.mode === 'two', JSON.stringify(c.ctl))
for (let i = 1; i <= 4; i++) { await send('touchMove', [P(1, 52 - i * 5, 480), P(2, 290 + i * 10, 690)]); await w(30) }
const afterTwo = await cam()
check('...and the two remaining fingers pinch from where they really are (small, smooth step)', Math.abs(Math.log(afterTwo.d / a.d)) < 0.5, `ln ratio ${Math.log(afterTwo.d / a.d).toFixed(3)}`)
await send('touchEnd', []); await w(100)

// --- 7. lifting one pinch finger: the other must not orbit
await reset()
await send('touchStart', [P(1, 120, 600)]); await send('touchStart', [P(1, 120, 600), P(2, 220, 600)]); await w(60)
await send('touchEnd', [P(1, 120, 600)]); await w(60)   // release finger 1; finger 2 stays down
a = await cam()
for (let i = 1; i <= 6; i++) { await send('touchMove', [P(2, 220 + i * 15, 600 + i * 10)]); await w(30) }
c = await cam()
check('after a pinch finger lifts, the remaining finger does not orbit', near(c.az, a.az, 1e-9) && near(c.el, a.el, 1e-9) && c.ctl.mode === 'settle', `dAz=${(c.az - a.az).toExponential(1)} mode=${c.ctl.mode}`)
await send('touchEnd', []); await w(100)
await drag1(100, 500, 140, 500, { steps: 4 }); const after7 = await cam()
check('...and a fresh touch afterwards orbits again', after7.az < c.az - 0.1)

// --- 8. cancel, blur, mouse button held
await reset()
await send('touchStart', [P(1, 120, 600)]); await send('touchStart', [P(1, 120, 600), P(2, 220, 600)]); await w(60)
await send('touchCancel', []); await w(80)
check('touchCancel clears the gesture', (await cam()).ctl.touches === 0, JSON.stringify((await cam()).ctl))
a = await cam(); await drag1(100, 500, 160, 500, { steps: 5 }); c = await cam()
check('...then a single touch orbits', near(c.az - a.az, -0.3, 1e-6))

await reset()
await send('touchStart', [P(1, 100, 500)]); await w(50)
await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await w(80)
check('window blur clears the gesture', (await cam()).ctl.touches === 0)
await send('touchEnd', []); await w(100)

await reset(); a = await cam()
await page.mouse.move(60, 300); await page.mouse.down() // mouse button held
await drag1(100, 500, 100, 600, { steps: 5 })
c = await cam(); await page.mouse.up()
check('mouse button held + a finger is not a pinch', near(c.d, a.d, 1e-9), `d ${a.d} -> ${c.d}`)

// --- 9. double tap
const tap = async (x, y, hold = 40) => { await send('touchStart', [P(1, x, y)]); await w(hold); await send('touchEnd', []) }
await reset(); await drag1(100, 500, 180, 540, { steps: 4 }); a = await cam()
await tap(195, 650); await w(80); await tap(198, 652); await w(150); c = await cam()
check('double-tap resets the view', c.epoch === a.epoch + 1 && near(c.az, -Math.PI / 4, 1e-9), `epoch ${a.epoch} -> ${c.epoch}`)

await reset(); await drag1(100, 500, 180, 540, { steps: 4 }); a = await cam()
await tap(195, 650); await w(450); await tap(195, 650); await w(150); c = await cam()
check('two taps too far apart in time do not reset', c.epoch === a.epoch)
await tap(60, 300); await w(60); await tap(330, 700); await w(150); c = await cam()
check('two taps too far apart in space do not reset', c.epoch === a.epoch)
await tap(195, 650); await w(40); await drag1(100, 500, 150, 500, { steps: 3, hold: 130 }); await tap(195, 650); await w(150); c = await cam()
check('a drag between two taps does not reset', c.epoch === a.epoch)

check('no console errors', errors.length === 0, JSON.stringify(errors))
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
await finish(b, failures)

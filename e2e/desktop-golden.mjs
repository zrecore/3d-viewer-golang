/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

// Desktop mouse controls against a recorded golden camera sequence. Use `record` to re-record.
// Needs the server running (go run .). See README.md.
import { BASE_URL, launch, finish, watchErrors } from './lib.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const mode = process.argv[2] || 'check'
const GOLDEN = fileURLToPath(new URL('./golden-desktop.json', import.meta.url))
const b = await launch()
const page = await b.newPage()
await page.setViewport({ width: 1280, height: 800 })
const errors = []
watchErrors(page, errors)
const w = (ms = 250) => new Promise(r => setTimeout(r, ms))
const cam = async () => page.evaluate(() => { const s = window.__stlViewerDebug.state(); return { azimuth: s.azimuth, elevation: s.elevation, distance: s.distance, target: s.target, eye: s.eye } })
const round = (o) => JSON.parse(JSON.stringify(o, (k, v) => typeof v === 'number' ? Number(v.toFixed(9)) : v))
// The pause before release matters: a drag that ends while still moving coasts (mouse inertia), which would
// make the numbers depend on timing. Pausing past VELOCITY_STALE_MS lets go with no momentum, so the
// recording is of the exact drag maths. Coasting itself is checked in mouse-inertia.mjs.
const drag = async (x0, y0, x1, y1, opts = {}) => { await page.mouse.move(x0, y0); await page.mouse.down(opts); await page.mouse.move(x1, y1, { steps: 6 }); await w(130); await page.mouse.up(opts) }
await page.goto(`${BASE_URL}/?debug`, { waitUntil: 'networkidle0' }); await w(2000)
const steps = {}
steps.initial = await cam()
await drag(400, 400, 500, 440); steps.leftDrag = await cam()
await page.keyboard.down('Shift'); await drag(400, 400, 440, 380); await page.keyboard.up('Shift'); steps.shiftDrag = await cam()
await drag(400, 400, 360, 430, { button: 'right' }); steps.rightDrag = await cam()
await drag(400, 400, 430, 400, { button: 'middle' }); steps.middleDrag = await cam()
await page.mouse.move(600, 400); await page.mouse.wheel({ deltaY: -300 }); await w(); steps.wheelIn = await cam()
await page.mouse.wheel({ deltaY: 500 }); await w(); steps.wheelOut = await cam()
await drag(500, 300, 500, 780); steps.orbitToClamp = await cam()
await page.click('#btnResetView'); await w(); steps.reset = await cam()
await drag(300, 400, 380, 400); await page.mouse.wheel({ deltaY: 120 }); await w(); steps.afterReset = await cam()
const result = round(steps)
console.log('errors', JSON.stringify(errors))
if (mode === 'record') { writeFileSync(GOLDEN, JSON.stringify(result, null, 1)); console.log('recorded', Object.keys(result).join(', ')) }
else {
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
  let bad = 0
  for (const k of Object.keys(golden)) { const same = JSON.stringify(golden[k]) === JSON.stringify(result[k]); if (!same) { bad++; console.log('DIFF', k, '\n golden', JSON.stringify(golden[k]), '\n actual', JSON.stringify(result[k])) } }
  console.log(bad ? `FAIL: ${bad} step(s) differ` : 'PASS: desktop controls identical to golden')
  await finish(b, bad)
}
await finish(b, 0)

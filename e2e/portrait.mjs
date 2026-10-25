/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

// Portrait framing: the model fits a phone-shaped viewport, landscape is unchanged, and rotating keeps the zoom.
// Needs the server running (go run .). See README.md.
import { BASE_URL, launch, finish, phone, watchErrors, fixture, out } from './lib.mjs'

const b = await launch()
const page = await b.newPage()
const errors = []
watchErrors(page, errors)
const w = (ms = 500) => new Promise(r => setTimeout(r, ms))
let failures = 0
const check = (name, ok, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  ' + detail : '')); if (!ok) failures++ }
const near = (a, b2, eps) => Math.abs(a - b2) <= eps

await page.emulate(phone(390, 844, 3))
await page.goto(`${BASE_URL}/?debug`, { waitUntil: 'networkidle0' }); await w(1500)
await page.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('stl-viewer') })
await page.reload({ waitUntil: 'networkidle0' }); await w(1500)
const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('#btnUpload')]); await chooser.accept([fixture('cube.stl')]); await w(1500)

// distance, and whether all 8 corners of the 2-unit cube are inside the viewport
const probe = () => page.evaluate(() => {
  const d = window.__stlViewerDebug, s = d.state(), c = s.canvas, W = c.cssWidth, H = c.cssHeight
  const corners = []; for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) corners.push(d.project([x, y, z]))
  const xs = corners.map(p => p[0]), ys = corners.map(p => p[1])
  return { aspect: W / H, distance: s.distance, frames: s.frames, canvas: [c.width, c.height], css: [W, H],
    insideViewport: Math.min(...xs) >= 0 && Math.max(...xs) <= W && Math.min(...ys) >= 0 && Math.max(...ys) <= H,
    bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(v => Math.round(v)) }
})

const portrait = await probe()
check('portrait 390x844: distance is 4 / aspect', near(portrait.distance, 4 / portrait.aspect, 1e-6), `${portrait.distance.toFixed(4)} vs ${(4 / portrait.aspect).toFixed(4)}`)
check('portrait: every cube corner is inside the viewport', portrait.insideViewport, `bbox ${portrait.bbox}`)
check('portrait: the drawing buffer is not larger than 2.5x the CSS size', portrait.canvas[0] <= Math.ceil(portrait.css[0] * 2.5) && portrait.canvas[1] <= Math.ceil(portrait.css[1] * 2.5), `buffer ${portrait.canvas} for css ${portrait.css} at dpr 3`)
await page.screenshot({ path: out('portrait.png') })

await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 3, isMobile: true, hasTouch: true }); await w(800)
const landscape = await probe()
check('landscape 844x390: distance is the unchanged default, 4', near(landscape.distance, 4, 1e-9), `${landscape.distance}`)
check('rotating redrew the canvas', landscape.frames > portrait.frames, `frames ${portrait.frames} -> ${landscape.frames}`)

await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true }); await w(800)
const back = await probe()
check('back to portrait: same framing as before', near(back.distance, portrait.distance, 1e-9), `${back.distance.toFixed(4)}`)

// a user's zoom survives a rotation
await page.mouse.move(195, 600)
await page.mouse.wheel({ deltaY: -400 }); await w(300)
const zoomed = await probe()
check('wheel zoom changed the distance', zoomed.distance < back.distance * 0.9, `${back.distance.toFixed(3)} -> ${zoomed.distance.toFixed(3)}`)
await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 3, isMobile: true, hasTouch: true }); await w(800)
const zoomedLandscape = await probe()
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true }); await w(800)
const zoomedBack = await probe()
check('zoomed: landscape distance scales by the framing ratio', near(zoomedLandscape.distance, zoomed.distance * 4 / portrait.distance, 1e-6), `${zoomedLandscape.distance.toFixed(4)}`)
check('zoomed: rotating there and back restores the user\'s zoom', near(zoomedBack.distance, zoomed.distance, 1e-6), `${zoomed.distance.toFixed(4)} -> ${zoomedBack.distance.toFixed(4)}`)

check('no console errors', errors.length === 0, JSON.stringify(errors))
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
await page.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('stl-viewer') })
await finish(b, failures)

/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

// Notch / home-indicator safe-area checks via Emulation.setSafeAreaInsetsOverride.
// Needs the server running (go run .). See README.md.
import { BASE_URL, launch, finish, phone, watchErrors, out } from './lib.mjs'
const b = await launch()
const w = (ms = 300) => new Promise(r => setTimeout(r, ms))
let failures = 0
const check = (name, ok, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  ' + detail : '')); if (!ok) failures++ }
const near = (a, b, e = 0.6) => Math.abs(a - b) <= e
const errors = []
for (const [label, W, H, insets] of [
  ['portrait notch', 390, 844, { top: 47, bottom: 34, left: 0, right: 0 }],
  ['landscape notch', 844, 390, { top: 0, bottom: 21, left: 47, right: 47 }],
]) {
  const ctx = await b.createBrowserContext(); const page = await ctx.newPage()
  watchErrors(page, errors)
  await page.emulate(phone(W, H, 2))
  const cdp = await page.createCDPSession()
  let supported = true
  try { await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: insets }) } catch (e) { supported = false; console.log('setSafeAreaInsetsOverride unavailable:', e.message) }
  check(`${label}: CDP safe-area override accepted`, supported)
  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle0' }); await w(1200)
  const probe = await page.evaluate(() => { const cs = getComputedStyle(document.getElementById('safeProbe')); return [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(parseFloat) })
  check(`${label}: probe reads the insets`, near(probe[0], insets.top) && near(probe[1], insets.right) && near(probe[2], insets.bottom) && near(probe[3], insets.left), `top/right/bottom/left = ${probe}`)
  const meta = await page.evaluate(() => document.querySelector('meta[name=viewport]').content)
  check(`${label}: viewport-fit=cover is set`, /viewport-fit=cover/.test(meta), meta)

  const r = (sel) => page.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom } }, sel)
  let tb = await r('#toolbar'), info = await r('#viewerInfo')
  check(`${label}: toolbar default clears the top inset`, tb.t >= Math.max(16, insets.top) - 0.6, `top ${tb.t.toFixed(1)}`)
  check(`${label}: toolbar default clears the right inset`, W - tb.r >= Math.max(16, insets.right) - 0.6, `right gap ${(W - tb.r).toFixed(1)}`)
  check(`${label}: info line clears the top inset`, info.t >= Math.max(16, insets.top) - 0.6, `top ${info.t.toFixed(1)}`)
  check(`${label}: info line clears the left inset`, info.l >= Math.max(16, insets.left) - 0.6, `left ${info.l.toFixed(1)}`)

  // progress bar + toast sit above the home indicator
  await page.evaluate(() => { document.getElementById('progressBar').classList.remove('hidden'); const t = document.getElementById('uploadMessage'); t.textContent = 'Saved x.stl in this browser.'; t.classList.remove('hidden') })
  const pb = await r('#progressBar'), toast = await r('#uploadMessage')
  check(`${label}: progress bar clears the bottom inset`, H - pb.b >= insets.bottom + 8, `gap ${(H - pb.b).toFixed(1)} (inset ${insets.bottom})`)
  check(`${label}: toast is above the progress bar and the inset`, toast.b <= pb.t + 0.5 && H - toast.b >= insets.bottom + 8, `gap ${(H - toast.b).toFixed(1)}`)

  // dragging keeps the toolbar out of the notch / home-indicator areas (touch drag on the handle)
  const handle = await (await page.$('#toolbarHandle')).boundingBox()
  const hx = handle.x + handle.width / 2, hy = handle.y + handle.height / 2
  await page.mouse.move(hx, hy); await page.mouse.down(); await page.mouse.move(hx - 2000, hy - 2000, { steps: 8 }); await page.mouse.up(); await w(200)
  tb = await r('#toolbar')
  check(`${label}: dragged to top-left stops at the insets`, near(tb.t, insets.top) && near(tb.l, insets.left), `top ${tb.t.toFixed(1)} (inset ${insets.top}), left ${tb.l.toFixed(1)} (inset ${insets.left})`)
  const h2 = await (await page.$('#toolbarHandle')).boundingBox()
  await page.mouse.move(h2.x + h2.width / 2, h2.y + h2.height / 2); await page.mouse.down(); await page.mouse.move(2000, 3000, { steps: 8 }); await page.mouse.up(); await w(200)
  tb = await r('#toolbar')
  check(`${label}: dragged to bottom-right stops at the insets`, near(H - tb.b, insets.bottom) && near(W - tb.r, insets.right), `bottom gap ${(H - tb.b).toFixed(1)} (inset ${insets.bottom}), right gap ${(W - tb.r).toFixed(1)} (inset ${insets.right})`)
  await page.screenshot({ path: out(`safe-${label.replace(' ', '-')}.png`) })
  await ctx.close()
}
check('no console errors', errors.length === 0, JSON.stringify(errors))
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
await finish(b, failures)

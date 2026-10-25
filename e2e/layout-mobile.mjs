/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

// Phone-size layout checks: touch-target sizes, info line vs toolbar, Help dialog fit, first-visit toolbar collapse, desktop unchanged.
// Needs the server running (go run .). See README.md.
import { BASE_URL, launch, finish, phone, watchErrors, fixture, out } from './lib.mjs'
const b = await launch()
const w = (ms = 300) => new Promise(r => setTimeout(r, ms))
let failures = 0
const check = (name, ok, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  ' + detail : '')); if (!ok) failures++ }
const errors = []

async function open(width, height, mobile = true) {
  const ctx = await b.createBrowserContext()   // fresh storage: a true first visit
  const page = await ctx.newPage()
  watchErrors(page, errors)
  if (mobile) await page.emulate(phone(width, height))
  else await page.setViewport({ width, height })
  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle0' }); await w(1200)
  return { page, ctx }
}
const rect = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height } }, sel)
const overlap = (a, c) => a && c && a.l < c.r && a.r > c.l && a.t < c.b && a.b > c.t

for (const [W, H] of [[390, 844], [360, 640], [844, 390]]) {
  const { page, ctx } = await open(W, H)
  const tag = `${W}x${H}`
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
  const collapsed = await page.evaluate(() => document.documentElement.classList.contains('toolbar-collapsed'))
  check(`${tag}: pointer is coarse under emulation`, coarse)
  check(`${tag}: toolbar starts collapsed on a first visit`, W <= 640 ? collapsed : true, `collapsed=${collapsed}`)

  // upload a model so the info line has real text
  const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('#btnUpload')]); await chooser.accept([fixture('cube.stl')]); await w(1500)

  for (const sel of ['#btnToggleToolbar', '#btnUpload', '#btnResetView', '#btnHelp']) {
    const r = await rect(page, sel)
    check(`${tag}: ${sel} is at least 44px`, r.w >= 43.5 && r.h >= 43.5, `${r.w.toFixed(1)}x${r.h.toFixed(1)}`)
  }
  const handle = await rect(page, '#toolbarHandle')
  const probe = await page.evaluate((h) => { const e = document.elementFromPoint(h.l + h.w / 2, h.t - 7); return e && (e.id || e.className) }, handle)
  const reach = handle.h + 7
  check(`${tag}: drag handle grab area is ~40px+ tall (strip ${handle.h.toFixed(0)}px + extension)`, probe === 'toolbarHandle' && reach >= 34, `7px above the strip hits "${probe}", reach ${reach.toFixed(0)}px`)

  for (const state of ['collapsed', 'expanded']) {
    const isCollapsed = await page.evaluate(() => document.documentElement.classList.contains('toolbar-collapsed'))
    if ((state === 'collapsed') !== isCollapsed) { await page.click('#btnToggleToolbar'); await w(250) }
    const info = await rect(page, '#viewerInfo'), tb = await rect(page, '#toolbar')
    check(`${tag}: info line does not run under the ${state} toolbar`, !overlap(info, tb), `info ${info.l.toFixed(0)}-${info.r.toFixed(0)}, toolbar ${tb.l.toFixed(0)}-${tb.r.toFixed(0)}`)
    check(`${tag}: info line stays on screen (${state})`, info.l >= 0 && info.r <= W)
  }

  await page.click('#btnHelp'); await w(400)
  const help = await rect(page, '#help')
  check(`${tag}: Help dialog fits the viewport`, help.l >= -0.5 && help.t >= -0.5 && help.r <= W + 0.5 && help.b <= H + 0.5, `${help.l.toFixed(0)},${help.t.toFixed(0)} - ${help.r.toFixed(0)},${help.b.toFixed(0)} in ${W}x${H}`)
  const scrollInfo = await page.evaluate(() => { const e = document.querySelector('.help-body'); return { xOverflow: e.scrollWidth > e.clientWidth + 1, scrolls: e.scrollHeight > e.clientHeight + 1 } })
  check(`${tag}: Help has no horizontal scrolling`, !scrollInfo.xOverflow, JSON.stringify(scrollInfo))
  const close = await rect(page, '#btnCloseHelp')
  check(`${tag}: Help close button is at least 44px`, close.w >= 43.5 && close.h >= 43.5, `${close.w.toFixed(0)}x${close.h.toFixed(0)}`)
  await page.screenshot({ path: out(`layout-${tag}.png`) })
  await ctx.close()
}

// desktop must look the same: expanded by default, no 44px growth
{
  const { page, ctx } = await open(1280, 800, false)
  const collapsed = await page.evaluate(() => document.documentElement.classList.contains('toolbar-collapsed'))
  const r = await rect(page, '#btnUpload'), hnd = await rect(page, '#toolbarHandle')
  check('desktop 1280x800: toolbar starts expanded', !collapsed)
  check('desktop: buttons keep their compact size (not forced to 44px)', r.h < 40, `${r.h.toFixed(1)}px`)
  check('desktop: drag strip keeps its 0.9rem height', Math.abs(hnd.h - 14.4) < 1, `${hnd.h.toFixed(1)}px`)
  await ctx.close()
}
check('no console errors', errors.length === 0, JSON.stringify(errors))
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
await finish(b, failures)

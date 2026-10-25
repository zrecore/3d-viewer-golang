/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

// Shared helpers for the browser end-to-end scripts. See README.md in this directory.
import puppeteer from 'puppeteer-core'
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The running server under test. Start it with `go run .` first. */
export const BASE_URL = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/$/, '')

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
/** Path to a file in e2e/fixtures. */
export const fixture = (name) => here('./fixtures/' + name)
/** Path for a screenshot or other artefact (e2e/out is git-ignored). */
export const out = (name) => { mkdirSync(here('./out/'), { recursive: true }); return here('./out/' + name) }

export const wait = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms))

export const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'

/** Emulated phone: touch, coarse pointer, mobile viewport. */
export const phone = (width, height, deviceScaleFactor = 2) =>
    ({ userAgent: IPHONE_UA, viewport: { width, height, deviceScaleFactor, isMobile: true, hasTouch: true } })

/** Chrome flags that give the viewer WebGPU in headless mode (software rendering). */
const WEBGPU_ARGS = ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader']

function chromePath() {
    const candidates = [
        process.env.CHROME_PATH,
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
    ].filter(Boolean)
    const found = candidates.find((p) => existsSync(p))
    if (!found) {
        console.error('Chrome not found. Install Google Chrome or set CHROME_PATH to its executable.')
        process.exit(2)
    }
    return found
}

/** Exit with a clear message when the server is not up. */
async function requireServer() {
    try {
        const res = await fetch(BASE_URL + '/')
        if (res.ok) return
        throw new Error('HTTP ' + res.status)
    } catch (err) {
        console.error(`Cannot reach ${BASE_URL} (${err.message}). Start the server with \`go run .\` or set BASE_URL.`)
        process.exit(2)
    }
}

/** Headless Chrome with software WebGPU (swiftshader), so the viewer really renders. */
export async function launch() {
    await requireServer()
    return puppeteer.launch({
        executablePath: chromePath(),
        headless: 'new',
        args: WEBGPU_ARGS,
    })
}

/**
 * A Playwright browser for the cross-browser suite: 'chrome' (your installed Chrome, software WebGPU) or
 * 'webkit' (Playwright's headless WebKit: Safari's engine with WebGPU, but not Safari.app itself).
 * Exits 3, which run-all.mjs treats as "skipped", when the WebKit build is not installed.
 * @param {'chrome'|'webkit'} engine
 * @returns {Promise<{browser: import('playwright-core').Browser, devices: typeof import('playwright-core').devices, label: string}>}
 */
export async function launchEngine(engine) {
    if (engine !== 'chrome' && engine !== 'webkit') {
        console.error(`Unknown engine "${engine}". Use "chrome" or "webkit".`)
        process.exit(2)
    }
    await requireServer()
    const { chromium, webkit, devices } = await import('playwright-core')
    if (engine === 'chrome') {
        const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: WEBGPU_ARGS })
        return { browser, devices, label: 'Chrome' }
    }
    if (!existsSync(webkit.executablePath())) {
        console.log('SKIP  Playwright WebKit is not installed. Run `npm run install-webkit` in e2e/ to enable the WebKit checks.')
        process.exit(3)
    }
    return { browser: await webkit.launch({ headless: true }), devices, label: 'WebKit' }
}

/** Close the browser and exit. Closing can hang after touch emulation, so never wait forever. */
export async function finish(browser, failures) {
    await Promise.race([browser.close(), wait(4000)])
    process.exit(failures ? 1 : 0)
}

/** Collect console errors and uncaught exceptions from a page. */
export function watchErrors(page, errors) {
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
}

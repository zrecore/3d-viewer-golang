/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

// Runs every end-to-end script in turn and reports which passed. The server must be running (go run .).
// Usage: node run-all.mjs [script-name-fragment ...]   e.g. node run-all.mjs touch layout
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPTS = [
    ['desktop-golden.mjs', ['check']], // mouse drags, wheel and reset against the recorded camera sequence
    ['mouse-inertia.mjs', []],
    ['portrait.mjs', []],
    ['layout-mobile.mjs', []],
    ['safe-area.mjs', []],
    ['cross-browser.mjs', ['chrome']], // the Playwright suite on Chrome...
    ['cross-browser.mjs', ['webkit']], // ...and on Safari's engine (optional: skipped, not failed, when WebKit is not installed)
    ['touch.mjs', []], // slowest (about two minutes), so last
]

const filters = process.argv.slice(2)
// a filter matches the script name or its argument, e.g. `node run-all.mjs webkit` or `node run-all.mjs cross-browser`
const title = (name, args) => (args[0] && args[0] !== 'check' ? `${name} ${args[0]}` : name)
const selected = SCRIPTS.filter(([name, args]) => filters.length === 0 || filters.some((f) => title(name, args).includes(f)))
if (selected.length === 0) {
    console.error('No script matches: ' + filters.join(', '))
    process.exit(2)
}

const results = []
for (const [name, args] of selected) {
    console.log(`\n=== ${title(name, args)} ===`)
    const code = await new Promise((resolve) => {
        const child = spawn(process.execPath, [fileURLToPath(new URL('./' + name, import.meta.url)), ...args], { stdio: 'inherit' })
        child.on('exit', (c) => resolve(c ?? 1))
    })
    results.push([title(name, args), code])
}

console.log('\n=== summary ===')
// exit codes: 0 passed, 1 failed, 2 Chrome or the server is missing (counts as a failure), 3 optional browser not installed (skipped)
const label = (code) => (code === 0 ? 'PASS' : code === 3 ? 'SKIP' : code === 2 ? 'ERROR (Chrome or server missing)' : 'FAIL')
for (const [name, code] of results) console.log(label(code).padEnd(8) + ' ' + name)
process.exit(results.every(([, code]) => code === 0 || code === 3) ? 0 : 1)

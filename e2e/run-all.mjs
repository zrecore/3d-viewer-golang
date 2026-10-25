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
    ['touch.mjs', []], // slowest (about two minutes), so last
]

const filters = process.argv.slice(2)
const selected = SCRIPTS.filter(([name]) => filters.length === 0 || filters.some((f) => name.includes(f)))
if (selected.length === 0) {
    console.error('No script matches: ' + filters.join(', '))
    process.exit(2)
}

const results = []
for (const [name, args] of selected) {
    console.log(`\n=== ${name} ===`)
    const code = await new Promise((resolve) => {
        const child = spawn(process.execPath, [fileURLToPath(new URL('./' + name, import.meta.url)), ...args], { stdio: 'inherit' })
        child.on('exit', (c) => resolve(c ?? 1))
    })
    results.push([name, code])
}

console.log('\n=== summary ===')
for (const [name, code] of results) console.log((code === 0 ? 'PASS' : code === 2 ? 'SKIP/ERROR(2)' : 'FAIL') + '  ' + name)
process.exit(results.every(([, code]) => code === 0) ? 0 : 1)

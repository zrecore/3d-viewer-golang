/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */
// Run with: node --test assets/*.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { isValidModelName } from './local-store.mjs'

test('isValidModelName accepts plain .stl base names', () => {
    for (const name of ['cube.stl', 'My Part v2.STL', 'a.b.stl', 'ünï.stl']) {
        assert.equal(isValidModelName(name), true, name)
    }
})

test('isValidModelName rejects paths, other extensions and junk', () => {
    for (const name of ['', '.stl', 'cube.obj', 'cube', 'a/b.stl', '..\\b.stl', '../x.stl', 'a\u0000.stl', 'x.stl\n', undefined, null, 42]) {
        assert.equal(isValidModelName(name), false, String(name))
    }
    assert.equal(isValidModelName('a'.repeat(252) + '.stl'), false)
})

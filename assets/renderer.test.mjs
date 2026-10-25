/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */
// Run with: node --test assets/*.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { backingSize } from './renderer.mjs'

test('backingSize is round(css * dpr) for ordinary displays', () => {
    assert.deepEqual(backingSize(1280, 800, 1, 8192), [1280, 800])
    assert.deepEqual(backingSize(1280, 800, 2, 8192), [2560, 1600])
    assert.deepEqual(backingSize(333.4, 200.6, 1.5, 8192), [500, 301])
})

test('backingSize treats a missing dpr as 1', () => {
    assert.deepEqual(backingSize(100, 50, 0, 8192), [100, 50])
    assert.deepEqual(backingSize(100, 50, undefined, 8192), [100, 50])
})

test('backingSize caps the device pixel ratio at 2.5 by default', () => {
    assert.deepEqual(backingSize(390, 844, 3, 8192), [975, 2110])
    assert.deepEqual(backingSize(390, 844, 4, 8192, { maxDpr: 3 }), [1170, 2532])
})

test('backingSize applies the pixel budget only when given, keeping the aspect ratio', () => {
    const unbounded = backingSize(2000, 1000, 2, 16384)
    assert.deepEqual(unbounded, [4000, 2000])
    const [w, h] = backingSize(2000, 1000, 2, 16384, { maxPixels: 2e6 })
    assert.ok(w * h <= 2e6 * 1.001, `${w}x${h}`)
    assert.ok(Math.abs(w / h - 2) < 0.01)
})

test('backingSize respects the texture limit and never returns 0', () => {
    assert.deepEqual(backingSize(20000, 100, 1, 8192), [8192, 100])
    assert.deepEqual(backingSize(0, 0, 2, 8192), [1, 1])
})

/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */
// Run with: node --test assets/*.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { multiply, perspective, lookAt, centerAndScale, normalMatrix } from './mat4.mjs'
import { OrbitCamera } from './camera.mjs'

const near = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`)

function transform(m, [x, y, z, w = 1]) {
    return [0, 1, 2, 3].map(r => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r] * w)
}

test('lookAt puts the target on the -Z axis at distance', () => {
    const v = lookAt([3, 4, 5], [0, 0, 0], [0, 0, 1])
    const p = transform(v, [0, 0, 0])
    near(p[0], 0); near(p[1], 0); near(p[2], -Math.hypot(3, 4, 5))
})

test('perspective maps near to 0 and far to 1', () => {
    const p = perspective(Math.PI / 4, 1.5, 0.1, 50)
    for (const [z, expected] of [[-0.1, 0], [-50, 1]]) {
        const c = transform(p, [0, 0, z])
        near(c[2] / c[3], expected)
    }
})

test('centerAndScale fits the model', () => {
    const m = centerAndScale([10, 20, 30], 0.5)
    assert.deepEqual(transform(m, [10, 20, 30]).slice(0, 3).map(v => v + 0), [0, 0, 0])
    assert.deepEqual(transform(m, [12, 20, 30]).slice(0, 3), [1, 0, 0])
})

test('normalMatrix keeps normals perpendicular under non-uniform scale', () => {
    const m = new Float32Array(16)
    m[0] = 2; m[5] = 1; m[10] = 0.5; m[15] = 1
    const nm = normalMatrix(m)
    // plane with normal (1,1,0): tangent (1,-1,0)
    const n = transform(nm, [1, 1, 0, 0])
    const t = transform(m, [1, -1, 0, 0])
    near(n[0] * t[0] + n[1] * t[1] + n[2] * t[2], 0)
})

test('camera orbit clamps elevation, zoom clamps distance', () => {
    const c = new OrbitCamera()
    c.orbit(0, 10)
    assert.ok(c.elevation < Math.PI / 2)
    c.zoom(1e6); assert.equal(c.distance, 40)
    c.zoom(1e-9); assert.equal(c.distance, 0.3)
    c.reset()
    assert.equal(c.distance, 4)
})

test('camera eye lies at the configured distance and basis is orthonormal', () => {
    const c = new OrbitCamera()
    const e = c.eye()
    near(Math.hypot(...e), c.distance)
    const { right, up } = c.basis()
    near(Math.hypot(...right), 1); near(Math.hypot(...up), 1)
    near(right[0] * up[0] + right[1] * up[1] + right[2] * up[2], 0)
    assert.ok(up[2] > 0, 'up points toward +Z')
})

test('pan moves target opposite to drag on screen', () => {
    const c = new OrbitCamera()
    const { right } = c.basis()
    c.pan(100, 0, 500)
    const d = c.target[0] * right[0] + c.target[1] * right[1] + c.target[2] * right[2]
    assert.ok(d < 0)
})

test('multiply is associative with identity-like transforms', () => {
    const a = centerAndScale([1, 2, 3], 2)
    const b = lookAt([0, -5, 2], [0, 0, 0], [0, 0, 1])
    const ab = multiply(b, a)
    const p = transform(ab, [1, 2, 3])
    const q = transform(b, transform(a, [1, 2, 3]))
    for (let i = 0; i < 4; i++) near(p[i], q[i])
})

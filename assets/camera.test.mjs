/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */
// Run with: node --test assets/*.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { multiply, perspective, lookAt, centerAndScale, normalMatrix } from './mat4.mjs'
import { OrbitCamera, framingDistance } from './camera.mjs'

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

// ---- touch-oriented camera maths ------------------------------------------

/** Project a world point with the same matrices the renderer uses. Returns CSS pixels. */
function gpuProject(cam, p, w, h) {
    const m = multiply(cam.projectionMatrix(w / h), cam.viewMatrix())
    const c = transform(m, p)
    return [((c[0] / c[3] + 1) / 2) * w, ((1 - c[1] / c[3]) / 2) * h]
}

const VIEWS = [
    { az: -Math.PI / 4, el: Math.PI / 6, d: 4, t: [0, 0, 0] },
    { az: 1.1, el: -0.4, d: 7, t: [0.5, -0.3, 0.2] },
    { az: 3.0, el: 1.2, d: 1.5, t: [-1, 2, 0.5] },
]

function cameraFor(v) {
    const c = new OrbitCamera()
    c.azimuth = v.az; c.elevation = v.el; c.distance = v.d; c.target = v.t.slice()
    return c
}

test('focalPlanePoint at the viewport centre is the target', () => {
    for (const v of VIEWS) {
        const c = cameraFor(v)
        const p = c.focalPlanePoint(400, 300, 800, 600)
        for (let i = 0; i < 3; i++) near(p[i], v.t[i], 1e-9)
    }
})

test('worldToScreen agrees with the renderer matrices and inverts focalPlanePoint', () => {
    for (const v of VIEWS) {
        const c = cameraFor(v)
        for (const [w, h] of [[800, 600], [390, 844]]) {
            for (const [px, py] of [[10, 20], [w / 2, h / 2], [w - 5, h - 9], [w * 0.3, h * 0.8]]) {
                const p = c.focalPlanePoint(px, py, w, h)
                const s = c.worldToScreen(p, w, h)
                near(s[0], px, 1e-6); near(s[1], py, 1e-6)
                near(s[2], v.d, 1e-6) // on the focal plane, depth equals distance
                const g = gpuProject(c, p, w, h)
                near(g[0], px, 1e-4); near(g[1], py, 1e-4)
            }
        }
    }
})

test('zoomAt keeps the point under the pixel fixed, zooming in and out', () => {
    for (const v of VIEWS) {
        for (const factor of [0.5, 0.9, 1.3, 2]) {
            const c = cameraFor(v)
            const [w, h, px, py] = [390, 844, 90, 600]
            const anchor = c.focalPlanePoint(px, py, w, h)
            c.zoomAt(factor, px, py, w, h)
            near(c.distance, v.d * factor, 1e-9)
            const s = c.worldToScreen(anchor, w, h)
            near(s[0], px, 1e-6); near(s[1], py, 1e-6)
            const g = gpuProject(c, anchor, w, h)
            near(g[0], px, 1e-4); near(g[1], py, 1e-4)
        }
    }
})

test('zoomAt at the viewport centre matches zoom()', () => {
    const a = cameraFor(VIEWS[1]); const b = cameraFor(VIEWS[1])
    a.zoomAt(1.7, 200, 400, 400, 800)
    b.zoom(1.7)
    near(a.distance, b.distance, 1e-12)
    for (let i = 0; i < 3; i++) near(a.target[i], b.target[i], 1e-12)
})

test('zoomAt is a no-op at factor 1 and at a distance limit', () => {
    const c = cameraFor(VIEWS[0])
    let changes = 0
    c.onChange = () => { changes++ }
    c.zoomAt(1, 10, 10, 400, 800)
    assert.equal(changes, 0)
    c.distance = 0.3
    const t = c.target.slice()
    c.zoomAt(0.5, 10, 10, 400, 800)
    assert.equal(c.distance, 0.3)
    assert.deepEqual(c.target, t)
    c.distance = 40
    c.zoomAt(3, 10, 10, 400, 800)
    assert.equal(c.distance, 40)
    assert.deepEqual(c.target, t)
    assert.equal(changes, 0)
})

test('zoomAt clamped part-way still keeps the anchor fixed', () => {
    const c = cameraFor({ az: 0.7, el: 0.3, d: 0.35, t: [0, 0, 0] })
    const [w, h, px, py] = [390, 844, 300, 100]
    const anchor = c.focalPlanePoint(px, py, w, h)
    c.zoomAt(0.1, px, py, w, h)
    assert.equal(c.distance, 0.3)
    const s = c.worldToScreen(anchor, w, h)
    near(s[0], px, 1e-6); near(s[1], py, 1e-6)
})

test('framingDistance is 4 for landscape/square and backs off in portrait', () => {
    assert.equal(framingDistance(16 / 9), 4)
    assert.equal(framingDistance(1), 4)
    assert.equal(framingDistance(0.5), 8)
    assert.equal(framingDistance(0), 4)
    assert.equal(framingDistance(NaN), 4)
})

test('reset uses the view aspect and bumps the epoch', () => {
    const c = new OrbitCamera()
    const e0 = c.epoch
    c.setViewAspect(0.5)
    c.reset()
    assert.equal(c.distance, 8)
    assert.equal(c.epoch, e0 + 1)
})

test('setViewAspect keeps the relative zoom through a rotation', () => {
    const c = new OrbitCamera()
    c.zoom(0.5) // user zoomed in: 2
    c.setViewAspect(0.5)
    near(c.distance, 4, 1e-12) // 2 * (8/4)
    c.setViewAspect(2)
    near(c.distance, 2, 1e-12) // back to the user's zoom
})

test('setViewAspect leaves landscape/square changes alone', () => {
    const c = new OrbitCamera()
    c.zoom(1.3)
    const d = c.distance
    c.setViewAspect(1.6)
    c.setViewAspect(2.4)
    c.setViewAspect(1)
    assert.equal(c.distance, d)
})

test('setViewAspect ignores tiny changes and invalid values, and clamps', () => {
    const c = new OrbitCamera()
    let changes = 0
    c.onChange = () => { changes++ }
    c.setViewAspect(1.0004)
    c.setViewAspect(0)
    c.setViewAspect(NaN)
    assert.equal(changes, 0)
    c.zoom(10) // 40, the maximum
    c.setViewAspect(0.1) // would be 400
    assert.equal(c.distance, 40)
})

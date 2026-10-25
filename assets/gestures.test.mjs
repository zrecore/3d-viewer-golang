/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */
// Run with: node --test assets/*.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
    TOUCH, wrapAngle, pinchMetrics, createPinchState, stepPinch,
    estimateVelocity, limitSpeed, inertiaStep, TapDetector,
} from './gestures.mjs'

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`)

test('wrapAngle folds into (-PI, PI]', () => {
    near(wrapAngle(0), 0)
    near(wrapAngle(Math.PI), Math.PI)
    near(wrapAngle(-Math.PI), Math.PI)
    near(wrapAngle(3 * Math.PI), Math.PI)
    near(wrapAngle(Math.PI + 0.1), -Math.PI + 0.1)
    near(wrapAngle(-Math.PI - 0.1), Math.PI - 0.1)
    near(wrapAngle(7 * Math.PI * 2 + 0.3), 0.3)
})

test('pinchMetrics gives centroid, separation and a clockwise-positive angle', () => {
    const m = pinchMetrics({ x: 100, y: 200 }, { x: 200, y: 200 })
    assert.deepEqual([m.cx, m.cy, m.dist], [150, 200, 100])
    near(m.angle, 0)
    // second finger moves below the first: screen y grows downward, so the angle grows (clockwise)
    near(pinchMetrics({ x: 0, y: 0 }, { x: 0, y: 10 }).angle, Math.PI / 2)
    near(pinchMetrics({ x: 0, y: 0 }, { x: -10, y: 0 }).angle, Math.PI)
})

function fingers(dist, angle, cx = 200, cy = 300) {
    const h = dist / 2
    const dx = Math.cos(angle) * h, dy = Math.sin(angle) * h
    return pinchMetrics({ x: cx - dx, y: cy - dy }, { x: cx + dx, y: cy + dy })
}

test('stepPinch: jitter below the dead zones changes nothing', () => {
    const st = createPinchState()
    let prev = fingers(200, 0)
    for (const [dist, ang] of [[204, 0.02], [199, -0.03], [203, 0.04], [200, 0]]) {
        const cur = fingers(dist, ang)
        const s = stepPinch(st, prev, cur)
        assert.equal(s.zoom, 1)
        assert.equal(s.twist, 0)
        prev = cur
    }
    assert.equal(st.zoomOn, false)
    assert.equal(st.twistOn, false)
})

test('stepPinch: zoom engages past the dead zone and then follows the fingers exactly', () => {
    const st = createPinchState()
    let prev = fingers(200, 0)
    let total = 1
    for (const dist of [210, 225, 250, 300, 360]) {
        const cur = fingers(dist, 0)
        total *= stepPinch(st, prev, cur).zoom
        prev = cur
    }
    assert.equal(st.zoomOn, true)
    // spreading zooms in (factor < 1); total = start/end minus the dead zone
    near(total, Math.exp(Math.log(200 / 360) + TOUCH.ZOOM_ENGAGE), 1e-9)
    assert.ok(total < 1)
})

test('stepPinch: pinching in zooms out, and the engage step is continuous (no jump)', () => {
    const st = createPinchState()
    const prev = fingers(200, 0)
    const cur = fingers(150, 0) // ln(200/150) = 0.288, far past the dead zone in one step
    const s = stepPinch(st, prev, cur)
    near(s.zoom, Math.exp(Math.log(200 / 150) - TOUCH.ZOOM_ENGAGE), 1e-9)
    assert.ok(s.zoom > 1)
})

test('stepPinch: clockwise twist is positive and engages after the dead zone', () => {
    const st = createPinchState()
    let prev = fingers(200, 0)
    let total = 0
    for (let i = 1; i <= 10; i++) {
        const cur = fingers(200, (i * 3 * Math.PI) / 180) // 3 degrees per step, clockwise on screen
        const s = stepPinch(st, prev, cur)
        assert.equal(s.zoom, 1)
        total += s.twist
        prev = cur
    }
    assert.equal(st.twistOn, true)
    near(total, (30 * Math.PI) / 180 - TOUCH.TWIST_ENGAGE, 1e-9)
    assert.ok(total > 0)
})

test('stepPinch: counter-clockwise twist is negative', () => {
    const st = createPinchState()
    const s = stepPinch(st, fingers(200, 0), fingers(200, (-20 * Math.PI) / 180))
    assert.ok(s.twist < 0)
})

test('stepPinch: twist is ignored while the fingers are close together', () => {
    const st = createPinchState()
    const s = stepPinch(st, fingers(TOUCH.TWIST_MIN_SEP - 1, 0), fingers(TOUCH.TWIST_MIN_SEP - 1, 1))
    assert.equal(s.twist, 0)
    assert.equal(st.twistOn, false)
})

test('stepPinch: a pure twist leaves zoom alone and a pure pinch leaves twist alone', () => {
    const a = createPinchState()
    const twisted = stepPinch(a, fingers(200, 0), fingers(200, 0.5))
    near(twisted.zoom, 1, 1e-12)
    const b = createPinchState()
    const pinched = stepPinch(b, fingers(200, 0.3), fingers(120, 0.3))
    near(pinched.twist, 0, 1e-12)
})

test('stepPinch: the angle wraps across +-PI without a spike', () => {
    // a 0.2 rad turn straddling the +-PI seam, not -2PI + 0.2
    const big = stepPinch(createPinchState(), fingers(200, Math.PI - 0.1), fingers(200, -Math.PI + 0.1))
    near(big.twist, 0.2 - TOUCH.TWIST_ENGAGE, 1e-9)
    // a tiny turn across the seam stays inside the dead zone instead of reading as a full revolution
    const small = stepPinch(createPinchState(), fingers(200, Math.PI - 0.02), fingers(200, -Math.PI + 0.02))
    assert.equal(small.twist, 0)
})

test('estimateVelocity: constant motion', () => {
    const samples = [0, 16, 32, 48, 64].map((t) => ({ t, x: t * 0.5, y: -t * 0.25 }))
    const [vx, vy] = estimateVelocity(samples, 70, ['x', 'y'])
    near(vx, 0.5); near(vy, -0.25)
})

test('estimateVelocity: only the last 100ms count', () => {
    const slow = [0, 20, 40, 60, 80].map((t) => ({ t, x: t * 0.1 }))
    const fast = [100, 116, 132, 148, 164].map((t, i) => ({ t, x: 8 + i * 16 * 2 }))
    const [vx] = estimateVelocity([...slow, ...fast], 170, ['x'])
    assert.ok(vx > 1.5, `expected the recent fast part to dominate, got ${vx}`)
})

test('estimateVelocity: zero with too few samples, a pause before release, or a tiny window', () => {
    assert.deepEqual(estimateVelocity([], 0, ['x', 'y']), [0, 0])
    assert.deepEqual(estimateVelocity([{ t: 0, x: 0 }], 5, ['x']), [0])
    const moving = [0, 16, 32].map((t) => ({ t, x: t }))
    assert.deepEqual(estimateVelocity(moving, 32 + TOUCH.VELOCITY_STALE_MS + 1, ['x']), [0])
    assert.deepEqual(estimateVelocity([{ t: 0, x: 0 }, { t: 3, x: 50 }], 4, ['x']), [0])
})

test('limitSpeed caps the magnitude and keeps the direction', () => {
    assert.deepEqual(limitSpeed(1, 1, 3), [1, 1])
    const [vx, vy] = limitSpeed(30, 40, 5)
    near(Math.hypot(vx, vy), 5)
    near(vy / vx, 40 / 30)
    assert.deepEqual(limitSpeed(0, 0, 3), [0, 0])
})

test('inertiaStep: one 32ms step equals two 16ms steps, and the distance sums to v*tau', () => {
    const one = inertiaStep(2, 32, 250)
    const a = inertiaStep(2, 16, 250)
    const b = inertiaStep(a.v, 16, 250)
    near(one.dist, a.dist + b.dist)
    near(one.v, b.v)
    near(inertiaStep(2, 1e9, 250).dist, 2 * 250, 1e-6)
    assert.ok(one.v < 2 && one.v > 0)
})

test('TapDetector: a quick stationary press is a tap; a second one nearby is a double tap', () => {
    const d = new TapDetector()
    d.begin(0, 100, 100); assert.equal(d.end(80), 'tap')
    d.begin(200, 110, 105); assert.equal(d.end(270), 'double')
    // the double tap is consumed: a third tap starts over
    d.begin(300, 110, 105); assert.equal(d.end(350), 'tap')
})

test('TapDetector: too slow, too far apart, long press, or moved fingers are not double taps', () => {
    let d = new TapDetector()
    d.begin(0, 0, 0); d.end(50)
    d.begin(500, 0, 0); assert.equal(d.end(550), 'tap') // 500ms after the first tap

    d = new TapDetector()
    d.begin(0, 0, 0); d.end(50)
    d.begin(100, 200, 0); assert.equal(d.end(150), 'tap') // 200px away

    d = new TapDetector()
    d.begin(0, 0, 0); assert.equal(d.end(400), null) // held too long

    d = new TapDetector()
    d.begin(0, 0, 0); d.moved(40, 0); assert.equal(d.end(60), null) // dragged
})

test('TapDetector: a drag between two taps prevents the double tap', () => {
    const d = new TapDetector()
    d.begin(0, 50, 50); assert.equal(d.end(60), 'tap')
    d.begin(100, 50, 50); d.moved(200, 50); assert.equal(d.end(150), null)
    d.begin(200, 50, 50); assert.equal(d.end(240), 'tap')
})

test('TapDetector: reset forgets a pending first tap', () => {
    const d = new TapDetector()
    d.begin(0, 0, 0); d.end(40)
    d.reset()
    d.begin(100, 0, 0); assert.equal(d.end(140), 'tap')
})

test('TapDetector: slop is measured from where the finger went down', () => {
    const d = new TapDetector()
    d.begin(0, 100, 100)
    d.moved(104, 103) // within 10px
    assert.equal(d.end(50), 'tap')
})

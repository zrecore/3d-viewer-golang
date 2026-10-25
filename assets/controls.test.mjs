/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */
// Run with: node --test assets/*.test.mjs
// OrbitControls against a fake element. The mouse-parity tests pin down the
// desktop behaviour so touch work cannot change it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrbitCamera, OrbitControls } from './camera.mjs'
import { TOUCH, MOUSE } from './gestures.mjs'

class FakeEl extends EventTarget {
    constructor() {
        super()
        this.style = {}
        this.clientWidth = 800
        this.clientHeight = 600
        this.captured = []
        this.released = []
    }
    setPointerCapture(id) { this.captured.push(id) }
    releasePointerCapture(id) { this.released.push(id) }
    getBoundingClientRect() {
        return { left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight }
    }
    fire(type, props = {}) {
        const ev = Object.assign(new Event(type, { cancelable: true }), {
            pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: 0, button: 0, shiftKey: false, ...props,
        })
        // timeStamp is a getter-only accessor on Event, so shadow it to inject a clock
        if (props.t !== undefined) Object.defineProperty(ev, 'timeStamp', { value: props.t })
        this.dispatchEvent(ev)
        return ev
    }
}

function setup() {
    const el = new FakeEl()
    const camera = new OrbitCamera()
    const controls = new OrbitControls(el, camera)
    return { el, camera, controls }
}

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`)
const snapshot = (c) => ({ az: c.azimuth, el: c.elevation, d: c.distance, t: c.target.slice() })

test('constructor disables browser touch gestures on the element', () => {
    const { el } = setup()
    assert.equal(el.style.touchAction, 'none')
})

test('mouse: left-drag orbits at 0.005 rad per pixel', () => {
    const { el, camera } = setup()
    const before = snapshot(camera)
    el.fire('pointerdown', { clientX: 100, clientY: 100 })
    el.fire('pointermove', { clientX: 200, clientY: 140 })
    near(camera.azimuth, before.az - 100 * 0.005)
    near(camera.elevation, before.el + 40 * 0.005)
    assert.equal(camera.distance, before.d)
    assert.deepEqual(camera.target, before.t)
})

test('mouse: successive moves accumulate relative to the last position', () => {
    const { el, camera } = setup()
    const before = camera.azimuth
    el.fire('pointerdown', { clientX: 0, clientY: 0 })
    el.fire('pointermove', { clientX: 10, clientY: 0 })
    el.fire('pointermove', { clientX: 30, clientY: 0 })
    near(camera.azimuth, before - 30 * 0.005)
})

test('mouse: shift-drag, right-drag and middle-drag pan instead of orbiting', () => {
    for (const down of [{ shiftKey: true }, { button: 2 }, { button: 1 }]) {
        const { el, camera } = setup()
        const expected = new OrbitCamera()
        expected.pan(30, -20, el.clientHeight)
        el.fire('pointerdown', { clientX: 100, clientY: 100, ...down })
        el.fire('pointermove', { clientX: 130, clientY: 80, ...down })
        near(camera.azimuth, expected.azimuth)
        near(camera.elevation, expected.elevation)
        assert.deepEqual(camera.target.map((v) => Number(v.toFixed(12))), expected.target.map((v) => Number(v.toFixed(12))))
    }
})

test('mouse: pressing shift mid-drag switches to pan', () => {
    const { el, camera } = setup()
    const before = snapshot(camera)
    el.fire('pointerdown', { clientX: 0, clientY: 0 })
    el.fire('pointermove', { clientX: 20, clientY: 0, shiftKey: true })
    near(camera.azimuth, before.az)
    assert.notDeepEqual(camera.target, before.t)
})

test('mouse: wheel zooms by exp(deltaY * scale * 0.0015) for pixel, line and page modes', () => {
    for (const [deltaMode, scale] of [[0, 1], [1, 16], [2, 100]]) {
        const { el, camera } = setup()
        const before = camera.distance
        const ev = el.fire('wheel', { deltaY: 10, deltaMode })
        near(camera.distance, before * Math.exp(10 * scale * 0.0015))
        assert.equal(ev.defaultPrevented, true)
    }
})

test('mouse: wheel zoom respects the distance limits', () => {
    const { el, camera } = setup()
    for (let i = 0; i < 200; i++) el.fire('wheel', { deltaY: -500 })
    assert.equal(camera.distance, 0.3)
    for (let i = 0; i < 200; i++) el.fire('wheel', { deltaY: 500 })
    assert.equal(camera.distance, 40)
})

test('mouse: contextmenu is suppressed so right-drag can pan', () => {
    const { el } = setup()
    assert.equal(el.fire('contextmenu').defaultPrevented, true)
})

test('mouse: pointerdown captures the pointer and prevents default', () => {
    const { el } = setup()
    const ev = el.fire('pointerdown', { pointerId: 7 })
    assert.deepEqual(el.captured, [7])
    assert.equal(ev.defaultPrevented, true)
})

test('mouse: moving without a button down, or after release, does nothing', () => {
    const { el, camera } = setup()
    const before = snapshot(camera)
    el.fire('pointermove', { clientX: 50, clientY: 50 })
    el.fire('pointerdown', { clientX: 50, clientY: 50 })
    el.fire('pointerup', { clientX: 50, clientY: 50 })
    assert.deepEqual(el.released, [1])
    el.fire('pointermove', { clientX: 90, clientY: 90 })
    assert.deepEqual(snapshot(camera), before)
})

test('mouse: pointercancel ends a drag like pointerup', () => {
    const { el, camera } = setup()
    el.fire('pointerdown', { clientX: 0, clientY: 0 })
    el.fire('pointercancel')
    const before = snapshot(camera)
    el.fire('pointermove', { clientX: 40, clientY: 40 })
    assert.deepEqual(snapshot(camera), before)
})

test('mouse: elevation stays clamped while orbiting', () => {
    const { el, camera } = setup()
    el.fire('pointerdown', { clientX: 0, clientY: 0 })
    el.fire('pointermove', { clientX: 0, clientY: 100000 })
    near(camera.elevation, (89 * Math.PI) / 180)
    el.fire('pointermove', { clientX: 0, clientY: -100000 })
    near(camera.elevation, -(89 * Math.PI) / 180)
})

test('dispose removes the listeners', () => {
    const { el, camera, controls } = setup()
    controls.dispose()
    const before = snapshot(camera)
    el.fire('pointerdown', { clientX: 0, clientY: 0 })
    el.fire('pointermove', { clientX: 80, clientY: 80 })
    el.fire('wheel', { deltaY: 100 })
    assert.deepEqual(snapshot(camera), before)
})

// ---- touch and pen ---------------------------------------------------------

/** A hand-driven requestAnimationFrame queue. */
function fakeRaf() {
    const q = new Map()
    let id = 0
    return {
        raf: (fn) => { q.set(++id, fn); return id },
        caf: (h) => { q.delete(h) },
        pending: () => q.size,
        step(ts) { const fns = [...q.values()]; q.clear(); fns.forEach((f) => f(ts)) },
    }
}

function touchSetup(opts = {}) {
    const el = new FakeEl()
    const camera = new OrbitCamera()
    const frames = fakeRaf()
    const controls = new OrbitControls(el, camera, { raf: frames.raf, caf: frames.caf, ...opts })
    const f = (type, id, x, y, t = 0, extra = {}) =>
        el.fire(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, t, ...extra })
    return {
        el, camera, controls, frames,
        down: (id, x, y, t, extra) => f('pointerdown', id, x, y, t, extra),
        move: (id, x, y, t, extra) => f('pointermove', id, x, y, t, extra),
        up: (id, x, y, t, extra) => f('pointerup', id, x, y, t, extra),
        cancel: (id, t) => f('pointercancel', id, 0, 0, t),
        lostCapture: (id) => f('lostpointercapture', id, 0, 0, 0),
    }
}

/** Two fingers at +-r around (cx, cy), rotated by `angle` radians (clockwise on screen). */
function pair(cx, cy, r, angle = 0) {
    const dx = Math.cos(angle) * r, dy = Math.sin(angle) * r
    return [[cx - dx, cy - dy], [cx + dx, cy + dy]]
}

/** Put two fingers down, then move them to a new pair in one frame. */
function pinchTo(h, from, to, t = 0) {
    h.down(1, from[0][0], from[0][1], t)
    h.down(2, from[1][0], from[1][1], t)
    h.move(1, to[0][0], to[0][1], t + 16)
    h.move(2, to[1][0], to[1][1], t + 16)
    h.frames.step(t + 16)
}

test('touch: one finger orbits exactly like a mouse drag', () => {
    const h = touchSetup()
    const before = snapshot(h.camera)
    h.down(1, 100, 100, 0)
    h.move(1, 200, 140, 16)
    near(h.camera.azimuth, before.az - 100 * 0.005)
    near(h.camera.elevation, before.el + 40 * 0.005)
    assert.equal(h.camera.distance, before.d)
    assert.deepEqual(h.camera.target, before.t)
})

test('touch: pointerdown captures the pointer and prevents default', () => {
    const h = touchSetup()
    const ev = h.down(4, 10, 10, 0)
    assert.deepEqual(h.el.captured, [4])
    assert.equal(ev.defaultPrevented, true)
})

test('touch: a mouse button held down does not turn a finger into a pinch', () => {
    const h = touchSetup()
    h.el.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0 }) // mouse button held
    const before = snapshot(h.camera)
    h.down(2, 100, 100, 0)
    h.move(2, 160, 100, 16)
    near(h.camera.azimuth, before.az - 60 * 0.005) // orbit, not a pinch
    assert.equal(h.camera.distance, before.d)
})

test('touch: a finger present does not disturb a mouse drag', () => {
    const h = touchSetup()
    h.down(2, 300, 300, 0)
    const az = h.camera.azimuth
    h.el.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0 })
    h.el.fire('pointermove', { pointerId: 1, clientX: 50, clientY: 0 })
    near(h.camera.azimuth, az - 50 * 0.005)
})

test('pen: one pointer orbits like touch, and its secondary button pans', () => {
    const h = touchSetup()
    const az = h.camera.azimuth
    h.el.fire('pointerdown', { pointerId: 3, pointerType: 'pen', clientX: 0, clientY: 0, t: 0 })
    h.el.fire('pointermove', { pointerId: 3, pointerType: 'pen', clientX: 40, clientY: 0, t: 16 })
    near(h.camera.azimuth, az - 40 * 0.005)
    h.el.fire('pointerup', { pointerId: 3, pointerType: 'pen', clientX: 40, clientY: 0, t: 300 })

    const p = touchSetup()
    const expected = new OrbitCamera()
    expected.pan(30, 0, p.el.clientHeight)
    p.el.fire('pointerdown', { pointerId: 3, pointerType: 'pen', button: 2, clientX: 0, clientY: 0, t: 0 })
    p.el.fire('pointermove', { pointerId: 3, pointerType: 'pen', button: 2, clientX: 30, clientY: 0, t: 16 })
    near(p.camera.azimuth, expected.azimuth)
    near(p.camera.target[0], expected.target[0], 1e-12)
    near(p.camera.target[1], expected.target[1], 1e-12)
})

test('pinch: spreading fingers zooms in, and the point between them stays under them', () => {
    const h = touchSetup()
    const rect = h.el.getBoundingClientRect()
    const from = pair(300, 200, 50)
    const anchor = h.camera.focalPlanePoint(300, 200, rect.width, rect.height)
    const d0 = h.camera.distance
    h.down(1, ...from[0], 0); h.down(2, ...from[1], 0)
    for (let i = 1; i <= 8; i++) {
        const [a, b] = pair(300, 200, 50 + i * 10)
        h.move(1, ...a, i * 16); h.move(2, ...b, i * 16)
        h.frames.step(i * 16)
    }
    assert.ok(h.camera.distance < d0 * 0.7, `expected a clear zoom in, got ${h.camera.distance}`)
    const s = h.camera.worldToScreen(anchor, rect.width, rect.height)
    near(s[0], 300, 1e-6); near(s[1], 200, 1e-6)
})

test('pinch: bringing fingers together zooms out', () => {
    const h = touchSetup()
    const d0 = h.camera.distance
    pinchTo(h, pair(400, 300, 150), pair(400, 300, 60))
    assert.ok(h.camera.distance > d0)
})

test('pinch: both fingers moving together pans without zooming or twisting', () => {
    const h = touchSetup()
    const before = snapshot(h.camera)
    const from = pair(400, 300, 50)
    h.down(1, ...from[0], 0); h.down(2, ...from[1], 0)
    // the two events of one frame arrive separately, but are applied together
    h.move(1, from[0][0] + 40, from[0][1], 16)
    h.move(2, from[1][0] + 40, from[1][1], 16)
    h.frames.step(16)
    assert.equal(h.camera.distance, before.d)
    near(h.camera.azimuth, before.az)
    near(h.camera.elevation, before.el)
    assert.notDeepEqual(h.camera.target, before.t)
    const expected = new OrbitCamera()
    expected.pan(40, 0, h.el.clientHeight)
    for (let i = 0; i < 3; i++) near(h.camera.target[i], expected.target[i], 1e-9)
})

test('twist: turning clockwise raises the azimuth viewed from above, and lowers it from below', () => {
    for (const [elevation, sign] of [[0.5, 1], [-0.5, -1]]) {
        const h = touchSetup()
        h.camera.elevation = elevation
        const az = h.camera.azimuth
        const dist = h.camera.distance
        pinchTo(h, pair(400, 300, 80, 0), pair(400, 300, 80, (40 * Math.PI) / 180))
        const expected = (40 * Math.PI) / 180 - TOUCH.TWIST_ENGAGE
        near(h.camera.azimuth - az, sign * expected, 1e-6)
        assert.equal(h.camera.elevation, elevation)
        near(h.camera.distance, dist, 1e-9) // a pure twist does not zoom
    }
})

test('twist: counter-clockwise is the opposite direction', () => {
    const h = touchSetup()
    const az = h.camera.azimuth
    pinchTo(h, pair(400, 300, 80, 0), pair(400, 300, 80, (-40 * Math.PI) / 180))
    assert.ok(h.camera.azimuth < az)
})

test('pinch: small jitter inside the dead zones does nothing', () => {
    const h = touchSetup()
    const before = snapshot(h.camera)
    pinchTo(h, pair(400, 300, 100), pair(400, 300, 102, 0.03))
    assert.deepEqual(snapshot(h.camera), before)
})

test('three fingers hold the camera still, and returning to two does not jump', () => {
    const h = touchSetup()
    h.down(1, 300, 300, 0); h.down(2, 400, 300, 0)
    h.down(3, 500, 300, 5)
    const held = snapshot(h.camera)
    // wander the fingers a long way while three are down
    h.move(1, 100, 100, 16); h.move(2, 700, 500, 16); h.move(3, 50, 500, 16)
    h.frames.step(16)
    assert.deepEqual(snapshot(h.camera), held)
    h.up(3, 50, 500, 32)
    h.frames.step(32)
    assert.deepEqual(snapshot(h.camera), held) // fresh baseline: no catch-up jump
    // two fingers keep working from where they actually are
    h.move(1, 90, 100, 48); h.move(2, 710, 500, 48)
    h.frames.step(48)
    const d = Math.abs(Math.log(h.camera.distance / held.d))
    assert.ok(d < 0.1, `expected a small step after re-baselining, got ln ratio ${d}`)
})

test('lifting one finger of a pinch does not hand the other one to orbit', () => {
    const h = touchSetup()
    h.down(1, 300, 300, 0); h.down(2, 400, 300, 0)
    h.up(2, 400, 300, 16)
    const before = snapshot(h.camera)
    h.move(1, 380, 340, 32)
    h.move(1, 420, 380, 48)
    assert.deepEqual(snapshot(h.camera), before)
    h.up(1, 420, 380, 64)
    // after everything lifts, a fresh finger orbits again
    h.down(5, 0, 0, 500); h.move(5, 30, 0, 516)
    near(h.camera.azimuth, before.az - 30 * 0.005)
})

test('a second finger can join again after one lifted, with a fresh baseline', () => {
    const h = touchSetup()
    h.down(1, 300, 300, 0); h.down(2, 400, 300, 0)
    h.up(2, 400, 300, 16)
    const before = snapshot(h.camera)
    h.down(3, 500, 300, 40) // pinch resumes: no jump on joining
    h.frames.step(40)
    assert.deepEqual(snapshot(h.camera), before)
    h.move(3, 700, 300, 56)
    h.frames.step(56)
    assert.ok(h.camera.distance < before.d)
})

test('pointercancel mid-pinch drops the gesture; a later single touch orbits', () => {
    const h = touchSetup()
    h.down(1, 300, 300, 0); h.down(2, 400, 300, 0)
    h.cancel(1, 16); h.cancel(2, 16)
    assert.equal(h.controls.debugState().touches, 0)
    const az = h.camera.azimuth
    h.down(7, 0, 0, 100); h.move(7, 20, 0, 116)
    near(h.camera.azimuth, az - 20 * 0.005)
})

test('lostpointercapture after a normal lift is harmless; before one it cancels', () => {
    const h = touchSetup()
    h.down(1, 0, 0, 0); h.up(1, 0, 0, 20)
    h.lostCapture(1) // fired by the browser after releasePointerCapture
    assert.deepEqual(h.controls.debugState(), { mode: 'idle', touches: 0, inertia: false })

    h.down(2, 0, 0, 100)
    h.lostCapture(2) // capture lost while still down
    assert.equal(h.controls.debugState().touches, 0)
    const before = snapshot(h.camera)
    h.move(2, 50, 50, 116)
    assert.deepEqual(snapshot(h.camera), before)
})

test('window blur and a hidden page clear the gesture', () => {
    const win = new EventTarget()
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    globalThis.window = win
    globalThis.document = doc
    try {
        const h = touchSetup()
        h.down(1, 0, 0, 0)
        win.dispatchEvent(new Event('blur'))
        assert.equal(h.controls.debugState().touches, 0)
        h.down(2, 0, 0, 100)
        doc.visibilityState = 'hidden'
        doc.dispatchEvent(new Event('visibilitychange'))
        assert.equal(h.controls.debugState().touches, 0)
        h.controls.dispose()
        let calls = 0
        const original = h.controls.touch.cancelAll.bind(h.controls.touch)
        h.controls.touch.cancelAll = () => { calls++; original() }
        win.dispatchEvent(new Event('blur'))
        doc.dispatchEvent(new Event('visibilitychange'))
        assert.equal(calls, 0) // dispose removed the window and document listeners
    } finally {
        delete globalThis.window
        delete globalThis.document
    }
})

test('double-tap resets the view', () => {
    const h = touchSetup()
    h.camera.orbit(1, 0.2); h.camera.zoom(0.5)
    const epoch = h.camera.epoch
    h.down(1, 200, 200, 0); h.up(1, 200, 200, 60)
    assert.equal(h.camera.epoch, epoch) // a single tap does nothing
    h.down(1, 205, 203, 150); h.up(1, 205, 203, 200)
    assert.equal(h.camera.epoch, epoch + 1)
    near(h.camera.distance, 4)
})

test('double-tap needs two quick taps close together and no drag in between', () => {
    const cases = [
        ['too slow', (h) => { h.down(1, 0, 0, 0); h.up(1, 0, 0, 40); h.down(1, 0, 0, 600); h.up(1, 0, 0, 640) }],
        ['too far apart', (h) => { h.down(1, 0, 0, 0); h.up(1, 0, 0, 40); h.down(1, 200, 0, 100); h.up(1, 200, 0, 140) }],
        ['a drag in between', (h) => {
            h.down(1, 0, 0, 0); h.up(1, 0, 0, 40)
            h.down(1, 0, 0, 80); h.move(1, 100, 0, 96); h.up(1, 100, 0, 112)
            h.down(1, 0, 0, 150); h.up(1, 0, 0, 190)
        }],
        ['a held press', (h) => { h.down(1, 0, 0, 0); h.up(1, 0, 0, 40); h.down(1, 0, 0, 100); h.up(1, 0, 0, 700) }],
    ]
    for (const [name, run] of cases) {
        const h = touchSetup({ inertia: false })
        const epoch = h.camera.epoch
        run(h)
        assert.equal(h.camera.epoch, epoch, name)
    }
})

test('a pinch between two taps prevents a double-tap', () => {
    const h = touchSetup()
    const epoch = h.camera.epoch
    h.down(1, 100, 100, 0); h.up(1, 100, 100, 40)
    h.down(1, 100, 100, 60); h.down(2, 180, 100, 62); h.up(2, 180, 100, 90); h.up(1, 100, 100, 100)
    h.down(1, 100, 100, 150); h.up(1, 100, 100, 190)
    assert.equal(h.camera.epoch, epoch)
})

test('inertia: a flick keeps coasting, decays, and stops on its own', () => {
    const h = touchSetup()
    h.down(1, 100, 100, 0)
    for (let i = 1; i <= 4; i++) h.move(1, 100 + i * 24, 100, i * 16) // 1.5 px/ms
    h.up(1, 196, 100, 70)
    assert.ok(h.controls.touch.inertiaActive)
    const released = h.camera.azimuth
    let ts = 70
    let steps = 0
    let prev = released
    let firstDelta = 0
    while (h.frames.pending() && steps < 200) {
        ts += 16; steps++
        h.frames.step(ts)
        if (steps === 1) firstDelta = h.camera.azimuth - prev
        prev = h.camera.azimuth
    }
    assert.ok(steps > 5 && steps < 200, `ran ${steps} frames`)
    assert.ok(h.camera.azimuth < released, 'kept turning in the flick direction')
    assert.ok(firstDelta < 0)
    assert.equal(h.controls.touch.inertiaActive, false)
    const after = snapshot(h.camera)
    h.frames.step(ts + 16)
    assert.deepEqual(snapshot(h.camera), after)
})

test('inertia: frame rate does not change how far a flick coasts', () => {
    const run = (frameMs) => {
        const h = touchSetup()
        h.down(1, 100, 100, 0)
        for (let i = 1; i <= 4; i++) h.move(1, 100 + i * 24, 100, i * 16)
        h.up(1, 196, 100, 70)
        let ts = 70
        while (h.frames.pending()) { ts += frameMs; h.frames.step(ts) }
        return h.camera.azimuth
    }
    near(run(8), run(32), 0.02)
})

test('inertia: pausing before lifting gives no coast', () => {
    const h = touchSetup()
    h.down(1, 100, 100, 0)
    for (let i = 1; i <= 4; i++) h.move(1, 100 + i * 24, 100, i * 16)
    h.up(1, 196, 100, 64 + TOUCH.VELOCITY_STALE_MS + 20)
    assert.equal(h.controls.touch.inertiaActive, false)
    assert.equal(h.frames.pending(), 0)
})

test('inertia: a tap or a very slow drag does not coast', () => {
    const h = touchSetup()
    h.down(1, 100, 100, 0); h.up(1, 100, 100, 50)
    assert.equal(h.controls.touch.inertiaActive, false)
    h.down(1, 100, 100, 1000)
    for (let i = 1; i <= 5; i++) h.move(1, 100 + i, 100, 1000 + i * 30)
    h.up(1, 105, 100, 1160)
    assert.equal(h.controls.touch.inertiaActive, false)
})

test('inertia: touching the screen, the wheel, a reset, blur or dispose all stop it', () => {
    const start = (h) => {
        h.down(1, 100, 100, 0)
        for (let i = 1; i <= 4; i++) h.move(1, 100 + i * 24, 100, i * 16)
        h.up(1, 196, 100, 70)
        assert.ok(h.controls.touch.inertiaActive)
    }
    let h = touchSetup(); start(h)
    h.down(2, 0, 0, 80)
    assert.equal(h.controls.touch.inertiaActive, false)
    assert.equal(h.frames.pending(), 0)

    h = touchSetup(); start(h)
    h.el.fire('wheel', { deltaY: 10 })
    assert.equal(h.controls.touch.inertiaActive, false)

    h = touchSetup(); start(h)
    h.camera.reset() // e.g. the Reset view button, a double-tap or a newly loaded model
    h.frames.step(86)
    assert.equal(h.controls.touch.inertiaActive, false)
    near(h.camera.azimuth, -Math.PI / 4)

    h = touchSetup(); start(h)
    h.controls.touch.cancelAll()
    assert.equal(h.controls.touch.inertiaActive, false)

    h = touchSetup(); start(h)
    h.el.fire('pointerdown', { pointerId: 9, pointerType: 'mouse' }) // a mouse press stops a touch fling too
    assert.equal(h.controls.touch.inertiaActive, false)
})

test('inertia: the inertia option turns coasting off for touch and mouse', () => {
    const off = touchSetup({ inertia: false })
    off.down(1, 100, 100, 0)
    for (let i = 1; i <= 4; i++) off.move(1, 100 + i * 24, 100, i * 16)
    off.up(1, 196, 100, 70)
    assert.equal(off.frames.pending(), 0)

    const m = mouseSetup({ inertia: false })
    m.flick()
    assert.equal(m.frames.pending(), 0)
    assert.equal(m.controls.touch.inertiaActive, false)
})

test('inertia: a two-finger pan coasts after the first finger lifts', () => {
    const h = touchSetup()
    const from = pair(300, 300, 50)
    h.down(1, ...from[0], 0); h.down(2, ...from[1], 0)
    for (let i = 1; i <= 4; i++) {
        h.move(1, from[0][0] + i * 24, from[0][1], i * 16)
        h.move(2, from[1][0] + i * 24, from[1][1], i * 16)
        h.frames.step(i * 16)
    }
    h.up(2, from[1][0] + 96, from[1][1], 70)
    assert.ok(h.controls.touch.inertiaActive)
    const t = h.camera.target.slice()
    h.frames.step(86)
    assert.notDeepEqual(h.camera.target, t)
    // the remaining finger lifting later does not restart or orbit
    const az = h.camera.azimuth
    h.move(1, from[0][0] + 200, from[0][1] + 50, 90)
    near(h.camera.azimuth, az)
})

test('inertia: an orbit fling stops vertical drift at the pole', () => {
    const h = touchSetup()
    h.down(1, 100, 100, 0)
    for (let i = 1; i <= 4; i++) h.move(1, 100, 100 + i * 24, i * 16) // flick downward: elevation rises
    h.up(1, 100, 196, 70)
    let ts = 70
    while (h.frames.pending() && ts < 5000) { ts += 16; h.frames.step(ts) }
    assert.ok(h.camera.elevation <= (89 * Math.PI) / 180 + 1e-12)
    assert.equal(h.controls.touch.inertiaActive, false)
})

test('dispose removes the touch listeners as well', () => {
    const h = touchSetup()
    h.controls.dispose()
    const before = snapshot(h.camera)
    h.down(1, 0, 0, 0); h.move(1, 90, 90, 16)
    assert.deepEqual(snapshot(h.camera), before)
})

// ---- mouse inertia ----------------------------------------------------------

function mouseSetup(opts = {}) {
    const h = touchSetup(opts)
    const f = (type, x, y, t, extra = {}) => h.el.fire(type, { pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y, t, ...extra })
    return {
        ...h,
        mdown: (x, y, t, extra) => f('pointerdown', x, y, t, extra),
        mmove: (x, y, t, extra) => f('pointermove', x, y, t, extra),
        mup: (x, y, t, extra) => f('pointerup', x, y, t, extra),
        mcancel: (t) => f('pointercancel', 0, 0, t),
        /** A quick horizontal flick released right at the end: 1.5 px/ms. */
        flick(extraDown = {}, extraMove = {}) {
            f('pointerdown', 100, 100, 0, extraDown)
            for (let i = 1; i <= 4; i++) f('pointermove', 100 + i * 24, 100, i * 16, extraMove)
            f('pointerup', 196, 100, 70, extraMove)
        },
    }
}

/** Run pending animation frames until the coast ends. */
function coastToEnd(h, from = 70, frameMs = 16) {
    let ts = from
    let frames = 0
    while (h.frames.pending() && frames < 500) { ts += frameMs; frames++; h.frames.step(ts) }
    return frames
}

test('mouse inertia: a quick flick keeps coasting, decays, and stops on its own', () => {
    const m = mouseSetup()
    m.flick()
    assert.ok(m.controls.touch.inertiaActive)
    const released = m.camera.azimuth
    const frames = coastToEnd(m)
    assert.ok(frames > 5 && frames < 500, `ran ${frames} frames`)
    assert.ok(m.camera.azimuth < released, 'kept turning the way the drag was going')
    assert.equal(m.controls.touch.inertiaActive, false)
    const after = snapshot(m.camera)
    m.frames.step(5000)
    assert.deepEqual(snapshot(m.camera), after)
})

test('mouse inertia: glides farther than the same flick with a finger, by the mouse tuning', () => {
    const m = mouseSetup()
    m.flick()
    const m0 = m.camera.azimuth // after the drag itself: only the coast is measured
    coastToEnd(m)
    const mouseCoast = m0 - m.camera.azimuth

    const t = touchSetup()
    t.down(1, 100, 100, 0)
    for (let i = 1; i <= 4; i++) t.move(1, 100 + i * 24, 100, i * 16)
    t.up(1, 196, 100, 70)
    const t0 = t.camera.azimuth
    coastToEnd(t)
    const touchCoast = t0 - t.camera.azimuth

    const ratio = (MOUSE.GAIN * MOUSE.ORBIT_TAU_MS) / (TOUCH.GAIN * TOUCH.ORBIT_TAU_MS)
    assert.ok(mouseCoast > touchCoast * 1.5, `mouse ${mouseCoast.toFixed(3)} vs touch ${touchCoast.toFixed(3)} rad`)
    near(mouseCoast / touchCoast, ratio, 0.05)
    // and the sideways direction is the same
    near(m.camera.elevation, t.camera.elevation, 1e-9)
})

test('touch inertia keeps its original distance: release speed x 250ms', () => {
    const t = touchSetup()
    t.down(1, 100, 100, 0)
    for (let i = 1; i <= 4; i++) t.move(1, 100 + i * 24, 100, i * 16) // 1.5 px/ms
    t.up(1, 196, 100, 70)
    const a0 = t.camera.azimuth
    coastToEnd(t)
    near(a0 - t.camera.azimuth, 1.5 * 250 * 0.005, 0.03)
})

test('mouse inertia: a modest drag still gives a visible coast', () => {
    // 0.4 px/ms is a casual mouse swipe; with the touch numbers it coasted only ~100px
    const m = mouseSetup()
    m.mdown(100, 100, 0)
    for (let i = 1; i <= 8; i++) m.mmove(100 + i * 6.4, 100, i * 16) // 0.4 px/ms
    m.mup(151.2, 100, 130)
    const a0 = m.camera.azimuth
    coastToEnd(m, 130)
    const coasted = (a0 - m.camera.azimuth) / 0.005 // px of drag
    // a coast ends once its speed falls below MIN_SPEED, so it stops that much short of v * tau
    near(coasted, (0.4 * MOUSE.GAIN - TOUCH.MIN_SPEED) * MOUSE.ORBIT_TAU_MS, 5)
    assert.ok(coasted > 150, `coasted only ${coasted.toFixed(0)}px`)
})

test('mouse inertia: more forgiving than touch about a short delay before releasing the button', () => {
    const gap = TOUCH.VELOCITY_STALE_MS + 10 // longer than touch allows, within the mouse allowance
    assert.ok(gap <= MOUSE.VELOCITY_STALE_MS)
    const m = mouseSetup()
    m.mdown(100, 100, 0)
    for (let i = 1; i <= 4; i++) m.mmove(100 + i * 24, 100, i * 16)
    m.mup(196, 100, 64 + gap)
    assert.equal(m.controls.touch.inertiaActive, true, 'mouse coasts')

    const t = touchSetup()
    t.down(1, 100, 100, 0)
    for (let i = 1; i <= 4; i++) t.move(1, 100 + i * 24, 100, i * 16)
    t.up(1, 196, 100, 64 + gap)
    assert.equal(t.controls.touch.inertiaActive, false, 'touch does not (a pause before lifting means no fling)')
})

test('mouse inertia: starts from slower drags than touch does, but not from near-stationary ones', () => {
    const slowSpeed = (TOUCH.START_SPEED + MOUSE.START_SPEED) / 2 // between the two thresholds, px/ms
    const drive = (setup, down, move, up) => {
        const h = setup()
        down(h, 0, 0, 0)
        for (let i = 1; i <= 6; i++) move(h, i * slowSpeed * 16, 0, i * 16)
        up(h, 6 * slowSpeed * 16, 0, 100)
        return h
    }
    const m = drive(mouseSetup, (h, x, y, t) => h.mdown(x, y, t), (h, x, y, t) => h.mmove(x, y, t), (h, x, y, t) => h.mup(x, y, t))
    assert.equal(m.controls.touch.inertiaActive, true)
    const t = drive(touchSetup, (h, x, y, tt) => h.down(1, x, y, tt), (h, x, y, tt) => h.move(1, x, y, tt), (h, x, y, tt) => h.up(1, x, y, tt))
    assert.equal(t.controls.touch.inertiaActive, false)

    const still = mouseSetup()
    still.mdown(0, 0, 0)
    for (let i = 1; i <= 6; i++) still.mmove(i * 0.2, 0, i * 16) // 0.0125 px/ms: a hand barely moving
    still.mup(1.2, 0, 100)
    assert.equal(still.controls.touch.inertiaActive, false)
})
test('mouse inertia: vertical flicks orbit vertically and stop at the pole', () => {
    const m = mouseSetup()
    m.mdown(100, 100, 0)
    for (let i = 1; i <= 4; i++) m.mmove(100, 100 + i * 24, i * 16)
    m.mup(100, 196, 70)
    const az = m.camera.azimuth
    coastToEnd(m)
    near(m.camera.azimuth, az, 1e-12)
    assert.ok(m.camera.elevation <= (89 * Math.PI) / 180 + 1e-12)
})

test('mouse inertia: a pause before releasing, a slow drag, or a click does not coast', () => {
    let m = mouseSetup()
    m.mdown(100, 100, 0)
    for (let i = 1; i <= 4; i++) m.mmove(100 + i * 24, 100, i * 16)
    m.mup(196, 100, 64 + MOUSE.VELOCITY_STALE_MS + 20)
    assert.equal(m.controls.touch.inertiaActive, false)

    m = mouseSetup()
    m.mdown(100, 100, 1000)
    for (let i = 1; i <= 5; i++) m.mmove(100 + i, 100, 1000 + i * 30)
    m.mup(105, 100, 1160)
    assert.equal(m.controls.touch.inertiaActive, false)

    m = mouseSetup()
    m.mdown(100, 100, 0); m.mup(100, 100, 50)
    assert.equal(m.controls.touch.inertiaActive, false)
    assert.equal(m.frames.pending(), 0)
})

test('mouse inertia: hovering and releasing a button that was never pressed here do nothing', () => {
    const m = mouseSetup()
    m.mmove(10, 10, 0); m.mmove(60, 10, 16); m.mup(60, 10, 20)
    assert.equal(m.controls.touch.inertiaActive, false)
})

test('mouse inertia: shift-drag, right-drag and middle-drag coast as pans', () => {
    for (const [down, move] of [[{ shiftKey: true }, { shiftKey: true }], [{ button: 2 }, {}], [{ button: 1 }, {}], [{}, { shiftKey: true }]]) {
        const m = mouseSetup()
        const before = snapshot(m.camera)
        m.flick(down, move)
        const atRelease = m.camera.target.slice()
        coastToEnd(m)
        assert.notDeepEqual(m.camera.target, atRelease, `target kept moving for ${JSON.stringify([down, move])}`)
        near(m.camera.azimuth, before.az) // a pan never orbits
        near(m.camera.elevation, before.el)
        assert.equal(m.camera.distance, before.d)
    }
})

test('mouse inertia: pointercancel does not coast', () => {
    const m = mouseSetup()
    m.mdown(100, 100, 0)
    for (let i = 1; i <= 4; i++) m.mmove(100 + i * 24, 100, i * 16)
    m.mcancel(70)
    assert.equal(m.controls.touch.inertiaActive, false)
})

test('mouse inertia: the mouse orbit maths is unchanged by coasting', () => {
    // while dragging, the camera follows the pointer exactly; coasting only starts on release
    const m = mouseSetup()
    const az = m.camera.azimuth
    m.mdown(100, 100, 0)
    m.mmove(160, 100, 16)
    near(m.camera.azimuth, az - 60 * 0.005, 1e-12)
    assert.equal(m.controls.touch.inertiaActive, false)
})

test('mouse inertia: a new press, the wheel, a reset or dispose stops it', () => {
    let m = mouseSetup(); m.flick()
    assert.ok(m.controls.touch.inertiaActive)
    m.mdown(0, 0, 80) // grabbing the model stops it dead
    assert.equal(m.controls.touch.inertiaActive, false)
    assert.equal(m.frames.pending(), 0)

    m = mouseSetup(); m.flick()
    m.el.fire('wheel', { deltaY: 10 })
    assert.equal(m.controls.touch.inertiaActive, false)

    m = mouseSetup(); m.flick()
    m.camera.reset() // the Reset view button, or a newly loaded model
    m.frames.step(86)
    assert.equal(m.controls.touch.inertiaActive, false)
    near(m.camera.azimuth, -Math.PI / 4)

    m = mouseSetup(); m.flick()
    m.controls.dispose()
    assert.equal(m.controls.touch.inertiaActive, false)
})

test('mouse inertia: a touch stops a mouse coast and vice versa', () => {
    let m = mouseSetup(); m.flick()
    m.down(2, 5, 5, 80) // a finger lands
    assert.equal(m.controls.touch.inertiaActive, false)

    const t = touchSetup()
    t.down(1, 100, 100, 0)
    for (let i = 1; i <= 4; i++) t.move(1, 100 + i * 24, 100, i * 16)
    t.up(1, 196, 100, 70)
    assert.ok(t.controls.touch.inertiaActive)
    t.el.fire('pointerdown', { pointerId: 9, pointerType: 'mouse', clientX: 0, clientY: 0, t: 80 })
    assert.equal(t.controls.touch.inertiaActive, false)
})

test('mouse inertia: frame rate does not change how far a flick coasts', () => {
    const run = (frameMs) => {
        const m = mouseSetup()
        m.flick()
        coastToEnd(m, 70, frameMs)
        return m.camera.azimuth
    }
    near(run(8), run(32), 0.02)
})

test('mouse inertia: the legacy two-mouse-pointer pinch does not coast', () => {
    const m = mouseSetup()
    m.el.fire('pointerdown', { pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: 0, t: 0 })
    m.el.fire('pointerdown', { pointerId: 2, pointerType: 'mouse', clientX: 100, clientY: 0, t: 2 })
    for (let i = 1; i <= 4; i++) m.el.fire('pointermove', { pointerId: 2, pointerType: 'mouse', clientX: 100 + i * 24, clientY: 0, t: i * 16 })
    m.el.fire('pointerup', { pointerId: 2, pointerType: 'mouse', clientX: 196, clientY: 0, t: 70 })
    m.el.fire('pointerup', { pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: 0, t: 72 })
    assert.equal(m.controls.touch.inertiaActive, false)
})

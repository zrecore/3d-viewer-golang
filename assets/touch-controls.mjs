/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

import {
    TOUCH, pinchMetrics, createPinchState, stepPinch,
    TapDetector, estimateVelocity, limitSpeed, inertiaStep,
} from './gestures.mjs'

// Gesture modes
const IDLE = 'idle'
const ONE = 'one' // one finger: orbit (or pan for a pen's pan button)
const TWO = 'two' // two fingers: pinch zoom toward the fingers, pan, twist
const HOLD = 'hold' // three or more fingers: the camera holds still
const SETTLE = 'settle' // a finger left a pinch: the rest do nothing until all lift

/**
 * Touch (and pen) handling for OrbitControls. Touches are tracked here, apart
 * from the mouse pointers in OrbitControls, so a held mouse button can never
 * combine with a finger into a pinch and a stale touch can never disturb the
 * mouse path.
 *
 * - one finger: orbit at the same speed as a mouse drag; a quick flick keeps
 *   coasting; a double-tap resets the view
 * - two fingers: the point between them stays under them while zooming, the
 *   pair pans, and turning them spins the model around the vertical axis
 * - a third finger freezes the camera; lifting a finger from a pinch ends the
 *   gesture (the remaining finger does not suddenly orbit)
 * - cancel, lost capture, blur and a hidden page all drop the gesture cleanly
 *
 * `controls` supplies `element`, `camera`, `rotateSpeed` and `onDoubleTap()`.
 */
export class TouchGestures {
    /**
     * @param {{element: HTMLElement, camera: import('./camera.mjs').OrbitCamera, rotateSpeed: number, onDoubleTap: () => void}} controls
     * @param {{raf?: Function, caf?: Function, inertia?: boolean}} [opts]
     */
    constructor(controls, opts = {}) {
        this.controls = controls
        this.raf = opts.raf || ((fn) => requestAnimationFrame(fn))
        this.caf = opts.caf || ((handle) => cancelAnimationFrame(handle))
        this.inertia = opts.inertia !== false

        this.touches = new Map() // pointerId -> {x, y, pan}
        this.mode = IDLE
        this.multi = false // this gesture has had two or more fingers
        this.cancelled = false
        this.ids = [] // the two fingers driving a TWO gesture
        this.last = null // pinch metrics at the previous step
        this.pinch = createPinchState()
        this.samples = [] // recent positions for fling velocity
        this.tap = new TapDetector()
        this.fling = null // running inertia, if any
        this.onePan = false
        this.pendingT = null // time of a two-finger update waiting for the next frame
        this.twoHandle = 0
    }

    get inertiaActive() {
        return this.fling !== null
    }

    debug() {
        return { mode: this.mode, touches: this.touches.size, inertia: this.inertiaActive }
    }

    // ------------------------------------------------------------ pointer events

    down(e) {
        const t = stamp(e)
        this.flushTwo() // apply a pending pinch step before the finger count changes
        this.stopInertia()
        const pan = e.pointerType === 'pen' && (e.shiftKey || e.button === 1 || e.button === 2)
        this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY, pan })
        try { this.controls.element.setPointerCapture?.(e.pointerId) } catch (_) { /* pointer already gone */ }
        e.preventDefault()

        const n = this.touches.size
        if (n === 1) {
            this.multi = false
            this.cancelled = false
            this.onePan = pan // a pen's pan button keeps panning, and its fling pans too
            this.samples = [{ t, x: e.clientX, y: e.clientY }]
            this.tap.begin(t, e.clientX, e.clientY)
            this.mode = ONE
        } else if (n === 2) {
            this.enterTwo(true)
        } else {
            this.mode = HOLD
        }
    }

    move(e) {
        const p = this.touches.get(e.pointerId)
        if (!p) return
        const t = stamp(e)
        const dx = e.clientX - p.x
        const dy = e.clientY - p.y
        p.x = e.clientX
        p.y = e.clientY

        if (this.mode === ONE) {
            this.tap.moved(p.x, p.y)
            const { camera, element, rotateSpeed } = this.controls
            if (p.pan || e.shiftKey) {
                camera.pan(dx, dy, element.clientHeight)
            } else {
                camera.orbit(-dx * rotateSpeed, dy * rotateSpeed)
            }
            this.record({ t, x: p.x, y: p.y })
        } else if (this.mode === TWO && this.ids.includes(e.pointerId)) {
            // Two fingers arrive as separate events, so applying each one alone would
            // read a half-moved pair as a pinch. Apply once per frame, with both fingers.
            this.pendingT = t
            if (!this.twoHandle) this.twoHandle = this.raf(() => { this.twoHandle = 0; this.flushTwo() })
        }
        // HOLD and SETTLE only keep the stored positions current, so a later
        // return to two fingers measures from where they really are.
    }

    up(e) {
        if (!this.touches.has(e.pointerId)) return
        this.flushTwo()
        this.touches.delete(e.pointerId)
        try { this.controls.element.releasePointerCapture?.(e.pointerId) } catch (_) { /* already released */ }
        this.afterLift(stamp(e), false)
    }

    cancel(e) {
        if (!this.touches.has(e.pointerId)) return
        this.flushTwo()
        this.touches.delete(e.pointerId)
        try { this.controls.element.releasePointerCapture?.(e.pointerId) } catch (_) { /* already released */ }
        this.afterLift(stamp(e), true)
    }

    /** lostpointercapture: a normal pointerup already removed the pointer, so this is then a no-op. */
    lost(e) {
        if (!this.touches.has(e.pointerId)) return
        this.flushTwo()
        this.touches.delete(e.pointerId)
        this.afterLift(stamp(e), true)
    }

    /** Drop everything: window blur, page hidden, dispose. */
    cancelAll() {
        if (this.twoHandle) this.caf(this.twoHandle)
        this.twoHandle = 0
        this.pendingT = null
        this.touches.clear()
        this.mode = IDLE
        this.multi = false
        this.cancelled = false
        this.ids = []
        this.last = null
        this.samples = []
        this.tap.reset()
        this.stopInertia()
    }

    // --------------------------------------------------------------- transitions

    afterLift(t, cancelled) {
        const was = this.mode
        if (cancelled) this.cancelled = true
        const n = this.touches.size

        if (n === 0) {
            if (was === ONE) this.finishOne(t)
            else this.tap.reset()
            this.mode = IDLE
            this.multi = false
            this.ids = []
            this.last = null
            this.samples = []
            return
        }
        if (n === 1) {
            // A finger left a pinch. Hand-over of the remaining finger to orbit is
            // exactly what felt wrong, so it waits until every finger has lifted.
            if (was === TWO && !this.cancelled) this.startMultiFling(t)
            this.mode = SETTLE
        } else if (n === 2) {
            this.enterTwo(false)
        } else {
            this.mode = HOLD
        }
    }

    finishOne(t) {
        if (this.cancelled) {
            this.tap.reset()
            return
        }
        const result = this.tap.end(t)
        if (result === 'double') {
            this.controls.onDoubleTap()
        } else if (result === null) {
            this.startOneFling(t) // a drag: let it coast
        }
    }

    enterTwo(fresh) {
        const keys = [...this.touches.keys()]
        this.ids = [keys[0], keys[1]]
        this.last = pinchMetrics(this.touches.get(this.ids[0]), this.touches.get(this.ids[1]))
        if (fresh) this.pinch = createPinchState()
        this.samples = []
        this.tap.reset()
        this.multi = true
        this.mode = TWO
    }

    /** Apply the pending two-finger update, if any (also called when the finger count is about to change). */
    flushTwo() {
        if (this.twoHandle) this.caf(this.twoHandle)
        this.twoHandle = 0
        const t = this.pendingT
        this.pendingT = null
        if (t !== null && this.mode === TWO) this.stepTwo(t)
    }

    stepTwo(t) {
        const { camera, element } = this.controls
        const cur = pinchMetrics(this.touches.get(this.ids[0]), this.touches.get(this.ids[1]))
        const prev = this.last
        const step = stepPinch(this.pinch, prev, cur)
        const rect = element.getBoundingClientRect()

        if (step.zoom !== 1) {
            camera.zoomAt(step.zoom, prev.cx - rect.left, prev.cy - rect.top, rect.width, rect.height)
        }
        if (step.twist !== 0) {
            // Viewed from above, turning the model clockwise on screen means a larger
            // azimuth; from below it is the other way round. The camera has no roll,
            // so near the horizon this reads as a yaw rather than an on-screen spin.
            camera.orbit(camera.elevation >= 0 ? step.twist : -step.twist, 0)
        }
        if (cur.cx !== prev.cx || cur.cy !== prev.cy) {
            camera.pan(cur.cx - prev.cx, cur.cy - prev.cy, element.clientHeight)
        }
        this.last = cur
        this.record({ t, cx: cur.cx, cy: cur.cy, lz: Math.log(cur.dist) })
    }

    record(sample) {
        pushSample(this.samples, sample)
    }

    // ------------------------------------------------------------------- inertia

    startOneFling(t) {
        this.coast(this.samples, t, this.onePan)
    }

    /**
     * Let a finished one-pointer drag keep moving: an orbit, or a pan when `pan`
     * is set. Used for touch and pen here, and by OrbitControls for the mouse.
     * @param {{t: number, x: number, y: number}[]} samples recent pointer positions, oldest first
     * @param {number} releaseT time the pointer lifted (ms)
     * @param {boolean} pan
     * @param {typeof TOUCH} [profile] thresholds and decay times: TOUCH (default) or MOUSE
     */
    coast(samples, releaseT, pan, profile = TOUCH) {
        if (!this.inertia) return
        const [rx, ry] = estimateVelocity(samples, releaseT, ['x', 'y'], profile)
        if (Math.hypot(rx, ry) < profile.START_SPEED) return // released too slowly to coast
        const [vx, vy] = limitSpeed(rx * profile.GAIN, ry * profile.GAIN, profile.MAX_SPEED)
        this.begin({ kind: 'one', vx, vy, vz: 0, pan, profile }, releaseT)
    }

    startMultiFling(t) {
        if (!this.inertia) return
        const [cx, cy, lz] = estimateVelocity(this.samples, t, ['cx', 'cy', 'lz'])
        const zoomRate = this.pinch.zoomOn ? lz : 0 // ln(finger separation) per ms; ignore pre-engage noise
        if (Math.hypot(cx, cy) < TOUCH.START_SPEED && Math.abs(zoomRate) < TOUCH.START_ZOOM_RATE) return // too slow to coast
        const [vx, vy] = limitSpeed(cx, cy)
        const rect = this.controls.element.getBoundingClientRect()
        this.begin({
            kind: 'multi',
            vx, vy,
            vz: zoomRate,
            ax: this.last.cx - rect.left,
            ay: this.last.cy - rect.top,
        }, t)
    }

    begin(f, t) {
        if (Math.hypot(f.vx, f.vy) < TOUCH.MIN_SPEED && Math.abs(f.vz) < TOUCH.MIN_ZOOM_RATE) return // nothing to run
        const { camera } = this.controls
        this.fling = { profile: TOUCH, ...f, lastT: t, epoch: camera.epoch, handle: 0 }
        this.fling.handle = this.raf((ts) => this.flingStep(ts))
    }

    flingStep(ts) {
        const f = this.fling
        if (!f) return
        const { camera, element, rotateSpeed } = this.controls
        if (camera.epoch !== f.epoch) { // Reset, double-tap or a new model replaced the view
            this.stopInertia()
            return
        }
        const tune = f.profile
        const dt = Math.min(ts - f.lastT, TOUCH.MAX_FRAME_MS)
        if (dt > 0) {
            f.lastT = ts
            if (f.kind === 'one' && !f.pan) {
                const sx = inertiaStep(f.vx, dt, tune.ORBIT_TAU_MS)
                const sy = inertiaStep(f.vy, dt, tune.ORBIT_TAU_MS)
                camera.orbit(-sx.dist * rotateSpeed, sy.dist * rotateSpeed)
                f.vx = sx.v
                f.vy = Math.abs(camera.elevation) >= (89 * Math.PI) / 180 - 1e-9 ? 0 : sy.v // stop at the pole
            } else {
                const sx = inertiaStep(f.vx, dt, tune.PAN_TAU_MS)
                const sy = inertiaStep(f.vy, dt, tune.PAN_TAU_MS)
                camera.pan(sx.dist, sy.dist, element.clientHeight)
                f.vx = sx.v
                f.vy = sy.v
                if (f.vz) {
                    const sz = inertiaStep(f.vz, dt, tune.ZOOM_TAU_MS)
                    const rect = element.getBoundingClientRect()
                    const before = camera.distance
                    camera.zoomAt(Math.exp(-sz.dist), f.ax, f.ay, rect.width, rect.height)
                    f.vz = camera.distance === before ? 0 : sz.v // stop at a distance limit
                }
            }
        }
        if (Math.hypot(f.vx, f.vy) < TOUCH.MIN_SPEED && Math.abs(f.vz || 0) < TOUCH.MIN_ZOOM_RATE) {
            this.stopInertia()
            return
        }
        f.handle = this.raf((next) => this.flingStep(next))
    }

    stopInertia() {
        if (!this.fling) return
        this.caf(this.fling.handle)
        this.fling = null
    }

    dispose() {
        this.cancelAll()
    }
}

/** Event time in ms, on the same clock as requestAnimationFrame timestamps. */
export function stamp(e) {
    // A timestamp of 0 is a valid time (tests use it), so only fall back when there is none.
    if (typeof e.timeStamp === 'number' && Number.isFinite(e.timeStamp)) return e.timeStamp
    return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/** Append a velocity sample, dropping ones too old to matter. */
export function pushSample(samples, sample) {
    samples.push(sample)
    while (samples.length > 2 && samples[0].t < sample.t - 2 * TOUCH.VELOCITY_WINDOW_MS) samples.shift()
}

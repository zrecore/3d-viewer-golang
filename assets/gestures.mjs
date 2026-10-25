/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

/**
 * Pure helpers for touch gestures: two-finger pinch/twist, tap and double-tap
 * detection, and fling velocity. No DOM and no camera, so everything here is
 * unit tested in node. The state machine that uses them is touch-controls.mjs.
 */

export const TOUCH = Object.freeze({
    // taps
    TAP_MAX_MS: 250,
    TAP_SLOP: 10, // px a finger may move and still count as a tap
    DOUBLE_TAP_MS: 300,
    DOUBLE_TAP_DIST: 30, // px between the two taps
    // two-finger gestures: pinch and twist start only after a dead zone
    ZOOM_ENGAGE: 0.04, // |ln(distance ratio)|, about 4%
    TWIST_ENGAGE: (7 * Math.PI) / 180,
    TWIST_MIN_SEP: 48, // px; angle is too noisy for fingers closer than this
    // inertia
    VELOCITY_WINDOW_MS: 100,
    VELOCITY_STALE_MS: 80, // pausing this long before lifting means no fling
    MIN_SAMPLE_DT_MS: 8,
    ORBIT_TAU_MS: 250,
    PAN_TAU_MS: 250,
    ZOOM_TAU_MS: 150,
    MAX_SPEED: 3, // px per ms
    START_SPEED: 0.1, // px per ms; releasing slower than this does not start a fling
    MIN_SPEED: 0.02, // px per ms; below this a running fling stops
    START_ZOOM_RATE: 5e-5, // ln(distance) per ms needed to start a zoom fling
    MIN_ZOOM_RATE: 1e-5, // ln(distance) per ms; below this a running zoom fling stops
    MAX_FRAME_MS: 64,
})

/** Normalise an angle in radians into (-PI, PI]. */
export function wrapAngle(r) {
    const twoPi = Math.PI * 2
    let a = r % twoPi
    if (a > Math.PI) a -= twoPi
    else if (a <= -Math.PI) a += twoPi
    return a
}

/**
 * Centroid, separation and screen angle of two touch points. The angle is
 * atan2(dy, dx) with y pointing down, so it grows clockwise on screen.
 */
export function pinchMetrics(a, b) {
    return {
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
        dist: Math.hypot(b.x - a.x, b.y - a.y),
        angle: Math.atan2(b.y - a.y, b.x - a.x),
    }
}

/** Accumulators for the zoom and twist dead zones of one two-finger gesture. */
export function createPinchState() {
    return { accZoom: 0, accTwist: 0, zoomOn: false, twistOn: false }
}

/**
 * Advance a two-finger gesture by one step.
 *
 * Pan is handled by the caller (it needs no dead zone). Zoom and twist stay at
 * rest until their signed accumulators leave a dead zone, so jitter cancels out
 * instead of ratcheting; on the step that engages they emit only the excess, so
 * there is no jump. Mutates `state`.
 *
 * @param {ReturnType<typeof createPinchState>} state
 * @param {ReturnType<typeof pinchMetrics>} prev metrics at the previous step
 * @param {ReturnType<typeof pinchMetrics>} cur metrics now
 * @returns {{zoom: number, twist: number}} zoom is a camera.zoom() factor (< 1 when
 * the fingers spread); twist is radians, positive when the fingers turn clockwise on screen
 */
export function stepPinch(state, prev, cur) {
    const raw = prev.dist > 0 && cur.dist > 0 ? Math.log(prev.dist / cur.dist) : 0
    const zoomLn = engage(state, 'accZoom', 'zoomOn', raw, TOUCH.ZOOM_ENGAGE)

    const sepOk = prev.dist >= TOUCH.TWIST_MIN_SEP && cur.dist >= TOUCH.TWIST_MIN_SEP
    const dTheta = sepOk ? wrapAngle(cur.angle - prev.angle) : 0
    const twist = engage(state, 'accTwist', 'twistOn', dTheta, TOUCH.TWIST_ENGAGE)

    return { zoom: Math.exp(zoomLn), twist }
}

function engage(state, accKey, onKey, delta, threshold) {
    if (state[onKey]) return delta
    state[accKey] += delta
    const acc = state[accKey]
    if (Math.abs(acc) <= threshold) return 0
    state[onKey] = true
    return acc - Math.sign(acc) * threshold
}

/**
 * Velocity of tracked values over the last VELOCITY_WINDOW_MS of samples.
 * @param {{t: number}[]} samples oldest first, each with a timestamp `t` (ms)
 * @param {number} releaseT time the fingers lifted (ms)
 * @param {string[]} keys sample properties to differentiate, e.g. ['x', 'y']
 * @returns {number[]} units per ms for each key; all zero with fewer than two
 * samples, a too-short window, or a pause before release
 */
export function estimateVelocity(samples, releaseT, keys) {
    const zero = keys.map(() => 0)
    const n = samples.length
    if (n < 2) return zero
    const last = samples[n - 1]
    if (releaseT - last.t > TOUCH.VELOCITY_STALE_MS) return zero
    let first = last
    for (let i = n - 2; i >= 0 && last.t - samples[i].t <= TOUCH.VELOCITY_WINDOW_MS; i--) first = samples[i]
    const dt = last.t - first.t
    if (dt < TOUCH.MIN_SAMPLE_DT_MS) return zero
    return keys.map((k) => (last[k] - first[k]) / dt)
}

/** Scale (vx, vy) down so its magnitude is at most `max`. */
export function limitSpeed(vx, vy, max = TOUCH.MAX_SPEED) {
    const speed = Math.hypot(vx, vy)
    if (speed <= max || speed === 0) return [vx, vy]
    const k = max / speed
    return [vx * k, vy * k]
}

/**
 * One step of exponential decay, integrated exactly so the result does not
 * depend on the frame rate.
 * @returns {{dist: number, v: number}} distance covered during `dtMs` and the new velocity
 */
export function inertiaStep(v, dtMs, tauMs) {
    const decay = Math.exp(-dtMs / tauMs)
    return { dist: v * tauMs * (1 - decay), v: v * decay }
}

/**
 * Tap and double-tap detection for a single finger. A tap is short and nearly
 * stationary; a drag, long press or any gap clears the pending tap, so a drag
 * between two taps can never produce a double-tap.
 */
export class TapDetector {
    constructor(opts = {}) {
        this.maxMs = opts.maxMs ?? TOUCH.TAP_MAX_MS
        this.slop = opts.slop ?? TOUCH.TAP_SLOP
        this.doubleMs = opts.doubleMs ?? TOUCH.DOUBLE_TAP_MS
        this.doubleDist = opts.doubleDist ?? TOUCH.DOUBLE_TAP_DIST
        this.current = null
        this.last = null
    }

    begin(t, x, y) {
        this.current = { t, x, y, valid: true }
    }

    moved(x, y) {
        const c = this.current
        if (c && Math.hypot(x - c.x, y - c.y) > this.slop) c.valid = false
    }

    /** @returns {'double'|'tap'|null} what the lifted finger completed */
    end(t) {
        const c = this.current
        this.current = null
        if (!c || !c.valid || t - c.t > this.maxMs) {
            this.last = null
            return null
        }
        const prev = this.last
        if (prev && t - prev.t <= this.doubleMs && Math.hypot(c.x - prev.x, c.y - prev.y) <= this.doubleDist) {
            this.last = null
            return 'double'
        }
        this.last = { t, x: c.x, y: c.y }
        return 'tap'
    }

    /** Forget everything: pinch, cancel, blur. */
    reset() {
        this.current = null
        this.last = null
    }
}

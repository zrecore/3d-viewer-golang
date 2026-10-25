/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

import { lookAt, perspective } from './mat4.mjs'
import { TouchGestures, stamp, pushSample } from './touch-controls.mjs'
import { MOUSE } from './gestures.mjs'

const DEFAULTS = Object.freeze({
    azimuth: -Math.PI / 4,   // radians around the Z axis
    elevation: Math.PI / 6,  // radians above the XY plane
    distance: 4,
    target: [0, 0, 0],
})

const MAX_ELEVATION = (89 * Math.PI) / 180
const MIN_DISTANCE = 0.3
const MAX_DISTANCE = 40

/**
 * Default camera distance for a viewport aspect ratio (width / height). The
 * field of view is vertical, so a portrait viewport needs to back off to keep
 * the model's width in frame. Landscape and square viewports are unchanged.
 */
export function framingDistance(aspect) {
    return DEFAULTS.distance / Math.min(1, aspect > 0 ? aspect : 1)
}

/**
 * Orbit camera in spherical coordinates around a target. Z is up, which is the
 * usual STL/CAD convention. Pure math, no DOM.
 */
export class OrbitCamera {
    constructor() {
        this.fovY = (45 * Math.PI) / 180
        this.near = 0.05
        this.far = 100
        this.onChange = () => {}
        this.viewAspect = 1 // viewport width / height, see setViewAspect()
        this.epoch = 0 // bumped by reset(), so animations can tell the view was replaced
        this.reset()
    }

    reset() {
        this.azimuth = DEFAULTS.azimuth
        this.elevation = DEFAULTS.elevation
        this.distance = framingDistance(this.viewAspect)
        this.target = DEFAULTS.target.slice()
        this.epoch++
        this.onChange()
    }

    /**
     * Tell the camera the viewport shape. Keeps the user's relative zoom: the
     * distance is scaled by the change in framing distance, so rotating a phone
     * re-frames the model without undoing a zoom. A no-op for any change between
     * landscape/square aspects, and for tiny changes (mobile URL-bar resizes).
     */
    setViewAspect(aspect) {
        if (!(aspect > 0) || Math.abs(aspect - this.viewAspect) < 1e-3) return
        const ratio = framingDistance(aspect) / framingDistance(this.viewAspect)
        this.viewAspect = aspect
        this.distance = clamp(this.distance * ratio, MIN_DISTANCE, MAX_DISTANCE)
        this.onChange()
    }

    orbit(dAzimuth, dElevation) {
        this.azimuth += dAzimuth
        this.elevation = clamp(this.elevation + dElevation, -MAX_ELEVATION, MAX_ELEVATION)
        this.onChange()
    }

    /** factor > 1 moves away, < 1 moves closer. */
    zoom(factor) {
        this.distance = clamp(this.distance * factor, MIN_DISTANCE, MAX_DISTANCE)
        this.onChange()
    }

    /**
     * Pan the target in the camera plane.
     * @param {number} dxPixels  drag delta in CSS pixels (right is positive)
     * @param {number} dyPixels  drag delta in CSS pixels (down is positive)
     * @param {number} viewportHeight CSS pixel height of the viewport
     */
    pan(dxPixels, dyPixels, viewportHeight) {
        const { right, up } = this.basis()
        const worldPerPixel = (2 * this.distance * Math.tan(this.fovY / 2)) / Math.max(viewportHeight, 1)
        for (let i = 0; i < 3; i++) {
            this.target[i] += (-dxPixels * right[i] + dyPixels * up[i]) * worldPerPixel
        }
        this.onChange()
    }

    /**
     * World point on the focal plane (the plane through the target facing the
     * camera) under a pixel.
     * @param {number} px x in CSS pixels from the viewport's left edge
     * @param {number} py y in CSS pixels from the viewport's top edge
     * @param {number} w viewport CSS width
     * @param {number} h viewport CSS height
     */
    focalPlanePoint(px, py, w, h) {
        const off = this.focalOffset(px, py, w, h, this.distance)
        return [this.target[0] + off[0], this.target[1] + off[1], this.target[2] + off[2]]
    }

    /**
     * Zoom while keeping the focal-plane point under a pixel fixed on screen
     * (pinch toward the fingers). Same factor convention as zoom(): > 1 moves
     * away. Exact for points at the target's depth, approximate elsewhere. At a
     * distance limit the target does not move.
     */
    zoomAt(factor, px, py, w, h) {
        const next = clamp(this.distance * factor, MIN_DISTANCE, MAX_DISTANCE)
        if (next === this.distance) return
        // The anchor is T + d*k and must equal T' + d'*k, so T' = T + (d - d')*k.
        const k = this.focalOffset(px, py, w, h, this.distance - next)
        for (let i = 0; i < 3; i++) this.target[i] += k[i]
        this.distance = next
        this.onChange()
    }

    /** Offset in the camera plane for a pixel, scaled by `depth` (world units). */
    focalOffset(px, py, w, h, depth) {
        const { right, up } = this.basis()
        const x = (2 * px) / Math.max(w, 1) - 1
        const y = 1 - (2 * py) / Math.max(h, 1)
        const t = Math.tan(this.fovY / 2)
        const a = w / Math.max(h, 1)
        const sx = depth * t * x * a
        const sy = depth * t * y
        return [sx * right[0] + sy * up[0], sx * right[1] + sy * up[1], sx * right[2] + sy * up[2]]
    }

    /**
     * Project a world point to viewport CSS pixels.
     * @returns {[number, number, number]} x, y and depth in front of the camera
     */
    worldToScreen(p, w, h) {
        const e = this.eye()
        const { right, up } = this.basis()
        const v = [p[0] - e[0], p[1] - e[1], p[2] - e[2]]
        const f = [(this.target[0] - e[0]) / this.distance, (this.target[1] - e[1]) / this.distance, (this.target[2] - e[2]) / this.distance]
        const depth = v[0] * f[0] + v[1] * f[1] + v[2] * f[2]
        const xc = v[0] * right[0] + v[1] * right[1] + v[2] * right[2]
        const yc = v[0] * up[0] + v[1] * up[1] + v[2] * up[2]
        const t = Math.tan(this.fovY / 2)
        const a = w / Math.max(h, 1)
        return [((xc / (depth * t * a) + 1) / 2) * w, ((1 - yc / (depth * t)) / 2) * h, depth]
    }

    eye() {
        const ce = Math.cos(this.elevation)
        return [
            this.target[0] + this.distance * ce * Math.cos(this.azimuth),
            this.target[1] + this.distance * ce * Math.sin(this.azimuth),
            this.target[2] + this.distance * Math.sin(this.elevation),
        ]
    }

    /** Camera right and up vectors in world space. */
    basis() {
        const e = this.eye()
        let fx = this.target[0] - e[0], fy = this.target[1] - e[1], fz = this.target[2] - e[2]
        const fl = Math.hypot(fx, fy, fz) || 1
        fx /= fl; fy /= fl; fz /= fl
        // right = forward x worldUp(0,0,1)
        let rx = fy, ry = -fx, rz = 0
        const rl = Math.hypot(rx, ry, rz) || 1
        rx /= rl; ry /= rl
        // up = right x forward
        const ux = ry * fz - rz * fy
        const uy = rz * fx - rx * fz
        const uz = rx * fy - ry * fx
        return { right: [rx, ry, rz], up: [ux, uy, uz] }
    }

    viewMatrix(out) {
        return lookAt(this.eye(), this.target, [0, 0, 1], out)
    }

    projectionMatrix(aspect, out) {
        return perspective(this.fovY, aspect, this.near, this.far, out)
    }
}

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v))
}

/** Touch and pen go to TouchGestures; mouse (and anything unknown) keeps the code below. */
function isTouchLike(e) {
    return e.pointerType === 'touch' || e.pointerType === 'pen'
}

/**
 * Pointer-event controls.
 *
 * Mouse: drag = orbit, shift/right/middle drag = pan, wheel = zoom. A quick flick
 * of a drag keeps coasting after release (the same inertia as touch; a wheel
 * turn or a new press stops it).
 * Touch and pen are handled by TouchGestures (touch-controls.mjs): one finger
 * orbits, two fingers pinch-zoom toward the fingers, pan and twist, a quick
 * flick coasts, and a double-tap resets the view. The mouse code below does not
 * run for touch or pen events, so its behaviour never depends on them.
 */
export class OrbitControls {
    /**
     * @param {HTMLElement} element
     * @param {OrbitCamera} camera
     * @param {{raf?: Function, caf?: Function, inertia?: boolean}} [opts] test hooks;
     * inertia defaults to on unless the user prefers reduced motion
     */
    constructor(element, camera, opts = {}) {
        this.element = element
        this.camera = camera
        this.pointers = new Map()
        this.rotateSpeed = 0.005 // radians per CSS pixel
        this.pinchStart = null
        this.dragSamples = null // recent positions of the current mouse drag, for coasting
        this.dragPan = false
        /** Called by a touch double-tap. */
        this.onDoubleTap = () => this.camera.reset()

        const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
        this.touch = new TouchGestures(this, { ...opts, inertia: opts.inertia ?? !reduceMotion })

        element.style.touchAction = 'none'

        this._down = (e) => this.onPointerDown(e)
        this._move = (e) => this.onPointerMove(e)
        this._up = (e) => this.onPointerUp(e)
        this._wheel = (e) => this.onWheel(e)
        this._menu = (e) => e.preventDefault()
        this._lost = (e) => { if (isTouchLike(e)) this.touch.lost(e) }
        this._drop = () => this.touch.cancelAll()
        this._hide = () => { if (this._doc && this._doc.visibilityState === 'hidden') this.touch.cancelAll() }
        this._win = typeof window !== 'undefined' ? window : null
        this._doc = typeof document !== 'undefined' ? document : null

        element.addEventListener('pointerdown', this._down)
        element.addEventListener('pointermove', this._move)
        element.addEventListener('pointerup', this._up)
        element.addEventListener('pointercancel', this._up)
        element.addEventListener('lostpointercapture', this._lost)
        element.addEventListener('wheel', this._wheel, { passive: false })
        element.addEventListener('contextmenu', this._menu)
        // A gesture cannot continue while the page is not visible.
        this._win?.addEventListener('blur', this._drop)
        this._doc?.addEventListener('visibilitychange', this._hide)
    }

    debugState() {
        return this.touch.debug()
    }

    dispose() {
        const el = this.element
        el.removeEventListener('pointerdown', this._down)
        el.removeEventListener('pointermove', this._move)
        el.removeEventListener('pointerup', this._up)
        el.removeEventListener('pointercancel', this._up)
        el.removeEventListener('lostpointercapture', this._lost)
        el.removeEventListener('wheel', this._wheel)
        el.removeEventListener('contextmenu', this._menu)
        this._win?.removeEventListener('blur', this._drop)
        this._doc?.removeEventListener('visibilitychange', this._hide)
        this.touch.dispose()
        this.pointers.clear()
    }

    onPointerDown(e) {
        if (isTouchLike(e)) return this.touch.down(e)
        if (this.touch.inertiaActive) this.touch.stopInertia()
        this.element.setPointerCapture?.(e.pointerId)
        this.pointers.set(e.pointerId, {
            x: e.clientX, y: e.clientY,
            pan: e.shiftKey || e.button === 1 || e.button === 2,
        })
        if (this.pointers.size === 2) this.pinchStart = this.pinchState()
        this.dragSamples = this.pointers.size === 1 ? [{ t: stamp(e), x: e.clientX, y: e.clientY }] : null
        e.preventDefault()
    }

    onPointerMove(e) {
        if (isTouchLike(e)) return this.touch.move(e)
        const p = this.pointers.get(e.pointerId)
        if (!p) return
        const dx = e.clientX - p.x
        const dy = e.clientY - p.y

        if (this.pointers.size === 1) {
            if (p.pan || e.shiftKey) {
                this.camera.pan(dx, dy, this.element.clientHeight)
            } else {
                this.camera.orbit(-dx * this.rotateSpeed, dy * this.rotateSpeed)
            }
            p.x = e.clientX
            p.y = e.clientY
            this.dragPan = p.pan || e.shiftKey
            if (this.dragSamples) pushSample(this.dragSamples, { t: stamp(e), x: p.x, y: p.y })
        } else if (this.pointers.size === 2) {
            const before = this.pinchState()
            p.x = e.clientX
            p.y = e.clientY
            const after = this.pinchState()
            if (before.dist > 0 && after.dist > 0) this.camera.zoom(before.dist / after.dist)
            this.camera.pan(after.cx - before.cx, after.cy - before.cy, this.element.clientHeight)
        }
    }

    onPointerUp(e) {
        if (isTouchLike(e)) return e.type === 'pointercancel' ? this.touch.cancel(e) : this.touch.up(e)
        // Only the release of a lone dragging button coasts (not a cancel, not a pinch).
        const coast = e.type === 'pointerup' && this.pointers.size === 1 && this.pointers.has(e.pointerId) ? this.dragSamples : null
        this.pointers.delete(e.pointerId)
        this.element.releasePointerCapture?.(e.pointerId)
        this.pinchStart = null
        this.dragSamples = null
        if (coast) this.touch.coast(coast, stamp(e), this.dragPan, MOUSE)
    }

    onWheel(e) {
        if (this.touch.inertiaActive) this.touch.stopInertia()
        e.preventDefault()
        // deltaMode 1 = lines, 2 = pages
        const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1
        this.camera.zoom(Math.exp(e.deltaY * scale * 0.0015))
    }

    pinchState() {
        const [a, b] = [...this.pointers.values()]
        return {
            dist: Math.hypot(a.x - b.x, a.y - b.y),
            cx: (a.x + b.x) / 2,
            cy: (a.y + b.y) / 2,
        }
    }
}

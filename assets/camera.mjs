/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

import { lookAt, perspective } from './mat4.mjs'

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
 * Orbit camera in spherical coordinates around a target. Z is up, which is the
 * usual STL/CAD convention. Pure math, no DOM.
 */
export class OrbitCamera {
    constructor() {
        this.fovY = (45 * Math.PI) / 180
        this.near = 0.05
        this.far = 100
        this.onChange = () => {}
        this.reset()
    }

    reset() {
        this.azimuth = DEFAULTS.azimuth
        this.elevation = DEFAULTS.elevation
        this.distance = DEFAULTS.distance
        this.target = DEFAULTS.target.slice()
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

/**
 * Pointer-event controls: drag = orbit, shift/right/middle drag = pan,
 * wheel = zoom, two-finger touch = pinch zoom + pan.
 */
export class OrbitControls {
    /**
     * @param {HTMLElement} element
     * @param {OrbitCamera} camera
     */
    constructor(element, camera) {
        this.element = element
        this.camera = camera
        this.pointers = new Map()
        this.rotateSpeed = 0.005 // radians per CSS pixel
        this.pinchStart = null

        element.style.touchAction = 'none'

        this._down = (e) => this.onPointerDown(e)
        this._move = (e) => this.onPointerMove(e)
        this._up = (e) => this.onPointerUp(e)
        this._wheel = (e) => this.onWheel(e)
        this._menu = (e) => e.preventDefault()

        element.addEventListener('pointerdown', this._down)
        element.addEventListener('pointermove', this._move)
        element.addEventListener('pointerup', this._up)
        element.addEventListener('pointercancel', this._up)
        element.addEventListener('wheel', this._wheel, { passive: false })
        element.addEventListener('contextmenu', this._menu)
    }

    dispose() {
        const el = this.element
        el.removeEventListener('pointerdown', this._down)
        el.removeEventListener('pointermove', this._move)
        el.removeEventListener('pointerup', this._up)
        el.removeEventListener('pointercancel', this._up)
        el.removeEventListener('wheel', this._wheel)
        el.removeEventListener('contextmenu', this._menu)
        this.pointers.clear()
    }

    onPointerDown(e) {
        this.element.setPointerCapture?.(e.pointerId)
        this.pointers.set(e.pointerId, {
            x: e.clientX, y: e.clientY,
            pan: e.shiftKey || e.button === 1 || e.button === 2,
        })
        if (this.pointers.size === 2) this.pinchStart = this.pinchState()
        e.preventDefault()
    }

    onPointerMove(e) {
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
        this.pointers.delete(e.pointerId)
        this.element.releasePointerCapture?.(e.pointerId)
        this.pinchStart = null
    }

    onWheel(e) {
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

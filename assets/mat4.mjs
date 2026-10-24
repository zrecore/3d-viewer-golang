/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

/**
 * Minimal column-major 4x4 matrix helpers (Float32Array(16)), matching WGSL
 * mat4x4<f32> memory layout. Projection targets WebGPU clip space (z in 0..1).
 */

export function identity() {
    const m = new Float32Array(16)
    m[0] = m[5] = m[10] = m[15] = 1
    return m
}

/** out = a * b (apply b first, then a). */
export function multiply(a, b, out = new Float32Array(16)) {
    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            let s = 0
            for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k]
            out[col * 4 + row] = s
        }
    }
    return out
}

/** Right-handed perspective, depth range 0..1. */
export function perspective(fovY, aspect, near, far, out = new Float32Array(16)) {
    const f = 1 / Math.tan(fovY / 2)
    out.fill(0)
    out[0] = f / aspect
    out[5] = f
    out[10] = far / (near - far)
    out[11] = -1
    out[14] = (far * near) / (near - far)
    return out
}

/** Right-handed look-at view matrix. */
export function lookAt(eye, target, up, out = new Float32Array(16)) {
    let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2]
    let l = Math.hypot(zx, zy, zz) || 1
    zx /= l; zy /= l; zz /= l
    let xx = up[1] * zz - up[2] * zy
    let xy = up[2] * zx - up[0] * zz
    let xz = up[0] * zy - up[1] * zx
    l = Math.hypot(xx, xy, xz) || 1
    xx /= l; xy /= l; xz /= l
    const yx = zy * xz - zz * xy
    const yy = zz * xx - zx * xz
    const yz = zx * xy - zy * xx
    out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0
    out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0
    out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0
    out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2])
    out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2])
    out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2])
    out[15] = 1
    return out
}

/** Model matrix p' = (p - center) * scale. */
export function centerAndScale(center, scale, out = new Float32Array(16)) {
    out.fill(0)
    out[0] = out[5] = out[10] = scale
    out[12] = -center[0] * scale
    out[13] = -center[1] * scale
    out[14] = -center[2] * scale
    out[15] = 1
    return out
}

/**
 * Inverse-transpose of the upper-left 3x3 of m, returned as a mat4 (w stays
 * identity) so it can live in a uniform struct without mat3 padding concerns.
 */
export function normalMatrix(m, out = new Float32Array(16)) {
    const a00 = m[0], a01 = m[1], a02 = m[2]
    const a10 = m[4], a11 = m[5], a12 = m[6]
    const a20 = m[8], a21 = m[9], a22 = m[10]
    const b01 = a22 * a11 - a12 * a21
    const b11 = -a22 * a10 + a12 * a20
    const b21 = a21 * a10 - a11 * a20
    let det = a00 * b01 + a01 * b11 + a02 * b21
    det = det ? 1 / det : 0
    // inverse (row-major cofactors) then transposed == cofactor matrix / det
    out.fill(0)
    out[0] = b01 * det
    out[1] = (-a22 * a01 + a02 * a21) * det
    out[2] = (a12 * a01 - a02 * a11) * det
    out[4] = b11 * det
    out[5] = (a22 * a00 - a02 * a20) * det
    out[6] = (-a12 * a00 + a02 * a10) * det
    out[8] = b21 * det
    out[9] = (-a21 * a00 + a01 * a20) * det
    out[10] = (a11 * a00 - a01 * a10) * det
    out[15] = 1
    return out
}

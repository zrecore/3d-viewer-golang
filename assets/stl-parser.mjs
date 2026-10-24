/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

/**
 * STL parser (binary and ASCII). Pure JavaScript, no DOM or WebGPU
 * dependencies, so it can be unit tested with Node.
 *
 * Binary layout:
 *   UINT8[80]  header
 *   UINT32     triangle count (little endian)
 *   foreach triangle (50 bytes):
 *     REAL32[3] normal, REAL32[3] v1, REAL32[3] v2, REAL32[3] v3, UINT16 attribute byte count
 */

const HEADER_BYTES = 84
const TRIANGLE_BYTES = 50

/**
 * @typedef {Object} StlModel
 * @property {Float32Array} positions  3 floats per vertex, 9 per triangle.
 * @property {Float32Array} normals    3 floats per vertex (flat, repeated for each corner).
 * @property {number} triangleCount
 * @property {{min: number[], max: number[]}} bounds  Axis-aligned bounds of the raw positions.
 * @property {'binary'|'ascii'} format
 */

/**
 * Parse an STL file.
 * @param {ArrayBuffer|ArrayBufferView} input
 * @returns {StlModel}
 */
export function parseSTL(input) {
    const buffer = toArrayBuffer(input)
    const byteLength = buffer.byteLength

    if (byteLength === 0) {
        throw new Error('STL file is empty.')
    }

    let model
    if (looksLikeAscii(buffer)) {
        model = parseAscii(buffer)
        // Some binary files have a header that begins with "solid" and a
        // corrupt count. If ASCII yields nothing, fall back to binary.
        if (model.triangleCount === 0 && byteLength >= HEADER_BYTES + TRIANGLE_BYTES) {
            model = parseBinary(buffer)
        }
    } else {
        model = parseBinary(buffer)
    }

    if (model.triangleCount === 0) {
        throw new Error('STL file contains no triangles.')
    }
    return model
}

/**
 * Compute the uniform scale and translation that fit the bounds into a cube
 * of the given edge length, centered at the origin.
 * Apply as: p' = (p - center) * scale
 * @param {{min: number[], max: number[]}} bounds
 * @param {number} [size=2] Edge length of the target cube.
 * @returns {{center: number[], scale: number, extent: number[]}}
 */
export function fitTransform(bounds, size = 2) {
    const center = [0, 1, 2].map(i => (bounds.min[i] + bounds.max[i]) / 2)
    const extent = [0, 1, 2].map(i => bounds.max[i] - bounds.min[i])
    const largest = Math.max(extent[0], extent[1], extent[2])
    const scale = largest > 0 && Number.isFinite(largest) ? size / largest : 1
    return { center, scale, extent }
}

function toArrayBuffer(input) {
    if (input instanceof ArrayBuffer) return input
    if (ArrayBuffer.isView(input)) {
        return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
    }
    // SharedArrayBuffer or cross-realm ArrayBuffer
    if (input && typeof input.byteLength === 'number' && typeof input.slice === 'function') {
        return input
    }
    throw new TypeError('parseSTL expects an ArrayBuffer.')
}

/**
 * ASCII if the file starts with "solid" (after optional BOM/whitespace) AND
 * the size does not match the binary formula for the declared count.
 */
function looksLikeAscii(buffer) {
    const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 256))
    let i = 0
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3
    while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++
    const word = String.fromCharCode(...bytes.subarray(i, i + 5)).toLowerCase()
    if (word !== 'solid') return false

    if (buffer.byteLength < HEADER_BYTES) return true
    const declared = new DataView(buffer).getUint32(80, true)
    return buffer.byteLength !== HEADER_BYTES + TRIANGLE_BYTES * declared
}

function parseBinary(buffer) {
    const byteLength = buffer.byteLength
    if (byteLength < HEADER_BYTES) {
        throw new Error('Not a valid STL file: too short for a binary header.')
    }
    const view = new DataView(buffer)
    const declared = view.getUint32(80, true)
    const derived = Math.floor((byteLength - HEADER_BYTES) / TRIANGLE_BYTES)
    // Prefer the byte-derived count when they disagree.
    const count = declared === derived ? declared : derived

    const positions = new Float32Array(count * 9)
    const normals = new Float32Array(count * 9)
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]

    let offset = HEADER_BYTES
    for (let t = 0; t < count; t++, offset += TRIANGLE_BYTES) {
        const p = t * 9
        for (let k = 0; k < 9; k++) {
            positions[p + k] = view.getFloat32(offset + 12 + k * 4, true)
        }
        writeNormal(
            normals, p, positions,
            view.getFloat32(offset, true),
            view.getFloat32(offset + 4, true),
            view.getFloat32(offset + 8, true)
        )
        expandBounds(min, max, positions, p)
    }

    return finish(positions, normals, count, min, max, 'binary')
}

function parseAscii(buffer) {
    const text = new TextDecoder('utf-8').decode(buffer)
    const tokens = text.split(/\s+/)

    let capacity = 1024
    let positions = new Float32Array(capacity * 9)
    let normals = new Float32Array(capacity * 9)
    let count = 0
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]

    let fn = [0, 0, 0]
    let verts = []
    let inFacet = false

    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i].toLowerCase()
        if (tok === 'facet') {
            inFacet = true
            verts = []
            fn = [0, 0, 0]
            if ((tokens[i + 1] || '').toLowerCase() === 'normal') {
                fn = [parseFloat(tokens[i + 2]), parseFloat(tokens[i + 3]), parseFloat(tokens[i + 4])]
                i += 4
            }
        } else if (tok === 'vertex' && inFacet) {
            if (verts.length < 9) {
                verts.push(parseFloat(tokens[i + 1]), parseFloat(tokens[i + 2]), parseFloat(tokens[i + 3]))
            }
            i += 3
        } else if (tok === 'endfacet') {
            if (inFacet && verts.length === 9) {
                if (count === capacity) {
                    capacity *= 2
                    const np = new Float32Array(capacity * 9); np.set(positions); positions = np
                    const nn = new Float32Array(capacity * 9); nn.set(normals); normals = nn
                }
                const p = count * 9
                for (let k = 0; k < 9; k++) positions[p + k] = verts[k]
                writeNormal(normals, p, positions, fn[0], fn[1], fn[2])
                expandBounds(min, max, positions, p)
                count++
            }
            inFacet = false
        }
    }

    return finish(positions.slice(0, count * 9), normals.slice(0, count * 9), count, min, max, 'ascii')
}

/** Writes the same normal for the 3 corners of the triangle starting at positions[p]. */
function writeNormal(normals, p, positions, nx, ny, nz) {
    let len = Math.hypot(nx, ny, nz)
    if (!Number.isFinite(len) || len < 1e-12) {
        // Missing or invalid normal: derive a flat normal from the winding order.
        const ax = positions[p + 3] - positions[p]
        const ay = positions[p + 4] - positions[p + 1]
        const az = positions[p + 5] - positions[p + 2]
        const bx = positions[p + 6] - positions[p]
        const by = positions[p + 7] - positions[p + 1]
        const bz = positions[p + 8] - positions[p + 2]
        nx = ay * bz - az * by
        ny = az * bx - ax * bz
        nz = ax * by - ay * bx
        len = Math.hypot(nx, ny, nz)
        if (!Number.isFinite(len) || len < 1e-20) {
            nx = 0; ny = 0; nz = 1; len = 1 // degenerate triangle
        }
    }
    nx /= len; ny /= len; nz /= len
    for (let v = 0; v < 3; v++) {
        normals[p + v * 3] = nx
        normals[p + v * 3 + 1] = ny
        normals[p + v * 3 + 2] = nz
    }
}

function expandBounds(min, max, positions, p) {
    for (let k = 0; k < 9; k++) {
        const v = positions[p + k]
        if (!Number.isFinite(v)) continue
        const axis = k % 3
        if (v < min[axis]) min[axis] = v
        if (v > max[axis]) max[axis] = v
    }
}

function finish(positions, normals, triangleCount, min, max, format) {
    for (let i = 0; i < 3; i++) {
        if (!Number.isFinite(min[i]) || !Number.isFinite(max[i])) {
            min[i] = 0
            max[i] = 0
        }
    }
    return { positions, normals, triangleCount, bounds: { min, max }, format }
}

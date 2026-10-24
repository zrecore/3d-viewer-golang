/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */
// Run with: node --test assets/
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseSTL, fitTransform } from './stl-parser.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const readStl = (name) => {
    const b = readFileSync(join(here, 'stl', name))
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
}

/** Build a binary STL from [{n:[..], v:[9 numbers]}] */
function makeBinary(tris, { declared = tris.length, header = '' } = {}) {
    const buf = new ArrayBuffer(84 + 50 * tris.length)
    const dv = new DataView(buf)
    for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i))
    dv.setUint32(80, declared, true)
    tris.forEach((t, i) => {
        const o = 84 + i * 50
        const f = [...t.n, ...t.v]
        f.forEach((x, k) => dv.setFloat32(o + k * 4, x, true))
    })
    return buf
}

const TRI = { n: [0, 0, 1], v: [0, 0, 0, 1, 0, 0, 0, 1, 0] }

function assertConsistent(m) {
    assert.equal(m.positions.length, m.triangleCount * 9)
    assert.equal(m.normals.length, m.triangleCount * 9)
    for (const v of m.positions) assert.ok(Number.isFinite(v))
    for (let i = 0; i < m.normals.length; i += 3) {
        const l = Math.hypot(m.normals[i], m.normals[i + 1], m.normals[i + 2])
        assert.ok(Math.abs(l - 1) < 1e-5, `normal ${i / 3} has length ${l}`)
    }
    for (let a = 0; a < 3; a++) assert.ok(m.bounds.min[a] <= m.bounds.max[a])
}

for (const [name, expectedTris] of [['cube.stl', 12], ['square.stl', 2]]) {
    test(`binary sample ${name}`, () => {
        const buf = readStl(name)
        const m = parseSTL(buf)
        assert.equal(m.format, 'binary')
        assert.equal(m.triangleCount, expectedTris)
        assert.equal(m.triangleCount, (buf.byteLength - 84) / 50)
        assertConsistent(m)
    })
}

for (const name of ['prog-jig-v2.stl', 'peristaltic-pump-v1.0.0.stl']) {
    test(`large binary sample ${name}`, () => {
        const buf = readStl(name)
        const m = parseSTL(buf)
        assert.equal(m.format, 'binary')
        assert.equal(m.triangleCount, Math.floor((buf.byteLength - 84) / 50))
        assert.ok(m.triangleCount > 255, 'more triangles than a single byte can count')
        assertConsistent(m)
        const fit = fitTransform(m.bounds)
        assert.ok(fit.scale > 0 && Number.isFinite(fit.scale))
    })
}

test('count mismatch prefers byte-derived count', () => {
    const tooBig = parseSTL(makeBinary([TRI, TRI], { declared: 1000 }))
    assert.equal(tooBig.triangleCount, 2)
    const tooSmall = parseSTL(makeBinary([TRI, TRI], { declared: 1 }))
    assert.equal(tooSmall.triangleCount, 2)
})

test('truncated trailing partial triangle is ignored', () => {
    const full = makeBinary([TRI, TRI])
    const cut = full.slice(0, full.byteLength - 10)
    assert.equal(parseSTL(cut).triangleCount, 1)
})

test('zero, NaN and wrong-length normals are replaced by flat normals', () => {
    const m = parseSTL(makeBinary([
        { n: [0, 0, 0], v: TRI.v },
        { n: [NaN, 0, 1], v: TRI.v },
        { n: [0, 0, 0], v: [0, 0, 0, 0, 1, 0, 1, 0, 0] }, // opposite winding -> -z
        { n: [0, 0, 5], v: TRI.v }, // non-unit normal gets normalised
    ]))
    const z = (t) => [m.normals[t * 9], m.normals[t * 9 + 1], m.normals[t * 9 + 2]]
    assert.deepEqual(z(0), [0, 0, 1])
    assert.deepEqual(z(1), [0, 0, 1])
    assert.deepEqual(z(2), [0, 0, -1])
    assert.deepEqual(z(3), [0, 0, 1])
    // all three corners share the normal
    for (let v = 1; v < 3; v++) assert.deepEqual(Array.from(m.normals.slice(v * 3, v * 3 + 3)), [0, 0, 1])
})

test('degenerate triangle gets a finite fallback normal', () => {
    const m = parseSTL(makeBinary([{ n: [0, 0, 0], v: [1, 1, 1, 1, 1, 1, 1, 1, 1] }]))
    assertConsistent(m)
})

test('bounds and fitTransform', () => {
    const m = parseSTL(makeBinary([{ n: [0, 0, 1], v: [10, 20, 30, 14, 20, 30, 10, 22, 31] }]))
    assert.deepEqual(m.bounds, { min: [10, 20, 30], max: [14, 22, 31] })
    const f = fitTransform(m.bounds, 2)
    assert.deepEqual(f.center, [12, 21, 30.5])
    assert.equal(f.scale, 0.5)
})

const ASCII = `solid test
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 1.5e0 0 0
      vertex 0 1 0
    endloop
  endfacet
  facet normal 0 0 0
    outer loop
      vertex 0 0 0
      vertex 0 0 2
      vertex 1 0 0
    endloop
  endfacet
endsolid test
`

test('ASCII STL', () => {
    const buf = new TextEncoder().encode(ASCII).buffer
    const m = parseSTL(buf)
    assert.equal(m.format, 'ascii')
    assert.equal(m.triangleCount, 2)
    assert.deepEqual(Array.from(m.positions.slice(0, 9)), [0, 0, 0, 1.5, 0, 0, 0, 1, 0])
    assert.deepEqual(Array.from(m.normals.slice(0, 3)), [0, 0, 1])
    // zero normal replaced: (0,0,2)x(1,0,0) = (0,2,0) -> +y
    assert.deepEqual(Array.from(m.normals.slice(9, 12)), [0, 1, 0])
    assert.deepEqual(m.bounds, { min: [0, 0, 0], max: [1.5, 1, 2] })
    assertConsistent(m)
})

test('ASCII STL with CRLF, upper case and many facets (buffer growth)', () => {
    let s = 'SOLID big\r\n'
    for (let i = 0; i < 3000; i++) {
        s += `FACET NORMAL 0 0 1\r\nOUTER LOOP\r\nVERTEX ${i} 0 0\r\nVERTEX ${i + 1} 0 0\r\nVERTEX ${i} 1 0\r\nENDLOOP\r\nENDFACET\r\n`
    }
    s += 'ENDSOLID big\r\n'
    const m = parseSTL(new TextEncoder().encode(s).buffer)
    assert.equal(m.format, 'ascii')
    assert.equal(m.triangleCount, 3000)
    assert.equal(m.bounds.max[0], 3000)
})

test('binary file whose header starts with "solid" is still binary when sizes match', () => {
    const m = parseSTL(makeBinary([TRI, TRI], { header: 'solid exported by something' }))
    assert.equal(m.format, 'binary')
    assert.equal(m.triangleCount, 2)
})

test('binary file with "solid" header and wrong count falls back to binary', () => {
    const m = parseSTL(makeBinary([TRI, TRI], { header: 'solid foo', declared: 99 }))
    assert.equal(m.format, 'binary')
    assert.equal(m.triangleCount, 2)
})

test('rejects empty, tiny and triangle-less input', () => {
    assert.throws(() => parseSTL(new ArrayBuffer(0)))
    assert.throws(() => parseSTL(new ArrayBuffer(10)))
    assert.throws(() => parseSTL(makeBinary([])))
})

test('accepts typed array views with offsets', () => {
    const buf = makeBinary([TRI])
    const padded = new Uint8Array(buf.byteLength + 7)
    padded.set(new Uint8Array(buf), 7)
    assert.equal(parseSTL(padded.subarray(7)).triangleCount, 1)
})

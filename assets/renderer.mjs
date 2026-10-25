/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

import { multiply, normalMatrix, identity } from './mat4.mjs'

const DEPTH_FORMAT = 'depth24plus'
const FLOATS_PER_VERTEX = 6 // position vec3 + normal vec3
const UNIFORM_BYTES = 64 + 64 + 16 + 16 + 16 // mvp, normalMatrix, lightDir, baseColor, params
const CLEAR_COLOR = { r: 0.055, g: 0.09, b: 0.125, a: 1 }
const MAX_DPR = 2.5
const MAX_COARSE_PIXELS = 4e6 // touch-first devices: cap the drawing buffer for mobile GPUs

/**
 * Drawing-buffer size for a canvas. The device pixel ratio is capped at
 * `maxDpr`, the area at `maxPixels` (keeping the aspect ratio), and each side
 * at the GPU's texture limit. For ordinary desktop displays this is just
 * round(css size * dpr).
 * @returns {[number, number]} width and height in device pixels
 */
export function backingSize(cssW, cssH, dpr, maxDim, { maxDpr = MAX_DPR, maxPixels = Infinity } = {}) {
    const scale = Math.min(dpr || 1, maxDpr)
    let w = cssW * scale
    let h = cssH * scale
    if (w * h > maxPixels) {
        const k = Math.sqrt(maxPixels / (w * h))
        w *= k
        h *= k
    }
    const side = (v) => Math.min(maxDim, Math.max(1, Math.round(v)))
    return [side(w), side(h)]
}

/**
 * Small raw-WebGPU renderer for a single mesh: one uniform buffer, one depth
 * texture, one pipeline. Redraws only when marked dirty.
 */
export class ModelRenderer {
    /**
     * Resolves to a renderer, or throws an Error with a user-presentable message.
     * @param {HTMLCanvasElement} canvas
     * @param {import('./camera.mjs').OrbitCamera} camera
     * @param {string} shaderUrl
     */
    static async create(canvas, camera, shaderUrl = '/assets/wgsl/model.wgsl') {
        if (!('gpu' in navigator)) {
            throw new Error('WebGPU is not available in this browser.')
        }
        const adapter = await navigator.gpu.requestAdapter()
        if (!adapter) {
            throw new Error('No suitable WebGPU adapter was found on this device.')
        }
        const device = await adapter.requestDevice()

        const context = canvas.getContext('webgpu')
        if (!context) {
            throw new Error('Could not create a WebGPU canvas context.')
        }

        const response = await fetch(shaderUrl)
        if (!response.ok) {
            throw new Error('Could not load the shader (' + shaderUrl + ', HTTP ' + response.status + ').')
        }
        const code = await response.text()

        return new ModelRenderer(device, canvas, context, camera, code)
    }

    constructor(device, canvas, context, camera, shaderCode) {
        this.device = device
        this.canvas = canvas
        this.context = context
        this.camera = camera

        this.format = navigator.gpu.getPreferredCanvasFormat()
        context.configure({ device, format: this.format, alphaMode: 'opaque' })

        this.vertexBuffer = null
        this.vertexCount = 0
        this.modelMatrix = identity()
        this.depthTexture = null
        this.dirty = true
        this.frameHandle = 0
        this.frames = 0 // completed draw() calls, read by the ?debug hook
        this.lost = false
        this.onLost = () => {}

        this.uniformData = new Float32Array(UNIFORM_BYTES / 4)
        this.mvp = new Float32Array(16)
        this.view = new Float32Array(16)
        this.proj = new Float32Array(16)
        this.viewModel = new Float32Array(16)
        this.normalMat = new Float32Array(16)

        this.uniformBuffer = device.createBuffer({
            size: UNIFORM_BYTES,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })

        const module = device.createShaderModule({ code: shaderCode })
        this.bindGroupLayout = device.createBindGroupLayout({
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: { type: 'uniform' },
            }],
        })
        this.bindGroup = device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
        })

        this.pipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
            vertex: {
                module,
                entryPoint: 'vertex_main',
                buffers: [{
                    arrayStride: FLOATS_PER_VERTEX * 4,
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x3' },
                        { shaderLocation: 1, offset: 12, format: 'float32x3' },
                    ],
                }],
            },
            fragment: {
                module,
                entryPoint: 'fragment_main',
                targets: [{ format: this.format }],
            },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: {
                format: DEPTH_FORMAT,
                depthWriteEnabled: true,
                depthCompare: 'less',
            },
        })

        device.lost.then((info) => {
            this.lost = true
            this.onLost(info)
        })

        this.camera.onChange = () => this.requestRender()

        this.resizeObserver = new ResizeObserver(() => this.resize())
        this.resizeObserver.observe(canvas)
        this.onWindowResize = () => this.resize()
        window.addEventListener('resize', this.onWindowResize)

        this.resize()
    }

    /**
     * Upload a mesh.
     * @param {Float32Array} positions  3 floats per vertex
     * @param {Float32Array} normals    3 floats per vertex
     * @param {Float32Array} modelMatrix centers/scales the mesh
     */
    setMesh(positions, normals, modelMatrix) {
        const count = positions.length / 3
        const interleaved = new Float32Array(count * FLOATS_PER_VERTEX)
        for (let i = 0; i < count; i++) {
            const o = i * FLOATS_PER_VERTEX
            interleaved[o] = positions[i * 3]
            interleaved[o + 1] = positions[i * 3 + 1]
            interleaved[o + 2] = positions[i * 3 + 2]
            interleaved[o + 3] = normals[i * 3]
            interleaved[o + 4] = normals[i * 3 + 1]
            interleaved[o + 5] = normals[i * 3 + 2]
        }

        if (interleaved.byteLength > this.device.limits.maxBufferSize) {
            throw new Error('This model is too large for this GPU.')
        }

        this.vertexBuffer?.destroy()
        this.vertexBuffer = this.device.createBuffer({
            size: Math.max(interleaved.byteLength, 4),
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        })
        this.device.queue.writeBuffer(this.vertexBuffer, 0, interleaved)
        this.vertexCount = count
        this.modelMatrix.set(modelMatrix)
        this.requestRender()
    }

    clearMesh() {
        this.vertexBuffer?.destroy()
        this.vertexBuffer = null
        this.vertexCount = 0
        this.requestRender()
    }

    /** Match the drawing buffer to the CSS size and devicePixelRatio. */
    resize() {
        const cssW = this.canvas.clientWidth
        const cssH = this.canvas.clientHeight
        // Portrait viewports need the camera further back (no-op for landscape).
        if (cssW > 0 && cssH > 0) this.camera.setViewAspect(cssW / cssH)

        const dpr = window.devicePixelRatio || 1
        const max = this.device.limits.maxTextureDimension2D
        const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
        const [width, height] = backingSize(cssW, cssH, dpr, max, { maxPixels: coarse ? MAX_COARSE_PIXELS : Infinity })

        if (this.canvas.width === width && this.canvas.height === height && this.depthTexture) {
            return
        }
        this.canvas.width = width
        this.canvas.height = height

        this.depthTexture?.destroy()
        this.depthTexture = this.device.createTexture({
            size: [width, height],
            format: DEPTH_FORMAT,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        })
        // Setting canvas.width cleared the buffer. Draw now, in the same task, so a
        // frame is never shown blank while a deferred redraw waits for the next rAF.
        this.dirty = true
        this.draw()
    }

    requestRender() {
        this.dirty = true
        if (!this.frameHandle && !this.lost) {
            this.frameHandle = requestAnimationFrame(() => {
                this.frameHandle = 0
                if (this.dirty) this.draw()
            })
        }
    }

    draw() {
        this.dirty = false
        if (this.lost || !this.depthTexture) return
        this.frames++

        const aspect = this.canvas.width / this.canvas.height
        this.camera.viewMatrix(this.view)
        this.camera.projectionMatrix(aspect, this.proj)
        multiply(this.view, this.modelMatrix, this.viewModel)
        multiply(this.proj, this.viewModel, this.mvp)
        normalMatrix(this.viewModel, this.normalMat)

        const u = this.uniformData
        u.set(this.mvp, 0)
        u.set(this.normalMat, 16)
        u.set([0.35, 0.55, 0.75, 0], 32) // lightDir (normalized in the shader), view space
        u.set([0.0, 0.62, 0.78, 1], 36)  // base color
        u.set([0.25, 0.12, 0, 0], 40)    // ambient, fill
        this.device.queue.writeBuffer(this.uniformBuffer, 0, u)

        const encoder = this.device.createCommandEncoder()
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: this.context.getCurrentTexture().createView(),
                clearValue: CLEAR_COLOR,
                loadOp: 'clear',
                storeOp: 'store',
            }],
            depthStencilAttachment: {
                view: this.depthTexture.createView(),
                depthClearValue: 1,
                depthLoadOp: 'clear',
                depthStoreOp: 'discard',
            },
        })
        if (this.vertexBuffer && this.vertexCount > 0) {
            pass.setPipeline(this.pipeline)
            pass.setBindGroup(0, this.bindGroup)
            pass.setVertexBuffer(0, this.vertexBuffer)
            pass.draw(this.vertexCount)
        }
        pass.end()
        this.device.queue.submit([encoder.finish()])
    }

    destroy() {
        cancelAnimationFrame(this.frameHandle)
        this.resizeObserver.disconnect()
        window.removeEventListener('resize', this.onWindowResize)
        this.vertexBuffer?.destroy()
        this.depthTexture?.destroy()
        this.uniformBuffer.destroy()
    }
}

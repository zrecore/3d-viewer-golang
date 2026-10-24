/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

import { parseSTL, fitTransform } from './stl-parser.mjs'
import { OrbitCamera, OrbitControls } from './camera.mjs'
import { ModelRenderer } from './renderer.mjs'
import { centerAndScale } from './mat4.mjs'

/** Edge length of the cube the model is scaled to fit. */
const FIT_SIZE = 2

/**
 * Browser-side STL viewer. Construction starts WebGPU initialization;
 * await `viewer.ready` (resolves to true/false, never rejects) before use.
 * `loadSTLFile` awaits it for you.
 */
class ClientViewer
{
    /**
     * @param {string} canvasId
     * @param {{messageId?: string, infoId?: string, shaderUrl?: string}} [options]
     */
    constructor(canvasId, options = {}) {
        this.canvas = document.getElementById(canvasId)
        this.messageElement = options.messageId ? document.getElementById(options.messageId) : null
        this.infoElement = options.infoId ? document.getElementById(options.infoId) : null
        this.shaderUrl = options.shaderUrl || '/assets/wgsl/model.wgsl'

        this.camera = new OrbitCamera()
        this.controls = null
        this.renderer = null
        this.supported = false
        this.loadToken = 0

        this.progressUpdateHandler = () => {}

        this.ready = this.initialize()
    }

    set progressUpdateCallback( handler ) {
        this.progressUpdateHandler = handler
    }
    get progressUpdateCallback()
    {
        return this.progressUpdateHandler
    }

    async initialize() {
        try {
            if (!this.canvas) {
                throw new Error('Viewer canvas not found.')
            }
            this.renderer = await ModelRenderer.create(this.canvas, this.camera, this.shaderUrl)
            this.renderer.onLost = (info) => {
                this.supported = false
                this.showMessage('The GPU device was lost (' + (info?.message || info?.reason || 'unknown reason') + '). Reload the page to continue.', 'error')
            }
            this.controls = new OrbitControls(this.canvas, this.camera)
            this.supported = true
            return true
        } catch (ex) {
            console.error(ex)
            this.supported = false
            this.showMessage(
                (ex && ex.message ? ex.message : String(ex)) +
                ' The 3D viewer needs a browser with WebGPU support (recent Chrome, Edge, or Safari 26+).',
                'error'
            )
            return false
        }
    }

    /**
     * Show (or clear, with a falsy text) a message over the viewer.
     * @param {string} text
     * @param {'error'|'info'} [kind]
     */
    showMessage(text, kind = 'info') {
        const el = this.messageElement
        if (!el) return
        el.textContent = text || ''
        el.classList.toggle('hidden', !text)
        el.classList.toggle('error', kind === 'error')
    }

    resetCamera() {
        this.camera.reset()
    }

    /**
     * Load a model from the server by name via /api/models/<name>.
     * @param {string} fileName
     * @returns {Promise<boolean>} true when the model is displayed
     */
    async loadSTLFile(fileName) {
        const token = ++this.loadToken
        const ok = await this.ready
        if (!ok) {
            this.progressUpdateCallback(100.0)
            return false
        }

        this.showMessage('')
        this.progressUpdateCallback(0)

        try {
            const url = '/api/models/' + encodeURIComponent(fileName)
            const body = await this.download(url, (p) => {
                if (token === this.loadToken) this.progressUpdateCallback(p * 80)
            })
            if (token !== this.loadToken) return false // superseded by a newer request

            this.progressUpdateCallback(80)
            await nextTask() // let the progress bar repaint before the synchronous parse
            const model = parseSTL(body)
            if (token !== this.loadToken) return false

            this.progressUpdateCallback(90)
            await nextTask()
            this.displayModel(model, fileName)
            this.progressUpdateCallback(100.0)
            return true
        } catch (ex) {
            console.error(ex)
            if (token === this.loadToken) {
                this.progressUpdateCallback(100.0)
                this.showMessage('Could not load "' + fileName + '": ' + (ex && ex.message ? ex.message : ex), 'error')
            }
            return false
        }
    }

    /** Parse and display STL bytes you already have (ArrayBuffer). */
    async loadSTLBuffer(buffer, label = 'model') {
        const ok = await this.ready
        if (!ok) return false
        try {
            this.showMessage('')
            this.displayModel(parseSTL(buffer), label)
            return true
        } catch (ex) {
            console.error(ex)
            this.showMessage('Could not read "' + label + '": ' + (ex && ex.message ? ex.message : ex), 'error')
            return false
        }
    }

    displayModel(model, label) {
        const fit = fitTransform(model.bounds, FIT_SIZE)
        const modelMatrix = centerAndScale(fit.center, fit.scale)
        this.renderer.setMesh(model.positions, model.normals, modelMatrix)
        this.camera.reset()
        if (this.infoElement) {
            const dims = fit.extent.map(v => Number(v.toPrecision(4))).join(' x ')
            this.infoElement.textContent =
                label + ' – ' + model.triangleCount.toLocaleString() + ' triangles, ' + dims
        }
    }

    /** Fetch with coarse progress (0..1) when Content-Length is known. */
    async download(url, onProgress) {
        const response = await fetch(url, { credentials: 'same-origin' })
        if (!response.ok) {
            let detail = ''
            try { detail = (await response.json()).error || '' } catch (_) { /* not JSON */ }
            throw new Error(detail || ('HTTP ' + response.status))
        }

        const total = Number(response.headers.get('Content-Length')) || 0
        if (!response.body || !total) {
            const buf = await response.arrayBuffer()
            onProgress(1)
            return buf
        }

        const reader = response.body.getReader()
        const chunks = []
        let received = 0
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(value)
            received += value.length
            onProgress(Math.min(received / total, 1))
        }
        const out = new Uint8Array(received)
        let offset = 0
        for (const c of chunks) {
            out.set(c, offset)
            offset += c.length
        }
        return out.buffer
    }
}

function nextTask() {
    return new Promise((resolve) => setTimeout(resolve, 0))
}

export {
    ClientViewer
}

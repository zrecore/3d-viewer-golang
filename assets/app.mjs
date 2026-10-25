/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

import { ClientViewer } from '/assets/client.mjs'
import { parseSTL } from '/assets/stl-parser.mjs'
import { isValidModelName, saveLastModel, loadLastModel } from '/assets/local-store.mjs'

/** Largest file accepted into this browser's storage. */
const MAX_LOCAL_MODEL_BYTES = 50 * 1024 * 1024

/**
 * Page wiring for templates/index.html: the toolbar (upload, reset view) and the viewer. The last model
 * the user uploaded is kept in this browser only and shown on the next visit;
 * nothing is shown until one has been uploaded. Everything is looked up by element id.
 */
export function initApp() {
    const $ = (id) => document.getElementById(id)
    const root = document.documentElement

    const viewer = new ClientViewer('viewerCanvas', { messageId: 'viewerMessage', infoId: 'viewerInfo' })
    const progressBar = $('progressBar')

    // ---------------------------------------------------------------- progress
    viewer.progressUpdateCallback = (percent) => {
        progressBar.classList.remove('hidden')
        const p = Math.max(0, Math.min(100, percent)).toFixed(0)
        progressBar.style.background =
            'linear-gradient( to right, var(--control-highlight-color), var(--control-highlight-color) ' + p + '%, var(--input-bg-color) ' + p + '%, var(--input-bg-color) )'
        progressBar.textContent = percent.toFixed(1) + '%'
        if (percent >= 100.0) {
            clearTimeout(progressBar._hideTimer)
            progressBar._hideTimer = setTimeout(() => progressBar.classList.add('hidden'), 500)
        } else {
            clearTimeout(progressBar._hideTimer)
        }
    }

    $('btnResetView').addEventListener('click', () => viewer.resetCamera())

    // ----------------------------------------------------------------- upload
    // Uploads are stored in this browser (IndexedDB) and never sent to the server.
    const uploadFile = $('uploadFile')
    const uploadButton = $('btnUpload')
    const uploadMessage = $('uploadMessage')

    // The message overlays the bottom of the screen and fades away on its own.
    const UPLOAD_MESSAGE_MS = 15000
    const UPLOAD_MESSAGE_FADE_MS = 600
    let uploadFadeTimer = null
    let uploadHideTimer = null

    function setUploadMessage(text, isError) {
        clearTimeout(uploadFadeTimer)
        clearTimeout(uploadHideTimer)
        uploadMessage.classList.remove('fading')
        uploadMessage.textContent = text || ''
        uploadMessage.classList.toggle('hidden', !text)
        uploadMessage.classList.toggle('error', !!isError)
        if (!text) return
        uploadFadeTimer = setTimeout(() => {
            uploadMessage.classList.add('fading')
            uploadHideTimer = setTimeout(() => {
                uploadMessage.classList.add('hidden')
                uploadMessage.classList.remove('fading')
            }, UPLOAD_MESSAGE_FADE_MS)
        }, UPLOAD_MESSAGE_MS)
    }

    // The Upload button opens the file picker; choosing a file uploads it right away.
    uploadButton.addEventListener('click', () => uploadFile.click())
    uploadFile.addEventListener('change', async () => {
        const file = uploadFile.files && uploadFile.files[0]
        if (!file) return
        uploadButton.disabled = true
        try {
            await storeAndShow(file)
        } finally {
            uploadFile.value = '' // so choosing the same file again still fires `change`
            uploadButton.disabled = false
        }
    })

    async function storeAndShow(file) {
        if (!isValidModelName(file.name)) {
            setUploadMessage('That is not an .stl file. Choose a file whose name ends in .stl.', true)
            return
        }
        if (file.size > MAX_LOCAL_MODEL_BYTES) {
            setUploadMessage('That file is larger than ' + formatBytes(MAX_LOCAL_MODEL_BYTES) + '.', true)
            return
        }
        setUploadMessage('Saving ' + file.name + '...', false)
        try {
            const data = await file.arrayBuffer()
            parseSTL(data) // reject files that are not valid STL before storing them
            await saveLastModel(file.name, data)

            setUploadMessage('Saved ' + file.name + ' in this browser.', false)
            await viewer.loadSTLBuffer(data, file.name)
        } catch (ex) {
            const quota = ex && ex.name === 'QuotaExceededError'
            const text = quota ? 'Not enough browser storage space for this file.' : (ex && ex.message ? ex.message : String(ex))
            setUploadMessage(quota ? text : 'Could not save: ' + text, true)
        }
    }

    // ------------------------------------------ movable, collapsible toolbar
    // `hi` never goes below `lo`, so a box larger than the room pins to the near edge.
    const clampBetween = (value, lo, hi) => Math.min(Math.max(value, lo), Math.max(lo, hi))

    /** Safe-area insets in CSS pixels, read from the invisible probe (see .safe-probe). */
    const safeProbe = $('safeProbe')
    function safeInsets() {
        const cs = getComputedStyle(safeProbe)
        return {
            top: parseFloat(cs.paddingTop) || 0,
            right: parseFloat(cs.paddingRight) || 0,
            bottom: parseFloat(cs.paddingBottom) || 0,
            left: parseFloat(cs.paddingLeft) || 0,
        }
    }

    /**
     * Make a floating box (the toolbar, the help dialog) draggable by its handle. The box is positioned by its
     * distance from the top and from `edge` ('left' or 'right'), so collapsing it
     * (which narrows it) leaves that edge where it is. The spot is saved under
     * 'stl-viewer:<name>-pos', which the inline script in index.html restores
     * before first paint.
     * @returns {() => void} pulls the box back onto the screen (call it after showing the box)
     */
    function makeMovable({ el, handle, name, edge }) {
        const sign = edge === 'right' ? -1 : 1
        const edgeVar = '--' + name + '-' + edge
        const topVar = '--' + name + '-top'

        const current = () => {
            const r = el.getBoundingClientRect()
            return { [edge]: edge === 'right' ? root.clientWidth - r.right : r.left, top: r.top }
        }
        // Keep the box inside the safe area (all zero except on notched screens in cover mode).
        const clampPos = (pos) => {
            const inset = safeInsets()
            const near = edge === 'right' ? inset.right : inset.left
            const far = edge === 'right' ? inset.left : inset.right
            return {
                [edge]: clampBetween(pos[edge], near, root.clientWidth - el.offsetWidth - far),
                top: clampBetween(pos.top, inset.top, root.clientHeight - el.offsetHeight - inset.bottom),
            }
        }
        const place = (pos) => {
            root.style.setProperty(edgeVar, Math.round(pos[edge]) + 'px')
            root.style.setProperty(topVar, Math.round(pos.top) + 'px')
        }

        // Where the user put the box: restored from storage, else read from the
        // screen once the box is visible. A small window only clamps what is
        // shown, so enlarging the window again restores the chosen spot.
        let desired = null
        try {
            const saved = JSON.parse(localStorage.getItem('stl-viewer:' + name + '-pos') || 'null')
            if (saved && Number.isFinite(saved[edge]) && Number.isFinite(saved.top)) desired = { [edge]: saved[edge], top: saved.top }
        } catch (_) { /* storage unavailable or corrupt */ }
        const isHidden = () => el.getClientRects().length === 0
        const keepOnScreen = () => {
            if (isHidden()) return // measured when it is next shown
            if (!desired) desired = current()
            place(clampPos(desired))
        }

        let drag = null
        handle.addEventListener('pointerdown', (ev) => {
            if (ev.button !== 0 || !ev.isPrimary || drag) return // a second finger must not restart the drag
            drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, start: clampPos(desired || current()) }
            handle.setPointerCapture(ev.pointerId)
            el.classList.add('dragging')
            ev.preventDefault()
        })
        handle.addEventListener('pointermove', (ev) => {
            if (!drag || ev.pointerId !== drag.id) return
            desired = clampPos({
                [edge]: drag.start[edge] + sign * (ev.clientX - drag.x),
                top: drag.start.top + (ev.clientY - drag.y),
            })
            place(desired)
        })
        const endDrag = (ev) => {
            if (!drag || (ev && ev.pointerId !== drag.id)) return
            drag = null
            el.classList.remove('dragging')
            try { localStorage.setItem('stl-viewer:' + name + '-pos', JSON.stringify(desired)) } catch (_) { /* storage unavailable */ }
        }
        handle.addEventListener('pointerup', endDrag)
        handle.addEventListener('pointercancel', endDrag)
        handle.addEventListener('lostpointercapture', endDrag)
        window.addEventListener('resize', keepOnScreen)
        keepOnScreen() // a saved position may not fit a smaller window
        return keepOnScreen
    }

    /**
     * Wire a toggle button to a `<name>-collapsed` class on <html>. The state is
     * saved under 'stl-viewer:<name>-collapsed', which the inline script in
     * index.html reads before first paint.
     */
    function wireCollapsible({ name, button, onChange }) {
        const className = name + '-collapsed'
        const apply = (collapsed, persist) => {
            root.classList.toggle(className, collapsed)
            button.setAttribute('aria-expanded', String(!collapsed))
            const label = (collapsed ? 'Expand ' : 'Collapse ') + name
            button.setAttribute('aria-label', label)
            button.title = label
            if (onChange) onChange(collapsed)
            if (persist) {
                try { localStorage.setItem('stl-viewer:' + className, collapsed ? '1' : '0') } catch (_) { /* storage unavailable */ }
            }
        }
        button.addEventListener('click', () => apply(!root.classList.contains(className), true))
        apply(root.classList.contains(className), false)
    }

    const keepToolbarOnScreen = makeMovable({ el: $('toolbar'), handle: $('toolbarHandle'), name: 'toolbar', edge: 'right' })

    // Collapsing or expanding changes the toolbar's size, so keep it on screen.
    wireCollapsible({ name: 'toolbar', button: $('btnToggleToolbar'), onChange: keepToolbarOnScreen })

    // ------------------------------------------------------------------- help
    const help = $('help')
    const helpButton = $('btnHelp')
    const helpClose = $('btnCloseHelp')
    const keepHelpOnScreen = makeMovable({ el: help, handle: $('helpHandle'), name: 'help', edge: 'left' })

    function setHelpOpen(open) {
        help.classList.toggle('hidden', !open)
        helpButton.setAttribute('aria-expanded', String(open))
        if (open) {
            keepHelpOnScreen()
            helpClose.focus()
        } else if (help.contains(document.activeElement)) {
            helpButton.focus()
        }
    }

    helpButton.addEventListener('click', () => setHelpOpen(help.classList.contains('hidden')))
    helpClose.addEventListener('click', () => setHelpOpen(false))
    document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && !help.classList.contains('hidden')) setHelpOpen(false)
    })

    // ------------------------------------------------------------------ start
    // Show the last uploaded model, if any. There is no default model.
    loadLastModel()
        .then((last) => last && viewer.loadSTLBuffer(last.data, last.name))
        .catch((ex) => console.warn('Could not read the last model stored in this browser:', ex))

    // ------------------------------------------------------------------ debug
    // Read-only camera state for end-to-end tests. Only present with ?debug in the URL.
    if (new URLSearchParams(location.search).has('debug')) {
        const canvas = $('viewerCanvas')
        window.__stlViewerDebug = Object.freeze({
            state() {
                const cam = viewer.camera
                const rect = canvas.getBoundingClientRect()
                return JSON.parse(JSON.stringify({
                    azimuth: cam.azimuth,
                    elevation: cam.elevation,
                    distance: cam.distance,
                    target: cam.target,
                    eye: cam.eye(),
                    viewAspect: cam.viewAspect ?? null,
                    epoch: cam.epoch ?? null,
                    canvas: { width: canvas.width, height: canvas.height, cssWidth: rect.width, cssHeight: rect.height, dpr: window.devicePixelRatio },
                    frames: viewer.renderer ? viewer.renderer.frames : 0,
                    controls: viewer.controls && viewer.controls.debugState ? viewer.controls.debugState() : null,
                }))
            },
            /** World point on the focal plane under a canvas pixel (CSS px). */
            focalPoint(px, py) {
                const rect = canvas.getBoundingClientRect()
                return viewer.camera.focalPlanePoint(px, py, rect.width, rect.height)
            },
            /** Canvas CSS pixel [x, y, depth] of a world point. */
            project(world) {
                const rect = canvas.getBoundingClientRect()
                return viewer.camera.worldToScreen(world, rect.width, rect.height)
            },
        })
    }

    return viewer
}

function formatBytes(n) {
    if (!Number.isFinite(n)) return ''
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KiB'
    return (n / (1024 * 1024)).toFixed(1) + ' MiB'
}

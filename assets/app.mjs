/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

import { ClientViewer } from '/assets/client.mjs'

/**
 * Page wiring for templates/index.html: model list, search filter, upload,
 * auth state, and the viewer. Everything is looked up by element id.
 */
export function initApp() {
    const $ = (id) => document.getElementById(id)

    const viewer = new ClientViewer('viewerCanvas', { messageId: 'viewerMessage', infoId: 'viewerInfo' })
    const progressBar = $('progressBar')
    const list = $('modelList')
    const noMatches = $('noMatches')
    const searchForm = $('frmSearch')
    const searchInput = $('query')

    let selectedName = null

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

    // ------------------------------------------------------------- model list
    const entryElements = () => Array.from(list.querySelectorAll('.file-entry'))

    function applyFilter() {
        const q = searchInput.value.trim().toLowerCase()
        let visible = 0
        for (const el of entryElements()) {
            const match = !q || el.dataset.name.toLowerCase().includes(q)
            el.classList.toggle('hidden', !match)
            if (match) visible++
        }
        noMatches.classList.toggle('hidden', visible > 0)
    }

    function markSelected() {
        for (const el of entryElements()) {
            el.classList.toggle('selected', el.dataset.name === selectedName)
        }
    }

    function renderList(models) {
        list.querySelectorAll('.file-entry').forEach((el) => el.remove())
        const frag = document.createDocumentFragment()
        for (const m of models) {
            const div = document.createElement('div')
            div.className = 'card-colorize font-monospace p-2 file-entry'
            div.dataset.name = m.name
            div.title = formatBytes(m.size)
            div.tabIndex = 0
            div.setAttribute('role', 'button')
            div.textContent = m.name
            frag.appendChild(div)
        }
        list.insertBefore(frag, noMatches)
        markSelected()
        applyFilter()
    }

    async function refreshList() {
        try {
            const res = await fetch('/api/models', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
            if (!res.ok) throw new Error('HTTP ' + res.status)
            const models = await res.json()
            if (Array.isArray(models)) renderList(models)
        } catch (ex) {
            // Keep the server-rendered list if the refresh fails.
            console.warn('Could not refresh model list:', ex)
        }
    }

    async function selectEntry(el) {
        const name = el?.dataset?.name
        if (!name) return
        selectedName = name
        markSelected()
        await viewer.loadSTLFile(name)
    }

    list.addEventListener('click', (ev) => selectEntry(ev.target.closest('.file-entry')))
    list.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
            const el = ev.target.closest('.file-entry')
            if (el) {
                ev.preventDefault()
                selectEntry(el)
            }
        }
    })

    searchForm.addEventListener('submit', (ev) => {
        ev.preventDefault()
        applyFilter()
    })
    searchInput.addEventListener('input', applyFilter)

    $('btnResetView').addEventListener('click', () => viewer.resetCamera())

    // ------------------------------------------------------------------- auth
    const uploadForm = $('frmUpload')
    const uploadFile = $('uploadFile')
    const uploadButton = $('btnUpload')
    const uploadMessage = $('uploadMessage')
    const signInLink = $('linkSignIn')
    const signOutButton = $('btnSignOut')
    const authUser = $('authUser')

    function setUploadMessage(text, isError) {
        uploadMessage.textContent = text || ''
        uploadMessage.classList.toggle('hidden', !text)
        uploadMessage.classList.toggle('error', !!isError)
    }

    function applyAuth(me) {
        const authed = !!(me && me.authenticated)
        uploadFile.disabled = !authed
        uploadButton.disabled = !authed
        uploadButton.classList.toggle('disabled', !authed)
        signInLink.classList.toggle('hidden', authed)
        signOutButton.classList.toggle('hidden', !authed)
        authUser.classList.toggle('hidden', !authed)
        authUser.textContent = authed ? 'Signed in as ' + (me.user?.name || me.user?.email || 'user') : ''
    }

    async function refreshAuth() {
        try {
            const res = await fetch('/api/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
            if (!res.ok) throw new Error('HTTP ' + res.status)
            applyAuth(await res.json())
        } catch (ex) {
            console.warn('Could not determine sign-in state:', ex)
            applyAuth({ authenticated: false })
        }
    }

    signOutButton.addEventListener('click', async () => {
        signOutButton.disabled = true
        try {
            await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' })
        } catch (ex) {
            console.warn('Sign out request failed:', ex)
        }
        signOutButton.disabled = false
        setUploadMessage('')
        await refreshAuth()
    })

    uploadForm.addEventListener('submit', async (ev) => {
        ev.preventDefault()
        const file = uploadFile.files && uploadFile.files[0]
        if (!file) {
            setUploadMessage('Choose an .stl file first.', true)
            return
        }
        if (!/\.stl$/i.test(file.name)) {
            setUploadMessage('Only .stl files can be uploaded.', true)
            return
        }

        const data = new FormData()
        data.append('file', file, file.name)

        uploadButton.disabled = true
        setUploadMessage('Uploading ' + file.name + '...', false)
        try {
            const res = await fetch('/api/models', { method: 'POST', body: data, credentials: 'same-origin' })
            let payload = null
            try { payload = await res.json() } catch (_) { /* non-JSON body */ }

            if (!res.ok) {
                setUploadMessage((payload && payload.error) || ('Upload failed (HTTP ' + res.status + ').'), true)
                if (res.status === 401) await refreshAuth()
                return
            }

            setUploadMessage('Uploaded ' + (payload?.name || file.name) + '.', false)
            uploadForm.reset()
            await refreshList()
            if (payload?.name) {
                selectedName = payload.name
                markSelected()
                await viewer.loadSTLFile(payload.name)
            }
        } catch (ex) {
            setUploadMessage('Upload failed: ' + (ex && ex.message ? ex.message : ex), true)
        } finally {
            // Re-enable only if still signed in (the 401 path already updated state).
            uploadButton.disabled = uploadFile.disabled
        }
    })

    // ------------------------------------------------------------------ start
    applyFilter()
    refreshAuth()
    refreshList()

    return viewer
}

function formatBytes(n) {
    if (!Number.isFinite(n)) return ''
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KiB'
    return (n / (1024 * 1024)).toFixed(1) + ' MiB'
}

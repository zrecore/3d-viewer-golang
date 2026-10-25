/**
 * @author Alex Albino <dev@alexventure.com>
 * @link https://github.com/zrecore/3d-viewer-golang
 * @license MIT. See LICENSE file.
 */

/**
 * Browser-local storage (IndexedDB) for the last model the user uploaded. The
 * file never leaves the browser. IndexedDB is used instead of localStorage
 * because localStorage is limited to ~5 MB of strings, which a single binary
 * STL can exceed.
 */

const DB_NAME = 'stl-viewer'
const STORE = 'models'

/** Same rule as the server's viewer.ValidName: a plain base name ending in .stl. */
export function isValidModelName(name) {
    if (typeof name !== 'string') return false
    if (name.length < 5 || name.length > 255) return false
    if (!/\.stl$/i.test(name)) return false
    if (/[/\\\u0000-\u001f]/.test(name)) return false
    return name !== '.' && name !== '..'
}

let dbPromise = null

function openDB() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            if (typeof indexedDB === 'undefined') {
                reject(new Error('This browser does not support local storage for models.'))
                return
            }
            const req = indexedDB.open(DB_NAME, 1)
            req.onupgradeneeded = () => {
                req.result.createObjectStore(STORE, { keyPath: 'name' })
            }
            req.onsuccess = () => resolve(req.result)
            req.onerror = () => reject(req.error || new Error('Could not open browser storage.'))
            req.onblocked = () => reject(new Error('Browser storage is blocked by another tab.'))
        }).catch((err) => {
            dbPromise = null // allow a retry
            throw err
        })
    }
    return dbPromise
}

/** Run one request in a transaction and resolve once the transaction commits. */
async function run(mode, makeRequest) {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode)
        const req = makeRequest(tx.objectStore(STORE))
        tx.oncomplete = () => resolve(req ? req.result : undefined)
        tx.onerror = () => reject(tx.error || req?.error)
        tx.onabort = () => reject(tx.error || new Error('Browser storage transaction aborted.'))
    })
}

/**
 * Store a model as the last upload, replacing whatever was stored before.
 * @param {string} name
 * @param {ArrayBuffer} data
 */
export async function saveLastModel(name, data) {
    await run('readwrite', (store) => {
        store.clear()
        return store.put({ name, data, size: data.byteLength, modTime: Date.now() })
    })
}

/**
 * @returns {Promise<{name: string, data: ArrayBuffer}|null>} the most recently
 * uploaded model, or null when nothing has been uploaded
 */
export async function loadLastModel() {
    const records = await run('readonly', (store) => store.getAll())
    if (!records || !records.length) return null
    const last = records.reduce((a, b) => (b.modTime > a.modTime ? b : a))
    return { name: last.name, data: last.data }
}

// IndexedDB storage. Everything stays on this device.
// Stores:
//   books        metadata, progress, cover thumbnail (keyPath id = SHA-256 of the file)
//   files        the EPUB bytes, kept apart so the library loads without them
//   annotations  highlights and bookmarks (keyPath id, index bookId)

const DB_NAME = 'quire'
const DB_VERSION = 1

let dbPromise = null

export function openDB() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    let req
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (e) {
      reject(new Error('This browser blocks local storage, so books cannot be saved.'))
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('annotations')) {
        const s = db.createObjectStore('annotations', { keyPath: 'id' })
        s.createIndex('bookId', 'bookId', { unique: false })
      }
    }
    req.onsuccess = () => {
      const db = req.result
      // Another tab upgraded the schema: close so it can proceed.
      db.onversionchange = () => db.close()
      resolve(db)
    }
    req.onerror = () => reject(req.error || new Error('Could not open the library database.'))
    req.onblocked = () => reject(new Error('Close other Quire tabs and try again.'))
  })
  dbPromise.catch(() => { dbPromise = null })
  return dbPromise
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted'))
  })
}

function result(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function getAll(store) {
  const db = await openDB()
  return result(db.transaction(store).objectStore(store).getAll())
}

export async function get(store, key) {
  const db = await openDB()
  return result(db.transaction(store).objectStore(store).get(key))
}

export async function put(store, value) {
  const db = await openDB()
  const tx = db.transaction(store, 'readwrite')
  tx.objectStore(store).put(value)
  return done(tx)
}

export async function del(store, key) {
  const db = await openDB()
  const tx = db.transaction(store, 'readwrite')
  tx.objectStore(store).delete(key)
  return done(tx)
}

// Adds a book and its file in one transaction, so a failed write
// never leaves a library entry without its file.
export async function addBook(meta, fileRecord) {
  const db = await openDB()
  const tx = db.transaction(['books', 'files'], 'readwrite')
  tx.objectStore('books').put(meta)
  tx.objectStore('files').put(fileRecord)
  return done(tx)
}

// Partial update of a book record (progress, last opened...).
export async function updateBook(id, patch) {
  const db = await openDB()
  const tx = db.transaction('books', 'readwrite')
  const store = tx.objectStore('books')
  let updated = null
  // Callback style on purpose: awaiting inside an IDB transaction can let it
  // auto-commit early on older WebKit.
  const req = store.get(id)
  req.onsuccess = () => {
    if (!req.result) return
    updated = { ...req.result, ...patch }
    store.put(updated)
  }
  await done(tx)
  return updated
}

export async function annotationsFor(bookId) {
  const db = await openDB()
  const idx = db.transaction('annotations').objectStore('annotations').index('bookId')
  return result(idx.getAll(IDBKeyRange.only(bookId)))
}

// Removes the book, its file and every annotation in one go.
export async function removeBook(id) {
  const db = await openDB()
  const tx = db.transaction(['books', 'files', 'annotations'], 'readwrite')
  tx.objectStore('books').delete(id)
  tx.objectStore('files').delete(id)
  const idx = tx.objectStore('annotations').index('bookId')
  const req = idx.openKeyCursor(IDBKeyRange.only(id))
  req.onsuccess = () => {
    const cursor = req.result
    if (!cursor) return
    tx.objectStore('annotations').delete(cursor.primaryKey)
    cursor.continue()
  }
  return done(tx)
}

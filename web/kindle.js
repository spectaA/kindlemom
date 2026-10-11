// Kindle storage access through the File System Access API (USB mass storage).

const BOOK_EXTS = new Set(['kfx', 'azw3', 'azw', 'mobi', 'prc', 'pdf', 'txt', 'epub']);
const SKIP_DIRS = new Set(['dictionaries']);
const SKIP_FILES = new Set(['my clippings.txt']);
const MANIFEST = 'kindlemom.json';

export const supported = () => 'showDirectoryPicker' in window;

export const extOf = (name) => {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
};

export const stem = (name) => {
  const i = name.lastIndexOf('.');
  return i < 0 ? name : name.slice(0, i);
};

/** A filename that FAT32 and the Kindle accept. */
export function safeFileName(base, ext) {
  const clean = base
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, 120)
    .trim();
  return `${clean || 'Livre'}.${ext}`;
}

// --- Remembered handle (IndexedDB) ---------------------------------------

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('kindlemom', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function kvGet(key) {
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const req = d.transaction('kv').objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
}

export async function kvSet(key, value) {
  try {
    const d = await db();
    await new Promise((resolve, reject) => {
      const tx = d.transaction('kv', 'readwrite');
      if (value === undefined) tx.objectStore('kv').delete(key);
      else tx.objectStore('kv').put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Remembering the device is a convenience only.
  }
}

// --- Device ---------------------------------------------------------------

async function childDir(dir, name, create = false) {
  try {
    return await dir.getDirectoryHandle(name, { create });
  } catch (e) {
    if (e.name === 'NotFoundError' || e.name === 'TypeMismatchError') return null;
    throw e;
  }
}

export class Kindle {
  constructor(root, documents) {
    this.root = root;
    this.documents = documents;
    this.name = root.name;
  }

  /** Opens a directory handle picked by the user, checking it is a Kindle. */
  static async open(root) {
    const documents = await childDir(root, 'documents');
    if (!documents) {
      if (root.name.toLowerCase() === 'documents') {
        throw new Error('Tu as choisi le dossier « documents », qui est à l’intérieur de la Kindle. Recommence et clique sur « Kindle » lui-même.');
      }
      throw new Error(`« ${root.name} » n’est pas une Kindle. Recommence et clique sur « Kindle » dans la colonne de gauche.`);
    }
    return new Kindle(root, documents);
  }

  /** Every book under documents/, newest first. */
  async list() {
    const books = [];
    const walk = async (dir, prefix, parents) => {
      for await (const [name, handle] of dir.entries()) {
        if (name.startsWith('.')) continue;
        if (handle.kind === 'directory') {
          const lower = name.toLowerCase();
          if (lower.endsWith('.sdr') || (!prefix && SKIP_DIRS.has(lower))) continue;
          await walk(handle, `${prefix}${name}/`, [...parents, handle]);
          continue;
        }
        const ext = extOf(name);
        if (!BOOK_EXTS.has(ext) || SKIP_FILES.has(name.toLowerCase())) continue;
        const file = await handle.getFile();
        books.push({
          path: `${prefix}${name}`,
          name,
          ext,
          size: file.size,
          modified: file.lastModified,
          handle,
          dir: parents[parents.length - 1],
        });
      }
    };
    await walk(this.documents, '', [this.documents]);
    books.sort((a, b) => b.modified - a.modified);
    return books;
  }

  async read(book) {
    const file = await book.handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async exists(dir, name) {
    try {
      await dir.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }

  async write(dir, name, data) {
    const handle = await dir.getFileHandle(name, { create: true });
    const stream = await handle.createWritable();
    try {
      await stream.write(data);
      await stream.close();
    } catch (e) {
      await stream.abort().catch(() => {});
      throw e;
    }
    return handle;
  }

  async remove(dir, name, recursive = false) {
    try {
      await dir.removeEntry(name, { recursive });
    } catch (e) {
      if (e.name !== 'NotFoundError') throw e;
    }
  }

  /**
   * Deletes a book with its reading-position folder and library thumbnail.
   * `keepFile` leaves the book file itself, for one just overwritten.
   */
  async removeBook(book, { keepFile = false } = {}) {
    if (!keepFile) await this.remove(book.dir, book.name);
    await this.remove(book.dir, `${stem(book.name)}.sdr`, true);
    const manifest = await this.manifest();
    const entry = manifest.books[book.path];
    if (entry?.thumbnail) {
      const thumbs = await this.thumbnails(false);
      if (thumbs) await this.remove(thumbs, entry.thumbnail);
    }
    delete manifest.books[book.path];
    await this.saveManifest(manifest);
  }

  async thumbnails(create = true) {
    const system = await childDir(this.root, 'system', create);
    return system && childDir(system, 'thumbnails', create);
  }

  async writeThumbnail(contentId, blob) {
    const thumbs = await this.thumbnails(true);
    const name = `thumbnail_${contentId}_EBOK_portrait.jpg`;
    await this.write(thumbs, name, blob);
    return name;
  }

  // Books added here, with the thumbnail written for each.
  async manifest() {
    if (!this._manifest) {
      try {
        const file = await (await this.root.getFileHandle(MANIFEST)).getFile();
        this._manifest = JSON.parse(await file.text());
      } catch {
        this._manifest = {};
      }
      this._manifest.books ??= {};
    }
    return this._manifest;
  }

  async saveManifest(manifest) {
    this._manifest = manifest;
    await this.write(this.root, MANIFEST, JSON.stringify(manifest, null, 1));
  }
}

export async function permitted(handle, ask) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if (!ask) return false;
  return (await handle.requestPermission(opts)) === 'granted';
}

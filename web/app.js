import * as engine from './engine.js';
import { Kindle, extOf, kvGet, kvSet, permitted, safeFileName, stem, supported } from './kindle.js';

const $ = (id) => document.getElementById(id);

const ui = {
  intro: $('intro'),
  library: $('library'),
  connect: $('connect'),
  reconnect: $('reconnect'),
  reconnectName: $('reconnect-name'),
  unsupported: $('unsupported'),
  device: $('device'),
  deviceLabel: $('device-label'),
  disconnect: $('disconnect'),
  drop: $('drop'),
  pick: $('pick'),
  fileInput: $('file-input'),
  format: $('format'),
  queue: $('queue'),
  count: $('count'),
  search: $('search'),
  refresh: $('refresh'),
  shelf: $('shelf'),
  empty: $('empty'),
  toast: $('toast'),
  confirmDialog: $('confirm-dialog'),
  confirmTitle: $('confirm-title'),
  confirmText: $('confirm-text'),
  confirmOk: $('confirm-ok'),
};

/** Formats the Kindle reads natively, copied as is. */
const NATIVE = new Set(['kfx', 'azw3', 'azw', 'mobi', 'prc', 'pdf', 'txt']);
const UNSUPPORTED = "Ce fichier n'est pas un livre que la Kindle sait lire. Choisis un fichier qui finit par .epub.";

let kindle = null;
let books = [];
const metaCache = new Map();

// --- Small helpers --------------------------------------------------------

const prefs = {
  get(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* not persisted */ }
  },
};

let toastTimer;
function toast(message, isError = false) {
  ui.toast.textContent = message;
  ui.toast.classList.toggle('error', isError);
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, isError ? 10000 : 6000);
}

function errorText(e) {
  if (e?.name === 'NotAllowedError') return "La Kindle a refusé l'accès. Clique sur « Changer de Kindle », puis accepte quand Chrome demande la permission.";
  if (e?.name === 'NotFoundError') return "La Kindle semble débranchée. Rebranche-la, puis clique sur « Changer de Kindle ».";
  if (e?.name === 'QuotaExceededError') return "Il n'y a plus assez de place sur la Kindle. Supprime un livre déjà lu, puis réessaie.";
  return e?.message || String(e);
}

/** Conversion errors come from the engine in technical terms. */
function bookErrorText(e) {
  if (e?.name !== 'Error' || e.message === UNSUPPORTED) return errorText(e);
  return `Ce livre n'a pas pu être préparé. Il est peut-être protégé contre la copie, ou abîmé. (${e.message})`;
}

function confirmAction({ title, text, ok = 'Confirmer', danger = true }) {
  ui.confirmTitle.textContent = title;
  ui.confirmText.textContent = text;
  ui.confirmOk.textContent = ok;
  ui.confirmOk.className = `btn ${danger ? 'danger' : 'primary'}`;
  ui.confirmDialog.returnValue = '';
  ui.confirmDialog.showModal();
  return new Promise((resolve) => {
    ui.confirmDialog.addEventListener('close', () => resolve(ui.confirmDialog.returnValue === 'ok'), { once: true });
  });
}

// --- Connection -----------------------------------------------------------

async function useHandle(handle) {
  kindle = await Kindle.open(handle);
  await kvSet('device', handle);
  ui.deviceLabel.textContent = kindle.name;
  ui.device.hidden = false;
  ui.intro.hidden = true;
  ui.library.hidden = false;
  await refresh();
}

async function connect() {
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: 'kindle', mode: 'readwrite' });
  } catch (e) {
    if (e.name !== 'AbortError') toast(errorText(e), true);
    return;
  }
  try {
    await useHandle(handle);
  } catch (e) {
    toast(errorText(e), true);
  }
}

async function reconnect() {
  const handle = await kvGet('device');
  if (!handle) return connect();
  try {
    if (!(await permitted(handle, true))) return toast("Il faut accepter la permission pour continuer.", true);
    await useHandle(handle);
  } catch (e) {
    toast(errorText(e), true);
  }
}

async function disconnect() {
  kindle = null;
  books = [];
  ui.shelf.replaceChildren();
  ui.queue.replaceChildren();
  ui.device.hidden = true;
  ui.library.hidden = true;
  ui.intro.hidden = false;
  await showReconnect();
}

async function showReconnect() {
  const handle = await kvGet('device');
  ui.reconnect.hidden = !handle;
  if (handle) {
    ui.reconnectName.textContent = handle.name;
    ui.connect.textContent = 'Choisir une autre Kindle';
    ui.connect.classList.remove('primary');
  }
}

// --- Library --------------------------------------------------------------

async function refresh() {
  if (!kindle) return;
  try {
    books = await kindle.list();
  } catch (e) {
    toast(errorText(e), true);
    return;
  }
  render();
  loadMetadata();
}

const cacheKey = (book) => `meta:${kindle.name}:${book.path}:${book.size}:${book.modified}`;

/** Reads titles and covers from the books, slowly, in the background. */
async function loadMetadata() {
  const current = kindle;
  for (const book of books) {
    if (kindle !== current) return;
    if (metaCache.has(book.path) || !engine.READABLE.has(book.ext)) continue;
    let meta = await kvGet(cacheKey(book));
    if (!meta) {
      meta = { title: '', authors: [], cover: null };
      try {
        const data = await kindle.read(book);
        const info = await engine.inspect(data, book.ext);
        meta.title = info.title;
        meta.authors = info.authors;
        if (info.has_cover) meta.cover = await thumbnail(await engine.cover(data, book.ext), 240, 360);
      } catch {
        // Unreadable here (DRM, Calibre split KFX…): keep the file name.
      }
      await kvSet(cacheKey(book), meta);
    }
    metaCache.set(book.path, meta);
    updateCard(book);
  }
}

function render() {
  const query = ui.search.value.trim().toLowerCase();
  const shown = books.filter((b) => {
    if (!query) return true;
    const meta = metaCache.get(b.path);
    return `${b.name} ${meta?.title ?? ''} ${meta?.authors?.join(' ') ?? ''}`.toLowerCase().includes(query);
  });
  ui.count.innerHTML = '';
  ui.count.append('Livres sur ta Kindle');
  const small = document.createElement('small');
  small.textContent = `(${books.length})`;
  ui.count.append(small);
  ui.search.hidden = books.length < SEARCH_FROM;
  ui.empty.hidden = books.length > 0;
  ui.shelf.replaceChildren(...shown.map(card));
}

const SEARCH_FROM = 12;

const PALETTE = ['#2f3a4a', '#6b2f2a', '#36513f', '#5a4a2a', '#3e2f52', '#1d1a16', '#7a4b1f'];

function hash(text) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.codePointAt(0)) | 0;
  return Math.abs(h);
}

function card(book) {
  const li = document.createElement('li');
  li.className = 'book';
  li.dataset.path = book.path;
  li.innerHTML = `
    <div class="cover">
      <div class="placeholder"><b></b><small></small></div>
    </div>
    <p class="title"></p>
    <p class="author"></p>
    <p class="unreadable" hidden>La Kindle ne peut pas ouvrir ce livre.</p>
    <div class="acts">
      <button class="btn small get" type="button"></button>
      <button class="btn small get-epub" type="button" hidden>Télécharger en EPUB</button>
      <button class="btn small del" type="button">Supprimer</button>
    </div>`;
  li.querySelector('.unreadable').hidden = book.ext !== 'epub';
  li.querySelector('.get-epub').hidden = book.ext === 'epub' || !engine.READABLE.has(book.ext);
  li.querySelector('.get').textContent = `Télécharger (${book.ext.toUpperCase()})`;
  li.querySelector('.placeholder').style.setProperty('--ph', PALETTE[hash(book.name) % PALETTE.length]);
  li.querySelector('.get').onclick = () => download(book, false);
  li.querySelector('.get-epub').onclick = () => download(book, true);
  li.querySelector('.del').onclick = () => remove(book);
  fillCard(li, book);
  return li;
}

function fillCard(li, book) {
  const meta = metaCache.get(book.path);
  const title = meta?.title || stem(book.name);
  const author = meta?.authors?.join(', ') || '';
  li.querySelector('.title').textContent = title;
  li.querySelector('.title').title = book.path;
  li.querySelector('.author').textContent = author;
  li.querySelector('.placeholder b').textContent = title;
  li.querySelector('.placeholder small').textContent = author;
  const cover = li.querySelector('.cover');
  cover.querySelector('img')?.remove();
  if (meta?.cover) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = URL.createObjectURL(meta.cover);
    img.onload = () => URL.revokeObjectURL(img.src);
    cover.append(img);
  }
}

function updateCard(book) {
  const li = [...ui.shelf.children].find((el) => el.dataset.path === book.path);
  if (li) fillCard(li, book);
}

function setBusy(book, busy) {
  const li = [...ui.shelf.children].find((el) => el.dataset.path === book.path);
  li?.classList.toggle('busy', busy);
}

// --- Images ---------------------------------------------------------------

/** Scales an image to fit `w`×`h`, as JPEG. Null when it cannot be decoded. */
async function thumbnail(bytes, w, h) {
  if (!bytes?.length) return null;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes]));
    const scale = Math.min(w / bitmap.width, h / bitmap.height, 1);
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  } catch {
    return null;
  }
}

// --- Jobs -----------------------------------------------------------------

function job(name) {
  const li = document.createElement('li');
  li.className = 'job working';
  li.innerHTML = '<span class="job-name"></span><span class="job-state"></span><span class="bar"><i></i></span>';
  li.querySelector('.job-name').textContent = name;
  ui.queue.prepend(li);
  const state = li.querySelector('.job-state');
  return {
    step(text) { state.textContent = text; },
    done(text) {
      li.className = 'job done';
      state.textContent = text;
      setTimeout(() => li.remove(), 6000);
    },
    fail(text) {
      li.className = 'job error';
      state.textContent = text;
      li.title = text;
      li.onclick = () => li.remove();
    },
  };
}

/** Converts (if needed) and writes one book to the Kindle. */
async function install({ data, ext, fileName, report }) {
  const target = ui.format.value;
  let out = data;
  let outExt = ext;
  let info = null;

  if (ext === 'epub') {
    info = await engine.inspect(data, 'epub');
    outExt = target;
    report.step('Préparation pour la Kindle…');
    try {
      out = await engine.convert(data, 'epub', outExt);
    } catch (e) {
      if (outExt !== 'kfx') throw e;
      report.step('Préparation pour la Kindle (autre méthode)…');
      outExt = 'azw3';
      out = await engine.convert(data, 'epub', 'azw3');
    }
  } else if (!NATIVE.has(ext)) {
    throw new Error(UNSUPPORTED);
  }

  const base = info
    ? [info.title || stem(fileName), info.authors.join(', ')].filter(Boolean).join(' - ')
    : stem(fileName);
  const name = safeFileName(base, outExt);
  const dir = kindle.documents;
  let overwritten = null;

  if (await kindle.exists(dir, name)) {
    const existing = books.find((b) => b.dir === dir && b.name === name);
    const ok = await confirmAction({
      title: 'Ce livre est déjà sur la Kindle',
      text: `« ${name} » est déjà sur la Kindle. Mettre la nouvelle version à sa place ?`,
      ok: 'Remplacer',
    });
    if (!ok) return 'skipped';
    overwritten = existing;
  }

  report.step('Copie sur la Kindle…');
  await kindle.write(dir, name, out);
  // Written first, so a failed copy never loses the old book.
  if (overwritten) await kindle.removeBook(overwritten, { keepFile: true });

  const manifest = await kindle.manifest();
  const entry = { added: new Date().toISOString() };
  if (outExt === 'kfx' && info?.has_cover) {
    const cover = await thumbnail(await engine.cover(data, 'epub'), 330, 500);
    if (cover) {
      entry.thumbnail = await kindle.writeThumbnail(info.kfx_content_id, cover);
    }
  }
  manifest.books[name] = entry;
  await kindle.saveManifest(manifest);
  return outExt;
}

async function addFiles(files) {
  if (!kindle) return;
  const list = [...files];
  if (!list.length) return;
  let added = 0;
  for (const file of list) {
    const report = job(file.name);
    const ext = extOf(file.name);
    if (!engine.READABLE.has(ext) && !NATIVE.has(ext)) {
      report.fail(UNSUPPORTED);
      continue;
    }
    try {
      report.step('Ouverture du livre…');
      const data = new Uint8Array(await file.arrayBuffer());
      const result = await install({ data, ext, fileName: file.name, report });
      if (result === 'skipped') report.done('Pas ajouté');
      else {
        report.done('Ajouté ✓');
        added++;
      }
    } catch (e) {
      report.fail(bookErrorText(e));
    }
  }
  if (added) toast(`${added} livre${added > 1 ? 's' : ''} ajouté${added > 1 ? 's' : ''}. Quand tu as fini, suis l'étape 3 pour débrancher.`);
  await refresh();
}

async function remove(book) {
  const title = metaCache.get(book.path)?.title || stem(book.name);
  const ok = await confirmAction({
    title: 'Supprimer ce livre ?',
    text: `« ${title} » sera effacé de la Kindle. La page de lecture et les notes seront perdues aussi.`,
    ok: 'Supprimer',
  });
  if (!ok) return;
  setBusy(book, true);
  try {
    await kindle.removeBook(book);
    toast('Livre supprimé ✓');
  } catch (e) {
    toast(errorText(e), true);
  }
  await refresh();
}

function save(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes]));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function download(book, asEpub) {
  setBusy(book, true);
  try {
    let data = await kindle.read(book);
    let name = book.name;
    if (asEpub) {
      data = await engine.convert(data, book.ext, 'epub');
      name = `${stem(book.name)}.epub`;
    }
    save(data, name);
  } catch (e) {
    const text = asEpub && e?.name === 'Error'
      ? "Ce livre ne peut pas être converti en EPUB. Il est peut-être protégé contre la copie."
      : errorText(e);
    toast(text, true);
  } finally {
    setBusy(book, false);
  }
}

// --- Wiring ---------------------------------------------------------------

ui.connect.onclick = connect;
ui.reconnect.onclick = reconnect;
ui.disconnect.onclick = disconnect;
ui.refresh.onclick = refresh;
ui.search.oninput = render;
ui.pick.onclick = (e) => { e.stopPropagation(); ui.fileInput.click(); };
ui.drop.onclick = () => ui.fileInput.click();
ui.fileInput.onchange = () => addFiles(ui.fileInput.files).finally(() => { ui.fileInput.value = ''; });

ui.format.value = prefs.get('format', 'kfx');
ui.format.onchange = () => prefs.set('format', ui.format.value);

// Drop anywhere on the page once connected.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!kindle || !hasFiles(e)) return;
  dragDepth++;
  ui.drop.classList.add('over');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; ui.drop.classList.remove('over'); }
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  ui.drop.classList.remove('over');
  if (kindle) addFiles(e.dataTransfer.files);
  else toast("Fais d'abord l'étape 1 : choisir ta Kindle.", true);
});

// Start
if (!supported()) {
  ui.unsupported.hidden = false;
  ui.connect.disabled = true;
} else {
  const handle = await kvGet('device');
  if (handle && await permitted(handle, false).catch(() => false)) {
    useHandle(handle).catch(() => showReconnect());
  } else {
    showReconnect();
  }
}

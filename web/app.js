import * as engine from './engine.js';
import { retitle } from './epub.js';
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
  replaceInput: $('replace-input'),
  format: $('format'),
  queue: $('queue'),
  count: $('count'),
  search: $('search'),
  refresh: $('refresh'),
  shelf: $('shelf'),
  empty: $('empty'),
  toast: $('toast'),
  renameDialog: $('rename-dialog'),
  renameForm: $('rename-form'),
  renameHint: $('rename-hint'),
  renameAuthorRow: $('rename-author-row'),
  confirmDialog: $('confirm-dialog'),
  confirmTitle: $('confirm-title'),
  confirmText: $('confirm-text'),
  confirmOk: $('confirm-ok'),
};

/** Formats the Kindle reads natively, copied as is. */
const NATIVE = new Set(['kfx', 'azw3', 'azw', 'mobi', 'prc', 'pdf', 'txt']);
/** Formats whose title lives inside the file (renamed through a conversion). */
const EMBEDDED_META = new Set(['kfx', 'azw3', 'azw', 'mobi', 'prc', 'epub']);

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

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`;
}

let toastTimer;
function toast(message, isError = false) {
  ui.toast.textContent = message;
  ui.toast.classList.toggle('error', isError);
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, isError ? 7000 : 3500);
}

function errorText(e) {
  if (e?.name === 'NotAllowedError') return "Accès refusé à la Kindle. Reconnecte-la et autorise la modification.";
  if (e?.name === 'NotFoundError') return 'La Kindle semble débranchée. Rebranche-la puis reconnecte-la.';
  if (e?.name === 'QuotaExceededError') return "Plus assez de place sur la Kindle.";
  return e?.message || String(e);
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

function askTitle(book) {
  const meta = metaCache.get(book.path);
  const embedded = EMBEDDED_META.has(book.ext);
  const fields = ui.renameForm.elements;
  fields.title.value = meta?.title || stem(book.name);
  fields.author.value = meta?.authors?.join(', ') || '';
  ui.renameAuthorRow.hidden = !embedded;
  ui.renameHint.textContent = embedded
    ? 'Le titre et l’auteur affichés sur la Kindle seront modifiés.'
    : 'Le nom du fichier sera modifié (c’est lui que la Kindle affiche).';
  ui.renameDialog.returnValue = '';
  ui.renameDialog.showModal();
  fields.title.select();
  return new Promise((resolve) => {
    ui.renameDialog.addEventListener('close', () => {
      if (ui.renameDialog.returnValue !== 'ok') return resolve(null);
      resolve({ title: fields.title.value.trim(), author: fields.author.value.trim() });
    }, { once: true });
  });
}

function pickFile(input) {
  input.value = '';
  return new Promise((resolve) => {
    const done = () => resolve(input.files?.[0] ?? null);
    input.addEventListener('change', done, { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
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
    if (!(await permitted(handle, true))) return toast('Autorisation refusée.', true);
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
    ui.reconnect.classList.add('primary');
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
  ui.count.append('Bibliothèque');
  const small = document.createElement('small');
  small.textContent = `${books.length} livre${books.length > 1 ? 's' : ''}`;
  ui.count.append(small);
  ui.empty.hidden = books.length > 0;
  ui.shelf.replaceChildren(...shown.map(card));
}

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
      <span class="badge"></span>
      <div class="placeholder"><b></b><small></small></div>
    </div>
    <div>
      <p class="title"></p>
      <p class="author"></p>
      <span class="meta"></span>
    </div>
    <div class="acts">
      <button class="link convert" type="button" hidden>Convertir</button>
      <button class="link rename" type="button">Renommer</button>
      <button class="link replace" type="button">Remplacer</button>
      <button class="link del" type="button">Supprimer</button>
    </div>`;
  const badge = li.querySelector('.badge');
  badge.textContent = book.ext;
  if (book.ext === 'epub') {
    badge.classList.add('warn');
    badge.title = 'La Kindle ne lit pas les EPUB copiés en USB';
    li.querySelector('.convert').hidden = false;
  }
  li.querySelector('.placeholder').style.setProperty('--ph', PALETTE[hash(book.name) % PALETTE.length]);
  li.querySelector('.meta').textContent = `${formatSize(book.size)} · ${new Date(book.modified).toLocaleDateString('fr-FR')}`;
  li.querySelector('.convert').onclick = () => convertInPlace(book);
  li.querySelector('.rename').onclick = () => rename(book);
  li.querySelector('.replace').onclick = () => replace(book);
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

/**
 * Converts (if needed) and writes one book to the Kindle.
 * `replacing`: the book this one takes the place of, removed once the new one is ready.
 */
async function install({ data, ext, fileName, replacing = null, meta = null, report }) {
  const target = ui.format.value;
  let out = data;
  let outExt = ext;
  let info = null;

  if (ext === 'epub' || meta) {
    let epub = data;
    if (ext !== 'epub') {
      report.step('Lecture…');
      epub = await engine.convert(data, ext, 'epub');
    }
    if (meta) epub = retitle(epub, { title: meta.title, author: meta.author });
    info = await engine.inspect(epub, 'epub');
    // A renamed KFX or AZW3 keeps its format; the rest goes to the chosen one.
    outExt = meta && (ext === 'kfx' || ext === 'azw3') ? ext : target;
    report.step(`Conversion en ${outExt.toUpperCase()}…`);
    try {
      out = await engine.convert(epub, 'epub', outExt);
    } catch (e) {
      if (outExt !== 'kfx') throw e;
      report.step('KFX impossible, conversion en AZW3…');
      outExt = 'azw3';
      out = await engine.convert(epub, 'epub', 'azw3');
    }
    data = epub;
  } else if (!NATIVE.has(ext)) {
    throw new Error('Format non pris en charge');
  }

  const base = info
    ? [info.title || stem(fileName), info.authors.join(', ')].filter(Boolean).join(' - ')
    : meta?.title || stem(fileName);
  const name = safeFileName(base, outExt);
  const dir = replacing?.dir ?? kindle.documents;
  let overwritten = null;

  if (replacing?.name !== name && await kindle.exists(dir, name)) {
    const existing = books.find((b) => b.dir === dir && b.name === name);
    const ok = await confirmAction({
      title: 'Ce livre existe déjà',
      text: `« ${name} » est déjà sur la Kindle. Le remplacer ?`,
      ok: 'Remplacer',
    });
    if (!ok) return 'skipped';
    overwritten = existing;
  }

  report.step('Copie sur la Kindle…');
  await kindle.write(dir, name, out);
  // Written first, so a failed copy never loses the old book.
  if (overwritten) await kindle.removeBook(overwritten, { keepFile: true });
  if (replacing) await kindle.removeBook(replacing, { keepFile: replacing.name === name });

  const manifest = await kindle.manifest();
  const entry = { added: new Date().toISOString() };
  if (outExt === 'kfx' && info?.has_cover) {
    const cover = await thumbnail(await engine.cover(data, 'epub'), 330, 500);
    if (cover) {
      entry.thumbnail = await kindle.writeThumbnail(info.kfx_content_id, cover);
    }
  }
  const prefix = dir === kindle.documents ? '' : replacing.path.slice(0, -replacing.name.length);
  manifest.books[`${prefix}${name}`] = entry;
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
      report.fail('Format non pris en charge (EPUB, KFX, AZW3, MOBI, PDF, TXT)');
      continue;
    }
    try {
      report.step('Lecture…');
      const data = new Uint8Array(await file.arrayBuffer());
      const result = await install({ data, ext, fileName: file.name, report });
      if (result === 'skipped') report.done('Ignoré');
      else {
        report.done(ext === result ? 'Copié' : `Ajouté en ${result.toUpperCase()}`);
        added++;
      }
    } catch (e) {
      report.fail(errorText(e));
    }
  }
  if (added) toast(`${added} livre${added > 1 ? 's' : ''} ajouté${added > 1 ? 's' : ''}. Pense à éjecter la Kindle.`);
  await refresh();
}

async function remove(book) {
  const title = metaCache.get(book.path)?.title || stem(book.name);
  const ok = await confirmAction({
    title: 'Supprimer ce livre ?',
    text: `« ${title} » sera effacé de la Kindle, avec sa position de lecture et ses notes.`,
    ok: 'Supprimer',
  });
  if (!ok) return;
  setBusy(book, true);
  try {
    await kindle.removeBook(book);
    toast('Livre supprimé.');
  } catch (e) {
    toast(errorText(e), true);
  }
  await refresh();
}

async function rename(book) {
  const answer = await askTitle(book);
  if (!answer?.title) return;
  setBusy(book, true);
  const report = job(`Renommer : ${answer.title}`);
  try {
    if (EMBEDDED_META.has(book.ext)) {
      const data = await kindle.read(book);
      await install({ data, ext: book.ext, fileName: book.name, replacing: book, meta: answer, report });
    } else {
      const name = safeFileName(answer.title, book.ext);
      if (name !== book.name) {
        if (await kindle.exists(book.dir, name)) throw new Error(`« ${name} » existe déjà.`);
        report.step('Copie…');
        await kindle.write(book.dir, name, await book.handle.getFile());
        await kindle.removeBook(book);
      }
    }
    report.done('Renommé');
  } catch (e) {
    report.fail(errorText(e));
  }
  await refresh();
}

async function replace(book) {
  const file = await pickFile(ui.replaceInput);
  if (!file) return;
  const report = job(`Remplacer par ${file.name}`);
  setBusy(book, true);
  try {
    const ext = extOf(file.name);
    const data = new Uint8Array(await file.arrayBuffer());
    const result = await install({ data, ext, fileName: file.name, replacing: book, report });
    report.done(result === 'skipped' ? 'Ignoré' : 'Remplacé');
  } catch (e) {
    report.fail(errorText(e));
  }
  await refresh();
}

/** An EPUB copied by hand: convert it and swap it for the Kindle version. */
async function convertInPlace(book) {
  const report = job(`Convertir ${book.name}`);
  setBusy(book, true);
  try {
    const data = await kindle.read(book);
    const result = await install({ data, ext: 'epub', fileName: book.name, replacing: book, report });
    report.done(result === 'skipped' ? 'Ignoré' : `Converti en ${result.toUpperCase()}`);
  } catch (e) {
    report.fail(errorText(e));
  }
  await refresh();
}

// --- Wiring ---------------------------------------------------------------

ui.connect.onclick = connect;
ui.reconnect.onclick = reconnect;
ui.disconnect.onclick = disconnect;
ui.refresh.onclick = refresh;
ui.search.oninput = render;
ui.pick.onclick = (e) => { e.stopPropagation(); ui.fileInput.click(); };
ui.drop.onclick = (e) => {
  if (e.target.closest('select, label')) return;
  ui.fileInput.click();
};
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
  else toast('Connecte d’abord ta Kindle.', true);
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

// Minimal EPUB editing: rewrite the title and author in the OPF package.
import { unzipSync, zipSync } from './vendor/fflate.js';

const DC = 'http://purl.org/dc/elements/1.1/';
const OPF = 'http://www.idpf.org/2007/opf';

const decode = (bytes) => new TextDecoder().decode(bytes);
const encode = (text) => new TextEncoder().encode(text);

function opfPath(files) {
  const container = files['META-INF/container.xml'];
  if (!container) throw new Error('EPUB invalide : container.xml manquant');
  const doc = new DOMParser().parseFromString(decode(container), 'application/xml');
  const path = doc.querySelector('rootfile')?.getAttribute('full-path');
  if (!path || !files[path]) throw new Error('EPUB invalide : fichier OPF introuvable');
  return path;
}

/** Drops every `<meta refines="#id">` attached to a removed element. */
function dropRefinements(metadata, el) {
  const id = el.getAttribute('id');
  if (!id) return;
  for (const meta of [...metadata.getElementsByTagNameNS(OPF, 'meta')]) {
    if (meta.getAttribute('refines') === `#${id}`) meta.remove();
  }
}

function setOnly(doc, metadata, local, value) {
  const existing = [...metadata.getElementsByTagNameNS(DC, local)];
  const keep = existing[0] ?? metadata.appendChild(doc.createElementNS(DC, `dc:${local}`));
  for (const el of existing.slice(1)) {
    dropRefinements(metadata, el);
    el.remove();
  }
  // file-as / title-type refinements would contradict the new value.
  dropRefinements(metadata, keep);
  for (const attr of [...keep.attributes]) {
    if (attr.localName === 'file-as') keep.removeAttributeNode(attr);
  }
  keep.textContent = value;
}

/**
 * Returns a copy of `epub` whose title (and author, when given) are replaced.
 */
export function retitle(epub, { title, author }) {
  const files = unzipSync(epub);
  const path = opfPath(files);
  const doc = new DOMParser().parseFromString(decode(files[path]), 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('EPUB invalide : OPF illisible');
  const metadata = doc.getElementsByTagNameNS(OPF, 'metadata')[0];
  if (!metadata) throw new Error('EPUB invalide : métadonnées absentes');

  setOnly(doc, metadata, 'title', title);
  if (author) setOnly(doc, metadata, 'creator', author);
  files[path] = encode(new XMLSerializer().serializeToString(doc));

  // The mimetype entry must come first and stay uncompressed.
  const out = {};
  if (files.mimetype) out.mimetype = [files.mimetype, { level: 0 }];
  for (const [name, data] of Object.entries(files)) {
    if (name !== 'mimetype') out[name] = data;
  }
  return zipSync(out, { level: 6 });
}

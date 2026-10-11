// Promise API over the conversion worker. One call at a time; the worker is
// recycled after a failure since a Rust panic leaves the wasm instance unusable.

let worker = null;
let seq = 0;
const pending = new Map();
let chain = Promise.resolve();

function spawn() {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.error) p.reject(new Error(data.error));
    else p.resolve(data.result);
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'Le moteur de conversion a planté.'));
    pending.clear();
    worker.terminate();
    worker = null;
  };
}

function call(op, args) {
  const run = () => new Promise((resolve, reject) => {
    if (!worker) spawn();
    const id = ++seq;
    pending.set(id, { resolve, reject });
    // Copy so the caller keeps its buffer.
    worker.postMessage({ id, op, args: { ...args, data: args.data.slice() } });
  }).catch((e) => {
    worker?.terminate();
    worker = null;
    throw e;
  });
  const result = chain.then(run, run);
  chain = result.catch(() => {});
  return result;
}

export const inspect = (data, from) => call('inspect', { data, from });
export const convert = (data, from, to) => call('convert', { data, from, to });
export const cover = (data, from) => call('cover', { data, from });

/** Formats the engine can read. */
export const READABLE = new Set(['epub', 'kfx', 'azw3', 'mobi', 'azw', 'prc']);

// Runs the boko WebAssembly engine off the main thread.
import init, { convert, inspect, cover } from './pkg/kindlemom_core.js';

const ready = init();

self.onmessage = async ({ data: { id, op, args } }) => {
  try {
    await ready;
    let result;
    switch (op) {
      case 'inspect': result = JSON.parse(inspect(args.data, args.from)); break;
      case 'convert': result = convert(args.data, args.from, args.to); break;
      case 'cover': result = cover(args.data, args.from); break;
      default: throw new Error(`opération inconnue : ${op}`);
    }
    self.postMessage({ id, result }, result instanceof Uint8Array ? [result.buffer] : []);
  } catch (e) {
    self.postMessage({ id, error: String(e?.message ?? e) });
  }
};

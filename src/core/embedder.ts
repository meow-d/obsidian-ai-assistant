// @ts-expect-error — esbuild-plugin-inline-worker transforms this into a Worker factory at build time
import EmbedderWorker from "./embedder.worker";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

interface QueuedRequest {
  type: string;
  payload?: Record<string, unknown>;
  priority: number;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, Pending>();
let statusCallback: ((msg: string) => void) | null = null;

export function setEmbedderStatusCallback(cb: ((msg: string) => void) | null): void {
  statusCallback = cb;
}

// The worker can only run one inference call at a time, so requests queue up
// on the main thread instead of being fired at the worker as soon as they're
// made. Higher-priority requests (e.g. the Smart Suggestions sidebar) jump
// ahead of queued lower-priority ones (e.g. background wikilink scanning) -
// though a request already in flight can't be preempted once dispatched.
let inFlight = false;
const queue: QueuedRequest[] = [];

function dispatchNext(): void {
  if (inFlight || queue.length === 0) return;

  let bestIdx = 0;
  for (let i = 1; i < queue.length; i++) {
    if (queue[i].priority > queue[bestIdx].priority) bestIdx = i;
  }
  const [req] = queue.splice(bestIdx, 1);

  inFlight = true;
  const id = nextId++;
  pending.set(id, {
    resolve: (v) => { inFlight = false; req.resolve(v); dispatchNext(); },
    reject: (e) => { inFlight = false; req.reject(e); dispatchNext(); },
  });
  getWorker().postMessage({ id, type: req.type, payload: req.payload });
}

function getWorker(): Worker {
  if (!worker) {
    const w = new EmbedderWorker();
    w.onmessage = (e: MessageEvent) => {
      const data = e.data as { id?: number; result?: unknown; error?: string; type?: string; message?: string };
      if (data.type === "status") {
        statusCallback?.(data.message!);
        return;
      }
      const { id, result, error } = data;
      const p = pending.get(id!);
      if (!p) return;
      pending.delete(id!);
      if (error) p.reject(new Error(error));
      else p.resolve(result);
    };
    w.onerror = (e: ErrorEvent) => {
      if (process.env.NODE_ENV !== "production") console.error("[embedder] worker error", e);
      for (const [id, p] of pending) {
        p.reject(new Error(e.message || "embedder worker crashed"));
        pending.delete(id);
      }
      w.terminate();
      if (worker === w) worker = null;
    };
    worker = w;
    return w;
  }
  return worker;
}

function send<T>(type: string, payload?: Record<string, unknown>, priority = 0): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({ type, payload, priority, resolve: resolve as (v: unknown) => void, reject });
    dispatchNext();
  });
}

export async function initEmbedder(modelPath?: string): Promise<{ vectorSize: number }> {
  return send<{ vectorSize: number }>("loadModel", { modelPath }, 10);
}

/** priority: higher runs first among requests still waiting in the queue (default 0). */
export async function embed(texts: string[], priority = 0): Promise<number[][]> {
  return send<number[][]>("embed", { texts }, priority);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

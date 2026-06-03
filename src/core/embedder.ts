// @ts-expect-error — esbuild-plugin-inline-worker transforms this into a Worker factory at build time
import EmbedderWorker from "./embedder.worker";

interface Pending {
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
    };
    worker = w;
    return w;
  }
  return worker;
}

function send<T>(type: string, payload?: Record<string, unknown>): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    getWorker().postMessage({ id, type, payload });
  });
}

export async function initEmbedder(modelPath?: string): Promise<{ vectorSize: number }> {
  return send<{ vectorSize: number }>("loadModel", { modelPath });
}

export async function embed(texts: string[]): Promise<number[][]> {
  return send<number[][]>("embed", { texts });
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}


import "./force-onnxruntime-web"
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

const DEFAULT_MODEL = "meow-d/mdbr-leaf-ir-obsidian";

let _pipe: FeatureExtractionPipeline | null = null;

async function loadModel(modelPath?: string): Promise<{ vectorSize: number }> {
  if (!_pipe) {
    const id = modelPath || DEFAULT_MODEL;
    const modelName = id.split("/").pop() || id;
    if (process.env.NODE_ENV !== "production") console.log(`[embedder-worker] loading model: ${id}`);
    const t0 = performance.now();
    let pendingDownloads = 0;
    _pipe = await pipeline("feature-extraction", id, {
      device: "auto",
      dtype: "q4",
      progress_callback: (p: { status: string }) => {
        if (p.status === "initiate") {
          pendingDownloads++;
          if (pendingDownloads === 1) self.postMessage({ type: "status", message: `Downloading model: ${modelName}` });
        } else if (p.status === "done") {
          pendingDownloads--;
          if (pendingDownloads === 0) self.postMessage({ type: "status", message: `Loading model: ${modelName}` });
        }
      },
    }) as unknown as FeatureExtractionPipeline;
    if (process.env.NODE_ENV !== "production") console.log(`[embedder-worker] model loaded in ${(performance.now() - t0).toFixed(0)}ms`);
  }

  // determine vector size from a test run
  const tensor = await _pipe("test", { pooling: "mean", normalize: true });
  const vectorSize = tensor.tolist()[0].length;
  return { vectorSize };
}

async function embed(texts: string[]): Promise<number[][]> {
  if (!_pipe) await loadModel();

  const t0 = performance.now();
  const output = await _pipe(texts, { pooling: "mean", normalize: true });
  const elapsed = performance.now() - t0;
  if (process.env.NODE_ENV !== "production") console.log(`[embedder-worker] embed(${texts.length} texts) took ${elapsed.toFixed(0)}ms`);

  return output.tolist() as number[][];
}

self.onmessage = async (e: MessageEvent) => {
  const { id, type, payload } = e.data;

  try {
    let result: any;
    if (type === "loadModel") result = await loadModel(payload?.modelPath);
    else if (type === "embed") result = await embed(payload.texts);
    else throw new Error(`Unknown message type: ${type}`);
    self.postMessage({ id, result });

  } catch (err: any) {
    self.postMessage({ id, error: err?.message ?? String(err) });
  }
};

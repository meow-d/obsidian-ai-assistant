// forces transformers.js to use onnxruntime-web rather than onnxruntime-node
// for some reason it can't run onnxruntime-node, likely because the bundler

// has to be its own file imported before transformers.js, if we put this before the import it'll run after the import
Object.defineProperty(globalThis, "process", { get: () => undefined, configurable: true });

// function transformers.js uses to decide
// https://github.com/huggingface/transformers.js/blob/d319c3d059662463c4a2181f2c77b6e2e3bb813a/packages/transformers/src/env.js#L44



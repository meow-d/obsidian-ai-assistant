import { defineConfig } from "vitest/config";
import path from "path";

const noop = path.resolve(__dirname, "src/__mocks__/noop.ts");

export default defineConfig({
  resolve: {
    alias: {
      obsidian: path.resolve(__dirname, "src/__mocks__/obsidian.ts"),
      // Prevent force-onnxruntime-web from clobbering `process` in Node tests
      "./force-onnxruntime-web": noop,
      // Worker module uses `self` which doesn't exist in Node; noop it so
      // tests that only import embedder.ts for cosine/etc. don't crash
      "./embedder.worker": noop,
    },
  },
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    environment: "node",
    server: {
      deps: {
        // wink packages ship CJS; inline them so Vite can process them
        inline: ["wink-nlp", "wink-eng-lite-web-model"],
      },
    },
  },
});

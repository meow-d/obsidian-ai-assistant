import { describe, it, expect } from "vitest";
import { cosine, pickHighestPriorityIndex } from "../core/embedder";

describe("cosine", () => {
  it("returns 1 for identical unit vectors", () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosine([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
  });

  it("returns -1 for opposite unit vectors", () => {
    expect(cosine([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1);
  });

  it("returns 0 for zero vector", () => {
    expect(cosine([0, 0, 0], [1, 0, 0])).toBe(0);
  });

  it("returns 0 when the stored vector is empty", () => {
    expect(cosine([0.6, 0.8], [])).toBe(0);
  });

  it("returns 0 when the dimensions do not match", () => {
    expect(cosine([1, 0, 0], [1, 0])).toBe(0);
  });

  it("computes dot product for normalized multi-dim vectors", () => {
    // 0.6² + 0.8² = 1 - already unit length
    const a = [0.6, 0.8];
    const b = [0.8, 0.6];
    expect(cosine(a, b)).toBeCloseTo(0.6 * 0.8 + 0.8 * 0.6);
  });
});

describe("pickHighestPriorityIndex", () => {
  it("picks the highest priority item", () => {
    const items = [{ priority: 0 }, { priority: 10 }, { priority: 5 }];
    expect(pickHighestPriorityIndex(items)).toBe(1);
  });

  it("breaks ties by earliest index (FIFO)", () => {
    const items = [{ priority: 5 }, { priority: 5 }, { priority: 5 }];
    expect(pickHighestPriorityIndex(items)).toBe(0);
  });

  it("returns 0 for a single item", () => {
    expect(pickHighestPriorityIndex([{ priority: 3 }])).toBe(0);
  });

  it("handles negative priorities", () => {
    const items = [{ priority: -5 }, { priority: -1 }, { priority: -10 }];
    expect(pickHighestPriorityIndex(items)).toBe(1);
  });
});

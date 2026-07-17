import { describe, it, expect } from "vitest";
import { BallTree } from "../core/ball-tree";

function dist(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

function bruteForceRadiusQuery(points: number[][], queryIndex: number, eps: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < points.length; i++) {
    if (i !== queryIndex && dist(points[queryIndex], points[i]) <= eps) out.push(i);
  }
  return out;
}

function randomPoints(n: number, dim: number, seed = 1): number[][] {
  // simple deterministic PRNG so failures are reproducible
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  return Array.from({ length: n }, () => Array.from({ length: dim }, () => rand() * 2 - 1));
}

describe("BallTree", () => {
  it("matches brute-force radius query results on random points", () => {
    const points = randomPoints(200, 16);
    const tree = new BallTree(points);

    for (const eps of [0.1, 0.5, 1.0, 2.0]) {
      for (let i = 0; i < points.length; i += 17) {
        const expected = bruteForceRadiusQuery(points, i, eps).sort((a, b) => a - b);
        const actual = tree.radiusQueryByIndex(i, eps).sort((a, b) => a - b);
        expect(actual).toEqual(expected);
      }
    }
  });

  it("handles a single point", () => {
    const tree = new BallTree([[0, 0]]);
    expect(tree.radiusQueryByIndex(0, 1)).toEqual([]);
  });

  it("handles duplicate points without infinite recursion", () => {
    const points = Array.from({ length: 20 }, () => [1, 2, 3]);
    const tree = new BallTree(points);
    const result = tree.radiusQueryByIndex(0, 0.001);
    expect(result.length).toBe(19);
  });

  it("excludes the query point itself even at distance 0", () => {
    const points = [[0, 0], [0, 0], [5, 5]];
    const tree = new BallTree(points);
    expect(tree.radiusQueryByIndex(0, 0)).toEqual([1]);
  });
});

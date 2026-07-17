/**
 * Ball tree for fast radius queries (find all points within eps of a point).
 * Same structure scikit-learn's DBSCAN uses by default.
 *
 * Needs a true metric (triangle inequality). Euclidean distance works;
 * `1 - cosine` does not. For unit vectors, ||a-b|| = sqrt(2 - 2*cos(a,b)),
 * so convert cosine distance to Euclidean before using this.
 */

const LEAF_SIZE = 8;

interface LeafNode {
  center: number[];
  radius: number;
  indices: number[];
}

interface SplitNode {
  center: number[];
  radius: number;
  left: BallTreeNode;
  right: BallTreeNode;
}

type BallTreeNode = LeafNode | SplitNode;

function isLeaf(node: BallTreeNode): node is LeafNode {
  return "indices" in node;
}

function distSq(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum;
}

function dist(a: number[], b: number[]): number {
  return Math.sqrt(distSq(a, b));
}

function centroid(points: number[][], indices: number[]): number[] {
  const dim = points[indices[0]].length;
  const c = new Array(dim).fill(0);
  for (const i of indices) {
    const p = points[i];
    for (let d = 0; d < dim; d++) c[d] += p[d];
  }
  for (let d = 0; d < dim; d++) c[d] /= indices.length;
  return c;
}

function boundingRadius(points: number[][], indices: number[], center: number[]): number {
  let radius = 0;
  for (const i of indices) radius = Math.max(radius, dist(center, points[i]));
  return radius;
}

function build(points: number[][], indices: number[]): BallTreeNode {
  const center = centroid(points, indices);
  const radius = boundingRadius(points, indices, center);

  if (indices.length <= LEAF_SIZE) {
    return { center, radius, indices };
  }

  // Split by nearest of two far-apart pivots.
  const p0 = points[indices[0]];
  let pivotA = indices[0];
  let maxDA = -1;
  for (const i of indices) {
    const d = distSq(p0, points[i]);
    if (d > maxDA) { maxDA = d; pivotA = i; }
  }
  let pivotB = pivotA;
  let maxDB = -1;
  for (const i of indices) {
    const d = distSq(points[pivotA], points[i]);
    if (d > maxDB) { maxDB = d; pivotB = i; }
  }

  const left: number[] = [];
  const right: number[] = [];
  for (const i of indices) {
    const dA = distSq(points[pivotA], points[i]);
    const dB = distSq(points[pivotB], points[i]);
    (dA <= dB ? left : right).push(i);
  }

  // All points tied between pivots (e.g. duplicates): split evenly instead.
  if (left.length === 0 || right.length === 0) {
    const mid = Math.floor(indices.length / 2);
    return {
      center,
      radius,
      left: build(points, indices.slice(0, mid)),
      right: build(points, indices.slice(mid)),
    };
  }

  return { center, radius, left: build(points, left), right: build(points, right) };
}

function search(node: BallTreeNode, points: number[][], query: number[], eps: number, exclude: number, out: number[]): void {
  if (dist(query, node.center) - node.radius > eps) return;

  if (isLeaf(node)) {
    for (const i of node.indices) {
      if (i !== exclude && dist(query, points[i]) <= eps) out.push(i);
    }
    return;
  }

  search(node.left, points, query, eps, exclude, out);
  search(node.right, points, query, eps, exclude, out);
}

export class BallTree {
  private root: BallTreeNode;

  constructor(private points: number[][]) {
    if (points.length === 0) throw new Error("BallTree requires at least one point");
    this.root = build(points, points.map((_, i) => i));
  }

  /** Returns indices of all points within `eps` of `points[queryIndex]`, excluding itself. */
  radiusQueryByIndex(queryIndex: number, eps: number): number[] {
    const out: number[] = [];
    search(this.root, this.points, this.points[queryIndex], eps, queryIndex, out);
    return out;
  }
}

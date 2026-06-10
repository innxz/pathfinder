import type { RoadGraph } from "./graph.js";
import type { Vec3 } from "./types.js";

class MinHeap {
  private readonly keys: Uint32Array;
  private readonly values: Float32Array;
  private size = 0;

  constructor(capacity: number) {
    this.keys = new Uint32Array(capacity);
    this.values = new Float32Array(capacity);
  }

  push(key: number, value: number): void {
    let i = this.size++;
    this.keys[i] = key;
    this.values[i] = value;

    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.values[parent]! <= this.values[i]!) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  pop(): { key: number; value: number } | null {
    if (this.size === 0) return null;

    const key = this.keys[0]!;
    const value = this.values[0]!;
    const last = --this.size;
    this.keys[0] = this.keys[last]!;
    this.values[0] = this.values[last]!;

    let i = 0;
    while (true) {
      const left = i * 2 + 1;
      const right = left + 1;
      let smallest = i;

      if (left < this.size && this.values[left]! < this.values[smallest]!) smallest = left;
      if (right < this.size && this.values[right]! < this.values[smallest]!) smallest = right;
      if (smallest === i) break;

      this.swap(i, smallest);
      i = smallest;
    }

    return { key, value };
  }

  private swap(a: number, b: number): void {
    const tmpKey = this.keys[a]!;
    const tmpVal = this.values[a]!;
    this.keys[a] = this.keys[b]!;
    this.values[a] = this.values[b]!;
    this.keys[b] = tmpKey;
    this.values[b] = tmpVal;
  }
}

export interface PathResult {
  distance: number;
  pathNodes: number;
  nodeIndices: number[];
  fromNode: number;
  toNode: number;
}

function reconstructPath(parent: Int32Array, toNode: number): number[] {
  const nodes: number[] = [];
  let cur = toNode;
  while (cur !== -1) {
    nodes.push(cur);
    cur = parent[cur]!;
  }
  nodes.reverse();
  return nodes;
}

function minHeuristicToGoals(graph: RoadGraph, node: number, goals: Vec3[]): number {
  const pos = graph.getPosition(node);
  let best = Infinity;
  for (const goal of goals) {
    const h = Math.hypot(pos.x - goal.x, pos.y - goal.y, pos.z - goal.z);
    if (h < best) best = h;
  }
  return best;
}

export function findRouteBetweenPoints(graph: RoadGraph, from: Vec3, to: Vec3): PathResult | null {
  const starts = graph.findNearestCandidates(from.x, from.y, from.z);
  const goals = graph.findNearestCandidates(to.x, to.y, to.z);

  if (starts.length === 0 || goals.length === 0) {
    return null;
  }

  const goalNodes = new Set(goals.map((candidate) => candidate.index));
  const goalPositions = goals.map((candidate) => graph.getPosition(candidate.index));

  if (starts.length === 1 && goals.length === 1 && starts[0]!.index === goals[0]!.index) {
    const node = starts[0]!.index;
    return {
      distance: graph.snapCost(from.x, from.y, from.z, node) + graph.snapCost(to.x, to.y, to.z, node),
      pathNodes: 1,
      nodeIndices: [node],
      fromNode: node,
      toNode: node,
    };
  }

  const nodeCount = graph.nodeCount;
  const gScore = new Float32Array(nodeCount);
  gScore.fill(Number.POSITIVE_INFINITY);

  const parent = new Int32Array(nodeCount);
  parent.fill(-1);

  const closed = new Uint8Array(nodeCount);
  const heap = new MinHeap(nodeCount);

  for (const start of starts) {
    gScore[start.index] = start.cost;
    heap.push(start.index, start.cost + minHeuristicToGoals(graph, start.index, goalPositions));
  }

  let bestGoal = -1;

  while (true) {
    const current = heap.pop();
    if (!current) break;

    const node = current.key;
    if (closed[node]) continue;

    if (goalNodes.has(node)) {
      bestGoal = node;
      break;
    }

    closed[node] = 1;

    const range = graph.getNeighborRange(node);
    for (let edge = range.start; edge < range.end; edge++) {
      const neighbor = graph.getNeighbor(edge);
      if (closed[neighbor]) continue;

      const tentative = gScore[node]! + graph.getWeight(edge);
      if (tentative >= gScore[neighbor]!) continue;

      gScore[neighbor] = tentative;
      parent[neighbor] = node;
      heap.push(neighbor, tentative + minHeuristicToGoals(graph, neighbor, goalPositions));
    }
  }

  if (bestGoal < 0) {
    return null;
  }

  const exitSnap = graph.snapCost(to.x, to.y, to.z, bestGoal);
  const nodeIndices = reconstructPath(parent, bestGoal);

  return {
    distance: gScore[bestGoal]! + exitSnap,
    pathNodes: nodeIndices.length,
    nodeIndices,
    fromNode: nodeIndices[0]!,
    toNode: bestGoal,
  };
}

export function findPath(graph: RoadGraph, fromNode: number, toNode: number): PathResult | null {
  return findRouteBetweenPoints(graph, graph.getPosition(fromNode), graph.getPosition(toNode));
}

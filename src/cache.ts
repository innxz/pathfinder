import type { PathResult } from "./pathfinder.js";
import type { Vec3 } from "./types.js";

export interface CachedPath extends PathResult {}

function routeKey(from: Vec3, to: Vec3): string {
  return [
    from.x.toFixed(1),
    from.y.toFixed(1),
    from.z.toFixed(1),
    to.x.toFixed(1),
    to.y.toFixed(1),
    to.z.toFixed(1),
  ].join(":");
}

export class RouteCache {
  private readonly maxSize: number;
  private readonly map = new Map<string, CachedPath>();

  constructor(maxSize = 10_000) {
    this.maxSize = Math.max(1, maxSize);
  }

  get(from: Vec3, to: Vec3): CachedPath | undefined {
    const key = routeKey(from, to);
    const hit = this.map.get(key);
    if (!hit) return undefined;

    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  set(from: Vec3, to: Vec3, value: PathResult): void {
    const key = routeKey(from, to);

    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest) this.map.delete(oldest);
    }

    this.map.set(key, value);
  }

  get size(): number {
    return this.map.size;
  }
}

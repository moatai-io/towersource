export interface ByteBudgetLruOptions<K, V> {
  maxBytes: number;
  maxEntries?: number;
  estimateSize: (value: V, key: K) => number;
}

/**
 * In-memory LRU with both byte and entry ceilings.
 *
 * Oversized values are not cached: retaining one item larger than the entire
 * budget would make the ceiling meaningless. Callers still keep their active
 * value in their primary store; this cache only accelerates revisits.
 */
export class ByteBudgetLru<K, V> {
  private readonly entries = new Map<K, { value: V; bytes: number }>();
  private totalBytesValue = 0;

  constructor(private readonly options: ByteBudgetLruOptions<K, V>) {
    if (!Number.isFinite(options.maxBytes) || options.maxBytes <= 0) {
      throw new Error('ByteBudgetLru maxBytes must be greater than zero');
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get totalBytes(): number {
    return this.totalBytesValue;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, protectedKey?: K | null): this {
    const bytes = Math.max(0, Math.ceil(this.options.estimateSize(value, key)));
    this.delete(key);
    if (!Number.isFinite(bytes) || bytes > this.options.maxBytes) return this;

    this.entries.set(key, { value, bytes });
    this.totalBytesValue += bytes;
    this.evict(protectedKey ?? key);
    return this;
  }

  delete(key: K): boolean {
    const existing = this.entries.get(key);
    if (!existing) return false;
    this.totalBytesValue -= existing.bytes;
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.totalBytesValue = 0;
  }

  keys(): IterableIterator<K> {
    return this.entries.keys();
  }

  private overBudget(): boolean {
    return this.totalBytesValue > this.options.maxBytes
      || (this.options.maxEntries !== undefined && this.entries.size > this.options.maxEntries);
  }

  private evict(protectedKey: K): void {
    while (this.overBudget() && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      if (Object.is(oldest, protectedKey)) {
        const protectedEntry = this.entries.get(oldest);
        if (!protectedEntry) break;
        this.entries.delete(oldest);
        this.entries.set(oldest, protectedEntry);
        continue;
      }
      this.delete(oldest);
    }
  }
}

export interface CacheEntry {
  body: string;
  status: number;
  headers: Record<string, string>;
  cachedAt: number;
}

export interface CacheStore {
  get(key: string): CacheEntry | undefined;
  set(key: string, entry: CacheEntry): void;
  delete(key: string): void;
}

export class MapCacheStore implements CacheStore {
  private store = new Map<string, CacheEntry>();
  get(key: string) { return this.store.get(key); }
  set(key: string, entry: CacheEntry) { this.store.set(key, entry); }
  delete(key: string) { this.store.delete(key); }
}
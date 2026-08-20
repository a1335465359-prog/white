// Safe server-side in-memory API key store.
// Keys are never written to disk, database, or config files.

const globalForApiKey = globalThis as typeof globalThis & {
  __apiKey?: string;
};

export function setApiKey(key: string): void {
  globalForApiKey.__apiKey = key;
}

export function getApiKey(): string | undefined {
  return globalForApiKey.__apiKey;
}

export function hasApiKey(): boolean {
  return !!globalForApiKey.__apiKey && globalForApiKey.__apiKey.trim().length > 0;
}

export function clearApiKey(): void {
  globalForApiKey.__apiKey = undefined;
}

export const CACHE_SCHEMA_VERSION = 2;

export interface CacheStats {
  filesTotal: number;
  filesCached: number;
  filesParsed: number;
  durationMs: number;
}

export interface CacheManifest {
  schemaVersion: number;
  projectFingerprint: string;
  /** relativePath → content hash */
  files: Record<string, string>;
}

export interface CachedParsedFile {
  hash: string;
  data: {
    file: string;
    imports: unknown[];
    exports: unknown[];
    symbols: unknown;
    complexity: number;
  };
}

/** File connections inferred from repository source. */
export interface ExportNode {
  id: string;
  file: string;
  name: string;
  fanIn: number;
  fanOut: number;
  isEntryPoint: boolean;
}

export interface ExportGraph {
  analysisVersion?: number;
  warnings?: string[];
  nodes: Map<string, ExportNode>;
  /** edges[importer] contains the repo-relative files it imports. */
  edges: Map<string, Set<string>>;
}

export type CloneError =
  | 'INVALID_URL'
  | 'CLONE_FAILED'
  | 'SIZE_EXCEEDED'
  | 'REPO_UNAVAILABLE'
  | 'CLONE_TIMEOUT'
  | 'NETWORK_ERROR'
  | 'GIT_UNAVAILABLE'
  | 'CHECKOUT_FAILED';

export type CloneResult = { ok: true; path: string } | { ok: false; error: CloneError };

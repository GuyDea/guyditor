export interface ContextRequestGate {
  contextKey: string | null;
  generation: number;
}

export interface ContextRequest {
  contextKey: string;
  generation: number;
}

export function deliverableContextKey(
  projectPath: string,
  deliverableId: string,
): string {
  return JSON.stringify([projectPath, deliverableId]);
}

export function createContextRequestGate(): ContextRequestGate {
  return { contextKey: null, generation: 0 };
}

export function beginContextRequest(
  gate: ContextRequestGate,
  contextKey: string,
): ContextRequest {
  gate.generation += 1;
  gate.contextKey = contextKey;
  return { contextKey, generation: gate.generation };
}

export function invalidateContextRequests(gate: ContextRequestGate): void {
  gate.generation += 1;
  gate.contextKey = null;
}

export function isContextRequestCurrent(
  gate: ContextRequestGate,
  request: ContextRequest,
  currentContextKey: string | null,
): boolean {
  return isContextRequestLatest(gate, request) &&
    request.contextKey === currentContextKey;
}

export function isContextRequestLatest(
  gate: ContextRequestGate,
  request: ContextRequest,
): boolean {
  return request.generation === gate.generation;
}

export function claimContextResponse(
  gate: ContextRequestGate,
  request: ContextRequest,
  contextKey: string,
): boolean {
  if (isContextRequestCurrent(gate, request, contextKey)) return true;
  if (gate.contextKey === contextKey) return false;
  beginContextRequest(gate, contextKey);
  return true;
}

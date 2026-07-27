export interface ContextRequestGate {
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
  return { generation: 0 };
}

export function beginContextRequest(
  gate: ContextRequestGate,
  contextKey: string,
): ContextRequest {
  gate.generation += 1;
  return { contextKey, generation: gate.generation };
}

export function invalidateContextRequests(gate: ContextRequestGate): void {
  gate.generation += 1;
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

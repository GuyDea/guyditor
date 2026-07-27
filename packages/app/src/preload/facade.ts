import type {
  GdEvent,
  GdEventKind,
  GdEventOfKind,
  GuyditorApi,
  GuyditorError,
  IpcRequest,
  IpcResponse,
} from "../shared/ipc.js";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

type EventListener = (event: unknown, payload: GdEvent) => void;

export interface FacadeTransport {
  invoke(channel: "gd:rpc", request: IpcRequest): Promise<unknown>;
  on(channel: "gd:evt", listener: EventListener): void;
  pathForFile(file: File): string;
  removeListener(channel: "gd:evt", listener: EventListener): void;
  requestId?: () => string;
}

export class GuyditorRpcError extends Error implements GuyditorError {
  public readonly code: string;
  public readonly affected: string[];
  public readonly acceptedStateChanged: boolean;
  public readonly retry: "safe" | "unsafe" | "none";
  public readonly suggestion?: string;

  public constructor(error: GuyditorError) {
    super(error.message);
    this.name = "GuyditorRpcError";
    this.code = error.code;
    this.affected = [...error.affected];
    this.acceptedStateChanged = error.acceptedStateChanged;
    this.retry = error.retry;
    if (error.suggestion !== undefined) this.suggestion = error.suggestion;
  }
}

function generatedRequestId(): string {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  return `req_${[...bytes].map((byte) => BASE32[byte & 31]).join("")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ipcResponse(value: unknown, requestId: string): IpcResponse {
  if (
    !isRecord(value) || value["v"] !== 1 || value["requestId"] !== requestId ||
    typeof value["ok"] !== "boolean"
  ) {
    throw new TypeError("Main returned an invalid gd:rpc response.");
  }
  return value as unknown as IpcResponse;
}

export function createGuyditorFacade(transport: FacadeTransport): GuyditorApi {
  return Object.freeze({
    async call<Result>(service: IpcRequest["service"], method: string, params: unknown) {
      const requestId = (transport.requestId ?? generatedRequestId)();
      const request: IpcRequest = { v: 1, requestId, service, method, params };
      const response = ipcResponse(await transport.invoke("gd:rpc", request), requestId);
      if (!response.ok) throw new GuyditorRpcError(response.error);
      return response.result as Result;
    },
    on<Kind extends GdEventKind>(
      kind: Kind,
      handler: (event: GdEventOfKind<Kind>) => void,
    ) {
      const listener: EventListener = (_event, payload) => {
        if (payload.kind === kind) handler(payload as GdEventOfKind<Kind>);
      };
      transport.on("gd:evt", listener);
      return () => transport.removeListener("gd:evt", listener);
    },
    pathForFile(file: File) {
      return transport.pathForFile(file);
    },
  });
}

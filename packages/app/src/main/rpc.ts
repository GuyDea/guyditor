import type {
  GuyditorError,
  IpcRequest,
  IpcResponse,
  IpcSurface,
  JsonSchema,
  ServiceName,
} from "../shared/ipc.js";

export type IpcService = Readonly<Record<string, unknown>>;
export type ServiceResolver = (service: ServiceName) => IpcService | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaError(path: string, message: string): string {
  return `${path === "" ? "/" : path} ${message}`;
}

function validateSchema(value: unknown, schema: JsonSchema, path = ""): string[] {
  const errors: string[] = [];
  const type = schema["type"];
  const matchesType =
    type === undefined ||
    (type === "object" && isRecord(value)) ||
    (type === "array" && Array.isArray(value)) ||
    (type === "string" && typeof value === "string") ||
    (type === "number" && typeof value === "number" && Number.isFinite(value)) ||
    (type === "integer" && typeof value === "number" && Number.isSafeInteger(value)) ||
    (type === "boolean" && typeof value === "boolean") ||
    (type === "null" && value === null);
  if (!matchesType) return [schemaError(path, `must be ${String(type)}`)];

  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && !enumValues.some((entry) => Object.is(entry, value))) {
    errors.push(schemaError(path, `must be one of ${enumValues.map(String).join(", ")}`));
  }
  if ("const" in schema && !Object.is(schema["const"], value)) {
    errors.push(schemaError(path, `must equal ${String(schema["const"])}`));
  }
  const oneOf = schema["oneOf"];
  if (Array.isArray(oneOf)) {
    const matches = oneOf.filter((candidate) =>
      isRecord(candidate) && validateSchema(value, candidate).length === 0).length;
    if (matches !== 1) errors.push(schemaError(path, "must match exactly one allowed shape"));
  }
  const anyOf = schema["anyOf"];
  if (Array.isArray(anyOf) && !anyOf.some((candidate) =>
    isRecord(candidate) && validateSchema(value, candidate).length === 0)) {
    errors.push(schemaError(path, "must match an allowed shape"));
  }

  if (typeof value === "string") {
    const pattern = schema["pattern"];
    if (typeof pattern === "string" && !new RegExp(pattern, "u").test(value)) {
      errors.push(schemaError(path, `must match ${pattern}`));
    }
    const minLength = schema["minLength"];
    if (typeof minLength === "number" && value.length < minLength) {
      errors.push(schemaError(path, `must have at least ${String(minLength)} characters`));
    }
  }
  if (typeof value === "number") {
    const minimum = schema["minimum"];
    const maximum = schema["maximum"];
    if (typeof minimum === "number" && value < minimum) {
      errors.push(schemaError(path, `must be at least ${String(minimum)}`));
    }
    if (typeof maximum === "number" && value > maximum) {
      errors.push(schemaError(path, `must be at most ${String(maximum)}`));
    }
  }
  if (Array.isArray(value) && isRecord(schema["items"])) {
    value.forEach((entry, index) => {
      errors.push(...validateSchema(entry, schema["items"] as JsonSchema, `${path}/${String(index)}`));
    });
  }
  if (isRecord(value)) {
    const required = schema["required"];
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === "string" && !(key in value)) {
          errors.push(schemaError(`${path}/${key}`, "is required"));
        }
      }
    }
    const properties = isRecord(schema["properties"])
      ? schema["properties"] as Record<string, unknown>
      : {};
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key];
      if (isRecord(childSchema)) {
        errors.push(...validateSchema(child, childSchema, `${path}/${key}`));
      } else if (schema["additionalProperties"] === false) {
        errors.push(schemaError(`${path}/${key}`, "is not allowed"));
      }
    }
  }
  return errors;
}

function errorEnvelope(
  code: string,
  message: string,
  retry: GuyditorError["retry"] = "none",
): GuyditorError {
  return { code, message, affected: [], acceptedStateChanged: false, retry };
}

function thrownError(error: unknown): GuyditorError {
  if (
    isRecord(error) && typeof error["code"] === "string" &&
    typeof error["message"] === "string" && Array.isArray(error["affected"]) &&
    typeof error["acceptedStateChanged"] === "boolean" &&
    (error["retry"] === "safe" || error["retry"] === "unsafe" || error["retry"] === "none")
  ) {
    return error as unknown as GuyditorError;
  }
  return errorEnvelope(
    "E_IPC_DISPATCH",
    error instanceof Error ? error.message : "The service call failed.",
  );
}

export function createRpcDispatcher(
  surfaces: readonly IpcSurface[],
  resolveService: ServiceResolver,
): (request: IpcRequest) => Promise<IpcResponse> {
  const manifests = new Map(surfaces.map((surface) => [surface.service, surface]));
  return async (request) => {
    const surface = manifests.get(request.service);
    const method = surface?.methods[request.method];
    if (method === undefined) {
      return {
        v: 1,
        requestId: request.requestId,
        ok: false,
        error: errorEnvelope(
          "E_IPC_METHOD",
          `${request.service}.${request.method} is not exposed over IPC.`,
        ),
      };
    }
    const paramsErrors = validateSchema(request.params, method.paramsSchema);
    if (paramsErrors.length > 0) {
      return {
        v: 1,
        requestId: request.requestId,
        ok: false,
        error: errorEnvelope("E_IPC_SCHEMA", paramsErrors.join("; ")),
      };
    }
    const target = resolveService(request.service);
    const implementation = target?.[request.method];
    if (target === undefined || typeof implementation !== "function") {
      return {
        v: 1,
        requestId: request.requestId,
        ok: false,
        error: errorEnvelope("E_IPC_SERVICE_UNAVAILABLE", `${request.service} is unavailable.`),
      };
    }
    try {
      const result = await Reflect.apply(implementation, target, [request.params]) as unknown;
      const resultErrors = validateSchema(result, method.resultSchema);
      if (resultErrors.length > 0) {
        return {
          v: 1,
          requestId: request.requestId,
          ok: false,
          error: errorEnvelope("E_IPC_RESULT_SCHEMA", resultErrors.join("; ")),
        };
      }
      return { v: 1, requestId: request.requestId, ok: true, result };
    } catch (error: unknown) {
      return { v: 1, requestId: request.requestId, ok: false, error: thrownError(error) };
    }
  };
}

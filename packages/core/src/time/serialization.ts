import {
  failure,
  makeGuyditorError,
  success,
} from "../errors.js";
import type { Result } from "../errors.js";
import type { TimeValue } from "./types.js";
import { validateTimeValue } from "./validation.js";

function formatError(message: string): ReturnType<typeof failure> {
  return failure(makeGuyditorError("E_TIME_FORMAT", message));
}

export function serializeTime(time: TimeValue): Result<string> {
  const validated = validateTimeValue(time);
  if (!validated.ok) return validated;
  return success(JSON.stringify(validated.value));
}

export function parseTime(serialized: unknown): Result<TimeValue> {
  if (typeof serialized !== "string") {
    return formatError("Serialized time must be a JSON string.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    return formatError("Serialized time is not valid JSON.");
  }

  const validated = validateTimeValue(parsed);
  if (!validated.ok) return validated;
  if (JSON.stringify(validated.value) !== serialized) {
    return formatError("Serialized time is not in canonical byte form.");
  }
  return success(validated.value);
}

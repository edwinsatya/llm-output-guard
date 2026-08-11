export interface JsonOptions {
  /** Allow the payload to sit inside a ```json fence rather than being bare. */
  allowFence?: boolean;
  /** Top-level keys that must be present for the payload to count as valid. */
  requiredKeys?: string[];
}

export interface JsonResult {
  /** 0 when the payload parses and satisfies requiredKeys, 1 otherwise. */
  score: number;
  /** The parsed value, when parsing succeeded. */
  value?: unknown;
  reason?: 'unparseable' | 'missing-keys';
  missingKeys?: string[];
}

/** Pull a JSON payload out of a ```json fence, or return the text unchanged. */
export function stripFence(text: string): string {
  const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : text.trim();
}

/**
 * Structured-output check. Models that "succeed" while emitting prose around
 * the JSON, or an object missing half its keys, fail here.
 */
export function jsonScore(text: string, options: JsonOptions = {}): JsonResult {
  const { allowFence = true, requiredKeys = [] } = options;
  const candidate = allowFence ? stripFence(text) : text.trim();

  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return { score: 1, reason: 'unparseable' };
  }

  if (requiredKeys.length > 0) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { score: 1, value, reason: 'missing-keys', missingKeys: [...requiredKeys] };
    }
    const record = value as Record<string, unknown>;
    const missing = requiredKeys.filter((k) => !(k in record));
    if (missing.length > 0) {
      return { score: 1, value, reason: 'missing-keys', missingKeys: missing };
    }
  }

  return { score: 0, value };
}

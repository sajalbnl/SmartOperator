export type ProcedureDraft = {
  title: string;
  steps: string[];
  tools: string[];
  safety: string[];
};

const REQUIRED_KEYS = ["safety", "steps", "title", "tools"];

function stringArray(value: unknown, field: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${field} must be ${allowEmpty ? "an" : "a non-empty"} array.`);
  }

  const strings = value.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`${field} must contain only non-empty strings.`);
    }
    return item.trim();
  });

  return strings;
}

export function parseProcedureDraft(raw: string): ProcedureDraft {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch (error) {
    throw new Error(
      `Claude did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Claude response must be a JSON object.");
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== REQUIRED_KEYS.length ||
    keys.some((key, index) => key !== REQUIRED_KEYS[index])
  ) {
    throw new Error(`Claude response must contain exactly: ${REQUIRED_KEYS.join(", ")}.`);
  }

  if (typeof record.title !== "string" || !record.title.trim()) {
    throw new Error("title must be a non-empty string.");
  }

  return {
    title: record.title.trim(),
    steps: stringArray(record.steps, "steps", false),
    tools: stringArray(record.tools, "tools", true),
    safety: stringArray(record.safety, "safety", true),
  };
}

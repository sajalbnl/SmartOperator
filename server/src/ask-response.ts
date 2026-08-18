export type AskModelResponse = {
  answer: string;
  sourceIds: string[];
};

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    return trimmed.slice(objectStart, objectEnd + 1);
  }
  return trimmed;
}

export function parseAskModelResponse(
  raw: string,
  allowedSourceIds: ReadonlySet<string>,
): AskModelResponse {
  let value: unknown;
  try {
    value = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new Error(
      `Claude answer was not valid JSON. Response preview: ${JSON.stringify(raw.slice(0, 500))}`,
    );
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Claude answer must be a JSON object.");
  }

  const record = value as Record<string, unknown>;
  if (typeof record.answer !== "string" || !record.answer.trim()) {
    throw new Error("Claude answer must contain a non-empty answer.");
  }
  if (
    !Array.isArray(record.source_ids) ||
    record.source_ids.some((sourceId) => typeof sourceId !== "string")
  ) {
    throw new Error("Claude answer must contain a source_ids string array.");
  }

  const sourceIds = [...new Set(record.source_ids as string[])];
  const unknownSourceId = sourceIds.find((sourceId) => !allowedSourceIds.has(sourceId));
  if (unknownSourceId) {
    throw new Error(`Claude cited an unavailable source: ${unknownSourceId}.`);
  }
  if (allowedSourceIds.size > 0 && sourceIds.length === 0) {
    throw new Error("Claude did not cite any of the supplied sources.");
  }

  return { answer: record.answer.trim(), sourceIds };
}

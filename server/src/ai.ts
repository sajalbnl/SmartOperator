import { readFile, stat } from "node:fs/promises";
import { requireEnv, responseError } from "../scripts/env.js";
import { parseProcedureDraft, type ProcedureDraft } from "./procedure-draft.js";

const MAX_WHISPER_BYTES = 24 * 1024 * 1024;

type WhisperResponse = {
  text?: unknown;
};

type AnthropicResponse = {
  content?: Array<{ type?: unknown; text?: unknown }>;
};

export async function transcribeAudio(audioPath: string): Promise<string> {
  const audioStat = await stat(audioPath);
  if (audioStat.size > MAX_WHISPER_BYTES) {
    throw new Error(
      `Extracted audio is ${(audioStat.size / (1024 * 1024)).toFixed(1)} MiB; Whisper limit guard is 24 MiB.`,
    );
  }
  const audio = await readFile(audioPath);

  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/mpeg" }), "capture.mp3");
  form.append("model", "whisper-1");
  form.append("response_format", "json");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}` },
    body: form,
  });

  if (!response.ok) {
    throw new Error(`Whisper transcription failed: ${await responseError(response)}`);
  }

  const result = (await response.json()) as WhisperResponse;
  if (typeof result.text !== "string" || !result.text.trim()) {
    throw new Error("Whisper returned an empty transcript.");
  }
  return result.text.trim();
}

async function callClaude(
  transcript: string,
  machineId: string,
  retryReason: string | null,
): Promise<string> {
  const correction = retryReason
    ? `\nYour previous response failed validation: ${retryReason}. Return corrected raw JSON only.`
    : "";
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": requireEnv("ANTHROPIC_API_KEY"),
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_STRUCTURE_MODEL?.trim() || "claude-sonnet-5",
      max_tokens: 1_200,
      system:
        "You turn a factory expert transcript into a concise draft procedure for human review. " +
        "Do not invent facts, tools, or safety requirements. Return raw JSON only: no markdown, " +
        "commentary, or code fences. The JSON must have exactly this shape: " +
        '{"title":string,"steps":string[],"tools":string[],"safety":string[]}.',
      messages: [
        {
          role: "user",
          content:
            `Machine context: ${machineId}\n` +
            `Expert transcript:\n${transcript}\n\n` +
            "Create a useful, faithful draft. Keep steps imperative and preserve the expert's ordering." +
            correction,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Claude structuring failed: ${await responseError(response)}`);
  }

  const result = (await response.json()) as AnthropicResponse;
  const text = result.content
    ?.filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("")
    .trim();
  if (!text) {
    throw new Error("Claude returned no text content.");
  }
  return text;
}

export async function structureTranscript(
  transcript: string,
  machineId: string,
): Promise<ProcedureDraft> {
  let parseError: Error | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await callClaude(transcript, machineId, parseError?.message ?? null);
    try {
      return parseProcedureDraft(raw);
    } catch (error) {
      parseError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new Error(`Claude JSON was invalid after one retry: ${parseError?.message}`);
}

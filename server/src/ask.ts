import { answerQuestion, transcribeAudioBytes } from "./ai.js";
import { HttpError } from "./http-error.js";
import { retrieveDocuments } from "./retrieval.js";

export const ASK_MACHINE_ID = "CNC-042";
const AUDIO_FILENAME = /\.(?:flac|m4a|mp3|mp4|mpeg|mpga|oga|ogg|wav|webm)$/i;

export type AskInput = {
  audio?: {
    bytes: Uint8Array;
    filename: string;
    mimeType: string;
  };
  machineId?: string;
  text?: string;
};

export async function ask(input: AskInput) {
  const machineId = input.machineId?.trim() || ASK_MACHINE_ID;
  if (machineId !== ASK_MACHINE_ID) {
    throw new HttpError(400, `This prototype is scoped to ${ASK_MACHINE_ID}.`);
  }

  const suppliedText = input.text?.trim() || "";
  if (suppliedText && input.audio) {
    throw new HttpError(400, "Send either text or audio, not both.");
  }
  if (!suppliedText && !input.audio) {
    throw new HttpError(400, "Send a non-empty text question or an audio file.");
  }
  if (input.audio && input.audio.bytes.byteLength === 0) {
    throw new HttpError(400, "The audio file is empty.");
  }
  if (
    input.audio &&
    !input.audio.mimeType.toLowerCase().startsWith("audio/") &&
    !AUDIO_FILENAME.test(input.audio.filename)
  ) {
    throw new HttpError(400, "The uploaded file must be audio.");
  }
  if (suppliedText.length > 500) {
    throw new HttpError(400, "text must be at most 500 characters.");
  }

  const question = input.audio
    ? await transcribeAudioBytes(
        input.audio.bytes,
        input.audio.filename,
        input.audio.mimeType,
      )
    : suppliedText;
  const documents = await retrieveDocuments(question, machineId);
  if (documents.length === 0) {
    throw new HttpError(404, "No relevant approved knowledge was found for this question.");
  }

  const result = await answerQuestion(question, machineId, documents);
  const documentsById = new Map(documents.map((document) => [document.id, document]));

  return {
    question,
    answer: result.answer,
    sources: result.sourceIds.map((sourceId) => {
      const document = documentsById.get(sourceId);
      if (!document) {
        throw new Error(`Validated source ${sourceId} was not in retrieved documents.`);
      }
      return {
        type: document.type,
        id: document.id,
        label: document.label,
      };
    }),
  };
}

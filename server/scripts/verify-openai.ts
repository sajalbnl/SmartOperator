import "dotenv/config";
import { requireEnv, responseError } from "./env.js";

const response = await fetch("https://api.openai.com/v1/models/whisper-1", {
  headers: { Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}` },
});

if (!response.ok) {
  throw new Error(`OpenAI verification failed: ${await responseError(response)}`);
}

const model = (await response.json()) as { id?: string };
console.log(`OpenAI key verified; model available: ${model.id ?? "whisper-1"}`);


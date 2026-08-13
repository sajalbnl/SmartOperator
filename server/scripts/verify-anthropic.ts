import "dotenv/config";
import { requireEnv, responseError } from "./env.js";

const response = await fetch("https://api.anthropic.com/v1/models?limit=1", {
  headers: {
    "anthropic-version": "2023-06-01",
    "x-api-key": requireEnv("ANTHROPIC_API_KEY"),
  },
});

if (!response.ok) {
  throw new Error(`Anthropic verification failed: ${await responseError(response)}`);
}

const result = (await response.json()) as { data?: Array<{ id?: string }> };
console.log(`Anthropic key verified; model available: ${result.data?.[0]?.id ?? "unknown"}`);


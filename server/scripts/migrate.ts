import "dotenv/config";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { requireEnv } from "./env.js";

const sql = await readFile(
  new URL("../migrations/001_initial.sql", import.meta.url),
  "utf8",
);
const client = new Client({ connectionString: requireEnv("DATABASE_URL") });

await client.connect();

try {
  await client.query("BEGIN");
  await client.query(sql);
  await client.query("COMMIT");
  console.log("Applied migration 001_initial.sql");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}


import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import { Client } from "pg";
import { requireEnv } from "./env.js";

const migrationsDirectory = new URL("../migrations/", import.meta.url);
const migrationFiles = (await readdir(migrationsDirectory))
  .filter((file) => /^\d+_.+\.sql$/.test(file))
  .sort();
const client = new Client({ connectionString: requireEnv("DATABASE_URL") });

await client.connect();

try {
  for (const file of migrationFiles) {
    const sql = await readFile(new URL(file, migrationsDirectory), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("COMMIT");
      console.log(`Applied migration ${file}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.end();
}

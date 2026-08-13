import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import { basename } from "node:path";
import { Client } from "pg";
import { requireEnv } from "./env.js";

const MACHINE_ID = "CNC-042";
const SOP_FILE = /^SOP-MCH-\d{3}\.md$/;
const seedDirectory = new URL("../../seed/", import.meta.url);

type Sop = {
  code: string;
  title: string;
  body: string;
};

function titleFromMarkdown(code: string, body: string): string {
  const firstLine = body.split("\n", 1)[0]?.trim();
  const match = firstLine?.match(/^#\s+(.+)$/);

  if (!match?.[1]) {
    throw new Error(`${code} must start with a level-one heading.`);
  }

  return match[1].trim();
}

async function loadSops(): Promise<Sop[]> {
  const entries = (await readdir(seedDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && SOP_FILE.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));

  if (entries.length < 8 || entries.length > 12) {
    throw new Error(`Expected 8 to 12 SOP files; found ${entries.length}.`);
  }

  return Promise.all(
    entries.map(async (entry) => {
      const body = `${(await readFile(new URL(entry.name, seedDirectory), "utf8")).trim()}\n`;
      const code = basename(entry.name, ".md");

      return { code, title: titleFromMarkdown(code, body), body };
    }),
  );
}

const sops = await loadSops();

if (process.argv.includes("--dry-run")) {
  for (const sop of sops) {
    console.log(`${sop.code}: ${sop.title}`);
  }
  console.log(`Validated ${sops.length} SOP files; database unchanged.`);
  process.exit(0);
}

const client = new Client({ connectionString: requireEnv("DATABASE_URL") });
await client.connect();

try {
  await client.query("BEGIN");

  for (const sop of sops) {
    await client.query(
      `INSERT INTO sops (machine_id, code, title, body)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO UPDATE
       SET machine_id = EXCLUDED.machine_id,
           title = EXCLUDED.title,
           body = EXCLUDED.body`,
      [MACHINE_ID, sop.code, sop.title, sop.body],
    );
  }

  const result = await client.query<{ count: string }>(
    "SELECT COUNT(*)::TEXT AS count FROM sops WHERE machine_id = $1",
    [MACHINE_ID],
  );

  await client.query("COMMIT");
  console.log(`Seeded ${sops.length} SOPs; ${result.rows[0]?.count ?? "0"} total for ${MACHINE_ID}.`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}


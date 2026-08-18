import "dotenv/config";
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Client } from "pg";
import { requireEnv } from "./env.js";

const allowedArguments = new Set(["--confirm", "--skip-storage"]);
const unknownArguments = process.argv.slice(2).filter((argument) => !allowedArguments.has(argument));
if (unknownArguments.length > 0) {
  throw new Error(`Unknown argument(s): ${unknownArguments.join(", ")}`);
}

const confirmed = process.argv.includes("--confirm");
const skipStorage = process.argv.includes("--skip-storage");
const databaseUrl = requireEnv("DATABASE_URL");
const parsedDatabaseUrl = new URL(databaseUrl);
const databaseLabel = `${parsedDatabaseUrl.hostname}${parsedDatabaseUrl.pathname}`;
const database = new Client({ connectionString: databaseUrl });

type CaptureStorageRow = {
  s3_key: string;
  s3_upload_id: string | null;
};

type Counts = {
  captures: number;
  chunks: number;
  procedures: number;
  sops: number;
  transcripts: number;
};

async function counts(): Promise<Counts> {
  const result = await database.query<Counts>(
    `SELECT
       (SELECT COUNT(*)::INTEGER FROM captures) AS captures,
       (SELECT COUNT(*)::INTEGER FROM chunks) AS chunks,
       (SELECT COUNT(*)::INTEGER FROM transcripts) AS transcripts,
       (SELECT COUNT(*)::INTEGER FROM procedures) AS procedures,
       (SELECT COUNT(*)::INTEGER FROM sops) AS sops`,
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Could not read demo table counts.");
  }
  return row;
}

await database.connect();

try {
  const before = await counts();
  const seed = await database.query<{ code: string }>(
    "SELECT code FROM sops WHERE code = 'SOP-MCH-042'",
  );
  if (!seed.rows[0]) {
    throw new Error("SOP-MCH-042 is missing. Re-seed before resetting the demo database.");
  }

  console.log(`Target database: ${databaseLabel}`);
  console.log(`Current rows: ${JSON.stringify(before)}`);

  if (!confirmed) {
    console.log("Dry run only. Re-run with --confirm to clear demo captures and reset their IDs.");
    process.exitCode = 2;
  } else {
    const storageRows = await database.query<CaptureStorageRow>(
      "SELECT s3_key, s3_upload_id FROM captures ORDER BY id",
    );

    await database.query("BEGIN");
    try {
      await database.query(
        "TRUNCATE TABLE chunks, transcripts, procedures, captures RESTART IDENTITY",
      );
      await database.query("COMMIT");
    } catch (error) {
      await database.query("ROLLBACK");
      throw error;
    }

    const after = await counts();
    if (
      after.captures !== 0 ||
      after.chunks !== 0 ||
      after.transcripts !== 0 ||
      after.procedures !== 0 ||
      after.sops !== before.sops
    ) {
      throw new Error(`Reset verification failed: ${JSON.stringify(after)}`);
    }
    console.log(`Database reset complete: ${JSON.stringify(after)}`);

    if (skipStorage || storageRows.rows.length === 0) {
      console.log(
        skipStorage
          ? "S3 cleanup skipped by request."
          : "No capture objects or multipart uploads needed S3 cleanup.",
      );
    } else {
      const bucket = requireEnv("AWS_S3_BUCKET");
      const storage = new S3Client({ region: requireEnv("AWS_REGION") });
      let warnings = 0;

      for (const row of storageRows.rows) {
        if (row.s3_upload_id) {
          try {
            await storage.send(
              new AbortMultipartUploadCommand({
                Bucket: bucket,
                Key: row.s3_key,
                UploadId: row.s3_upload_id,
              }),
            );
          } catch (error) {
            warnings += 1;
            console.warn(`Could not abort multipart upload for ${row.s3_key}:`, error);
          }
        }

        try {
          await storage.send(new DeleteObjectCommand({ Bucket: bucket, Key: row.s3_key }));
        } catch (error) {
          warnings += 1;
          console.warn(`Could not delete ${row.s3_key}:`, error);
        }
      }

      console.log(
        `S3 cleanup attempted for ${storageRows.rows.length} capture key(s); ${warnings} warning(s).`,
      );
    }
  }
} finally {
  await database.end();
}

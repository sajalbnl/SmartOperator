import "dotenv/config";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomBytes, randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireEnv, responseError } from "./env.js";

const PART_SIZE = 5 * 1024 * 1024;
const PART_COUNT = 6;
const FILE_SIZE = PART_SIZE * PART_COUNT;
const bucket = requireEnv("AWS_S3_BUCKET");
const key = `verification/multipart-${randomUUID()}.bin`;
const filePath = join(tmpdir(), `smartoperator-${randomUUID()}.bin`);
const client = new S3Client({ region: requireEnv("AWS_REGION") });

let uploadId: string | undefined;
let completed = false;

async function generateFile(): Promise<void> {
  const file = await open(filePath, "w");
  const block = randomBytes(1024 * 1024);

  try {
    for (let offset = 0; offset < FILE_SIZE; offset += block.length) {
      await file.write(block, 0, block.length, offset);
    }
  } finally {
    await file.close();
  }
}

try {
  console.log(`Generating ${FILE_SIZE / 1024 / 1024} MiB at ${filePath}`);
  await generateFile();

  const created = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: "application/octet-stream",
    }),
  );
  uploadId = created.UploadId;

  if (!uploadId) {
    throw new Error("S3 did not return an upload ID.");
  }

  const file = await open(filePath, "r");
  const parts: Array<{ ETag: string; PartNumber: number }> = [];

  try {
    for (let index = 0; index < PART_COUNT; index += 1) {
      const partNumber = index + 1;
      const bytes = Buffer.allocUnsafe(PART_SIZE);
      const { bytesRead } = await file.read(bytes, 0, PART_SIZE, index * PART_SIZE);

      if (bytesRead !== PART_SIZE) {
        throw new Error(`Expected ${PART_SIZE} bytes for part ${partNumber}; read ${bytesRead}.`);
      }

      const url = await getSignedUrl(
        client,
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: 15 * 60 },
      );
      const response = await fetch(url, { method: "PUT", body: new Uint8Array(bytes) });

      if (!response.ok) {
        throw new Error(`Part ${partNumber} upload failed: ${await responseError(response)}`);
      }

      const etag = response.headers.get("etag");
      if (!etag) {
        throw new Error(`Part ${partNumber} response did not include an ETag.`);
      }

      parts.push({ ETag: etag, PartNumber: partNumber });
      console.log(`Uploaded part ${partNumber}/${PART_COUNT} (${PART_SIZE / 1024 / 1024} MiB)`);
    }
  } finally {
    await file.close();
  }

  await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }),
  );
  completed = true;

  const object = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  if (object.ContentLength !== FILE_SIZE) {
    throw new Error(`Completed object is ${object.ContentLength ?? "unknown"} bytes; expected ${FILE_SIZE}.`);
  }

  console.log(`Multipart upload completed and verified: s3://${bucket}/${key}`);
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  console.log("Deleted the verification object.");
} catch (error) {
  if (uploadId && !completed) {
    await client
      .send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }))
      .catch(() => undefined);
  }
  throw error;
} finally {
  await unlink(filePath).catch(() => undefined);
}


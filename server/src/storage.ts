import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { requireEnv } from "../scripts/env.js";

const bucket = requireEnv("AWS_S3_BUCKET");
const client = new S3Client({ region: requireEnv("AWS_REGION") });
const PRESIGNED_URL_TTL_SECONDS = 15 * 60;

export async function createMultipartUpload(key: string): Promise<string> {
  const result = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: "application/octet-stream",
    }),
  );

  if (!result.UploadId) {
    throw new Error("S3 did not return an upload ID.");
  }

  return result.UploadId;
}

export function presignPart(
  key: string,
  uploadId: string,
  partNumber: number,
): Promise<string> {
  return getSignedUrl(
    client,
    new UploadPartCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    }),
    { expiresIn: PRESIGNED_URL_TTL_SECONDS },
  );
}

export async function completeMultipartUpload(
  key: string,
  uploadId: string,
  parts: Array<{ partNumber: number; etag: string }>,
): Promise<void> {
  await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts.map(({ partNumber, etag }) => ({
          PartNumber: partNumber,
          ETag: etag,
        })),
      },
    }),
  );
}

export async function objectHasSize(key: string, expectedBytes: number): Promise<boolean> {
  try {
    const object = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    return object.ContentLength === expectedBytes;
  } catch (error) {
    if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
      return false;
    }
    throw error;
  }
}

export function isMissingMultipartUpload(error: unknown): boolean {
  return error instanceof S3ServiceException && error.name === "NoSuchUpload";
}

export async function downloadObject(key: string, destination: string): Promise<void> {
  const object = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );

  if (!object.Body) {
    throw new Error(`S3 object ${key} has no response body.`);
  }

  await pipeline(object.Body as Readable, createWriteStream(destination));
}

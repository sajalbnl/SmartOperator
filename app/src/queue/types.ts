export const PART_SIZE_BYTES = 5 * 1024 * 1024;

export type ChunkState = 'pending' | 'uploading' | 'failed' | 'done';

export type LocalCapture = {
  attempts: number;
  created_at: string;
  duration_s: number;
  file_uri: string;
  id: string;
  last_error: string | null;
  machine_id: string;
  next_attempt_at: number;
  operator_id: string;
  server_id: string | null;
  status: string;
  total_bytes: number;
  updated_at: string;
  urls_refreshed_at: number | null;
};

export type LocalChunk = {
  attempts: number;
  byte_end: number;
  byte_start: number;
  capture_id: string;
  etag: string | null;
  id: number;
  last_error: string | null;
  next_attempt_at: number;
  part_number: number;
  presigned_url: string | null;
  state: ChunkState;
  updated_at: string;
};

export type CaptureQueueItem = LocalCapture & {
  chunks: LocalChunk[];
};

export type PresignedPart = {
  byteEnd: number;
  byteStart: number;
  partNumber: number;
  presignedUrl: string;
};

export type QueueSnapshot = {
  captures: CaptureQueueItem[];
  unfinishedCount: number;
};


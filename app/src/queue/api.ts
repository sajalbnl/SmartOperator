import { fetch as expoFetch, type FetchRequestInit } from 'expo/fetch';

import type { PresignedPart } from './types';

const HEALTH_TIMEOUT_MS = 5_000;
const API_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 120_000;

type CaptureRegistration = {
  captureId: string;
  parts: PresignedPart[];
};

export type PipelineStatus = 'uploaded' | 'transcribing' | 'structuring' | 'ready' | 'failed';

export type CapturePipeline = {
  captureId: string;
  error: string | null;
  procedureId: string | null;
  status: PipelineStatus;
  updatedAt: string | null;
};

export type ProcedureDraft = {
  approved: boolean;
  captureId: string;
  createdAt: string;
  id: string;
  machineId: string;
  rejectedAt: string | null;
  reviewStatus: 'pending' | 'approved' | 'rejected';
  safety: string[];
  source: string;
  steps: string[];
  title: string;
  tools: string[];
  transcript: string;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

function apiBaseUrl() {
  const configured = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (!configured) {
    throw new ApiError('EXPO_PUBLIC_API_URL is not configured.', null);
  }
  return configured.replace(/\/$/, '');
}

async function fetchWithTimeout(
  input: string,
  init: FetchRequestInit | undefined,
  timeoutMillis: number,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMillis);
  try {
    return await expoFetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ApiError(`Request timed out after ${Math.round(timeoutMillis / 1_000)}s.`, null);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function responseError(response: Response) {
  const body = await response.text().catch(() => '');
  let detail = body;
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === 'string') {
      detail = parsed.error;
    }
  } catch {
    // Keep the raw response when it is not JSON.
  }
  return new ApiError(
    `HTTP ${response.status}${detail ? `: ${detail.slice(0, 240)}` : ''}`,
    response.status,
  );
}

async function jsonRequest<T>(path: string, init?: FetchRequestInit): Promise<T> {
  const response = await fetchWithTimeout(
    `${apiBaseUrl()}${path}`,
    {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    },
    API_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw await responseError(response);
  }
  return response.json() as Promise<T>;
}

export async function probeHealth() {
  const response = await fetchWithTimeout(
    `${apiBaseUrl()}/health`,
    { headers: { Accept: 'application/json' } },
    HEALTH_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw await responseError(response);
  }
}

export function registerCapture(input: {
  durationSeconds: number;
  idempotencyKey: string;
  machineId: string;
  operatorId: string;
  totalBytes: number;
}) {
  return jsonRequest<CaptureRegistration>('/captures', {
    body: JSON.stringify({
      duration_s: input.durationSeconds,
      machine_id: input.machineId,
      operator_id: input.operatorId,
      total_bytes: input.totalBytes,
    }),
    headers: { 'Idempotency-Key': input.idempotencyKey },
    method: 'POST',
  });
}

export function resumeCapture(serverId: string) {
  return jsonRequest<CaptureRegistration>(`/captures/${serverId}/resume`);
}

export async function putPart(url: string, bytes: Uint8Array<ArrayBuffer>) {
  const response = await fetchWithTimeout(
    url,
    {
      body: bytes,
      headers: { 'Content-Type': 'application/octet-stream' },
      method: 'PUT',
    },
    UPLOAD_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw await responseError(response);
  }
  const etag = response.headers.get('etag');
  if (!etag) {
    throw new ApiError('S3 upload succeeded without an ETag response header.', response.status);
  }
  return etag;
}

export function reportPartComplete(serverId: string, partNumber: number, etag: string) {
  return jsonRequest<{ state: 'done' }>(
    `/captures/${serverId}/parts/${partNumber}/complete`,
    {
      body: JSON.stringify({ etag }),
      method: 'POST',
    },
  );
}

export function completeCapture(serverId: string) {
  return jsonRequest<{ status: 'uploaded' }>(`/captures/${serverId}/complete`, {
    method: 'POST',
  });
}

export function getCapturePipeline(serverId: string) {
  return jsonRequest<CapturePipeline>(`/captures/${serverId}/pipeline`);
}

export function listPendingProcedures() {
  return jsonRequest<{ procedures: ProcedureDraft[] }>('/procedures?review_status=pending');
}

export function rejectProcedure(procedureId: string) {
  return jsonRequest<{ procedure: ProcedureDraft }>(`/procedures/${procedureId}/reject`, {
    method: 'POST',
  });
}

export function approveProcedure(procedureId: string) {
  return jsonRequest<{ procedure: ProcedureDraft }>(`/procedures/${procedureId}/approve`, {
    method: 'POST',
  });
}

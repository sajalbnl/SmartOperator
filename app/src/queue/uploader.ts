import NetInfo, { type NetInfoSubscription } from '@react-native-community/netinfo';
import { File, FileMode } from 'expo-file-system';

import BackgroundVideoRecorder from '../../modules/background-video-recorder';
import {
  completeCapture,
  probeHealth,
  putPart,
  registerCapture,
  reportPartComplete,
  resumeCapture,
} from './api';
import {
  failCapture,
  failChunk,
  getRetryDelayMillis,
  listChunks,
  listRegisteredUnfinishedCaptures,
  listUnfinishedCaptures,
  markCaptureCompleting,
  markCaptureDone,
  markCaptureResuming,
  markChunkDone,
  markChunkUploading,
  markRegistrationStarted,
  nextActionableCapture,
  nextUploadableChunk,
  recoverInterruptedWork,
  requeueDueFailures,
  storeChunkEtag,
  storeRegistration,
  storeResumedParts,
} from './database';
import type { LocalCapture, LocalChunk } from './types';

type Connectivity = 'checking' | 'offline' | 'server-ready';

export type UploaderSnapshot = {
  connectivity: Connectivity;
  detail: string;
  running: boolean;
};

const URL_REFRESH_AFTER_MS = 10 * 60 * 1_000;
const MAX_BACKOFF_MS = 60_000;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function retryDelayMillis(attempt: number) {
  const exponential = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential / 2 + Math.random() * (exponential / 2));
}

function readChunkBytes(capture: LocalCapture, chunk: LocalChunk) {
  const file = new File(capture.file_uri);
  if (!file.exists) {
    throw new Error(`Local capture file is missing: ${capture.file_uri}`);
  }
  const expectedLength = chunk.byte_end - chunk.byte_start + 1;
  const handle = file.open(FileMode.ReadOnly);
  try {
    handle.offset = chunk.byte_start;
    const bytes = handle.readBytes(expectedLength);
    if (bytes.byteLength !== expectedLength) {
      throw new Error(
        `Read ${bytes.byteLength} bytes for part ${chunk.part_number}; expected ${expectedLength}.`,
      );
    }
    return bytes;
  } finally {
    handle.close();
  }
}

class DurableUploader {
  private listeners = new Set<() => void>();
  private networkSubscription: NetInfoSubscription | null = null;
  private started = false;
  private stopped = false;
  private pumping = false;
  private wakeResolver: (() => void) | null = null;
  private foregroundServiceRunning = false;
  private snapshot: UploaderSnapshot = {
    connectivity: 'checking',
    detail: 'Starting durable queue…',
    running: false,
  };

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private updateSnapshot(patch: Partial<UploaderSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  async start() {
    if (this.started) {
      this.wake();
      return;
    }
    this.started = true;
    this.stopped = false;
    await recoverInterruptedWork();
    this.networkSubscription = NetInfo.addEventListener(() => this.wake());
    this.wake();
  }

  stop() {
    this.started = false;
    this.stopped = true;
    this.networkSubscription?.();
    this.networkSubscription = null;
    this.wake();
    this.stopForegroundService();
  }

  wake() {
    this.wakeResolver?.();
    this.wakeResolver = null;
    if (!this.pumping && !this.stopped) {
      void this.pump();
    }
  }

  private wait(timeoutMillis: number) {
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.wakeResolver === wake) {
          this.wakeResolver = null;
        }
        resolve();
      }, timeoutMillis);
      const wake = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.wakeResolver = wake;
    });
  }

  private startForegroundService(unfinishedCount: number) {
    if (this.foregroundServiceRunning) {
      return;
    }
    this.foregroundServiceRunning = true;
    void BackgroundVideoRecorder.startUploadService(unfinishedCount).catch((error) => {
      this.foregroundServiceRunning = false;
      this.updateSnapshot({ detail: `Foreground service: ${errorMessage(error)}` });
    });
  }

  private stopForegroundService() {
    if (!this.foregroundServiceRunning) {
      return;
    }
    this.foregroundServiceRunning = false;
    void BackgroundVideoRecorder.stopUploadService().catch(() => undefined);
  }

  private async serverReachable() {
    this.updateSnapshot({ connectivity: 'checking', detail: 'Probing server /health…' });
    try {
      const network = await NetInfo.fetch();
      if (network.isConnected === false || network.isInternetReachable === false) {
        this.updateSnapshot({ connectivity: 'offline', detail: 'Offline — queue is durable' });
        return false;
      }
      await probeHealth();
      this.updateSnapshot({ connectivity: 'server-ready', detail: 'Server reachable' });
      return true;
    } catch (error) {
      this.updateSnapshot({
        connectivity: 'offline',
        detail: `Server unreachable: ${errorMessage(error)}`,
      });
      return false;
    }
  }

  private async refreshCapture(capture: LocalCapture) {
    if (!capture.server_id) {
      return;
    }
    await markCaptureResuming(capture.id);
    const resumed = await resumeCapture(capture.server_id);
    if (resumed.captureId !== capture.server_id) {
      throw new Error('Resume response returned the wrong capture ID.');
    }
    await storeResumedParts(capture.id, resumed.parts);
  }

  private async coldStartResume() {
    const captures = await listRegisteredUnfinishedCaptures();
    for (const capture of captures) {
      try {
        await this.refreshCapture(capture);
      } catch (error) {
        const attempt = capture.attempts + 1;
        await failCapture(
          capture,
          `Resume failed: ${errorMessage(error)}`,
          Date.now() + retryDelayMillis(attempt),
        );
      }
    }
  }

  private async register(capture: LocalCapture) {
    await markRegistrationStarted(capture.id);
    try {
      const result = await registerCapture({
        durationSeconds: capture.duration_s,
        idempotencyKey: capture.id,
        machineId: capture.machine_id,
        operatorId: capture.operator_id,
        totalBytes: capture.total_bytes,
      });
      await storeRegistration(capture.id, result.captureId, result.parts);
    } catch (error) {
      const attempt = capture.attempts + 1;
      await failCapture(
        capture,
        `Registration failed: ${errorMessage(error)}`,
        Date.now() + retryDelayMillis(attempt),
      );
    }
  }

  private async uploadChunk(capture: LocalCapture, chunk: LocalChunk) {
    await markChunkUploading(chunk);
    try {
      let etag = chunk.etag;
      if (!etag) {
        if (!chunk.presigned_url) {
          await this.refreshCapture(capture);
          const refreshed = (await listChunks(capture.id)).find(
            (candidate) => candidate.id === chunk.id,
          );
          if (!refreshed?.presigned_url) {
            throw new Error(`No presigned URL is available for part ${chunk.part_number}.`);
          }
          chunk = refreshed;
        }
        const bytes = readChunkBytes(capture, chunk);
        etag = await putPart(chunk.presigned_url as string, bytes);
        // Persist the result of the PUT before reporting it. If the report is
        // interrupted, the next run can report this ETag without re-uploading.
        await storeChunkEtag(chunk.id, etag);
      }

      await reportPartComplete(capture.server_id as string, chunk.part_number, etag);
      await markChunkDone(chunk, etag);
    } catch (error) {
      const attempt = chunk.attempts + 1;
      await failChunk(
        chunk,
        errorMessage(error),
        Date.now() + retryDelayMillis(attempt),
      );
    }
  }

  private async finishCapture(capture: LocalCapture) {
    await markCaptureCompleting(capture.id);
    try {
      await completeCapture(capture.server_id as string);
      await markCaptureDone(capture.id);
    } catch (error) {
      const attempt = capture.attempts + 1;
      await failCapture(
        capture,
        `Completion failed: ${errorMessage(error)}`,
        Date.now() + retryDelayMillis(attempt),
      );
    }
  }

  private async processOne(capture: LocalCapture) {
    if (!capture.server_id) {
      await this.register(capture);
      return;
    }

    const chunks = await listChunks(capture.id);
    if (chunks.every((chunk) => chunk.state === 'done')) {
      await this.finishCapture(capture);
      return;
    }

    const urlIsStale =
      capture.urls_refreshed_at == null ||
      Date.now() - capture.urls_refreshed_at >= URL_REFRESH_AFTER_MS;
    if (urlIsStale) {
      try {
        await this.refreshCapture(capture);
      } catch (error) {
        const attempt = capture.attempts + 1;
        await failCapture(
          capture,
          `URL refresh failed: ${errorMessage(error)}`,
          Date.now() + retryDelayMillis(attempt),
        );
        return;
      }
    }

    const chunk = await nextUploadableChunk(capture.id);
    if (chunk) {
      await this.uploadChunk(capture, chunk);
    }
  }

  private async pump() {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    this.updateSnapshot({ running: true });
    let needsColdStartResume = true;

    try {
      while (!this.stopped) {
        await requeueDueFailures();
        const unfinished = await listUnfinishedCaptures();
        if (unfinished.length === 0) {
          this.stopForegroundService();
          this.updateSnapshot({ detail: 'Queue drained', running: false });
          await this.wait(30_000);
          continue;
        }

        this.startForegroundService(unfinished.length);
        if (!(await this.serverReachable())) {
          await this.wait(10_000);
          continue;
        }

        if (needsColdStartResume) {
          needsColdStartResume = false;
          await this.coldStartResume();
          continue;
        }

        const capture = await nextActionableCapture();
        if (!capture) {
          await this.wait(await getRetryDelayMillis());
          continue;
        }

        await this.processOne(capture);
      }
    } catch (error) {
      this.updateSnapshot({
        detail: `Uploader loop recovered: ${errorMessage(error)}`,
        running: false,
      });
    } finally {
      this.pumping = false;
      this.updateSnapshot({ running: false });
      if (!this.stopped) {
        setTimeout(() => this.wake(), 2_000);
      }
    }
  }
}

export const durableUploader = new DurableUploader();

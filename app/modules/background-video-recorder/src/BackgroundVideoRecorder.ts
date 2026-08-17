import { NativeModule, requireNativeModule } from 'expo';

export type RecorderStatus = {
  isRecording: boolean;
  lastError: string | null;
  uri: string | null;
};

export type RecordingResult = {
  durationMillis: number;
  size: number;
  uri: string;
};

declare class BackgroundVideoRecorderModule extends NativeModule<{}> {
  getStatus(): RecorderStatus;
  startRecording(outputUri: string): Promise<{ uri: string }>;
  startUploadService(unfinishedCaptures: number): Promise<void>;
  stopRecording(): Promise<RecordingResult>;
  stopUploadService(): Promise<void>;
}

export default requireNativeModule<BackgroundVideoRecorderModule>(
  'BackgroundVideoRecorder',
);

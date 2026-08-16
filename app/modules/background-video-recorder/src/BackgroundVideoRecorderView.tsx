import { requireNativeViewManager } from 'expo-modules-core';
import type { ViewProps } from 'react-native';

const NativeBackgroundVideoRecorderView =
  requireNativeViewManager<ViewProps>('BackgroundVideoRecorder');

export function BackgroundVideoRecorderView(props: ViewProps) {
  return <NativeBackgroundVideoRecorderView {...props} />;
}

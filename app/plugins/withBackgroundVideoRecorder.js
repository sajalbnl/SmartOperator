const { withAndroidManifest } = require('expo/config-plugins');

const SERVICE_NAME =
  'expo.modules.smartoperatorrecorder.BackgroundVideoRecorderService';

const REQUIRED_PERMISSIONS = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_CAMERA',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
];

function addPermission(manifest, permission) {
  const permissions = manifest['uses-permission'] ?? [];
  const present = permissions.some(
    (entry) => entry.$?.['android:name'] === permission,
  );

  if (!present) {
    permissions.push({ $: { 'android:name': permission } });
  }

  manifest['uses-permission'] = permissions;
}

function withBackgroundVideoRecorder(config) {
  return withAndroidManifest(config, (configWithManifest) => {
    const manifest = configWithManifest.modResults.manifest;
    REQUIRED_PERMISSIONS.forEach((permission) => addPermission(manifest, permission));

    const application = manifest.application?.[0];
    if (!application) {
      throw new Error('Android application entry is missing from the manifest.');
    }

    const services = application.service ?? [];
    const existing = services.find(
      (service) => service.$?.['android:name'] === SERVICE_NAME,
    );
    const attributes = {
      'android:name': SERVICE_NAME,
      'android:exported': 'false',
      'android:foregroundServiceType': 'camera|microphone',
      'android:stopWithTask': 'false',
    };

    if (existing) {
      existing.$ = { ...existing.$, ...attributes };
    } else {
      services.push({ $: attributes });
    }
    application.service = services;

    return configWithManifest;
  });
}

module.exports = withBackgroundVideoRecorder;


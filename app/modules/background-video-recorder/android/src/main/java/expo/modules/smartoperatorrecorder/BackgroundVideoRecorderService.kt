package expo.modules.smartoperatorrecorder

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import androidx.camera.core.CameraSelector
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FallbackStrategy
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import java.io.File

class BackgroundVideoRecorderService : Service(), LifecycleOwner {
  private val lifecycleRegistry = LifecycleRegistry(this)
  override fun getLifecycle(): Lifecycle = lifecycleRegistry

  private var cameraProvider: ProcessCameraProvider? = null
  private var preview: Preview? = null
  private var recording: Recording? = null
  private var outputFile: File? = null
  private var outputUri: String? = null
  private var startedAtElapsedRealtime = 0L
  private var isFinishing = false

  override fun onCreate() {
    super.onCreate()
    lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_CREATE)
    RecorderCoordinator.attach(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action != ACTION_START) {
      fail("E_INVALID_SERVICE_ACTION", "The recording service received an invalid action.")
      return START_NOT_STICKY
    }

    val requestedUri = intent.getStringExtra(EXTRA_OUTPUT_URI)
    val requestedPath = requestedUri?.let { android.net.Uri.parse(it).path }
    if (requestedUri.isNullOrBlank() || requestedPath.isNullOrBlank()) {
      fail("E_BAD_OUTPUT_URI", "The recording service received an invalid output URI.")
      return START_NOT_STICKY
    }

    startForegroundNotification()

    if (!hasRequiredPermissions()) {
      fail("E_MISSING_PERMISSION", "Camera and microphone permissions are required.")
      return START_NOT_STICKY
    }

    outputUri = requestedUri
    outputFile = File(requestedPath)
    lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_START)
    lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)
    bindCameraAndRecord()
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  fun stopFromModule() {
    if (isFinishing) {
      return
    }
    isFinishing = true
    recording?.stop()
      ?: fail("E_RECORDING_NOT_READY", "The camera recording was not ready to stop.")
  }

  private fun bindCameraAndRecord() {
    val providerFuture = ProcessCameraProvider.getInstance(this)
    providerFuture.addListener(
      {
        try {
          val provider = providerFuture.get()
          val selector = QualitySelector.from(
            Quality.HD,
            FallbackStrategy.higherQualityOrLowerThan(Quality.HD),
          )
          val recorder = Recorder.Builder()
            .setExecutor(ContextCompat.getMainExecutor(this))
            .setQualitySelector(selector)
            .setTargetVideoEncodingBitRate(TARGET_VIDEO_BITRATE)
            .build()
          val videoCapture = VideoCapture.withOutput(recorder)
          val previewUseCase = Preview.Builder().build().also { preview ->
            RecorderCoordinator.getPreviewSurfaceProvider()?.let(preview::setSurfaceProvider)
          }

          provider.unbindAll()
          provider.bindToLifecycle(
            this,
            CameraSelector.DEFAULT_BACK_CAMERA,
            previewUseCase,
            videoCapture,
          )
          cameraProvider = provider
          preview = previewUseCase
          beginRecording(recorder)
        } catch (error: Throwable) {
          fail(
            "E_CAMERA_BIND_FAILED",
            error.message ?: "Could not open the back camera.",
            error,
          )
        }
      },
      ContextCompat.getMainExecutor(this),
    )
  }

  fun setPreviewSurfaceProvider(surfaceProvider: Preview.SurfaceProvider) {
    preview?.setSurfaceProvider(surfaceProvider)
  }

  fun clearPreviewSurfaceProvider(surfaceProvider: Preview.SurfaceProvider) {
    if (RecorderCoordinator.getPreviewSurfaceProvider() !== surfaceProvider) {
      preview?.setSurfaceProvider(null)
    }
  }

  private fun beginRecording(recorder: Recorder) {
    val file = outputFile
    if (file == null) {
      fail("E_OUTPUT_MISSING", "The recording output file was not configured.")
      return
    }

    val options = FileOutputOptions.Builder(file)
      .setDurationLimitMillis(MAX_DURATION_MILLIS)
      .build()
    startedAtElapsedRealtime = SystemClock.elapsedRealtime()
    recording = recorder.prepareRecording(this, options)
      .withAudioEnabled()
      .start(ContextCompat.getMainExecutor(this)) { event ->
        when (event) {
          is VideoRecordEvent.Start -> RecorderCoordinator.onStarted()
          is VideoRecordEvent.Finalize -> finalizeRecording(event)
        }
      }
  }

  private fun finalizeRecording(event: VideoRecordEvent.Finalize) {
    val uri = outputUri
    val file = outputFile
    val duration = SystemClock.elapsedRealtime() - startedAtElapsedRealtime

    // CameraX reports reaching an intentional duration limit through the error
    // field even though the MP4 was finalized successfully and is usable.
    if (
      event.hasError() &&
      event.error != VideoRecordEvent.Finalize.ERROR_DURATION_LIMIT_REACHED
    ) {
      fail(
        "E_RECORDING_FAILED",
        event.cause?.message ?: "CameraX finalized the recording with error ${event.error}.",
        event.cause,
      )
      return
    }

    if (uri == null || file == null || !file.exists()) {
      fail("E_OUTPUT_MISSING", "The completed video file could not be found.")
      return
    }

    RecorderCoordinator.onFinished(uri, file.length(), duration)
    shutdown()
  }

  private fun hasRequiredPermissions(): Boolean =
    ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
      PackageManager.PERMISSION_GRANTED &&
      ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
      PackageManager.PERMISSION_GRANTED

  private fun startForegroundNotification() {
    val notificationManager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      notificationManager.createNotificationChannel(
        NotificationChannel(
          NOTIFICATION_CHANNEL_ID,
          "Active capture",
          NotificationManager.IMPORTANCE_LOW,
        ).apply {
          description = "Shown while SmartOperator is recording video"
          setSound(null, null)
        },
      )
    }

    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    val pendingIntent = launchIntent?.let {
      PendingIntent.getActivity(
        this,
        0,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
    val notification = NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
      .setContentTitle("Recording CNC-042")
      .setContentText("Video and audio capture is in progress")
      .setSmallIcon(android.R.drawable.ic_menu_camera)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setContentIntent(pendingIntent)
      .build()

    val foregroundTypes = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA or
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    } else {
      0
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      startForeground(NOTIFICATION_ID, notification, foregroundTypes)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun fail(code: String, message: String, error: Throwable? = null) {
    RecorderCoordinator.onFailed(code, message, error)
    shutdown()
  }

  private fun shutdown() {
    recording?.close()
    recording = null
    cameraProvider?.unbindAll()
    cameraProvider = null
    preview = null

    if (lifecycleRegistry.currentState == Lifecycle.State.RESUMED) {
      lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_PAUSE)
    }
    if (lifecycleRegistry.currentState.isAtLeast(Lifecycle.State.STARTED)) {
      lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
    }

    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onDestroy() {
    if (lifecycleRegistry.currentState != Lifecycle.State.DESTROYED) {
      lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_DESTROY)
    }
    super.onDestroy()
  }

  companion object {
    const val ACTION_START = "com.smartoperator.capture.START_RECORDING"
    const val EXTRA_OUTPUT_URI = "outputUri"
    private const val NOTIFICATION_CHANNEL_ID = "active-capture"
    private const val NOTIFICATION_ID = 42
    private const val TARGET_VIDEO_BITRATE = 3_000_000
    private const val MAX_DURATION_MILLIS = 120_000L
  }
}

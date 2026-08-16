package expo.modules.smartoperatorrecorder

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.camera.core.Preview
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import java.io.File

internal object RecorderCoordinator {
  private val mainHandler = Handler(Looper.getMainLooper())

  @Volatile
  private var service: BackgroundVideoRecorderService? = null

  @Volatile
  private var previewSurfaceProvider: Preview.SurfaceProvider? = null

  @Volatile
  private var activeUri: String? = null

  @Volatile
  private var recording = false

  private var startPromise: Promise? = null
  private var stopPromise: Promise? = null
  private var lastResult: Map<String, Any>? = null
  private var lastError: String? = null

  fun start(context: Context, outputUri: String, promise: Promise) {
    mainHandler.post {
      if (activeUri != null || service != null) {
        promise.reject("E_RECORDING_ACTIVE", "A recording is already in progress.", null)
        return@post
      }

      val outputPath = Uri.parse(outputUri).path
      if (outputPath.isNullOrBlank()) {
        promise.reject("E_BAD_OUTPUT_URI", "The output file URI is invalid.", null)
        return@post
      }

      val file = File(outputPath)
      file.parentFile?.mkdirs()
      if (file.exists()) {
        file.delete()
      }

      activeUri = outputUri
      lastResult = null
      lastError = null
      startPromise = promise

      try {
        val intent = Intent(context, BackgroundVideoRecorderService::class.java).apply {
          action = BackgroundVideoRecorderService.ACTION_START
          putExtra(BackgroundVideoRecorderService.EXTRA_OUTPUT_URI, outputUri)
        }
        ContextCompat.startForegroundService(context, intent)
      } catch (error: Throwable) {
        activeUri = null
        startPromise = null
        promise.reject(
          "E_SERVICE_START_FAILED",
          error.message ?: "Could not start the recording service.",
          error,
        )
      }
    }
  }

  fun stop(promise: Promise) {
    mainHandler.post {
      val currentService = service
      if (currentService != null && activeUri != null) {
        if (stopPromise != null) {
          promise.reject("E_STOP_PENDING", "Recording is already stopping.", null)
          return@post
        }
        stopPromise = promise
        currentService.stopFromModule()
        return@post
      }

      val completed = lastResult
      if (completed != null) {
        lastResult = null
        promise.resolve(completed)
        return@post
      }

      promise.reject(
        "E_NO_RECORDING",
        lastError ?: "There is no recording in progress.",
        null,
      )
    }
  }

  fun attach(service: BackgroundVideoRecorderService) {
    this.service = service
  }

  fun attachPreview(surfaceProvider: Preview.SurfaceProvider) {
    mainHandler.post {
      previewSurfaceProvider = surfaceProvider
      service?.setPreviewSurfaceProvider(surfaceProvider)
    }
  }

  fun detachPreview(surfaceProvider: Preview.SurfaceProvider) {
    mainHandler.post {
      if (previewSurfaceProvider === surfaceProvider) {
        previewSurfaceProvider = null
        service?.clearPreviewSurfaceProvider(surfaceProvider)
      }
    }
  }

  fun getPreviewSurfaceProvider(): Preview.SurfaceProvider? = previewSurfaceProvider

  fun onStarted() {
    recording = true
    startPromise?.resolve(mapOf("uri" to requireNotNull(activeUri)))
    startPromise = null
  }

  fun onFinished(outputUri: String, size: Long, durationMillis: Long) {
    recording = false
    service = null
    activeUri = null
    lastError = null

    val result = mapOf<String, Any>(
      "uri" to outputUri,
      "size" to size.toDouble(),
      "durationMillis" to durationMillis.toDouble(),
    )
    val pendingStop = stopPromise
    stopPromise = null
    if (pendingStop != null) {
      pendingStop.resolve(result)
    } else {
      lastResult = result
    }
  }

  fun onFailed(code: String, message: String, error: Throwable? = null) {
    recording = false
    service = null
    activeUri = null
    lastResult = null
    lastError = message

    startPromise?.reject(code, message, error)
    stopPromise?.reject(code, message, error)
    startPromise = null
    stopPromise = null
  }

  fun status(): Map<String, Any?> = mapOf(
    "isRecording" to recording,
    "uri" to activeUri,
    "lastError" to lastError,
  )
}

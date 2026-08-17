package expo.modules.smartoperatorrecorder

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class BackgroundVideoRecorderModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.AppContextLost()

  override fun definition() = ModuleDefinition {
    Name("BackgroundVideoRecorder")

    AsyncFunction("startRecording") { outputUri: String, promise: Promise ->
      RecorderCoordinator.start(context, outputUri, promise)
    }

    AsyncFunction("stopRecording") { promise: Promise ->
      RecorderCoordinator.stop(promise)
    }

    AsyncFunction("startUploadService") { unfinishedCaptures: Int ->
      val intent = Intent(context, UploadForegroundService::class.java).apply {
        action = UploadForegroundService.ACTION_START
        putExtra(UploadForegroundService.EXTRA_UNFINISHED_CAPTURES, unfinishedCaptures)
      }
      ContextCompat.startForegroundService(context, intent)
    }

    AsyncFunction("stopUploadService") {
      context.stopService(Intent(context, UploadForegroundService::class.java))
    }

    Function("getStatus") {
      RecorderCoordinator.status()
    }

    View(BackgroundVideoRecorderView::class) {}
  }
}

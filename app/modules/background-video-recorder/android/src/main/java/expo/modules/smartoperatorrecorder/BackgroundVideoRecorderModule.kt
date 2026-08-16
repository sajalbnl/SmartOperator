package expo.modules.smartoperatorrecorder

import android.content.Context
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

    Function("getStatus") {
      RecorderCoordinator.status()
    }

    View(BackgroundVideoRecorderView::class) {}
  }
}

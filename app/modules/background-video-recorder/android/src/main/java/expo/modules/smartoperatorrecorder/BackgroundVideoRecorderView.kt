package expo.modules.smartoperatorrecorder

import android.annotation.SuppressLint
import android.content.Context
import android.view.View
import android.view.View.MeasureSpec
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import androidx.camera.view.PreviewView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

/**
 * The preview surface used by the foreground recorder.
 *
 * The service owns CameraX while recording so that its lifecycle is not tied to
 * the Activity. Supplying its Preview use case with this surface lets the same
 * camera session render in React while the Activity is visible.
 */
@SuppressLint("ViewConstructor")
class BackgroundVideoRecorderView(
  context: Context,
  appContext: AppContext,
) : ExpoView(context, appContext) {
  private val cameraPreview = PreviewView(context).apply {
    // SurfaceView is the most reliable path for sustained camera frames on
    // physical Android devices. React only reveals this view after Expo Camera
    // releases ownership, so it cannot punch through the idle preview.
    implementationMode = PreviewView.ImplementationMode.PERFORMANCE
    scaleType = PreviewView.ScaleType.FILL_CENTER
  }

  init {
    // PreviewView creates its SurfaceView only after CameraX requests a
    // surface. React Native has already completed layout at that point, so
    // explicitly measure/layout the new child just as Expo Camera does.
    cameraPreview.setOnHierarchyChangeListener(object : ViewGroup.OnHierarchyChangeListener {
      override fun onChildViewRemoved(parent: View?, child: View?) = Unit

      override fun onChildViewAdded(parent: View?, child: View?) {
        parent?.measure(
          MeasureSpec.makeMeasureSpec(measuredWidth, MeasureSpec.EXACTLY),
          MeasureSpec.makeMeasureSpec(measuredHeight, MeasureSpec.EXACTLY),
        )
        parent?.layout(0, 0, parent.measuredWidth, parent.measuredHeight)
      }
    })
    addView(cameraPreview, LayoutParams(MATCH_PARENT, MATCH_PARENT))
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    RecorderCoordinator.attachPreview(cameraPreview.surfaceProvider)
  }

  override fun onDetachedFromWindow() {
    RecorderCoordinator.detachPreview(cameraPreview.surfaceProvider)
    super.onDetachedFromWindow()
  }
}

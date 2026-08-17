package expo.modules.smartoperatorrecorder

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Keeps the React Native process important while the durable SQLite uploader is
 * active. The actual state machine remains in TypeScript so every transition is
 * committed to expo-sqlite and immediately reflected in the demo table.
 *
 * stopWithTask=true in the manifest deliberately stops this service when the
 * user swipes the task away. The next Activity launch performs cold-start
 * reconciliation from SQLite and the server's idempotent resume endpoint.
 */
class UploadForegroundService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val unfinishedCaptures = intent
      ?.getIntExtra(EXTRA_UNFINISHED_CAPTURES, 1)
      ?.coerceAtLeast(1)
      ?: 1
    startForegroundNotification(unfinishedCaptures)
    return START_NOT_STICKY
  }

  private fun startForegroundNotification(unfinishedCaptures: Int) {
    val notificationManager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      notificationManager.createNotificationChannel(
        NotificationChannel(
          NOTIFICATION_CHANNEL_ID,
          "Capture uploads",
          NotificationManager.IMPORTANCE_LOW,
        ).apply {
          description = "Shown while queued factory captures are uploading"
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
    val noun = if (unfinishedCaptures == 1) "capture" else "captures"
    val notification = NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
      .setContentTitle("SmartOperator upload queue")
      .setContentText("Recovering $unfinishedCaptures queued $noun")
      .setSmallIcon(android.R.drawable.stat_sys_upload)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setContentIntent(pendingIntent)
      .build()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  companion object {
    const val ACTION_START = "com.smartoperator.capture.START_UPLOAD_QUEUE"
    const val EXTRA_UNFINISHED_CAPTURES = "unfinishedCaptures"
    private const val NOTIFICATION_CHANNEL_ID = "capture-uploads"
    private const val NOTIFICATION_ID = 43
  }
}

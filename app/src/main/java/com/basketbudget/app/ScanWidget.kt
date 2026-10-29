package com.basketbudget.app

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

/**
 * A home-screen button that goes straight to photographing a receipt.
 *
 * The shop is where a receipt is worth recording - by the time the phone is
 * back on the sofa the slip is in a pocket. So this skips the app entirely:
 * tap, camera, review sheet.
 */
class ScanWidget : AppWidgetProvider() {

    override fun onUpdate(
        context: Context,
        manager: AppWidgetManager,
        ids: IntArray,
    ) {
        for (id in ids) {
            val open = Intent(context, MainActivity::class.java).apply {
                action = Intent.ACTION_MAIN
                putExtra(EXTRA_SCAN, true)
                // Reuse the running task rather than stacking a second copy of
                // the page on top of itself.
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            val views = RemoteViews(context.packageName, R.layout.widget_scan).apply {
                setOnClickPendingIntent(
                    R.id.widget_root,
                    PendingIntent.getActivity(
                        context,
                        id,
                        open,
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                    ),
                )
            }
            manager.updateAppWidget(id, views)
        }
    }

    companion object {
        const val EXTRA_SCAN = "com.basketbudget.app.SCAN"
    }
}

package com.basketbudget.app

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

/**
 * A home-screen button that takes in whatever M-PESA has sent since last time.
 *
 * The app already does this quietly on the way in, which is right - nobody
 * wants to be told nothing happened - but quiet also means you cannot ask. A
 * statement arrives, or a payment you want to see on the list now, and the only
 * way to be sure it has been read is to open the app and trust that it did.
 *
 * So this is the same read, out loud: tap, and it says how many it took in.
 * The widget then keeps that answer on the home screen until the next tap, so
 * the question "is the tracker up to date" is answered without opening
 * anything at all.
 */
class InboxWidget : AppWidgetProvider() {

    override fun onUpdate(
        context: Context,
        manager: AppWidgetManager,
        ids: IntArray,
    ) {
        val status = context
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_STATUS, null)

        for (id in ids) {
            val open = Intent(context, MainActivity::class.java).apply {
                action = Intent.ACTION_MAIN
                putExtra(EXTRA_INBOX, true)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            val views = RemoteViews(context.packageName, R.layout.widget_inbox).apply {
                setTextViewText(R.id.widget_status, status ?: "Tap to read")
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
        const val EXTRA_INBOX = "com.basketbudget.app.INBOX"

        // The widget's own file. It could share the one the reader keeps its
        // high-water mark in, but that belongs to the read; this is a line of
        // text about the last one, and the two have no reason to be coupled.
        private const val PREFS = "inboxWidget"
        private const val KEY_STATUS = "status"

        /**
         * Put the result of a read on the home screen.
         *
         * Called after every read, not only the ones the widget asked for, so
         * the line stays true whichever way the messages came in.
         */
        fun say(context: Context, status: String) {
            context
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_STATUS, status)
                .apply()

            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, InboxWidget::class.java))
            if (ids.isEmpty()) return // nobody has added one; nothing to draw
            InboxWidget().onUpdate(context, manager, ids)
        }
    }
}

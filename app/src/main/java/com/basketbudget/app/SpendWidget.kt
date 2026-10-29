package com.basketbudget.app

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

/**
 * What you have spent this cycle, on the home screen.
 *
 * The other two widgets are buttons: they offer to open something that will
 * answer a question. This one answers it. An alarm widget shows the time
 * rather than a button marked "alarms", and a budget widget that only says
 * "Budget Tracker" is taking up a home-screen slot to tell you an app exists.
 *
 * It cannot work the figure out for itself - the transactions live in the
 * page's own storage inside the WebView, which Android cannot read - so the
 * page hands over a summary each time it draws its home screen, and this draws
 * whatever it was last told. The note says how old that is rather than
 * pretending the number is live.
 */
class SpendWidget : AppWidgetProvider() {

    override fun onUpdate(
        context: Context,
        manager: AppWidgetManager,
        ids: IntArray,
    ) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val amount = prefs.getString(KEY_AMOUNT, null)
        val note = prefs.getString(KEY_NOTE, null)
        val pct = prefs.getInt(KEY_PCT, 0)

        for (id in ids) {
            val open = Intent(context, MainActivity::class.java).apply {
                action = Intent.ACTION_MAIN
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            val views = RemoteViews(context.packageName, R.layout.widget_spend).apply {
                if (amount != null) setTextViewText(R.id.spend_amount, amount)
                if (note != null) setTextViewText(R.id.spend_note, note)
                setProgressBar(R.id.spend_bar, 100, pct.coerceIn(0, 100), false)
                // No budget set means no bar to fill: an empty track reads as
                // "you have spent nothing", which is the opposite of the truth.
                setViewVisibility(R.id.spend_bar, if (pct > 0) android.view.View.VISIBLE else android.view.View.GONE)
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
        private const val PREFS = "spendWidget"
        private const val KEY_AMOUNT = "amount"
        private const val KEY_NOTE = "note"
        private const val KEY_PCT = "pct"

        /**
         * Take the page's summary and redraw.
         *
         * @param pct share of the budget used, 0 when there is no budget to use
         */
        fun say(context: Context, amount: String, note: String, pct: Int) {
            context
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_AMOUNT, amount)
                .putString(KEY_NOTE, note)
                .putInt(KEY_PCT, pct)
                .apply()

            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, SpendWidget::class.java))
            if (ids.isEmpty()) return // nobody has added one; nothing to draw
            SpendWidget().onUpdate(context, manager, ids)
        }
    }
}

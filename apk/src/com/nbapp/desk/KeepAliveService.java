package com.nbapp.desk;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

/**
 * 前台服务：AI 正在写正文 / 批量 / 流水线在跑的时候，把进程保住。
 *
 * 为什么需要它：网页里那点在跑的活其实是**服务器**在干，但 WebView 切到后台会被系统
 * 回收，回来时页面已经重载 —— 用户看到的就成了「切出去一会儿，任务没了」。
 * 起一个低优先级的前台通知，Android 就不会随便杀掉我们；任务结束由网页调停掉。
 *
 * 注意：用户从最近任务里划掉 App 时（onTaskRemoved）立刻自己停掉，不做流氓驻留。
 */
public class KeepAliveService extends Service {

    public static final String CHANNEL = "writing";
    private static final int NOTI_ID = 41;

    public static void start(Context ctx) {
        Intent i = new Intent(ctx, KeepAliveService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
            else ctx.startService(i);
        } catch (Exception e) {
            // 系统不让起（比如通知被禁）：保活失败不能把主流程弄崩，安静地算了
        }
    }

    public static void stop(Context ctx) {
        try { ctx.stopService(new Intent(ctx, KeepAliveService.class)); } catch (Exception e) { }
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            startForeground(NOTI_ID, build());
        } catch (Exception e) {
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Override public void onTaskRemoved(Intent rootIntent) {
        stopSelf();                 // 用户划掉 App 就撤，不赖在通知栏里
        super.onTaskRemoved(rootIntent);
    }

    private Notification build() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel c = new NotificationChannel(CHANNEL, "正在写作",
                        NotificationManager.IMPORTANCE_LOW);
                c.setShowBadge(false);
                c.setDescription("AI 写正文、批量跑的时候在这儿报个信；停下来就撤掉");
                nm.createNotificationChannel(c);
            }
        }
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) piFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, piFlags);
        Notification.Builder b = (Build.VERSION.SDK_INT >= 26)
                ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        b.setContentTitle("正在写")
         .setContentText("AI 还在写，切出去也不影响")
         .setSmallIcon(android.R.drawable.stat_notify_sync)
         .setOngoing(true)
         .setContentIntent(pi);
        return b.build();
    }
}

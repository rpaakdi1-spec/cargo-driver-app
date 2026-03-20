package com.cargo.driver;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;
import android.webkit.JavascriptInterface;

import androidx.core.app.NotificationCompat;

/**
 * WebAppInterface — JS ↔ 네이티브 브릿지
 * ─────────────────────────────────────────────
 * driver.html(JS)에서 window.AndroidGPS.xxx() 로 호출합니다.
 *
 * 추가된 기능:
 *  - showNotification(title, body) : 네이티브 푸시 알림 표시
 *  - openCamera() : 파일 선택은 WebView에서 onShowFileChooser로 처리되므로 불필요
 */
public class WebAppInterface {

    private static final String TAG              = "WebAppInterface";
    private static final String CHANNEL_ID       = "cargo_notifications";
    private static final String CHANNEL_NAME     = "화물운송 알림";
    private static int          notifId          = 1000;

    private final MainActivity activity;
    private final Context      context;

    public WebAppInterface(Context ctx, MainActivity act) {
        this.context  = ctx;
        this.activity = act;
        createNotificationChannel();
    }

    // ── 알림 채널 생성 (Android 8.0+) ────────────────────────
    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("화물운송 기사 앱 알림");
            channel.enableVibration(true);
            channel.enableLights(true);
            NotificationManager nm =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.createNotificationChannel(channel);
        }
    }

    // ── GPS 서비스 시작 ───────────────────────────────────────
    @JavascriptInterface
    public void startGps(String deliveryId) {
        Log.d(TAG, "JS → startGps: " + deliveryId);
        activity.runOnUiThread(() -> activity.startGpsService(deliveryId));
    }

    // ── GPS 서비스 중지 ───────────────────────────────────────
    @JavascriptInterface
    public void stopGps() {
        Log.d(TAG, "JS → stopGps");
        activity.runOnUiThread(() -> activity.stopGpsService());
    }

    // ── 배송 ID 업데이트 ─────────────────────────────────────
    @JavascriptInterface
    public void setDeliveryId(String deliveryId) {
        Log.d(TAG, "JS → setDeliveryId: " + deliveryId);
        if (activity.isGpsServiceRunning()) {
            activity.startGpsService(deliveryId);
        }
    }

    // ── 앱 최소화 ─────────────────────────────────────────────
    @JavascriptInterface
    public void moveToBackground() {
        Log.d(TAG, "JS → moveToBackground");
        activity.runOnUiThread(() -> {
            Intent home = new Intent(Intent.ACTION_MAIN);
            home.addCategory(Intent.CATEGORY_HOME);
            home.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(home);
        });
    }

    // ── GPS 실행 여부 ─────────────────────────────────────────
    @JavascriptInterface
    public String isGpsRunning() {
        return String.valueOf(activity.isGpsServiceRunning());
    }

    // ── 앱 환경 확인 ─────────────────────────────────────────
    @JavascriptInterface
    public String isNativeApp() {
        return "true";
    }

    // ── 토스트 메시지 ─────────────────────────────────────────
    @JavascriptInterface
    public void showToast(String message) {
        activity.runOnUiThread(() ->
            android.widget.Toast.makeText(context, message,
                android.widget.Toast.LENGTH_SHORT).show());
    }

    // ★★★ 네이티브 푸시 알림 표시 ★★★
    // JS에서: AndroidGPS.showNotification("제목", "내용")
    @JavascriptInterface
    public void showNotification(String title, String body) {
        Log.d(TAG, "JS → showNotification: " + title + " / " + body);
        activity.runOnUiThread(() -> {
            // 앱 탭할 때 MainActivity 열기
            Intent intent = new Intent(context, MainActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                : PendingIntent.FLAG_UPDATE_CURRENT;
            PendingIntent pendingIntent =
                PendingIntent.getActivity(context, notifId, intent, flags);

            NotificationCompat.Builder builder =
                new NotificationCompat.Builder(context, CHANNEL_ID)
                    .setSmallIcon(R.drawable.ic_gps)
                    .setContentTitle(title != null ? title : "화물운송")
                    .setContentText(body != null ? body : "")
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setAutoCancel(true)
                    .setContentIntent(pendingIntent)
                    .setVibrate(new long[]{0, 300, 100, 300});

            NotificationManager nm =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.notify(notifId++, builder.build());
            }
        });
    }
}

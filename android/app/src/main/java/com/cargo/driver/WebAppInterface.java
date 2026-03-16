package com.cargo.driver;

import android.webkit.JavascriptInterface;
import android.util.Log;

public class WebAppInterface {

    private static final String TAG = "WebAppInterface";
    private final MainActivity activity;
    private final android.content.Context context;

    public WebAppInterface(android.content.Context ctx, MainActivity act) {
        this.context  = ctx;
        this.activity = act;
    }

    @JavascriptInterface
    public void startGps(String deliveryId) {
        Log.d(TAG, "JS → startGps: " + deliveryId);
        activity.runOnUiThread(() -> activity.startGpsService(deliveryId));
    }

    @JavascriptInterface
    public void stopGps() {
        Log.d(TAG, "JS → stopGps");
        activity.runOnUiThread(() -> activity.stopGpsService());
    }

    @JavascriptInterface
    public void setDeliveryId(String deliveryId) {
        Log.d(TAG, "JS → setDeliveryId: " + deliveryId);
        if (activity.isGpsServiceRunning()) {
            activity.startGpsService(deliveryId);
        }
    }

    // ★ 앱 최소화 — 홈 화면으로 이동
    @JavascriptInterface
    public void moveToBackground() {
        Log.d(TAG, "JS → moveToBackground");
        activity.runOnUiThread(() -> {
            android.content.Intent home = new android.content.Intent(
                android.content.Intent.ACTION_MAIN);
            home.addCategory(android.content.Intent.CATEGORY_HOME);
            home.setFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(home);
        });
    }

    @JavascriptInterface
    public String isGpsRunning() {
        return String.valueOf(activity.isGpsServiceRunning());
    }

    @JavascriptInterface
    public String isNativeApp() {
        return "true";
    }

    @JavascriptInterface
    public void showToast(String message) {
        activity.runOnUiThread(() ->
            android.widget.Toast.makeText(context, message,
                android.widget.Toast.LENGTH_SHORT).show());
    }
}

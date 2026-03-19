package com.cargo.driver;

import android.webkit.JavascriptInterface;
import android.util.Log;

/**
 * WebAppInterface — JS ↔ 네이티브 GPS 브릿지
 * ─────────────────────────────────────────────
 * driver.html(JS)에서 window.AndroidGPS.xxx() 로 호출합니다.
 */
public class WebAppInterface {

    private static final String TAG = "WebAppInterface";

    private final MainActivity activity;
    private final android.content.Context context;

    public WebAppInterface(android.content.Context ctx, MainActivity act) {
        this.context  = ctx;
        this.activity = act;
    }

    // GPS 서비스 시작
    @JavascriptInterface
    public void startGps(String deliveryId) {
        Log.d(TAG, "JS → startGps: " + deliveryId);
        activity.runOnUiThread(() -> activity.startGpsService(deliveryId));
    }

    // GPS 서비스 중지 (하차 완료 시)
    @JavascriptInterface
    public void stopGps() {
        Log.d(TAG, "JS → stopGps");
        activity.runOnUiThread(() -> activity.stopGpsService());
    }

    // 배송 ID 업데이트
    @JavascriptInterface
    public void setDeliveryId(String deliveryId) {
        Log.d(TAG, "JS → setDeliveryId: " + deliveryId);
        if (activity.isGpsServiceRunning()) {
            activity.startGpsService(deliveryId);
        }
    }

    // ★ 앱 최소화 (상차완료 버튼 클릭 시 호출)
    @JavascriptInterface
    public void moveToBackground() {
        Log.d(TAG, "JS → moveToBackground");
        activity.runOnUiThread(() -> {
            // 홈 화면으로 이동 = 앱 최소화
            android.content.Intent home = new android.content.Intent(
                android.content.Intent.ACTION_MAIN);
            home.addCategory(android.content.Intent.CATEGORY_HOME);
            home.setFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(home);
        });
    }

    // GPS 서비스 실행 여부 확인
    @JavascriptInterface
    public String isGpsRunning() {
        return String.valueOf(activity.isGpsServiceRunning());
    }

    // 앱 환경인지 확인
    @JavascriptInterface
    public String isNativeApp() {
        return "true";
    }

    // 토스트 메시지
    @JavascriptInterface
    public void showToast(String message) {
        activity.runOnUiThread(() ->
            android.widget.Toast.makeText(context, message,
                android.widget.Toast.LENGTH_SHORT).show());
    }
}

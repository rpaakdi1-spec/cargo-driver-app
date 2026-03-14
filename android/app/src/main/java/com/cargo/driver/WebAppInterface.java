package com.cargo.driver;

import android.webkit.JavascriptInterface;
import android.util.Log;

/**
 * WebAppInterface — JS ↔ 네이티브 GPS 브릿지
 * ─────────────────────────────────────────────
 * driver.html(JS)에서 window.AndroidGPS.xxx() 로 호출합니다.
 *
 * 사용 예 (driver.js):
 *   if (window.AndroidGPS) {
 *       window.AndroidGPS.startGps(deliveryId);
 *   }
 */
public class WebAppInterface {

    private static final String TAG = "WebAppInterface";

    private final MainActivity activity;
    private final android.content.Context context;

    public WebAppInterface(android.content.Context ctx, MainActivity act) {
        this.context  = ctx;
        this.activity = act;
    }

    // ─────────────────────────────────────
    //  GPS 서비스 시작
    //  @param deliveryId  현재 배송건 ID (DB의 deliveries.id)
    // ─────────────────────────────────────
    @JavascriptInterface
    public void startGps(String deliveryId) {
        Log.d(TAG, "JS → startGps: " + deliveryId);
        activity.runOnUiThread(() -> activity.startGpsService(deliveryId));
    }

    // ─────────────────────────────────────
    //  GPS 서비스 중지 (하차 완료 시)
    // ─────────────────────────────────────
    @JavascriptInterface
    public void stopGps() {
        Log.d(TAG, "JS → stopGps");
        activity.runOnUiThread(() -> activity.stopGpsService());
    }

    // ─────────────────────────────────────
    //  배송 ID 업데이트 (배송 변경 시)
    // ─────────────────────────────────────
    @JavascriptInterface
    public void setDeliveryId(String deliveryId) {
        Log.d(TAG, "JS → setDeliveryId: " + deliveryId);
        if (activity.isGpsServiceRunning()) {
            activity.startGpsService(deliveryId); // 재시작으로 ID 업데이트
        }
    }

    // ─────────────────────────────────────
    //  GPS 서비스 실행 여부 확인
    //  @return "true" or "false" (문자열 — JS에서 파싱)
    // ─────────────────────────────────────
    @JavascriptInterface
    public String isGpsRunning() {
        return String.valueOf(activity.isGpsServiceRunning());
    }

    // ─────────────────────────────────────
    //  앱 환경인지 확인 (driver.js에서 분기용)
    //  웹: window.AndroidGPS 없음
    //  앱: window.AndroidGPS.isNativeApp() = "true"
    // ─────────────────────────────────────
    @JavascriptInterface
    public String isNativeApp() {
        return "true";
    }

    // ─────────────────────────────────────
    //  토스트 메시지 (디버깅용)
    // ─────────────────────────────────────
    @JavascriptInterface
    public void showToast(String message) {
        activity.runOnUiThread(() ->
            android.widget.Toast.makeText(context, message,
                android.widget.Toast.LENGTH_SHORT).show());
    }
}

package com.cargo.driver;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.location.Location;
import android.os.Binder;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import org.json.JSONObject;

import java.io.IOException;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * GpsService — Foreground Service
 * --------------------------------
 * - 앱이 백그라운드(네비 사용 중)여도 GPS 수신 및 서버 전송 유지
 * - 상태바에 "GPS 전송 중" 알림 표시
 * - JS Bridge(WebAppInterface)에서 시작/중지 제어
 */
public class GpsService extends Service {

    private static final String TAG            = "GpsService";
    private static final String CHANNEL_ID     = "gps_channel";
    private static final int    NOTIF_ID       = 1001;
    private static final long   UPDATE_INTERVAL = 20_000L;  // 20초마다 위치 수신
    private static final long   SERVER_INTERVAL = 30_000L;  // 30초마다 서버 전송

    // ---- 외부에서 주입 ----
    private String serverBaseUrl  = "";   // 예: https://xxxx.pages.dev
    private String deliveryId     = "";   // 현재 배송건 ID

    // ---- 내부 상태 ----
    private FusedLocationProviderClient fusedClient;
    private LocationCallback            locationCallback;
    private OkHttpClient                httpClient;

    private double lastLat = 0, lastLng = 0;
    private long   lastServerSend = 0;
    private boolean running = false;

    // ---- Binder ----
    private final IBinder binder = new LocalBinder();
    public class LocalBinder extends Binder {
        public GpsService getService() { return GpsService.this; }
    }

    // =========================================================
    //  서비스 생명주기
    // =========================================================
    @Override
    public void onCreate() {
        super.onCreate();
        fusedClient = LocationServices.getFusedLocationProviderClient(this);
        httpClient  = new OkHttpClient();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            serverBaseUrl = intent.getStringExtra("serverBaseUrl") != null
                    ? intent.getStringExtra("serverBaseUrl") : serverBaseUrl;
            deliveryId    = intent.getStringExtra("deliveryId") != null
                    ? intent.getStringExtra("deliveryId") : deliveryId;
        }
        startForeground(NOTIF_ID, buildNotification("GPS 연결 중..."));
        startLocationUpdates();
        running = true;
        Log.d(TAG, "GpsService 시작 — deliveryId=" + deliveryId);
        return START_STICKY;  // OS가 강제 종료해도 자동 재시작
    }

    @Override
    public void onDestroy() {
        stopLocationUpdates();
        running = false;
        Log.d(TAG, "GpsService 종료");
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) { return binder; }

    // =========================================================
    //  외부 제어 메서드 (WebAppInterface에서 호출)
    // =========================================================
    public void setDeliveryId(String id) {
        this.deliveryId = id;
        Log.d(TAG, "deliveryId 업데이트: " + id);
    }

    public void setServerBaseUrl(String url) {
        this.serverBaseUrl = url;
    }

    public boolean isRunning() { return running; }

    // =========================================================
    //  GPS 위치 업데이트
    // =========================================================
    private void startLocationUpdates() {
        LocationRequest req = new LocationRequest.Builder(
                Priority.PRIORITY_HIGH_ACCURACY, UPDATE_INTERVAL)
                .setMinUpdateIntervalMillis(10_000L)
                .setMaxUpdateDelayMillis(UPDATE_INTERVAL)
                .build();

        locationCallback = new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult result) {
                if (result == null) return;
                Location loc = result.getLastLocation();
                if (loc == null) return;

                lastLat = loc.getLatitude();
                lastLng = loc.getLongitude();
                int acc  = (int) loc.getAccuracy();

                // 알림 업데이트
                updateNotification(String.format("📍 %.5f, %.5f  정확도 ±%dm", lastLat, lastLng, acc));

                // 30초 쓰로틀링으로 서버 전송
                long now = System.currentTimeMillis();
                if (!deliveryId.isEmpty() && now - lastServerSend >= SERVER_INTERVAL) {
                    lastServerSend = now;
                    sendToServer(lastLat, lastLng, now);
                }
            }
        };

        try {
            fusedClient.requestLocationUpdates(req, locationCallback, Looper.getMainLooper());
        } catch (SecurityException e) {
            Log.e(TAG, "위치 권한 없음", e);
        }
    }

    private void stopLocationUpdates() {
        if (locationCallback != null) {
            fusedClient.removeLocationUpdates(locationCallback);
            locationCallback = null;
        }
    }

    // =========================================================
    //  서버 전송 (OkHttp PATCH → 실패 시 PUT)
    // =========================================================
    private void sendToServer(double lat, double lng, long timestamp) {
        if (serverBaseUrl.isEmpty() || deliveryId.isEmpty()) return;

        String url = serverBaseUrl.replaceAll("/$", "")
                + "/tables/deliveries/" + deliveryId;

        try {
            JSONObject body = new JSONObject();
            body.put("current_lat",    lat);
            body.put("current_lng",    lng);
            body.put("gps_updated_at", timestamp);
            body.put("status",         "transit");

            MediaType JSON = MediaType.get("application/json; charset=utf-8");

            // 1차: PATCH 시도
            Request patchReq = new Request.Builder()
                    .url(url)
                    .patch(RequestBody.create(body.toString(), JSON))
                    .build();

            httpClient.newCall(patchReq).enqueue(new Callback() {
                @Override
                public void onFailure(Call call, IOException e) {
                    Log.w(TAG, "PATCH 실패, PUT 재시도", e);
                    sendPut(url, body, JSON);
                }
                @Override
                public void onResponse(Call call, Response response) {
                    int code = response.code();
                    response.close();
                    if (code == 405) {
                        // PATCH 미지원 → GPS 전용 필드만 PUT
                        Log.w(TAG, "PATCH 405 → PUT 폴백");
                        sendPut(url, body, JSON);
                    } else if (!response.isSuccessful()) {
                        Log.w(TAG, "PATCH " + code + " 실패");
                        // 일시 오류 — 다음 주기에 재시도 (연쇄 실패 방지)
                    } else {
                        Log.d(TAG, "GPS 전송 성공 (PATCH)");
                    }
                }
            });
        } catch (Exception e) {
            Log.e(TAG, "sendToServer 오류", e);
        }
    }

    private void sendPut(String url, JSONObject gpsData, MediaType JSON) {
        // GET으로 기존 데이터 가져와서 머지 후 PUT
        // ★ 이미지 필드(loading_invoice_photo 등)는 반드시 제거하여 페이로드 폭증 방지
        Request getReq = new Request.Builder().url(url).get().build();
        httpClient.newCall(getReq).enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException e) {
                Log.e(TAG, "GET 실패", e);
            }
            @Override
            public void onResponse(Call call, Response response) throws IOException {
                if (!response.isSuccessful()) { response.close(); return; }
                try {
                    String bodyStr  = response.body().string();
                    response.close();
                    JSONObject merged = new JSONObject(bodyStr);

                    // ★ 이미지/대용량 필드 제거 (페이로드 폭증 방지)
                    String[] imageFields = {
                        "loading_invoice_photo", "loading_temp_photo",
                        "loading_extra_photos",  "stop_photos", "stops"
                    };
                    for (String field : imageFields) {
                        merged.remove(field);
                    }
                    // 시스템 필드 제거
                    String[] sysFields = {"id","gs_project_id","gs_table_name","created_at","updated_at"};
                    for (String field : sysFields) {
                        merged.remove(field);
                    }

                    // GPS 필드만 머지
                    java.util.Iterator<String> keys = gpsData.keys();
                    while (keys.hasNext()) {
                        String k = keys.next();
                        merged.put(k, gpsData.get(k));
                    }
                    Request putReq = new Request.Builder()
                            .url(url)
                            .put(RequestBody.create(merged.toString(), JSON))
                            .build();
                    httpClient.newCall(putReq).enqueue(new Callback() {
                        @Override public void onFailure(Call c, IOException e) {
                            Log.e(TAG, "PUT 실패", e);
                        }
                        @Override public void onResponse(Call c, Response r) {
                            Log.d(TAG, "GPS 전송 성공 (PUT) " + r.code());
                            r.close();
                        }
                    });
                } catch (Exception e) {
                    Log.e(TAG, "PUT 머지 오류", e);
                }
            }
        });
    }

    // =========================================================
    //  알림
    // =========================================================
    private void createNotificationChannel() {
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "GPS 위치 전송", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("배송 중 GPS 위치를 서버로 전송합니다");
        ch.setShowBadge(false);
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.createNotificationChannel(ch);
    }

    private Notification buildNotification(String content) {
        Intent tap = new Intent(this, MainActivity.class);
        tap.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(
                this, 0, tap, PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("🚛 화물운송 — GPS 전송 중")
                .setContentText(content)
                .setSmallIcon(R.drawable.ic_gps)
                .setContentIntent(pi)
                .setOngoing(true)          // 사용자가 직접 제거 불가
                .setForegroundServiceBehavior(
                        NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .build();
    }

    private void updateNotification(String content) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(NOTIF_ID, buildNotification(content));
    }
}

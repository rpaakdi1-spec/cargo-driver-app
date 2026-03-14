package com.cargo.driver;

import android.Manifest;
import android.app.AlertDialog;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.provider.Settings;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * MainActivity
 * ─────────────────────────────────────
 * • WebView로 driver.html 로드
 * • JS Bridge(WebAppInterface) 등록
 * • GPS/백그라운드 위치 권한 요청
 * • GpsService 바인딩 (시작/중지 제어)
 */
public class MainActivity extends AppCompatActivity {

    // ★ 배포된 기사 페이지 URL로 교체하세요
    public static final String DRIVER_URL    = "https://0a89cb78-a46a-4ebb-a43c-ddadb273ca86.vip.gensparksite.com/driver.html";
    public static final String SERVER_BASE   = "https://0a89cb78-a46a-4ebb-a43c-ddadb273ca86.vip.gensparksite.com";

    private WebView            webView;
    private SwipeRefreshLayout swipeRefresh;

    // GpsService 바인딩
    private GpsService  gpsService;
    private boolean     serviceBound = false;
    private final ServiceConnection serviceConn = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            gpsService   = ((GpsService.LocalBinder) binder).getService();
            serviceBound = true;
        }
        @Override public void onServiceDisconnected(ComponentName name) {
            serviceBound = false;
        }
    };

    // 권한 런처
    private ActivityResultLauncher<String[]> permLauncher;

    // =========================================================
    //  생명주기
    // =========================================================
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView      = findViewById(R.id.webView);
        swipeRefresh = findViewById(R.id.swipeRefresh);

        setupWebView();
        setupPermissionLauncher();
        requestAllPermissions();

        webView.loadUrl(DRIVER_URL);
    }

    @Override
    protected void onStart() {
        super.onStart();
        // GpsService에 바인딩 (이미 실행 중이면 연결)
        Intent intent = new Intent(this, GpsService.class);
        bindService(intent, serviceConn, Context.BIND_AUTO_CREATE);
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (serviceBound) {
            unbindService(serviceConn);
            serviceBound = false;
        }
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    // =========================================================
    //  WebView 설정
    // =========================================================
    private void setupWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // localStorage 사용
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);         // 웹 GPS 권한 (보조용)
        s.setAllowFileAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " CargoDriverApp/1.0");
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        // 쿠키 허용
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        // JS Bridge 등록
        webView.addJavascriptInterface(
                new WebAppInterface(this, this), "AndroidGPS");

        // WebViewClient — 외부 링크는 브라우저로
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                String url = req.getUrl().toString();
                if (url.startsWith("http") && !url.contains("gensparksite.com")) {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    return true;
                }
                return false;
            }
        });

        // WebChromeClient — 웹 GPS 권한 자동 허용 (네이티브 GPS 사용 중이므로 보조)
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(
                    String origin, GeolocationPermissions.Callback callback) {
                callback.invoke(origin, true, false);
            }
        });

        // 당겨서 새로고침
        swipeRefresh.setOnRefreshListener(() -> {
            webView.reload();
            swipeRefresh.setRefreshing(false);
        });
        swipeRefresh.setColorSchemeResources(R.color.purple_500);
    }

    // =========================================================
    //  권한 요청
    // =========================================================
    private void setupPermissionLauncher() {
        permLauncher = registerForActivityResult(
                new ActivityResultContracts.RequestMultiplePermissions(),
                results -> {
                    boolean fineGranted = Boolean.TRUE.equals(
                            results.get(Manifest.permission.ACCESS_FINE_LOCATION));
                    if (!fineGranted) {
                        showPermissionDialog();
                        return;
                    }
                    // Android 10+ 백그라운드 위치 권한 추가 요청
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        requestBackgroundPermission();
                    }
                });
    }

    private void requestAllPermissions() {
        List<String> needed = new ArrayList<>();
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.ACCESS_FINE_LOCATION);
            needed.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }
        if (!needed.isEmpty()) {
            permLauncher.launch(needed.toArray(new String[0]));
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            requestBackgroundPermission();
        }
    }

    private void requestBackgroundPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;
        if (ContextCompat.checkSelfPermission(this,
                Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                == PackageManager.PERMISSION_GRANTED) return;

        new AlertDialog.Builder(this)
            .setTitle("백그라운드 위치 권한 필요")
            .setMessage("네비 사용 중에도 GPS를 전송하려면\n"
                    + "위치 권한을 '항상 허용'으로 설정해 주세요.\n\n"
                    + "설정 → 앱 → 화물운송 기사 → 권한 → 위치 → 항상 허용")
            .setPositiveButton("설정 열기", (d, w) -> {
                Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:" + getPackageName()));
                startActivity(intent);
            })
            .setNegativeButton("나중에", null)
            .show();
    }

    private void showPermissionDialog() {
        new AlertDialog.Builder(this)
            .setTitle("GPS 권한 필요")
            .setMessage("이 앱은 배송 중 기사 위치를 전송하기 위해 GPS 권한이 필요합니다.")
            .setPositiveButton("설정 열기", (d, w) -> {
                Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:" + getPackageName()));
                startActivity(intent);
            })
            .setNegativeButton("종료", (d, w) -> finish())
            .show();
    }

    // =========================================================
    //  GpsService 제어 (WebAppInterface에서 호출)
    // =========================================================
    public void startGpsService(String deliveryId) {
        Intent intent = new Intent(this, GpsService.class);
        intent.putExtra("serverBaseUrl", SERVER_BASE);
        intent.putExtra("deliveryId",    deliveryId);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent);
        } else {
            startService(intent);
        }
        // 바인딩도 갱신
        if (serviceBound && gpsService != null) {
            gpsService.setDeliveryId(deliveryId);
            gpsService.setServerBaseUrl(SERVER_BASE);
        }
    }

    public void stopGpsService() {
        stopService(new Intent(this, GpsService.class));
    }

    public boolean isGpsServiceRunning() {
        return serviceBound && gpsService != null && gpsService.isRunning();
    }

    // WebView에 JS 실행 (메인 스레드에서)
    public void runJs(String js) {
        runOnUiThread(() -> webView.evaluateJavascript(js, null));
    }
}

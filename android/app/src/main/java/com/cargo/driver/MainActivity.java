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
import android.provider.MediaStore;
import android.provider.Settings;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import java.io.File;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * MainActivity
 * ─────────────────────────────────────
 * • WebView로 driver.html 로드
 * • JS Bridge(WebAppInterface) 등록
 * • GPS/백그라운드 위치 권한 요청
 * • 카메라/파일선택 권한 및 onShowFileChooser 처리
 * • Android 13+ 알림 권한 요청
 * • GpsService 바인딩 (시작/중지 제어)
 */
public class MainActivity extends AppCompatActivity {

    // ★ 배포된 기사 페이지 URL
    public static final String DRIVER_URL  = "https://0a89cb78-a46a-4ebb-a43c-ddadb273ca86.vip.gensparksite.com/driver.html";
    public static final String SERVER_BASE = "https://0a89cb78-a46a-4ebb-a43c-ddadb273ca86.vip.gensparksite.com";

    private WebView            webView;
    private SwipeRefreshLayout swipeRefresh;

    // ─── 파일 선택 (input[type=file]) ───────────────────────
    private ValueCallback<Uri[]>  filePathCallback;
    private Uri                   cameraImageUri;

    private ActivityResultLauncher<Intent> fileChooserLauncher;
    private ActivityResultLauncher<Uri>    cameraLauncher;

    // ─── GpsService 바인딩 ───────────────────────────────────
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

    // ─── 권한 런처 ───────────────────────────────────────────
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

        registerFileLaunchers();
        setupWebView();
        setupPermissionLauncher();
        requestAllPermissions();

        webView.loadUrl(DRIVER_URL);
    }

    @Override
    protected void onStart() {
        super.onStart();
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
    //  파일 선택 런처 등록
    // =========================================================
    private void registerFileLaunchers() {
        // 갤러리/파일 선택 결과 처리
        fileChooserLauncher = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(),
            result -> {
                if (filePathCallback == null) return;
                Uri[] results = null;
                if (result.getResultCode() == RESULT_OK) {
                    if (result.getData() != null) {
                        // 갤러리 선택 결과
                        String dataStr = result.getData().getDataString();
                        if (dataStr != null) {
                            results = new Uri[]{Uri.parse(dataStr)};
                        } else if (result.getData().getClipData() != null) {
                            int count = result.getData().getClipData().getItemCount();
                            results = new Uri[count];
                            for (int i = 0; i < count; i++) {
                                results[i] = result.getData().getClipData().getItemAt(i).getUri();
                            }
                        }
                    }
                    // ★ 카메라 촬영 시 getData()가 null — EXTRA_OUTPUT으로 저장된 URI 사용
                    if ((results == null || results.length == 0) && cameraImageUri != null) {
                        results = new Uri[]{cameraImageUri};
                    }
                }
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
                cameraImageUri = null;
            }
        );

        // 카메라 촬영 결과 처리
        cameraLauncher = registerForActivityResult(
            new ActivityResultContracts.TakePicture(),
            success -> {
                if (filePathCallback == null) return;
                if (success && cameraImageUri != null) {
                    filePathCallback.onReceiveValue(new Uri[]{cameraImageUri});
                } else {
                    filePathCallback.onReceiveValue(new Uri[]{});
                }
                filePathCallback = null;
                cameraImageUri = null;
            }
        );
    }

    // =========================================================
    //  WebView 설정
    // =========================================================
    private void setupWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setAllowFileAccess(true);            // 파일 선택을 위해 true
        s.setAllowContentAccess(true);         // Content URI 접근
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " CargoDriverApp/1.0");
        s.setCacheMode(WebSettings.LOAD_DEFAULT); // 기본 캐시 모드 — LOAD_NO_CACHE는 fetch 차단 가능성

        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(
            new WebAppInterface(this, this), "AndroidGPS");

        // ─── WebViewClient ────────────────────────────────────
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                // ★ fetch/XHR은 절대 가로채지 않음 — 네비게이션(링크 클릭)만 처리
                if (req.isForMainFrame()) {
                    String url = req.getUrl().toString();
                    if (url.startsWith("http") && !url.contains("gensparksite.com")) {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                        return true;
                    }
                }
                return false;
            }
        });

        // ─── WebChromeClient (파일 선택 + GPS 권한) ───────────
        webView.setWebChromeClient(new WebChromeClient() {

            // ★★★ 핵심: input[type=file] 처리 ★★★
            @Override
            public boolean onShowFileChooser(
                    WebView webView,
                    ValueCallback<Uri[]> filePathCallback,
                    FileChooserParams fileChooserParams) {

                // 이전 콜백 있으면 취소
                if (MainActivity.this.filePathCallback != null) {
                    MainActivity.this.filePathCallback.onReceiveValue(null);
                }
                MainActivity.this.filePathCallback = filePathCallback;

                // 카메라 촬영 인텐트 생성
                Intent cameraIntent = null;
                Uri photoUri = createImageUri();
                if (photoUri != null) {
                    cameraImageUri = photoUri;
                    cameraIntent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                    cameraIntent.putExtra(MediaStore.EXTRA_OUTPUT, photoUri);
                }

                // 갤러리/파일 선택 인텐트
                Intent galleryIntent = new Intent(Intent.ACTION_GET_CONTENT);
                galleryIntent.setType("image/*");
                galleryIntent.addCategory(Intent.CATEGORY_OPENABLE);
                galleryIntent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);

                // 촬영 + 갤러리 선택 통합 다이얼로그
                Intent chooser;
                if (cameraIntent != null) {
                    chooser = Intent.createChooser(galleryIntent, "사진 선택");
                    chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{cameraIntent});
                } else {
                    chooser = Intent.createChooser(galleryIntent, "사진 선택");
                }

                fileChooserLauncher.launch(chooser);
                return true;
            }

            // GPS 권한 자동 허용
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

    /** 카메라 촬영용 임시 URI 생성 */
    private Uri createImageUri() {
        try {
            String timeStamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault())
                    .format(new Date());
            File storageDir = getExternalCacheDir();
            File imageFile  = File.createTempFile("IMG_" + timeStamp, ".jpg", storageDir);
            return FileProvider.getUriForFile(this,
                    getPackageName() + ".fileprovider", imageFile);
        } catch (IOException e) {
            return null;
        }
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
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    requestBackgroundPermission();
                }
            });
    }

    private void requestAllPermissions() {
        List<String> needed = new ArrayList<>();

        // GPS 권한
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.ACCESS_FINE_LOCATION);
            needed.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }

        // 카메라 권한
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.CAMERA);
        }

        // Android 13+ 알림 권한
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this,
                    Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.POST_NOTIFICATIONS);
            }
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

    public void runJs(String js) {
        runOnUiThread(() -> webView.evaluateJavascript(js, null));
    }
}

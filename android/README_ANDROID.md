# 화물운송 기사 Android 앱

## 개요
기사용 GPS 추적 앱. WebView로 기존 `driver.html`을 표시하면서,  
**Foreground Service**로 백그라운드에서도 GPS를 계속 서버에 전송합니다.  
네비 앱 사용 중, 화면 꺼짐, 다른 앱 전환 중에도 GPS가 끊기지 않습니다.

---

## 빌드 전 필수 설정

### 1. 서버 URL 변경
`android/app/src/main/java/com/cargo/driver/MainActivity.java` 파일의 2줄을 수정하세요:

```java
// ★ 아래 두 줄을 실제 배포 URL로 교체
public static final String DRIVER_URL  = "https://YOUR_DOMAIN.pages.dev/driver.html";
public static final String SERVER_BASE = "https://YOUR_DOMAIN.pages.dev";
```

예시:
```java
public static final String DRIVER_URL  = "https://cargo-abc123.pages.dev/driver.html";
public static final String SERVER_BASE = "https://cargo-abc123.pages.dev";
```

---

## 빌드 방법

### 환경 준비
- **Android Studio** 최신 버전 설치 (Hedgehog 이상 권장)
- **JDK 17** 이상
- **Android SDK** API 34 설치

### 빌드 순서

```bash
# 1. android/ 폴더를 Android Studio로 열기
#    File → Open → android/ 폴더 선택

# 2. Gradle Sync 완료 대기

# 3. APK 빌드
#    Build → Build Bundle(s) / APK(s) → Build APK(s)

# 4. 생성된 APK 위치
#    android/app/build/outputs/apk/debug/app-debug.apk
```

### 명령줄 빌드 (선택)
```bash
cd android
./gradlew assembleDebug
# APK: app/build/outputs/apk/debug/app-debug.apk
```

---

## 기사 폰에 설치하는 방법

### 방법 A — USB 케이블 (개발자 모드)
1. 기사 폰 → 설정 → 소프트웨어 정보 → 빌드번호 7번 탭 → 개발자 옵션 활성화
2. 설정 → 개발자 옵션 → USB 디버깅 ON
3. PC에 USB 연결
4. `adb install app-debug.apk`

### 방법 B — APK 파일 직접 전송 (가장 간단)
1. `app-debug.apk` 파일을 카카오톡 등으로 폰에 전송
2. 폰에서 파일 열기
3. "출처를 알 수 없는 앱" 허용 → 설치

### 방법 C — Google Play 내부 테스트 (배포용)
- Google Play Console → 내부 테스트 트랙 → APK 업로드 → 기사 이메일 초대

---

## 앱 최초 실행 시 권한 설정

앱 실행 후 아래 권한을 반드시 허용해야 합니다:

| 권한 | 설정 값 | 이유 |
|---|---|---|
| 위치 | **항상 허용** | 네비 사용 중 백그라운드 GPS |
| 알림 | 허용 | Foreground Service 상태바 표시 |

> ⚠️ "앱 사용 중에만 허용"으로 설정하면 네비 사용 시 GPS가 중단됩니다.  
> 반드시 **"항상 허용"** 으로 설정해 주세요.

**위치 권한 "항상 허용" 설정 경로:**  
설정 → 앱 → 화물운송 기사 → 권한 → 위치 → **항상 허용**

---

## 동작 방식

```
[기사가 업무 시작 클릭]
        ↓
[driver.html JS] → window.AndroidGPS.startGps(deliveryId)
        ↓
[GpsService 시작] → Foreground Service (상태바에 알림 표시)
        ↓
[FusedLocationProvider] → 20초마다 GPS 수신
        ↓
[OkHttp] → 30초마다 서버 PATCH (current_lat, current_lng)
        ↓
[네비 앱 켜도 GPS 계속 전송 ✅]
[화면 꺼져도 GPS 계속 전송 ✅]
[다른 앱 전환해도 GPS 계속 전송 ✅]
        ↓
[기사가 하차완료 클릭]
        ↓
[driver.html JS] → window.AndroidGPS.stopGps()
        ↓
[GpsService 중지] ← 상태바 알림 사라짐
```

---

## 파일 구조

```
android/
├── build.gradle                          # 루트 빌드 설정
├── settings.gradle                       # 프로젝트 설정
├── gradle.properties                     # Gradle 옵션
└── app/
    ├── build.gradle                      # 앱 의존성 (OkHttp, FusedLocation 등)
    └── src/main/
        ├── AndroidManifest.xml           # 권한, 서비스 등록
        ├── java/com/cargo/driver/
        │   ├── MainActivity.java         # WebView + 권한 요청
        │   ├── GpsService.java           # ★ Foreground GPS 서비스
        │   └── WebAppInterface.java      # JS ↔ 네이티브 브릿지
        └── res/
            ├── layout/activity_main.xml  # WebView 레이아웃
            ├── values/strings.xml        # 앱 이름
            ├── values/themes.xml         # 테마/색상
            └── drawable/ic_gps.xml       # GPS 아이콘
```

---

## 웹 driver.js와의 연동

`driver.js`는 `window.AndroidGPS` 존재 여부로 앱/웹 환경을 자동 감지합니다:

```javascript
// 앱 환경 → Foreground Service GPS 사용
if (window.AndroidGPS && currentDelivery) {
    window.AndroidGPS.startGps(currentDelivery.id);
}

// 웹 환경 → 기존 watchPosition 방식
else {
    navigator.geolocation.watchPosition(...);
}
```

별도 코드 수정 없이 **웹과 앱 양쪽에서 동일하게 동작**합니다.

---

## 자주 묻는 질문

**Q. GPS가 안 잡혀요**  
A. 설정 → 앱 → 화물운송 기사 → 권한 → 위치 → "항상 허용" 확인

**Q. 앱이 갑자기 꺼져요**  
A. 설정 → 배터리 → 앱별 배터리 사용 → 화물운송 기사 → "제한 없음" 설정  
(삼성: 설정 → 배터리 및 디바이스 케어 → 배터리 → 백그라운드 사용 제한 → 화물운송 기사 제외)

**Q. 상태바 알림이 없어도 GPS가 전송되나요?**  
A. 아니오. Foreground Service는 반드시 알림이 표시되어야 동작합니다 (Android 정책).  
알림을 없애면 서비스가 백그라운드 서비스로 전환되어 언제든 종료될 수 있습니다.

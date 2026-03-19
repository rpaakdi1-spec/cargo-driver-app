# 화물운송 기사 앱 — 접속 URL & APK 배포 가이드

> 최종 업데이트: 2025-03-19

---

## 📌 서비스 접속 URL

| 역할 | URL | 비고 |
|------|-----|------|
| 🏠 **메인 (역할 선택)** | `https://0a89cb78-a46a-4ebb-a43c-ddadb273ca86.vip.gensparksite.com` | 누구나 접속 |
| 🛡️ **관리자** | `https://0a89cb78-a46a-4ebb-a43c-ddadb273ca86.vip.gensparksite.com/admin.html` | 비밀번호: `rhkdtls1` |
| 🏢 **고객사 룸** | `https://0a89cb78-a46a-4ebb-a43c-ddadb273ca86.vip.gensparksite.com/room.html?id=ROOM_ID` | 룸 비밀번호 |
| 🚛 **기사 업무** | `https://0a89cb78-a46a-4ebb-a43c-ddadb273ca86.vip.gensparksite.com/driver.html` | 기사명 + PIN |
| 🖼️ **사진 보관함** | `https://0a89cb78-a46a-4ebb-a43c-ddadb273ca86.vip.gensparksite.com/gallery.html` | 비밀번호: `rhkdtls1` |
| 📱 **QR 코드** | `https://0a89cb78-a46a-4ebb-a43c-ddadb273ca86.vip.gensparksite.com/qr.html` | 누구나 접속 |
| 📖 **사용법 안내** | `https://0a89cb78-a46a-4ebb-a43c-ddadb273ca86.vip.gensparksite.com/guide.html` | 누구나 접속 |

---

## 📱 기사 앱 (Android APK) — GitHub Actions 자동 빌드

### APK 빌드 방법 (GitHub Actions)

```
[소스 코드]  →  [GitHub 저장소 push]  →  [Actions 자동 빌드]  →  [APK 다운로드]
```

#### 1단계: 코드 변경 후 GitHub에 push
```bash
git add .
git commit -m "기능 업데이트"
git push origin main
```
→ GitHub Actions가 **자동으로 APK 빌드** 시작 (약 5~7분 소요)

#### 2단계: APK 다운로드
1. GitHub 저장소 → **Actions** 탭
2. 최신 "Build Android APK" 워크플로우 클릭
3. 하단 **Artifacts** 섹션 → **화물운송기사앱** 클릭 → ZIP 다운로드
4. ZIP 압축 해제 → `app-debug.apk` 파일 확인

---

## 📲 기사님 폰에 APK 설치 방법

### 방법 1: 카카오톡으로 전송 (권장)
```
1. app-debug.apk 파일을 카카오톡으로 기사님께 전송
2. 기사님 폰에서 카카오톡 파일 다운로드
3. 파일 탭에서 APK 파일 클릭
4. "알 수 없는 출처 앱 설치" → 허용
5. 설치 완료
```

### 방법 2: 구글 드라이브로 공유
```
1. APK를 구글 드라이브에 업로드
2. 링크 공유 → 기사님에게 전송
3. 기사님이 링크 접속 → 다운로드 → 설치
```

---

## ⚙️ 설치 후 필수 권한 설정 (기사님 폰)

> ⚠️ 이 설정을 안 하면 GPS가 네비 중에 꺼집니다!

### 위치 권한 — "항상 허용" 설정
```
설정 → 앱 → 화물운송 기사 → 권한 → 위치
→ "앱 사용 중에만 허용" ❌
→ "항상 허용" ✅  ← 이것 선택!
```

### 배터리 최적화 해제 (삼성 기준)
```
설정 → 배터리 → 앱별 배터리 관리
→ 화물운송 기사 → "제한 없음" 선택
```

### 자동 시작 허용 (삼성 기준)
```
설정 → 앱 → 화물운송 기사 → 배터리
→ "백그라운드에서 앱 활동 허용" ON
```

---

## 🔄 앱 업데이트 배포 절차

웹사이트(driver.html, utils.js 등)가 업데이트되면:

### 웹사이트만 변경된 경우
```
1. Genspark Publish 탭에서 재배포
   → 앱은 WebView로 최신 URL을 로드하므로 자동 반영
   → APK 재설치 불필요 ✅
```

### APK 자체 변경이 필요한 경우 (네이티브 코드 수정 시)
```
1. android/ 폴더 내 Java 파일 수정
2. GitHub에 push
3. Actions에서 APK 빌드 완료 대기 (5~7분)
4. 새 APK 다운로드
5. 기사님 폰에 재설치 (기존 앱 위에 덮어씌워도 됨)
```

---

## 🏗️ 앱 구조

```
android/
├── .github/workflows/build.yml     ← GitHub Actions 자동 빌드
├── build.gradle                    ← 루트 Gradle 설정
├── settings.gradle                 ← 모듈 설정
├── gradle.properties
├── gradlew                         ← Gradle Wrapper
└── app/
    ├── build.gradle                ← 앱 Gradle 설정 (SDK, 의존성)
    └── src/main/
        ├── AndroidManifest.xml     ← 권한 선언, 서비스 등록
        ├── java/com/cargo/driver/
        │   ├── MainActivity.java   ← WebView + 권한 요청
        │   ├── GpsService.java     ← 백그라운드 GPS 포그라운드 서비스
        │   └── WebAppInterface.java← JS ↔ 네이티브 브릿지
        └── res/
            ├── layout/activity_main.xml
            ├── values/strings.xml
            ├── values/themes.xml
            └── drawable/ic_gps.xml
```

---

## 🌐 앱에 설정된 URL

`MainActivity.java`에 하드코딩된 URL:
```java
public static final String DRIVER_URL  = "https://0a89cb78-a46a-4ebb-a43c-ddadb273ca86.vip.gensparksite.com/driver.html";
public static final String SERVER_BASE = "https://0a89cb78-a46a-4ebb-a43c-ddadb273ca86.vip.gensparksite.com";
```

URL이 변경되면 이 두 줄만 수정 후 재빌드하면 됩니다.

---

## 📋 JS ↔ 네이티브 브릿지 (WebAppInterface)

기사 웹페이지(driver.html)에서 아래 함수로 네이티브 기능 호출:

| JS 호출 | 동작 |
|---------|------|
| `window.AndroidGPS.startGps(deliveryId)` | 백그라운드 GPS 포그라운드 서비스 시작 |
| `window.AndroidGPS.stopGps()` | GPS 서비스 중지 |
| `window.AndroidGPS.setDeliveryId(id)` | 배송 ID 업데이트 |
| `window.AndroidGPS.moveToBackground()` | 홈 화면으로 이동 (앱 최소화) |
| `window.AndroidGPS.isGpsRunning()` | GPS 실행 여부 반환 (`"true"/"false"`) |
| `window.AndroidGPS.isNativeApp()` | 앱 환경 여부 반환 (`"true"`) |
| `window.AndroidGPS.showToast(msg)` | 안드로이드 토스트 메시지 표시 |

---

## 🆚 웹 브라우저 vs 앱 차이점

| 기능 | 웹 브라우저 | Android 앱 |
|------|------------|------------|
| GPS 백그라운드 유지 | ❌ 꺼짐 (네비 사용 시) | ✅ 항상 유지 |
| 화면 꺼짐 후 GPS | ❌ 중단될 수 있음 | ✅ 계속 작동 |
| 앱 강제 종료 후 | ❌ 중단 | ✅ START_STICKY로 재시작 |
| 상차완료 → 홈 전환 | ⚠️ intent:// 시도 | ✅ 즉시 홈으로 이동 |
| 상태바 알림 | ❌ 없음 | ✅ "GPS 전송 중 📍위도,경도" |
| 설치 방법 | URL 접속 | APK 설치 |

---

## 🔧 로컬 빌드 방법 (Android Studio)

GitHub Actions 없이 직접 빌드하려면:

```bash
# 1. Android Studio 설치
#    https://developer.android.com/studio

# 2. 프로젝트 열기
#    File → Open → android/ 폴더 선택

# 3. Gradle sync 완료 대기 (2~3분)

# 4. APK 빌드
#    Build → Build Bundle(s) / APK(s) → Build APK(s)

# 5. APK 위치
#    android/app/build/outputs/apk/debug/app-debug.apk
```

---

## ❓ 자주 묻는 문제

### Q. APK 설치 시 "파싱 오류"가 나요
- Android 7.0 미만 기기는 미지원
- 파일이 완전히 다운로드됐는지 확인

### Q. GPS가 계속 꺼져요
- 위치 권한 → **"항상 허용"** 재확인
- 배터리 최적화 → **"제한 없음"** 재확인
- 앱 재시작 후 GPS 시작 버튼 수동 클릭

### Q. "알 수 없는 출처 앱" 경고가 나요
- 정상입니다. Google Play 미등록 앱이므로 직접 설치(사이드로딩) 시 표시됩니다.
- "그래도 설치" 또는 "허용" 클릭하면 됩니다.

### Q. 앱 업데이트 후 기존 데이터가 사라지나요
- 아니요. 데이터는 서버 DB에 저장됩니다.
- APK 재설치 시 기존 앱 위에 덮어씌우면 로그인 상태도 유지됩니다.

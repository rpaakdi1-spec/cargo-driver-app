/* ===========================
   기사 페이지 JS - driver.js
   v20250321AF
   - 촬영 즉시 자동업로드
   - 수정 버튼 (재촬영)
   - GPS 지속 유지 + 자동 재시도
   - 웹창 닫아도 GPS 유지 (localStorage 복원)
   - 상차완료 시 자동 백그라운드 전환 + Wake Lock
   - 저속(15km/h 미만 40분) 알림 / 상차 4시간 경과 알림
   - 도착하차대기 버튼 + 추가사진(물품/현장사진) 업로드
=========================== */

let currentDriverName = null;
let currentDelivery   = null;
let gpsWatchId        = null;
let gpsRetryTimer     = null;
let gpsKeepAlive      = false; // 하차 미완료 시 GPS 강제 유지

// 다중 하차 stops 배열
let stops = [];

// ★ 추가사진 배열 { section:'loading'|'stop_N', photos:[{url,caption,ts}] }
// loading 섹션: loadingExtraPhotos[]
// stop 섹션: stops[idx].extra_photos[]
let loadingExtraPhotos = [];  // 상차 추가사진

// Wake Lock (화면 꺼짐 방지)
let wakeLock = null;

// 백그라운드 GPS 카운터
let bgGpsInterval = null;
let bgGpsSeconds  = 0;
let isBackground  = false;

// ★ 파일선택(카메라/갤러리)이 열려있을 때 visibilitychange로 GPS가 재시작되지 않도록 플래그
let filePickerOpen = false;
let _filePickerOpenTimer = null; // 안전장치: filePickerOpen이 오래 true면 자동 초기화

/** filePickerOpen을 true로 설정하고 30초 후 자동 초기화 안전장치 */
function setFilePickerOpen(val) {
    filePickerOpen = val;
    if (_filePickerOpenTimer) { clearTimeout(_filePickerOpenTimer); _filePickerOpenTimer = null; }
    if (val) {
        // Android에서 onchange가 발생 안 해도 30초 후 자동 해제
        _filePickerOpenTimer = setTimeout(() => {
            filePickerOpen = false;
            _filePickerOpenTimer = null;
            console.warn('[filePickerOpen] 30초 타임아웃 — 자동 해제');
        }, 30000);
    }
}

// ★ GPS 위치 요청 폴링 (화주가 요청 시 즉시 전송)
let gpsRequestPollTimer = null;
let lastKnownRequestAt  = 0;  // 마지막으로 처리한 요청 시각

// ★ 사진 촬영 요청 폴링 (화주가 요청 시 기사 앱에 알림)
let photoRequestPollTimer = null;
let lastKnownPhotoRequestAt = 0;

// ★ 세션 유효성 폴링 (방/배송건 삭제 감지 → GPS 자동 종료)
let sessionValidPollTimer = null;

// ★ 저속 감지 + 상차 4시간 초과 알림 타이머
let alertCheckTimer       = null;
let lowSpeedStartAt       = null;   // 저속 시작 시각
let lowSpeedAlertAt       = null;   // 저속 알림 마지막 발송 시각
let loadedAlertAt         = null;   // 상차초과 알림 마지막 발송 시각

const LOW_SPEED_THRESHOLD  = 15;               // km/h 미만
const LOW_SPEED_DURATION   = 40 * 60 * 1000;  // 40분 (최초 발동 기준)
const LOADED_ALERT_DELAY   = 4 * 60 * 60 * 1000; // 4시간 (최초 발동 기준)
const REPEAT_INTERVAL      = 5 * 60 * 1000;   // 반복 알림 간격 5분

/* =====================
   커스텀 확인 모달 (Android WebView confirm() 대체)
   ===================== */
function showConfirm(message, okLabel, dangerOk) {
    return new Promise(resolve => {
        const modal    = document.getElementById('confirmModal');
        const msgEl    = document.getElementById('confirmModalMsg');
        const okBtn    = document.getElementById('confirmModalOk');
        const cancelBtn = document.getElementById('confirmModalCancel');
        if (!modal) { resolve(window.confirm(message)); return; }

        msgEl.textContent = message;
        okBtn.textContent = okLabel || '확인';
        okBtn.style.background = dangerOk ? '#ef4444' : '#0891b2';
        modal.style.display = 'flex';

        function cleanup() {
            modal.style.display = 'none';
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
        }
        function onOk()     { cleanup(); resolve(true);  }
        function onCancel() { cleanup(); resolve(false); }
        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
    });
}

/* =====================
   localStorage 세션 헬퍼
   (탭을 닫아도 유지 — 하차완료 시 자동 삭제)
   ===================== */
const LS_SESSION = 'driver_ls_session'; // { driverName, pinHash, timestamp }
const LS_WORK    = 'driver_ls_work';    // { deliveryId, timestamp }

function lsSaveSession(name, pinHash) {
    localStorage.setItem(LS_SESSION, JSON.stringify({ driverName: name, pinHash, timestamp: Date.now() }));
}
function lsSaveWork(deliveryId) {
    localStorage.setItem(LS_WORK, JSON.stringify({ deliveryId, timestamp: Date.now() }));
}
function lsGetSession() {
    try { return JSON.parse(localStorage.getItem(LS_SESSION)); } catch { return null; }
}
function lsGetWork() {
    try { return JSON.parse(localStorage.getItem(LS_WORK)); } catch { return null; }
}
function lsClearWork() { localStorage.removeItem(LS_WORK); }
function lsClearAll()  { localStorage.removeItem(LS_SESSION); localStorage.removeItem(LS_WORK); }

/* =====================
   초기화
   ===================== */
document.addEventListener('DOMContentLoaded', async () => {
    // ★ 로그인 버튼 최초 등록
    _bindLoginBtn();
    // ★ 알림 권한 요청 — 네이티브 앱(AndroidGPS 브릿지)이면 호출하지 않음
    // (WebView에서 Notification.requestPermission()을 호출하면 시스템 알림이 기사 앱에 뜨는 문제)
    if ('Notification' in window &&
        Notification.permission === 'default' &&
        !(window.AndroidGPS && typeof window.AndroidGPS.isNativeApp === 'function')) {
        Notification.requestPermission();
    }

    // URL 파라미터로 UVIS 계정 자동 저장 (관리자가 생성한 링크로 접속 시)
    const urlParams = new URLSearchParams(window.location.search);
    const uvisParam  = urlParams.get('uvis');
    const imgbbParam = urlParams.get('imgbb');

    if (uvisParam) {
        try {
            const decoded = JSON.parse(atob(decodeURIComponent(uvisParam)));
            if (decoded.u && decoded.p) {
                setUvisCredentials(decoded.u, decoded.p);
                showToast('✅ UVIS 서버 업로드 설정이 완료되었습니다.', 'success', 3000);
            }
        } catch(e) { console.warn('[driver] UVIS 파라미터 파싱 실패:', e); }
        window.history.replaceState({}, '', window.location.pathname);
    } else if (imgbbParam) {
        // 구버전 imgBB 링크 호환
        setImgBBKey(imgbbParam);
        window.history.replaceState({}, '', window.location.pathname);
        showToast('✅ 이미지 업로드 설정이 완료되었습니다.', 'success', 3000);
    }

    // 1) 기존 sessionStorage 세션 유지 (동일 탭 내)
    try {
        const sessionSaved = Session.get('driver_session');
        if (sessionSaved && sessionSaved.driverName && (Date.now() - sessionSaved.timestamp < 12 * 60 * 60 * 1000)) {
            currentDriverName = sessionSaved.driverName;
            const valid = await verifyDriverSession(sessionSaved.driverName, sessionSaved.pinHash);
            if (valid) { await restoreWorkOrShowSelect(); return; }
            // valid=false → _forceLogout()이 showPinSection() 호출하므로 return
            return;
        }
        // 2) localStorage 세션 복원 (탭 닫고 재접속)
        const lsSaved = lsGetSession();
        if (lsSaved && lsSaved.driverName && (Date.now() - lsSaved.timestamp < 12 * 60 * 60 * 1000)) {
            currentDriverName = lsSaved.driverName;
            const valid = await verifyDriverSession(lsSaved.driverName, lsSaved.pinHash);
            if (valid) {
                Session.set('driver_session', { driverName: lsSaved.driverName, pinHash: lsSaved.pinHash, timestamp: Date.now() });
                await restoreWorkOrShowSelect();
                return;
            }
            return;
        }
    } catch (initErr) {
        // 세션 복원 중 어떤 오류가 나도 반드시 로그인 화면 표시
        console.error('[driver] 세션 복원 오류:', initErr);
    }
    showPinSection();
});

/* ================================================
   ★ 세션 유효성 서버 재검증
   - 재접속 시 기사 PIN이 DB에 여전히 유효한지 확인
   - 배송건이 0건 이거나 방이 삭제된 경우 → 세션 초기화 후 PIN 화면
   ================================================ */
async function verifyDriverSession(driverName, pinHash) {
    try {
        const data = await apiGetList('tables/deliveries?limit=500');
        const all  = data.data || [];

        // ★ 이름 일치하는 배송건이 하나라도 있으면 유효 (delivered 포함)
        const anyMatch = all.some(d =>
            d.driver_name &&
            d.driver_name.replace(/\s/g, '') === driverName.replace(/\s/g, '')
        );

        if (!anyMatch) {
            // 이 기사 이름으로 등록된 배송건 자체가 없음 → 방이 삭제됐거나 기사 정보 삭제
            console.warn('[verifyDriverSession] 기사 배송건 없음 → 세션 초기화');
            showToast('⚠️ 등록된 배송 정보가 없습니다. 다시 로그인해주세요.', 'error', 4000);
            _forceLogout();
            return false;
        }
        return true; // 유효한 세션
    } catch (e) {
        // 네트워크 오류 시 세션 유지 (서버 일시 장애 대응)
        console.warn('[verifyDriverSession] 서버 확인 실패, 세션 유지:', e);
        return true;
    }
}

/* 강제 로그아웃 (세션만 초기화, 토스트 없음) */
function _forceLogout() {
    gpsKeepAlive = false;
    stopGPS();
    stopGpsRequestPoll();
    stopPhotoRequestPoll();
    stopSessionValidPoll();  // ★ 세션 유효성 폴링 중지
    stopAlertCheck();
    currentDriverName = null;
    currentDelivery   = null;
    stops = [];
    Session.remove('driver_session');
    lsClearAll();
    const ne = document.getElementById('pinDriverName');
    const ce = document.getElementById('pinCode');
    if (ne) ne.value = '';
    if (ce) ce.value = '';
    const form = document.getElementById('driverPinForm');
    if (form) form.dataset.bound = '';
    showPinSection();
}

/* 업무 중이던 배송건 자동 복원 또는 배송 선택 화면 이동 */
async function restoreWorkOrShowSelect() {
    const lsWork = lsGetWork();
    if (lsWork && lsWork.deliveryId && (Date.now() - lsWork.timestamp < 12 * 60 * 60 * 1000)) {
        // 업무 중이던 배송건 자동 복원 시도
        try {
            const delivery = await apiGet(`tables/deliveries/${lsWork.deliveryId}`);
            const parsedStops = restoreStopPhotos(parseStops(delivery.stops), delivery);
            const allDone     = parsedStops.length > 0 && parsedStops.every(s => s.delivered_at);
            if (!allDone && delivery.status !== 'delivered') {
                // 아직 하차 미완료 → 업무화면 자동 복원
                currentDelivery = delivery;
                stops = parsedStops;
                gpsKeepAlive = true;
                initSelectEventListeners(); // ★ 버튼 바인딩 먼저
                renderWorkScreen();
                showWorkSection();
                setTimeout(() => {
                    startGPS();
                    startGpsRequestPoll();    // ★ 위치 요청 폴링
                    startPhotoRequestPoll();  // ★ 사진 요청 폴링
                    startSessionValidPoll();  // ★ 방/배송건 삭제 감지 폴링
                    startAlertCheck();        // ★ 저속/상차시간 알림
                    showToast('📍 이전 업무 복원! GPS 자동 재시작됩니다.', 'success');
                }, 800);
                return;
            } else {
                // 배송 완료된 경우에만 세션 삭제
                lsClearWork();
            }
        } catch (e) {
            // ★ 네트워크 오류 / 서버 오류 시 세션 유지 (기존 방 초기화 방지)
            // 404(배송건 삭제)인 경우에만 세션 삭제
            const isNotFound = e.message && (e.message.includes('404') || e.message.includes('not found'));
            if (isNotFound) {
                console.warn('배송건이 삭제됨, 세션 초기화:', e);
                lsClearWork();
            } else {
                // 일시적 오류 — 세션 유지하고 선택 화면으로 이동 (세션 삭제 안 함)
                console.warn('업무 복원 일시 실패 (세션 유지), 배송 선택 화면으로 이동:', e);
                showToast('⚠️ 업무 복원 실패. 배송건을 다시 선택해주세요.', 'error', 4000);
            }
        }
    }
    showSelectSection();
}

// ★ 네비 앱 / 다른 탭 전환 후 복귀 시 GPS 자동 재시작
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        // 백그라운드로 전환됨
        isBackground = true;
        startBgCounter();
        // ★ 파일 선택(카메라/갤러리) 또는 다른 앱 전환 모두 여기서 감지
        // filePickerOpen=true 로 설정해두면 복귀 시 GPS 재시작 억제
        // onchange가 발생하면 setFilePickerOpen(false) 로 해제됨
        // onchange가 발생 안 해도 30초 타임아웃으로 자동 해제(setFilePickerOpen 내부)
        setFilePickerOpen(true);

    } else if (document.visibilityState === 'visible') {
        // 포그라운드로 복귀
        isBackground = false;
        stopBgCounter();

        // ★ 파일 선택(카메라/갤러리)으로 인한 복귀면 GPS 재시작 건너뜀
        // filePickerOpen은 visibilitychange(hidden) 에서 true로 설정되고
        // onchange 이벤트 발생 시 setFilePickerOpen(false) 로 해제됨
        // onchange 미발생 시에도 30초 타임아웃으로 자동 해제됨
        if (filePickerOpen) {
            // Wake Lock만 재획득하고 GPS 재시작은 건너뜀
            if (gpsKeepAlive) requestWakeLock();
            return;
        }

        if (gpsKeepAlive) {
            // GPS watchId가 살아있어도 일부 브라우저에서 중단되므로 무조건 재시작
            if (gpsWatchId !== null) {
                navigator.geolocation.clearWatch(gpsWatchId);
                gpsWatchId = null;
            }
            clearGpsRetry();
            startGPS();
            showToast('📍 GPS 재연결됨', 'success');
        }

        // Wake Lock 재획득 (포그라운드 복귀 후)
        if (gpsKeepAlive) requestWakeLock();
    }
});

// ★ iOS Safari: 페이지 재활성화 시 GPS 재시작 (visibilitychange 미지원 경우 대비)
// filePickerOpen 중에는 GPS 재시작 건너뜀
window.addEventListener('pageshow', (e) => {
    if (filePickerOpen) return; // 카메라/갤러리 복귀 시 건너뜀
    if (gpsKeepAlive && gpsWatchId === null) {
        clearGpsRetry();
        startGPS();
    }
    if (gpsKeepAlive) requestWakeLock();
});

/* =====================
   Wake Lock — 화면 꺼짐 방지
   ===================== */
async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return; // 미지원 브라우저
    try {
        if (wakeLock && !wakeLock.released) return; // 이미 획득
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
            // 백그라운드 전환 시 자동 해제 — 포그라운드 복귀 때 visibilitychange가 재획득
        });
    } catch (e) {
        // 권한 없거나 미지원 — 무시
    }
}
function releaseWakeLock() {
    if (wakeLock && !wakeLock.released) {
        wakeLock.release();
        wakeLock = null;
    }
}

/* =====================
   백그라운드 GPS 카운터
   ===================== */
function startBgCounter() {
    stopBgCounter();
    bgGpsSeconds = 0;
    const counter = document.getElementById('bgGpsCounter');
    if (!counter) return;
    if (!gpsKeepAlive) return;
    counter.style.display = 'inline';
    bgGpsInterval = setInterval(() => {
        bgGpsSeconds++;
        const m = Math.floor(bgGpsSeconds / 60);
        const s = bgGpsSeconds % 60;
        counter.textContent = `백그라운드 ${m > 0 ? m + '분 ' : ''}${s}초`;
    }, 1000);
}
function stopBgCounter() {
    if (bgGpsInterval) { clearInterval(bgGpsInterval); bgGpsInterval = null; }
    const counter = document.getElementById('bgGpsCounter');
    if (counter) counter.style.display = 'none';
    bgGpsSeconds = 0;
}

/* =====================
   화면 전환
   ===================== */
function showPinSection() {
    show('driverPinSection');
    hide('driverSelectSection');
    hide('driverWorkSection');
    _bindLoginBtn(); // ★ 화면 전환할 때마다 버튼 이벤트 재등록
}
function showSelectSection() {
    hide('driverPinSection');
    show('driverSelectSection');
    hide('driverWorkSection');
    var nameEl = document.getElementById('welcomeDriverName');
    if (nameEl) nameEl.textContent = currentDriverName + ' 기사님, 환영합니다! 👋';
    loadDeliveriesForDriver();
    initSelectEventListeners();
}
function showWorkSection() {
    hide('driverPinSection');
    hide('driverSelectSection');
    show('driverWorkSection');
}
function show(id) { const el = document.getElementById(id); if (el) el.style.display = 'flex'; }
function hide(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }

/* =====================
   이벤트 바인딩
   ===================== */
// ★ 로그인 버튼 이벤트 등록 — onclick(HTML) + addEventListener(JS) 이중 보증
// _loginInProgress 플래그로 중복 실행 차단
function _bindLoginBtn() {
    const btn = document.getElementById('btnDoLogin');
    if (!btn) return;
    // 이미 등록된 경우 제거 후 재등록 (로그아웃 후 재진입 대비)
    btn.removeEventListener('click', handlePinLogin);
    btn.addEventListener('click', handlePinLogin);
}
function initPinEventListeners() {
    _bindLoginBtn();
}

function initSelectEventListeners() {
    bindOnce('btnStartWork',      'click', handleStartWork);
    bindOnce('btnPinLogout',      'click', handleFullLogout);
    bindOnce('btnChangeDelivery', 'click', () => { stopGPS(); lsClearWork(); currentDelivery = null; showSelectSection(); });
    bindOnce('btnWorkLogout',     'click', handleFullLogout);
    bindOnce('btnStartGPS',       'click', startGPS);
    bindOnce('btnStopGPS',        'click', handleStopGpsClick);
    bindOnce('btnMarkLoaded',     'click', markLoaded);
    bindOnce('btnCancelLoaded',   'click', cancelLoaded);
    bindOnce('btnAddStop',        'click', addStopSection);

    // 상차 사진 — 촬영 즉시 자동업로드
    setupLoadingPhotoInput('invoice');
    setupLoadingPhotoInput('temp');
}

function bindOnce(id, event, fn) {
    const el = document.getElementById(id);
    if (el && !el.dataset.bound) { el.dataset.bound = '1'; el.addEventListener(event, fn); }
}

/* =====================
   PIN 로그인
   ===================== */
const PIN_LOCKOUT_KEY = 'pin_lockout';
function getPinLockout() {
    try { return JSON.parse(localStorage.getItem(PIN_LOCKOUT_KEY)) || { count: 0, lockedUntil: 0 }; }
    catch { return { count: 0, lockedUntil: 0 }; }
}
function setPinLockout(obj) { localStorage.setItem(PIN_LOCKOUT_KEY, JSON.stringify(obj)); }
function clearPinLockout() { localStorage.removeItem(PIN_LOCKOUT_KEY); }

// ★ PIN 잠금 수동 초기화 (화면 버튼에서 호출)
function resetPinLockout() {
    clearPinLockout();
    hideError('driverPinError');
    showToast('로그인 잠금이 초기화되었습니다.', 'success');
}

let _loginInProgress = false; // ★ 중복 실행 방지

/* ──────────────────────────────────────────────────────
   handlePinLogin
   ★ async/await 완전 제거 — 구형 Android WebView 호환
   ★ 순수 .then().catch() 체인으로만 작성
   ────────────────────────────────────────────────────── */
function handlePinLogin(e) {
    // 이벤트 기본 동작 차단
    if (e) {
        try { e.preventDefault(); } catch(x) {}
        try { e.stopPropagation(); } catch(x) {}
    }

    // 중복 실행 방지
    if (_loginInProgress) return;
    _loginInProgress = true;

    // 디버그 로그 출력 함수
    function dbg(msg) {
        console.log('[LOGIN] ' + msg);
        var dbgEl = document.getElementById('loginDebug');
        if (dbgEl) dbgEl.textContent = msg;
    }

    // 버튼 상태 변경
    var btn = document.getElementById('btnDoLogin');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 확인 중...';
    }

    // 에러 표시 함수
    function showErr(msg) {
        var errEl = document.getElementById('driverPinError');
        if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
        showToast(msg, 'error', 5000);
        dbg('오류: ' + msg);
    }
    function hideErr() {
        var errEl = document.getElementById('driverPinError');
        if (errEl) errEl.style.display = 'none';
    }

    // 완료 후 복원 함수
    function done() {
        _loginInProgress = false;
        var b = document.getElementById('btnDoLogin');
        if (b) {
            b.disabled = false;
            b.innerHTML = '<i class="fas fa-sign-in-alt"></i> 로그인';
        }
    }

    hideErr();
    dbg('버튼 클릭됨');

    // 입력값 읽기
    var nameEl = document.getElementById('pinDriverName');
    var pinEl  = document.getElementById('pinCode');
    var name   = nameEl ? (nameEl.value || '').trim() : '';
    var pin    = pinEl  ? (pinEl.value  || '').trim() : '';

    if (!name || !pin) {
        showErr('이름과 PIN을 모두 입력해주세요.');
        done();
        return;
    }

    // 잠금 확인
    var lockout = getPinLockout();
    var now = Date.now();
    if (lockout.lockedUntil > now) {
        var sec = Math.ceil((lockout.lockedUntil - now) / 1000);
        showErr('로그인 잠금 중 (' + sec + '초 후 재시도)\n아래 잠금 초기화 버튼을 누르세요.');
        done();
        return;
    }

    dbg('서버 연결 중...');

    // API 호출 — fetch 직접 사용 (apiGetList 래퍼 우회)
    fetch('tables/deliveries?limit=500')
        .then(function(res) {
            dbg('응답 수신: HTTP ' + res.status);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        })
        .then(function(json) {
            var all = (json && Array.isArray(json.data)) ? json.data : [];
            dbg('배송건 ' + all.length + '개 로드됨');

            // PIN 해시 계산 — hashPassword 결과 Promise 처리
            return hashPassword(pin).then(function(pinHash) {
                var pinHashFallback = _fallbackHash(pin + '_cargo_salt_2025');
                dbg('해시 계산 완료. 이름: ' + name);

                var matched = all.filter(function(d) {
                    if (!d.driver_name) return false;
                    var dName = d.driver_name.replace(/\s/g, '');
                    var iName = name.replace(/\s/g, '');
                    if (dName !== iName) return false;
                    return (
                        d.driver_pin_hash === pinHash ||
                        d.driver_pin_hash === pinHashFallback ||
                        (d.driver_pin_hash2 && (
                            d.driver_pin_hash2 === pinHash ||
                            d.driver_pin_hash2 === pinHashFallback
                        ))
                    );
                });

                dbg('매칭: ' + matched.length + '건 (전체 ' + all.length + '건)');

                if (matched.length === 0) {
                    var nameOnly = all.filter(function(d) {
                        return d.driver_name &&
                            d.driver_name.replace(/\s/g, '') === name.replace(/\s/g, '');
                    });
                    var newCount = (lockout.count || 0) + 1;
                    var msg = '';
                    if (newCount >= 5) {
                        var lockSec = Math.min(30 * Math.pow(2, newCount - 5), 600);
                        setPinLockout({ count: newCount, lockedUntil: Date.now() + lockSec * 1000 });
                        msg = '5회 실패 — ' + lockSec + '초 잠금\n아래 잠금 초기화 버튼을 누르세요.';
                    } else {
                        setPinLockout({ count: newCount, lockedUntil: 0 });
                        msg = nameOnly.length === 0
                            ? '"' + name + '" 이름으로 등록된 배송건이 없습니다. (' + newCount + '/5)\n고객사 담당자에게 문의하세요.'
                            : 'PIN이 올바르지 않습니다. (' + newCount + '/5회 실패)';
                    }
                    if (pinEl) pinEl.value = '';
                    showErr(msg);
                    done();
                    return;
                }

                // 로그인 성공
                clearPinLockout();
                currentDriverName = name;
                Session.set('driver_session', { driverName: name, pinHash: pinHash, timestamp: Date.now() });
                lsSaveSession(name, pinHash);
                dbg('로그인 성공!');
                showToast(name + ' 기사님, 로그인되었습니다! 🎉', 'success');
                done();
                showSelectSection();
            });
        })
        .catch(function(err) {
            var msg = err && err.message ? err.message : String(err);
            dbg('오류: ' + msg);
            showErr('서버 오류: ' + msg);
            done();
        });
}

/* =====================
   배송건 목록 로드
   ===================== */
async function loadDeliveriesForDriver() {
    const select = document.getElementById('selectDelivery');
    select.innerHTML = '<option value="">불러오는 중...</option>';
    select.disabled  = true;
    try {
        const data  = await apiGetList('tables/deliveries?limit=500');
        const all   = data.data || [];
        // 로그인은 이미 PIN 검증 완료 → 배송건 목록은 이름 일치만 확인
        const mine  = all.filter(d =>
            d.driver_name &&
            d.driver_name.replace(/\s/g, '') === currentDriverName.replace(/\s/g, '')
        );

        let roomMap = {};
        try {
            const rd = await apiGet('tables/rooms?limit=100');
            (rd.data || []).forEach(r => { roomMap[r.id] = r.room_name; });
        } catch {}

        select.innerHTML = '<option value="">-- 배송건 선택 --</option>';
        if (!mine.length) {
            select.innerHTML = '<option value="">배송건 없음 (고객사에 문의)</option>';
        } else {
            const active = mine.filter(d => d.status !== 'delivered');
            const done   = mine.filter(d => d.status === 'delivered');
            [...active, ...done].forEach(d => {
                const opt  = document.createElement('option');
                opt.value  = d.id;
                const rm   = roomMap[d.room_id] || '고객사';
                opt.textContent = `${d.status === 'delivered' ? '✅ ' : '🚛 '}[${rm}] ${getCargoTypeLabel(d.cargo_type) || '화물'} · ${d.origin || '-'} → ${d.destination || '-'} (${getStatusText(d.status)})`;
                if (d.status !== 'delivered' && active.length === 1) opt.selected = true;
                select.appendChild(opt);
            });
        }
        select.disabled = false;
    } catch (err) {
        select.innerHTML = '<option value="">로드 실패 - 다시 시도</option>';
        console.error(err);
    }
}

/* =====================
   업무 시작
   ===================== */
async function handleStartWork() {
    const deliveryId = document.getElementById('selectDelivery').value;
    hideError('driverSelectError');
    if (!deliveryId) { showError('driverSelectError', '배송건을 선택해주세요.'); return; }

    const btn = document.getElementById('btnStartWork');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 로딩 중...';
    try {
        currentDelivery = await apiGet(`tables/deliveries/${deliveryId}`);
        stops           = restoreStopPhotos(parseStops(currentDelivery.stops), currentDelivery);
        const allDone   = stops.length > 0 && stops.every(s => s.delivered_at);
        gpsKeepAlive    = !allDone;

        // 업무 중 배송건 ID를 localStorage에 저장 (탭 닫아도 복원 가능)
        if (gpsKeepAlive) lsSaveWork(deliveryId);

        renderWorkScreen();
        showWorkSection();

        // ★ 기사 접속 알림 전송 (하차완료 상태가 아닐 때만)
        if (!allDone) {
            sendDriverNotification('driver_login');
        }

        // 업무 시작 시 GPS 자동 시작
        if (gpsKeepAlive) {
            setTimeout(() => startGPS(), 500);
        }
        // ★ GPS 위치 요청 폴링 시작
        startGpsRequestPoll();
        // ★ 사진 촬영 요청 폴링 시작
        startPhotoRequestPoll();
        // ★ 방/배송건 삭제 감지 폴링 시작 (30초 간격)
        startSessionValidPoll();
        // ★ 저속 감지 + 상차 4시간 초과 알림 타이머 시작
        startAlertCheck();
        showToast('업무를 시작합니다!', 'success');
    } catch {
        showError('driverSelectError', '배송 정보를 불러오지 못했습니다.');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-play-circle"></i> 업무 시작';
    }
}

function parseStops(raw) {
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
}

/* =====================
   업무 화면 렌더링
   ===================== */
function renderWorkScreen() {
    const d = currentDelivery;
    document.getElementById('workDriverName').innerHTML = `<i class="fas fa-user"></i> ${escapeHtml(currentDriverName)}`;
    document.getElementById('workVehicle').innerHTML    = `<i class="fas fa-car"></i> ${escapeHtml(d.vehicle_number || '-')}`;

    // 화물 타입 배지
    document.getElementById('workCargo').innerHTML = cargoTypeBadge(d.cargo_type) || '<span style="color:#94a3b8;">-</span>';

    document.getElementById('workRoute').textContent    = `${d.origin || '-'} → ${d.destination || '-'}`;
    updateStatusDisplay(d.status);

    // 냉동/냉장 타입이면 온도기록지 카드에 AB온도 안내 배지 표시
    refreshTempCardNotice();

    // ★ 상차 카드 UI 완전 초기화 (renderWorkScreen 재호출 시 상태 꼬임 방지)
    _resetLoadingCardUI('invoice');
    _resetLoadingCardUI('temp');

    // 상차 기존 사진 복원
    if (d.loading_invoice_photo) {
        setPhotoPreview('loadingInvoicePreview', d.loading_invoice_photo);
        setPhotoStatus('loadingInvoiceStatus', true, d.loading_invoice_date);
        document.getElementById('loadingInvoiceCard').classList.add('uploaded');
        showEditBtn('loadingInvoiceLabel', 'loadingInvoiceEditBtn');
    }
    if (d.loading_temp_photo) {
        setPhotoPreview('loadingTempPreview', d.loading_temp_photo);
        setPhotoStatus('loadingTempStatus', true, d.loading_temp_date);
        document.getElementById('loadingTempCard').classList.add('uploaded');
        showEditBtn('loadingTempLabel', 'loadingTempEditBtn');
        showTempAbNotice('loadingTempCard'); // 업로드 완료 시 AB온도 문구
    }

    // ★ 상차 추가사진 복원
    try {
        loadingExtraPhotos = d.loading_extra_photos
            ? JSON.parse(d.loading_extra_photos) : [];
    } catch { loadingExtraPhotos = []; }
    renderExtraPhotoGrid('loading');

    // ★ 상차사진 input 바인딩 (renderWorkScreen 호출마다 강제 재바인딩)
    _rebindLoadingPhotoInput('invoice');
    _rebindLoadingPhotoInput('temp');
    // 추가사진 input 바인딩
    bindExtraPhotoInput('loading');

    renderAllStops();

    // 이미 상차완료 상태면 취소 버튼 표시
    const markBtn   = document.getElementById('btnMarkLoaded');
    const cancelBtn = document.getElementById('btnCancelLoaded');
    if (d.status === 'loading' || d.status === 'transit') {
        if (markBtn)   markBtn.style.display   = 'none';
        if (cancelBtn) cancelBtn.style.display = 'block';
    } else {
        if (markBtn)   markBtn.style.display   = 'block';
        if (cancelBtn) cancelBtn.style.display = 'none';
    }
}

// ===== 화물 타입 헬퍼 — utils.js의 공통 함수 사용 (isColdType, getCargoTypeLabel, getCargoTypeBg, getCargoTypeColor, cargoTypeBadge) =====

// 온도기록지 카드에 냉동/냉장 안내 배지 추가 (상차 + 모든 하차 stop)
function refreshTempCardNotice() {
    const d = currentDelivery;
    if (!d || !isColdType(d.cargo_type)) return;

    const NOTICE_HTML = '<i class="fas fa-thermometer-full" style="color:#f59e0b;"></i> AB온도 확인 필수<br><span style="font-weight:400;font-size:0.72rem;">온도기록지에 A·B 온도 기재 여부를 확인하세요</span>';
    const NOTICE_STYLE = 'margin-top:6px;padding:5px 8px;background:#fef3c7;border-radius:7px;font-size:0.76rem;color:#92400e;font-weight:600;text-align:center;line-height:1.4;border:1px solid #fde68a;';

    function addNotice(card) {
        if (!card || card.querySelector('.ab-temp-notice')) return;
        const notice = document.createElement('div');
        notice.className = 'ab-temp-notice';
        notice.style.cssText = NOTICE_STYLE;
        notice.innerHTML = NOTICE_HTML;
        card.appendChild(notice);
    }

    // 상차 온도기록지 카드
    addNotice(document.getElementById('loadingTempCard'));

    // 하차 stop 온도기록지 카드 (stops 배열 기준으로 모든 stop에 적용)
    stops.forEach((_, idx) => {
        addNotice(document.getElementById(`stopTmpCard_${idx}`));
    });
}

// 온도기록지 업로드 완료 시 AB온도 확인 강조 팝업
function showTempAbNotice(cardId) {
    const d = currentDelivery;
    if (!d || !isColdType(d.cargo_type)) return;
    showToast('🌡️ 온도기록지 업로드 완료! AB 온도가 기재되어 있는지 확인해주세요.', 'warning', 5000);
}

function updateStatusDisplay(status) {
    const badge    = document.getElementById('workStatusBadge');
    const colorMap = {
        waiting:   'background:rgba(255,255,255,0.15)',
        loading:   'background:#fef3c7;color:#d97706',
        transit:   'background:#cffafe;color:#0891b2',
        delivered: 'background:#dcfce7;color:#16a34a'
    };
    badge.style.cssText = colorMap[status] || '';
    badge.textContent   = getStatusText(status);

    const lb = document.getElementById('loadingBadge');
    if (lb && ['loading', 'transit', 'delivered'].includes(status)) {
        lb.textContent = '완료'; lb.classList.add('done');
    }
}

/* ================================================
   ★ 상차 사진 — 촬영/선택 즉시 자동업로드
   ================================================ */
/* 상차 카드 UI 초기화 — renderWorkScreen 재호출 시 상태 꼬임 방지 */
function _resetLoadingCardUI(type) {
    const cardId  = type === 'invoice' ? 'loadingInvoiceCard'    : 'loadingTempCard';
    const prevId  = type === 'invoice' ? 'loadingInvoicePreview' : 'loadingTempPreview';
    const statId  = type === 'invoice' ? 'loadingInvoiceStatus'  : 'loadingTempStatus';
    const labelId = type === 'invoice' ? 'loadingInvoiceLabel'   : 'loadingTempLabel';
    const editId  = type === 'invoice' ? 'loadingInvoiceEditBtn' : 'loadingTempEditBtn';
    const card    = document.getElementById(cardId);
    const label   = document.getElementById(labelId);
    const edit    = document.getElementById(editId);
    const stat    = document.getElementById(statId);
    const prev    = document.getElementById(prevId);
    if (card)  card.classList.remove('uploaded');
    if (label) label.style.display = 'inline-block'; // 촬영/선택 버튼 보이기
    if (edit)  edit.style.display  = 'none';          // 수정 버튼 숨기기
    if (stat)  stat.innerHTML      = '';
    if (prev)  prev.innerHTML      = type === 'invoice'
        ? `<i class="fas fa-file-invoice"></i><p>거래명세표</p><span>사진 없음</span>`
        : `<i class="fas fa-thermometer-half"></i><p>온도기록지</p><span>사진 없음</span>`;
    // onchange 프로퍼티 방식이므로 _handlerBound 리셋 불필요 — _rebindLoadingPhotoInput에서 항상 덮어씀
}

/* 상차 사진 input 바인딩 (onchange 프로퍼티 방식 — 중복 등록 방지) */
function _rebindLoadingPhotoInput(type) {
    const inputId  = type === 'invoice' ? 'loadingInvoiceInput' : 'loadingTempInput';
    const labelId  = type === 'invoice' ? 'loadingInvoiceLabel' : 'loadingTempLabel';
    const input    = document.getElementById(inputId);
    const labelWrap = document.getElementById(labelId);
    if (!input) return;

    // ★ input.onclick, labelWrap.onclick 모두 제거
    // filePickerOpen 플래그는 visibilitychange(hidden) 에서 자동 설정됨
    // — onclick을 file input 또는 부모에 걸면 Android WebView에서
    //   카메라 복귀 후 onchange가 발생하지 않는 버그 있음
    input.onclick = null;
    if (labelWrap) labelWrap.onclick = null;

    // ★ onchange 프로퍼티로 덮어씌우기 — addEventListener와 달리 항상 1개만 유지
    input.onchange = async function () {
        setFilePickerOpen(false);
        if (!this.files || !this.files[0]) return;
        const file     = this.files[0];
        const fileName = file.name;
        const fileType = file.type || 'image/jpeg';
        // ★ value 초기화는 readFileToMemory로 파일을 메모리에 올린 뒤에 수행
        //   (초기화를 먼저 하면 Android에서 파일 참조가 끊길 수 있음)

        const previewId = type === 'invoice' ? 'loadingInvoicePreview' : 'loadingTempPreview';
        showUploadingSpinner(previewId);
        try {
            const safeFile = await readFileToMemory(file, fileName, fileType);
            this.value = ''; // 메모리 적재 완료 후 초기화 (동일 파일 재선택 허용)
            const imgValue = await uploadImage(safeFile, { silent: true });
            if (imgValue && !imgValue.startsWith('http')) {
                showToast('⚠️ 이미지 서버 연결 실패. 사진을 직접 저장합니다.', 'warning', 3000);
            }
            await uploadLoadingPhoto(type, imgValue);
        } catch (err) {
            console.error('[loadingPhoto] 업로드 오류:', err);
            showToast('이미지 처리 실패. 다시 시도해주세요.', 'error');
            restoreLoadingPreview(type);
        }
    };
    input._handlerBound = true;
}

/* 기존 setupLoadingPhotoInput — triggerLoadingRePhoto에서 재촬영 시 사용 */
function setupLoadingPhotoInput(type) {
    _rebindLoadingPhotoInput(type);
}

async function uploadLoadingPhoto(type, b64) {
    const field   = type === 'invoice' ? 'loading_invoice_photo' : 'loading_temp_photo';
    const dfField = type === 'invoice' ? 'loading_invoice_date'  : 'loading_temp_date';
    const tsField = type === 'invoice' ? 'loading_invoice_ts'    : 'loading_temp_ts';
    const prevId  = type === 'invoice' ? 'loadingInvoicePreview' : 'loadingTempPreview';
    const statId  = type === 'invoice' ? 'loadingInvoiceStatus'  : 'loadingTempStatus';
    const cardId  = type === 'invoice' ? 'loadingInvoiceCard'    : 'loadingTempCard';
    const labelId = type === 'invoice' ? 'loadingInvoiceLabel'   : 'loadingTempLabel';
    const editId  = type === 'invoice' ? 'loadingInvoiceEditBtn' : 'loadingTempEditBtn';

    try {
        const now     = Date.now();
        const dateKey = getTodayKST();
        await apiPatch(`tables/deliveries/${currentDelivery.id}`, {
            [field]: b64, [dfField]: dateKey, [tsField]: now
        });
        currentDelivery[field]   = b64;
        currentDelivery[dfField] = dateKey;
        currentDelivery[tsField] = now;

        setPhotoPreview(prevId, b64);
        setPhotoStatus(statId, true, dateKey);
        document.getElementById(cardId).classList.add('uploaded');
        showEditBtn(labelId, editId);
        showToast(`상차 ${type === 'invoice' ? '거래명세표' : '온도기록지'} 업로드 완료!`, 'success');
        // 온도기록지 업로드 완료 시 냉동/냉장이면 AB온도 확인 알림
        if (type === 'temp') showTempAbNotice(cardId);
    } catch (err) {
        console.error(err);
        showToast('업로드 실패. 다시 시도해주세요.', 'error');
        restoreLoadingPreview(type);
    }
}

function restoreLoadingPreview(type) {
    const prevId = type === 'invoice' ? 'loadingInvoicePreview' : 'loadingTempPreview';
    const photo  = type === 'invoice'
        ? currentDelivery?.loading_invoice_photo
        : currentDelivery?.loading_temp_photo;
    if (photo) {
        setPhotoPreview(prevId, photo);
    } else {
        const el = document.getElementById(prevId);
        if (el) el.innerHTML = type === 'invoice'
            ? `<i class="fas fa-file-invoice"></i><p>거래명세표</p><span>사진 없음</span>`
            : `<i class="fas fa-thermometer-half"></i><p>온도기록지</p><span>사진 없음</span>`;
    }
}

/* ★ 수정 버튼 — 상차 재촬영 */
function triggerLoadingRePhoto(type) {
    const inputId = type === 'invoice' ? 'loadingInvoiceInput' : 'loadingTempInput';
    const input   = document.getElementById(inputId);
    if (!input) return;
    input.value = '';
    // onchange 방식: setupLoadingPhotoInput이 항상 핸들러를 덮어씌움
    setupLoadingPhotoInput(type);
    setFilePickerOpen(true);
    input.click();
}

/* ★ 파일 input 직접 트리거 (label for 대체 — WebView 호환) */
function triggerPhotoInput(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;
    // value 초기화로 동일 파일 재선택 가능
    input.value = '';
    input.click();
}

/* =====================
   상차 완료 처리
   ===================== */
async function markLoaded() {
    if (!currentDelivery) return;
    if (!await showConfirm('상차 완료 처리하시겠습니까?', '완료 처리')) return;
    try {
        const loadedAt = Date.now(); // ★ 동일한 타임스탬프 사용
        await apiPatch(`tables/deliveries/${currentDelivery.id}`, {
            status: 'loading', loaded_at: loadedAt
        });
        currentDelivery.status    = 'loading';
        currentDelivery.loaded_at = loadedAt;
        updateStatusDisplay('loading');
        showToast('상차 완료! 네비를 켜세요 — GPS는 백그라운드에서 계속 전송됩니다.', 'success');

        // 상차완료 버튼 숨기고 취소 버튼 표시
        const markBtn   = document.getElementById('btnMarkLoaded');
        const cancelBtn = document.getElementById('btnCancelLoaded');
        if (markBtn)   markBtn.style.display   = 'none';
        if (cancelBtn) cancelBtn.style.display = 'block';

        // ★ 상차완료 알림 전송
        sendDriverNotification('loaded');

        // ★ Wake Lock (화면 꺼짐 방지)
        await requestWakeLock();

        // ★ 창을 백그라운드로 내리기
        sendToBackground();
    } catch { showToast('상태 변경 실패.', 'error'); }
}

/* =====================
   상차 취소 처리
   ===================== */
async function cancelLoaded() {
    if (!currentDelivery) return;
    if (!await showConfirm('⚠️ 상차를 취소하시겠습니까?\n\n상차 전 대기 상태로 돌아갑니다.\n(업로드한 사진은 유지됩니다)', '취소 처리', true)) return;

    try {
        await apiPatch(`tables/deliveries/${currentDelivery.id}`, {
            status: 'waiting',
            loaded_at: null
        });
        currentDelivery.status    = 'waiting';
        currentDelivery.loaded_at = null;
        updateStatusDisplay('waiting');

        // 상차 관련 알림 타이머 리셋
        loadedAlertAt   = null;
        lowSpeedStartAt = null;

        showToast('상차가 취소되었습니다. 상차 전 상태로 돌아갑니다.', 'default');

        // 취소 버튼 숨기고 상차완료 버튼 표시
        const markBtn   = document.getElementById('btnMarkLoaded');
        const cancelBtn = document.getElementById('btnCancelLoaded');
        if (markBtn)   markBtn.style.display   = 'block';
        if (cancelBtn) cancelBtn.style.display = 'none';
    } catch { showToast('상태 변경 실패. 다시 시도해주세요.', 'error'); }
}

/* =====================
   창 백그라운드로 내리기
   ===================== */
function sendToBackground() {
    // ★ 네이티브 앱 환경 — AndroidGPS 브릿지로 즉시 홈 화면 이동
    if (window.AndroidGPS) {
        window.AndroidGPS.moveToBackground();
        return;
    }

    // 웹 브라우저 환경 — blur + intent URL 시도
    window.blur();
    const isAndroid = /Android/i.test(navigator.userAgent);
    if (isAndroid) {
        try {
            const a = document.createElement('a');
            a.href = 'intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.HOME;end';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        } catch(e) {}
    }
}

/* ================================================
   ★ 다중 하차 세트
   ================================================ */
function renderAllStops() {
    const container = document.getElementById('stopsContainer');
    container.innerHTML = '';
    if (stops.length === 0) {
        addStopSection(true); // 첫번째 세트 자동 추가 (토스트 없음)
    } else {
        stops.forEach((stop, idx) => renderStopSection(idx, stop));
    }
}

function addStopSection(silent = false) {
    const idx = stops.length;
    stops.push({
        label: `하차 ${idx + 1}`,
        invoice_photo: null, temp_photo: null,
        invoice_date: null,  temp_date: null,
        invoice_ts: null,    temp_ts: null,
        arrived_at: null,    // ★ 도착하차대기 시각
        delivered_at: null,
        extra_photos: []     // ★ 추가사진 배열
    });
    renderStopSection(idx, stops[idx]);
    if (!silent) showToast(`하차 ${idx + 1} 세트가 추가되었습니다.`, 'success');
}

function renderStopSection(idx, stop) {
    const container = document.getElementById('stopsContainer');
    const isFirst   = idx === 0;
    const color     = isFirst ? 'var(--success)' : '#0891b2';
    const isDone    = !!stop.delivered_at;
    const isArrived = !!stop.arrived_at && !isDone;  // 도착대기 중 (하차완료 전)

    const section = document.createElement('div');
    section.className = 'work-section stop-section';
    section.id = `stopSection_${idx}`;

    section.innerHTML = `
        <div class="section-title" style="justify-content:space-between;">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <i class="fas fa-arrow-down" style="color:${color};"></i>
                <span id="stopLabel_${idx}" style="font-weight:700;">${escapeHtml(stop.label)}</span>
                <span class="section-badge delivered-badge${isDone ? ' done' : (isArrived ? ' arrived' : '')}" id="stopBadge_${idx}">
                    ${isDone ? '완료' : (isArrived ? '도착대기' : '대기중')}
                </span>
            </div>
            ${idx > 0 ? `<button class="btn btn-sm" style="background:#fee2e2;color:#dc2626;border:none;border-radius:8px;padding:4px 10px;cursor:pointer;white-space:nowrap;" onclick="removeStop(${idx})"><i class="fas fa-times"></i> 삭제</button>` : ''}
        </div>

        <div style="margin-bottom:12px;">
            <input type="text" id="stopLabelInput_${idx}"
                value="${escapeHtml(stop.label)}"
                placeholder="예: 1차 하차지, 경유지 등"
                style="width:100%;padding:8px 12px;border:1.5px solid #e2e8f0;border-radius:8px;font-family:inherit;font-size:0.88rem;outline:none;"
                onfocus="this.style.borderColor='#2563eb'"
                onblur="this.style.borderColor='#e2e8f0'; updateStopLabel(${idx}, this.value)" />
        </div>

        <div class="upload-grid">
            <!-- 거래명세표 -->
            <div class="upload-card${stop.invoice_photo ? ' uploaded' : ''}" id="stopInvCard_${idx}">
                <div class="upload-preview" id="stopInvPreview_${idx}">
                    ${stop.invoice_photo
                        ? `<img src="${stop.invoice_photo}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit;">`
                        : `<i class="fas fa-file-invoice"></i><p>거래명세표</p><span>사진 없음</span>`}
                </div>
                <div class="upload-actions" id="stopInvActions_${idx}">
                    ${stop.invoice_photo
                        ? `<button class="btn btn-outline btn-sm edit-photo-btn" id="stopInvEditBtn_${idx}">
                               <i class="fas fa-redo"></i> 수정
                           </button>`
                        : `<div class="file-btn-wrap" id="stopInvLabel_${idx}">
                               <span class="btn btn-outline btn-sm upload-label">
                                   <i class="fas fa-camera"></i> 촬영/선택
                               </span>
                               <input type="file" id="stopInvInput_${idx}" accept="image/*" class="file-overlay-input" />
                           </div>`}
                </div>
                <div class="upload-status" id="stopInvStatus_${idx}">
                    ${stop.invoice_date ? `<i class="fas fa-check-circle" style="color:var(--success);"></i> 완료<br><small>${stop.invoice_date}</small>` : ''}
                </div>
            </div>

            <!-- 온도기록지 -->
            <div class="upload-card${stop.temp_photo ? ' uploaded' : ''}" id="stopTmpCard_${idx}">
                <div class="upload-preview" id="stopTmpPreview_${idx}">
                    ${stop.temp_photo
                        ? `<img src="${stop.temp_photo}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit;">`
                        : `<i class="fas fa-thermometer-half"></i><p>온도기록지</p><span>사진 없음</span>`}
                </div>
                <div class="upload-actions" id="stopTmpActions_${idx}">
                    ${stop.temp_photo
                        ? `<button class="btn btn-outline btn-sm edit-photo-btn" id="stopTmpEditBtn_${idx}">
                               <i class="fas fa-redo"></i> 수정
                           </button>`
                        : `<div class="file-btn-wrap" id="stopTmpLabel_${idx}">
                               <span class="btn btn-outline btn-sm upload-label">
                                   <i class="fas fa-camera"></i> 촬영/선택
                               </span>
                               <input type="file" id="stopTmpInput_${idx}" accept="image/*" class="file-overlay-input" />
                           </div>`}
                </div>
                <div class="upload-status" id="stopTmpStatus_${idx}">
                    ${stop.temp_date ? `<i class="fas fa-check-circle" style="color:var(--success);"></i> 완료<br><small>${stop.temp_date}</small>` : ''}
                </div>
            </div>
        </div>

        <!-- ★ 추가 사진 (물품/현장사진 등) -->
        <div id="stop_${idx}ExtraSection">
            <div style="display:flex;align-items:center;justify-content:space-between;margin:8px 0 4px;">
                <span style="font-size:0.8rem;font-weight:600;color:#475569;">
                    <i class="fas fa-images" style="color:#6366f1;"></i> 추가 사진
                    <span id="stop_${idx}ExtraCount" style="font-size:0.73rem;color:#94a3b8;margin-left:3px;">(0장)</span>
                </span>
                <div class="file-btn-wrap">
                    <span class="btn btn-outline btn-sm" style="font-size:0.75rem;padding:3px 9px;border-color:#6366f1;color:#6366f1;">
                        <i class="fas fa-plus"></i> 사진 추가
                    </span>
                    <input type="file" id="stop_${idx}ExtraInput" accept="image/*" multiple class="file-overlay-input" />
                </div>
            </div>
            <div id="stop_${idx}ExtraGrid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-bottom:4px;"></div>
        </div>

        <!-- ★ 버튼 영역: 대기중 → 도착하차대기 → 하차완료 3단계 -->
        ${isDone
            /* ③ 하차완료 상태 */
            ? `<button class="btn btn-success btn-block" id="stopDoneBtn_${idx}"
                   style="margin-top:8px;opacity:0.6;pointer-events:none;">
                   <i class="fas fa-check-double"></i> ✅ 하차완료 (${formatDateShort(stop.delivered_at)})
               </button>`

            : isArrived
            /* ② 도착하차대기 상태 — 도착시각 표시 + 하차완료 버튼 활성 */
            ? `<div style="margin-top:8px;padding:8px 12px;background:#fef3c7;border-radius:10px;border:1px solid #fde68a;display:flex;align-items:center;gap:8px;font-size:0.82rem;color:#92400e;font-weight:600;">
                   <i class="fas fa-map-marker-alt" style="color:#f59e0b;"></i>
                   도착하차대기 중 (${formatDateShort(stop.arrived_at)})
               </div>
               <button class="btn btn-success btn-block" id="stopDoneBtn_${idx}"
                   style="margin-top:6px;">
                   <i class="fas fa-check-double"></i> ${stop.label} 하차 완료 처리
               </button>`

            /* ① 운송 중 상태 — 도착하차대기 버튼만 */
            : `<button class="btn btn-block" id="stopArrivedBtn_${idx}"
                   style="margin-top:8px;background:#fef3c7;color:#92400e;border:1.5px solid #fde68a;border-radius:10px;padding:12px;font-weight:700;font-size:0.92rem;cursor:pointer;">
                   <i class="fas fa-map-marker-alt" style="color:#f59e0b;"></i> ${stop.label} 도착 · 하차 대기
               </button>
               <button class="btn btn-success btn-block" id="stopDoneBtn_${idx}"
                   style="margin-top:6px;opacity:0.35;pointer-events:none;">
                   <i class="fas fa-check-double"></i> ${stop.label} 하차 완료 처리
               </button>`
        }
    `;

    container.appendChild(section);

    // ★ 하차 버튼 addEventListener 바인딩 (onclick 문자열 대신)
    const arrivedBtn = document.getElementById(`stopArrivedBtn_${idx}`);
    if (arrivedBtn) arrivedBtn.addEventListener('click', () => markStopArrived(idx));

    const doneBtn = document.getElementById(`stopDoneBtn_${idx}`);
    if (doneBtn && !doneBtn.style.pointerEvents.includes('none') && isArrived) {
        doneBtn.addEventListener('click', () => markStopDelivered(idx));
    }

    // 수정 버튼 바인딩
    const invEditBtn = document.getElementById(`stopInvEditBtn_${idx}`);
    if (invEditBtn) invEditBtn.addEventListener('click', () => triggerStopRePhoto(idx, 'invoice'));
    const tmpEditBtn = document.getElementById(`stopTmpEditBtn_${idx}`);
    if (tmpEditBtn) tmpEditBtn.addEventListener('click', () => triggerStopRePhoto(idx, 'temp'));

    // 파일 input 이벤트 바인딩 (자동업로드)
    bindStopInput(idx, 'invoice');
    bindStopInput(idx, 'temp');

    // ★ 추가사진 복원 및 바인딩
    if (stop.extra_photos && stop.extra_photos.length > 0) {
        renderExtraPhotoGrid(`stop_${idx}`);
    }
    bindExtraPhotoInput(`stop_${idx}`);
}

/* ★ 하차 사진 자동업로드 바인딩 */
function bindStopInput(idx, type) {
    const inputId    = type === 'invoice' ? `stopInvInput_${idx}` : `stopTmpInput_${idx}`;
    const labelWrapId = type === 'invoice' ? `stopInvLabel_${idx}` : `stopTmpLabel_${idx}`;
    const input      = document.getElementById(inputId);
    const labelWrap  = document.getElementById(labelWrapId);
    if (!input) return;

    // ★ input.onclick, labelWrap.onclick 모두 제거
    // filePickerOpen 플래그는 visibilitychange(hidden) 에서 자동 설정됨
    input.onclick = null;
    if (labelWrap) labelWrap.onclick = null;

    // ★ onchange 프로퍼티로 덮어씌우기 — 중복 핸들러 방지
    input.onchange = async function () {
        setFilePickerOpen(false);
        if (!this.files || !this.files[0]) return;
        const file     = this.files[0];
        const fileName = file.name;
        const fileType = file.type || 'image/jpeg';

        const prevId = type === 'invoice' ? `stopInvPreview_${idx}` : `stopTmpPreview_${idx}`;
        showUploadingSpinner(prevId);
        try {
            const safeFile = await readFileToMemory(file, fileName, fileType);
            this.value = ''; // 메모리 적재 완료 후 초기화
            const imgValue = await uploadImage(safeFile, { silent: true });
            if (imgValue && !imgValue.startsWith('http')) {
                showToast('⚠️ 이미지 서버 연결 실패. 사진을 직접 저장합니다.', 'warning', 3000);
            }
            stops[idx][type === 'invoice' ? 'invoice_photo' : 'temp_photo'] = imgValue;
            await uploadStopPhoto(idx, type);
        } catch (err) {
            console.error('[stopPhoto] 업로드 오류:', err);
            showToast('이미지 처리 실패. 다시 시도해주세요.', 'error');
            const old = stops[idx][type === 'invoice' ? 'invoice_photo' : 'temp_photo'];
            if (old) setPhotoPreview(prevId, old);
            else {
                const el = document.getElementById(prevId);
                if (el) el.innerHTML = type === 'invoice'
                    ? `<i class="fas fa-file-invoice"></i><p>거래명세표</p><span>사진 없음</span>`
                    : `<i class="fas fa-thermometer-half"></i><p>온도기록지</p><span>사진 없음</span>`;
            }
        }
    };
    input._handlerBound = true;
}

async function uploadStopPhoto(idx, type) {
    const photoField = type === 'invoice' ? 'invoice_photo' : 'temp_photo';
    const photo   = stops[idx][photoField];
    const prevId  = type === 'invoice' ? `stopInvPreview_${idx}` : `stopTmpPreview_${idx}`;
    const statId  = type === 'invoice' ? `stopInvStatus_${idx}`  : `stopTmpStatus_${idx}`;
    const cardId  = type === 'invoice' ? `stopInvCard_${idx}`    : `stopTmpCard_${idx}`;
    const actId   = type === 'invoice' ? `stopInvActions_${idx}` : `stopTmpActions_${idx}`;
    const inputId = type === 'invoice' ? `stopInvInput_${idx}`   : `stopTmpInput_${idx}`;

    try {
        const now     = Date.now();
        const dateKey = getTodayKST();
        if (type === 'invoice') { stops[idx].invoice_date = dateKey; stops[idx].invoice_ts = now; }
        else                    { stops[idx].temp_date    = dateKey; stops[idx].temp_ts    = now; }

        // ★ 이미지를 stop_photos 필드에 저장 (DB 스키마 필드 사용 — 안전)
        await saveStopPhotos();

        // ★ stops 메타데이터 저장 (이미지 없이)
        await saveStopsToServer();

        setPhotoPreview(prevId, photo);
        setPhotoStatus(statId, true, dateKey);
        document.getElementById(cardId).classList.add('uploaded');

        // 촬영/선택 → 수정 버튼으로 교체
        const actEl = document.getElementById(actId);
        if (actEl) {
            actEl.innerHTML = `
                <button class="btn btn-outline btn-sm edit-photo-btn" onclick="triggerStopRePhoto(${idx},'${type}')">
                    <i class="fas fa-redo"></i> 수정
                </button>
                <input type="file" id="${inputId}" accept="image/*" style="display:none;" />
            `;
            bindStopInput(idx, type);
        }
        showToast(`${stops[idx].label} ${type === 'invoice' ? '거래명세표' : '온도기록지'} 업로드 완료!`, 'success');
        // 온도기록지 업로드 완료 시 냉동/냉장이면 AB온도 확인 알림
        if (type === 'temp') showTempAbNotice(`stopTmpCard_${idx}`);
    } catch (err) {
        console.error('[uploadStopPhoto] 실패:', err.message, err);
        showToast('하차 사진 저장 실패. 다시 시도해주세요.', 'error');
        setPhotoPreview(prevId, photo);
    }
function triggerStopRePhoto(idx, type) {
    const inputId = type === 'invoice' ? `stopInvInput_${idx}` : `stopTmpInput_${idx}`;
    const input   = document.getElementById(inputId);
    if (!input) return;
    // onchange 방식: bindStopInput이 항상 핸들러를 덮어씌움
    input.value = '';
    bindStopInput(idx, type);
    setFilePickerOpen(true);
    input.click();
}

function updateStopLabel(idx, val) {
    stops[idx].label = val.trim() || `하차 ${idx + 1}`;
    const lbl = document.getElementById(`stopLabel_${idx}`);
    if (lbl) lbl.textContent = stops[idx].label;
    const doneBtn = document.getElementById(`stopDoneBtn_${idx}`);
    if (doneBtn && !stops[idx].delivered_at) {
        doneBtn.innerHTML = `<i class="fas fa-check-double"></i> ${stops[idx].label} 하차 완료 처리`;
    }
}

async function removeStop(idx) {
    if (!await showConfirm(`${stops[idx].label} 세트를 삭제하시겠습니까?`, '삭제', true)) return;
    stops.splice(idx, 1);
    saveStopsToServer();
    const container = document.getElementById('stopsContainer');
    container.innerHTML = '';
    stops.forEach((s, i) => renderStopSection(i, s));
    showToast('하차 세트가 삭제되었습니다.', 'default');
}

/* ★ 도착 하차대기 처리 */
async function markStopArrived(idx) {
    if (!await showConfirm(`${stops[idx].label} 도착 · 하차 대기 처리하시겠습니까?\n\n상차 후 경과 알림이 중단됩니다.`, '도착 처리')) return;
    try {
        const now = Date.now();
        stops[idx].arrived_at = now;
        await saveStopsToServer();

        // UI 업데이트
        const badge = document.getElementById(`stopBadge_${idx}`);
        if (badge) { badge.textContent = '도착대기'; badge.classList.add('arrived'); }

        const arrivedBtn = document.getElementById(`stopArrivedBtn_${idx}`);
        if (arrivedBtn) arrivedBtn.outerHTML = `
            <div style="margin-top:8px;padding:8px 12px;background:#fef3c7;border-radius:10px;border:1px solid #fde68a;display:flex;align-items:center;gap:8px;font-size:0.82rem;color:#92400e;font-weight:600;">
                <i class="fas fa-map-marker-alt" style="color:#f59e0b;"></i>
                도착하차대기 중 (${formatDateShort(now)})
            </div>`;

        const doneBtn = document.getElementById(`stopDoneBtn_${idx}`);
        if (doneBtn) {
            doneBtn.style.opacity = '1';
            doneBtn.style.pointerEvents = 'auto';
            // ★ 하차완료 버튼 이벤트 바인딩 (활성화 시점에 연결)
            doneBtn.addEventListener('click', () => markStopDelivered(idx));
        }

        // ★ 상차 4시간 경과 알림 중단 (도착했으므로 더 이상 불필요)
        loadedAlertAt = Date.now(); // 방금 처리로 간주 → 다음 5분 카운트 차단
        // 모든 하차지가 도착 완료됐으면 타이머 완전 중단
        if (stops.every(s => s.arrived_at || s.delivered_at)) {
            loadedAlertAt = Infinity; // 영구 차단
        }

        showToast(`📍 ${stops[idx].label} 도착! 하차 준비 후 완료 버튼을 눌러주세요.`, 'success', 5000);

        // ★ 도착 알림 전송 (화주·관리자)
        await sendDriverNotification('stop_arrived', idx);
    } catch (err) {
        console.error(err);
        showToast('처리 실패. 다시 시도해주세요.', 'error');
    }
}

async function markStopDelivered(idx) {
    if (!await showConfirm(`${stops[idx].label} 하차 완료 처리하시겠습니까?`, '하차 완료')) return;
    try {
        const now   = Date.now();
        stops[idx].delivered_at = now;
        const allDone   = stops.every(s => s.delivered_at);
        const newStatus = allDone ? 'delivered' : 'transit';

        await apiPatch(`tables/deliveries/${currentDelivery.id}`, {
            stops:        JSON.stringify(stops),
            status:       newStatus,
            delivered_at: allDone ? now : (currentDelivery.delivered_at || null)
        });
        currentDelivery.status = newStatus;
        currentDelivery.stops  = JSON.stringify(stops);
        updateStatusDisplay(newStatus);

        const doneBtn = document.getElementById(`stopDoneBtn_${idx}`);
        if (doneBtn) {
            doneBtn.innerHTML    = `<i class="fas fa-check-double"></i> ✅ 하차완료 (${formatDateShort(now)})`;
            doneBtn.style.opacity      = '0.6';
            doneBtn.style.pointerEvents = 'none';
        }
        const badge = document.getElementById(`stopBadge_${idx}`);
        if (badge) { badge.textContent = '완료'; badge.classList.add('done'); }

        if (allDone) {
            gpsKeepAlive = false;
            stopGPS();
            stopAlertCheck();           // 저속/상차시간 알림 중지
            stopSessionValidPoll();     // ★ 세션 유효성 폴링 중지
            stopGpsRequestPoll();       // GPS 위치 폴링 중지
            stopPhotoRequestPoll();     // 사진 요청 폴링 중지
            lowSpeedStartAt = null;
            lowSpeedAlertAt = null;
            loadedAlertAt   = null;
            lsClearWork(); // 하차완료 시 localStorage 업무 세션 삭제
            showToast('🎉 모든 하차 완료! GPS가 자동으로 종료됩니다.', 'success');
            // ★ 하차완료 알림 전송
            sendDriverNotification('delivered');
        } else {
            showToast(`${stops[idx].label} 하차 완료!`, 'success');
        }
    } catch (err) {
        console.error(err);
        showToast('처리 실패.', 'error');
    }
}

/* ★ stops 저장 — stops JSON에는 메타데이터만, 이미지는 stop_photos 별도 필드
   (DB 스키마에 stop_photos 필드 정의됨 — v20250321E)
   stop_photos 구조: { "0": {invoice_photo, temp_photo, extra_photos}, "1": {...} }
*/
async function saveStopsToServer() {
    // 1. 이미지 없는 슬림 stops 준비 (메타데이터만)
    const slimStops = stops.map(s => {
        // eslint-disable-next-line no-unused-vars
        const { invoice_photo, temp_photo, extra_photos, ...meta } = s;
        return meta;
    });

    // 2. stops 메타데이터 PATCH
    await apiPatch(`tables/deliveries/${currentDelivery.id}`, {
        stops: JSON.stringify(slimStops)
    });
    currentDelivery.stops = JSON.stringify(slimStops);
}

/* ★ stop_photos 필드에 이미지 저장
   stops 배열의 모든 이미지를 stop_photos JSON 필드에 모아서 PATCH
   DB에 스키마 필드(stop_photos)로 저장 → 안전하게 보존됨 */
async function saveStopPhotos() {
    // 현재 stop_photos JSON 빌드
    const photos = {};
    stops.forEach((s, i) => {
        const entry = {};
        if (s.invoice_photo !== undefined) entry.invoice_photo = s.invoice_photo;
        if (s.temp_photo    !== undefined) entry.temp_photo    = s.temp_photo;
        if (s.extra_photos  !== undefined) entry.extra_photos  = s.extra_photos;
        if (Object.keys(entry).length > 0) photos[String(i)] = entry;
    });
    const json = JSON.stringify(photos);
    const sizeKB = Math.round(json.length / 1024);

    // ★ 페이로드 크기 로그 — 디버깅용
    console.log(`[saveStopPhotos] 페이로드 크기: ${sizeKB}KB, stops수: ${stops.length}`);

    if (sizeKB > 900) {
        console.warn('[saveStopPhotos] 페이로드가 너무 큽니다. 저장을 건너뜁니다.');
        showToast('⚠️ 하차 사진 저장 실패: 사진 크기 초과. UVIS 서버 연결을 확인해주세요.', 'error', 4000);
        return;
    }

    try {
        await apiPatch(`tables/deliveries/${currentDelivery.id}`, { stop_photos: json });
        currentDelivery.stop_photos = json;
        console.log('[saveStopPhotos] 저장 성공');
    } catch (err) {
        console.error('[saveStopPhotos] PATCH 실패:', err.message);
        showToast('⚠️ 하차 사진 저장 실패. 다시 시도해주세요.', 'error', 3000);
        throw err; // 호출부에서 처리
    }
}

/* ★ DB에서 읽은 delivery 객체로 stops 배열에 이미지 복원
   stop_photos JSON 필드에서 각 stop의 이미지를 stops 배열에 주입 */
function restoreStopPhotos(parsedStops, delivery) {
    let photos = {};
    if (delivery.stop_photos) {
        try { photos = JSON.parse(delivery.stop_photos); } catch { photos = {}; }
    }
    parsedStops.forEach((s, i) => {
        const p = photos[String(i)];
        if (!p) return;
        if (p.invoice_photo !== undefined) s.invoice_photo = p.invoice_photo;
        if (p.temp_photo    !== undefined) s.temp_photo    = p.temp_photo;
        if (p.extra_photos  !== undefined) s.extra_photos  = p.extra_photos;
    });
    return parsedStops;
}

/* =====================
   로그아웃
   ===================== */
function handleFullLogout() {
    gpsKeepAlive = false;
    stopGPS();
    stopGpsRequestPoll();    // GPS 위치 폴링 중지
    stopPhotoRequestPoll();  // 사진 요청 폴링 중지
    stopSessionValidPoll();  // 세션 유효성 폴링 중지
    stopAlertCheck();        // 저속/상차시간 알림 중지
    lowSpeedStartAt = null;
    lowSpeedAlertAt = null;
    loadedAlertAt   = null;
    currentDriverName = null; currentDelivery = null; stops = [];
    Session.remove('driver_session');
    lsClearAll();
    const ne = document.getElementById('pinDriverName');
    const ce = document.getElementById('pinCode');
    if (ne) ne.value = '';
    if (ce) ce.value = '';
    const form = document.getElementById('driverPinForm');
    if (form) form.dataset.bound = ''; // ★ 플래그 초기화로 재바인딩 가능하게
    showToast('로그아웃되었습니다.', 'default');
    showPinSection(); // ★ showPinSection 내부에서 initPinEventListeners() 재호출됨
}

/* ================================================
   ★ GPS 위치 요청 폴링
   화주가 "현재 위치 요청" 버튼 클릭 시
   → DB의 gps_request_at 갱신
   → 기사 앱이 5초마다 감지 → 즉시 GPS 전송
   ================================================ */
function startGpsRequestPoll() {
    stopGpsRequestPoll();
    if (!currentDelivery) return;

    // 시작 시 현재 요청 시각을 기준으로 설정 (이전 요청 무시)
    lastKnownRequestAt = currentDelivery.gps_request_at
        ? Number(currentDelivery.gps_request_at) : 0;

    gpsRequestPollTimer = setInterval(async () => {
        if (!currentDelivery) { stopGpsRequestPoll(); return; }
        try {
            const res = await fetch(`tables/deliveries/${currentDelivery.id}`);

            // ★ 배송건 삭제 감지 → 자동 로그아웃
            if (res.status === 404 || res.status === 410) {
                handleDeliveryDeleted();
                return;
            }
            if (!res.ok) return;
            const d = await res.json();

            // ★ deleted 플래그 감지
            if (d.deleted) {
                handleDeliveryDeleted();
                return;
            }

            const reqAt = d.gps_request_at ? Number(d.gps_request_at) : 0;
            if (reqAt > lastKnownRequestAt && reqAt > Date.now() - 60000) {
                lastKnownRequestAt = reqAt;
                await sendGpsNow();
            }
        } catch (e) { /* 네트워크 오류 무시 */ }
    }, 5000);
}

function stopGpsRequestPoll() {
    if (gpsRequestPollTimer) {
        clearInterval(gpsRequestPollTimer);
        gpsRequestPollTimer = null;
    }
}

/* ★ 배송건 삭제 감지 → 자동 초기화 및 로그아웃 */
function handleDeliveryDeleted() {
    // 모든 타이머/GPS 중지
    stopGPS();
    stopGpsRequestPoll();
    stopPhotoRequestPoll();
    stopSessionValidPoll();  // ★ 세션 유효성 폴링 중지
    stopAlertCheck();
    releaseWakeLock();
    gpsKeepAlive = false;

    // 세션/업무 데이터 완전 초기화
    currentDelivery   = null;
    currentDriverName = null;
    stops             = [];
    loadingExtraPhotos = [];
    lsClearAll();
    Session.remove('driver_session');

    // 알림 후 PIN 로그인 화면으로
    showToast('⚠️ 배송건이 삭제되어 앱이 초기화됩니다.', 'error', 4000);
    setTimeout(() => showPinSection(), 1500);
}

/* ================================================
   ★ 사진 촬영 요청 폴링 (화주 → 기사 앱 알림)
   ================================================ */
function startPhotoRequestPoll() {
    stopPhotoRequestPoll();
    if (!currentDelivery) return;

    lastKnownPhotoRequestAt = currentDelivery.photo_request_at
        ? Number(currentDelivery.photo_request_at) : 0;

    photoRequestPollTimer = setInterval(async () => {
        if (!currentDelivery) { stopPhotoRequestPoll(); return; }
        try {
            const res = await fetch(`tables/deliveries/${currentDelivery.id}`);

            // ★ 배송건 삭제 감지 → 자동 로그아웃
            if (res.status === 404 || res.status === 410) {
                handleDeliveryDeleted();
                return;
            }
            if (!res.ok) return;
            const d = await res.json();

            // ★ deleted 플래그 감지
            if (d.deleted) {
                handleDeliveryDeleted();
                return;
            }

            const reqAt = d.photo_request_at ? Number(d.photo_request_at) : 0;
            if (reqAt > lastKnownPhotoRequestAt && reqAt > Date.now() - 120000) {
                lastKnownPhotoRequestAt = reqAt;
                const reqType = d.photo_request_type || '';
                showPhotoRequestAlert(reqType);
            }
        } catch (e) { /* 네트워크 오류 무시 */ }
    }, 5000); // 5초마다 폴링
}

function stopPhotoRequestPoll() {
    if (photoRequestPollTimer) {
        clearInterval(photoRequestPollTimer);
        photoRequestPollTimer = null;
    }
}

/* ================================================
   ★ 세션 유효성 폴링
   30초마다 배송건·방 존재 여부를 확인 →
   삭제됐거나 기사 정보가 없으면 GPS 자동 종료
   ================================================ */
function startSessionValidPoll() {
    stopSessionValidPoll();
    if (!currentDelivery) return;

    sessionValidPollTimer = setInterval(async () => {
        if (!currentDelivery) { stopSessionValidPoll(); return; }
        try {
            // 1) 배송건 존재 확인
            const res = await fetch(`tables/deliveries/${currentDelivery.id}`);

            if (res.status === 404 || res.status === 410) {
                handleDeliveryDeleted();
                return;
            }
            if (!res.ok) return; // 일시적 서버 오류 — 다음 주기에 재시도

            const d = await res.json();
            if (d.deleted) { handleDeliveryDeleted(); return; }

            // 2) 방(room) 존재 확인
            if (d.room_id) {
                const roomRes = await fetch(`tables/rooms/${d.room_id}`);
                if (roomRes.status === 404 || roomRes.status === 410) {
                    // 방이 삭제됨 → GPS 종료 + 로그아웃
                    _handleRoomDeleted();
                    return;
                }
                if (roomRes.ok) {
                    const room = await roomRes.json();
                    if (room.deleted || room.is_active === false) {
                        _handleRoomDeleted();
                        return;
                    }
                }
            }

            // 3) 기사 이름 일치 여부 확인 (배송건에서 기사 이름이 바뀌면 감지)
            if (currentDriverName && d.driver_name &&
                d.driver_name.replace(/\s/g,'') !== currentDriverName.replace(/\s/g,'')) {
                handleDeliveryDeleted();
                return;
            }

        } catch (e) { /* 네트워크 오류 — 무시하고 다음 주기 진행 */ }
    }, 30000); // 30초마다 확인
}

function stopSessionValidPoll() {
    if (sessionValidPollTimer) {
        clearInterval(sessionValidPollTimer);
        sessionValidPollTimer = null;
    }
}

/* 방(room)이 삭제된 경우 처리 */
function _handleRoomDeleted() {
    stopGPS();
    stopGpsRequestPoll();
    stopPhotoRequestPoll();
    stopSessionValidPoll();
    stopAlertCheck();
    releaseWakeLock();
    gpsKeepAlive = false;

    currentDelivery    = null;
    currentDriverName  = null;
    stops              = [];
    loadingExtraPhotos = [];
    lsClearAll();
    Session.remove('driver_session');

    showToast('⚠️ 고객사 방이 삭제되어 GPS가 종료됩니다. 관리자에게 문의하세요.', 'error', 5000);
    setTimeout(() => showPinSection(), 2000);
}

function showPhotoRequestAlert(reqType) {
    // reqType → 사람이 읽기 쉬운 문자로 변환
    const typeLabels = {
        'loading_invoice':  '상차 거래명세표',
        'loading_temp':     '상차 온도기록지',
        'delivery_invoice': '하차 거래명세표',
        'delivery_temp':    '하차 온도기록지',
    };
    // stop_invoice_0, stop_temp_1 등 패턴 처리
    let label = typeLabels[reqType] || '';
    if (!label) {
        const m = reqType.match(/^stop_(invoice|temp)_(\d+)$/);
        if (m) label = `하차${Number(m[2])+1} ${m[1] === 'invoice' ? '거래명세표' : '온도기록지'}`;
        else    label = '서류 사진';
    }

    // 화면 최상단에 배너 알림
    showPhotoRequestBanner(label);
    // 토스트도 함께 표시
    showToast(`📸 화주 요청: ${label} 사진을 촬영해 주세요!`, 'warning', 8000);
}

function showPhotoRequestBanner(label) {
    let banner = document.getElementById('photoRequestBanner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'photoRequestBanner';
        banner.style.cssText = [
            'position:fixed;top:0;left:0;right:0;z-index:9999',
            'background:linear-gradient(90deg,#f59e0b,#ef4444)',
            'color:#fff;text-align:center;padding:14px 16px',
            'font-size:0.9rem;font-weight:700;line-height:1.5',
            'box-shadow:0 4px 16px rgba(0,0,0,0.3)',
            'animation:fadeInDown 0.3s ease'
        ].join(';');
        document.body.appendChild(banner);
    }
    banner.innerHTML = `
        <i class="fas fa-camera" style="font-size:1.1rem;"></i>
        &nbsp;화주 요청&nbsp;|&nbsp;<strong>${label}</strong> 사진을 촬영해 주세요!
        <button onclick="document.getElementById('photoRequestBanner').remove()"
            style="margin-left:12px;background:rgba(255,255,255,0.25);border:none;color:#fff;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:0.8rem;">
            확인
        </button>
    `;
    banner.style.display = 'block';
    // 30초 후 자동 숨김
    setTimeout(() => { if (banner) banner.remove(); }, 30000);
}

// 현재 위치를 즉시 서버에 전송
async function sendGpsNow() {
    if (!currentDelivery || currentDelivery.status === 'delivered') return;

    // 네이티브 앱: FusedLocation에서 마지막 위치 사용 (이미 GpsService가 주기적으로 전송 중)
    // 웹: navigator.geolocation.getCurrentPosition으로 즉시 취득
    if (window.AndroidGPS) {
        // 앱은 GpsService가 이미 주기적으로 보내고 있으므로 별도 처리 불필요
        // (GpsService의 다음 전송 주기까지 최대 30초 → 이미 충분히 빠름)
        return;
    }

    return new Promise((resolve) => {
        if (!navigator.geolocation) { resolve(); return; }
        navigator.geolocation.getCurrentPosition(async (pos) => {
            try {
                const lat = pos.coords.latitude;
                const lng = pos.coords.longitude;
                const now = Date.now();
                await apiPatch(`tables/deliveries/${currentDelivery.id}`, {
                    current_lat: lat, current_lng: lng,
                    gps_updated_at: now,
                    status: currentDelivery.status === 'waiting' || currentDelivery.status === 'loading'
                        ? 'transit' : currentDelivery.status
                });
                currentDelivery.current_lat = lat;
                currentDelivery.current_lng = lng;
                window._lastGpsUpdate = now; // 쓰로틀 초기화
            } catch (e) { console.warn('즉시 GPS 전송 실패:', e); }
            resolve();
        }, () => resolve(), { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 });
    });
}

/* ================================================
   ★ GPS — 지속 유지 + 자동 재시도
   ================================================ */
function handleStopGpsClick() {
    if (gpsKeepAlive) {
        showToast('모든 하차 완료 전에는 GPS를 끌 수 없습니다.', 'warning');
        return;
    }
    stopGPS();
}

function startGPS() {
    // ★ 네이티브 앱(AndroidGPS 브릿지) 환경 — Foreground Service 사용
    if (window.AndroidGPS && currentDelivery) {
        window.AndroidGPS.startGps(currentDelivery.id);
        setGpsUI('on');
        hide('btnStartGPS');
        show('btnStopGPS');
        const noticeA = document.getElementById('gpsKeepAliveNotice');
        if (noticeA) noticeA.style.display = gpsKeepAlive ? 'block' : 'none';
        const bannerA = document.getElementById('gpsKeepBanner');
        if (bannerA) bannerA.style.display = gpsKeepAlive ? 'block' : 'none';
        if (gpsKeepAlive) requestWakeLock();
        return;  // 네이티브 GPS 사용 — watchPosition 불필요
    }
    // 웹 브라우저 환경 — watchPosition 방식
    if (!navigator.geolocation) { showToast('GPS 미지원 기기입니다.', 'error'); return; }
    clearGpsRetry();

    hide('btnStartGPS');
    show('btnStopGPS');
    setGpsUI('on');

    // 하차 미완료 시 GPS 유지 안내 배너 표시
    const notice = document.getElementById('gpsKeepAliveNotice');
    if (notice) notice.style.display = gpsKeepAlive ? 'block' : 'none';
    const banner = document.getElementById('gpsKeepBanner');
    if (banner) banner.style.display = gpsKeepAlive ? 'block' : 'none';

    // Wake Lock 시작 (화면 꺼짐 방지)
    if (gpsKeepAlive) requestWakeLock();

    gpsWatchId = navigator.geolocation.watchPosition(
        onGPSSuccess,
        onGPSError,
        { enableHighAccuracy: true, timeout: 0, maximumAge: 10000 }
    );
}

function stopGPS() {
    // ★ 네이티브 앱 환경
    if (window.AndroidGPS) window.AndroidGPS.stopGps();

    clearGpsRetry();
    stopBgCounter();
    if (gpsWatchId !== null) {
        navigator.geolocation.clearWatch(gpsWatchId);
        gpsWatchId = null;
    }
    show('btnStartGPS');
    hide('btnStopGPS');
    setGpsUI('off');
    const c = document.getElementById('gpsCoords');
    if (c) { c.textContent = 'GPS 중지됨'; c.className = 'gps-coords'; }
    const notice = document.getElementById('gpsKeepAliveNotice');
    if (notice) notice.style.display = 'none';
    const banner = document.getElementById('gpsKeepBanner');
    if (banner) banner.style.display = 'none';
    // Wake Lock 해제
    releaseWakeLock();
}

function setGpsUI(state) {
    const el = document.getElementById('gpsStatus');
    if (!el) return;
    if (state === 'on') {
        el.className = 'gps-status gps-on';
        el.innerHTML = '<i class="fas fa-location-arrow"></i> GPS 켜짐';
    } else if (state === 'retry') {
        el.className = 'gps-status gps-retry';
        el.innerHTML = '<i class="fas fa-sync fa-spin"></i> GPS 재연결 중...';
    } else {
        el.className = 'gps-status gps-off';
        el.innerHTML = '<i class="fas fa-location-arrow"></i> GPS 꺼짐';
    }
}

function clearGpsRetry() {
    if (gpsRetryTimer) { clearTimeout(gpsRetryTimer); gpsRetryTimer = null; }
}

async function onGPSSuccess(pos) {
    clearGpsRetry();
    setGpsUI('on');

    const lat   = pos.coords.latitude;
    const lng   = pos.coords.longitude;
    const acc   = Math.round(pos.coords.accuracy);
    // 속도: m/s → km/h (null이면 0으로 처리)
    const speedMs  = pos.coords.speed || 0;
    const speedKmh = Math.round(speedMs * 3.6);

    // 저속 감지 업데이트
    updateLowSpeedTracking(speedKmh);

    const coordEl = document.getElementById('gpsCoords');
    if (coordEl) {
        coordEl.className   = 'gps-coords active';
        coordEl.textContent = `📍 ${lat.toFixed(5)}, ${lng.toFixed(5)}${speedKmh > 0 ? `  🚗 ${speedKmh}km/h` : ''}`;
    }
    const accEl = document.getElementById('gpsAccuracy');
    if (accEl) accEl.textContent = `정확도: ±${acc}m`;
    const updEl = document.getElementById('gpsLastUpdate');
    if (updEl) updEl.textContent = `업데이트: ${new Date().toLocaleTimeString('ko-KR')}`;

    // 30초 쓰로틀링
    const now = Date.now();
    if (!window._lastGpsUpdate || now - window._lastGpsUpdate > 30000) {
        window._lastGpsUpdate = now;
        if (currentDelivery && currentDelivery.status !== 'delivered') {
            try {
                const ns = (currentDelivery.status === 'waiting' || currentDelivery.status === 'loading')
                    ? 'transit' : currentDelivery.status;
                await apiPatch(`tables/deliveries/${currentDelivery.id}`, {
                    current_lat: lat, current_lng: lng,
                    current_speed: speedKmh,
                    gps_updated_at: now, status: ns
                });
                if (currentDelivery.status !== ns) {
                    currentDelivery.status = ns;
                    updateStatusDisplay(ns);
                }
                currentDelivery.current_lat   = lat;
                currentDelivery.current_lng   = lng;
                currentDelivery.current_speed = speedKmh;
            } catch (e) { console.warn('GPS 업데이트 실패:', e); }
        }
    }
}

function onGPSError(err) {
    const msgs = {
        1: '위치 권한 거부. 브라우저 설정에서 허용해 주세요.',
        2: '위치 신호 없음. 5초 후 재시도합니다.',
        3: 'GPS 시간 초과. 5초 후 재시도합니다.'
    };
    const msg = msgs[err.code] || 'GPS 오류 발생';
    const coordEl = document.getElementById('gpsCoords');
    if (coordEl) { coordEl.textContent = msg; coordEl.className = 'gps-coords'; }

    if (err.code === 1) {
        // 권한 거부 — 재시도 불가
        gpsKeepAlive = false;
        showToast(msg, 'error');
        stopGPS();
        return;
    }

    // code:2(위치없음), code:3(타임아웃) — gpsKeepAlive 여부와 무관하게 재시도
    // (네비 앱 전환, 백그라운드, 실내 등 일시적 신호 손실 대응)
    setGpsUI('retry');
    clearGpsRetry();
    gpsRetryTimer = setTimeout(() => {
        if (gpsWatchId !== null) {
            navigator.geolocation.clearWatch(gpsWatchId);
            gpsWatchId = null;
        }
        startGPS();
    }, 5000);
}

/* =====================
   UI 헬퍼
   ===================== */
function showUploadingSpinner(previewId) {
    const el = document.getElementById(previewId);
    if (!el) return;
    el.innerHTML = `
        <div style="position:absolute;inset:0;display:flex;flex-direction:column;
                    align-items:center;justify-content:center;
                    background:rgba(248,250,252,0.95);gap:8px;border-radius:inherit;">
            <i class="fas fa-spinner fa-spin" style="font-size:2rem;color:#2563eb;"></i>
            <span style="font-size:0.78rem;font-weight:600;color:#2563eb;">업로드 중...</span>
        </div>`;
}

function setPhotoPreview(previewId, base64) {
    const el = document.getElementById(previewId);
    if (!el) return;
    el.innerHTML = `<img src="${base64}" alt="사진"
        style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit;">`;
}

function setPhotoStatus(statusId, ok, dateKey) {
    const el = document.getElementById(statusId);
    if (!el) return;
    if (ok) {
        el.innerHTML = `<i class="fas fa-check-circle" style="color:var(--success);"></i> 완료<br>
            <small style="color:var(--gray-400);">${dateKey || ''}</small>`;
    } else {
        el.innerHTML = '';
    }
}

/* 촬영/선택 숨기고 수정 버튼 보이기 */
function showEditBtn(labelId, editBtnId) {
    const label = document.getElementById(labelId);
    const edit  = document.getElementById(editBtnId);
    if (label) label.style.display = 'none';
    if (edit)  edit.style.display  = 'flex';
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ================================================
   ★ 추가사진 — 상차/하차 물품사진 등 자유 첨부
   ================================================ */

/**
 * 추가사진 input 파일선택 트리거
 * section: 'loading' | 'stop_0' | 'stop_1' ...
 */
function triggerExtraPhoto(section) {
    const inputId = `${section}ExtraInput`;
    const input   = document.getElementById(inputId);
    if (!input) return;
    input.value = '';
    input.click();
}

/**
 * input change 이벤트 바인딩 (한 번만)
 */
function bindExtraPhotoInput(section) {
    // section: 'loading' → inputId: 'loadingExtraInput'
    // section: 'stop_0'  → inputId: 'stop_0ExtraInput'
    const realInputId = `${section}ExtraInput`;
    const input = document.getElementById(realInputId);
    if (!input) return;

    // ★ input.onclick, wrap.onclick 모두 제거
    // filePickerOpen 플래그는 visibilitychange(hidden) 에서 자동 설정됨
    input.onclick = null;
    const wrap = input.closest('.file-btn-wrap');
    if (wrap) wrap.onclick = null;

    // ★ onchange 프로퍼티로 덮어씌우기 — 중복 핸들러 방지
    input.onchange = async function () {
        setFilePickerOpen(false);
        if (!this.files || !this.files.length) return;
        const fileInfos = Array.from(this.files).map(f => ({
            file: f, name: f.name, type: f.type || 'image/jpeg'
        }));
        this.value = '';
        for (const fi of fileInfos) {
            try {
                const safeFile = await readFileToMemory(fi.file, fi.name, fi.type);
                await uploadOneExtraPhoto(section, safeFile);
            } catch (e) {
                console.error('[extraPhoto] 읽기 실패:', e);
                showToast('사진 읽기 실패. 다시 시도해주세요.', 'error');
            }
        }
    };
    input._handlerBound = true;
}

/**
 * 사진 1장 업로드 후 배열 갱신 + 서버 저장
 */
async function uploadOneExtraPhoto(section, file) {
    // 임시 썸네일: 업로드 스피너를 그리드에 추가
    const tempId = `extraThumb_${section}_tmp_${Date.now()}`;
    addExtraThumbSpinner(section, tempId);

    try {
        // silent:true — UVIS 실패 토스트는 여기서 제어
        const url = await uploadImage(file, { silent: true });
        if (url && !url.startsWith('http')) {
            showToast('⚠️ 이미지 서버 연결 실패. 사진을 직접 저장합니다.', 'warning', 3000);
        }
        const photo = { url, caption: '', ts: Date.now() };

        if (section === 'loading') {
            loadingExtraPhotos.push(photo);
            await saveLoadingExtraPhotos();
        } else {
            // section: 'stop_0', 'stop_1', ...
            const idx = parseInt(section.split('_')[1]);
            if (!stops[idx].extra_photos) stops[idx].extra_photos = [];
            stops[idx].extra_photos.push(photo);
            // ★ stop_photos 필드에 이미지 저장 + stops 메타데이터 저장
            await saveStopPhotos();
            await saveStopsToServer();
        }

        renderExtraPhotoGrid(section);
        showToast('📸 사진이 추가되었습니다.', 'success');
    } catch (err) {
        console.error(err);
        showToast('사진 업로드 실패.', 'error');
        // 스피너 제거
        const el = document.getElementById(tempId);
        if (el) el.remove();
        updateExtraCount(section);
    }
}

/** 그리드에 업로드 스피너 썸네일 추가 */
function addExtraThumbSpinner(section, tempId) {
    const grid = document.getElementById(`${section}ExtraGrid`);
    if (!grid) return;
    const thumb = document.createElement('div');
    thumb.id = tempId;
    thumb.style.cssText = `
        position:relative;aspect-ratio:1;border-radius:8px;
        background:#f1f5f9;display:flex;align-items:center;
        justify-content:center;overflow:hidden;`;
    thumb.innerHTML = `<i class="fas fa-spinner fa-spin" style="font-size:1.2rem;color:#6366f1;"></i>`;
    grid.appendChild(thumb);
}

/**
 * 추가사진 그리드 전체 렌더링
 */
function renderExtraPhotoGrid(section) {
    const grid = document.getElementById(`${section}ExtraGrid`);
    if (!grid) return;

    const photos = getExtraPhotos(section);
    grid.innerHTML = '';

    photos.forEach((photo, i) => {
        const thumb = document.createElement('div');
        thumb.style.cssText = `
            position:relative;aspect-ratio:1;border-radius:8px;
            overflow:hidden;background:#f1f5f9;cursor:pointer;`;

        thumb.innerHTML = `
            <img src="${photo.url}" alt="추가사진 ${i + 1}"
                style="width:100%;height:100%;object-fit:cover;"
                onclick="openLightbox('${photo.url}','추가사진 ${i + 1}')">
            <button onclick="deleteExtraPhoto('${section}',${i})"
                style="position:absolute;top:3px;right:3px;
                       width:20px;height:20px;border-radius:50%;
                       background:rgba(220,38,38,0.85);color:#fff;
                       border:none;cursor:pointer;font-size:0.65rem;
                       display:flex;align-items:center;justify-content:center;
                       line-height:1;padding:0;">
                <i class="fas fa-times"></i>
            </button>`;
        grid.appendChild(thumb);
    });

    updateExtraCount(section);
}

/** 사진 배열 가져오기 */
function getExtraPhotos(section) {
    if (section === 'loading') return loadingExtraPhotos;
    const idx = parseInt(section.split('_')[1]);
    return (stops[idx] && stops[idx].extra_photos) ? stops[idx].extra_photos : [];
}

/** 카운트 배지 갱신 */
function updateExtraCount(section) {
    const countEl = document.getElementById(`${section}ExtraCount`);
    if (!countEl) return;
    const cnt = getExtraPhotos(section).length;
    countEl.textContent = `(${cnt}장)`;
}

/** 추가사진 삭제 */
async function deleteExtraPhoto(section, idx) {
    if (!await showConfirm('이 사진을 삭제하시겠습니까?', '삭제', true)) return;
    try {
        if (section === 'loading') {
            loadingExtraPhotos.splice(idx, 1);
            await saveLoadingExtraPhotos();
        } else {
            const stopIdx = parseInt(section.split('_')[1]);
            if (stops[stopIdx] && stops[stopIdx].extra_photos) {
                stops[stopIdx].extra_photos.splice(idx, 1);
                // ★ stop_photos 필드 업데이트
                await saveStopPhotos();
                await saveStopsToServer();
            }
        }
        renderExtraPhotoGrid(section);
        showToast('사진이 삭제되었습니다.', 'default');
    } catch (err) {
        console.error(err);
        showToast('삭제 실패. 다시 시도해주세요.', 'error');
    }
}

/** 상차 추가사진 서버 저장 */
async function saveLoadingExtraPhotos() {
    const json = JSON.stringify(loadingExtraPhotos);
    const sizeKB = Math.round(json.length / 1024);
    console.log(`[saveLoadingExtraPhotos] 페이로드 크기: ${sizeKB}KB, 사진수: ${loadingExtraPhotos.length}`);
    if (sizeKB > 900) {
        console.warn('[saveLoadingExtraPhotos] 페이로드가 너무 큽니다. 저장을 건너뜁니다.');
        showToast('⚠️ 추가사진 저장 실패: 사진 크기 초과. 재촬영해주세요.', 'error', 4000);
        return;
    }
    try {
        await apiPatch(`tables/deliveries/${currentDelivery.id}`, {
            loading_extra_photos: json
        });
        currentDelivery.loading_extra_photos = json;
        console.log('[saveLoadingExtraPhotos] 저장 성공');
    } catch (err) {
        console.error('[saveLoadingExtraPhotos] 저장 실패:', err.message);
        showToast('⚠️ 상차 추가사진 저장 실패. 다시 시도해주세요.', 'error', 3000);
        throw err;
    }
}

/* ================================================
   ★ 저속 감지 + 상차 4시간 알림 체크
   ================================================ */

/**
 * GPS 업데이트마다 호출 — 저속 지속시간 추적
 * @param {number} speedKmh - 현재 속도(km/h)
 */
function updateLowSpeedTracking(speedKmh) {
    if (!currentDelivery || currentDelivery.status === 'delivered') {
        lowSpeedStartAt = null;
        return;
    }
    // 상차완료(loading) 또는 운송중(transit) 상태에서만 감지
    const trackableStatus = ['loading', 'transit'];
    if (!trackableStatus.includes(currentDelivery.status)) {
        lowSpeedStartAt = null;
        return;
    }

    if (speedKmh < LOW_SPEED_THRESHOLD) {
        // 저속 시작 시각 기록 (처음 진입)
        if (!lowSpeedStartAt) {
            lowSpeedStartAt = Date.now();
        }
    } else {
        // ★ 속도가 회복되면 저속 타이머 및 알림 플래그 리셋
        if (lowSpeedStartAt) {
            lowSpeedStartAt = null;
            lowSpeedAlertAt = null; // 속도 회복 → 다음 저속 구간에 다시 발동 가능
        }
    }
}

/**
 * 주기적 체크 타이머 (1분 간격):
 *  ① 저속 40분 도달 후 → 속도 회복 전까지 5분마다 알림
 *  ② 상차 4시간 경과 후 → 하차완료 전까지 5분마다 알림
 */
function startAlertCheck() {
    stopAlertCheck();
    if (!currentDelivery) return;

    alertCheckTimer = setInterval(async () => {
        if (!currentDelivery || currentDelivery.status === 'delivered') {
            stopAlertCheck();
            return;
        }

        const now = Date.now();

        /* ── ① 저속 지속 알림 ──
           조건: 저속 시작 후 40분 경과 AND (아직 한 번도 안 보냈거나 마지막 발송 후 5분 경과)
           종료: 속도 회복 시 updateLowSpeedTracking()에서 lowSpeedAlertAt을 null로 리셋 */
        if (lowSpeedStartAt &&
            (now - lowSpeedStartAt >= LOW_SPEED_DURATION)) {

            if (!lowSpeedAlertAt || (now - lowSpeedAlertAt >= REPEAT_INTERVAL)) {
                lowSpeedAlertAt = now;
                await sendDriverNotification('low_speed_alert');
                showToast('⚠️ 저속(15km/h 미만) 지속 중 — 화주·관리자에게 알림이 전송되었습니다.', 'warning', 6000);
            }
        }

        /* ── ② 상차 후 4시간 경과 알림 ──
           조건: loaded_at 기준 4시간 경과 AND (아직 한 번도 안 보냈거나 마지막 발송 후 5분 경과)
           종료: 도착하차대기 버튼을 누르면 loadedAlertAt = Infinity로 차단됨
                 전체 하차완료(delivered) 시 alertCheckTimer 자체가 중단됨 */
        const loadedAt = currentDelivery.loaded_at ? Number(currentDelivery.loaded_at) : 0;
        if (loadedAt > 0 &&
            loadedAlertAt !== Infinity &&                      // 도착대기 처리 후엔 발송 안 함
            (now - loadedAt >= LOADED_ALERT_DELAY)) {

            if (!loadedAlertAt || (now - loadedAlertAt >= REPEAT_INTERVAL)) {
                loadedAlertAt = now;
                await sendDriverNotification('loaded_timeout');
                showToast('⏰ 상차 후 4시간 경과 — 화주·관리자에게 알림이 전송되었습니다.', 'warning', 6000);
            }
        }
    }, 60 * 1000); // 1분마다 체크
}

function stopAlertCheck() {
    if (alertCheckTimer) {
        clearInterval(alertCheckTimer);
        alertCheckTimer = null;
    }
}

/* ================================================
   ★ 알림 전송 (기사 이벤트 → DB → 관리자/고객사 폴링)
   ================================================ */
async function sendDriverNotification(eventType, stopIdx = null) {
    if (!currentDelivery) return;
    const d = currentDelivery;

    // 하차지 라벨 (stop_arrived 이벤트에만 사용)
    const stopLabel = (stopIdx !== null && stops[stopIdx])
        ? stops[stopIdx].label
        : '';

    const messages = {
        driver_login:    `🚛 기사 접속 | ${d.driver_name || '기사'} (${d.vehicle_number || '-'}) 앱 접속`,
        loaded:          `📦 상차완료 | ${d.driver_name || '기사'} (${d.vehicle_number || '-'}) 상차 완료`,
        delivered:       `✅ 하차완료 | ${d.driver_name || '기사'} (${d.vehicle_number || '-'}) 전체 하차 완료`,
        low_speed_alert: `⚠️ 저속 장시간 | ${d.driver_name || '기사'} (${d.vehicle_number || '-'}) 15km/h 미만 40분 지속`,
        loaded_timeout:  `⏰ 상차 4시간 경과 | ${d.driver_name || '기사'} (${d.vehicle_number || '-'}) 상차 후 4시간 초과, 하차 미완료`,
        stop_arrived:    `📍 하차지 도착 | ${d.driver_name || '기사'} (${d.vehicle_number || '-'}) [${stopLabel}] 도착 · 하차 대기 중`
    };

    const msg = messages[eventType] || eventType;

    try {
        await fetch('tables/notifications', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                delivery_id:    d.id,
                room_id:        d.room_id || '',
                event_type:     eventType,
                driver_name:    d.driver_name || '',
                vehicle_number: d.vehicle_number || '',
                cargo_type:     d.cargo_type || '',
                message:        msg,
                created_at:     Date.now()
            })
        });
    } catch (e) {
        console.warn('[sendDriverNotification] 알림 전송 실패(무시):', e.message);
    }

    // ★ NOTE: 기사 앱에서는 네이티브 알림을 띄우지 않음.
    // sendDriverNotification은 화주/관리자용 알림 DB 기록 전송이 목적이며,
    // 화주/관리자 페이지(room.js, admin.js)의 폴링이 해당 알림을 토스트로 표시함.
    // (기사 앱 자신에게 푸시 알림을 보내면 기사가 자기 행동 알림을 받게 되는 문제 발생)
}

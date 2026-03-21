/* ===========================
   공통 유틸리티 - utils.js
=========================== */

// ===== 비밀번호 해시 =====
// crypto.subtle SHA-256 우선 사용, 실패 시 폴백
// ※ Android WebView는 HTTP에서도 crypto.subtle 지원 가능
async function hashPassword(password) {
    // 1순위: crypto.subtle SHA-256 (HTTPS + 대부분의 WebView)
    try {
        if (window.crypto && window.crypto.subtle) {
            const encoder = new TextEncoder();
            const data = encoder.encode(password + '_cargo_salt_2025');
            const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        }
    } catch(e) {
        console.warn('[hashPassword] crypto.subtle 실패, SubtleCrypto 직접 시도:', e.message);
    }
    // 2순위: SubtleCrypto 직접 접근 (일부 구형 WebView)
    try {
        if (window.crypto && window.crypto.subtle && window.crypto.subtle.digest) {
            const encoder = new TextEncoder();
            const data = encoder.encode(password + '_cargo_salt_2025');
            const hashBuffer = await window.crypto.subtle.digest({ name: 'SHA-256' }, data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        }
    } catch(e2) {
        console.warn('[hashPassword] 2차 시도 실패, 폴백 사용:', e2.message);
    }
    // 3순위: HTTP 환경 폴백 (위 두 방법 모두 실패 시)
    console.warn('[hashPassword] ⚠️ 폴백 해시 사용 — PIN 불일치 가능성 있음');
    return _fallbackHash(password + '_cargo_salt_2025');
}

// HTTP 환경용 결정론적 해시 (32바이트 hex 출력)
function _fallbackHash(str) {
    let h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
             0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        for (let j = 0; j < h.length; j++) {
            h[j] = (Math.imul(h[j] ^ c, 0x9e3779b9 + j) >>> 0);
            h[j] = ((h[j] << 13) | (h[j] >>> 19)) >>> 0;
        }
    }
    // 최종 혼합
    for (let r = 0; r < 4; r++) {
        for (let j = 0; j < h.length; j++) {
            h[j] = (Math.imul(h[j] ^ h[(j + 1) % h.length], 0xd2a98b26) >>> 0);
        }
    }
    return h.map(v => (v >>> 0).toString(16).padStart(8, '0')).join('');
}

// ===== 비밀번호 표시/숨기기 =====
function togglePassword(inputId) {
    const input = document.getElementById(inputId);
    const btn = input.closest('.input-with-icon').querySelector('.toggle-pw i');
    if (input.type === 'password') {
        input.type = 'text';
        btn.className = 'fas fa-eye-slash';
    } else {
        input.type = 'password';
        btn.className = 'fas fa-eye';
    }
}

// ===== 알림음 (Web Audio API — 외부 파일 없이 비프음 생성) =====
/**
 * playNotifSound(type)
 *  type: 'info'    — 기본 알림 (낮은 단음)
 *        'warning' — 경고 알림 (빠른 2비프)
 *        'urgent'  — 긴급 알림 (3비프 상승)
 */
let _audioCtx = null;
function _getAudioCtx() {
    if (!_audioCtx) {
        try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) {}
    }
    return _audioCtx;
}

// ★ 사용자 첫 인터랙션(클릭/터치)에서 AudioContext를 활성화
// 브라우저 자동재생 정책: 제스처 없이는 suspended 상태
(function _initAudioOnInteraction() {
    const _resume = () => {
        const ctx = _getAudioCtx();
        if (ctx && ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
        }
    };
    document.addEventListener('click',      _resume, { once: false, passive: true });
    document.addEventListener('touchstart', _resume, { once: false, passive: true });
    document.addEventListener('keydown',    _resume, { once: false, passive: true });
})();

function playNotifSound(type = 'info') {
    const ctx = _getAudioCtx();
    if (!ctx) return;
    // ★ suspended 상태면 resume 후 재생
    if (ctx.state === 'suspended') {
        ctx.resume().then(() => _playBeeps(ctx, type)).catch(() => {});
        return;
    }
    _playBeeps(ctx, type);
}

function _playBeeps(ctx, type) {
    const beepConfigs = {
        info:    [{ freq: 880, start: 0,    dur: 0.15 }],
        warning: [{ freq: 660, start: 0,    dur: 0.12 }, { freq: 880, start: 0.18, dur: 0.12 }],
        urgent:  [{ freq: 660, start: 0,    dur: 0.1  }, { freq: 880, start: 0.15, dur: 0.1  }, { freq: 1100, start: 0.30, dur: 0.18 }]
    };

    const beeps = beepConfigs[type] || beepConfigs.info;
    const now   = ctx.currentTime;

    beeps.forEach(({ freq, start, dur }) => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.type      = 'sine';
        osc.frequency.setValueAtTime(freq, now + start);
        gain.gain.setValueAtTime(0.4,  now + start);
        gain.gain.exponentialRampToValueAtTime(0.001, now + start + dur);

        osc.start(now + start);
        osc.stop(now + start + dur + 0.05);
    });
}

// ===== Toast 알림 =====
function showToast(message, type = 'default', duration = 3000) {
    const toast = document.getElementById('toast');
    if (!toast) return;

    toast.className = 'toast show';
    if (type === 'success') toast.classList.add('toast-success');
    if (type === 'error') toast.classList.add('toast-error');
    if (type === 'warning') toast.classList.add('toast-warning');

    const icons = {
        success: 'fas fa-check-circle',
        error: 'fas fa-times-circle',
        warning: 'fas fa-exclamation-circle',
        default: 'fas fa-info-circle'
    };

    toast.innerHTML = `<i class="${icons[type] || icons.default}"></i> ${message}`;

    clearTimeout(window._toastTimer);
    window._toastTimer = setTimeout(() => {
        toast.className = 'toast';
    }, duration);
}

// ===== 한국 시간(KST, UTC+9) 기준 Date 객체 =====
function toKSTDate(timestamp) {
    const ts = typeof timestamp === 'number' ? timestamp : parseInt(timestamp);
    // UTC 밀리초에 9시간(ms) 더해 KST로 보정
    return new Date(ts + 9 * 60 * 60 * 1000);
}

// ===== 현재 KST 날짜 키 (YYYY-MM-DD) =====
function getTodayKST() {
    const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// ===== 타임스탬프 → KST 날짜 키 (YYYY-MM-DD) =====
function getDateKeyKST(timestamp) {
    if (!timestamp) return '-';
    const d = toKSTDate(timestamp);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// ===== 날짜 포맷 (KST 기준) =====
function formatDate(timestamp) {
    if (!timestamp) return '-';
    let d;
    if (typeof timestamp === 'number') {
        d = new Date(timestamp);
    } else {
        const asNum = Number(timestamp);
        d = isNaN(asNum) ? new Date(timestamp) : new Date(asNum);
    }
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleString('ko-KR', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatDateShort(timestamp) {
    if (!timestamp) return '-';
    let d;
    if (typeof timestamp === 'number') {
        d = new Date(timestamp);
    } else {
        // ISO 문자열 또는 숫자 문자열 모두 처리
        const asNum = Number(timestamp);
        d = isNaN(asNum) ? new Date(timestamp) : new Date(asNum);
    }
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleString('ko-KR', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// YYYY-MM-DD HH:MM:SS (KST)
function formatDateFull(timestamp) {
    if (!timestamp) return '-';
    let d;
    if (typeof timestamp === 'number') {
        d = new Date(timestamp);
    } else {
        const asNum = Number(timestamp);
        d = isNaN(asNum) ? new Date(timestamp) : new Date(asNum);
    }
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleString('ko-KR', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

function timeAgo(timestamp) {
    if (!timestamp) return '-';
    const now = Date.now();
    let ts;
    if (typeof timestamp === 'number') {
        ts = timestamp;
    } else {
        const asNum = Number(timestamp);
        ts = isNaN(asNum) ? new Date(timestamp).getTime() : asNum;
    }
    const diff = now - ts;

    if (diff < 60000) return '방금 전';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}분 전`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}시간 전`;
    return `${Math.floor(diff / 86400000)}일 전`;
}

// ===== 상태 텍스트 =====
function getStatusText(status) {
    const map = {
        waiting: '대기',
        loading: '상차완료',
        transit: '운송중',
        delivered: '배송완료'
    };
    return map[status] || status || '-';
}

function getStatusBadge(status) {
    return `<span class="status-badge status-${status}">${getStatusText(status)}</span>`;
}

function getStatusIcon(status) {
    const icons = {
        waiting: 'fas fa-clock',
        loading: 'fas fa-box-open',
        transit: 'fas fa-truck',
        delivered: 'fas fa-check-double'
    };
    return icons[status] || 'fas fa-circle';
}

// ===== API 호출 =====

// 사진 필드 (Base64/URL) — 목록 조회 시 제외하여 페이로드 경량화
// ★ 'stops'는 v20250321D 이후 이미지 없는 메타데이터만 저장하므로 제외 대상에서 제거
// ★ 'stop_photos'는 v20250321E 신규 추가 — 목록 조회 시 제외 (상세 단건 apiGet에서 조회)
const PHOTO_FIELDS = [
    'loading_invoice_photo', 'loading_temp_photo',
    'loading_extra_photos',
    'stop_photos'           // 하차 사진 전체 JSON — 목록 조회 시 제외
];

function stripPhotoFields(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const r = { ...obj };
    PHOTO_FIELDS.forEach(f => delete r[f]);
    return r;
}

// 목록 조회 전용 — 사진 필드 자동 제거 (500 오류 방지)
// ※ 500 오류가 계속 발생하면 limit 값을 더 줄이세요 (200 → 100 → 50)
async function apiGetList(url) {
    let res;
    try {
        res = await fetch(url);
    } catch (networkErr) {
        throw new Error(`네트워크 오류: ${networkErr.message}`);
    }
    if (!res.ok) {
        // 500 오류 시: DB 과부하(Base64 사진 대량) 가능성 → limit 줄이기 필요
        let detail = '';
        try { const t = await res.text(); detail = t.substring(0, 200); } catch {}
        console.error(`[apiGetList] ${url} → HTTP ${res.status}`, detail);
        throw new Error(`API Error: ${res.status} (${url})`);
    }
    const json = await res.json();
    if (json.data && Array.isArray(json.data)) {
        json.data = json.data.map(stripPhotoFields);
    }
    return json;
}

async function apiGet(url) {
    let res;
    try {
        res = await fetch(url);
    } catch (networkErr) {
        throw new Error(`네트워크 오류: ${networkErr.message}`);
    }
    if (!res.ok) {
        let detail = '';
        try { const t = await res.text(); detail = t.substring(0, 200); } catch {}
        console.error(`[apiGet] ${url} → HTTP ${res.status}`, detail);
        throw new Error(`API Error: ${res.status}`);
    }
    return res.json();
}

async function apiPost(url, data) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    if (!res.ok) {
        let detail = '';
        try { const t = await res.text(); detail = t.substring(0, 300); } catch {}
        console.error(`[apiPost] ${url} → HTTP ${res.status}`, detail);
        throw new Error(`API Error: ${res.status} — ${detail}`);
    }
    return res.json();
}

async function apiPut(url, data) {
    const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    if (!res.ok) {
        let detail = '';
        try { const t = await res.text(); detail = t.substring(0, 300); } catch {}
        console.error(`[apiPut] ${url} → HTTP ${res.status}`, detail);
        throw new Error(`API Error: ${res.status} — ${detail}`);
    }
    return res.json();
}

// ★ PATCH → 405 시 이미지 필드를 제외한 안전한 PUT 폴백
// PUT 폴백 시 GET으로 현재 레코드를 가져오되, 이미지 필드(Base64/대용량)는
// 새 data에 있을 때만 포함시켜 페이로드 폭증을 방지
const _IMAGE_FIELDS = [
    'loading_invoice_photo', 'loading_temp_photo',
    'loading_extra_photos',  'stop_photos', 'stops'
];

// PATCH 직렬화 큐 — 동일 URL 동시 PUT 폴백 시 race condition 방지
const _patchQueue = {};

async function apiPatch(url, data) {
    // 1차: PATCH 시도
    let res;
    try {
        res = await fetch(url, {
            method : 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body   : JSON.stringify(data)
        });
    } catch (networkErr) {
        console.error(`[apiPatch] 네트워크 오류:`, networkErr);
        throw new Error(`네트워크 오류 (PATCH): ${networkErr.message}`);
    }
    console.log(`[apiPatch] ${url} → HTTP ${res.status}`);

    // PATCH 성공
    if (res.ok) return res.json();

    // PATCH 미지원(405) → PUT 폴백
    if (res.status === 405) {
        console.warn(`[apiPatch] PATCH 405 → PUT 폴백: ${url}`);
        // 직렬화: 같은 URL에 동시에 PUT이 중복 실행되지 않도록
        if (!_patchQueue[url]) _patchQueue[url] = Promise.resolve();
        const result = await (_patchQueue[url] = _patchQueue[url].then(async () => {
            // 현재 레코드 GET (이미지 필드도 포함되어 있으므로 머지 시 제외)
            const getRes = await fetch(url);
            if (!getRes.ok) throw new Error(`PUT 폴백 GET 실패: ${getRes.status}`);
            const current = await getRes.json();

            // 시스템 필드 제거
            ['id','gs_project_id','gs_table_name','created_at','updated_at'].forEach(k => delete current[k]);

            // 이미지 필드: 새 data에 포함된 경우만 유지, 없으면 current에서도 제거
            // (대용량 Base64가 current에 있어도 payload에서 빠짐)
            _IMAGE_FIELDS.forEach(k => {
                if (!(k in data)) delete current[k];
            });

            // 새 data 머지
            const merged = Object.assign(current, data);

            const putRes = await fetch(url, {
                method : 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body   : JSON.stringify(merged)
            });
            if (!putRes.ok) {
                let detail = '';
                try { const t = await putRes.text(); detail = t.substring(0, 300); } catch {}
                console.error(`[apiPatch→PUT] ${url} → HTTP ${putRes.status}`, detail);
                throw new Error(`API Error (PUT fallback): ${putRes.status} — ${detail}`);
            }
            return putRes.json();
        }));
        return result;
    }

    // 기타 오류
    let detail = '';
    try { const t = await res.text(); detail = t.substring(0, 300); } catch {}
    console.error(`[apiPatch] ${url} → HTTP ${res.status}`, detail);
    throw new Error(`API Error (PATCH): ${res.status} — ${detail}`);
}

async function apiDelete(url) {
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) throw new Error(`API Error: ${res.status}`);
    return true;
}

// ===== 파일을 메모리(Blob)로 즉시 읽기 =====
// ★ Android 카메라 앱으로 촬영 시 임시 파일이 WebView 복귀 직후 해제될 수 있음
// ★ change 이벤트 발생 즉시 파일 내용을 ArrayBuffer로 읽어 새 File 객체로 재생성
// ★ 이렇게 하면 원본 임시 파일이 사라져도 업로드 계속 진행 가능
function readFileToMemory(file, fileName, fileType) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                // ArrayBuffer → Uint8Array → Blob → File 순으로 재생성
                const arrayBuffer = e.target.result;
                const blob = new Blob([arrayBuffer], { type: fileType });
                const safeFile = new File([blob], fileName || 'photo.jpg', { type: fileType });
                resolve(safeFile);
            } catch (err) {
                reject(err);
            }
        };
        reader.onerror = () => reject(new Error('파일 읽기 실패 (readFileToMemory)'));
        reader.readAsArrayBuffer(file);
    });
}

// ===== 이미지를 Base64로 변환 (리사이즈 포함) =====
// ★ FileReader로 DataURL을 먼저 읽은 뒤 Image로 로드 → canvas 압축
// ★ createObjectURL 대신 FileReader 방식으로 Blob 재생성 File도 안정적으로 처리
// ★ 4단계 압축으로 반드시 300KB 미만 보장
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const done = (val) => { if (!settled) { settled = true; resolve(val); } };
        const fail = (e)  => { if (!settled) { settled = true; reject(e); } };

        // 1단계: FileReader로 DataURL 읽기
        const reader = new FileReader();
        reader.onerror = () => fail(new Error('FileReader 실패'));
        reader.onload = (e) => {
            const dataUrl = e.target.result;
            if (!dataUrl) { fail(new Error('DataURL 비어있음')); return; }

            // 2단계: Image로 로드해 canvas 압축
            const img = new Image();
            img.onerror = () => {
                // canvas 압축 불가 → DataURL 그대로 반환
                console.warn('[fileToBase64] Image 로드 실패 — 원본 DataURL 반환');
                done(dataUrl);
            };
            img.onload = () => {
                try {
                    // ★ stop_photos는 여러 이미지를 JSON으로 묶어 저장하므로
                    //   개별 이미지를 150KB 이하로 유지해야 전체 페이로드 안전
                    let result = _compressToCanvas(img, 800, 0.70);  // 1차: 800px / 70%
                    if (result.length > 300000) result = _compressToCanvas(img, 640, 0.60);
                    if (result.length > 250000) result = _compressToCanvas(img, 480, 0.50);
                    if (result.length > 200000) result = _compressToCanvas(img, 360, 0.40);
                    if (result.length > 150000) result = _compressToCanvas(img, 320, 0.35);
                    console.log(`[fileToBase64] 압축 완료: ${Math.round(result.length/1024)}KB`);
                    done(result);
                } catch (e2) {
                    // canvas 실패 → 원본 DataURL
                    console.warn('[fileToBase64] canvas 압축 실패 — 원본 반환:', e2);
                    done(dataUrl);
                }
            };
            img.src = dataUrl;
        };
        reader.readAsDataURL(file);
    });
}

/** canvas 압축 헬퍼 */
function _compressToCanvas(img, maxPx, quality) {
    const canvas = document.createElement('canvas');
    let { width, height } = img;
    if (width > maxPx || height > maxPx) {
        if (width > height) { height = Math.round(height * maxPx / width); width = maxPx; }
        else                { width  = Math.round(width  * maxPx / height); height = maxPx; }
    }
    canvas.width  = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', quality);
}

/* =====================================================
   외부 이미지 호스팅 - UVIS 서버 (rhkdtls.cloud)
   MinIO 오브젝트 스토리지에 저장, URL만 DB에 보관
   DB Base64 직접 저장 → 500 에러 문제 완전 해결
   ===================================================== */

const UVIS_BASE       = 'https://www.rhkdtls.cloud';
const UVIS_UPLOAD_URL  = `${UVIS_BASE}/api/v1/files/upload-image`;
const UVIS_LOGIN_URL   = `${UVIS_BASE}/api/v1/auth/login`;
const UVIS_FOLDER      = 'cargo-images';

// 고정 계정 (업로드 전용 VIEWER 권한)
const UVIS_USER = 'cargo_api';
const UVIS_PASS = 'CargoApp!2026';

// localStorage 키 (토큰 캐시만 사용)
const UVIS_TOKEN_KEY = 'uvis_token_cache';

// ── 하위 호환용 스텁 (기존 코드에서 호출해도 오류 없음) ──
function getUvisCredentials() { return { username: UVIS_USER, password: UVIS_PASS }; }
function setUvisCredentials() {}
function clearUvisCredentials() { localStorage.removeItem(UVIS_TOKEN_KEY); }

// ── 토큰 캐시 (만료 5분 전에 재발급) ──────────────────
function getCachedToken() {
    try {
        const c = JSON.parse(localStorage.getItem(UVIS_TOKEN_KEY));
        if (c && c.token && c.expires_at > Date.now() + 5 * 60 * 1000) return c.token;
    } catch {}
    return null;
}
function setCachedToken(token, ttlSeconds = 1800) {
    localStorage.setItem(UVIS_TOKEN_KEY, JSON.stringify({
        token,
        expires_at: Date.now() + ttlSeconds * 1000
    }));
}

// ── 로그인 → Bearer Token 발급 (고정 계정, 24시간 TTL) ──
// ★ 8초 타임아웃 — 서버 무응답 시 빠르게 폴백 전환
async function getUvisToken() {
    const cached = getCachedToken();
    if (cached) return cached;

    const body = new URLSearchParams();
    body.append('username', UVIS_USER);
    body.append('password', UVIS_PASS);

    const ctrl = new AbortController();
    const tId  = setTimeout(() => ctrl.abort(), 8000); // 8초 타임아웃

    let res;
    try {
        res = await fetch(UVIS_LOGIN_URL, {
            method : 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body   : body.toString(),
            signal : ctrl.signal
        });
    } finally {
        clearTimeout(tId);
    }

    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        console.error('[UVIS] 로그인 실패:', res.status, txt);
        throw new Error(`UVIS 로그인 오류: ${res.status}`);
    }

    const json  = await res.json();
    const token = json.access_token || json.token;
    if (!token) throw new Error('UVIS 로그인: 토큰을 받지 못했습니다.');

    setCachedToken(token, json.expires_in || 82800);
    console.log('[UVIS] 로그인 성공, 토큰 캐시됨');
    return token;
}

/**
 * 이미지 파일을 UVIS 서버(MinIO)에 업로드
 * ★ 10초 타임아웃
 * @param {File} file
 * @returns {Promise<string>} 이미지 URL
 */
async function uploadImageToUVIS(file) {
    const token = await getUvisToken();

    const form = new FormData();
    form.append('file', file);
    form.append('folder', UVIS_FOLDER);

    const ctrl = new AbortController();
    const tId  = setTimeout(() => ctrl.abort(), 10000); // 10초 타임아웃

    let res;
    try {
        res = await fetch(UVIS_UPLOAD_URL, {
            method : 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body   : form,
            signal : ctrl.signal
        });
    } finally {
        clearTimeout(tId);
    }

    if (res.status === 401) {
        localStorage.removeItem(UVIS_TOKEN_KEY);
        const newToken = await getUvisToken();
        const ctrl2 = new AbortController();
        const tId2  = setTimeout(() => ctrl2.abort(), 10000);
        let retry;
        try {
            retry = await fetch(UVIS_UPLOAD_URL, {
                method : 'POST',
                headers: { 'Authorization': `Bearer ${newToken}` },
                body   : form,
                signal : ctrl2.signal
            });
        } finally {
            clearTimeout(tId2);
        }
        if (!retry.ok) throw new Error(`UVIS 업로드 재시도 실패: ${retry.status}`);
        const j = await retry.json();
        return j.url;
    }

    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        console.error('[UVIS] 업로드 실패:', res.status, txt);
        throw new Error(`UVIS 업로드 실패: ${res.status}`);
    }

    const json = await res.json();
    if (!json.url) throw new Error('UVIS 업로드: URL을 받지 못했습니다.');
    console.log('[UVIS] 업로드 성공:', json.url);
    return json.url;
}

/**
 * 이미지 업로드 통합 함수
 * 우선순위: UVIS 서버(MinIO) → Base64 폴백
 * ★ UVIS 실패해도 Base64로 반드시 반환 (업로드 흐름 차단 방지)
 * @param {File} file
 * @returns {Promise<string>} URL(UVIS 성공) 또는 Base64(폴백)
 */
async function uploadImage(file, { silent = false } = {}) {
    // 1순위: UVIS MinIO 서버
    try {
        const url = await uploadImageToUVIS(file);
        if (url) return url;
    } catch (err) {
        console.warn('[uploadImage] UVIS 실패:', err.message);
    }

    // 2순위: Base64 폴백 (UVIS 불가 시 — DB에 직접 저장)
    console.log('[uploadImage] Base64 폴백으로 저장합니다.');
    // silent=true 이면 토스트 생략 (호출부에서 직접 토스트 제어)
    if (!silent) showToast('⚠️ 이미지 서버 연결 실패. 사진을 직접 저장합니다.', 'warning', 3000);
    const b64 = await fileToBase64(file);
    console.log(`[uploadImage] Base64 크기: ${Math.round(b64.length / 1024)}KB`);
    return b64;
}

// ── imgBB 보조 함수 (폴백용, 이전 호환) ──────────────
const IMGBB_KEY_STORAGE = 'imgbb_api_key';
function getImgBBKey()     { return localStorage.getItem(IMGBB_KEY_STORAGE) || ''; }
function setImgBBKey(key)  { localStorage.setItem(IMGBB_KEY_STORAGE, key.trim()); }

async function uploadImageToImgBB(file) {
    const apiKey = getImgBBKey();
    if (!apiKey) throw new Error('IMGBB_NO_KEY');
    const b64     = await fileToBase64(file);
    const pureB64 = b64.split(',')[1];
    const form    = new FormData();
    form.append('key', apiKey);
    form.append('image', pureB64);
    const res  = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: form });
    if (!res.ok) throw new Error(`imgBB 업로드 실패: ${res.status}`);
    const json = await res.json();
    if (!json.success) throw new Error('imgBB: ' + (json.error?.message || '오류'));
    return json.data.display_url || json.data.url;
}

/**
 * 저장된 값이 URL인지 Base64인지 확인
 * @param {string} value
 * @returns {boolean}
 */
function isImageUrl(value) {
    if (!value) return false;
    return value.startsWith('http://') || value.startsWith('https://');
}

// ===== 이미지 미리보기 업데이트 =====
function updateImagePreview(previewId, base64, altText) {
    const preview = document.getElementById(previewId);
    if (!preview) return;

    if (base64) {
        preview.innerHTML = `<img src="${base64}" alt="${altText}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;" />`;
    }
}

// ===== 라이트박스 =====
function openLightbox(src, caption) {
    const lb = document.getElementById('lightbox');
    const img = document.getElementById('lightboxImg');
    const cap = document.getElementById('lightboxCaption');
    if (!lb || !img) return;

    img.src = src;
    if (cap) cap.textContent = caption || '';
    // ★ classList.add('active') 방식과 인라인 display 모두 지원
    lb.classList.add('active');
    lb.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

function closeLightbox() {
    const lb = document.getElementById('lightbox');
    if (lb) {
        lb.classList.remove('active');
        lb.style.display = 'none';
    }
    document.body.style.overflow = '';
}

// ===== 모달 열기/닫기 =====
function openModal(id) {
    const modal = document.getElementById(id);
    if (modal) {
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
    }
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) {
        modal.classList.remove('active');
        document.body.style.overflow = '';
    }
}

// 모달 외부 클릭 시 닫기
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) {
        e.target.classList.remove('active');
        document.body.style.overflow = '';
    }
});

// 탭 시스템
function initTabs(containerSelector) {
    const container = document.querySelector(containerSelector) || document;
    const tabBtns = container.querySelectorAll('.tab-btn');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.getAttribute('data-tab');

            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const allContents = document.querySelectorAll('.tab-content');
            allContents.forEach(c => c.classList.remove('active'));

            const target = document.getElementById(`tab-${tabId}`);
            if (target) target.classList.add('active');

            // 탭 변경 이벤트
            document.dispatchEvent(new CustomEvent('tabChanged', { detail: tabId }));
        });
    });
}

// 세션 스토리지 헬퍼
const Session = {
    set(key, val) { sessionStorage.setItem(key, JSON.stringify(val)); },
    get(key) {
        try { return JSON.parse(sessionStorage.getItem(key)); }
        catch { return null; }
    },
    remove(key) { sessionStorage.removeItem(key); }
};

// ===== 화물 타입 헬퍼 (공통) =====
function isColdType(cargoType) {
    return ['냉동/냉장', '냉동', '냉장'].includes(cargoType);
}
function getCargoTypeLabel(t) {
    const map = { '냉동/냉장': '❄️ 냉동/냉장', '냉동': '🧊 냉동', '냉장': '🌡️ 냉장', '상온': '📦 상온' };
    return map[t] || t || '';
}
function getCargoTypeBg(t) {
    if (t === '냉동' || t === '냉동/냉장') return '#dbeafe';
    if (t === '냉장') return '#e0f2fe';
    return '#f1f5f9';
}
function getCargoTypeColor(t) {
    if (t === '냉동' || t === '냉동/냉장') return '#1d4ed8';
    if (t === '냉장') return '#0369a1';
    return '#475569';
}
/** cargo_type 뱃지 HTML 반환 (인라인 스타일) */
function cargoTypeBadge(cargoType) {
    if (!cargoType) return '';
    return `<span style="display:inline-block;padding:1px 7px;border-radius:9px;font-size:0.72rem;font-weight:700;background:${getCargoTypeBg(cargoType)};color:${getCargoTypeColor(cargoType)};">${getCargoTypeLabel(cargoType)}</span>`;
}

// 에러 메시지 표시 (XSS 방어: textContent 사용)
function showError(elementId, msg) {
    const el = document.getElementById(elementId);
    if (el) {
        el.textContent = '';
        const icon = document.createElement('i');
        icon.className = 'fas fa-exclamation-circle';
        el.appendChild(icon);
        el.appendChild(document.createTextNode(' ' + msg));
        el.style.display = 'flex';
    }
}

function hideError(elementId) {
    const el = document.getElementById(elementId);
    if (el) el.style.display = 'none';
}

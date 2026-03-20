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

// 사진 필드 (Base64) — 목록 조회 시 제외하여 페이로드 경량화
const PHOTO_FIELDS = [
    'loading_invoice_photo', 'loading_temp_photo',
    'stops'  // 하차 사진을 포함한 JSON이므로 목록 조회 시 제외
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

// PATCH — 서버가 PATCH를 지원하면 직접 전송, 아니면 GET 후 머지 PUT
async function apiPatch(url, data) {
    // 1차: PATCH 직접 시도
    try {
        const res = await fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (res.ok) return res.json();
        // PATCH 미지원(405) 이외의 오류는 throw
        if (res.status !== 405 && res.status !== 404) {
            throw new Error(`API Error: ${res.status}`);
        }
    } catch (e) {
        if (!e.message.includes('405') && !e.message.includes('fetch')) throw e;
    }

    // 2차: PATCH 미지원 → GET 후 머지 PUT (사진 필드 재로딩 최소화)
    const current = await apiGet(url);
    const merged = { ...current, ...data };
    const res2 = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(merged)
    });
    if (!res2.ok) throw new Error(`API Error: ${res2.status}`);
    return res2.json();
}

async function apiDelete(url) {
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) throw new Error(`API Error: ${res.status}`);
    return true;
}

// ===== 이미지를 Base64로 변환 (리사이즈 포함) =====
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.onerror = reject;

        // 이미지 리사이즈 (최대 1024px, 품질 80%)
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const MAX = 1024;
            let { width, height } = img;

            if (width > MAX || height > MAX) {
                if (width > height) {
                    height = Math.round(height * MAX / width);
                    width = MAX;
                } else {
                    width = Math.round(width * MAX / height);
                    height = MAX;
                }
            }

            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/jpeg', 0.8));
        };

        img.onerror = () => reader.readAsDataURL(file);
        img.src = URL.createObjectURL(file);
    });
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
async function getUvisToken() {
    const cached = getCachedToken();
    if (cached) return cached;

    // Content-Type: application/x-www-form-urlencoded (서버 스펙)
    const body = new URLSearchParams();
    body.append('username', UVIS_USER);
    body.append('password', UVIS_PASS);

    const res = await fetch(UVIS_LOGIN_URL, {
        method : 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body   : body.toString()
    });

    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        console.error('[UVIS] 로그인 실패:', res.status, txt);
        throw new Error(`UVIS 로그인 오류: ${res.status}`);
    }

    const json = await res.json();
    const token = json.access_token || json.token;
    if (!token) throw new Error('UVIS 로그인: 토큰을 받지 못했습니다.');

    // 서버 TTL 24시간 → 23시간 캐시
    setCachedToken(token, json.expires_in || 82800);
    console.log('[UVIS] 로그인 성공, 토큰 캐시됨');
    return token;
}

/**
 * 이미지 파일을 UVIS 서버(MinIO)에 업로드
 * @param {File} file
 * @returns {Promise<string>} 이미지 URL
 */
async function uploadImageToUVIS(file) {
    const token = await getUvisToken();   // 자동 로그인/캐시

    const form = new FormData();
    form.append('file', file);
    form.append('folder', UVIS_FOLDER);

    const res = await fetch(UVIS_UPLOAD_URL, {
        method : 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body   : form
    });

    if (res.status === 401) {
        // 토큰 만료 → 캐시 삭제 후 1회 재시도
        localStorage.removeItem(UVIS_TOKEN_KEY);
        const newToken = await getUvisToken();
        const retry = await fetch(UVIS_UPLOAD_URL, {
            method : 'POST',
            headers: { 'Authorization': `Bearer ${newToken}` },
            body   : form
        });
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
 * 이미지 업로드 통합 함수 (우선순위: UVIS → imgBB → Base64 폴백)
 * @param {File} file
 * @returns {Promise<string>} URL 또는 Base64
 */
async function uploadImage(file) {
    // UVIS 서버 (rhkdtls.cloud / MinIO) — 항상 시도
    try {
        return await uploadImageToUVIS(file);
    } catch (err) {
        console.warn('[UVIS] 업로드 실패, Base64 폴백:', err.message);
        showToast('⚠️ 이미지 서버 연결 실패. 임시로 기기에 저장됩니다.', 'warning', 4000);
    }

    // 폴백: Base64 (UVIS 실패 시에만)
    return fileToBase64(file);
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
    lb.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeLightbox() {
    const lb = document.getElementById('lightbox');
    if (lb) lb.classList.remove('active');
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

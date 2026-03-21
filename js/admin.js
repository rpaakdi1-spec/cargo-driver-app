/* ===========================
   관리자 페이지 JS - admin.js
   역할 분리 버전
=========================== */

const ADMIN_PASSWORD = 'rhkdtls1';
const ADMIN_SESSION_KEY = 'admin_auth_v2';
const ADMIN_LOCKOUT_KEY = 'admin_lockout';
let allRooms = [];
let allDeliveries = [];
let pendingDeleteId = null;
let pendingDeleteType = null;

function getAdminLockout() {
    try { return JSON.parse(sessionStorage.getItem(ADMIN_LOCKOUT_KEY)) || { count: 0, lockedUntil: 0 }; }
    catch { return { count: 0, lockedUntil: 0 }; }
}
function setAdminLockout(obj) { sessionStorage.setItem(ADMIN_LOCKOUT_KEY, JSON.stringify(obj)); }
function clearAdminLockout() { sessionStorage.removeItem(ADMIN_LOCKOUT_KEY); }

// ===== 초기화 =====
document.addEventListener('DOMContentLoaded', () => {
    initAdminLogin();
    initTabs('body');
    initEventListeners();
});

// ===== 관리자 로그인 체크 =====
function initAdminLogin() {
    const auth = Session.get(ADMIN_SESSION_KEY);
    const isValid = auth && auth.authenticated && (Date.now() - auth.timestamp < 4 * 60 * 60 * 1000); // 4시간

    if (isValid) {
        showAdminMain();
    } else {
        document.getElementById('adminLoginOverlay').style.display = 'flex';
        document.getElementById('adminMain').style.display = 'none';
        setTimeout(() => document.getElementById('adminPw').focus(), 200);
    }
}

// ===== 이벤트 리스너 =====
function initEventListeners() {
    // 로그인 (form submit으로 Enter키 포함 처리)
    document.getElementById('adminLoginBtn').addEventListener('click', handleAdminLogin);

    // 로그아웃
    document.getElementById('btnAdminLogout').addEventListener('click', () => {
        Session.remove(ADMIN_SESSION_KEY);
        document.getElementById('adminMain').style.display = 'none';
        document.getElementById('adminHeaderActions').style.display = 'none';
        document.getElementById('adminHeaderHome').style.display = 'flex';
        document.getElementById('adminLoginOverlay').style.display = 'flex';
        document.getElementById('adminPw').value = '';
        hideError('adminLoginError');
        showToast('로그아웃되었습니다.', 'default');
    });

    // 탭 변경
    document.addEventListener('tabChanged', (e) => {
        if (e.detail === 'admin-rooms')      loadAdminRooms();
        if (e.detail === 'admin-deliveries') loadAdminDeliveries();
        if (e.detail === 'admin-settings')   initSettingsTab();
    });

    // 룸 생성/편집 모달
    document.getElementById('adminCreateRoomBtn').addEventListener('click', openCreateRoomModal);
    document.getElementById('closeAdminRoomModal').addEventListener('click', () => closeModal('adminRoomModal'));
    document.getElementById('cancelAdminRoomModal').addEventListener('click', () => closeModal('adminRoomModal'));
    document.getElementById('adminRoomForm').addEventListener('submit', handleSaveRoom);

    // 기사 PIN 탭 제거 - 배송 등록 시 PIN 설정으로 변경

    // 삭제 확인
    document.getElementById('closeConfirmDelete').addEventListener('click', () => closeModal('confirmDeleteModal'));
    document.getElementById('cancelConfirmDelete').addEventListener('click', () => closeModal('confirmDeleteModal'));
    document.getElementById('confirmDeleteBtn').addEventListener('click', executeDelete);

    // 배송 검색
    document.getElementById('adminSearchDelivery').addEventListener('input', renderAdminDeliveries);

    // 설정 탭 버튼 이벤트
    document.getElementById('btnTestImgBB').addEventListener('click', testUvisConnection);
    document.getElementById('btnGenDriverLink').addEventListener('click', genDriverLink);
    document.getElementById('btnCopyDriverLink').addEventListener('click', copyDriverLink);
}

// ===== 관리자 로그인 처리 =====
async function handleAdminLogin() {
    const pw = document.getElementById('adminPw').value;
    hideError('adminLoginError');

    if (!pw) {
        showError('adminLoginError', '비밀번호를 입력해주세요.');
        return;
    }

    // ── 잠금 상태 확인 ──
    const lockout = getAdminLockout();
    const now = Date.now();
    if (lockout.lockedUntil > now) {
        const remaining = Math.ceil((lockout.lockedUntil - now) / 1000);
        showError('adminLoginError', `${remaining}초 후 다시 시도하세요. (반복 실패 잠금)`);
        return;
    }

    const btn = document.getElementById('adminLoginBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 확인 중...';

    await new Promise(r => setTimeout(r, 400)); // 딜레이

    if (pw === ADMIN_PASSWORD) {
        clearAdminLockout();
        Session.set(ADMIN_SESSION_KEY, { authenticated: true, timestamp: Date.now() });
        showAdminMain();
    } else {
        const newCount = (lockout.count || 0) + 1;
        let lockedUntil = 0;
        if (newCount >= 5) {
            const lockSec = Math.min(60 * Math.pow(2, newCount - 5), 1800); // 60초~30분
            lockedUntil = now + lockSec * 1000;
            showError('adminLoginError', `5회 실패. ${lockSec}초 동안 로그인이 잠겼습니다.`);
        } else {
            showError('adminLoginError', `비밀번호가 올바르지 않습니다. (${newCount}/5회 실패)`);
        }
        setAdminLockout({ count: newCount, lockedUntil });
        document.getElementById('adminPw').value = '';
        document.getElementById('adminPw').focus();
    }

    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> 로그인';
}

// ===== 관리자 메인 표시 =====
function showAdminMain() {
    document.getElementById('adminLoginOverlay').style.display = 'none';
    document.getElementById('adminMain').style.display = 'block';
    document.getElementById('adminHeaderActions').style.display = 'flex';
    document.getElementById('adminHeaderHome').style.display = 'none';
    loadAdminStats();
    loadAdminRooms();
    // ★ 알림 폴링 시작
    startAdminNotifPoll();
}

// ===== 통계 로드 =====
async function loadAdminStats() {
    try {
        // ★ limit=1로 total 카운트만 조회 (대량 데이터 불러오기 방지)
        const [roomData, delivData] = await Promise.all([
            apiGet('tables/rooms?limit=1'),
            apiGetList('tables/deliveries?limit=500')
        ]);

        const deliveries = delivData.data || [];
        const total     = delivData.total || deliveries.length; // 서버 전체 건수
        const active    = deliveries.filter(d => d.status === 'transit' || d.status === 'loading').length;
        const completed = deliveries.filter(d => d.status === 'delivered').length;

        document.getElementById('aTotalRooms').textContent          = roomData.total || 0;
        document.getElementById('aTotalDeliveries').textContent     = total;
        document.getElementById('aActiveDeliveries').textContent    = active;
        document.getElementById('aCompletedDeliveries').textContent = completed;
    } catch (err) { console.error('통계 로드 오류:', err); }
}

// ===== 룸 관리 =====
async function loadAdminRooms() {
    try {
        const data = await apiGet('tables/rooms?limit=100');
        allRooms = data.data || [];
        // limit을 200으로 줄여 서버 메모리 과부하 방지
        const delivData = await apiGetList('tables/deliveries?limit=200');
        allDeliveries = delivData.data || [];
        renderAdminRooms();
        loadAdminStats();
    } catch (err) {
        document.getElementById('adminRoomsBody').innerHTML =
            `<tr><td colspan="6" class="loading-cell">데이터를 불러오지 못했습니다.</td></tr>`;
    }
}

function renderAdminRooms() {
    const tbody = document.getElementById('adminRoomsBody');
    if (!allRooms.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="loading-cell">등록된 고객사가 없습니다.</td></tr>`;
        return;
    }
    tbody.innerHTML = allRooms.map(room => {
        const count = allDeliveries.filter(d => d.room_id === room.id).length;
        return `
            <tr>
                <td><strong>${escapeHtml(room.room_name)}</strong></td>
                <td>${escapeHtml(room.contact || '-')}</td>
                <td>${escapeHtml(room.description || '-')}</td>
                <td><span class="status-badge status-transit">${count}건</span></td>
                <td>${formatDateShort(room.created_at)}</td>
                <td>
                    <div class="table-actions">
                        <button class="btn-icon btn-icon-view" onclick="viewRoom('${room.id}')" title="룸 보기">
                            <i class="fas fa-eye"></i>
                        </button>
                        <button class="btn-icon btn-icon-edit" onclick="openEditRoomModal('${room.id}')" title="편집">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="btn-icon btn-icon-delete" onclick="confirmDelete('room','${room.id}','${escapeHtml(room.room_name)}')" title="삭제">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </td>
            </tr>`;
    }).join('');
}

function viewRoom(roomId) {
    Session.set(`room_auth_${roomId}`, { authenticated: true, roomId, timestamp: Date.now() });
    window.open(`room.html?id=${roomId}`, '_blank');
}

function openCreateRoomModal() {
    document.getElementById('adminRoomId').value = '';
    document.getElementById('adminRoomName').value = '';
    document.getElementById('adminRoomPw').value = '';
    document.getElementById('adminRoomContact').value = '';
    document.getElementById('adminRoomDesc').value = '';
    document.getElementById('adminRoomModalTitle').innerHTML = '<i class="fas fa-plus-circle"></i> 고객사 룸 생성';
    document.getElementById('adminPwNote').innerHTML = '<span class="required">*</span> 필수';
    document.getElementById('adminRoomPw').required = true;
    document.getElementById('adminRoomPw').placeholder = '비밀번호 입력 (필수)';
    openModal('adminRoomModal');
}

function openEditRoomModal(roomId) {
    const room = allRooms.find(r => r.id === roomId);
    if (!room) return;
    document.getElementById('adminRoomId').value = room.id;
    document.getElementById('adminRoomName').value = room.room_name;
    document.getElementById('adminRoomPw').value = '';
    document.getElementById('adminRoomContact').value = room.contact || '';
    document.getElementById('adminRoomDesc').value = room.description || '';
    document.getElementById('adminRoomModalTitle').innerHTML = '<i class="fas fa-edit"></i> 고객사 룸 편집';
    document.getElementById('adminPwNote').textContent = '(변경 시에만 입력)';
    document.getElementById('adminRoomPw').required = false;
    document.getElementById('adminRoomPw').placeholder = '변경 시에만 입력';
    openModal('adminRoomModal');
}

async function handleSaveRoom(e) {
    e.preventDefault();
    const id = document.getElementById('adminRoomId').value;
    const name = document.getElementById('adminRoomName').value.trim();
    const pw = document.getElementById('adminRoomPw').value;
    const contact = document.getElementById('adminRoomContact').value.trim();
    const desc = document.getElementById('adminRoomDesc').value.trim();

    const btn = e.target.querySelector('[type="submit"]');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 저장 중...';

    try {
        const data = { room_name: name, contact, description: desc, is_active: true };
        if (pw) data.password_hash = await hashPassword(pw);

        if (id) {
            // ★ 캐시(allRooms)가 오래됐을 수 있으므로 서버에서 최신 데이터를 직접 조회 후 병합
            // → 비밀번호 필드가 캐시 값으로 덮어씌워지는 버그 방지
            const currentRoom = await apiGet(`tables/rooms/${id}`);
            // 시스템 필드 제거
            ['id','gs_project_id','gs_table_name','created_at','updated_at'].forEach(f => delete currentRoom[f]);
            // pw 미입력 시 기존 password_hash 유지 (data에 password_hash 없으면 currentRoom 값 사용)
            await apiPut(`tables/rooms/${id}`, { ...currentRoom, ...data });
            showToast('룸이 수정되었습니다.', 'success');
        } else {
            if (!pw) { showToast('비밀번호를 입력해주세요.', 'error'); return; }
            await apiPost('tables/rooms', data);
            showToast('룸이 생성되었습니다.', 'success');
        }
        closeModal('adminRoomModal');
        await loadAdminRooms();
    } catch(err) {
        console.error('[handleSaveRoom]', err);
        showToast('저장 실패: ' + err.message.substring(0, 80), 'error', 6000);
    }
    finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-save"></i> 저장';
    }
}

// ===== 전체 배송 (최근 200건만 표시, 서버 메모리 과부하 방지) =====
async function loadAdminDeliveries() {
    try {
        const [delivData, roomData] = await Promise.all([
            apiGetList('tables/deliveries?limit=200'),
            apiGet('tables/rooms?limit=100')
        ]);
        allDeliveries = delivData.data || [];
        allRooms = roomData.data || [];
        renderAdminDeliveries();
    } catch (err) {
        console.error('배송 목록 오류:', err);
        document.getElementById('adminDeliveriesBody').innerHTML =
            `<tr><td colspan="10" class="loading-cell">데이터를 불러오지 못했습니다. (${err.message})</td></tr>`;
    }
}

function renderAdminDeliveries() {
    const tbody = document.getElementById('adminDeliveriesBody');
    const search = document.getElementById('adminSearchDelivery').value.toLowerCase().trim();
    let filtered = allDeliveries;
    if (search) {
        filtered = allDeliveries.filter(d =>
            (d.driver_name || '').toLowerCase().includes(search) ||
            (d.vehicle_number || '').toLowerCase().includes(search) ||
            (d.cargo_type || '').toLowerCase().includes(search)
        );
    }
    if (!filtered.length) {
        tbody.innerHTML = `<tr><td colspan="10" class="loading-cell">데이터가 없습니다.</td></tr>`;
        return;
    }
    tbody.innerHTML = filtered.map(d => {
        const room = allRooms.find(r => r.id === d.room_id);
        const roomName = room ? room.room_name : '-';
        const hasLoadInv = !!d.loading_invoice_photo;
        const hasLoadTemp = !!d.loading_temp_photo;
        const hasDelInv = !!d.delivery_invoice_photo;
        const hasDelTemp = !!d.delivery_temp_photo;
        const gpsAge = d.gps_updated_at ? Date.now() - parseInt(d.gps_updated_at) : null;
        const gpsRecent = gpsAge && gpsAge < 10 * 60 * 1000;
        return `
            <tr>
                <td><strong>${escapeHtml(roomName)}</strong></td>
                <td>${escapeHtml(d.driver_name || '-')}</td>
                <td><span style="font-family:monospace;">${escapeHtml(d.vehicle_number || '-')}</span></td>
                <td>${cargoTypeBadge(d.cargo_type) || '-'}</td>
                <td style="font-size:0.82rem;">
                    ${escapeHtml(d.origin || '-')}<br>
                    <span style="color:var(--gray-400)">→ ${escapeHtml(d.destination || '-')}</span>
                </td>
                <td>${getStatusBadge(d.status)}</td>
                <td>
                    <div class="doc-status-icons">
                        <span class="doc-pill ${hasLoadInv ? 'has' : 'none'}" title="상차 거래명세표">상↑명</span>
                        <span class="doc-pill ${hasLoadTemp ? 'has' : 'none'}" title="상차 온도기록지">상↑온</span>
                        <span class="doc-pill ${hasDelInv ? 'has' : 'none'}" title="하차 거래명세표">하↓명</span>
                        <span class="doc-pill ${hasDelTemp ? 'has' : 'none'}" title="하차 온도기록지">하↓온</span>
                    </div>
                </td>
                <td>
                    <div class="gps-cell">
                        ${d.current_lat && d.current_lng
                            ? `<span class="${gpsRecent ? 'gps-active' : 'gps-inactive'}">
                                <i class="fas fa-circle" style="font-size:0.6rem;"></i>
                                ${gpsRecent ? '활성' : timeAgo(d.gps_updated_at)}</span>`
                            : `<span class="gps-inactive"><i class="fas fa-circle" style="font-size:0.6rem;"></i> 없음</span>`}
                    </div>
                </td>
                <td style="font-size:0.82rem;">${formatDateShort(d.created_at)}</td>
                <td>
                    <div class="table-actions">
                        <button class="btn-icon btn-icon-edit" onclick="openDeliveryStatusEdit('${d.id}')" title="상태 변경">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="btn-icon btn-icon-delete" onclick="confirmDelete('delivery','${d.id}','${escapeHtml(d.driver_name || d.id)}')" title="삭제">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </td>
            </tr>`;
    }).join('');
}

async function openDeliveryStatusEdit(deliveryId) {
    const d = allDeliveries.find(x => x.id === deliveryId);
    if (!d) return;
    const newStatus = prompt(
        `배송 상태 변경\n현재: ${getStatusText(d.status)}\n\n입력 가능: waiting / loading / transit / delivered`,
        d.status
    );
    if (!newStatus || newStatus === d.status) return;
    if (!['waiting', 'loading', 'transit', 'delivered'].includes(newStatus)) {
        showToast('올바른 상태값을 입력해주세요.', 'error');
        return;
    }
    try {
        await apiPatch(`tables/deliveries/${deliveryId}`, { status: newStatus });
        showToast('상태가 변경되었습니다.', 'success');
        await loadAdminDeliveries();
        await loadAdminStats();
    } catch { showToast('변경 실패.', 'error'); }
}

// ===== 삭제 =====
function confirmDelete(type, id, name) {
    pendingDeleteId = id;
    pendingDeleteType = type;
    const typeText = { room: '고객사 룸', delivery: '배송' }[type] || '항목';
    document.getElementById('confirmDeleteMsg').innerHTML =
        `<strong>"${escapeHtml(name)}"</strong> ${typeText}을(를) 삭제하시겠습니까?<br>
        <small style="color:var(--danger);">이 작업은 되돌릴 수 없습니다.</small>`;
    openModal('confirmDeleteModal');
}

async function executeDelete() {
    if (!pendingDeleteId) return;
    const btn = document.getElementById('confirmDeleteBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 삭제 중...';
    try {
        const tableMap = { room: 'rooms', delivery: 'deliveries', driver: 'driver_pins' };
        await apiDelete(`tables/${tableMap[pendingDeleteType]}/${pendingDeleteId}`);
        showToast('삭제되었습니다.', 'success');
        closeModal('confirmDeleteModal');
        if (pendingDeleteType === 'room')     await loadAdminRooms();
        else if (pendingDeleteType === 'delivery') await loadAdminDeliveries();
        await loadAdminStats();
    } catch { showToast('삭제 실패.', 'error'); }
    finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-trash"></i> 삭제';
        pendingDeleteId = null;
        pendingDeleteType = null;
    }
}

// ===== HTML 이스케이프 =====
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* =====================================================
   설정 탭 - UVIS 서버 이미지 업로드 상태 관리
   고정 계정(cargo_api) 자동 로그인 방식
   ===================================================== */

function initSettingsTab() {
    updateUvisStatusUI();
    loadImgStats();
}

// ── 상태 UI 업데이트 ─────────────────────────────────
function updateUvisStatusUI() {
    const token = getCachedToken();
    const el    = document.getElementById('imgbbStatus');
    if (!el) return;

    if (token) {
        el.style.background = 'rgba(16,185,129,0.1)';
        el.style.border     = '1px solid rgba(16,185,129,0.3)';
        el.style.color      = '#86efac';
        el.innerHTML = `<i class="fas fa-check-circle" style="color:#10b981;"></i>
            <span>✅ UVIS 서버 연결됨 — 기사님 사진이 <strong>rhkdtls.cloud MinIO</strong>에 자동 저장됩니다</span>`;
    } else {
        el.style.background = 'rgba(99,102,241,0.1)';
        el.style.border     = '1px solid rgba(99,102,241,0.3)';
        el.style.color      = '#a5b4fc';
        el.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i>
            <span>서버 미연결 — <strong>연결 테스트</strong> 버튼을 눌러 확인하세요</span>`;
    }
}

// ── 연결 테스트 ──────────────────────────────────────
async function testUvisConnection() {
    const btn = document.getElementById('btnTestImgBB');
    const el  = document.getElementById('imgbbStatus');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 연결 중...';

    if (el) {
        el.style.background = 'rgba(99,102,241,0.1)';
        el.style.border     = '1px solid rgba(99,102,241,0.3)';
        el.style.color      = '#a5b4fc';
        el.innerHTML        = '<i class="fas fa-circle-notch fa-spin"></i> <span>연결 테스트 중...</span>';
    }

    try {
        localStorage.removeItem(UVIS_TOKEN_KEY);
        const token = await getUvisToken();
        if (token) {
            showToast('✅ UVIS 서버 연결 성공! 이미지 업로드 정상 작동합니다.', 'success', 4000);
            updateUvisStatusUI();
            loadImgStats();
        }
    } catch (err) {
        showToast('❌ 연결 실패: ' + err.message, 'error', 5000);
        if (el) {
            el.style.background = 'rgba(239,68,68,0.1)';
            el.style.border     = '1px solid rgba(239,68,68,0.3)';
            el.style.color      = '#fca5a5';
            el.innerHTML        = `<i class="fas fa-times-circle" style="color:#ef4444;"></i> <span>연결 실패: ${err.message}</span>`;
        }
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-vial"></i> 연결 테스트';
    }
}

// ── 기사용 링크 생성 ─────────────────────────────────
function genDriverLink() {
    const base = window.location.origin + window.location.pathname.replace('admin.html', '');
    const link = `${base}driver.html`;
    const box     = document.getElementById('driverLinkBox');
    const copyBtn = document.getElementById('btnCopyDriverLink');
    box.textContent       = link;
    box.style.display     = 'block';
    copyBtn.style.display = 'inline-flex';
    copyBtn.dataset.link  = link;
    showToast('기사용 링크가 생성되었습니다.', 'success');
}

function copyDriverLink() {
    const link = document.getElementById('btnCopyDriverLink').dataset.link;
    if (!link) return;
    navigator.clipboard.writeText(link).then(() => {
        showToast('📋 링크가 복사되었습니다!', 'success');
    }).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = link;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('📋 링크가 복사되었습니다!', 'success');
    });
}

/* ================================================
   ★ 알림 시스템 — 관리자용
   폴링 간격: 10초 / 관리자 로그인 상태에서만 동작
   ================================================ */
let adminNotifPollTimer = null;
let adminLastNotifAt    = Date.now();

function startAdminNotifPoll() {
    stopAdminNotifPoll();
    adminLastNotifAt = Date.now();

    adminNotifPollTimer = setInterval(async () => {
        try {
            const res  = await fetch('tables/notifications?limit=20&sort=-created_at');
            if (!res.ok) return;
            const data = await res.json();
            const rows = (data.data || []).filter(n => {
                const ts = n.created_at ? Number(n.created_at) : 0;
                return ts > adminLastNotifAt;
            });
            if (rows.length === 0) return;
            adminLastNotifAt = Math.max(...rows.map(n => Number(n.created_at) || 0));
            rows.reverse();
            // ★ 알림음 재생 (이벤트 유형별)
            const hasUrgent  = rows.some(n => ['low_speed_alert','loaded_timeout'].includes(n.event_type));
            const hasWarning = rows.some(n => ['stop_arrived'].includes(n.event_type));
            if (hasUrgent) playNotifSound('urgent');
            else if (hasWarning) playNotifSound('warning');
            else playNotifSound('info');
            rows.forEach(n => showAdminNotifToast(n));
            updateAdminNotifBadge(rows.length);
            addAdminNotifItems(rows);
        } catch (e) { /* 무시 */ }
    }, 10000);
}

function stopAdminNotifPoll() {
    if (adminNotifPollTimer) { clearInterval(adminNotifPollTimer); adminNotifPollTimer = null; }
}

function showAdminNotifToast(n) {
    const icons = { driver_login: '🚛', loaded: '📦', delivered: '✅', low_speed_alert: '⚠️', loaded_timeout: '⏰', stop_arrived: '📍' };
    showToast(`${icons[n.event_type] || '🔔'} ${n.message}`, 'success', 6000);
}

function updateAdminNotifBadge(count) {
    const badge = document.getElementById('adminNotifBadge');
    if (!badge) return;
    const cur = parseInt(badge.dataset.count || '0') + count;
    badge.dataset.count = cur;
    badge.textContent   = cur > 99 ? '99+' : cur;
    badge.style.display = 'flex';
}

function addAdminNotifItems(rows) {
    const list = document.getElementById('adminNotifList');
    if (!list) return;
    const empty = list.querySelector('.notif-empty');
    if (empty) empty.remove();
    rows.forEach(n => {
        const icMap  = { driver_login:'fas fa-sign-in-alt', loaded:'fas fa-arrow-up', delivered:'fas fa-check-double', low_speed_alert:'fas fa-exclamation-triangle', loaded_timeout:'fas fa-clock', stop_arrived:'fas fa-map-marker-alt' };
        const colMap = { driver_login:'#2563eb', loaded:'#d97706', delivered:'#16a34a', low_speed_alert:'#dc2626', loaded_timeout:'#9333ea', stop_arrived:'#f59e0b' };
        const item   = document.createElement('div');
        item.className = 'notif-item';
        item.innerHTML = `
            <div class="notif-icon" style="background:${colMap[n.event_type]||'#6366f1'}20;color:${colMap[n.event_type]||'#6366f1'};">
                <i class="${icMap[n.event_type]||'fas fa-bell'}"></i>
            </div>
            <div class="notif-body">
                <div class="notif-msg">${n.message||''}</div>
                <div class="notif-time">${n.cargo_type ? getCargoTypeLabel(n.cargo_type) + ' · ' : ''}${formatRelativeTime(Number(n.created_at))}</div>
            </div>`;
        list.insertBefore(item, list.firstChild);
    });
    while (list.children.length > 30) list.removeChild(list.lastChild);
}

function formatRelativeTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 60000)   return '방금';
    if (diff < 3600000) return `${Math.floor(diff/60000)}분 전`;
    return new Date(ts).toLocaleTimeString('ko-KR', { hour:'2-digit', minute:'2-digit' });
}

function toggleAdminNotifPanel() {
    const panel = document.getElementById('adminNotifPanel');
    if (!panel) return;
    const isOpen = panel.style.display !== 'none';
    panel.style.display = isOpen ? 'none' : 'block';
    if (!isOpen) {
        const badge = document.getElementById('adminNotifBadge');
        if (badge) { badge.style.display = 'none'; badge.dataset.count = '0'; }
    }
}

// ── 이미지 저장 현황 ─────────────────────────────────
async function loadImgStats() {
    const el = document.getElementById('imgStatsArea');
    if (!el) return;
    try {
        const data  = await apiGetList('tables/deliveries?limit=1');
        const total = data.total || 0;
        const token = getCachedToken();

        const storageMode  = token ? '✅ UVIS MinIO' : '⏳ 연결 대기';
        const storageColor = token ? '#10b981' : '#6366f1';
        const storageDesc  = token
            ? 'UVIS 서버 연결 완료. 신규 사진은 rhkdtls.cloud MinIO에 저장됩니다.'
            : '연결 테스트 버튼을 눌러 서버 연결을 확인하세요.';

        el.innerHTML = `
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                <div style="padding:12px; background:rgba(99,102,241,0.1); border-radius:8px; text-align:center;">
                    <div style="font-size:1.5rem; font-weight:700; color:#818cf8;">${total}</div>
                    <div style="font-size:0.8rem; margin-top:4px;">전체 배송 건수</div>
                </div>
                <div style="padding:12px; background:rgba(0,0,0,0.15); border-radius:8px; text-align:center;">
                    <div style="font-size:1rem; font-weight:700; color:${storageColor};">${storageMode}</div>
                    <div style="font-size:0.8rem; margin-top:4px;">이미지 저장 방식</div>
                </div>
            </div>
            <p style="margin:12px 0 0; font-size:0.82rem; color:var(--gray-400);">
                <i class="fas fa-info-circle"></i> ${storageDesc}
            </p>`;
    } catch (err) {
        el.innerHTML = `<span style="color:#ef4444;"><i class="fas fa-times-circle"></i> 분석 실패: ${err.message}</span>`;
    }
}

// utils.js의 상수 참조용 (중복 선언 방지)
// UVIS_TOKEN_KEY 는 utils.js에 정의됨

// 현재 상태 UI 업데이트
function updateImgBBStatusUI() {
    const key = getImgBBKey();
    const el  = document.getElementById('imgbbStatus');
    if (!el) return;

    // 입력창에 현재 키 표시 (마스킹)
    const input = document.getElementById('imgbbApiKeyInput');
    if (input && key) input.value = key;

    if (key) {
        el.style.background = 'rgba(16,185,129,0.1)';
        el.style.border     = '1px solid rgba(16,185,129,0.3)';
        el.style.color      = '#86efac';
        el.innerHTML = `<i class="fas fa-check-circle" style="color:#10b981;"></i>
            <span>API 키 등록됨 — 기사님 사진이 <strong>imgBB 외부 서버</strong>에 저장됩니다 (DB 부담 없음)</span>`;
    } else {
        el.style.background = 'rgba(239,68,68,0.08)';
        el.style.border     = '1px solid rgba(239,68,68,0.2)';
        el.style.color      = '#fca5a5';
        el.innerHTML = `<i class="fas fa-times-circle" style="color:#ef4444;"></i>
            <span>API 키 미등록 — 현재 사진이 <strong>DB에 Base64로 저장</strong>되어 500 에러 원인이 됩니다</span>`;
    }
}

// API 키 저장
function saveImgBBKey() {
    const input = document.getElementById('imgbbApiKeyInput');
    const key   = (input?.value || '').trim();
    if (!key) {
        showToast('API 키를 입력해주세요.', 'error');
        return;
    }
    setImgBBKey(key);
    updateImgBBStatusUI();
    showToast('✅ imgBB API 키가 저장되었습니다!', 'success');
}

// API 키 삭제
function clearImgBBKey() {
    if (!confirm('imgBB API 키를 삭제하면 이후 사진이 DB에 Base64로 저장됩니다.\n계속하시겠습니까?')) return;
    localStorage.removeItem(IMGBB_KEY_STORAGE);
    const input = document.getElementById('imgbbApiKeyInput');
    if (input) input.value = '';
    updateImgBBStatusUI();
    showToast('API 키가 삭제되었습니다.', 'default');
}

// 연결 테스트 (1x1 투명 PNG 업로드)
async function testImgBBConnection() {
    const btn = document.getElementById('btnTestImgBB');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 테스트 중...';

    try {
        const key = getImgBBKey();
        if (!key) { showToast('먼저 API 키를 저장해주세요.', 'error'); return; }

        // 1x1 투명 PNG (최소 크기 테스트 이미지)
        const testB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        const form = new FormData();
        form.append('key', key);
        form.append('image', testB64);

        const res  = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: form });
        const json = await res.json();

        if (json.success) {
            showToast('✅ imgBB 연결 성공! 이미지 업로드가 정상 작동합니다.', 'success', 4000);
        } else {
            showToast('❌ imgBB 오류: ' + (json.error?.message || '알 수 없는 오류'), 'error', 5000);
        }
    } catch (err) {
        showToast('❌ 연결 실패: ' + err.message, 'error', 5000);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-vial"></i> 연결 테스트';
    }
}

// 기사용 링크 생성 (API 키 포함)
function genDriverLink() {
    const key = getImgBBKey();
    if (!key) {
        showToast('먼저 imgBB API 키를 저장해주세요.', 'error');
        return;
    }
    const base   = window.location.origin + window.location.pathname.replace('admin.html', '');
    const link   = `${base}driver.html?imgbb=${encodeURIComponent(key)}`;
    const box    = document.getElementById('driverLinkBox');
    const copyBtn = document.getElementById('btnCopyDriverLink');

    box.textContent    = link;
    box.style.display  = 'block';
    copyBtn.style.display = 'inline-flex';
    copyBtn.dataset.link  = link;
    showToast('링크가 생성되었습니다. 기사님께 전송하세요.', 'success');
}

function copyDriverLink() {
    const link = document.getElementById('btnCopyDriverLink').dataset.link;
    if (!link) return;
    navigator.clipboard.writeText(link).then(() => {
        showToast('📋 링크가 복사되었습니다!', 'success');
    }).catch(() => {
        // 구형 방식
        const ta = document.createElement('textarea');
        ta.value = link;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('📋 링크가 복사되었습니다!', 'success');
    });
}

// 이미지 저장 방식 현황 분석
async function loadImgStats() {
    const el = document.getElementById('imgStatsArea');
    if (!el) return;
    try {
        // 최근 50건만 분석 (서버 부담 최소화)
        const data = await apiGetList('tables/deliveries?limit=50');
        const rows = data.data || [];
        let urlCount  = 0;
        let b64Count  = 0;
        let noneCount = 0;

        rows.forEach(d => {
            // apiGetList가 사진 필드를 제거하므로, 필드 존재 여부로만 판단 불가
            // → 전체 개수 기준 표시
            urlCount  += 0; // 사진 필드 없으므로 개별 조회 불가
            noneCount += 1;
        });

        const total = data.total || 0;
        const key   = getImgBBKey();

        el.innerHTML = `
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                <div style="padding:12px; background:rgba(99,102,241,0.1); border-radius:8px; text-align:center;">
                    <div style="font-size:1.5rem; font-weight:700; color:#818cf8;">${total}</div>
                    <div style="font-size:0.8rem; margin-top:4px;">전체 배송 건수</div>
                </div>
                <div style="padding:12px; background:${key ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)'}; border-radius:8px; text-align:center;">
                    <div style="font-size:1.5rem; font-weight:700; color:${key ? '#10b981' : '#ef4444'};">
                        ${key ? '✅ URL' : '⚠️ Base64'}
                    </div>
                    <div style="font-size:0.8rem; margin-top:4px;">신규 사진 저장 방식</div>
                </div>
            </div>
            <p style="margin:12px 0 0; font-size:0.82rem; color:var(--gray-400);">
                <i class="fas fa-info-circle"></i>
                ${key
                    ? '✅ imgBB 키 등록 완료. 신규 사진은 URL로 저장됩니다. 기존 Base64 사진은 그대로 표시됩니다.'
                    : '⚠️ imgBB 키 미등록. 사진이 DB에 직접 저장되어 건수가 늘면 500 에러가 발생할 수 있습니다.'
                }
            </p>`;
    } catch (err) {
        el.innerHTML = `<span style="color:#ef4444;"><i class="fas fa-times-circle"></i> 분석 실패: ${err.message}</span>`;
    }
}

// imgBB localStorage 상수는 utils.js에 정의됨 (IMGBB_KEY_STORAGE)

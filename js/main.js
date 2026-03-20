/* ===========================
   메인 페이지 JS - main.js
   역할 선택 + 고객사 룸 입장
=========================== */

let allRooms = [];
let pendingRoomId = null;
let pendingPasswordHash = null;

// ===== 초기화 =====
document.addEventListener('DOMContentLoaded', async () => {
    await loadStats();
    initEventListeners();
});

// ===== 이벤트 리스너 =====
function initEventListeners() {
    // 고객사 카드 클릭 → 룸 패널 표시
    document.getElementById('roleCustomerCard').addEventListener('click', toggleRoomsPanel);

    // 룸 패널 닫기
    document.getElementById('closeRoomsPanel').addEventListener('click', hideRoomsPanel);

    // 비밀번호 모달
    document.getElementById('closePasswordModal').addEventListener('click', () => closeModal('roomPasswordModal'));
    document.getElementById('cancelPasswordModal').addEventListener('click', () => closeModal('roomPasswordModal'));
    document.getElementById('confirmPassword').addEventListener('click', handlePasswordConfirm);
    document.getElementById('enterPassword').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handlePasswordConfirm();
    });

    // 룸 검색
    document.getElementById('searchRoomMain').addEventListener('input', (e) => {
        filterRooms(e.target.value);
    });
}

// ===== 통계 로드 =====
async function loadStats() {
    try {
        const [roomRes, delivRes] = await Promise.all([
            apiGet('tables/rooms?limit=1'),
            apiGetList('tables/deliveries?limit=1000')
        ]);
        const deliveries = delivRes.data || [];
        const active = deliveries.filter(d => d.status === 'transit' || d.status === 'loading').length;
        const done = deliveries.filter(d => d.status === 'delivered').length;

        document.getElementById('statRooms').textContent = roomRes.total || 0;
        document.getElementById('statDeliveries').textContent = deliveries.length;
        document.getElementById('statActive').textContent = active;
        document.getElementById('statDone').textContent = done;
    } catch { }
}

// ===== 룸 패널 토글 =====
async function toggleRoomsPanel() {
    const panel = document.getElementById('roomsPanel');
    if (panel.style.display === 'none') {
        panel.style.display = 'block';
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        await loadRooms();
    } else {
        hideRoomsPanel();
    }
}

function hideRoomsPanel() {
    document.getElementById('roomsPanel').style.display = 'none';
}

// ===== 룸 목록 로드 =====
async function loadRooms() {
    document.getElementById('mainRoomGrid').innerHTML = `
        <div class="loading-spinner">
            <i class="fas fa-circle-notch fa-spin"></i>
            <span>로딩 중...</span>
        </div>`;
    try {
        const data = await apiGet('tables/rooms?limit=100');
        allRooms = data.data || [];
        renderRooms(allRooms);
    } catch {
        document.getElementById('mainRoomGrid').innerHTML = `
            <div class="empty-state">
                <i class="fas fa-exclamation-triangle"></i>
                <p>룸 목록을 불러오지 못했습니다.</p>
            </div>`;
    }
}

// ===== 룸 렌더링 =====
function renderRooms(rooms) {
    const grid = document.getElementById('mainRoomGrid');
    if (!rooms || rooms.length === 0) {
        grid.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-building" style="color:#94a3b8;"></i>
                <p>등록된 고객사가 없습니다.<br>관리자에게 문의하세요.</p>
            </div>`;
        return;
    }
    grid.innerHTML = rooms.map(room => `
        <div class="room-card"
             onclick="openRoomPassword('${room.id}', '${escapeHtml(room.room_name)}', '${room.password_hash}')">
            <div class="room-card-header">
                <div class="room-card-name">
                    <i class="fas fa-building"></i>
                    ${escapeHtml(room.room_name)}
                </div>
                <i class="fas fa-lock room-lock-icon"></i>
            </div>
            <div class="room-card-info">
                ${room.contact ? `<div class="room-info-row"><i class="fas fa-phone"></i><span>${escapeHtml(room.contact)}</span></div>` : ''}
                ${room.description ? `<div class="room-info-row"><i class="fas fa-sticky-note"></i><span>${escapeHtml(room.description)}</span></div>` : ''}
            </div>
            <div class="room-card-footer">
                <div class="room-delivery-count">
                    <i class="fas fa-calendar-alt"></i>
                    <span>${formatDate(room.created_at)}</span>
                </div>
                <div class="room-enter-btn">
                    <i class="fas fa-sign-in-alt"></i> 입장
                </div>
            </div>
        </div>
    `).join('');
}

// ===== 룸 검색 =====
function filterRooms(query) {
    const q = query.toLowerCase().trim();
    if (!q) { renderRooms(allRooms); return; }
    renderRooms(allRooms.filter(r =>
        r.room_name.toLowerCase().includes(q) ||
        (r.contact && r.contact.includes(q))
    ));
}

// ===== 비밀번호 모달 =====
function openRoomPassword(roomId, roomName, passwordHash) {
    pendingRoomId = roomId;
    pendingPasswordHash = passwordHash;
    document.getElementById('roomPasswordTitle').textContent = roomName;
    document.getElementById('enterPassword').value = '';
    hideError('passwordError');
    openModal('roomPasswordModal');
    setTimeout(() => document.getElementById('enterPassword').focus(), 150);
}

async function handlePasswordConfirm() {
    const pw = document.getElementById('enterPassword').value;
    if (!pw) { showError('passwordError', '비밀번호를 입력해주세요.'); return; }

    const btn = document.getElementById('confirmPassword');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 확인 중...';

    // 딜레이 (브루트포스 방지)
    await new Promise(r => setTimeout(r, 300));

    try {
        const hash = await hashPassword(pw);
        if (hash === pendingPasswordHash) {
            Session.set(`room_auth_${pendingRoomId}`, {
                authenticated: true,
                roomId: pendingRoomId,
                timestamp: Date.now()
            });
            closeModal('roomPasswordModal');
            window.location.href = `room.html?id=${pendingRoomId}`;
        } else {
            showError('passwordError', '비밀번호가 올바르지 않습니다.');
            document.getElementById('enterPassword').value = '';
            document.getElementById('enterPassword').focus();
        }
    } catch {
        showError('passwordError', '오류가 발생했습니다. 다시 시도해주세요.');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> 입장하기';
    }
}

// ===== HTML 이스케이프 =====
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

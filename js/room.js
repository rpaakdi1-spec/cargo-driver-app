/* ===========================
   룸 페이지 JS - room.js
   v20250321T
=========================== */

let roomId = null;
let roomData = null;
let deliveries = [];
let currentFilter = 'all';
let leafletMap = null;
let markers = {};
let autoRefreshTimer = null;

// ===== 초기화 =====
document.addEventListener('DOMContentLoaded', async () => {
    const params = new URLSearchParams(window.location.search);
    roomId = params.get('id');

    if (!roomId) {
        window.location.href = 'index.html';
        return;
    }

    await loadRoomData();
    initTabs('body');
    initEventListeners();
});

// ===== 룸 데이터 로드 =====
async function loadRoomData() {
    try {
        roomData = await apiGet(`tables/rooms/${roomId}`);

        document.getElementById('gateRoomName').textContent = roomData.room_name;
        document.title = `${roomData.room_name} - 배송 현황`;

        // 세션 인증 확인
        const auth = Session.get(`room_auth_${roomId}`);
        const isValid = auth && auth.authenticated && (Date.now() - auth.timestamp < 8 * 60 * 60 * 1000); // 8시간

        if (isValid) {
            showRoomContent();
        } else {
            document.getElementById('passwordGate').style.display = 'flex';
        }
    } catch (err) {
        showToast('룸 정보를 불러오지 못했습니다.', 'error');
        setTimeout(() => window.location.href = 'index.html', 2000);
    }
}

// ===== 룸 콘텐츠 표시 =====
function showRoomContent() {
    document.getElementById('passwordGate').style.display = 'none';
    document.getElementById('roomMain').style.display = 'block';

    document.getElementById('headerRoomName').textContent = roomData.room_name;
    document.getElementById('roomTitle').innerHTML = `<i class="fas fa-building"></i> ${escapeHtml(roomData.room_name)}`;
    document.getElementById('roomContact').innerHTML = roomData.contact
        ? `<i class="fas fa-phone"></i> ${escapeHtml(roomData.contact)}`
        : `<i class="fas fa-info-circle"></i> ${escapeHtml(roomData.description || '배송 현황')}`;

    loadDeliveries();
    // ★ 알림 폴링 시작 (이 룸의 배송 이벤트만 수신)
    startRoomNotifPoll();
}

// ===== 이벤트 리스너 =====
function initEventListeners() {
    // 비밀번호 게이트
    document.getElementById('gateEnterBtn').addEventListener('click', handleGatePassword);
    document.getElementById('gatePassword').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleGatePassword();
    });

    // 로그아웃
    document.getElementById('btnLogout').addEventListener('click', () => {
        Session.remove(`room_auth_${roomId}`);
        window.location.href = 'index.html';
    });

    // 배송 등록
    document.getElementById('btnAddDelivery').addEventListener('click', () => openModal('addDeliveryModal'));
    document.getElementById('closeAddDelivery').addEventListener('click', () => closeModal('addDeliveryModal'));
    document.getElementById('cancelAddDelivery').addEventListener('click', () => closeModal('addDeliveryModal'));
    document.getElementById('addDeliveryForm').addEventListener('submit', handleAddDelivery);

    // 배송 상세
    document.getElementById('closeDeliveryDetail').addEventListener('click', () => closeModal('deliveryDetailModal'));

    // 검색
    document.getElementById('searchDelivery').addEventListener('input', () => renderDeliveries());

    // 필터 버튼
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.getAttribute('data-status');
            renderDeliveries();
        });
    });

    // 탭 변경
    document.addEventListener('tabChanged', (e) => {
        if (e.detail === 'map') {
            initMap();
            startAutoRefresh();
        } else {
            stopAutoRefresh();
        }
        if (e.detail === 'docs') {
            loadDocumentsDropdown();
        }
    });

    // 자동 갱신 토글
    document.getElementById('autoRefreshToggle').addEventListener('change', (e) => {
        if (e.target.checked) startAutoRefresh();
        else stopAutoRefresh();
    });
}

// ===== 비밀번호 게이트 처리 =====
async function handleGatePassword() {
    const pw = document.getElementById('gatePassword').value;
    if (!pw) {
        showError('gateError', '비밀번호를 입력해주세요.');
        return;
    }

    const btn = document.getElementById('gateEnterBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 확인 중...';

    try {
        const hash         = await hashPassword(pw);
        const fallbackHash = _fallbackHash(pw + '_cargo_salt_2025');
        const match = hash === roomData.password_hash
                   || fallbackHash === roomData.password_hash
                   || (roomData.password_hash2 && (hash === roomData.password_hash2 || fallbackHash === roomData.password_hash2));
        if (match) {
            Session.set(`room_auth_${roomId}`, {
                authenticated: true,
                roomId: roomId,
                timestamp: Date.now()
            });
            showRoomContent();
        } else {
            showError('gateError', '비밀번호가 올바르지 않습니다.');
            document.getElementById('gatePassword').value = '';
        }
    } catch {
        showError('gateError', '오류가 발생했습니다.');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> 입장하기';
    }
}

// ===== 배송 목록 로드 =====
async function loadDeliveries() {
    try {
        // ★ limit=500으로 올려 배송건 누락 방지 (200이면 오래된 배송건 잠자일 수 있음)
        const data = await apiGetList(`tables/deliveries?limit=500&sort=created_at`);
        deliveries = (data.data || []).filter(d => d.room_id === roomId);
        updateStats();
        renderDeliveries();
        loadDocumentsDropdown();
    } catch (err) {
        console.error(err);
    }
}

// ===== 통계 업데이트 =====
function updateStats() {
    document.getElementById('rTotal').textContent = deliveries.length;
    document.getElementById('rLoading').textContent = deliveries.filter(d => d.status === 'loading').length;
    document.getElementById('rTransit').textContent = deliveries.filter(d => d.status === 'transit').length;
    document.getElementById('rDelivered').textContent = deliveries.filter(d => d.status === 'delivered').length;
}

// ===== 배송 목록 렌더링 =====
function renderDeliveries() {
    const search = document.getElementById('searchDelivery').value.toLowerCase().trim();
    let filtered = deliveries;

    if (currentFilter !== 'all') {
        filtered = filtered.filter(d => d.status === currentFilter);
    }

    if (search) {
        filtered = filtered.filter(d =>
            (d.driver_name || '').toLowerCase().includes(search) ||
            (d.vehicle_number || '').toLowerCase().includes(search) ||
            (d.cargo_type || '').toLowerCase().includes(search) ||
            (d.origin || '').toLowerCase().includes(search) ||
            (d.destination || '').toLowerCase().includes(search)
        );
    }

    const list = document.getElementById('deliveryList');

    if (!filtered.length) {
        list.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-truck" style="color:#94a3b8;"></i>
                <p>${deliveries.length === 0 ? '등록된 배송이 없습니다.<br>배송 등록 버튼으로 추가하세요.' : '검색 결과가 없습니다.'}</p>
            </div>`;
        return;
    }

    list.innerHTML = filtered.map(d => {
        const hasLoadInv  = !!(d.loading_invoice_ts  || d.loading_invoice_photo);
        const hasLoadTemp = !!(d.loading_temp_ts     || d.loading_temp_photo);

        // stops 배열에서 하차 서류 여부 확인
        let stopsArr = [];
        try { stopsArr = d.stops ? JSON.parse(d.stops) : []; } catch {}
        const hasAnyDelInv  = stopsArr.length > 0 ? stopsArr.some(s => s.invoice_photo) : !!d.delivery_invoice_photo;
        const hasAnyDelTemp = stopsArr.length > 0 ? stopsArr.some(s => s.temp_photo)    : !!d.delivery_temp_photo;
        const stopsCount    = stopsArr.length;
        const stopsAllDone  = stopsArr.length > 0 && stopsArr.every(s => s.delivered_at);

        const gpsTime = d.gps_updated_at ? timeAgo(d.gps_updated_at) : null;
        const gpsRecent = d.gps_updated_at && (Date.now() - Number(d.gps_updated_at)) < 5 * 60 * 1000;
        const hasGps = !!(d.current_lat && d.current_lng);

        return `
            <div class="delivery-card" onclick="showDeliveryDetail('${d.id}')">
                <div class="delivery-card-header">
                    <div class="delivery-driver-name">
                        <i class="fas fa-user"></i>
                        ${escapeHtml(d.driver_name || '-')}
                        <span style="color:var(--gray-500);font-weight:400;font-size:0.85rem;">
                            (${escapeHtml(d.vehicle_number || '-')})
                        </span>
                    </div>
                    <div style="display:flex;align-items:center;gap:6px;">
                        ${hasGps ? `
                        <button class="btn-track-gps ${gpsRecent ? 'recent' : 'old'}"
                            onclick="event.stopPropagation(); trackOnMap('${d.id}')"
                            title="실시간 위치 추적">
                            <i class="fas fa-location-arrow"></i>
                            <span>${gpsRecent ? '위치추적' : 'GPS확인'}</span>
                        </button>` : ''}
                        <button class="btn-track-gps" style="background:#7c3aed;border-color:#7c3aed;"
                            onclick="event.stopPropagation(); requestGpsNow('${d.id}')"
                            title="기사에게 현재 위치 즉시 요청">
                            <i class="fas fa-satellite-dish"></i>
                            <span>위치 요청</span>
                        </button>
                        ${getStatusBadge(d.status)}
                    </div>
                </div>
                <div class="delivery-card-body">
                    <div class="delivery-info-item">
                        <i class="fas fa-box"></i>
                        <span>${cargoTypeBadge(d.cargo_type) || '<span style="color:#94a3b8;">-</span>'}</span>
                    </div>
                    ${d.driver_phone ? `
                    <div class="delivery-info-item">
                        <i class="fas fa-phone" style="color:#16a34a;"></i>
                        <a href="tel:${escapeHtml(d.driver_phone)}" onclick="event.stopPropagation()"
                           style="color:#16a34a;font-weight:600;text-decoration:none;font-size:0.88rem;">
                            ${escapeHtml(d.driver_phone)}
                        </a>
                    </div>` : ''}
                    ${d.origin || d.destination ? `
                    <div class="delivery-info-item">
                        <i class="fas fa-route"></i>
                        <span>${escapeHtml(d.origin || '-')} → ${escapeHtml(d.destination || '-')}</span>
                    </div>` : ''}
                    ${gpsTime ? `
                    <div class="delivery-info-item">
                        <i class="fas fa-map-marker-alt" style="color:${gpsRecent ? 'var(--success)' : 'var(--gray-400)'}"></i>
                        <span style="color:${gpsRecent ? 'var(--success)' : 'var(--gray-500)'}">GPS: ${gpsTime}</span>
                    </div>` : ''}
                </div>
                <div class="delivery-card-footer">
                    <span>${formatDateShort(d.created_at)} 등록</span>
                    <div class="doc-icons">
                        <div class="doc-icon ${hasLoadInv ? 'has-doc' : 'no-doc'}" title="상차 거래명세표">
                            <i class="fas fa-file-invoice"></i>
                        </div>
                        <div class="doc-icon ${hasLoadTemp ? 'has-doc' : 'no-doc'}" title="상차 온도기록지">
                            <i class="fas fa-thermometer-half"></i>
                        </div>
                        <div class="doc-icon ${hasAnyDelInv ? 'has-doc' : 'no-doc'}" title="하차 거래명세표${stopsCount > 1 ? ` (${stopsCount}건)` : ''}">
                            <i class="fas fa-file-invoice"></i>
                        </div>
                        <div class="doc-icon ${hasAnyDelTemp ? 'has-doc' : 'no-doc'}" title="하차 온도기록지${stopsCount > 1 ? ` (${stopsCount}건)` : ''}">
                            <i class="fas fa-thermometer-half"></i>
                        </div>
                        ${stopsCount > 1 ? `<div class="doc-icon has-doc" title="경유 ${stopsCount}건${stopsAllDone?' (전체완료)':''}" style="font-size:0.65rem;padding:2px 5px;border-radius:8px;">경유${stopsCount}</div>` : ''}
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

// ===== 배송 등록 =====
async function handleAddDelivery(e) {
    e.preventDefault();

    const driverName    = document.getElementById('driverName').value.trim();
    const vehicleNumber = document.getElementById('vehicleNumber').value.trim();
    const pin           = document.getElementById('driverPin').value.trim();
    const cargoType     = document.getElementById('cargoType').value;

    // ── 필수 입력 검증 ──
    if (!driverName) {
        showToast('기사 이름을 입력해주세요.', 'error'); return;
    }
    if (driverName.length > 30) {
        showToast('기사 이름은 30자 이내로 입력해주세요.', 'error'); return;
    }
    if (!vehicleNumber) {
        showToast('차량번호를 입력해주세요.', 'error'); return;
    }
    if (!pin) {
        showToast('기사 PIN을 입력해주세요.', 'error'); return;
    }
    if (!/^\d{4,8}$/.test(pin)) {
        showToast('PIN은 숫자 4~8자리여야 합니다.', 'error'); return;
    }
    if (!cargoType) {
        showToast('화물 타입을 선택해주세요.', 'error'); return;
    }

    // 전화번호 형식 검증 (입력된 경우에만)
    const driverPhone = document.getElementById('driverPhone').value.trim();
    if (driverPhone && !/^0\d{1,2}-\d{3,4}-\d{4}$/.test(driverPhone)) {
        showToast('전화번호 형식이 올바르지 않습니다. (예: 010-1234-5678)', 'error'); return;
    }

    const submitBtn = e.target.querySelector('[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 등록 중...';

    try {
        const pinHash      = await hashPassword(pin);          // SHA-256 (웹 기준)
        const pinHashFallback = _fallbackHash(pin + '_cargo_salt_2025'); // 폴백 해시 (WebView 대비)
        await apiPost('tables/deliveries', {
            room_id:        roomId,
            driver_name:    driverName,
            vehicle_number: vehicleNumber,
            driver_phone:   driverPhone,
            cargo_type:     cargoType,
            status:         document.getElementById('deliveryStatus').value,
            origin:         document.getElementById('origin').value.trim(),
            destination:    document.getElementById('destination').value.trim(),
            notes:          document.getElementById('deliveryNotes').value.trim(),
            driver_pin_hash:  pinHash,
            driver_pin_hash2: pinHashFallback  // WebView 폴백 해시 병행 저장
        });

        showToast('배송이 등록되었습니다!', 'success');
        closeModal('addDeliveryModal');
        document.getElementById('addDeliveryForm').reset();
        await loadDeliveries();
    } catch (err) {
        showToast('배송 등록에 실패했습니다.', 'error');
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fas fa-save"></i> 등록';
    }
}

// ===== 배송 상세 =====
async function showDeliveryDetail(deliveryId) {
    // ★ 이미지 필드 포함 전체 데이터를 단건 apiGet으로 조회 (목록 캐시는 이미지 제외됨)
    const content = document.getElementById('deliveryDetailContent');
    content.innerHTML = '<div style="text-align:center;padding:32px;"><i class="fas fa-spinner fa-spin" style="font-size:1.5rem;color:#6366f1;"></i><p style="margin-top:8px;color:#64748b;">불러오는 중...</p></div>';
    openModal('deliveryDetailModal');

    let d;
    try {
        d = await apiGet(`tables/deliveries/${deliveryId}`);
    } catch {
        content.innerHTML = '<p style="color:#ef4444;text-align:center;padding:24px;">데이터를 불러오지 못했습니다.</p>';
        return;
    }

    const docSection = (label, photoData, icon, typeClass, dateKey, tsVal, deliveryId, reqType) => {
        const dateBadge = dateKey
            ? `<span class="doc-date-tag" style="font-size:0.72rem;"><i class="fas fa-calendar-alt"></i> ${dateKey}</span>`
            : '';
        if (photoData) {
            return `
                <div class="detail-doc-item">
                    <img src="${photoData}" alt="${label}" onclick="openLightbox('${photoData}', '${label} (${dateKey || '-'})')" title="클릭하여 확대" />
                    <p><i class="${icon}"></i> ${label} ${dateBadge}</p>
                </div>
            `;
        }
        // 사진 없음 → 요청 버튼 포함
        const canRequest = deliveryId && reqType && ['loading','transit'].includes(d.status);
        return `
            <div class="detail-doc-item">
                <div class="detail-doc-empty">
                    <i class="${icon}"></i>
                    <span>${label}</span><br><small>사진 없음</small>
                </div>
                ${canRequest ? `
                <button class="btn btn-sm" style="margin-top:6px;background:#fef3c7;color:#92400e;border:1px solid #fde68a;border-radius:8px;font-size:0.78rem;padding:4px 10px;cursor:pointer;width:100%;"
                    onclick="requestPhotoFromDriver('${deliveryId}','${reqType}',this)">
                    <i class="fas fa-camera"></i> 촬영 요청
                </button>` : ''}
            </div>
        `;
    };

    content.innerHTML = `
        <div class="detail-grid">
            <div class="detail-item">
                <span class="detail-label"><i class="fas fa-user"></i> 기사명</span>
                <span class="detail-value">${escapeHtml(d.driver_name || '-')}</span>
            </div>
            <div class="detail-item">
                <span class="detail-label"><i class="fas fa-car"></i> 차량번호</span>
                <span class="detail-value">${escapeHtml(d.vehicle_number || '-')}</span>
            </div>
            ${d.driver_phone ? `
            <div class="detail-item">
                <span class="detail-label"><i class="fas fa-phone"></i> 연락처</span>
                <span class="detail-value"><a href="tel:${escapeHtml(d.driver_phone)}" style="color:#16a34a;font-weight:700;text-decoration:none;">${escapeHtml(d.driver_phone)}</a></span>
            </div>` : ''}
            <div class="detail-item">
                <span class="detail-label"><i class="fas fa-box"></i> 화물 타입</span>
                <span class="detail-value">${cargoTypeBadge(d.cargo_type) || '-'}</span>
            </div>
            <div class="detail-item">
                <span class="detail-label"><i class="fas fa-info-circle"></i> 상태</span>
                <span class="detail-value">${getStatusBadge(d.status)}</span>
            </div>
            <div class="detail-item">
                <span class="detail-label"><i class="fas fa-map-marker-alt"></i> 출발지</span>
                <span class="detail-value">${escapeHtml(d.origin || '-')}</span>
            </div>
            <div class="detail-item">
                <span class="detail-label"><i class="fas fa-map-pin"></i> 목적지</span>
                <span class="detail-value">${escapeHtml(d.destination || '-')}</span>
            </div>
            <div class="detail-item">
                <span class="detail-label"><i class="fas fa-clock"></i> 상차 시각</span>
                <span class="detail-value">${formatDate(d.loaded_at)}</span>
            </div>
            <div class="detail-item">
                <span class="detail-label"><i class="fas fa-check-circle"></i> 하차 시각</span>
                <span class="detail-value">${formatDate(d.delivered_at)}</span>
            </div>
            ${d.current_lat && d.current_lng ? `
            <div class="detail-item">
                <span class="detail-label"><i class="fas fa-location-arrow"></i> 현재 GPS</span>
                <span class="detail-value">${parseFloat(d.current_lat).toFixed(5)}, ${parseFloat(d.current_lng).toFixed(5)}<br>
                <small style="color:var(--gray-400)">업데이트: ${timeAgo(d.gps_updated_at)}</small></span>
            </div>` : ''}
            ${d.notes ? `
            <div class="detail-item" style="grid-column:1/-1;">
                <span class="detail-label"><i class="fas fa-sticky-note"></i> 메모</span>
                <span class="detail-value">${escapeHtml(d.notes)}</span>
            </div>` : ''}
        </div>

        <div class="detail-docs">
            <h4><i class="fas fa-arrow-up" style="color:var(--warning)"></i> 상차 완료 서류</h4>
            <div class="detail-docs-grid">
                ${docSection('거래명세표', d.loading_invoice_photo,  'fas fa-file-invoice',     'loading',  d.loading_invoice_date,  d.loading_invoice_ts,  d.id, 'loading_invoice')}
                ${docSection('온도기록지',  d.loading_temp_photo,     'fas fa-thermometer-half', 'loading',  d.loading_temp_date,     d.loading_temp_ts,     d.id, 'loading_temp')}
            </div>
            ${(() => {
                let extras = [];
                try { extras = d.loading_extra_photos ? JSON.parse(d.loading_extra_photos) : []; } catch {}
                // 항상 추가사진 영역을 표시 (0장이라도 표시)
                return `<div style="margin-top:12px;border-top:1px solid #f1f5f9;padding-top:10px;">
                    <p style="font-size:0.78rem;font-weight:600;color:#6366f1;margin-bottom:6px;">
                        <i class="fas fa-images"></i> 상차 추가사진 ${extras.length > 0 ? `(${extras.length}장)` : '<span style="color:#94a3b8;font-weight:400;">(0장)</span>'}
                    </p>
                    ${extras.length > 0 ? `
                    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;">
                        ${extras.map((p, i) => `
                            <div style="aspect-ratio:1;border-radius:8px;overflow:hidden;background:#f1f5f9;cursor:pointer;"
                                onclick="openLightbox('${p.url}','상차 추가사진 ${i+1}')">
                                <img src="${p.url}" alt="추가사진 ${i+1}" style="width:100%;height:100%;object-fit:cover;" loading="lazy"
                                    onerror="this.style.display='none';this.parentElement.innerHTML='<div style=\"display:flex;align-items:center;justify-content:center;height:100%;color:#94a3b8;font-size:0.7rem;\"><i class=\"fas fa-image-slash\"></i></div>'">
                            </div>`).join('')}
                    </div>` : '<p style="font-size:0.75rem;color:#94a3b8;margin:0;">기사가 업로드한 추가사진이 나타납니다.</p>'}
                </div>`;
            })()}
        </div>

        ${(() => {
            // stops 배열(다중 하차) 지원
            let stopsArr = [];
            try { stopsArr = d.stops ? JSON.parse(d.stops) : []; } catch {}

            // ★ stop_photos 필드에서 이미지를 stops 배열에 주입 (v20250321E)
            let stopPhotos = {};
            if (d.stop_photos) {
                try { stopPhotos = JSON.parse(d.stop_photos); } catch { stopPhotos = {}; }
            }
            stopsArr.forEach((s, i) => {
                const p = stopPhotos[String(i)];
                if (!p) return;
                if (p.invoice_photo !== undefined) s.invoice_photo = p.invoice_photo;
                if (p.temp_photo    !== undefined) s.temp_photo    = p.temp_photo;
                if (p.extra_photos  !== undefined) s.extra_photos  = p.extra_photos;
            });

            if (stopsArr.length > 0) {
                return stopsArr.map((stop, idx) => `
                    <div class="detail-docs" style="margin-top:16px;">
                        <h4 style="display:flex;align-items:center;gap:8px;">
                            <i class="fas fa-arrow-down" style="color:#0891b2;"></i>
                            ${escapeHtml(stop.label || `하차 ${idx+1}`)}
                            ${stop.delivered_at ? `<span style="font-size:0.75rem;background:#dcfce7;color:#16a34a;padding:2px 8px;border-radius:12px;font-weight:500;">완료 ${formatDateShort(stop.delivered_at)}</span>` : '<span style="font-size:0.75rem;background:#fef3c7;color:#d97706;padding:2px 8px;border-radius:12px;font-weight:500;">대기중</span>'}
                        </h4>
                        <div class="detail-docs-grid">
                            ${docSection('거래명세표', stop.invoice_photo, 'fas fa-file-invoice',     'delivery', stop.invoice_date, stop.invoice_ts, d.id, `stop_invoice_${idx}`)}
                            ${docSection('온도기록지',  stop.temp_photo,    'fas fa-thermometer-half', 'delivery', stop.temp_date,   stop.temp_ts,   d.id, `stop_temp_${idx}`)}
                        </div>
                        ${(() => {
                            const extras = (stop.extra_photos && stop.extra_photos.length) ? stop.extra_photos : [];
                            // 항상 추가사진 영역 표시
                            return `<div style="margin-top:10px;border-top:1px solid #f1f5f9;padding-top:8px;">
                                <p style="font-size:0.78rem;font-weight:600;color:#6366f1;margin-bottom:5px;">
                                    <i class="fas fa-images"></i> 하차 추가사진 ${extras.length > 0 ? `(${extras.length}장)` : '<span style="color:#94a3b8;font-weight:400;">(0장)</span>'}
                                </p>
                                ${extras.length > 0 ? `
                                <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:5px;">
                                    ${extras.map((p, pi) => `
                                        <div style="aspect-ratio:1;border-radius:7px;overflow:hidden;background:#f1f5f9;cursor:pointer;"
                                            onclick="openLightbox('${p.url}','${escapeHtml(stop.label||'하차'+(idx+1))} 추가사진 ${pi+1}')">
                                            <img src="${p.url}" alt="추가사진" style="width:100%;height:100%;object-fit:cover;" loading="lazy"
                                                onerror="this.style.display='none';this.parentElement.innerHTML='<div style=\"display:flex;align-items:center;justify-content:center;height:100%;color:#94a3b8;font-size:0.7rem;\"><i class=\"fas fa-image-slash\"></i></div>'">
                                        </div>`).join('')}
                                </div>` : '<p style="font-size:0.75rem;color:#94a3b8;margin:0;">기사가 업로드한 추가사진이 나타납니다.</p>'}
                            </div>`;
                        })()}
                    </div>
                `).join('');
            } else {
                // 구버전 호환: stops 없으면 기존 단일 하차 필드 표시
                return `
                    <div class="detail-docs" style="margin-top:16px;">
                        <h4><i class="fas fa-arrow-down" style="color:var(--success)"></i> 하차 완료 서류</h4>
                        <div class="detail-docs-grid">
                            ${docSection('거래명세표', d.delivery_invoice_photo, 'fas fa-file-invoice',     'delivery', d.delivery_invoice_date, d.delivery_invoice_ts, d.id, 'delivery_invoice')}
                            ${docSection('온도기록지',  d.delivery_temp_photo,    'fas fa-thermometer-half', 'delivery', d.delivery_temp_date,    d.delivery_temp_ts,    d.id, 'delivery_temp')}
                        </div>
                    </div>
                `;
            }
        })()}

        <div class="form-actions" style="margin-top:20px;">
            <button class="btn btn-outline btn-sm" onclick="closeModal('deliveryDetailModal')">
                <i class="fas fa-times"></i> 닫기
            </button>
            <button class="btn btn-danger btn-sm" onclick="deleteDelivery('${d.id}')">
                <i class="fas fa-trash"></i> 삭제
            </button>
        </div>
    `;
    // 모달은 이미 열려있으므로 재호출 불필요
}

// ===== 배송 삭제 =====
async function deleteDelivery(deliveryId) {
    if (!confirm('이 배송 건을 삭제하시겠습니까?')) return;
    try {
        await apiDelete(`tables/deliveries/${deliveryId}`);
        showToast('삭제되었습니다.', 'success');
        closeModal('deliveryDetailModal');
        await loadDeliveries();
    } catch {
        showToast('삭제 실패.', 'error');
    }
}

// ===== 기사에게 사진 촬영 요청 =====
async function requestPhotoFromDriver(deliveryId, reqType, btn) {
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 요청 중...';
    }
    try {
        await apiPatch(`tables/deliveries/${deliveryId}`, {
            photo_request_at: Date.now(),
            photo_request_type: reqType
        });
        showToast('📸 기사에게 사진 촬영 요청을 보냈습니다! 기사 앱에서 알림이 뜹니다.', 'success', 4000);
        if (btn) {
            btn.innerHTML = '<i class="fas fa-check"></i> 요청 완료';
            btn.style.background = '#dcfce7';
            btn.style.color = '#16a34a';
            btn.style.borderColor = '#86efac';
            // ★ 3초 후 버튼 복구 (재요청 가능하게)
            setTimeout(() => {
                if (!btn) return;
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-camera"></i> 재요청';
                btn.style.background = '';
                btn.style.color = '';
                btn.style.borderColor = '';
            }, 3000);
        }
    } catch {
        showToast('요청 전송 실패. 다시 시도해주세요.', 'error');
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-camera"></i> 촬영 요청';
        }
    }
}

// ===== 지도 초기화 =====
function initMap() {
    if (leafletMap) {
        refreshMap();
        return;
    }

    const mapEl = document.getElementById('deliveryMap');
    if (!mapEl) return;

    leafletMap = L.map('deliveryMap').setView([36.5, 127.5], 7);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19
    }).addTo(leafletMap);

    renderMapDrivers();
}

// ===== 지도 새로고침 =====
async function refreshMap() {
    const icon = document.getElementById('mapRefreshIcon');
    if (icon) icon.style.display = 'inline-block';

    try {
        await loadDeliveries();
        renderMapDrivers();
        document.getElementById('mapLastUpdate').textContent =
            `마지막 업데이트: ${new Date().toLocaleTimeString('ko-KR')}`;
    } finally {
        if (icon) icon.style.display = 'none';
    }
}

// ===== 지도에 기사 마커 렌더링 =====
function renderMapDrivers() {
    if (!leafletMap) return;

    // 기존 마커 제거
    Object.values(markers).forEach(m => leafletMap.removeLayer(m));
    markers = {};

    const activeDeliveries = deliveries.filter(d =>
        d.current_lat && d.current_lng &&
        (d.status === 'transit' || d.status === 'loading')
    );

    const driverPanel = document.getElementById('driverListForMap');

    if (!activeDeliveries.length) {
        driverPanel.innerHTML = `
            <div style="padding:20px;text-align:center;color:var(--gray-400);font-size:0.85rem;">
                <i class="fas fa-map-marker-alt" style="font-size:2rem;display:block;margin-bottom:8px;"></i>
                운송 중인 차량이 없습니다
            </div>`;
        return;
    }

    driverPanel.innerHTML = activeDeliveries.map(d => {
        const gpsAge = d.gps_updated_at ? Date.now() - parseInt(d.gps_updated_at) : null;
        const isRecent = gpsAge && gpsAge < 5 * 60 * 1000;

        return `
            <div class="driver-map-item" onclick="focusDriver('${d.id}')">
                <div class="driver-name">
                    <span class="gps-dot ${isRecent ? 'active' : 'inactive'}"></span>
                    ${escapeHtml(d.driver_name || '-')}
                </div>
                <div class="driver-vehicle">${escapeHtml(d.vehicle_number || '-')}${d.cargo_type ? ' · ' + getCargoTypeLabel(d.cargo_type) : ''}</div>
                <div class="driver-gps-time">${d.gps_updated_at ? timeAgo(d.gps_updated_at) : '위치 미수신'}</div>
            </div>
        `;
    }).join('');

    const bounds = [];

    activeDeliveries.forEach(d => {
        const lat = parseFloat(d.current_lat);
        const lng = parseFloat(d.current_lng);
        if (isNaN(lat) || isNaN(lng)) return;

        const gpsAge = d.gps_updated_at ? Date.now() - parseInt(d.gps_updated_at) : null;
        const isRecent = gpsAge && gpsAge < 5 * 60 * 1000;

        const color = isRecent ? '#16a34a' : '#94a3b8';
        const iconHtml = `
            <div style="
                background:${color};
                color:white;
                border-radius:50% 50% 50% 0;
                transform:rotate(-45deg);
                width:36px;height:36px;
                display:flex;align-items:center;justify-content:center;
                border:3px solid white;
                box-shadow:0 2px 8px rgba(0,0,0,0.3);
            ">
                <i class="fas fa-truck" style="transform:rotate(45deg);font-size:14px;"></i>
            </div>`;

        const icon = L.divIcon({
            html: iconHtml,
            iconSize: [36, 36],
            iconAnchor: [18, 36],
            popupAnchor: [0, -36],
            className: ''
        });

        const marker = L.marker([lat, lng], { icon })
            .addTo(leafletMap)
            .bindPopup(`
                <div style="font-family:'Noto Sans KR',sans-serif;min-width:180px;">
                    <strong style="font-size:1rem;">${escapeHtml(d.driver_name || '-')}</strong><br>
                    <span style="color:#64748b;font-size:0.85rem;">${escapeHtml(d.vehicle_number || '-')}</span><br>
                    <hr style="margin:6px 0;">
                    <span style="font-size:0.85rem;"><i class="fas fa-box"></i> ${d.cargo_type ? getCargoTypeLabel(d.cargo_type) : '-'}</span><br>
                    <span style="font-size:0.82rem;color:#64748b;">상태: ${getStatusText(d.status)}</span><br>
                    <span style="font-size:0.78rem;color:#94a3b8;">GPS: ${d.gps_updated_at ? timeAgo(d.gps_updated_at) : '-'}</span>
                </div>
            `);

        markers[d.id] = marker;
        bounds.push([lat, lng]);
    });

    if (bounds.length > 0) {
        if (bounds.length === 1) {
            leafletMap.setView(bounds[0], 13);
        } else {
            leafletMap.fitBounds(bounds, { padding: [40, 40] });
        }
    }
}

// ===== 기사 포커스 =====
function focusDriver(deliveryId) {
    const d = deliveries.find(x => x.id === deliveryId);
    if (!d || !d.current_lat || !d.current_lng) return;

    leafletMap.setView([parseFloat(d.current_lat), parseFloat(d.current_lng)], 14);
    if (markers[deliveryId]) markers[deliveryId].openPopup();
}

// ===== 배송 목록 → 지도 탭으로 이동 후 차량 위치 포커스 =====
function trackOnMap(deliveryId) {
    const d = deliveries.find(x => x.id === deliveryId);
    if (!d || !d.current_lat || !d.current_lng) {
        showToast('GPS 위치 정보가 없습니다.', 'warning');
        return;
    }

    // 지도 탭 버튼 클릭 (탭 활성화)
    const mapTabBtn = document.querySelector('.tab-btn[data-tab="map"]');
    if (mapTabBtn) mapTabBtn.click();

    // 지도 초기화 후 포커스 (약간의 딜레이로 렌더링 완료 대기)
    setTimeout(() => {
        // 지도가 없으면 초기화
        if (!leafletMap) initMap();

        // 지도 크기 재계산 (탭 전환 후 필요)
        leafletMap.invalidateSize();

        // 해당 차량 위치로 이동
        const lat = parseFloat(d.current_lat);
        const lng = parseFloat(d.current_lng);
        leafletMap.setView([lat, lng], 15);

        // 마커 팝업 열기 (마커가 없으면 렌더링 후 열기)
        if (markers[deliveryId]) {
            markers[deliveryId].openPopup();
        } else {
            renderMapDrivers();
            setTimeout(() => {
                if (markers[deliveryId]) markers[deliveryId].openPopup();
            }, 300);
        }

        // 해당 기사 패널 항목 강조
        const driverItems = document.querySelectorAll('.driver-map-item');
        driverItems.forEach(item => item.classList.remove('focused'));
        const targetItem = document.querySelector(`.driver-map-item[onclick*="${deliveryId}"]`);
        if (targetItem) {
            targetItem.classList.add('focused');
            targetItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        showToast(`${d.driver_name || '기사'} 차량 위치로 이동했습니다.`, 'success');
    }, 350);
}

/* ★ 현재 위치 즉시 요청
   DB에 gps_request_at 갱신 → 기사 앱이 5초 내 감지 → 즉시 GPS 전송
   전송 완료 후 자동으로 지도에 위치 표시 */
async function requestGpsNow(deliveryId) {
    const d = deliveries.find(x => x.id === deliveryId);
    if (!d) return;

    const btn = event.currentTarget;
    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 요청 중...';

    try {
        // gps_request_at 갱신 → 기사 앱이 폴링으로 감지
        await apiPatch(`tables/deliveries/${deliveryId}`, {
            gps_request_at: Date.now()
        });
        showToast(`📡 ${d.driver_name || '기사'}님에게 위치 전송 요청했습니다. 잠시 후 지도에 표시됩니다.`, 'success');

        // 10초 후 자동으로 배송목록 새로고침 + 지도 이동
        setTimeout(async () => {
            await loadDeliveries();
            const updated = deliveries.find(x => x.id === deliveryId);
            if (updated && updated.current_lat && updated.current_lng) {
                trackOnMap(deliveryId);
            }
        }, 10000);

    } catch (e) {
        showToast('요청 실패. 다시 시도해주세요.', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = origHtml;
    }
}

// ===== 자동 새로고침 =====
function startAutoRefresh() {
    stopAutoRefresh();
    if (document.getElementById('autoRefreshToggle')?.checked) {
        autoRefreshTimer = setInterval(refreshMap, 30000);
    }
}

function stopAutoRefresh() {
    if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
    }
}

// ===== 서류 사진 탭 =====
function loadDocumentsDropdown() {
    const select = document.getElementById('docsDeliveryFilter');
    if (!select) return;

    const current = select.value;
    select.innerHTML = '<option value="">-- 배송 선택 --</option>';

    deliveries.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.id;
        opt.textContent = `${d.driver_name || '-'} (${d.vehicle_number || '-'}) - ${getStatusText(d.status)}`;
        select.appendChild(opt);
    });

    if (current) select.value = current;
}

function loadDocuments() {
    const deliveryId = document.getElementById('docsDeliveryFilter').value;
    const grid = document.getElementById('docsGrid');

    if (!deliveryId) {
        grid.innerHTML = `<div class="empty-state"><i class="fas fa-file-image"></i><p>배송을 선택하면 서류 사진을 확인할 수 있습니다.</p></div>`;
        return;
    }

    const d = deliveries.find(x => x.id === deliveryId);
    if (!d) return;

    // 날짜 + 사진 렌더 함수
    const renderDoc = (title, photoData, icon, typeClass, dateKey, tsVal) => {
        const dateLabel = dateKey
            ? `<span class="doc-date-tag"><i class="fas fa-calendar-alt"></i> ${dateKey}</span>`
            : '';
        const timeLabel = tsVal
            ? `<span class="doc-time-tag"><i class="fas fa-clock"></i> ${formatDateFull(tsVal)}</span>`
            : '';

        return `
        <div class="doc-section">
            <div class="doc-section-header ${typeClass}">
                <i class="${icon}"></i> ${title}
                <div class="doc-header-meta">${dateLabel}${timeLabel}</div>
            </div>
            ${photoData
                ? `<div class="doc-image-wrap" onclick="openLightbox('${photoData}', '${title} (${dateKey || '-'})')">
                    <img src="${photoData}" alt="${title}" />
                    <p><i class="fas fa-search-plus"></i> 클릭하여 확대</p>
                   </div>`
                : `<div class="doc-no-image"><i class="${icon}"></i><span>사진 없음</span></div>`
            }
        </div>`;
    };

    // stops 다중 하차 렌더
    let stopsArr = [];
    try { stopsArr = d.stops ? JSON.parse(d.stops) : []; } catch {}

    let stopsHtml = '';
    if (stopsArr.length > 0) {
        stopsHtml = stopsArr.map((stop, idx) => `
            <div style="grid-column:1/-1;">
                <div style="display:flex;align-items:center;gap:8px;margin:16px 0 8px;padding-bottom:8px;border-bottom:2px solid #cffafe;">
                    <i class="fas fa-arrow-down" style="color:#0891b2;"></i>
                    <strong style="color:#0891b2;">${escapeHtml(stop.label || `하차 ${idx+1}`)}</strong>
                    ${stop.delivered_at
                        ? `<span style="font-size:0.75rem;background:#dcfce7;color:#16a34a;padding:2px 8px;border-radius:12px;">✅ 완료 ${formatDateShort(stop.delivered_at)}</span>`
                        : `<span style="font-size:0.75rem;background:#fef3c7;color:#d97706;padding:2px 8px;border-radius:12px;">대기중</span>`}
                </div>
            </div>
            ${renderDoc(`[${stop.label||`하차${idx+1}`}] 거래명세표`, stop.invoice_photo, 'fas fa-file-invoice',     'delivery-type', stop.invoice_date, stop.invoice_ts)}
            ${renderDoc(`[${stop.label||`하차${idx+1}`}] 온도기록지`,  stop.temp_photo,    'fas fa-thermometer-half', 'delivery-type', stop.temp_date,   stop.temp_ts)}
        `).join('');
    } else {
        // 구버전 호환
        stopsHtml = `
            ${renderDoc('하차 거래명세표', d.delivery_invoice_photo, 'fas fa-file-invoice',      'delivery-type', d.delivery_invoice_date, d.delivery_invoice_ts)}
            ${renderDoc('하차 온도기록지',  d.delivery_temp_photo,    'fas fa-thermometer-half',  'delivery-type', d.delivery_temp_date,    d.delivery_temp_ts)}
        `;
    }

    grid.innerHTML = `
        ${renderDoc('상차 거래명세표', d.loading_invoice_photo,  'fas fa-file-invoice',      'loading-type',  d.loading_invoice_date,  d.loading_invoice_ts)}
        ${renderDoc('상차 온도기록지',  d.loading_temp_photo,     'fas fa-thermometer-half',  'loading-type',  d.loading_temp_date,     d.loading_temp_ts)}
        ${stopsHtml}
    `;
}

// ===== HTML 이스케이프 =====
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ================================================
   ★ 알림 시스템 — 고객사(룸)용
   이 룸의 배송 이벤트만 필터링하여 표시
   ================================================ */
let roomNotifPollTimer = null;
let roomLastNotifAt    = Date.now();

function startRoomNotifPoll() {
    stopRoomNotifPoll();
    roomLastNotifAt = Date.now();

    roomNotifPollTimer = setInterval(async () => {
        if (!roomId) return;
        try {
            const res  = await fetch(`tables/notifications?limit=20&sort=-created_at`);
            if (!res.ok) return;
            const data = await res.json();
            // 이 룸에 해당하는 알림만 필터
            const rows = (data.data || []).filter(n => {
                const ts = n.created_at ? Number(n.created_at) : 0;
                return ts > roomLastNotifAt && n.room_id === roomId;
            });
            if (rows.length === 0) return;
            roomLastNotifAt = Math.max(...rows.map(n => Number(n.created_at) || 0));
            rows.reverse();
            // ★ 알림음 재생 (이벤트 유형별)
            const hasUrgent = rows.some(n => ['low_speed_alert','loaded_timeout'].includes(n.event_type));
            const hasWarning = rows.some(n => ['stop_arrived'].includes(n.event_type));
            if (hasUrgent) playNotifSound('urgent');
            else if (hasWarning) playNotifSound('warning');
            else playNotifSound('info');
            rows.forEach(n => showRoomNotifToast(n));
            updateRoomNotifBadge(rows.length);
            addRoomNotifItems(rows);
            // 새 이벤트 발생 시 배송 목록 자동 갱신
            loadDeliveries();
        } catch (e) { /* 무시 */ }
    }, 10000);
}

function stopRoomNotifPoll() {
    if (roomNotifPollTimer) { clearInterval(roomNotifPollTimer); roomNotifPollTimer = null; }
}

function showRoomNotifToast(n) {
    const icons = { driver_login: '🚛', loaded: '📦', delivered: '✅', low_speed_alert: '⚠️', loaded_timeout: '⏰', stop_arrived: '📍' };
    showToast(`${icons[n.event_type] || '🔔'} ${n.message}`, 'success', 6000);
}

function updateRoomNotifBadge(count) {
    const badge = document.getElementById('roomNotifBadge');
    if (!badge) return;
    const cur = parseInt(badge.dataset.count || '0') + count;
    badge.dataset.count = cur;
    badge.textContent   = cur > 99 ? '99+' : cur;
    badge.style.display = 'flex';
}

function addRoomNotifItems(rows) {
    const list = document.getElementById('roomNotifList');
    if (!list) return;
    const empty = list.querySelector('.notif-empty');
    if (empty) empty.remove();
    rows.forEach(n => {
        const icMap  = { driver_login:'fas fa-sign-in-alt', loaded:'fas fa-arrow-up', delivered:'fas fa-check-double', low_speed_alert:'fas fa-exclamation-triangle', loaded_timeout:'fas fa-clock', stop_arrived:'fas fa-map-marker-alt' };
        const colMap = { driver_login:'#2563eb', loaded:'#d97706', delivered:'#16a34a', low_speed_alert:'#dc2626', loaded_timeout:'#9333ea', stop_arrived:'#f59e0b' };
        const item   = document.createElement('div');
        item.className = 'notif-item';
        item.style.cssText = 'display:flex;align-items:flex-start;gap:10px;padding:10px 14px;border-bottom:1px solid #e2e8f0;';
        item.innerHTML = `
            <div style="width:30px;height:30px;border-radius:50%;
                        background:${colMap[n.event_type]||'#6366f1'}20;
                        color:${colMap[n.event_type]||'#6366f1'};
                        display:flex;align-items:center;justify-content:center;
                        font-size:0.8rem;flex-shrink:0;margin-top:2px;">
                <i class="${icMap[n.event_type]||'fas fa-bell'}"></i>
            </div>
            <div style="flex:1;min-width:0;">
                <div style="font-size:0.82rem;color:#1e293b;line-height:1.4;word-break:keep-all;">${n.message||''}</div>
                <div style="font-size:0.72rem;color:#94a3b8;margin-top:2px;">${n.cargo_type ? getCargoTypeLabel(n.cargo_type) + ' · ' : ''}${roomFormatRelTime(Number(n.created_at))}</div>
            </div>`;
        list.insertBefore(item, list.firstChild);
    });
    while (list.children.length > 20) list.removeChild(list.lastChild);
}

function roomFormatRelTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 60000)   return '방금';
    if (diff < 3600000) return `${Math.floor(diff/60000)}분 전`;
    return new Date(ts).toLocaleTimeString('ko-KR', { hour:'2-digit', minute:'2-digit' });
}

function toggleRoomNotifPanel() {
    const panel = document.getElementById('roomNotifPanel');
    if (!panel) return;
    const isOpen = panel.style.display !== 'none';
    panel.style.display = isOpen ? 'none' : 'block';
    if (!isOpen) {
        const badge = document.getElementById('roomNotifBadge');
        if (badge) { badge.style.display = 'none'; badge.dataset.count = '0'; }
    }
}

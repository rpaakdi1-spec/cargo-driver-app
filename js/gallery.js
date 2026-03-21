/* ===========================
   사진 보관함 JS - gallery.js
   날짜·거래처별 사진 관리
=========================== */

const GALLERY_ADMIN_PW = 'rhkdtls1';
const GALLERY_SESS_KEY  = 'gallery_auth';

let allDeliveries = [];
let allRooms      = {};
let filteredPhotos = [];
let currentView    = 'date'; // 'date' | 'room' | 'grid'
let lbIndex        = 0;      // 라이트박스 현재 인덱스

// ===== 초기화 =====
document.addEventListener('DOMContentLoaded', async () => {
    const auth = Session.get(GALLERY_SESS_KEY);
    if (auth && auth.ok && (Date.now() - auth.ts < 8 * 60 * 60 * 1000)) {
        showGalleryMain();
    }
    // 오늘 날짜를 기본값으로 설정
    const today = getTodayKST();
    const oneMonthAgo = getDateBefore(30);
    document.getElementById('filterDateFrom').value = oneMonthAgo;
    document.getElementById('filterDateTo').value   = today;
});

// ===== 날짜 유틸 =====
function getTodayKST() {
    return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '-');
}
function getDateBefore(days) {
    const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000 + 9 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
}

// ===== 관리자 로그인 =====
async function doGalleryLogin() {
    const pw  = document.getElementById('galleryPw').value.trim();
    const err = document.getElementById('galleryPwError');
    const btn = document.getElementById('galleryLoginBtn');
    err.style.display = 'none';

    if (!pw) { err.textContent = '비밀번호를 입력해주세요.'; err.style.display = 'block'; return; }
    if (pw !== GALLERY_ADMIN_PW) {
        err.textContent = '비밀번호가 올바르지 않습니다.';
        err.style.display = 'block';
        document.getElementById('galleryPw').value = '';
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 로딩 중...';

    Session.set(GALLERY_SESS_KEY, { ok: true, ts: Date.now() });
    await showGalleryMain();

    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> 입장하기';
}

function galleryLogout() {
    Session.remove(GALLERY_SESS_KEY);
    document.getElementById('adminGate').style.display  = 'flex';
    document.getElementById('galleryMain').style.display = 'none';
    document.getElementById('galleryPw').value = '';
}

// ===== 갤러리 메인 표시 =====
async function showGalleryMain() {
    document.getElementById('adminGate').style.display  = 'none';
    document.getElementById('galleryMain').style.display = 'block';
    await loadAllData();
    applyFilter();
}

// ===== 전체 데이터 로드 =====
async function loadAllData() {
    document.getElementById('galleryResults').innerHTML = `
        <div class="loading-spinner">
            <i class="fas fa-spinner fa-spin"></i> 데이터를 불러오는 중...
        </div>`;
    try {
        // 룸 목록
        const rd = await apiGet('tables/rooms?limit=200');
        (rd.data || []).forEach(r => { allRooms[r.id] = r.room_name; });

        // 룸 필터 드롭다운
        const sel = document.getElementById('filterRoom');
        sel.innerHTML = '<option value="">전체 거래처</option>';
        Object.entries(allRooms).forEach(([id, name]) => {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = name;
            sel.appendChild(opt);
        });

        // ★ 1단계: 목록 조회 (사진 필드 제외 — 경량)
        //   apiGetList는 사진 필드를 자동 제거하므로 타임스탬프 필드로 사진 존재 여부 파악
        const dd = await apiGetList('tables/deliveries?limit=200&sort=created_at');
        const listRows = dd.data || [];

        document.getElementById('galleryTotalBadge').innerHTML =
            `<i class="fas fa-photo-video"></i> 배송 ${listRows.length}건 확인 중...`;

        // ★ 2단계: 사진이 있는 배송건만 단건 조회 (병렬, 최대 10개씩 배치)
        //   타임스탬프 필드(loading_invoice_ts 등)가 있으면 사진 있음으로 판단
        const hasPhoto = (d) =>
            d.loading_invoice_ts || d.loading_temp_ts ||
            d.delivery_invoice_ts || d.loading_extra_photos !== undefined ||
            d.stops; // stops가 있으면 stop_photos도 있을 수 있음

        const needDetail = listRows.filter(hasPhoto);
        console.log(`[gallery] 전체 ${listRows.length}건 중 상세 조회 대상: ${needDetail.length}건`);

        // 배치 병렬 조회 (10개씩)
        const BATCH = 10;
        const detailMap = {};
        for (let i = 0; i < needDetail.length; i += BATCH) {
            const batch = needDetail.slice(i, i + BATCH);
            const results = await Promise.allSettled(
                batch.map(d => apiGet(`tables/deliveries/${d.id}`))
            );
            results.forEach((r, idx) => {
                if (r.status === 'fulfilled' && r.value) {
                    detailMap[batch[idx].id] = r.value;
                }
            });
        }

        // ★ 3단계: 목록 rows에 상세 사진 필드 머지
        allDeliveries = listRows.map(d => {
            const detail = detailMap[d.id];
            if (!detail) return d;
            // 사진 관련 필드만 머지 (메타데이터는 목록 데이터 유지)
            return {
                ...d,
                loading_invoice_photo: detail.loading_invoice_photo || null,
                loading_temp_photo:    detail.loading_temp_photo    || null,
                loading_extra_photos:  detail.loading_extra_photos  || null,
                stop_photos:           detail.stop_photos           || null,
                delivery_invoice_photo: detail.delivery_invoice_photo || null,
                delivery_temp_photo:   detail.delivery_temp_photo   || null,
            };
        });

        const photoCount = allDeliveries.filter(d =>
            d.loading_invoice_photo || d.loading_temp_photo || d.stop_photos
        ).length;
        document.getElementById('galleryTotalBadge').innerHTML =
            `<i class="fas fa-photo-video"></i> 배송 ${allDeliveries.length}건 (사진 ${photoCount}건)`;

    } catch (err) {
        console.error(err);
        document.getElementById('galleryResults').innerHTML = `
            <div class="empty-gallery">
                <i class="fas fa-exclamation-triangle" style="color:#ef4444;"></i>
                <p>데이터를 불러오지 못했습니다.</p>
                <small>네트워크를 확인하고 새로고침해주세요.</small>
            </div>`;
    }
}

// ===== 필터 리셋 =====
function resetFilter() {
    document.getElementById('filterRoom').value     = '';
    document.getElementById('filterDateFrom').value = getDateBefore(30);
    document.getElementById('filterDateTo').value   = getTodayKST();
    document.getElementById('filterDriver').value   = '';
    document.getElementById('filterDocType').value  = '';
    applyFilter();
}

// ===== 필터 적용 & 사진 수집 =====
function applyFilter() {
    const roomFilter   = document.getElementById('filterRoom').value;
    const dateFrom     = document.getElementById('filterDateFrom').value;
    const dateTo       = document.getElementById('filterDateTo').value;
    const driverFilter = document.getElementById('filterDriver').value.trim().toLowerCase();
    const docType      = document.getElementById('filterDocType').value;

    filteredPhotos = [];

    allDeliveries.forEach(d => {
        // 거래처 필터
        if (roomFilter && d.room_id !== roomFilter) return;
        // 기사 필터
        if (driverFilter && !(d.driver_name || '').toLowerCase().includes(driverFilter)) return;

        const roomName  = allRooms[d.room_id] || '미지정';
        const baseInfo  = {
            deliveryId:    d.id,
            roomId:        d.room_id,
            roomName,
            driverName:    d.driver_name    || '-',
            vehicleNumber: d.vehicle_number || '-',
            cargoType:     d.cargo_type     || '',
            origin:        d.origin         || '',
            destination:   d.destination    || '',
            deliveryStatus: d.status
        };

        // 상차 서류
        if (!docType || docType === 'loading' || docType === 'invoice') {
            if (d.loading_invoice_photo && (!dateFrom || (d.loading_invoice_date||'') >= dateFrom) && (!dateTo || (d.loading_invoice_date||'') <= dateTo)) {
                filteredPhotos.push({ ...baseInfo, photo: d.loading_invoice_photo, photoType: 'loading', docKind: 'invoice', dateKey: d.loading_invoice_date || '', ts: d.loading_invoice_ts, label: '상차', stopLabel: null });
            }
        }
        if (!docType || docType === 'loading' || docType === 'temp') {
            if (d.loading_temp_photo && (!dateFrom || (d.loading_temp_date||'') >= dateFrom) && (!dateTo || (d.loading_temp_date||'') <= dateTo)) {
                filteredPhotos.push({ ...baseInfo, photo: d.loading_temp_photo, photoType: 'loading', docKind: 'temp', dateKey: d.loading_temp_date || '', ts: d.loading_temp_ts, label: '상차', stopLabel: null });
            }
        }

        // ★ 하차 서류: stop_photos 필드에서 추출 (v20250321E 이후 구조)
        //   stop_photos = JSON {"0":{invoice_photo,temp_photo,...}, "1":{...}}
        let stopsArr = [];
        try { stopsArr = d.stops ? JSON.parse(d.stops) : []; } catch {}

        let stopPhotos = {};
        try { stopPhotos = d.stop_photos ? JSON.parse(d.stop_photos) : {}; } catch {}

        // stop_photos가 있으면 우선 사용, 없으면 stops 배열의 photo 필드 사용 (하위호환)
        if (Object.keys(stopPhotos).length > 0 || stopsArr.length > 0) {
            const len = Math.max(Object.keys(stopPhotos).length, stopsArr.length);
            for (let idx = 0; idx < len; idx++) {
                const sp   = stopPhotos[String(idx)] || {};
                const meta = stopsArr[idx] || {};
                const stopLabel = meta.label || `하차 ${idx+1}`;

                // 거래명세표
                const invPhoto = sp.invoice_photo || meta.invoice_photo;
                const invDate  = meta.invoice_date || '';
                const invTs    = meta.invoice_ts   || sp.invoice_ts;
                if (!docType || docType === 'delivery' || docType === 'invoice') {
                    if (invPhoto && (!dateFrom || invDate >= dateFrom) && (!dateTo || invDate <= dateTo)) {
                        filteredPhotos.push({ ...baseInfo, photo: invPhoto, photoType: 'delivery', docKind: 'invoice', dateKey: invDate, ts: invTs, label: stopLabel, stopLabel });
                    }
                }

                // 온도기록지
                const tmpPhoto = sp.temp_photo || meta.temp_photo;
                const tmpDate  = meta.temp_date || '';
                const tmpTs    = meta.temp_ts   || sp.temp_ts;
                if (!docType || docType === 'delivery' || docType === 'temp') {
                    if (tmpPhoto && (!dateFrom || tmpDate >= dateFrom) && (!dateTo || tmpDate <= dateTo)) {
                        filteredPhotos.push({ ...baseInfo, photo: tmpPhoto, photoType: 'delivery', docKind: 'temp', dateKey: tmpDate, ts: tmpTs, label: stopLabel, stopLabel });
                    }
                }

                // 추가사진 (extra_photos)
                const extras = sp.extra_photos || meta.extra_photos || [];
                if (Array.isArray(extras)) {
                    extras.forEach(ep => {
                        if (!ep || !ep.url) return;
                        const epDate = ep.date || meta.arrived_at?.slice(0,10) || '';
                        if ((!dateFrom || epDate >= dateFrom) && (!dateTo || epDate <= dateTo)) {
                            filteredPhotos.push({ ...baseInfo, photo: ep.url, photoType: 'delivery', docKind: 'extra', dateKey: epDate, ts: ep.ts, label: stopLabel, stopLabel });
                        }
                    });
                }
            }
        } else {
            // 구버전 하차 호환 (delivery_invoice_photo 직접 저장)
            if (!docType || docType === 'delivery' || docType === 'invoice') {
                if (d.delivery_invoice_photo && (!dateFrom || (d.delivery_invoice_date||'') >= dateFrom) && (!dateTo || (d.delivery_invoice_date||'') <= dateTo)) {
                    filteredPhotos.push({ ...baseInfo, photo: d.delivery_invoice_photo, photoType: 'delivery', docKind: 'invoice', dateKey: d.delivery_invoice_date || '', ts: d.delivery_invoice_ts, label: '하차', stopLabel: null });
                }
            }
            if (!docType || docType === 'delivery' || docType === 'temp') {
                if (d.delivery_temp_photo && (!dateFrom || (d.delivery_temp_date||'') >= dateFrom) && (!dateTo || (d.delivery_temp_date||'') <= dateTo)) {
                    filteredPhotos.push({ ...baseInfo, photo: d.delivery_temp_photo, photoType: 'delivery', docKind: 'temp', dateKey: d.delivery_temp_date || '', ts: d.delivery_temp_ts, label: '하차', stopLabel: null });
                }
            }
        }

        // ★ 상차 추가사진 (loading_extra_photos)
        if (!docType || docType === 'loading' || docType === 'extra') {
            let loadingExtras = [];
            try { loadingExtras = d.loading_extra_photos ? JSON.parse(d.loading_extra_photos) : []; } catch {}
            if (Array.isArray(loadingExtras)) {
                loadingExtras.forEach(ep => {
                    if (!ep || !ep.url) return;
                    const epDate = ep.date || d.loading_invoice_date || '';
                    if ((!dateFrom || epDate >= dateFrom) && (!dateTo || epDate <= dateTo)) {
                        filteredPhotos.push({ ...baseInfo, photo: ep.url, photoType: 'loading', docKind: 'extra', dateKey: epDate, ts: ep.ts, label: '상차(추가)', stopLabel: null });
                    }
                });
            }
        }
    });

    // 날짜순 정렬 (최신 → 오래된)
    filteredPhotos.sort((a, b) => {
        const dk = (b.dateKey || '').localeCompare(a.dateKey || '');
        if (dk !== 0) return dk;
        return (parseInt(b.ts) || 0) - (parseInt(a.ts) || 0);
    });

    updateStats();
    renderView();
}

// ===== 통계 =====
function updateStats() {
    const total     = filteredPhotos.length;
    const loading   = filteredPhotos.filter(p => p.photoType === 'loading').length;
    const delivery  = filteredPhotos.filter(p => p.photoType === 'delivery').length;
    const delivSet  = new Set(filteredPhotos.map(p => p.deliveryId)).size;

    document.getElementById('statTotalPhotos').textContent     = total;
    document.getElementById('statLoadingPhotos').textContent   = loading;
    document.getElementById('statDeliveryPhotos').textContent  = delivery;
    document.getElementById('statTotalDeliveries').textContent = delivSet;

    const dateFrom = document.getElementById('filterDateFrom').value;
    const dateTo   = document.getElementById('filterDateTo').value;
    let titleStr = `총 ${total}장`;
    if (dateFrom && dateTo) titleStr += ` (${dateFrom} ~ ${dateTo})`;
    document.getElementById('galleryResultTitle').textContent = titleStr;
}

// ===== 뷰 전환 =====
function setView(view) {
    currentView = view;
    ['date','room','grid'].forEach(v => {
        const btn = document.getElementById(`btnView${v.charAt(0).toUpperCase()+v.slice(1)}`);
        if (btn) btn.classList.toggle('active', v === view);
    });
    renderView();
}

function renderView() {
    if (filteredPhotos.length === 0) {
        document.getElementById('galleryResults').innerHTML = `
            <div class="empty-gallery">
                <i class="fas fa-images"></i>
                <p>조건에 맞는 사진이 없습니다.</p>
                <small>날짜 범위나 필터 조건을 변경해보세요.</small>
            </div>`;
        return;
    }

    if (currentView === 'date') renderByDate();
    else if (currentView === 'room') renderByRoom();
    else renderAllGrid();
}

// ===== 날짜별 뷰 =====
function renderByDate() {
    const grouped = {};
    filteredPhotos.forEach(p => {
        const key = p.dateKey || '날짜 없음';
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(p);
    });

    const keys = Object.keys(grouped).sort((a, b) => b.localeCompare(a));
    let html = '';

    keys.forEach(date => {
        const photos = grouped[date];
        const rooms  = [...new Set(photos.map(p => p.roomName))];
        html += `
            <div class="date-group">
                <div class="date-group-header">
                    <i class="fas fa-calendar-day" style="color:var(--primary);"></i>
                    <span class="date-text">${formatDisplayDate(date)}</span>
                    <span class="date-count">${photos.length}장 · ${rooms.join(', ')}</span>
                </div>
                <div class="photo-grid">
                    ${photos.map((p, idx) => photoCardHtml(p, globalIndex(p))).join('')}
                </div>
            </div>
        `;
    });

    document.getElementById('galleryResults').innerHTML = html;
}

// ===== 거래처별 뷰 =====
function renderByRoom() {
    const grouped = {};
    filteredPhotos.forEach(p => {
        const key = p.roomId || 'unknown';
        if (!grouped[key]) grouped[key] = { name: p.roomName, photos: [] };
        grouped[key].photos.push(p);
    });

    const keys = Object.keys(grouped);
    let html = '';

    keys.forEach(roomId => {
        const { name, photos } = grouped[roomId];
        const loadCnt = photos.filter(p => p.photoType === 'loading').length;
        const delCnt  = photos.filter(p => p.photoType === 'delivery').length;

        html += `
            <div class="room-group">
                <div class="room-group-header">
                    <div class="room-name-text">
                        <i class="fas fa-building"></i> ${escapeHtml(name)}
                    </div>
                    <div class="room-meta">
                        총 ${photos.length}장
                        · <span style="color:#d97706;">상차 ${loadCnt}</span>
                        · <span style="color:#16a34a;">하차 ${delCnt}</span>
                    </div>
                </div>
                <div class="room-group-body">
                    <div class="photo-grid">
                        ${photos.map(p => photoCardHtml(p, globalIndex(p))).join('')}
                    </div>
                </div>
            </div>
        `;
    });

    document.getElementById('galleryResults').innerHTML = html;
}

// ===== 전체 그리드 뷰 =====
function renderAllGrid() {
    document.getElementById('galleryResults').innerHTML = `
        <div style="background:white;border-radius:16px;padding:16px;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
            <div class="photo-grid">
                ${filteredPhotos.map((p, idx) => photoCardHtml(p, idx)).join('')}
            </div>
        </div>
    `;
}

// ===== 사진 카드 HTML =====
function photoCardHtml(p, globalIdx) {
    const typeLabel = p.photoType === 'loading' ? '상차' : (p.stopLabel || '하차');
    const typeClass = p.photoType === 'loading' ? 'type-loading' : 'type-delivery';
    const kindIcon  = p.docKind === 'invoice' ? 'fas fa-file-invoice' : 'fas fa-thermometer-half';
    const kindLabel = p.docKind === 'invoice' ? '거래명세표' : '온도기록지';

    return `
        <div class="photo-card" onclick="openLightboxAt(${globalIdx})">
            <img class="photo-thumb" src="${p.photo}" alt="${kindLabel}" loading="lazy" />
            <div class="photo-info">
                <span class="photo-type ${typeClass}">${typeLabel}</span>
                <span class="info-badge badge-${p.docKind === 'invoice' ? 'invoice' : 'temp'}" style="margin-left:4px;">
                    <i class="${kindIcon}"></i> ${kindLabel}
                </span>
                <div class="photo-driver">
                    <i class="fas fa-user" style="font-size:0.68rem;"></i>
                    ${escapeHtml(p.driverName)}
                </div>
                <div class="photo-date-small">
                    <i class="fas fa-building" style="font-size:0.65rem;"></i> ${escapeHtml(p.roomName)}<br>
                    ${p.dateKey ? `<i class="fas fa-calendar" style="font-size:0.65rem;"></i> ${p.dateKey}` : '날짜 없음'}
                </div>
                ${p.cargoType ? `<div class="photo-date-small">${cargoTypeBadge(p.cargoType)}</div>` : ''}
            </div>
        </div>
    `;
}

// ===== 글로벌 인덱스 찾기 =====
function globalIndex(p) {
    return filteredPhotos.indexOf(p);
}

// ===== 라이트박스 =====
function openLightboxAt(idx) {
    if (idx < 0 || idx >= filteredPhotos.length) return;
    lbIndex = idx;
    showLightboxItem();
    document.getElementById('lightboxOverlay').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function showLightboxItem() {
    const p     = filteredPhotos[lbIndex];
    const total = filteredPhotos.length;

    document.getElementById('lightboxImg').src = p.photo;
    document.getElementById('lbCounter').textContent = `${lbIndex + 1} / ${total}`;
    document.getElementById('lbPrev').disabled = (lbIndex === 0);
    document.getElementById('lbNext').disabled = (lbIndex === total - 1);

    const typeText  = p.photoType === 'loading' ? '상차' : (p.stopLabel || '하차');
    const kindText  = p.docKind === 'invoice' ? '거래명세표' : '온도기록지';
    document.getElementById('lightboxCaption').innerHTML = `
        <strong>${escapeHtml(p.roomName)}</strong> ·
        ${escapeHtml(p.driverName)} (${escapeHtml(p.vehicleNumber)}) ·
        ${typeText} ${kindText}
        ${p.dateKey ? `· 📅 ${p.dateKey}` : ''}
        ${p.cargoType ? `<br><span style="font-size:0.82rem;opacity:0.7;">${getCargoTypeLabel(p.cargoType)} ${p.origin ? `/ ${escapeHtml(p.origin)} → ${escapeHtml(p.destination)}` : ''}</span>` : ''}
    `;
}

function navigateLightbox(dir) {
    const newIdx = lbIndex + dir;
    if (newIdx < 0 || newIdx >= filteredPhotos.length) return;
    lbIndex = newIdx;
    showLightboxItem();
}

function closeLightbox(event) {
    if (event && event.target !== document.getElementById('lightboxOverlay') && event.target !== document.getElementById('lightboxImg')) {
        // 내부 클릭은 무시 (nav버튼, 캡션 등)
    }
    if (!event || event.target === document.getElementById('lightboxOverlay')) {
        document.getElementById('lightboxOverlay').classList.remove('active');
        document.body.style.overflow = '';
    }
}

// 키보드 이벤트
document.addEventListener('keydown', (e) => {
    const lb = document.getElementById('lightboxOverlay');
    if (!lb.classList.contains('active')) return;
    if (e.key === 'ArrowLeft')  navigateLightbox(-1);
    if (e.key === 'ArrowRight') navigateLightbox(1);
    if (e.key === 'Escape')     { lb.classList.remove('active'); document.body.style.overflow = ''; }
});

// ===== 날짜 포맷 =====
function formatDisplayDate(dateStr) {
    if (!dateStr || dateStr === '날짜 없음') return '날짜 미지정';
    try {
        const d = new Date(dateStr + 'T00:00:00');
        const days = ['일','월','화','수','목','금','토'];
        return `${dateStr} (${days[d.getDay()]}요일)`;
    } catch { return dateStr; }
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ===========================
   기사 PIN 로그인 전용 모듈
   login.js v20250322A
   - driver.js와 완전히 분리
   - async/await 없이 순수 .then().catch() 체인
   - 구형 Android WebView 완전 호환
=========================== */

(function() {
    'use strict';

    /* ── 잠금 관리 ── */
    var LOCKOUT_KEY = 'pin_lockout';
    function getLockout() {
        try { return JSON.parse(localStorage.getItem(LOCKOUT_KEY)) || {count:0,lockedUntil:0}; }
        catch(e) { return {count:0,lockedUntil:0}; }
    }
    function setLockout(obj) { localStorage.setItem(LOCKOUT_KEY, JSON.stringify(obj)); }
    function clearLockout() { localStorage.removeItem(LOCKOUT_KEY); }

    /* ── 잠금 초기화 (버튼에서 호출) ── */
    window.resetPinLockout = function() {
        clearLockout();
        setDebug('잠금 초기화 완료');
        showToast('로그인 잠금이 초기화되었습니다.', 'success');
    };

    /* ── 디버그 표시 ── */
    function setDebug(msg) {
        var el = document.getElementById('loginDebug');
        if (el) el.textContent = msg;
        console.log('[LOGIN] ' + msg);
    }

    /* ── 에러 표시 ── */
    function showErr(msg) {
        var el = document.getElementById('driverPinError');
        if (el) { el.textContent = msg; el.style.display = 'block'; }
        showToast(msg, 'error', 5000);
        setDebug('오류: ' + msg.substring(0, 50));
    }
    function hideErr() {
        var el = document.getElementById('driverPinError');
        if (el) el.style.display = 'none';
    }

    /* ── 버튼 상태 ── */
    var _busy = false;
    function setBusy(v) {
        _busy = v;
        var btn = document.getElementById('btnDoLogin');
        if (!btn) return;
        if (v) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 확인 중...';
        } else {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> 로그인';
        }
    }

    /* ── 핵심: 로그인 함수 ── */
    window.handlePinLogin = function(e) {
        if (e) { try { e.preventDefault(); } catch(x) {} }
        if (_busy) return;

        hideErr();

        var name = (document.getElementById('pinDriverName') || {}).value;
        var pin  = (document.getElementById('pinCode') || {}).value;
        name = name ? name.trim() : '';
        pin  = pin  ? pin.trim()  : '';

        if (!name || !pin) {
            showErr('이름과 PIN을 모두 입력해주세요.');
            return;
        }

        var lockout = getLockout();
        var now = Date.now();
        if (lockout.lockedUntil > now) {
            var sec = Math.ceil((lockout.lockedUntil - now) / 1000);
            showErr('잠금 중 (' + sec + '초 후 재시도)');
            return;
        }

        setBusy(true);
        setDebug('서버 연결 중...');

        fetch('tables/deliveries?limit=500')
            .then(function(res) {
                setDebug('응답: HTTP ' + res.status);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function(json) {
                var all = (json && Array.isArray(json.data)) ? json.data : [];
                setDebug(all.length + '건 로드됨. 이름 검색 중...');

                return hashPassword(pin).then(function(pinHash) {
                    var fallback = _fallbackHash(pin + '_cargo_salt_2025');
                    setDebug('해시 완료. 매칭 중...');

                    var matched = [];
                    for (var i = 0; i < all.length; i++) {
                        var d = all[i];
                        if (!d.driver_name) continue;
                        if (d.driver_name.replace(/\s/g,'') !== name.replace(/\s/g,'')) continue;
                        if (d.driver_pin_hash === pinHash ||
                            d.driver_pin_hash === fallback ||
                            (d.driver_pin_hash2 && (d.driver_pin_hash2 === pinHash || d.driver_pin_hash2 === fallback))) {
                            matched.push(d);
                        }
                    }

                    setDebug('매칭: ' + matched.length + '건');

                    if (matched.length === 0) {
                        var nameOnly = 0;
                        for (var j = 0; j < all.length; j++) {
                            if (all[j].driver_name && all[j].driver_name.replace(/\s/g,'') === name.replace(/\s/g,'')) nameOnly++;
                        }
                        var lk = getLockout();
                        var cnt = (lk.count || 0) + 1;
                        var msg;
                        if (cnt >= 5) {
                            var sec2 = Math.min(30 * Math.pow(2, cnt - 5), 600);
                            setLockout({count: cnt, lockedUntil: Date.now() + sec2 * 1000});
                            msg = '5회 실패 — ' + sec2 + '초 잠금';
                        } else {
                            setLockout({count: cnt, lockedUntil: 0});
                            msg = nameOnly === 0
                                ? '"' + name + '" 이름의 배송건이 없습니다. (' + cnt + '/5)\n고객사 담당자에게 문의하세요.'
                                : 'PIN이 올바르지 않습니다. (' + cnt + '/5회)';
                        }
                        var pinEl = document.getElementById('pinCode');
                        if (pinEl) pinEl.value = '';
                        showErr(msg);
                        setBusy(false);
                        return;
                    }

                    /* ── 로그인 성공 ── */
                    clearLockout();
                    setDebug('로그인 성공!');

                    /* currentDriverName은 driver.js의 전역 변수 */
                    if (typeof currentDriverName !== 'undefined') {
                        currentDriverName = name;
                    }
                    /* Session 헬퍼는 utils.js에 있음 */
                    if (typeof Session !== 'undefined') {
                        Session.set('driver_session', {driverName: name, pinHash: pinHash, timestamp: Date.now()});
                    }
                    if (typeof lsSaveSession === 'function') {
                        lsSaveSession(name, pinHash);
                    }

                    showToast(name + ' 기사님, 로그인되었습니다! 🎉', 'success');
                    setBusy(false);

                    if (typeof showSelectSection === 'function') {
                        showSelectSection();
                    }
                });
            })
            .catch(function(err) {
                var msg = err && err.message ? err.message : String(err);
                setDebug('오류: ' + msg);
                showErr('서버 오류: ' + msg);
                setBusy(false);
            });
    };

    /* ── 비밀번호 표시/숨기기 ── */
    window.togglePassword = function(inputId) {
        var input = document.getElementById(inputId);
        if (!input) return;
        var wrap = input.parentElement;
        var icon = wrap ? wrap.querySelector('.toggle-pw i') : null;
        if (input.type === 'password') {
            input.type = 'text';
            if (icon) icon.className = 'fas fa-eye-slash';
        } else {
            input.type = 'password';
            if (icon) icon.className = 'fas fa-eye';
        }
    };

    /* ── DOMContentLoaded 시 버튼 이벤트 등록 ── */
    function bindBtn() {
        var btn = document.getElementById('btnDoLogin');
        if (!btn) return;
        btn.onclick = window.handlePinLogin;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindBtn);
    } else {
        bindBtn();
    }

})();

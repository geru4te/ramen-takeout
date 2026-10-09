const socket = io();
const CONTAINER_FEE_PER_BOWL = 100; // ラーメン・汁なし 1杯につき容器代100円

let menuData = { mainMenu: [], toppings: { free: [], paid: [] } };
let cart = [];
let currentOrderId = localStorage.getItem('ramen_order_id') || null;
let currentOrder = null;
let isAcceptingOrders = true;

let selectedRamen = null;

// Web Audio API での出来上がり呼出チャイム
let custAudioCtx = null;
function getCustAudioContext() {
  if (!custAudioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) custAudioCtx = new AudioContextClass();
  }
  return custAudioCtx;
}

async function unlockCustAudio() {
  const ctx = getCustAudioContext();
  if (ctx && ctx.state === 'suspended') {
    try { await ctx.resume(); } catch (e) {}
  }
}
['click', 'touchstart'].forEach(evt => {
  window.addEventListener(evt, unlockCustAudio, { passive: true });
});

// 出来上がり完成チャイム音（明るい「ピンポンパンポ〜ン♪」）
function playCustomerReadyChime() {
  try {
    const ctx = getCustAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});

    // スマートフォンのバイブレーション（対応機種）
    if ('vibrate' in navigator) {
      try { navigator.vibrate([300, 150, 300, 150, 500]); } catch (e) {}
    }

    const playNote = (freq, startOffset, dur = 0.5, vol = 0.45) => {
      const startTime = ctx.currentTime + startOffset;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, startTime);
      gain.gain.setValueAtTime(vol, startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startTime);
      osc.stop(startTime + dur);
    };

    // ド(523Hz) → ミ(659Hz) → ソ(784Hz) → 高いド(1046Hz)
    const base = 0.05;
    playNote(523.25, base, 0.45, 0.4);
    playNote(659.25, base + 0.25, 0.45, 0.4);
    playNote(783.99, base + 0.50, 0.45, 0.4);
    playNote(1046.50, base + 0.75, 0.90, 0.5);
  } catch (err) {
    console.error('Customer ready chime error:', err);
  }
}

// DOM要素
const menuListView = document.getElementById('menu-order-view');
const orderStatusView = document.getElementById('order-status-view');
const categoryTabs = document.getElementById('category-tabs');
const menuListContainer = document.getElementById('menu-list');
const cartBar = document.getElementById('cart-bar');
const cartCount = document.getElementById('cart-count');
const cartTotal = document.getElementById('cart-total');

// 注文確認モーダル
const confirmModal = document.getElementById('confirm-modal');
const btnOpenConfirm = document.getElementById('btn-open-confirm');
const btnCloseModal = document.getElementById('btn-close-modal');
const btnSubmitOrder = document.getElementById('btn-submit-order');
const modalCartItems = document.getElementById('modal-cart-items');
const modalTicketTotal = document.getElementById('modal-ticket-total');
const modalOrderMemo = document.getElementById('modal-order-memo');
const storePausedBanner = document.getElementById('store-paused-banner');
const pausedBannerTitle = document.getElementById('paused-banner-title');
const pausedBannerDesc = document.getElementById('paused-banner-desc');
const welcomeGuideBox = document.getElementById('welcome-guide-box');
const capacityDot = document.getElementById('capacity-dot');
const capacityCount = document.getElementById('capacity-count');
const capacityBadge = document.getElementById('capacity-badge');

// トッピングカスタマイズモーダル
const toppingModal = document.getElementById('topping-modal');
const toppingModalTitle = document.getElementById('topping-modal-title');
const toppingModalDesc = document.getElementById('topping-modal-desc');
const freeToppingsContainer = document.getElementById('free-toppings-container');
const paidToppingsContainer = document.getElementById('paid-toppings-container');
const toppingModalSubtotal = document.getElementById('topping-modal-subtotal');
const btnCloseToppingModal = document.getElementById('btn-close-topping-modal');
const btnAddCustomizedItem = document.getElementById('btn-add-customized-item');

// 注文完了画面要素
const dispOrderNumber = document.getElementById('disp-order-number');
const dispOrderItemsList = document.getElementById('disp-order-items-list');
const dispTotalAmount = document.getElementById('disp-total-amount');

// LINE認証関連（ポップアップモーダル）
const lineAuthModal = document.getElementById('line-auth-modal');
const btnPopupLineAuth = document.getElementById('btn-popup-line-auth');
const btnCloseLineAuthModal = document.getElementById('btn-close-line-auth-modal');

// リピーター特典関連UI要素
const repeatRewardBanner = document.getElementById('repeat-reward-banner');
const repeatRewardText = document.getElementById('repeat-reward-text');
const modalRewardBanner = document.getElementById('modal-reward-banner');
const modalRewardDiscountText = document.getElementById('modal-reward-discount-text');

let liffProfile = null; // { userId, displayName }
let liffConfigId = null;
let currentUserStats = {
  totalCount: 0,
  monthlyCount: 0,
  isContainerFree: false,
  remainingForFree: 2
};

// プロフィールキャッシュ管理（LINE内ブラウザでのリロード・リダイレクト耐性を最大化）
function saveLineProfileCache(profile) {
  if (!profile || !profile.userId) return;
  try {
    localStorage.setItem('ramen_line_user_cache', JSON.stringify(profile));
    sessionStorage.setItem('ramen_line_user_cache', JSON.stringify(profile));
  } catch (e) {}
}

function getCachedLineProfile() {
  try {
    const s = sessionStorage.getItem('ramen_line_user_cache') || localStorage.getItem('ramen_line_user_cache');
    if (s) {
      const p = JSON.parse(s);
      if (p && p.userId) return p;
    }
  } catch (e) {}
  return null;
}

async function fetchUserOrderStats(userId) {
  if (!userId) return;
  try {
    const res = await fetch(`/api/user/order-stats?lineUserId=${encodeURIComponent(userId)}`);
    if (res.ok) {
      currentUserStats = await res.json();
      updateRepeatRewardUI();
      recalculateCartPrices();
    }
  } catch (e) {
    console.warn('Failed to fetch user stats:', e);
  }
}

function updateRepeatRewardUI() {
  if (!repeatRewardText) return;
  if (!liffProfile) {
    repeatRewardText.innerHTML = `<strong>リピーター特典:</strong> 1か月に3回以上のご利用で容器代（1杯100円）が無料になります！`;
    return;
  }

  const monthly = currentUserStats.monthlyCount || 0;
  if (currentUserStats.isContainerFree) {
    repeatRewardText.innerHTML = `🎉 <strong>リピーター特典適用中:</strong> 今月${monthly}回ご利用中！今回の注文から容器代（1杯100円）が【無料】になります！`;
  } else if (monthly === 1) {
    repeatRewardText.innerHTML = `🌟 <strong>リピーター特典:</strong> 今月1回ご利用済み！あと1回のご注文で容器代（1杯100円）が無料になります！`;
  } else {
    repeatRewardText.innerHTML = `🌱 <strong>リピーター特典:</strong> 1か月に3回以上のご利用で容器代（1杯100円）が無料になります！（今月あと2回）`;
  }
}

function recalculateCartPrices() {
  const isFree = Boolean(currentUserStats && currentUserStats.isContainerFree);
  let changed = false;
  cart.forEach(item => {
    const fee = isFree ? 0 : CONTAINER_FEE_PER_BOWL;
    if (item.containerFee !== fee) {
      item.containerFee = fee;
      item.requiredTickets = [
        ...(item.requiredTickets || []).filter(t => t.name !== '容器代券'),
        ...(fee > 0 ? [{ name: '容器代券', price: fee }] : [])
      ];
      let topsTotal = 0;
      (item.paidToppings || []).forEach(p => { topsTotal += (p.price || 0); });
      item.itemTotal = item.price + fee + topsTotal;
      changed = true;
    }
  });
  if (changed) {
    updateCartBar();
    saveCartToStorage();
  }
}

async function initLiff() {
  try {
    const res = await fetch('/api/config/liff');
    const data = await res.json();
    liffConfigId = data.liffId || null;

    // まずキャッシュからプロフィールを復元（LINEアプリ内での高速化）
    const cached = getCachedLineProfile();
    if (cached) {
      liffProfile = cached;
    }

    if (liffConfigId && window.liff) {
      await liff.init({ liffId: liffConfigId });

      // LINE内ブラウザ（isInClient）またはすでにログイン済みの場合は自動プロフィール取得
      if (liff.isLoggedIn()) {
        try {
          const p = await liff.getProfile();
          if (p) {
            liffProfile = p;
            saveLineProfileCache(p);
            await fetchUserOrderStats(p.userId);
          }
        } catch (profileErr) {
          console.warn('LIFF getProfile warning in init:', profileErr);
        }
      }
    } else {
      const savedMock = localStorage.getItem('ramen_demo_line_user');
      if (savedMock) {
        try { 
          liffProfile = JSON.parse(savedMock); 
          saveLineProfileCache(liffProfile);
          await fetchUserOrderStats(liffProfile.userId);
        } catch (e) {}
      }
    }

    updateRepeatRewardUI();

    // LINEログインリダイレクト復帰後の自動確定チェック（リセット防止）
    await checkPendingOrderAutoSubmit();
  } catch (err) {
    console.warn('LIFF init warning:', err);
    // エラー時でも保留中注文チェックは試行
    await checkPendingOrderAutoSubmit();
  }
}

// リダイレクト復帰時に保留中の注文を自動送信（注文リセットを完全に防止）
async function checkPendingOrderAutoSubmit() {
  let pendingStr = null;
  try {
    pendingStr = localStorage.getItem('ramen_pending_order') || sessionStorage.getItem('ramen_pending_order');
  } catch (e) {}

  if (!pendingStr) return;

  try {
    const pending = JSON.parse(pendingStr);
    if (!pending || !pending.cart || pending.cart.length === 0) return;
    if (Date.now() - (pending.timestamp || 0) > 15 * 60 * 1000) return; // 15分以内

    // プロフィールがまだなければ取得を試行
    if (!liffProfile && window.liff && liff.isLoggedIn()) {
      try {
        liffProfile = await liff.getProfile();
        saveLineProfileCache(liffProfile);
      } catch (e) {}
    }
    if (!liffProfile) {
      liffProfile = getCachedLineProfile();
    }

    // LINEアプリ内ブラウザ（isInClient）ならプロフィール取得が制限されても注文を通す
    if (!liffProfile && window.liff && liff.isInClient && liff.isInClient()) {
      liffProfile = {
        userId: 'U_line_client_' + Date.now().toString(36),
        displayName: 'LINEお客様'
      };
      saveLineProfileCache(liffProfile);
    }

    if (liffProfile) {
      localStorage.removeItem('ramen_pending_order');
      sessionStorage.removeItem('ramen_pending_order');
      cart = pending.cart;
      await executeSubmitOrder(pending.cart, pending.memo || '', liffProfile);
    }
  } catch (e) {
    console.error('Pending order submit error:', e);
  }
}

// ポップアップ「LINEで認証して注文を確定する」ボタン押下時
if (btnPopupLineAuth) {
  btnPopupLineAuth.addEventListener('click', async () => {
    btnPopupLineAuth.disabled = true;
    btnPopupLineAuth.textContent = 'LINE認証中...';

    const memoVal = modalOrderMemo ? modalOrderMemo.value.trim() : '';
    const pending = {
      cart: cart,
      memo: memoVal,
      timestamp: Date.now()
    };
    try {
      localStorage.setItem('ramen_pending_order', JSON.stringify(pending));
      sessionStorage.setItem('ramen_pending_order', JSON.stringify(pending));
    } catch (e) {}
    saveCartToStorage();

    if (liffConfigId && window.liff) {
      try {
        // すでにログイン済み、またはLINEアプリ内ブラウザ（isInClient）なら即座に取得して注文送信！
        if (liff.isLoggedIn()) {
          try {
            liffProfile = await liff.getProfile();
            saveLineProfileCache(liffProfile);
            await fetchUserOrderStats(liffProfile.userId);
          } catch (pe) {
            console.warn('Profile fetch warning:', pe);
          }
          if (lineAuthModal) lineAuthModal.style.display = 'none';
          return executeSubmitOrder(cart, memoVal, liffProfile);
        }

        // LINEアプリ内ブラウザで万が一 isLoggedIn() が false でも即時確定
        if (liff.isInClient && liff.isInClient()) {
          liffProfile = {
            userId: 'U_line_inapp_' + Date.now().toString(36),
            displayName: 'LINEお客様'
          };
          saveLineProfileCache(liffProfile);
          if (lineAuthModal) lineAuthModal.style.display = 'none';
          return executeSubmitOrder(cart, memoVal, liffProfile);
        }

        // 外部ブラウザの場合は redirectUri を現在URLに指定してログイン画面へ
        liff.login({ redirectUri: window.location.href });
      } catch (err) {
        console.error('LIFF auth error in popup:', err);
        // エラー時でもお客様をブロックせず注文確定へフォールバック
        liffProfile = {
          userId: 'U_line_user_' + Date.now().toString(36),
          displayName: 'LINEお客様'
        };
        saveLineProfileCache(liffProfile);
        if (lineAuthModal) lineAuthModal.style.display = 'none';
        return executeSubmitOrder(cart, memoVal, liffProfile);
      }
    } else {
      // LIFF ID未設定時のテスト認証
      const name = prompt('【LINE認証テスト】お名前（ニックネーム）を入力:', 'ラーメン好きのお客様');
      if (name && name.trim()) {
        liffProfile = {
          userId: 'U_test_' + Math.random().toString(36).substring(2, 10),
          displayName: name.trim()
        };
        localStorage.setItem('ramen_demo_line_user', JSON.stringify(liffProfile));
        saveLineProfileCache(liffProfile);
        await fetchUserOrderStats(liffProfile.userId);
        if (lineAuthModal) lineAuthModal.style.display = 'none';
        executeSubmitOrder(cart, memoVal, liffProfile);
      } else {
        btnPopupLineAuth.disabled = false;
        btnPopupLineAuth.textContent = 'LINEで認証して注文を確定する';
      }
    }
  });
}

// ポップアップ閉じるボタン
if (btnCloseLineAuthModal) {
  btnCloseLineAuthModal.addEventListener('click', () => {
    if (lineAuthModal) lineAuthModal.style.display = 'none';
  });
}

let currentStoreStatus = {
  isAcceptingOrders: true,
  pauseReason: '店内混雑のため',
  maxConcurrent: 10,
  activeCount: 0,
  remainingSlots: 10,
  isLimitReached: false,
  canAccept: true
};

window.addEventListener('DOMContentLoaded', async () => {
  currentOrderId = localStorage.getItem('ramen_order_id') || sessionStorage.getItem('ramen_order_id') || null;

  await initLiff();
  await fetchStoreStatus();
  await fetchMenu();
  loadCartFromStorage();

  // 自動注文確定された場合、または既存の有効な注文がある場合は受付完了画面を確実に表示
  if (currentOrder) {
    showOrderStatus(currentOrder);
  } else if (currentOrderId) {
    await checkExistingOrder(currentOrderId);
  }
});

async function fetchStoreStatus() {
  try {
    const res = await fetch('/api/store-status');
    const data = await res.json();
    setStoreStatus(data);
  } catch (err) {
    console.error('Failed to load store status:', err);
  }
}

function setStoreStatus(statusData) {
  if (typeof statusData === 'boolean') {
    currentStoreStatus.isAcceptingOrders = statusData;
    currentStoreStatus.canAccept = statusData;
  } else if (statusData && typeof statusData === 'object') {
    currentStoreStatus = { ...currentStoreStatus, ...statusData };
  }

  const canAccept = currentStoreStatus.canAccept;
  const isLimitReached = currentStoreStatus.isLimitReached;
  const activeCount = currentStoreStatus.activeCount || 0;
  const maxConcurrent = currentStoreStatus.maxConcurrent || 10;
  const remaining = currentStoreStatus.remainingSlots !== undefined ? currentStoreStatus.remainingSlots : Math.max(0, maxConcurrent - activeCount);

  isAcceptingOrders = canAccept;

  // 同時受付枠ステータスバーの更新
  if (capacityCount) {
    capacityCount.textContent = `${activeCount} / ${maxConcurrent}件`;
  }
  if (capacityDot && capacityBadge) {
    capacityDot.className = 'capacity-dot';
    capacityBadge.className = 'capacity-badge';

    if (!currentStoreStatus.isAcceptingOrders) {
      capacityDot.classList.add('warning');
      capacityBadge.classList.add('warning');
      capacityBadge.textContent = '店舗休止中';
    } else if (isLimitReached) {
      capacityDot.classList.add('full');
      capacityBadge.classList.add('full');
      capacityBadge.textContent = `🔴 満枠（現在${maxConcurrent}件対応中）`;
    } else if (remaining <= 2) {
      capacityDot.classList.add('warning');
      capacityBadge.classList.add('warning');
      capacityBadge.textContent = `🟡 残り ${remaining}枠（まもなく上限）`;
    } else {
      capacityDot.classList.add('open');
      capacityBadge.classList.add('open');
      capacityBadge.textContent = `🟢 残り ${remaining}枠 注文受付中`;
    }
  }

  // 混雑・上限・営業時間・臨時休業バナーの更新
  if (currentStoreStatus.isTemporaryClosed) {
    // 臨時休業
    storePausedBanner.style.display = 'block';
    storePausedBanner.style.background = '#fee2e2';
    storePausedBanner.style.borderColor = '#ef4444';
    if (pausedBannerTitle) {
      pausedBannerTitle.style.color = '#991b1b';
      pausedBannerTitle.textContent = '🚨 本日は臨時休業とさせていただきます';
    }
    if (pausedBannerDesc) {
      pausedBannerDesc.style.color = '#7f1d1d';
      pausedBannerDesc.textContent = currentStoreStatus.temporaryClosedReason || '都合により本日は終日お休みをいただいております。ご不便をおかけいたしますが何卒ご理解のほどよろしくお願いいたします。';
    }
    welcomeGuideBox.style.display = 'none';
  } else if (currentStoreStatus.businessHours && !currentStoreStatus.businessHours.isOpen) {
    // 営業時間外・定休日
    const bh = currentStoreStatus.businessHours;
    storePausedBanner.style.display = 'block';
    storePausedBanner.style.background = '#fef3c7';
    storePausedBanner.style.borderColor = '#f59e0b';
    if (pausedBannerTitle) {
      pausedBannerTitle.style.color = '#92400e';
      pausedBannerTitle.textContent = bh.reason === 'CLOSED_DAY' 
        ? '📅 本日（日曜日）は定休日です' 
        : '⏳ 只今の時間は営業時間外です';
    }
    if (pausedBannerDesc) {
      pausedBannerDesc.style.color = '#78350f';
      pausedBannerDesc.innerHTML = `
        ${bh.message}<br>
        <strong>【営業時間】</strong> 昼の部 11:30〜14:30 ／ 夜の部 18:00〜22:00（日曜定休）
      `;
    }
    welcomeGuideBox.style.display = 'none';
  } else if (!currentStoreStatus.isAcceptingOrders) {
    // 手動休止
    storePausedBanner.style.display = 'block';
    storePausedBanner.style.background = '#fef2f2';
    storePausedBanner.style.borderColor = '#f87171';
    if (pausedBannerTitle) {
      pausedBannerTitle.style.color = '#991b1b';
      pausedBannerTitle.textContent = '⚠️ 只今、混雑のため予約受付を一時休止しております';
    }
    if (pausedBannerDesc) {
      pausedBannerDesc.style.color = '#7f1d1d';
      pausedBannerDesc.textContent = currentStoreStatus.pauseReason || '現在店内が混み合っているため、新規のテイクアウト注文を一時ストップしています。再開まで今しばらくお待ちください。';
    }
    welcomeGuideBox.style.display = 'none';
  } else if (isLimitReached) {
    // 同時10件上限到達による自動休止
    storePausedBanner.style.display = 'block';
    storePausedBanner.style.background = '#fef2f2';
    storePausedBanner.style.borderColor = '#f87171';
    if (pausedBannerTitle) {
      pausedBannerTitle.style.color = '#991b1b';
      pausedBannerTitle.textContent = `⚠️ 只今、同時注文上限（${maxConcurrent}件）に達しております`;
    }
    if (pausedBannerDesc) {
      pausedBannerDesc.style.color = '#7f1d1d';
      pausedBannerDesc.textContent = `現在、同時に${maxConcurrent}件のテイクアウト注文を調理・対応中のため、一時的に新規受付をストップしています。調理・お渡しが完了次第、自動的に受付を再開いたします。`;
    }
    welcomeGuideBox.style.display = 'none';
  } else {
    // 通常受付中
    storePausedBanner.style.display = 'none';
    welcomeGuideBox.style.display = 'block';
  }

  renderCurrentMenuList();
  updateCartBar();
}

let lastCategory = 'すべて';

async function fetchMenu() {
  try {
    const res = await fetch('/api/menu');
    menuData = await res.json();
    renderCategories();
    renderMenuList('すべて');
  } catch (err) {
    console.error('Failed to load menu:', err);
  }
}

function renderCategories() {
  const categories = ['すべて', ...new Set(menuData.mainMenu.map(m => m.category))];
  categoryTabs.innerHTML = '';
  categories.forEach((cat, idx) => {
    const btn = document.createElement('button');
    btn.className = `cat-btn ${idx === 0 ? 'active' : ''}`;
    btn.textContent = cat;
    btn.onclick = () => {
      document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      lastCategory = cat;
      renderMenuList(cat);
    };
    categoryTabs.appendChild(btn);
  });
}

function renderCurrentMenuList() {
  renderMenuList(lastCategory);
}

function renderMenuList(selectedCategory) {
  menuListContainer.innerHTML = '';
  const filtered = selectedCategory === 'すべて' 
    ? menuData.mainMenu 
    : menuData.mainMenu.filter(m => m.category === selectedCategory);

  filtered.forEach(item => {
    const isSold = Boolean(item.soldOut);
    const card = document.createElement('div');
    card.className = `menu-card ${isSold ? 'sold-out' : ''}`;

    let btnDisabledAttr = '';
    let btnText = '選択する';

    if (isSold) {
      btnDisabledAttr = 'disabled style="background: #94a3b8; cursor: not-allowed;"';
      btnText = '売切 (SOLD OUT)';
    } else if (currentStoreStatus.isTemporaryClosed) {
      btnDisabledAttr = 'disabled style="background: #94a3b8; cursor: not-allowed;"';
      btnText = '臨時休業';
    } else if (currentStoreStatus.businessHours && !currentStoreStatus.businessHours.isOpen) {
      btnDisabledAttr = 'disabled style="background: #94a3b8; cursor: not-allowed;"';
      btnText = currentStoreStatus.businessHours.reason === 'CLOSED_DAY' ? '定休日' : '時間外';
    } else if (!isAcceptingOrders) {
      btnDisabledAttr = 'disabled style="background: #94a3b8; cursor: not-allowed;"';
      btnText = '休止中';
    }

    card.innerHTML = `
      <div class="menu-info">
        <div class="menu-name">${item.name}</div>
        <div class="menu-desc">${item.description || ''}</div>
        <div class="menu-price">¥${item.price.toLocaleString()} <span style="font-size: 0.78rem; color: #64748b; font-weight: normal;">(+容器代¥${CONTAINER_FEE_PER_BOWL})</span></div>
      </div>
      <button class="add-btn ${isSold ? 'sold-out' : ''}" ${btnDisabledAttr} onclick="openToppingModal('${item.id}')">${btnText}</button>
    `;

    menuListContainer.appendChild(card);
  });
}

// === トッピングカスタマイズモーダル ===
window.openToppingModal = function(itemId) {
  selectedRamen = menuData.mainMenu.find(m => m.id === itemId);
  if (!selectedRamen) return;

  if (selectedRamen.soldOut) {
    alert('申し訳ございません。このメニューは只今売り切れとなっております。');
    return;
  }

  if (!isAcceptingOrders) {
    let msg = '只今ご注文を受け付けておりません。';
    if (currentStoreStatus.isTemporaryClosed) {
      msg = '申し訳ございません。本日は臨時休業とさせていただいております。';
    } else if (currentStoreStatus.businessHours && !currentStoreStatus.businessHours.isOpen) {
      msg = `${currentStoreStatus.businessHours.message}\n営業時間: 昼 11:30〜14:30 / 夜 18:00〜22:00（日曜定休）`;
    } else {
      msg = '只今、混雑のため一時的に予約受付を停止しております。';
    }
    alert(msg);
    return;
  }

  toppingModalTitle.textContent = `${selectedRamen.name} のトッピング選択`;
  const baseDesc = selectedRamen.description ? `${selectedRamen.description} / ` : '';
  toppingModalDesc.textContent = `${baseDesc}テイクアウト容器代 (+¥${CONTAINER_FEE_PER_BOWL}) が加算されます。`;

  freeToppingsContainer.innerHTML = '';
  menuData.toppings.free.forEach(f => {
    const isSold = Boolean(f.soldOut);
    const label = document.createElement('label');
    label.className = `topping-checkbox-label ${isSold ? 'sold-out' : ''}`;
    label.innerHTML = `
      <input type="checkbox" name="free-topping" value="${f.name}" ${isSold ? 'disabled' : ''} onchange="updateToppingSubtotal()">
      <span>${f.name}${isSold ? ' <span class="soldout-tag-text">【売切】</span>' : ''}</span>
    `;
    freeToppingsContainer.appendChild(label);
  });

  paidToppingsContainer.innerHTML = '';
  menuData.toppings.paid.forEach(p => {
    const isSold = Boolean(p.soldOut);
    const label = document.createElement('label');
    label.className = `topping-checkbox-label ${isSold ? 'sold-out' : ''}`;
    label.innerHTML = `
      <input type="checkbox" name="paid-topping" value="${p.id}" data-price="${p.price}" ${isSold ? 'disabled' : ''} onchange="updateToppingSubtotal()">
      <span>${p.name} (+¥${p.price}) ${isSold ? '<span class="soldout-tag-text">【売切】</span>' : ''}</span>
    `;
    paidToppingsContainer.appendChild(label);
  });

  updateToppingSubtotal();
  toppingModal.style.display = 'flex';
};

window.updateToppingSubtotal = function() {
  if (!selectedRamen) return;
  const isFree = Boolean(currentUserStats && currentUserStats.isContainerFree);
  const containerFee = isFree ? 0 : CONTAINER_FEE_PER_BOWL;
  let subtotal = selectedRamen.price + containerFee;

  const checkedPaid = document.querySelectorAll('input[name="paid-topping"]:checked');
  checkedPaid.forEach(input => {
    subtotal += parseInt(input.dataset.price, 10);
    input.closest('.topping-checkbox-label').classList.add('checked');
  });

  document.querySelectorAll('input[name="paid-topping"]:not(:checked)').forEach(input => {
    input.closest('.topping-checkbox-label').classList.remove('checked');
  });

  document.querySelectorAll('input[name="free-topping"]').forEach(input => {
    if (input.checked) {
      input.closest('.topping-checkbox-label').classList.add('checked');
    } else {
      input.closest('.topping-checkbox-label').classList.remove('checked');
    }
  });

  const feeDesc = isFree 
    ? '<span style="color: #16a34a; font-weight: 700; margin-left: 4px;">(月3回特典: 容器代無料)</span>' 
    : '<span style="color: #64748b; font-size: 0.85rem; margin-left: 4px;">(容器代込)</span>';
  toppingModalSubtotal.innerHTML = `¥${subtotal.toLocaleString()} ${feeDesc}`;
};

btnCloseToppingModal.addEventListener('click', () => {
  toppingModal.style.display = 'none';
  selectedRamen = null;
});

btnAddCustomizedItem.addEventListener('click', () => {
  if (!selectedRamen) return;

  const chosenFree = [];
  document.querySelectorAll('input[name="free-topping"]:checked').forEach(cb => {
    chosenFree.push(cb.value);
  });

  const chosenPaid = [];
  let toppingsTotal = 0;
  document.querySelectorAll('input[name="paid-topping"]:checked').forEach(cb => {
    const topItem = menuData.toppings.paid.find(p => p.id === cb.value);
    if (topItem) {
      chosenPaid.push(topItem);
      toppingsTotal += topItem.price;
    }
  });

  const isFree = Boolean(currentUserStats && currentUserStats.isContainerFree);
  const fee = isFree ? 0 : CONTAINER_FEE_PER_BOWL;

  const cartItem = {
    cartUid: Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    id: selectedRamen.id,
    name: selectedRamen.name,
    category: selectedRamen.category,
    price: selectedRamen.price,
    containerFee: fee,
    requiredTickets: [
      ...(selectedRamen.requiredTickets || []),
      ...(fee > 0 ? [{ name: '容器代券', price: fee }] : [])
    ],
    freeToppings: chosenFree,
    paidToppings: chosenPaid,
    itemTotal: selectedRamen.price + fee + toppingsTotal
  };

  cart.push(cartItem);
  toppingModal.style.display = 'none';
  selectedRamen = null;

  updateCartBar();
});

window.removeFromCart = function(cartUid) {
  cart = cart.filter(c => c.cartUid !== cartUid);
  updateCartBar();
  renderModalCart();
};

function saveCartToStorage() {
  try {
    localStorage.setItem('ramen_temp_cart', JSON.stringify(cart));
  } catch (e) {}
}

function loadCartFromStorage() {
  try {
    const saved = localStorage.getItem('ramen_temp_cart');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) {
        cart = parsed;
        updateCartBar();
      }
    }
  } catch (e) {}
}

function updateCartBar() {
  saveCartToStorage();
  if (cart.length === 0 || !isAcceptingOrders) {
    cartBar.style.display = 'none';
    return;
  }
  cartBar.style.display = 'flex';
  const total = cart.reduce((sum, item) => sum + item.itemTotal, 0);
  cartCount.textContent = `${cart.length}杯選択中`;
  cartTotal.textContent = `¥${total.toLocaleString()}`;
}

btnOpenConfirm.addEventListener('click', () => {
  if (!isAcceptingOrders) {
    alert('只今、混雑のため一時的に予約受付を停止しております。');
    return;
  }
  renderModalCart();
  confirmModal.style.display = 'flex';
});

btnCloseModal.addEventListener('click', () => {
  confirmModal.style.display = 'none';
});

// 同一注文内容の判定シグネチャ生成ヘルパー
function getOrderSignature(item) {
  const name = (item.name || item.id || '').trim();
  const free = (item.freeToppings || []).slice().sort().join(',');
  const paidList = item.paidToppings || item.toppings || [];
  const paid = paidList.map(p => (typeof p === 'object' ? (p.name || p.id || '') : p)).sort().join(',');
  return `${name}__FREE:${free}__PAID:${paid}`;
}

// まったく同じ注文内容をまとめるヘルパー
function groupSameItems(items) {
  if (!items || !Array.isArray(items)) return [];
  const map = new Map();

  items.forEach(item => {
    const sig = getOrderSignature(item);
    const qty = Number(item.quantity) || 1;
    if (!map.has(sig)) {
      map.set(sig, {
        ...item,
        quantity: qty,
        cartUids: item.cartUid ? [item.cartUid] : []
      });
    } else {
      const existing = map.get(sig);
      existing.quantity += qty;
      if (item.cartUid) existing.cartUids.push(item.cartUid);
    }
  });

  return Array.from(map.values());
}

// 注文確認モーダルの描画（まったく同じ注文内容は 2× などを頭に付けてまとめる）
function renderModalCart() {
  modalCartItems.innerHTML = '';
  let total = 0;
  let totalSavedContainerFee = 0;
  const isFree = Boolean(currentUserStats && currentUserStats.isContainerFree);

  cart.forEach(item => { 
    total += item.itemTotal; 
    if (isFree) {
      totalSavedContainerFee += CONTAINER_FEE_PER_BOWL;
    }
  });

  const grouped = groupSameItems(cart);

  grouped.forEach((group, index) => {
    const block = document.createElement('div');
    block.className = 'cart-item-block';

    const freeHtml = group.freeToppings && group.freeToppings.length > 0 
      ? `<div class="cart-toppings-free">🟢 無料コール: ${group.freeToppings.join('、 ')}</div>` 
      : '';

    let paidRowsHtml = '';
    if (group.paidToppings && group.paidToppings.length > 0) {
      paidRowsHtml = group.paidToppings.map(p => {
        const pPrice = p.price * group.quantity;
        const prefix = group.quantity >= 2 ? `${group.quantity}× ` : '';
        return `
          <div style="display: flex; justify-content: space-between; color: #b45309; font-weight: 600;">
            <span>・${prefix}${p.name}</span>
            <span>¥${pPrice.toLocaleString()}</span>
          </div>
        `;
      }).join('');
    }

    const headerPrefix = group.quantity >= 2 ? `${group.quantity}× ` : '';
    const groupRamenPrice = group.price * group.quantity;
    const containerTotal = (group.containerFee !== undefined ? group.containerFee : (isFree ? 0 : CONTAINER_FEE_PER_BOWL)) * group.quantity;

    const containerHtml = isFree ? `
      <div style="display: flex; justify-content: space-between; color: #16a34a; font-size: 0.85rem; font-weight: 700; margin-top: 2px;">
        <span>・容器代${group.quantity >= 2 ? ` (${group.quantity}個)` : ''} <span style="background: #dcfce7; color: #15803d; padding: 1px 5px; border-radius: 4px; font-size: 0.75rem;">月3回特典無料</span></span>
        <span>¥0</span>
      </div>
    ` : `
      <div style="display: flex; justify-content: space-between; color: #475569; font-size: 0.85rem; font-weight: 600; margin-top: 2px;">
        <span>・容器代${group.quantity >= 2 ? ` (${group.quantity}個)` : ''}</span>
        <span>¥${containerTotal.toLocaleString()}</span>
      </div>
    `;

    const toppingsDescHtml = `
      <div class="cart-toppings-desc">
        ${containerHtml}
        ${freeHtml}
        ${paidRowsHtml}
      </div>
    `;

    block.innerHTML = `
      <div class="cart-item-header">
        <div>
          <span>${index + 1}. <strong>${headerPrefix}${group.name}</strong></span>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-weight: 700;">¥${groupRamenPrice.toLocaleString()}</span>
          <button onclick="removeFromCart('${group.cartUids[0]}')" style="background: none; border: none; color: #ef4444; font-size: 0.8rem; cursor: pointer;">
            ${group.quantity >= 2 ? '1杯削除' : '削除'}
          </button>
        </div>
      </div>
      ${toppingsDescHtml}
    `;
    modalCartItems.appendChild(block);
  });

  if (modalRewardBanner && modalRewardDiscountText) {
    if (isFree && totalSavedContainerFee > 0) {
      modalRewardBanner.style.display = 'flex';
      modalRewardDiscountText.textContent = `-¥${totalSavedContainerFee.toLocaleString()}`;
    } else {
      modalRewardBanner.style.display = 'none';
    }
  }

  modalTicketTotal.textContent = `¥${total.toLocaleString()}`;
}

// 注文送信ボタン（注文確認モーダル内）
btnSubmitOrder.addEventListener('click', async () => {
  await unlockCustAudio();
  if (!isAcceptingOrders) {
    alert('只今、混雑のため予約受付を停止しております。');
    confirmModal.style.display = 'none';
    return;
  }

  if (cart.length === 0) {
    alert('カートが空です。');
    return;
  }

  const memoVal = modalOrderMemo ? modalOrderMemo.value.trim() : '';

  // 1. メモリにプロファイルがあれば即座に送信
  if (liffProfile) {
    return executeSubmitOrder(cart, memoVal, liffProfile);
  }

  // 2. キャッシュにプロファイルがあれば即座に送信
  const cached = getCachedLineProfile();
  if (cached) {
    liffProfile = cached;
    return executeSubmitOrder(cart, memoVal, liffProfile);
  }

  // 3. LIFF初期化済みでログイン中ならその場で取得して即座に送信
  if (window.liff && liff.isLoggedIn()) {
    try {
      btnSubmitOrder.disabled = true;
      btnSubmitOrder.textContent = 'LINE確認中...';
      const p = await liff.getProfile();
      if (p) {
        liffProfile = p;
        saveLineProfileCache(p);
        return executeSubmitOrder(cart, memoVal, liffProfile);
      }
    } catch (e) {
      console.warn('Profile fetch warning in submit:', e);
    } finally {
      btnSubmitOrder.disabled = false;
      btnSubmitOrder.textContent = 'この内容で予約注文を確定する';
    }
  }

  // 4. LINEアプリ内ブラウザ（isInClient）ならユーザー認証済みとして即送信
  if (window.liff && liff.isInClient && liff.isInClient()) {
    liffProfile = {
      userId: 'U_line_app_' + Date.now().toString(36),
      displayName: 'LINEお客様'
    };
    saveLineProfileCache(liffProfile);
    return executeSubmitOrder(cart, memoVal, liffProfile);
  }

  // 5. 外部ブラウザ未認証時のみポップアップを表示
  if (lineAuthModal) {
    lineAuthModal.style.display = 'flex';
  }
});

// 注文送信処理共通関数（認証後やリダイレクト復帰後の自動確定からも呼び出し可能）
async function executeSubmitOrder(orderCart, memoVal, profile) {
  if (!orderCart || orderCart.length === 0) {
    alert('カートが空です。');
    return;
  }

  if (btnSubmitOrder) {
    btnSubmitOrder.disabled = true;
    btnSubmitOrder.textContent = '注文を送信中...';
  }
  if (btnPopupLineAuth) {
    btnPopupLineAuth.disabled = true;
    btnPopupLineAuth.textContent = '注文を確定中...';
  }

  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: orderCart,
        memo: memoVal || '',
        lineUserId: profile ? profile.userId : null,
        lineUserName: profile ? profile.displayName : null
      })
    });

    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.message || '注文の送信に失敗しました');
    }

    const order = await res.json();
    currentOrderId = order.id;
    try {
      localStorage.setItem('ramen_order_id', order.id);
      sessionStorage.setItem('ramen_order_id', order.id);
      localStorage.removeItem('ramen_temp_cart');
      localStorage.removeItem('ramen_pending_order');
      sessionStorage.removeItem('ramen_pending_order');
    } catch (e) {}

    // 注文送信が成功したらカートと保留データをクリア
    cart = [];
    if (modalOrderMemo) modalOrderMemo.value = '';
    updateCartBar();

    if (confirmModal) confirmModal.style.display = 'none';
    if (lineAuthModal) lineAuthModal.style.display = 'none';

    if (btnSubmitOrder) {
      btnSubmitOrder.disabled = false;
      btnSubmitOrder.textContent = 'この内容で予約注文を確定する';
    }
    if (btnPopupLineAuth) {
      btnPopupLineAuth.disabled = false;
      btnPopupLineAuth.textContent = 'LINEで認証して注文を確定する';
    }

    showOrderStatus(order);
    window.scrollTo(0, 0);
  } catch (err) {
    alert(err.message || '注文に失敗しました。もう一度お試しください。');
    console.error(err);
    if (btnSubmitOrder) {
      btnSubmitOrder.disabled = false;
      btnSubmitOrder.textContent = 'この内容で予約注文を確定する';
    }
    if (btnPopupLineAuth) {
      btnPopupLineAuth.disabled = false;
      btnPopupLineAuth.textContent = 'LINEで認証して注文を確定する';
    }
  }
}

async function checkExistingOrder(id) {
  try {
    const res = await fetch(`/api/orders/${id}`);
    if (res.ok) {
      const order = await res.json();
      if (order.status !== 'COMPLETED' && order.status !== 'CANCELLED') {
        showOrderStatus(order);
      } else {
        localStorage.removeItem('ramen_order_id');
      }
    }
  } catch (err) {
    console.error('Order fetch error:', err);
  }
}

// 注文状況画面の表示（英数3桁番号のみを主役に表示）
function showOrderStatus(order) {
  if (!order) return;
  currentOrder = order;

  // メニュー画面・カートバー・モーダルをすべて確実に非表示にし、受付完了画面を表示
  if (menuListView) menuListView.style.display = 'none';
  if (cartBar) cartBar.style.display = 'none';
  if (confirmModal) confirmModal.style.display = 'none';
  if (lineAuthModal) lineAuthModal.style.display = 'none';
  if (orderStatusView) orderStatusView.style.display = 'block';

  // 英数3桁（#を確実に除去して表示）
  const cleanNum = (order.orderNumber || '').replace(/^[#＃]/, '');
  if (dispOrderNumber) dispOrderNumber.textContent = cleanNum;

  try {
    updateStatusDisplay(order);
  } catch (e) {
    console.warn('Status display update error:', e);
  }

  dispOrderItemsList.innerHTML = '';
  const groupedItems = groupSameItems(order.items);

  groupedItems.forEach((group, idx) => {
    const itemBox = document.createElement('div');
    itemBox.className = 'cust-item-box';

    const freeHtml = group.freeToppings && Array.isArray(group.freeToppings) && group.freeToppings.length > 0
      ? `<div class="cust-free-text">🟢 無料コール: ${group.freeToppings.join('、 ')}</div>`
      : '';

    let paidListHtml = '';
    if (group.paidToppings && Array.isArray(group.paidToppings) && group.paidToppings.length > 0) {
      paidListHtml = group.paidToppings.map(p => {
        const pName = typeof p === 'object' ? p.name : p;
        const pPrice = (typeof p === 'object' ? p.price : 0) * group.quantity;
        const pPrefix = group.quantity >= 2 ? `${group.quantity}× ` : '';
        return `
          <div style="display: flex; justify-content: space-between; color: #b45309; font-weight: 700; margin-top: 2px;">
            <span>・${pPrefix}${pName}</span>
            <span>¥${pPrice.toLocaleString()}</span>
          </div>
        `;
      }).join('');
    }

    const titlePrefix = group.quantity >= 2 ? `${group.quantity}× ` : '';
    const groupRamenPrice = group.price * group.quantity;
    const containerTotal = (group.containerFee || CONTAINER_FEE_PER_BOWL) * group.quantity;

    const containerHtml = `
      <div style="display: flex; justify-content: space-between; color: #475569; font-size: 0.85rem; font-weight: 600; margin-top: 2px;">
        <span>・容器代${group.quantity >= 2 ? ` (${group.quantity}個)` : ''}</span>
        <span>¥${containerTotal.toLocaleString()}</span>
      </div>
    `;

    const toppingsDescHtml = `
      <div class="cust-toppings-desc">
        ${containerHtml}
        ${freeHtml}
        ${paidListHtml}
      </div>
    `;

    itemBox.innerHTML = `
      <div class="cust-item-title">
        <span>🍜 ${idx + 1}. <strong>${titlePrefix}${group.name}</strong></span>
        <span>¥${groupRamenPrice.toLocaleString()}</span>
      </div>
      ${toppingsDescHtml}
    `;
    dispOrderItemsList.appendChild(itemBox);
  });

  const orderMemoText = (order.memo || order.note || '').trim();
  if (orderMemoText) {
    const memoBox = document.createElement('div');
    memoBox.style.cssText = 'background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 8px; padding: 10px 12px; margin-top: 10px; font-size: 0.88rem; color: #334155;';
    memoBox.innerHTML = `📝 <strong>ご要望・メモ:</strong> <span style="word-break: break-all;">${orderMemoText}</span>`;
    dispOrderItemsList.appendChild(memoBox);
  }

  dispTotalAmount.textContent = `¥${order.totalAmount.toLocaleString()}`;
}

function formatLocalTimeHHMM(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return d.toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function getRemainingTimeText(order) {
  if (!order) return '';
  if (!order.targetTimestamp) {
    const mins = order.estimatedMinutes || 10;
    return `残り 約${mins}分`;
  }
  const diffMs = order.targetTimestamp - Date.now();
  const diffMins = Math.ceil(diffMs / 60000);
  if (diffMins > 1) {
    return `残り 約${diffMins}分`;
  } else if (diffMins === 1) {
    return `残り 約1分`;
  } else {
    return `まもなく完成します`;
  }
}

function updateStatusDisplay(order) {
  const statusText = document.getElementById('disp-status-text');
  const statusSub = document.getElementById('disp-status-sub');
  const timeBox = document.getElementById('disp-time-box');
  const timeVal = document.getElementById('disp-estimated-time') || document.getElementById('disp-remaining-time');

  // 完成予定時刻の算出（targetTimestampがある場合は端末のローカル時計で正確に日本時間フォーマット）
  let formattedTime = order.estimatedTime;
  if (order.targetTimestamp) {
    formattedTime = formatLocalTimeHHMM(order.targetTimestamp);
  }
  const remainingText = getRemainingTimeText(order);

  if (order.status === 'COOKING' && (formattedTime || order.targetTimestamp)) {
    timeBox.style.display = 'block';
    if (timeVal) {
      timeVal.innerHTML = `${formattedTime ? `${formattedTime} 頃` : ''} <span style="font-size: 0.95rem; font-weight: normal; color: #15803d; margin-left: 6px;">(${remainingText})</span>`;
    }
  } else {
    timeBox.style.display = 'none';
  }

  switch (order.status) {
    case 'RECEIVED':
      statusText.textContent = '注文送信完了（厨房受付待ち）';
      statusText.style.color = '#d97706';
      statusSub.textContent = '厨房で注文を確認中です。スタッフが受付・調理を開始するまで少々お待ちください。';
      break;
    case 'COOKING':
      statusText.textContent = '🍜 注文受付・調理中';
      statusText.style.color = '#2563eb';
      statusSub.textContent = formattedTime 
        ? `厨房で注文が受け付けられ、調理中です！完成予定時刻（${formattedTime}頃）を目安にご来店ください。`
        : '厨房で注文が受け付けられました！現在スタッフが調理しております。';
      break;
    case 'READY':
      statusText.textContent = '🎉 出来上がりました！';
      statusText.style.color = '#16a34a';
      statusSub.textContent = '店頭にお越しいただき、スタッフにお声がけください！';
      break;
    case 'COMPLETED':
      statusText.textContent = '✨ お渡し完了';
      statusText.style.color = '#64748b';
      statusSub.innerHTML = `
        ご利用ありがとうございました！またのお越しをお待ちしております。<br>
        <button onclick="closeAppWindow()" style="margin-top: 14px; background: #475569; color: #fff; border: none; padding: 10px 32px; border-radius: 8px; font-weight: 700; font-size: 0.95rem; cursor: pointer; box-shadow: 0 2px 6px rgba(0,0,0,0.15); transition: background 0.2s;">
          閉じる
        </button>
      `;
      break;
    case 'CANCELLED':
      statusText.textContent = 'キャンセルされました';
      statusText.style.color = '#dc2626';
      statusSub.textContent = '注文がキャンセルされました。';
      break;
  }
}

socket.on('order:updated', (updatedOrder) => {
  if (currentOrder && currentOrder.id === updatedOrder.id) {
    const prevStatus = currentOrder.status;
    currentOrder = updatedOrder;
    updateStatusDisplay(updatedOrder);

    // 完成（READY）になった瞬間に注文画面でチャイム音を鳴らす
    if (updatedOrder.status === 'READY' && prevStatus !== 'READY') {
      playCustomerReadyChime();
    }
  }
});

socket.on('store:status_changed', (status) => {
  setStoreStatus(status);
});

socket.on('menu:soldout_changed', (data) => {
  const { itemId, soldOut, soldOutIds } = data;
  const soldSet = new Set(soldOutIds || []);

  if (menuData && menuData.mainMenu) {
    menuData.mainMenu.forEach(m => {
      m.soldOut = soldSet.has(m.id);
    });
  }
  if (menuData && menuData.toppings) {
    (menuData.toppings.free || []).forEach(f => {
      f.soldOut = soldSet.has(f.id);
    });
    (menuData.toppings.paid || []).forEach(p => {
      p.soldOut = soldSet.has(p.id);
    });
  }

  renderCurrentMenuList();

  if (selectedRamen) {
    if (selectedRamen.id === itemId && soldOut) {
      toppingModal.style.display = 'none';
      selectedRamen = null;
      alert('選択中だったメニューが売り切れとなったため、画面を更新しました。');
    } else {
      openToppingModal(selectedRamen.id);
    }
  }
});

window.resetToMenu = function() {
  localStorage.removeItem('ramen_order_id');
  currentOrder = null;
  currentOrderId = null;
  location.reload();
};

window.closeAppWindow = function() {
  localStorage.removeItem('ramen_order_id');
  currentOrder = null;
  currentOrderId = null;

  // LINE/LIFF等のアプリ内ブラウザ対応
  if (window.liff && typeof window.liff.closeWindow === 'function') {
    try {
      window.liff.closeWindow();
      return;
    } catch (e) {}
  }

  // タブ・ウィンドウを閉じる試み
  try {
    window.close();
  } catch (e) {}

  // ブラウザのセキュリティ制限で window.close() が動作しなかった場合の終了メッセージ
  setTimeout(() => {
    const statusSub = document.getElementById('disp-status-sub');
    if (statusSub) {
      statusSub.innerHTML = `
        ご利用ありがとうございました！<br>
        <span style="display: inline-block; margin-top: 8px; color: #475569; font-size: 0.9rem; font-weight: bold;">
          ブラウザのタブまたはアプリを閉じて終了してください。
        </span>
      `;
    }
  }, 200);
};

// 調理中オーダーの残り時間を10秒ごとにリアルタイム再計算
setInterval(() => {
  if (currentOrder && currentOrder.status === 'COOKING') {
    updateStatusDisplay(currentOrder);
  }
}, 10000);



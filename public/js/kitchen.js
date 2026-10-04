const socket = io();

let orders = [];
let currentFilter = 'all'; // 'all', 'RECEIVED', 'COOKING', 'READY', 'completed'
let soundEnabled = true;
let searchQuery = '';
let isAcceptingOrders = true;
const pendingMinutes = {}; // 受付前の時間調整保持用 (orderId -> 分数)

const ordersGrid = document.getElementById('kitchen-orders-grid');
const badgeCapacity = document.getElementById('badge-capacity');
const badgeReceived = document.getElementById('badge-received');
const badgeCooking = document.getElementById('badge-cooking');
const badgeReady = document.getElementById('badge-ready');
const soldoutChipsContainer = document.getElementById('soldout-chips-container');
const soldoutStatusSummary = document.getElementById('soldout-status-summary');
const btnSoundToggle = document.getElementById('btn-sound-toggle');
const inputSearch = document.getElementById('input-search-order');
const btnToggleAccepting = document.getElementById('btn-toggle-accepting');
const btnToggleTempClosed = document.getElementById('btn-toggle-temp-closed');
const badgeBusinessHours = document.getElementById('badge-business-hours');

let menuData = { mainMenu: [], toppings: { free: [], paid: [] } };
let soldOutIds = new Set();

let storeStatus = {
  isAcceptingOrders: true,
  activeCount: 0,
  maxConcurrent: 10,
  isLimitReached: false
};

// Web Audio API での着信チャイム音
let audioCtx = null;
function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
}

function playNotificationSound() {
  if (!soundEnabled) return;
  try {
    initAudio();
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    const now = audioCtx.currentTime;
    const osc1 = audioCtx.createOscillator();
    const gain1 = audioCtx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(740, now);
    gain1.gain.setValueAtTime(0.3, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    osc1.connect(gain1);
    gain1.connect(audioCtx.destination);
    osc1.start(now);
    osc1.stop(now + 0.6);

    const osc2 = audioCtx.createOscillator();
    const gain2 = audioCtx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(987.77, now + 0.2);
    gain2.gain.setValueAtTime(0.3, now + 0.2);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 1.0);
    osc2.connect(gain2);
    gain2.connect(audioCtx.destination);
    osc2.start(now + 0.2);
    osc2.stop(now + 1.0);
  } catch (err) {
    console.error('Audio play error:', err);
  }
}

window.addEventListener('click', initAudio, { once: true });

btnSoundToggle.addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  if (soundEnabled) {
    btnSoundToggle.textContent = '音声: ON';
    btnSoundToggle.style.color = '#38bdf8';
    playNotificationSound();
  } else {
    btnSoundToggle.textContent = '音声: OFF';
    btnSoundToggle.style.color = '#94a3b8';
  }
});

btnToggleAccepting.addEventListener('click', async () => {
  const nextStatus = !isAcceptingOrders;
  try {
    const res = await fetch('/api/store-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accepting: nextStatus })
    });
    if (res.ok) {
      const data = await res.json();
      updateAcceptingButton(data);
    }
  } catch (err) {
    console.error('Failed to update store status:', err);
  }
});

if (btnToggleTempClosed) {
  btnToggleTempClosed.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/store-status/toggle-temporary-closed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      if (res.ok) {
        const data = await res.json();
        updateAcceptingButton(data);
      }
    } catch (err) {
      console.error('Failed to toggle temporary closed:', err);
    }
  });
}

function updateAcceptingButton(statusData) {
  if (typeof statusData === 'boolean') {
    storeStatus.isAcceptingOrders = statusData;
  } else if (statusData && typeof statusData === 'object') {
    storeStatus = { ...storeStatus, ...statusData };
  }
  isAcceptingOrders = storeStatus.isAcceptingOrders;

  // 1. 臨時休業ボタンの表示
  if (btnToggleTempClosed) {
    if (storeStatus.isTemporaryClosed) {
      btnToggleTempClosed.style.background = '#dc2626';
      btnToggleTempClosed.style.color = '#ffffff';
      btnToggleTempClosed.style.borderColor = '#ef4444';
      btnToggleTempClosed.style.fontWeight = '900';
      btnToggleTempClosed.textContent = '臨時休業: ON (タップで解除)';
    } else {
      btnToggleTempClosed.style.background = '#1e293b';
      btnToggleTempClosed.style.color = '#94a3b8';
      btnToggleTempClosed.style.borderColor = '#475569';
      btnToggleTempClosed.style.fontWeight = 'normal';
      btnToggleTempClosed.textContent = '臨時休業: OFF (タップで休業)';
    }
  }

  // 2. 営業時間バッジの更新
  if (badgeBusinessHours) {
    const bh = storeStatus.businessHours;
    if (storeStatus.isTemporaryClosed) {
      badgeBusinessHours.style.background = '#dc2626';
      badgeBusinessHours.style.color = '#fff';
      badgeBusinessHours.textContent = '臨時休業中';
    } else if (bh && bh.isOpen) {
      badgeBusinessHours.style.background = '#166534';
      badgeBusinessHours.style.color = '#bbf7d0';
      badgeBusinessHours.textContent = '営業中 (受付可能)';
    } else {
      badgeBusinessHours.style.background = '#334155';
      badgeBusinessHours.style.color = '#94a3b8';
      badgeBusinessHours.textContent = '受付停止中';
    }
  }

  // 3. 受付中 / 混雑休止ボタンの更新
  if (storeStatus.isTemporaryClosed) {
    btnToggleAccepting.className = 'btn-store-status paused';
    btnToggleAccepting.textContent = '臨時休業中 (受付停止)';
  } else if (!storeStatus.isAcceptingOrders) {
    btnToggleAccepting.className = 'btn-store-status paused';
    btnToggleAccepting.textContent = '手動休止中 (タップで受付再開)';
  } else if (storeStatus.isLimitReached) {
    btnToggleAccepting.className = 'btn-store-status paused';
    btnToggleAccepting.textContent = `同時上限(${storeStatus.maxConcurrent || 10}件)到達 (停止中)`;
  } else {
    btnToggleAccepting.className = 'btn-store-status accepting';
    btnToggleAccepting.textContent = '注文受付中 (タップで休止)';
  }
}

inputSearch.addEventListener('input', (e) => {
  searchQuery = e.target.value.trim().toLowerCase();
  renderOrders();
});

// 1分刻みの残り時間をリアルタイムに更新（10秒ごとに再計算・再描画）
setInterval(() => {
  renderOrders();
}, 10000);

window.addEventListener('DOMContentLoaded', async () => {
  await fetchStoreStatus();
  await fetchOrders();
  await fetchMenu();
});

async function fetchStoreStatus() {
  try {
    const res = await fetch('/api/store-status');
    const data = await res.json();
    updateAcceptingButton(data);
  } catch (err) {
    console.error('Failed to load store status:', err);
  }
}

async function fetchOrders() {
  try {
    const res = await fetch('/api/orders');
    orders = await res.json();
    renderOrders();
  } catch (err) {
    console.error('Failed to fetch orders:', err);
  }
}

async function fetchMenu() {
  try {
    const res = await fetch('/api/menu');
    menuData = await res.json();
    soldOutIds = new Set(menuData.soldOutIds || []);
    renderSoldOutChips();
  } catch (err) {
    console.error('Failed to fetch menu:', err);
  }
}

function renderSoldOutChips() {
  if (!soldoutChipsContainer) return;
  soldoutChipsContainer.innerHTML = '';

  const porkIds = (menuData.mainMenu || []).filter(m => m.name.includes('ブタ')).map(m => m.id);
  const isPorkOut = porkIds.length > 0 && porkIds.every(id => soldOutIds.has(id));

  let totalSoldOutCount = 0;
  if (isPorkOut) totalSoldOutCount += porkIds.length;

  // 1. 🐷 ブタ終了（豚切れ）ボタン（ラーメン・汁なしのブタ系メニューを一括で売り切れ・販売中切替）
  const porkGroup = document.createElement('div');
  porkGroup.style.display = 'inline-flex';
  porkGroup.style.alignItems = 'center';
  porkGroup.style.gap = '6px';
  porkGroup.style.marginRight = '14px';
  porkGroup.style.marginBottom = '4px';

  const porkBtn = document.createElement('button');
  porkBtn.type = 'button';
  porkBtn.className = `btn-pork-toggle ${isPorkOut ? 'is-sold-out' : ''}`;
  porkBtn.title = 'タップでブタ入りメニュー全6品（ラーメン・汁なし）を一括で売り切れ/販売中に切り替えます';
  porkBtn.innerHTML = `
    <span>${isPorkOut ? 'ブタ終了中（全品売切）' : 'ブタ入りメニュー：通常販売'}</span>
    <span class="pork-badge">${isPorkOut ? '売切' : 'タップでブタ終了'}</span>
  `;
  porkBtn.onclick = () => togglePorkSoldOut();
  porkGroup.appendChild(porkBtn);
  soldoutChipsContainer.appendChild(porkGroup);

  // 2. 有料トッピング（8品）個別トグル（無料トッピングは品切れ除外）
  const paidToppings = (menuData.toppings && menuData.toppings.paid) || [];
  if (paidToppings.length > 0) {
    const paidGroup = document.createElement('div');
    paidGroup.style.display = 'inline-flex';
    paidGroup.style.alignItems = 'center';
    paidGroup.style.gap = '4px';
    paidGroup.style.marginBottom = '4px';
    paidGroup.style.flexWrap = 'wrap';

    const lbl = document.createElement('span');
    lbl.className = 'soldout-group-label';
    lbl.textContent = '有料トッピング';
    paidGroup.appendChild(lbl);

    paidToppings.forEach(item => {
      const isSold = soldOutIds.has(item.id);
      if (isSold) totalSoldOutCount++;

      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `soldout-chip ${isSold ? 'is-sold-out' : ''}`;
      chip.title = `${item.name} をタップして売り切れ/販売中を切替`;
      chip.innerHTML = `
        <span>${item.name}</span>
        <span class="chip-status">${isSold ? '売切' : '販売中'}</span>
      `;
      chip.onclick = () => toggleSoldOut(item.id);
      paidGroup.appendChild(chip);
    });

    soldoutChipsContainer.appendChild(paidGroup);
  }

  // ステータスサマリーの更新
  if (soldoutStatusSummary) {
    if (isPorkOut) {
      soldoutStatusSummary.innerHTML = `<span style="background: #dc2626; color: #fff; padding: 2px 8px; border-radius: 4px; font-weight: 800;">ブタ終了中</span> ${totalSoldOutCount > 6 ? `<span style="color: #fbbf24; font-size: 0.75rem;">(+トッピング${totalSoldOutCount - 6}品売切)</span>` : ''}`;
    } else if (totalSoldOutCount > 0) {
      soldoutStatusSummary.innerHTML = `<span style="background: #eab308; color: #78350f; padding: 2px 8px; border-radius: 4px; font-weight: 800;">トッピング ${totalSoldOutCount}品 売り切れ中</span>`;
    } else {
      soldoutStatusSummary.innerHTML = `<span style="color: #4ade80; font-weight: 700;">全品 通常販売中</span>`;
    }
  }
}

window.togglePorkSoldOut = async function() {
  const porkIds = (menuData.mainMenu || []).filter(m => m.name.includes('ブタ')).map(m => m.id);
  const currentlyOut = porkIds.length > 0 && porkIds.every(id => soldOutIds.has(id));
  const nextState = !currentlyOut;

  porkIds.forEach(id => {
    if (nextState) soldOutIds.add(id); else soldOutIds.delete(id);
  });
  renderSoldOutChips();

  try {
    const res = await fetch('/api/menu/toggle-pork-soldout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ soldOut: nextState })
    });
    if (res.ok) {
      const data = await res.json();
      soldOutIds = new Set(data.soldOutIds || []);
      renderSoldOutChips();
    }
  } catch (err) {
    console.error('Failed to toggle pork soldout:', err);
    await fetchMenu();
  }
};

window.toggleSoldOut = async function(itemId) {
  const willSoldOut = !soldOutIds.has(itemId);
  if (willSoldOut) {
    soldOutIds.add(itemId);
  } else {
    soldOutIds.delete(itemId);
  }
  renderSoldOutChips();

  try {
    const res = await fetch('/api/menu/toggle-soldout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId, soldOut: willSoldOut })
    });
    if (res.ok) {
      const data = await res.json();
      soldOutIds = new Set(data.soldOutIds || []);
      renderSoldOutChips();
    }
  } catch (err) {
    console.error('Failed to toggle sold out:', err);
    await fetchMenu();
  }
};

window.setFilter = function(filter) {
  currentFilter = filter;
  document.querySelectorAll('.kds-tab-btn').forEach(btn => btn.classList.remove('active'));
  
  if (filter === 'all') document.getElementById('tab-all').classList.add('active');
  if (filter === 'RECEIVED') document.getElementById('tab-received').classList.add('active');
  if (filter === 'COOKING') document.getElementById('tab-cooking').classList.add('active');
  if (filter === 'READY') document.getElementById('tab-ready').classList.add('active');
  if (filter === 'completed') document.getElementById('tab-completed').classList.add('active');

  renderOrders();
};

// 同一注文内容の判定ヘルパー
function getOrderSignature(item) {
  const name = (item.name || item.id || '').trim();
  const free = (item.freeToppings || []).slice().sort().join(',');
  const paidList = item.paidToppings || item.toppings || [];
  const paid = paidList.map(p => (typeof p === 'object' ? (p.name || p.id || '') : p)).sort().join(',');
  return `${name}__FREE:${free}__PAID:${paid}`;
}

function groupSameItems(items) {
  if (!items || !Array.isArray(items)) return [];
  const map = new Map();

  items.forEach(item => {
    const sig = getOrderSignature(item);
    const qty = Number(item.quantity) || 1;
    if (!map.has(sig)) {
      map.set(sig, {
        ...item,
        quantity: qty
      });
    } else {
      const existing = map.get(sig);
      existing.quantity += qty;
    }
  });

  return Array.from(map.values());
}

function renderOrders() {
  ordersGrid.innerHTML = '';

  const receivedCount = orders.filter(o => o.status === 'RECEIVED').length;
  const cookingCount = orders.filter(o => o.status === 'COOKING').length;
  const readyCount = orders.filter(o => o.status === 'READY').length;

  badgeReceived.textContent = `未対応: ${receivedCount}件`;
  badgeCooking.textContent = `調理中: ${cookingCount}件`;
  badgeReady.textContent = `受取待ち: ${readyCount}件`;

  const activeOrders = orders.filter(o => o.status !== 'COMPLETED' && o.status !== 'CANCELLED');
  const activeCount = activeOrders.length;
  if (badgeCapacity) {
    badgeCapacity.textContent = `進行中: ${activeCount} / 10件`;
    if (activeCount >= 10) {
      badgeCapacity.classList.add('full');
    } else {
      badgeCapacity.classList.remove('full');
    }
  }

  let displayOrders = [];
  if (currentFilter === 'all') {
    displayOrders = activeOrders;
  } else if (currentFilter === 'completed') {
    displayOrders = orders.filter(o => o.status === 'COMPLETED' || o.status === 'CANCELLED');
  } else {
    displayOrders = orders.filter(o => o.status === currentFilter);
  }

  displayOrders.sort((a, b) => {
    const statusPriority = { 'RECEIVED': 1, 'COOKING': 2, 'READY': 3, 'COMPLETED': 4, 'CANCELLED': 5 };
    const pDiff = (statusPriority[a.status] || 99) - (statusPriority[b.status] || 99);
    if (pDiff !== 0) return pDiff;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

  if (displayOrders.length === 0) {
    ordersGrid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 60px 20px; color: #64748b; font-size: 1.1rem;">
        該当する注文はありません
      </div>
    `;
    return;
  }

  displayOrders.forEach(order => {
    const card = document.createElement('div');

    const orderTime = new Date(order.createdAt);
    const timeStr = `${String(orderTime.getHours()).padStart(2, '0')}:${String(orderTime.getMinutes()).padStart(2, '0')}`;
    const elapsedMinutes = Math.floor((Date.now() - orderTime.getTime()) / 60000);

    let timeClass = '';
    let badgeClass = 'badge-normal';
    if (order.status !== 'COMPLETED' && order.status !== 'CANCELLED') {
      if (elapsedMinutes >= 10) {
        timeClass = 'time-danger';
        badgeClass = 'badge-danger';
      } else if (elapsedMinutes >= 5) {
        timeClass = 'time-warning';
        badgeClass = 'badge-warning';
      }
    }

    const isSearchMatch = searchQuery && order.orderNumber.toLowerCase().includes(searchQuery);

    card.className = `kds-card status-${order.status} ${timeClass} ${isSearchMatch ? 'searched-highlight' : ''}`;
    card.id = `order-card-${order.id}`;

    // 各ラーメンごとの調理情報ボックス（まったく同じ注文内容は 2× などを頭に付けてまとめる）
    const groupedItems = groupSameItems(order.items);
    const itemsHtml = groupedItems.map((item, idx) => {
      const freeToppings = item.freeToppings && Array.isArray(item.freeToppings) && item.freeToppings.length > 0
        ? item.freeToppings.join('、 ')
        : null;

      const paidToppings = item.paidToppings && Array.isArray(item.paidToppings) && item.paidToppings.length > 0
        ? item.paidToppings.map(p => {
            const pName = typeof p === 'object' ? p.name : p;
            return item.quantity >= 2 ? `${item.quantity}× ${pName}` : pName;
          }).join('、 ')
        : null;

      const prefix = item.quantity >= 2 
        ? `<span style="background: #eab308; color: #000; font-size: 0.95rem; font-weight: 900; padding: 2px 6px; border-radius: 4px; margin-right: 4px;">${item.quantity}×</span>` 
        : '';

      const freeRowHtml = freeToppings
        ? `
          <div class="kds-topping-row">
            <span class="tag-badge-free">無料コール</span>
            <span class="topping-names-free">${freeToppings}</span>
          </div>
        `
        : '';

      const paidRowHtml = paidToppings
        ? `
          <div class="kds-topping-row">
            <span class="tag-badge-paid">トッピング</span>
            <span class="topping-names-paid">${paidToppings}</span>
          </div>
        `
        : '';

      const toppingsWrapHtml = (freeRowHtml || paidRowHtml)
        ? `
          <div class="kds-toppings-wrap">
            ${freeRowHtml}
            ${paidRowHtml}
          </div>
        `
        : '';

      return `
        <div class="kds-item-box ${item.quantity >= 2 ? 'multi-qty' : ''}" style="${item.quantity >= 2 ? 'border-left: 4px solid #eab308; background: rgba(234, 179, 8, 0.05);' : ''}">
          <div class="kds-item-header-row">
            <span style="${item.quantity >= 2 ? 'font-size: 1.05rem; font-weight: 800;' : ''}">${idx + 1}. ${prefix}<strong>${item.name}</strong></span>
          </div>
          ${toppingsWrapHtml}
        </div>
      `;
    }).join('');

    function getRemainingMinutes(o) {
      if (!o || !o.targetTimestamp) return o.estimatedMinutes || 10;
      const diffMs = o.targetTimestamp - Date.now();
      return Math.max(0, Math.ceil(diffMs / 60000));
    }

    const remMins = getRemainingMinutes(order);
    const stagedMins = pendingMinutes[order.id] !== undefined ? pendingMinutes[order.id] : 10;

    let statusLabel = '未対応';
    let statusBg = '#ef4444';
    if (order.status === 'COOKING') {
      statusLabel = remMins > 0 ? `調理中 (残り約${remMins}分)` : `調理中 (まもなく完成)`;
      statusBg = '#3b82f6';
    } else if (order.status === 'READY') {
      statusLabel = '受取待ち';
      statusBg = '#10b981';
    } else if (order.status === 'COMPLETED') {
      statusLabel = '完了';
      statusBg = '#64748b';
    }

    const cleanOrderNum = (order.orderNumber || '').replace(/^[#＃]/, '');
    card.innerHTML = `
      <div class="kds-card-head">
        <div>
          <span class="kds-order-num">${cleanOrderNum}</span>
          <span style="background: ${statusBg}; color: white; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: bold; margin-left: 6px;">
            ${statusLabel}
          </span>
        </div>
        <div class="kds-time-badge ${badgeClass}">
          ${timeStr} (${elapsedMinutes}分経過)
        </div>
      </div>

      <div class="kds-card-body">
        <!-- お名前行を廃止し、合計金額と杯数をスマートに表示 -->
        <div class="kds-customer-name">
          <span class="kds-total-badge">合計お会計: ¥${order.totalAmount.toLocaleString()}</span>
          <span style="font-size: 0.95rem; color: #94a3b8; font-weight: 700;">計 ${order.items.length}杯</span>
        </div>

        ${(order.memo || order.note) ? `
          <div style="background: #fef3c7; border: 2px solid #f59e0b; border-left: 6px solid #d97706; color: #78350f; padding: 8px 12px; border-radius: 8px; margin: 10px 0; font-size: 0.95rem; font-weight: 800; word-break: break-all; box-shadow: 0 2px 6px rgba(245, 158, 11, 0.2);">
            <div style="display: flex; align-items: center; gap: 6px; font-size: 0.8rem; color: #b45309; margin-bottom: 2px;">
              <span>お客様メモ:</span>
            </div>
            <div style="font-size: 1.05rem; color: #1e293b; font-weight: 900; line-height: 1.4;">
              ${(order.memo || order.note)}
            </div>
          </div>
        ` : ''}

        <!-- 調理品目・トッピング一覧 -->
        <div>
          ${itemsHtml}
        </div>

        ${order.status === 'RECEIVED' ? `
          <!-- 受付前：目安時間の事前調整（押しても注文確定せず、ボタンに時間を反映） -->
          <div class="kds-quick-time">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
              <span class="kds-quick-time-label" style="margin: 0;">目安時間の事前調整（標準10分後に完成）:</span>
              ${stagedMins !== 10 ? `
                <button onclick="resetStagedMinutes('${order.id}')" style="background: none; border: none; color: #38bdf8; font-size: 0.75rem; text-decoration: underline; cursor: pointer;">
                  10分に戻す
                </button>
              ` : ''}
            </div>
            
            <div class="time-btn-group">
              <button class="time-btn btn-minus-time" onclick="stageEstimatedMinutes('${order.id}', -5)">－５分</button>
              <button class="time-btn btn-minus-time" onclick="stageEstimatedMinutes('${order.id}', -1)">－１分</button>
              <button class="time-btn btn-add-time" onclick="stageEstimatedMinutes('${order.id}', 1)">＋１分</button>
              <button class="time-btn btn-add-time" onclick="stageEstimatedMinutes('${order.id}', 5)">＋５分</button>
            </div>

            <div style="margin-top: 5px; font-size: 0.82rem; color: ${stagedMins !== 10 ? '#38bdf8' : '#94a3b8'}; text-align: center; font-weight: ${stagedMins !== 10 ? '700' : 'normal'};">
              ${stagedMins !== 10 
                ? `目安時間を「${stagedMins}分後に完成」に変更中（下のボタンで確定）` 
                : '※下のボタンを押すと「10分後に完成」として調理開始します'}
            </div>
          </div>
        ` : ''}

        ${order.status === 'COOKING' ? `
          <!-- 調理中：目安時間のリアルタイム調整 -->
          <div class="kds-quick-time">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
              <span class="kds-quick-time-label" style="margin: 0;">目安時間の調整:</span>
              ${order.targetTimestamp ? `
                <button onclick="resetEstimatedTime('${order.id}')" style="background: none; border: none; color: #94a3b8; font-size: 0.75rem; text-decoration: underline; cursor: pointer;">
                  取消
                </button>
              ` : ''}
            </div>
            
            <div class="time-btn-group">
              <button class="time-btn btn-minus-time" onclick="addEstimatedTime('${order.id}', -5)">－５分</button>
              <button class="time-btn btn-minus-time" onclick="addEstimatedTime('${order.id}', -1)">－１分</button>
              <button class="time-btn btn-add-time" onclick="addEstimatedTime('${order.id}', 1)">＋１分</button>
              <button class="time-btn btn-add-time" onclick="addEstimatedTime('${order.id}', 5)">＋５分</button>
            </div>

            <div style="margin-top: 6px; font-size: 0.9rem; color: #38bdf8; font-weight: bold; text-align: center; background: #1e293b; padding: 6px; border-radius: 6px;">
              お渡し目安: <span style="font-size: 1.15rem; color: #4ade80;">残り 約${remMins}分</span>
            </div>
          </div>
        ` : ''}
      </div>

      ${order.status !== 'COMPLETED' ? `
        <div class="kds-actions">
          ${order.status === 'RECEIVED' ? `
            <button class="kds-btn kds-btn-accept" onclick="acceptOrder('${order.id}', ${stagedMins})" style="${stagedMins !== 10 ? 'background: #2563eb; box-shadow: 0 0 12px rgba(37,99,235,0.6);' : ''}">
              注文を受ける（${stagedMins}分後に完成）
            </button>
          ` : ''}

          ${order.status === 'COOKING' ? `
            <button class="kds-btn kds-btn-ready" onclick="updateStatus('${order.id}', 'READY')">
              出来上がり（呼出）
            </button>
          ` : ''}

          ${order.status === 'READY' ? `
            <button class="kds-btn kds-btn-complete" onclick="updateStatus('${order.id}', 'COMPLETED')">
              お渡し完了
            </button>
          ` : ''}
        </div>
      ` : ''}
    `;

    ordersGrid.appendChild(card);
  });
}

window.stageEstimatedMinutes = function(orderId, delta) {
  const current = pendingMinutes[orderId] !== undefined ? pendingMinutes[orderId] : 10;
  pendingMinutes[orderId] = Math.max(1, current + delta);
  renderOrders();
};

window.resetStagedMinutes = function(orderId) {
  delete pendingMinutes[orderId];
  renderOrders();
};

window.acceptOrder = async function(orderId, mins) {
  try {
    const res = await fetch(`/api/orders/${orderId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'COOKING',
        estimatedMinutes: mins || 10
      })
    });
    if (res.ok) {
      delete pendingMinutes[orderId];
      const updated = await res.json();
      updateLocalOrder(updated);
    }
  } catch (err) {
    console.error('Accept order error:', err);
  }
};

window.addEstimatedTime = async function(orderId, addMins) {
  try {
    const res = await fetch(`/api/orders/${orderId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addMinutes: addMins })
    });
    if (res.ok) {
      const updated = await res.json();
      updateLocalOrder(updated);
    }
  } catch (err) {
    console.error('Time add error:', err);
  }
};

window.resetEstimatedTime = async function(orderId) {
  try {
    const res = await fetch(`/api/orders/${orderId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resetTime: true })
    });
    if (res.ok) {
      const updated = await res.json();
      updateLocalOrder(updated);
    }
  } catch (err) {
    console.error('Time reset error:', err);
  }
};

window.updateStatus = async function(orderId, status) {
  try {
    const res = await fetch(`/api/orders/${orderId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    if (res.ok) {
      const updated = await res.json();
      updateLocalOrder(updated);
    }
  } catch (err) {
    console.error('Status update error:', err);
  }
};

function updateLocalOrder(updated) {
  const idx = orders.findIndex(o => o.id === updated.id);
  if (idx !== -1) {
    orders[idx] = updated;
  } else {
    orders.push(updated);
  }
  renderOrders();
}

socket.on('order:created', (newOrder) => {
  orders.push(newOrder);
  renderOrders();
  playNotificationSound();
});

socket.on('order:updated', (updatedOrder) => {
  updateLocalOrder(updatedOrder);
});

socket.on('orders:reset', () => {
  orders = [];
  renderOrders();
});

socket.on('store:status_changed', (status) => {
  updateAcceptingButton(status);
});

socket.on('menu:soldout_changed', (data) => {
  soldOutIds = new Set(data.soldOutIds || []);
  renderSoldOutChips();
});

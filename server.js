const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

app.use(express.json());

// ブラウザによる古いJSキャッシュを防止し、常に最新の画面を表示
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));

// メニューデータの読み込み
const menuPath = path.join(__dirname, 'data', 'menu.json');
let menuData = { mainMenu: [], toppings: { free: [], paid: [] } };
let soldOutIds = new Set(); // 売り切れ中のメニューID一覧

function loadMenu() {
  try {
    menuData = JSON.parse(fs.readFileSync(menuPath, 'utf-8'));
  } catch (err) {
    console.error('Failed to load menu data:', err);
  }
}
loadMenu();

function getPorkMenuIds() {
  if (!menuData.mainMenu || menuData.mainMenu.length === 0) loadMenu();
  return (menuData.mainMenu || []).filter(m => m.name.includes('ブタ')).map(m => m.id);
}

function isPorkSoldOut() {
  const porkIds = getPorkMenuIds();
  return porkIds.length > 0 && porkIds.every(id => soldOutIds.has(id));
}

// いたずら防止用ブラックリスト管理
const BLACKLIST_FILE = path.join(__dirname, 'data', 'blacklist.json');
let blacklist = [];

function loadBlacklist() {
  try {
    if (fs.existsSync(BLACKLIST_FILE)) {
      blacklist = JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('Failed to load blacklist:', err);
    blacklist = [];
  }
}
loadBlacklist();

function saveBlacklist() {
  try {
    const dir = path.dirname(BLACKLIST_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(blacklist, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save blacklist:', err);
  }
}

function isBlacklisted(userId) {
  if (!userId) return false;
  return blacklist.some(b => b.userId === userId);
}

function addToBlacklist(userId, userName) {
  if (!userId) return;
  if (!isBlacklisted(userId)) {
    blacklist.push({
      userId,
      userName: userName || '不明',
      blockedAt: new Date().toISOString()
    });
    saveBlacklist();
  }
}

function getMenuWithSoldOut() {
  const applySoldOut = (item) => ({
    ...item,
    soldOut: soldOutIds.has(item.id)
  });

  return {
    mainMenu: menuData.mainMenu.map(applySoldOut),
    toppings: {
      free: (menuData.toppings.free || []).map(applySoldOut),
      paid: (menuData.toppings.paid || []).map(applySoldOut)
    },
    soldOutIds: Array.from(soldOutIds),
    isPorkSoldOut: isPorkSoldOut()
  };
}

// 注文管理データ & 店舗受付ステータス永続化
const MAX_CONCURRENT_ORDERS = 10; // 同時に受けられる最大注文数
const ordersPath = path.join(__dirname, 'data', 'orders.json');
let orders = [];

function loadOrders() {
  try {
    if (fs.existsSync(ordersPath)) {
      orders = JSON.parse(fs.readFileSync(ordersPath, 'utf-8'));
    }
  } catch (err) {
    console.error('Failed to load orders.json:', err);
    orders = [];
  }
}
loadOrders();

function saveOrders() {
  try {
    const dir = path.dirname(ordersPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // 直近500件まで保持
    const trimmed = orders.slice(0, 500);
    fs.writeFileSync(ordersPath, JSON.stringify(trimmed, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save orders.json:', err);
  }
}

// LINEユーザーの過去注文回数（キャンセルを除く有効な注文）を集計
function getUserOrderHistory(userId) {
  if (!userId) {
    return {
      totalCount: 0,
      monthlyCount: 0,
      isContainerFree: false,
      remainingForFree: 2
    };
  }

  const oneMonthAgo = Date.now() - (30 * 24 * 60 * 60 * 1000); // 直近30日間
  const userValidOrders = orders.filter(o => 
    o.lineUserId === userId && 
    o.status !== 'CANCELLED'
  );

  const totalCount = userValidOrders.length;
  const monthlyOrders = userValidOrders.filter(o => {
    const t = new Date(o.createdAt).getTime();
    return !isNaN(t) && t >= oneMonthAgo;
  });
  const monthlyCount = monthlyOrders.length;

  // 「1か月に3回以上注文すると容器代を無料にする」
  // 過去30日に2回以上注文があれば、今回の注文は3回目（またはそれ以上）になるので無料！
  const isContainerFree = (monthlyCount >= 2);
  const remainingForFree = Math.max(0, 2 - monthlyCount);

  return {
    totalCount,
    monthlyCount,
    isContainerFree,
    remainingForFree
  };
}

const storeStatusPath = path.join(__dirname, 'data', 'store_status.json');
let storeConfig = {
  isAcceptingOrders: true,
  pauseReason: '店内混雑のため',
  isTemporaryClosed: false,
  temporaryClosedReason: '本日臨時休業',
  forceOpenForTesting: false
};

function loadStoreConfig() {
  try {
    if (fs.existsSync(storeStatusPath)) {
      const data = JSON.parse(fs.readFileSync(storeStatusPath, 'utf-8'));
      storeConfig = { ...storeConfig, ...data };
    }
  } catch (err) {
    console.error('Failed to load store_status.json:', err);
  }
}
loadStoreConfig();

function saveStoreConfig() {
  try {
    fs.writeFileSync(storeStatusPath, JSON.stringify(storeConfig, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save store_status.json:', err);
  }
}

// 営業時間判定（定休日・休業時間の制限を解除中：常時受付可能）
function checkBusinessHours() {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const jstDate = new Date(utc + (3600000 * 9));

  const day = jstDate.getDay(); // 0: 日曜, 1: 月曜, ..., 6: 土曜
  const hours = jstDate.getHours();
  const minutes = jstDate.getMinutes();

  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  const currentDayName = dayNames[day];
  const currentTimeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;

  // 定休日・休業時間を解除し、常時注文受付を許可
  return {
    isOpen: true,
    period: '受付中',
    businessHoursText: '営業時間: 昼 11:30〜14:30 / 夜 18:00〜22:00（日曜定休）',
    currentDay: currentDayName,
    currentTime: currentTimeStr
  };
}

function getActiveOrders() {
  return orders.filter(o => o.status !== 'COMPLETED' && o.status !== 'CANCELLED');
}

function getStoreStatus() {
  const activeCount = getActiveOrders().length;
  const isLimitReached = activeCount >= MAX_CONCURRENT_ORDERS;
  const bh = checkBusinessHours();

  // 注文を受け付けられる条件:
  // 1. 臨時休業でない
  // 2. 営業時間内である（日曜でなく、昼または夜の部、あるいはテスト強制営業中）
  // 3. 手動休止中でない
  // 4. 同時10件上限に達していない
  const canAccept = !storeConfig.isTemporaryClosed && bh.isOpen && storeConfig.isAcceptingOrders && !isLimitReached;

  return {
    isAcceptingOrders: storeConfig.isAcceptingOrders,
    pauseReason: storeConfig.pauseReason,
    isTemporaryClosed: storeConfig.isTemporaryClosed,
    temporaryClosedReason: storeConfig.temporaryClosedReason,
    forceOpenForTesting: Boolean(storeConfig.forceOpenForTesting),
    businessHours: bh,
    maxConcurrent: MAX_CONCURRENT_ORDERS,
    activeCount,
    remainingSlots: Math.max(0, MAX_CONCURRENT_ORDERS - activeCount),
    isLimitReached,
    canAccept
  };
}

// 英数3桁のランダムな注文番号生成（英字と数字が必ず混ざる3桁・見間違いやすい 0/O, 1/I 除外）
function generateOrderNumber() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // 24文字 (I, O 除外)
  const digits = '23456789';                 // 8文字 (0, 1 除外)
  const activeNumbers = new Set(
    orders
      .filter(o => o.status !== 'COMPLETED' && o.status !== 'CANCELLED')
      .map(o => o.orderNumber)
  );

  let code = '';
  let attempts = 0;
  do {
    // 英字と数字が必ず両方含まれるように生成（英字1+数字2、または英字2+数字1）
    const letterCount = Math.random() < 0.5 ? 1 : 2;
    const digitCount = 3 - letterCount;
    const chars = [];
    for (let i = 0; i < letterCount; i++) {
      chars.push(letters[Math.floor(Math.random() * letters.length)]);
    }
    for (let i = 0; i < digitCount; i++) {
      chars.push(digits[Math.floor(Math.random() * digits.length)]);
    }
    // シャッフル
    for (let i = chars.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    code = chars.join('');
    attempts++;
  } while (activeNumbers.has(code) && attempts < 100);

  return code;
}

// ラーメン・汁なし 1杯につき容器代100円
const CONTAINER_FEE_PER_BOWL = 100;

// 券売機で購入すべき食券リストを算出（容器代 1杯100円、特典適用時は無料）
function calculateTickets(items, isContainerFree = false) {
  const ticketSummary = {};
  let totalAmount = 0;

  items.forEach(item => {
    const qty = item.quantity || 1;
    // ラーメン・汁なし 1杯につき容器代100円（特典適用時は無料0円）
    const standardFee = (item.containerFee !== undefined) ? item.containerFee : CONTAINER_FEE_PER_BOWL;
    const containerFee = isContainerFree ? 0 : standardFee;
    let itemSubtotal = ((item.price || 0) + containerFee) * qty;

    if (item.requiredTickets && item.requiredTickets.length > 0) {
      item.requiredTickets.forEach(t => {
        const key = t.name;
        if (!ticketSummary[key]) {
          ticketSummary[key] = { name: key, price: t.price, quantity: 0, subtotal: 0 };
        }
        ticketSummary[key].quantity += qty;
        ticketSummary[key].subtotal += t.price * qty;
      });
    }

    // 容器代食券の内訳
    if (containerFee > 0) {
      const key = '容器代券';
      if (!ticketSummary[key]) {
        ticketSummary[key] = { name: key, price: containerFee, quantity: 0, subtotal: 0 };
      }
      ticketSummary[key].quantity += qty;
      ticketSummary[key].subtotal += containerFee * qty;
    }

    const paidTops = item.paidToppings || item.toppings || [];
    if (paidTops.length > 0) {
      paidTops.forEach(top => {
        itemSubtotal += (top.price || 0) * qty;
        if (top.requiredTickets && top.requiredTickets.length > 0) {
          top.requiredTickets.forEach(t => {
            const key = t.name;
            if (!ticketSummary[key]) {
              ticketSummary[key] = { name: key, price: t.price, quantity: 0, subtotal: 0 };
            }
            ticketSummary[key].quantity += qty;
            ticketSummary[key].subtotal += t.price * qty;
          });
        }
      });
    }

    totalAmount += itemSubtotal;
  });

  return {
    tickets: Object.values(ticketSummary),
    totalAmount
  };
}

// === API エンドポイント ===

app.get('/api/store-status', (req, res) => {
  res.json(getStoreStatus());
});

app.post('/api/store-status', (req, res) => {
  const { accepting, reason, isTemporaryClosed, temporaryClosedReason } = req.body;
  if (typeof accepting === 'boolean') {
    storeConfig.isAcceptingOrders = accepting;
  }
  if (reason !== undefined) {
    storeConfig.pauseReason = reason;
  }
  if (typeof isTemporaryClosed === 'boolean') {
    storeConfig.isTemporaryClosed = isTemporaryClosed;
  }
  if (temporaryClosedReason !== undefined) {
    storeConfig.temporaryClosedReason = temporaryClosedReason;
  }
  saveStoreConfig();
  const currentStatus = getStoreStatus();
  io.emit('store:status_changed', currentStatus);
  res.json(currentStatus);
});

app.post('/api/store-status/toggle-temporary-closed', (req, res) => {
  const { isTemporaryClosed, reason } = req.body;
  if (typeof isTemporaryClosed === 'boolean') {
    storeConfig.isTemporaryClosed = isTemporaryClosed;
  } else {
    storeConfig.isTemporaryClosed = !storeConfig.isTemporaryClosed;
  }
  if (reason) {
    storeConfig.temporaryClosedReason = reason;
  }
  saveStoreConfig();
  const currentStatus = getStoreStatus();
  io.emit('store:status_changed', currentStatus);
  res.json(currentStatus);
});

app.post('/api/store-status/toggle-force-open', (req, res) => {
  const { forceOpen } = req.body;
  if (typeof forceOpen === 'boolean') {
    storeConfig.forceOpenForTesting = forceOpen;
  } else {
    storeConfig.forceOpenForTesting = !storeConfig.forceOpenForTesting;
  }
  saveStoreConfig();
  const currentStatus = getStoreStatus();
  io.emit('store:status_changed', currentStatus);
  res.json(currentStatus);
});

app.get('/api/menu', (req, res) => {
  loadMenu();
  res.json(getMenuWithSoldOut());
});

app.post('/api/menu/toggle-soldout', (req, res) => {
  const { itemId, soldOut } = req.body;
  if (!itemId) {
    return res.status(400).json({ error: 'itemId is required' });
  }

  let isSoldOut;
  if (typeof soldOut === 'boolean') {
    isSoldOut = soldOut;
    if (isSoldOut) {
      soldOutIds.add(itemId);
    } else {
      soldOutIds.delete(itemId);
    }
  } else {
    if (soldOutIds.has(itemId)) {
      soldOutIds.delete(itemId);
      isSoldOut = false;
    } else {
      soldOutIds.add(itemId);
      isSoldOut = true;
    }
  }

  const payload = {
    itemId,
    soldOut: isSoldOut,
    soldOutIds: Array.from(soldOutIds),
    isPorkSoldOut: isPorkSoldOut()
  };

  io.emit('menu:soldout_changed', payload);
  res.json(payload);
});

app.post('/api/menu/toggle-pork-soldout', (req, res) => {
  const { soldOut } = req.body;
  const porkIds = getPorkMenuIds();
  const currentlySoldOut = isPorkSoldOut();
  const nextState = typeof soldOut === 'boolean' ? soldOut : !currentlySoldOut;

  porkIds.forEach(id => {
    if (nextState) {
      soldOutIds.add(id);
    } else {
      soldOutIds.delete(id);
    }
  });

  const payload = {
    isPorkSoldOut: nextState,
    porkIds,
    soldOutIds: Array.from(soldOutIds)
  };

  io.emit('menu:soldout_changed', payload);
  res.json(payload);
});

app.get('/api/orders', (req, res) => {
  res.json(orders);
});

app.get('/api/orders/:id', (req, res) => {
  const order = orders.find(o => o.id === req.params.id);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }
  res.json(order);
});

// ユーザーの注文回数と特典ステータスを取得（注文画面用）
app.get('/api/user/order-stats', (req, res) => {
  const { lineUserId } = req.query;
  const stats = getUserOrderHistory(lineUserId);
  res.json(stats);
});

app.post('/api/orders', (req, res) => {
  const currentStatus = getStoreStatus();
  if (currentStatus.isTemporaryClosed) {
    return res.status(403).json({
      error: 'TEMPORARY_CLOSED',
      message: `本日は臨時休業のため、予約注文を受け付けておりません。（${currentStatus.temporaryClosedReason || '本日臨時休業'}）`
    });
  }
  if (!currentStatus.businessHours.isOpen) {
    return res.status(403).json({
      error: currentStatus.businessHours.reason,
      message: `${currentStatus.businessHours.message} ${currentStatus.businessHours.businessHoursText}`
    });
  }
  if (!currentStatus.isAcceptingOrders) {
    return res.status(403).json({
      error: 'ORDER_PAUSED',
      message: '只今、混雑のため一時的に予約受付を停止しております。'
    });
  }
  if (currentStatus.isLimitReached) {
    return res.status(429).json({
      error: 'ORDER_LIMIT_REACHED',
      message: `只今、同時注文上限（${MAX_CONCURRENT_ORDERS}件）に達しております。現在調理中の注文がお渡し完了になり次第、自動的に受付を再開いたします。`
    });
  }

  const { items, note, memo, lineUserId, lineUserName } = req.body;
  const orderMemo = (memo || note || '').toString().slice(0, 300);

  // いたずら防止ブラックリストチェック
  if (lineUserId && isBlacklisted(lineUserId)) {
    return res.status(403).json({
      error: 'ACCOUNT_BLOCKED',
      message: '申し訳ございません。このアカウントからのご注文は現在受け付けておりません。'
    });
  }

  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'Cart is empty' });
  }

  // 売り切れアイテムのバリデーション
  for (const item of items) {
    if (soldOutIds.has(item.id)) {
      return res.status(400).json({
        error: 'ITEM_SOLD_OUT',
        message: `申し訳ございません。「${item.name}」は只今売り切れとなっております。`
      });
    }
    const paidTops = item.paidToppings || item.toppings || [];
    for (const t of paidTops) {
      if (soldOutIds.has(t.id)) {
        return res.status(400).json({
          error: 'TOPPING_SOLD_OUT',
          message: `申し訳ございません。トッピング「${t.name}」は只今売り切れとなっております。`
        });
      }
    }
  }

  // リピーター判定（直近30日で過去2回以上注文済み＝今回で3回目以上なら容器代無料）
  const userHistory = getUserOrderHistory(lineUserId);
  const isContainerFree = userHistory.isContainerFree;

  // 容器代無料特典の適用反映（アイテムデータ自体の容器代を0円に更新）
  const sanitizedItems = items.map(item => {
    const fee = isContainerFree ? 0 : ((item.containerFee !== undefined) ? item.containerFee : CONTAINER_FEE_PER_BOWL);
    const paidTopsTotal = (item.paidToppings || item.toppings || []).reduce((sum, p) => sum + (p.price || 0), 0);
    const ramenPrice = item.price || 0;
    const filteredTickets = (item.requiredTickets || []).filter(t => t.name !== '容器代券');
    if (fee > 0) {
      filteredTickets.push({ name: '容器代券', price: fee });
    }
    return {
      ...item,
      containerFee: fee,
      requiredTickets: filteredTickets,
      itemTotal: (ramenPrice + fee + paidTopsTotal) * (item.quantity || 1)
    };
  });

  const totalBowls = sanitizedItems.reduce((sum, item) => sum + (item.quantity || 1), 0);
  const savedContainerFee = isContainerFree ? (totalBowls * CONTAINER_FEE_PER_BOWL) : 0;

  const { tickets, totalAmount } = calculateTickets(sanitizedItems, isContainerFree);
  const now = new Date();

  const currentTotalCount = userHistory.totalCount + 1;
  const currentMonthlyCount = userHistory.monthlyCount + 1;

  const newOrder = {
    id: 'ord_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    orderNumber: generateOrderNumber(), // 英数3桁（例: A01）
    items: sanitizedItems,
    tickets,
    totalAmount,
    note: orderMemo,
    memo: orderMemo,
    lineUserId: lineUserId || null,
    lineUserName: lineUserName || null,
    status: 'RECEIVED',
    createdAt: now.toISOString(),
    targetTimestamp: null,
    estimatedMinutes: null,
    readyAt: null,
    userOrderStats: {
      totalCount: currentTotalCount,
      monthlyCount: currentMonthlyCount,
      isContainerFree: isContainerFree,
      savedContainerFee: savedContainerFee
    }
  };

  orders.unshift(newOrder);
  saveOrders();
  io.emit('order:created', newOrder);
  io.emit('store:status_changed', getStoreStatus());

  res.status(201).json(newOrder);
});

// LIFF設定の取得
app.get('/api/config/liff', (req, res) => {
  res.json({
    liffId: process.env.LINE_LIFF_ID || '2011903918-yFtFeQMz'
  });
});

// 厨房からいたずら注文者をブロック（出禁）＆注文キャンセル
app.post('/api/orders/:id/block', (req, res) => {
  const order = orders.find(o => o.id === req.params.id);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  if (order.lineUserId) {
    addToBlacklist(order.lineUserId, order.lineUserName);
  }

  order.status = 'CANCELLED';
  order.cancelReason = 'いたずら注文としてブロック';

  saveOrders();
  io.emit('order:updated', order);
  io.emit('store:status_changed', getStoreStatus());

  res.json({
    success: true,
    message: 'ユーザーをブラックリストに登録し、注文を破棄しました',
    order
  });
});

// 管理者用ブラックリスト一覧取得
app.get('/api/admin/blacklist', (req, res) => {
  res.json(blacklist);
});

// 管理者用ブラックリスト解除
app.post('/api/admin/blacklist/unblock', (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  blacklist = blacklist.filter(b => b.userId !== userId);
  saveBlacklist();
  res.json({ success: true, message: 'ブロックを解除しました' });
});

function formatTimeHHMM(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return d.toLocaleTimeString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

app.patch('/api/orders/:id', (req, res) => {
  const order = orders.find(o => o.id === req.params.id);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const { status, addMinutes, resetTime, estimatedMinutes } = req.body;

  if (status) {
    order.status = status;
    if (status === 'READY') {
      order.readyAt = new Date().toISOString();
    } else if (status === 'COOKING') {
      const now = Date.now();
      const mins = Number(estimatedMinutes) || order.estimatedMinutes || 10;
      order.estimatedMinutes = mins;
      order.targetTimestamp = now + mins * 60 * 1000;
      order.estimatedTime = formatTimeHHMM(order.targetTimestamp);
    }
  }

  if (resetTime) {
    order.targetTimestamp = null;
    order.estimatedMinutes = null;
    order.estimatedTime = null;
    if (order.status === 'COOKING') {
      order.status = 'RECEIVED';
    }
  } else if (addMinutes !== undefined && order.status === 'COOKING') {
    const now = Date.now();
    let baseTimestamp = order.targetTimestamp || (now + 10 * 60 * 1000);
    const newTimestamp = Math.max(now, baseTimestamp + addMinutes * 60 * 1000);
    order.targetTimestamp = newTimestamp;
    order.estimatedMinutes = Math.max(1, Math.ceil((newTimestamp - now) / 60000));
    order.estimatedTime = formatTimeHHMM(newTimestamp);
  } else if (estimatedMinutes !== undefined && !status && order.status === 'COOKING') {
    const now = Date.now();
    order.estimatedMinutes = estimatedMinutes;
    order.targetTimestamp = now + estimatedMinutes * 60 * 1000;
    order.estimatedTime = formatTimeHHMM(order.targetTimestamp);
  }

  saveOrders();
  io.emit('order:updated', order);
  io.emit('store:status_changed', getStoreStatus());
  res.json(order);
});

// テスト用：全注文クリア
app.post('/api/orders/reset', (req, res) => {
  orders = [];
  saveOrders();
  io.emit('store:status_changed', getStoreStatus());
  io.emit('orders:reset');
  res.json({ success: true, message: 'All orders reset' });
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  // 接続時に最新の受付状況を送信
  socket.emit('store:status_changed', getStoreStatus());
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`===============================================`);
  console.log(`🍜 ラーメン店 テイクアウト注文システム 起動中`);
  console.log(`📱 お客様用画面 (PC自身)   : http://localhost:${PORT}/`);
  console.log(`📱 お客様用画面 (同一Wi-Fi): http://192.168.1.57:${PORT}/`);
  console.log(`📟 厨房モニター (PC自身)   : http://localhost:${PORT}/kitchen.html`);
  console.log(`📟 厨房モニター (同一Wi-Fi): http://192.168.1.57:${PORT}/kitchen.html`);
  console.log(`===============================================`);
});

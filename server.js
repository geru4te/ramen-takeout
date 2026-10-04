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
let orders = [];

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

// 営業時間判定（日曜定休 / 昼 11:30〜14:30 / 夜 18:00〜22:00 JST）
function checkBusinessHours() {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const jstDate = new Date(utc + (3600000 * 9));

  const day = jstDate.getDay(); // 0: 日曜, 1: 月曜, ..., 6: 土曜
  const hours = jstDate.getHours();
  const minutes = jstDate.getMinutes();
  const totalMinutes = hours * 60 + minutes;

  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  const currentDayName = dayNames[day];
  const currentTimeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;

  // テスト用：営業時間・定休日制限の強制解除
  if (storeConfig.forceOpenForTesting) {
    return {
      isOpen: true,
      period: 'テスト営業中 (時間制限解除中)',
      isForceOpen: true,
      businessHoursText: '※テスト用に営業時間・定休日を解除しています',
      currentDay: currentDayName,
      currentTime: currentTimeStr
    };
  }

  // 日曜日は定休日
  if (day === 0) {
    return {
      isOpen: false,
      reason: 'CLOSED_DAY',
      message: '本日（日曜日）は定休日のため、予約受付を行っておりません。',
      businessHoursText: '営業時間: 昼 11:30〜14:30 / 夜 18:00〜22:00（日曜定休）',
      currentDay: currentDayName,
      currentTime: currentTimeStr
    };
  }

  // 昼の部: 11:30 (690分) 〜 14:30 (870分)
  const isLunch = totalMinutes >= (11 * 60 + 30) && totalMinutes < (14 * 60 + 30);
  // 夜の部: 18:00 (1080分) 〜 22:00 (1320分)
  const isDinner = totalMinutes >= (18 * 60) && totalMinutes < (22 * 60);

  if (isLunch || isDinner) {
    return {
      isOpen: true,
      period: isLunch ? '昼の部 (11:30〜14:30)' : '夜の部 (18:00〜22:00)',
      businessHoursText: '営業時間: 昼 11:30〜14:30 / 夜 18:00〜22:00（日曜定休）',
      currentDay: currentDayName,
      currentTime: currentTimeStr
    };
  }

  return {
    isOpen: false,
    reason: 'OUT_OF_HOURS',
    message: '只今の時間は営業時間外です。',
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

// 券売機で購入すべき食券リストを算出（容器代 1杯100円を含む）
function calculateTickets(items) {
  const ticketSummary = {};
  let totalAmount = 0;

  items.forEach(item => {
    const qty = item.quantity || 1;
    // ラーメン・汁なし 1杯につき容器代100円を加算
    const containerFee = (item.containerFee !== undefined) ? item.containerFee : CONTAINER_FEE_PER_BOWL;
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

  const { items, note, memo } = req.body;
  const orderMemo = (memo || note || '').toString().slice(0, 300);

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

  const { tickets, totalAmount } = calculateTickets(items);
  const now = new Date();

  const newOrder = {
    id: 'ord_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    orderNumber: generateOrderNumber(), // 英数3桁（例: A01）
    items,
    tickets,
    totalAmount,
    note: orderMemo,
    memo: orderMemo,
    status: 'RECEIVED',
    createdAt: now.toISOString(),
    targetTimestamp: null,
    estimatedMinutes: null,
    readyAt: null
  };

  orders.unshift(newOrder);
  io.emit('order:created', newOrder);
  io.emit('store:status_changed', getStoreStatus());

  res.status(201).json(newOrder);
});

function formatTimeHHMM(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
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

  io.emit('order:updated', order);
  io.emit('store:status_changed', getStoreStatus());
  res.json(order);
});

// テスト用：全注文クリア
app.post('/api/orders/reset', (req, res) => {
  orders = [];
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

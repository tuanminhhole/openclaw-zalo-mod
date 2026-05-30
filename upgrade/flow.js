#!/usr/bin/env node
/**
 * upgrade-flow — CLI tool for automated upgrade/payment flow
 * ─────────────────────────────────────────────────────────────
 * Standalone module cho bot Mkt xử lý:
 *   deviceId detection → plan selection → QR payment → key generation
 *
 * Commands:
 *   node flow.js show-plans
 *   node flow.js create-order <deviceId> <planId> <senderId> [senderName]
 *   node flow.js check-payment <orderId>
 *   node flow.js confirm-order <orderId>
 *   node flow.js generate-key <deviceId> <planId>
 *   node flow.js get-order <orderId>
 *   node flow.js list-orders [pending|completed|all]
 *   node flow.js create-qr <amount> <memo>
 *
 * @author tuanminhhole
 * @version 1.0.0
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Data files ───────────────────────────────────────────────
const PLANS_FILE    = path.join(__dirname, 'plans.json');
const ORDERS_FILE   = path.join(__dirname, 'orders.json');
const HISTORY_FILE  = path.join(__dirname, 'history.json');
const KEY_FILE      = path.join(__dirname, 'private-key.pem');

// ── Helpers ──────────────────────────────────────────────────
function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return typeof fallback === 'function' ? fallback() : fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function loadPlans() {
  return readJson(PLANS_FILE, { plans: [] });
}

function loadOrders() {
  return readJson(ORDERS_FILE, {});
}

function saveOrders(orders) {
  writeJson(ORDERS_FILE, orders);
}

function loadHistory() {
  return readJson(HISTORY_FILE, []);
}

function saveHistory(history) {
  writeJson(HISTORY_FILE, history);
}

function generateOrderId() {
  return 'ORD-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

function nowIso() {
  return new Date().toISOString();
}

// ── DeviceId validation ──────────────────────────────────────
function isValidDeviceId(deviceId) {
  return /^[0-9A-Fa-f]{16}$/.test(deviceId);
}

// ── Plan lookup ──────────────────────────────────────────────
function getPlanById(planId) {
  const config = loadPlans();
  return config.plans.find(p => p.id === planId.toLowerCase());
}

function getPlanByIndex(index) {
  const config = loadPlans();
  const idx = parseInt(index, 10) - 1;
  if (idx >= 0 && idx < config.plans.length) return config.plans[idx];
  return null;
}

// ── RSA Key Generation ───────────────────────────────────────
// NOTE: zalo-mod verifyLicenseKey checks planGroup (personal/team/lifetime)
// NOT the full planId (personal-monthly etc). So we sign with planGroup.
function generateLicenseKey(deviceId, planId) {
  const plan = getPlanById(planId);
  if (!plan) throw new Error(`Plan "${planId}" not found`);

  const normalizedDeviceId = deviceId.toUpperCase();
  const planGroup = plan.planGroup || planId; // personal, team, lifetime

  // Calculate expiry from NOW
  let expiry;
  let renewAt = null; // ISO date for renewal reminder
  if (plan.durationMonths === -1) {
    expiry = '2099-12-31';
  } else {
    const d = new Date();
    d.setMonth(d.getMonth() + plan.durationMonths);
    expiry = d.toISOString().slice(0, 10);
    // Renewal reminder: 3 days before expiry
    const r = new Date(d);
    r.setDate(r.getDate() - 3);
    renewAt = r.toISOString().slice(0, 10);
  }

  const expiryCompact = expiry.replace(/-/g, ''); // YYYYMMDD

  // Sign with planGroup (not full planId) for zalo-mod compatibility
  const dataToSign = `${normalizedDeviceId}:${planGroup}:${expiry}`;

  let privateKey;
  try {
    privateKey = fs.readFileSync(KEY_FILE, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read private key: ${e.message}`);
  }

  const signer = crypto.createSign('sha256');
  signer.update(dataToSign);
  const signature = signer.sign(privateKey, 'base64');

  // Format: ZALOMKT-[PLANGROUP]-[EXPIRY_YYYYMMDD]-[RSA_SIGNATURE_BASE64]
  const key = `ZALOMKT-${planGroup.toUpperCase()}-${expiryCompact}-${signature}`;

  return {
    key,
    plan: planGroup,
    planId,
    expiry,
    renewAt,
    deviceId: normalizedDeviceId,
    durationMonths: plan.durationMonths,
    dataToSign,
    generatedAt: nowIso()
  };
}

// ── MonkeyPay Integration ────────────────────────────────────
// MonkeyPay API:
//   POST /api/transactions  — Create tx (returns tx_id, qr_url, payment_note)
//   GET  /api/transactions/:tx_id — Check tx status
//   Auth: X-Api-Key header

function getMonkeyPayConfig() {
  const config = loadPlans();
  const mp = config.monkeypay || {};
  return {
    serverUrl: mp.serverUrl || '',
    apiKey: mp.apiKey || '',
    notePrefix: mp.notePrefix || 'ZALOMOD',
    bankInfo: config.bankInfo || {}
  };
}

async function createPaymentQR(amount, memo) {
  const mp = getMonkeyPayConfig();

  if (!mp.serverUrl || !mp.apiKey) {
    // Fallback: manual bank transfer info
    return {
      ok: true,
      method: 'manual',
      bankName: mp.bankInfo.bankName || 'MB Bank',
      accountNumber: mp.bankInfo.accountNumber || '(chưa cấu hình)',
      accountName: mp.bankInfo.accountName || '(chưa cấu hình)',
      amount,
      memo,
      message: 'MonkeyPay chưa cấu hình. Dùng thông tin CK thủ công.'
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(`${mp.serverUrl}/api/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': mp.apiKey
      },
      body: JSON.stringify({
        amount,
        payment_note: memo,
        description: `Nâng cấp OpenClaw Zalo-Mod — ${memo}`
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json();
      return {
        ok: true,
        method: 'monkeypay',
        txId: data.tx_id,
        qrUrl: data.qr_url,
        paymentNote: data.payment_note,
        bankInfo: data.bank_info,
        expiresAt: data.expires_at,
        status: data.status
      };
    }

    const errBody = await res.json().catch(() => ({}));
    return { ok: false, error: errBody.error || `MonkeyPay returned ${res.status}` };
  } catch (e) {
    // Fallback to manual on network error
    return {
      ok: true,
      method: 'manual',
      bankName: mp.bankInfo.bankName || 'MB Bank',
      accountNumber: mp.bankInfo.accountNumber || '(chưa cấu hình)',
      accountName: mp.bankInfo.accountName || '(chưa cấu hình)',
      amount,
      memo,
      message: `MonkeyPay lỗi: ${e.message}. Dùng CK thủ công.`
    };
  }
}

// ── MonkeyPay Payment Check ──────────────────────────────────
async function checkPaymentStatus(txId) {
  const mp = getMonkeyPayConfig();

  if (!mp.serverUrl || !mp.apiKey) {
    return { ok: false, paid: false, error: 'MonkeyPay chưa cấu hình' };
  }

  if (!txId) {
    return { ok: false, paid: false, error: 'Không có MonkeyPay txId' };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(`${mp.serverUrl}/api/transactions/${txId}`, {
      method: 'GET',
      headers: { 'x-api-key': mp.apiKey },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json();
      const paid = data.status === 'completed';
      return {
        ok: true,
        paid,
        status: data.status,
        transaction: data.matched_bank_tx || null
      };
    }
    return { ok: false, paid: false, error: `Status ${res.status}` };
  } catch (e) {
    return { ok: false, paid: false, error: e.message };
  }
}

// ── Commands ─────────────────────────────────────────────────

async function cmdShowPlans() {
  const config = loadPlans();
  const features = config.planFeatures || {};
  const lines = ['📋 BẢNG GIÁ OPENCLAW ZALO-MOD', '━━━━━━━━━━━━━━━━━━'];

  // Group plans by planGroup for display
  let lastGroup = '';
  config.plans.forEach((p) => {
    if (p.planGroup !== lastGroup) {
      lines.push('');
      // Show group features header
      const groupFeats = features[p.planGroup] || [];
      if (p.planGroup === 'personal') lines.push('🔵 CÁ NHÂN');
      else if (p.planGroup === 'team') lines.push('🟢 TEAM');
      else if (p.planGroup === 'lifetime') lines.push('🟡 LIFETIME');
      groupFeats.forEach(f => lines.push(`   ✅ ${f}`));
      lastGroup = p.planGroup;
    }
    const note = p.priceNote ? ` (${p.priceNote})` : '';
    lines.push(`   ${p.emoji} ${p.priceLabel}${note}`);
  });

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━');
  lines.push(`💬 Reply số (1-${config.plans.length}) để chọn gói.`);

  console.log(JSON.stringify({ ok: true, message: lines.join('\n'), plans: config.plans }));
}

async function cmdCreateOrder(deviceId, planId, senderId, senderName) {
  if (!isValidDeviceId(deviceId)) {
    console.log(JSON.stringify({ ok: false, error: `DeviceId "${deviceId}" không hợp lệ (cần 16 ký tự hex)` }));
    return;
  }

  // Accept plan by index (1,2,3) or by id (personal, team, lifetime)
  let plan = getPlanById(planId);
  if (!plan) plan = getPlanByIndex(planId);
  if (!plan) {
    console.log(JSON.stringify({ ok: false, error: `Plan "${planId}" không tồn tại` }));
    return;
  }

  const orderId = generateOrderId();
  // Use planGroup (no dashes) for memo — banks strip special chars like '-'
  const planGroup = (plan.planGroup || plan.id).toUpperCase().replace(/-/g, '');
  const memo = `ZALOMOD ${deviceId.toUpperCase()} ${planGroup}`;
  const amount = plan.totalPrice || plan.price;

  // Create payment QR
  const qrResult = await createPaymentQR(amount, memo);

  const order = {
    orderId,
    monkeyPayTxId: qrResult.txId || null,
    deviceId: deviceId.toUpperCase(),
    planId: plan.id,
    planGroup: plan.planGroup || plan.id,
    planName: plan.name || plan.nameShort,
    durationMonths: plan.durationMonths,
    amount,
    memo,
    senderId: senderId || '',
    senderName: senderName || senderId || '',
    status: 'pending',
    createdAt: nowIso(),
    qr: qrResult,
    paidAt: null,
    keyGenerated: null
  };

  const orders = loadOrders();
  orders[orderId] = order;
  saveOrders(orders);

  console.log(JSON.stringify({
    ok: true,
    orderId,
    order,
    paymentMessage: buildPaymentMessage(order, qrResult)
  }));
}

function buildPaymentMessage(order, qrResult) {
  const lines = [
    `💳 THANH TOÁN — ${order.planName}`,
    `━━━━━━━━━━━━━━━━━━`,
    ``,
    `📱 Device ID: ${order.deviceId}`,
    `📦 Gói: ${order.planName}`,
    `💰 Số tiền: ${order.amount.toLocaleString('vi-VN')}đ`,
    ``,
  ];

  if (qrResult.method === 'monkeypay' && qrResult.qrUrl) {
    const bi = qrResult.bankInfo || {};
    lines.push(`🏦 ${bi.bank || 'MB Bank'} — ${bi.account_name || ''}`);
    lines.push(`   STK: ${bi.account_number || ''}`);
  } else {
    lines.push(`🏦 Chuyển khoản:`);
    lines.push(`   Ngân hàng: ${qrResult.bankName || 'MB Bank'}`);
    lines.push(`   STK: ${qrResult.accountNumber || '(xem QR)'}`);
    lines.push(`   Tên: ${qrResult.accountName || '(xem QR)'}`);
  }

  lines.push(``);
  lines.push(`📝 Nội dung CK: ${qrResult.paymentNote || order.memo}`);
  lines.push(``);
  lines.push(`⏳ Mã đơn: ${order.orderId}`);
  lines.push(`📌 Sau khi CK xong, hệ thống sẽ tự động xác nhận và gửi key.`);
  lines.push(`💡 Hoặc reply "đã ck" để mình kiểm tra ngay.`);

  // Return text + separate qrUrl for bot to send as image
  return {
    text: lines.join('\n'),
    qrUrl: qrResult.qrUrl || null
  };
}

async function cmdCheckPayment(orderId) {
  const orders = loadOrders();
  const order = orders[orderId];

  if (!order) {
    console.log(JSON.stringify({ ok: false, error: `Order "${orderId}" không tồn tại` }));
    return;
  }

  if (order.status === 'completed') {
    console.log(JSON.stringify({ ok: true, paid: true, order, message: 'Đơn này đã hoàn tất.' }));
    return;
  }

  const result = await checkPaymentStatus(order.monkeyPayTxId);

  if (result.paid) {
    // Auto-confirm and generate key
    order.status = 'paid';
    order.paidAt = nowIso();
    orders[orderId] = order;
    saveOrders(orders);

    // Generate key
    const keyResult = generateLicenseKey(order.deviceId, order.planId);
    order.status = 'completed';
    order.keyGenerated = keyResult;
    orders[orderId] = order;
    saveOrders(orders);

    // Save to history
    const history = loadHistory();
    history.push({ ...order, completedAt: nowIso() });
    saveHistory(history);

    console.log(JSON.stringify({
      ok: true,
      paid: true,
      order,
      key: keyResult.key,
      message: buildKeyDeliveryMessage(order, keyResult)
    }));
  } else {
    console.log(JSON.stringify({
      ok: true,
      paid: false,
      order,
      message: `⏳ Chưa nhận được thanh toán cho đơn ${orderId}.\n💰 Số tiền: ${order.amount.toLocaleString('vi-VN')}đ\n📝 Nội dung CK: ${order.memo}`
    }));
  }
}

async function cmdConfirmOrder(orderId) {
  const orders = loadOrders();
  const order = orders[orderId];

  if (!order) {
    console.log(JSON.stringify({ ok: false, error: `Order "${orderId}" không tồn tại` }));
    return;
  }

  if (order.status === 'completed') {
    console.log(JSON.stringify({ ok: true, order, message: 'Đơn này đã hoàn tất trước đó.' }));
    return;
  }

  // Force confirm (manual by owner)
  order.status = 'paid';
  order.paidAt = nowIso();

  // Generate key
  const keyResult = generateLicenseKey(order.deviceId, order.planId);
  order.status = 'completed';
  order.keyGenerated = keyResult;
  orders[orderId] = order;
  saveOrders(orders);

  // Save to history
  const history = loadHistory();
  history.push({ ...order, completedAt: nowIso() });
  saveHistory(history);

  console.log(JSON.stringify({
    ok: true,
    order,
    key: keyResult.key,
    message: buildKeyDeliveryMessage(order, keyResult)
  }));
}

function buildKeyDeliveryMessage(order, keyResult) {
  const lines = [
    `✅ THANH TOÁN THÀNH CÔNG!`,
    `━━━━━━━━━━━━━━━━━━`,
    ``,
    `📦 Gói: ${order.planName}`,
    `📱 Device ID: ${order.deviceId}`,
    `📅 Hạn dùng: ${keyResult.expiry}`,
  ];

  if (keyResult.renewAt) {
    lines.push(`🔔 Nhắc gia hạn: ${keyResult.renewAt}`);
  }

  lines.push(``);
  lines.push(`🔑 KEY KÍCH HOẠT:`);
  lines.push(``);
  lines.push(keyResult.key);
  lines.push(``);
  lines.push(`━━━━━━━━━━━━━━━━━━`);
  lines.push(`📋 Cách kích hoạt:`);
  lines.push(`1. Mở Dashboard Zalo-Mod`);
  lines.push(`2. Vào tab "Nâng cấp"`);
  lines.push(`3. Dán key vào ô "Kích hoạt"`);
  lines.push(`4. Nhấn "Xác thực"`);
  lines.push(``);
  lines.push(`💡 Hoặc gõ trong Zalo:`);
  lines.push(`   /mkt-active-key ${keyResult.key}`);

  if (keyResult.durationMonths > 0) {
    lines.push(``);
    lines.push(`⏳ Key hết hạn ngày ${keyResult.expiry}. Mình sẽ nhắc bạn gia hạn trước 3 ngày.`);
  }

  lines.push(``);
  lines.push(`Cảm ơn bạn đã ủng hộ! 🙏`);

  return lines.join('\n');
}

async function cmdGenerateKey(deviceId, planId) {
  if (!isValidDeviceId(deviceId)) {
    console.log(JSON.stringify({ ok: false, error: `DeviceId "${deviceId}" không hợp lệ` }));
    return;
  }

  try {
    const result = generateLicenseKey(deviceId, planId);
    console.log(JSON.stringify({ ok: true, ...result }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message }));
  }
}

async function cmdGetOrder(orderId) {
  const orders = loadOrders();
  const order = orders[orderId];
  if (!order) {
    console.log(JSON.stringify({ ok: false, error: `Order "${orderId}" không tồn tại` }));
    return;
  }
  console.log(JSON.stringify({ ok: true, order }));
}

async function cmdListOrders(filter) {
  const orders = loadOrders();
  let entries = Object.values(orders);

  if (filter === 'pending') entries = entries.filter(o => o.status === 'pending');
  else if (filter === 'completed') entries = entries.filter(o => o.status === 'completed');

  console.log(JSON.stringify({
    ok: true,
    count: entries.length,
    orders: entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  }));
}

async function cmdFindPendingBySender(senderId) {
  const orders = loadOrders();
  const pending = Object.values(orders)
    .filter(o => o.senderId === senderId && o.status === 'pending')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (pending.length === 0) {
    console.log(JSON.stringify({ ok: true, found: false, message: 'Không có đơn pending nào.' }));
  } else {
    console.log(JSON.stringify({ ok: true, found: true, order: pending[0], allPending: pending }));
  }
}

// ── Poll all pending orders ──────────────────────────────────
// Checks MonkeyPay status for ALL pending orders.
// Returns list of newly completed orders (with keys + sender info).
// Bot should run this periodically (e.g. every 30s via cron/heartbeat).
async function cmdPollPending() {
  const orders = loadOrders();
  const pendingList = Object.values(orders).filter(o => o.status === 'pending');

  if (pendingList.length === 0) {
    console.log(JSON.stringify({ ok: true, completed: [], message: 'Không có đơn pending.' }));
    return;
  }

  const completed = [];

  for (const order of pendingList) {
    if (!order.monkeyPayTxId) continue;

    const result = await checkPaymentStatus(order.monkeyPayTxId);
    if (!result.ok || !result.paid) continue;

    // PAID! Generate key
    order.status = 'paid';
    order.paidAt = nowIso();
    const keyResult = generateLicenseKey(order.deviceId, order.planId);
    order.status = 'completed';
    order.keyGenerated = keyResult;
    orders[order.orderId] = order;

    // Save to history
    const history = loadHistory();
    history.push({ ...order, completedAt: nowIso() });
    saveHistory(history);

    completed.push({
      orderId: order.orderId,
      senderId: order.senderId,
      senderName: order.senderName,
      deviceId: order.deviceId,
      planName: order.planName,
      key: keyResult.key,
      expiry: keyResult.expiry,
      renewAt: keyResult.renewAt,
      message: buildKeyDeliveryMessage(order, keyResult)
    });
  }

  // Save all changes
  saveOrders(orders);

  console.log(JSON.stringify({
    ok: true,
    polled: pendingList.length,
    completed,
    message: completed.length > 0
      ? `✅ ${completed.length} đơn đã thanh toán và cấp key.`
      : `⏳ ${pendingList.length} đơn pending, chưa có thanh toán mới.`
  }));
}

// ── Main ─────────────────────────────────────────────────────
const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case 'show-plans':
    await cmdShowPlans();
    break;
  case 'create-order':
    await cmdCreateOrder(args[0], args[1], args[2], args[3]);
    break;
  case 'check-payment':
    await cmdCheckPayment(args[0]);
    break;
  case 'confirm-order':
    await cmdConfirmOrder(args[0]);
    break;
  case 'generate-key':
    await cmdGenerateKey(args[0], args[1]);
    break;
  case 'get-order':
    await cmdGetOrder(args[0]);
    break;
  case 'list-orders':
    await cmdListOrders(args[0] || 'all');
    break;
  case 'find-pending':
    await cmdFindPendingBySender(args[0]);
    break;
  case 'poll-pending':
    await cmdPollPending();
    break;
  default:
    console.log(JSON.stringify({
      ok: false,
      error: `Unknown command: ${cmd}`,
      usage: [
        'node flow.js show-plans',
        'node flow.js create-order <deviceId> <planId> <senderId> [senderName]',
        'node flow.js check-payment <orderId>',
        'node flow.js confirm-order <orderId>',
        'node flow.js generate-key <deviceId> <planId>',
        'node flow.js get-order <orderId>',
        'node flow.js list-orders [pending|completed|all]',
        'node flow.js find-pending <senderId>',
        'node flow.js poll-pending'
      ]
    }));
}

'use strict';

const { getPool } = require('../db');
const { hashPassword } = require('../utils/password');

/** 数据仓储层：SQL 集中此处，路由层只调用这些 async 方法，对外返回 camelCase。 */

/* ----------------------------- 映射 ----------------------------- */
function mapUser(r) {
  if (!r) return null;
  return { id: r.id, username: r.username, name: r.name, role: r.role, status: r.status, createdAt: r.created_at };
}
function mapUserWithHash(r) { return r ? { ...mapUser(r), passwordHash: r.password_hash } : null; }
function mapCanteen(r) {
  if (!r) return null;
  return { id: r.id, code: r.code, name: r.name, district: r.district, address: r.address, capacity: r.capacity, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
}
function mapElder(r) {
  if (!r) return null;
  return { id: r.id, code: r.code, name: r.name, gender: r.gender, age: r.age, phone: r.phone, subsidyLevel: r.subsidy_level, identities: r.identities, dietary: r.dietary, canteenId: r.canteen_id, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
}
function mapMeal(r) {
  if (!r) return null;
  return { id: r.id, canteenId: r.canteen_id, serveDate: r.serve_date, mealType: r.meal_type, dishName: r.dish_name, priceCents: r.price_cents, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
}
function mapOrder(r) {
  if (!r) return null;
  return { id: r.id, elderId: r.elder_id, mealId: r.meal_id, diningType: r.dining_type, qty: r.qty, amountCents: r.amount_cents, subsidyCents: r.subsidy_cents, payCents: r.pay_cents, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
}

/* ----------------------------- 用户 ----------------------------- */
async function getUserByUsername(u) { const [r] = await getPool().query('SELECT * FROM users WHERE username=?', [u]); return mapUserWithHash(r[0]); }
async function getUserById(id) { const [r] = await getPool().query('SELECT * FROM users WHERE id=?', [id]); return mapUser(r[0]); }
async function listUsers() { const [r] = await getPool().query('SELECT * FROM users ORDER BY id'); return r.map(mapUser); }
async function createUser({ username, password, name, role = 'VIEWER', status = 'ACTIVE' }) {
  const [x] = await getPool().query('INSERT INTO users (username,password_hash,name,role,status) VALUES (?,?,?,?,?)', [username, hashPassword(password), name, role, status]);
  return getUserById(x.insertId);
}
async function updateUser(id, f) {
  const sets = []; const p = [];
  for (const [k, col] of Object.entries({ name: 'name', role: 'role', status: 'status' })) if (f[k] !== undefined) { sets.push(`${col}=?`); p.push(f[k]); }
  if (f.password !== undefined) { sets.push('password_hash=?'); p.push(hashPassword(f.password)); }
  if (sets.length) { p.push(id); await getPool().query(`UPDATE users SET ${sets.join(',')} WHERE id=?`, p); }
  return getUserById(id);
}
async function deleteUser(id) { const [x] = await getPool().query('DELETE FROM users WHERE id=?', [id]); return x.affectedRows > 0; }
async function countUsers() { const [r] = await getPool().query('SELECT COUNT(*) AS n FROM users'); return r[0].n; }

/* ----------------------------- 助餐点 ----------------------------- */
async function listCanteens({ district, status, keyword } = {}) {
  const w = []; const p = [];
  if (district) { w.push('district=?'); p.push(district); }
  if (status) { w.push('status=?'); p.push(status); }
  if (keyword) { w.push('(code LIKE ? OR name LIKE ?)'); const k = `%${keyword}%`; p.push(k, k); }
  const c = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const [r] = await getPool().query(`SELECT * FROM canteens ${c} ORDER BY id DESC`, p); return r.map(mapCanteen);
}
async function getCanteenById(id) { const [r] = await getPool().query('SELECT * FROM canteens WHERE id=?', [id]); return mapCanteen(r[0]); }
async function getCanteenByCode(code) { const [r] = await getPool().query('SELECT * FROM canteens WHERE code=?', [code]); return mapCanteen(r[0]); }
async function createCanteen(d) {
  const [x] = await getPool().query('INSERT INTO canteens (code,name,district,address,capacity,status) VALUES (?,?,?,?,?,?)', [d.code, d.name, d.district, d.address || '', d.capacity || 0, d.status || 'OPEN']);
  return getCanteenById(x.insertId);
}
async function updateCanteen(id, d) {
  const sets = []; const p = [];
  for (const [k, col] of Object.entries({ name: 'name', district: 'district', address: 'address', capacity: 'capacity', status: 'status' })) if (d[k] !== undefined) { sets.push(`${col}=?`); p.push(d[k]); }
  if (sets.length) { sets.push('updated_at=CURRENT_TIMESTAMP(3)'); p.push(id); await getPool().query(`UPDATE canteens SET ${sets.join(',')} WHERE id=?`, p); }
  return getCanteenById(id);
}
async function deleteCanteen(id) { const [x] = await getPool().query('DELETE FROM canteens WHERE id=?', [id]); return x.affectedRows > 0; }

/* ----------------------------- 长者 ----------------------------- */
async function listElders({ canteenId, subsidyLevel, status, keyword } = {}) {
  const w = []; const p = [];
  if (canteenId !== undefined) { w.push('canteen_id=?'); p.push(canteenId); }
  if (subsidyLevel) { w.push('subsidy_level=?'); p.push(subsidyLevel); }
  if (status) { w.push('status=?'); p.push(status); }
  if (keyword) { w.push('(code LIKE ? OR name LIKE ? OR phone LIKE ?)'); const k = `%${keyword}%`; p.push(k, k, k); }
  const c = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const [r] = await getPool().query(`SELECT * FROM elders ${c} ORDER BY id DESC`, p); return r.map(mapElder);
}
async function getElderById(id) { const [r] = await getPool().query('SELECT * FROM elders WHERE id=?', [id]); return mapElder(r[0]); }
async function getElderByCode(code) { const [r] = await getPool().query('SELECT * FROM elders WHERE code=?', [code]); return mapElder(r[0]); }
async function createElder(d) {
  const [x] = await getPool().query('INSERT INTO elders (code,name,gender,age,phone,subsidy_level,identities,dietary,canteen_id,status) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [d.code, d.name, d.gender || 'U', d.age || 0, d.phone || '', d.subsidyLevel || 'C', d.identities || '', d.dietary || '', d.canteenId ?? null, d.status || 'ACTIVE']);
  return getElderById(x.insertId);
}
async function updateElder(id, d) {
  const map = { name: 'name', gender: 'gender', age: 'age', phone: 'phone', subsidyLevel: 'subsidy_level', identities: 'identities', dietary: 'dietary', canteenId: 'canteen_id', status: 'status' };
  const sets = []; const p = [];
  for (const [k, col] of Object.entries(map)) if (d[k] !== undefined) { sets.push(`${col}=?`); p.push(d[k]); }
  if (sets.length) { sets.push('updated_at=CURRENT_TIMESTAMP(3)'); p.push(id); await getPool().query(`UPDATE elders SET ${sets.join(',')} WHERE id=?`, p); }
  return getElderById(id);
}
async function deleteElder(id) { const [x] = await getPool().query('DELETE FROM elders WHERE id=?', [id]); return x.affectedRows > 0; }

/* ----------------------------- 餐次 ----------------------------- */
async function listMeals({ canteenId, serveDate, mealType, status } = {}) {
  const w = []; const p = [];
  if (canteenId !== undefined) { w.push('canteen_id=?'); p.push(canteenId); }
  if (serveDate) { w.push('serve_date=?'); p.push(serveDate); }
  if (mealType) { w.push('meal_type=?'); p.push(mealType); }
  if (status) { w.push('status=?'); p.push(status); }
  const c = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const [r] = await getPool().query(`SELECT * FROM meals ${c} ORDER BY serve_date DESC, id DESC`, p); return r.map(mapMeal);
}
async function getMealById(id) { const [r] = await getPool().query('SELECT * FROM meals WHERE id=?', [id]); return mapMeal(r[0]); }
async function createMeal(d) {
  const [x] = await getPool().query('INSERT INTO meals (canteen_id,serve_date,meal_type,dish_name,price_cents,status) VALUES (?,?,?,?,?,?)',
    [d.canteenId, d.serveDate, d.mealType || 'LUNCH', d.dishName, d.priceCents || 0, d.status || 'PUBLISHED']);
  return getMealById(x.insertId);
}
async function updateMeal(id, d) {
  const map = { serveDate: 'serve_date', mealType: 'meal_type', dishName: 'dish_name', priceCents: 'price_cents', status: 'status' };
  const sets = []; const p = [];
  for (const [k, col] of Object.entries(map)) if (d[k] !== undefined) { sets.push(`${col}=?`); p.push(d[k]); }
  if (sets.length) { sets.push('updated_at=CURRENT_TIMESTAMP(3)'); p.push(id); await getPool().query(`UPDATE meals SET ${sets.join(',')} WHERE id=?`, p); }
  return getMealById(id);
}
async function deleteMeal(id) { const [x] = await getPool().query('DELETE FROM meals WHERE id=?', [id]); return x.affectedRows > 0; }

/* ----------------------------- 订餐 ----------------------------- */
async function listOrders({ elderId, mealId, status } = {}) {
  const w = []; const p = [];
  if (elderId !== undefined) { w.push('elder_id=?'); p.push(elderId); }
  if (mealId !== undefined) { w.push('meal_id=?'); p.push(mealId); }
  if (status) { w.push('status=?'); p.push(status); }
  const c = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const [r] = await getPool().query(`SELECT * FROM orders ${c} ORDER BY id DESC`, p); return r.map(mapOrder);
}
async function getOrderById(id) { const [r] = await getPool().query('SELECT * FROM orders WHERE id=?', [id]); return mapOrder(r[0]); }
async function createOrder(d) {
  const [x] = await getPool().query('INSERT INTO orders (elder_id,meal_id,dining_type,qty,amount_cents,subsidy_cents,pay_cents,status) VALUES (?,?,?,?,?,?,?,?)',
    [d.elderId, d.mealId, d.diningType || 'DINE_IN', d.qty || 1, d.amountCents || 0, d.subsidyCents || 0, d.payCents || 0, d.status || 'RESERVED']);
  return getOrderById(x.insertId);
}
async function updateOrder(id, d) {
  const map = { diningType: 'dining_type', qty: 'qty', amountCents: 'amount_cents', subsidyCents: 'subsidy_cents', payCents: 'pay_cents', status: 'status' };
  const sets = []; const p = [];
  for (const [k, col] of Object.entries(map)) if (d[k] !== undefined) { sets.push(`${col}=?`); p.push(d[k]); }
  if (sets.length) { sets.push('updated_at=CURRENT_TIMESTAMP(3)'); p.push(id); await getPool().query(`UPDATE orders SET ${sets.join(',')} WHERE id=?`, p); }
  return getOrderById(id);
}

/* ----------------------------- 补贴规则 ----------------------------- */
function mapSubsidyRule(r) {
  if (!r) return null;
  return { id: r.id, code: r.code, name: r.name, ruleType: r.rule_type, priority: r.priority, conditionJson: r.condition_json, amountCents: r.amount_cents, percent: r.percent, mealTypes: r.meal_types, isHoliday: r.is_holiday, status: r.status, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, createdAt: r.created_at, updatedAt: r.updated_at };
}
async function listSubsidyRules({ ruleType, status, effectiveDate } = {}) {
  const w = []; const p = [];
  if (ruleType) { w.push('rule_type=?'); p.push(ruleType); }
  if (status) { w.push('status=?'); p.push(status); }
  if (effectiveDate) { w.push('effective_from<=? AND (effective_to IS NULL OR effective_to>=?)'); p.push(effectiveDate, effectiveDate); }
  const c = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const [r] = await getPool().query(`SELECT * FROM subsidy_rules ${c} ORDER BY priority ASC, id ASC`, p); return r.map(mapSubsidyRule);
}
async function getSubsidyRuleById(id) { const [r] = await getPool().query('SELECT * FROM subsidy_rules WHERE id=?', [id]); return mapSubsidyRule(r[0]); }
async function getSubsidyRuleByCode(code) { const [r] = await getPool().query('SELECT * FROM subsidy_rules WHERE code=?', [code]); return mapSubsidyRule(r[0]); }
async function createSubsidyRule(d) {
  const [x] = await getPool().query('INSERT INTO subsidy_rules (code,name,rule_type,priority,condition_json,amount_cents,percent,meal_types,is_holiday,status,effective_from,effective_to) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [d.code, d.name, d.ruleType, d.priority || 0, d.conditionJson ? JSON.stringify(d.conditionJson) : null, d.amountCents || 0, d.percent || 0, d.mealTypes || '', d.isHoliday ? 1 : 0, d.status || 'ACTIVE', d.effectiveFrom, d.effectiveTo || null]);
  return getSubsidyRuleById(x.insertId);
}
async function updateSubsidyRule(id, d) {
  const map = { name: 'name', ruleType: 'rule_type', priority: 'priority', amountCents: 'amount_cents', percent: 'percent', mealTypes: 'meal_types', isHoliday: 'is_holiday', status: 'status', effectiveFrom: 'effective_from', effectiveTo: 'effective_to' };
  const sets = []; const p = [];
  for (const [k, col] of Object.entries(map)) if (d[k] !== undefined) { sets.push(`${col}=?`); p.push(d[k]); }
  if (d.conditionJson !== undefined) { sets.push('condition_json=?'); p.push(d.conditionJson ? JSON.stringify(d.conditionJson) : null); }
  if (sets.length) { sets.push('updated_at=CURRENT_TIMESTAMP(3)'); p.push(id); await getPool().query(`UPDATE subsidy_rules SET ${sets.join(',')} WHERE id=?`, p); }
  return getSubsidyRuleById(id);
}
async function deleteSubsidyRule(id) { const [x] = await getPool().query('DELETE FROM subsidy_rules WHERE id=?', [id]); return x.affectedRows > 0; }

/* ----------------------------- 订单补贴明细 ----------------------------- */
function mapOrderSubsidyDetail(r) {
  if (!r) return null;
  return { id: r.id, orderId: r.order_id, ruleId: r.rule_id, ruleCode: r.rule_code, ruleName: r.rule_name, ruleType: r.rule_type, amountCents: r.amount_cents, createdAt: r.created_at };
}
async function listOrderSubsidyDetails({ orderId } = {}) {
  const w = []; const p = [];
  if (orderId !== undefined) { w.push('order_id=?'); p.push(orderId); }
  const c = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const [r] = await getPool().query(`SELECT * FROM order_subsidy_details ${c} ORDER BY id ASC`, p); return r.map(mapOrderSubsidyDetail);
}
async function createOrderSubsidyDetail(d) {
  const [x] = await getPool().query('INSERT INTO order_subsidy_details (order_id,rule_id,rule_code,rule_name,rule_type,amount_cents) VALUES (?,?,?,?,?,?)',
    [d.orderId, d.ruleId, d.ruleCode, d.ruleName, d.ruleType, d.amountCents || 0]);
  const [r] = await getPool().query('SELECT * FROM order_subsidy_details WHERE id=?', [x.insertId]);
  return mapOrderSubsidyDetail(r[0]);
}
async function deleteOrderSubsidyDetailsByOrderId(orderId) {
  const [x] = await getPool().query('DELETE FROM order_subsidy_details WHERE order_id=?', [orderId]);
  return x.affectedRows;
}

/* ----------------------------- 月度补贴使用累计 ----------------------------- */
function mapMonthlySubsidyUsage(r) {
  if (!r) return null;
  return { id: r.id, elderId: r.elder_id, month: r.month, usedCents: r.used_cents, capCents: r.cap_cents, createdAt: r.created_at, updatedAt: r.updated_at };
}
async function getMonthlySubsidyUsage(elderId, month) {
  const [r] = await getPool().query('SELECT * FROM monthly_subsidy_usage WHERE elder_id=? AND month=?', [elderId, month]);
  return mapMonthlySubsidyUsage(r[0]);
}
async function listMonthlySubsidyUsage({ elderId, month } = {}) {
  const w = []; const p = [];
  if (elderId !== undefined) { w.push('elder_id=?'); p.push(elderId); }
  if (month) { w.push('month=?'); p.push(month); }
  const c = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const [r] = await getPool().query(`SELECT * FROM monthly_subsidy_usage ${c} ORDER BY month DESC, elder_id ASC`, p); return r.map(mapMonthlySubsidyUsage);
}
async function upsertMonthlySubsidyUsage(elderId, month, deltaCents, capCents) {
  await getPool().query(`INSERT INTO monthly_subsidy_usage (elder_id,month,used_cents,cap_cents) VALUES (?,?,?,?)
    ON DUPLICATE KEY UPDATE used_cents=used_cents+?, cap_cents=?, updated_at=CURRENT_TIMESTAMP(3)`,
    [elderId, month, deltaCents, capCents, deltaCents, capCents]);
  return getMonthlySubsidyUsage(elderId, month);
}

/* ----------------------------- 带关联的订单查询（用于结算） ----------------------------- */
async function listOrdersWithDetails({ elderId, month, canteenId, status } = {}) {
  const w = []; const p = [];
  w.push('o.status != ?'); p.push('CANCELLED');
  if (elderId !== undefined) { w.push('o.elder_id=?'); p.push(elderId); }
  if (canteenId !== undefined) { w.push('m.canteen_id=?'); p.push(canteenId); }
  if (status) { w.push('o.status=?'); p.push(status); }
  if (month) { w.push('DATE_FORMAT(m.serve_date, "%Y-%m")=?'); p.push(month); }
  const c = `WHERE ${w.join(' AND ')}`;
  const sql = `SELECT o.*, m.serve_date, m.meal_type, m.price_cents AS meal_price, m.canteen_id, e.subsidy_level, e.identities
    FROM orders o
    INNER JOIN meals m ON o.meal_id = m.id
    INNER JOIN elders e ON o.elder_id = e.id
    ${c}
    ORDER BY m.serve_date ASC, o.id ASC`;
  const [r] = await getPool().query(sql, p);
  return r.map((row) => ({
    id: row.id, elderId: row.elder_id, mealId: row.meal_id, diningType: row.dining_type,
    qty: row.qty, amountCents: row.amount_cents, subsidyCents: row.subsidy_cents,
    payCents: row.pay_cents, status: row.status, createdAt: row.created_at,
    serveDate: row.serve_date, mealType: row.meal_type, mealPriceCents: row.meal_price,
    canteenId: row.canteen_id, subsidyLevel: row.subsidy_level, identities: row.identities,
  }));
}

/* ----------------------------- 结算单 ----------------------------- */
function mapSettlementSheet(r) {
  if (!r) return null;
  return { id: r.id, month: r.month, canteenId: r.canteen_id, sheetType: r.sheet_type, groupKey: r.group_key, groupValue: r.group_value, orderCount: r.order_count, totalAmountCents: r.total_amount_cents, totalSubsidyCents: r.total_subsidy_cents, totalPayCents: r.total_pay_cents, status: r.status, snapshotRules: r.snapshot_rules, createdAt: r.created_at, updatedAt: r.updated_at };
}
async function listSettlementSheets({ month, canteenId, sheetType, status } = {}) {
  const w = []; const p = [];
  if (month) { w.push('month=?'); p.push(month); }
  if (canteenId !== undefined) { w.push('canteen_id=?'); p.push(canteenId); }
  if (sheetType) { w.push('sheet_type=?'); p.push(sheetType); }
  if (status) { w.push('status=?'); p.push(status); }
  const c = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const [r] = await getPool().query(`SELECT * FROM settlement_sheets ${c} ORDER BY month DESC, id ASC`, p); return r.map(mapSettlementSheet);
}
async function getSettlementSheetById(id) { const [r] = await getPool().query('SELECT * FROM settlement_sheets WHERE id=?', [id]); return mapSettlementSheet(r[0]); }
async function createSettlementSheet(d) {
  const [x] = await getPool().query('INSERT INTO settlement_sheets (month,canteen_id,sheet_type,group_key,group_value,order_count,total_amount_cents,total_subsidy_cents,total_pay_cents,status,snapshot_rules) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [d.month, d.canteenId ?? null, d.sheetType, d.groupKey, d.groupValue, d.orderCount || 0, d.totalAmountCents || 0, d.totalSubsidyCents || 0, d.totalPayCents || 0, d.status || 'DRAFT', d.snapshotRules ? JSON.stringify(d.snapshotRules) : null]);
  return getSettlementSheetById(x.insertId);
}
async function updateSettlementSheet(id, d) {
  const map = { status: 'status' };
  const sets = []; const p = [];
  for (const [k, col] of Object.entries(map)) if (d[k] !== undefined) { sets.push(`${col}=?`); p.push(d[k]); }
  if (sets.length) { sets.push('updated_at=CURRENT_TIMESTAMP(3)'); p.push(id); await getPool().query(`UPDATE settlement_sheets SET ${sets.join(',')} WHERE id=?`, p); }
  return getSettlementSheetById(id);
}
async function deleteSettlementSheetsByMonth(month) {
  const [x] = await getPool().query('DELETE FROM settlement_sheets WHERE month=?', [month]);
  return x.affectedRows;
}

/* ----------------------------- 结算勾稽差异 ----------------------------- */
function mapSettlementDiscrepancy(r) {
  if (!r) return null;
  return { id: r.id, settlementId: r.settlement_id, orderId: r.order_id, issueType: r.issue_type, expectedCents: r.expected_cents, actualCents: r.actual_cents, diffCents: r.diff_cents, description: r.description, resolved: r.resolved, createdAt: r.created_at };
}
async function listSettlementDiscrepancies({ settlementId, resolved } = {}) {
  const w = []; const p = [];
  if (settlementId !== undefined) { w.push('settlement_id=?'); p.push(settlementId); }
  if (resolved !== undefined) { w.push('resolved=?'); p.push(resolved ? 1 : 0); }
  const c = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const [r] = await getPool().query(`SELECT * FROM settlement_discrepancies ${c} ORDER BY id ASC`, p); return r.map(mapSettlementDiscrepancy);
}
async function createSettlementDiscrepancy(d) {
  const [x] = await getPool().query('INSERT INTO settlement_discrepancies (settlement_id,order_id,issue_type,expected_cents,actual_cents,diff_cents,description) VALUES (?,?,?,?,?,?,?)',
    [d.settlementId, d.orderId, d.issueType, d.expectedCents || 0, d.actualCents || 0, d.diffCents || 0, d.description || '']);
  const [r] = await getPool().query('SELECT * FROM settlement_discrepancies WHERE id=?', [x.insertId]);
  return mapSettlementDiscrepancy(r[0]);
}
async function resolveSettlementDiscrepancy(id) {
  await getPool().query('UPDATE settlement_discrepancies SET resolved=1 WHERE id=?', [id]);
  const [r] = await getPool().query('SELECT * FROM settlement_discrepancies WHERE id=?', [id]);
  return mapSettlementDiscrepancy(r[0]);
}

/* ----------------------------- 月度结算锁定 ----------------------------- */
function mapMonthlySettlementLock(r) {
  if (!r) return null;
  return { id: r.id, month: r.month, lockedBy: r.locked_by, lockedAt: r.locked_at, remark: r.remark };
}
async function getMonthlySettlementLock(month) { const [r] = await getPool().query('SELECT * FROM monthly_settlement_locks WHERE month=?', [month]); return mapMonthlySettlementLock(r[0]); }
async function listMonthlySettlementLocks() {
  const [r] = await getPool().query('SELECT * FROM monthly_settlement_locks ORDER BY month DESC');
  return r.map(mapMonthlySettlementLock);
}
async function lockMonthSettlement(month, lockedBy, remark = '') {
  const [x] = await getPool().query('INSERT INTO monthly_settlement_locks (month,locked_by,remark) VALUES (?,?,?)', [month, lockedBy, remark]);
  return getMonthlySettlementLock(month);
}
async function isMonthLocked(month) {
  const lock = await getMonthlySettlementLock(month);
  return !!lock;
}

module.exports = {
  mapUser, mapCanteen, mapElder, mapMeal, mapOrder,
  mapSubsidyRule, mapOrderSubsidyDetail, mapMonthlySubsidyUsage, mapSettlementSheet, mapSettlementDiscrepancy, mapMonthlySettlementLock,
  getUserByUsername, getUserById, listUsers, createUser, updateUser, deleteUser, countUsers,
  listCanteens, getCanteenById, getCanteenByCode, createCanteen, updateCanteen, deleteCanteen,
  listElders, getElderById, getElderByCode, createElder, updateElder, deleteElder,
  listMeals, getMealById, createMeal, updateMeal, deleteMeal,
  listOrders, getOrderById, createOrder, updateOrder, listOrdersWithDetails,
  listSubsidyRules, getSubsidyRuleById, getSubsidyRuleByCode, createSubsidyRule, updateSubsidyRule, deleteSubsidyRule,
  listOrderSubsidyDetails, createOrderSubsidyDetail, deleteOrderSubsidyDetailsByOrderId,
  getMonthlySubsidyUsage, listMonthlySubsidyUsage, upsertMonthlySubsidyUsage,
  listSettlementSheets, getSettlementSheetById, createSettlementSheet, updateSettlementSheet, deleteSettlementSheetsByMonth,
  listSettlementDiscrepancies, createSettlementDiscrepancy, resolveSettlementDiscrepancy,
  getMonthlySettlementLock, listMonthlySettlementLocks, lockMonthSettlement, isMonthLocked,
};

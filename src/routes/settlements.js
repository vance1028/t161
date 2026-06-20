'use strict';

const express = require('express');
const store = require('../data/store');
const { authRequired, requireRole } = require('../auth');
const { sendData, sendError, parseId } = require('../utils/http');
const {
  calculateOrderSubsidy,
  aggregateSettlementByGroup,
  checkDiscrepancies,
  recalculateMonthOrders,
  getMonthKey,
  extractCapRules,
  toDateStr,
} = require('../utils/subsidy-calculator');

const router = express.Router();
router.use(authRequired);

async function getContextForMonth(month) {
  const firstDay = `${month}-01`;
  const rules = await store.listSubsidyRules({ status: 'ACTIVE', effectiveDate: firstDay });
  const capRules = extractCapRules(rules);
  const holidays = await store.listHolidayDatesByMonth(month);
  const orders = await store.listOrdersWithDetails({ month, includeCancelled: true });
  const elders = await store.listElders();
  const meals = await store.listMeals();
  return { rules, capRules, holidays, orders, elders, meals };
}

/* ---------- 静态路径：放在 :id 路由之前，防止被动态 id 抢占 ---------- */

router.get('/locks', async (req, res, next) => {
  try {
    return sendData(res, 200, await store.listMonthlySettlementLocks());
  } catch (e) { return next(e); }
});

router.get('/locks/:month', async (req, res, next) => {
  try {
    const { month } = req.params;
    const locked = await store.isMonthLocked(month);
    const lock = await store.getMonthlySettlementLock(month);
    return sendData(res, 200, { month, locked, lock: lock || null });
  } catch (e) { return next(e); }
});

router.post('/locks/:month', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const { month } = req.params;
    const { remark = '' } = req.body || {};
    if (!/^\d{4}-\d{2}$/.test(month)) return sendError(res, 400, '月份格式不正确，应为 YYYY-MM');
    if (await store.isMonthLocked(month)) return sendError(res, 409, '该月份已锁定');
    const lock = await store.lockMonthSettlement(month, req.user.id, remark);
    return sendData(res, 201, lock);
  } catch (e) { return next(e); }
});

router.get('/holidays', async (req, res, next) => {
  try {
    const { year, month, from, to } = req.query;
    return sendData(res, 200, await store.listHolidays({ year, month, from, to }));
  } catch (e) { return next(e); }
});

router.post('/holidays', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { holidayDate, name } = req.body || {};
    if (!holidayDate) return sendError(res, 400, '节假日日期不能为空');
    const d = toDateStr(holidayDate);
    if (await store.getHolidayByDate(d)) return sendError(res, 409, '该日期已存在');
    return sendData(res, 201, await store.createHoliday({ holidayDate: d, name }));
  } catch (e) { return next(e); }
});

router.delete('/holidays/:id', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const deleted = await store.deleteHoliday(id);
    return sendData(res, 200, { id, deleted });
  } catch (e) { return next(e); }
});

router.post('/generate', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { month, holidays: extraHolidays = [] } = req.body || {};
    if (!month) return sendError(res, 400, '月份不能为空');
    if (!/^\d{4}-\d{2}$/.test(month)) return sendError(res, 400, '月份格式不正确，应为 YYYY-MM');
    if (await store.isMonthLocked(month)) return sendError(res, 409, '该月份已锁定，不能重新生成结算单');

    const ctx = await getContextForMonth(month);
    const allHolidays = Array.from(new Set([...ctx.holidays, ...(extraHolidays || []).map(toDateStr)]));

    const discrepancies = checkDiscrepancies(
      ctx.orders, ctx.rules, ctx.elders, ctx.meals, allHolidays
    );

    await store.deleteSettlementSheetsByMonth(month);

    const byCanteen = aggregateSettlementByGroup(ctx.orders, (o) => `CANTEEN_${o.canteenId}`);
    const byLevel = aggregateSettlementByGroup(ctx.orders, (o) => `LEVEL_${o.subsidyLevel || 'C'}`);
    const byIdentity = aggregateSettlementByGroup(ctx.orders, (o) => {
      const identities = (o.identities || '').split(',').map((s) => s.trim()).filter(Boolean);
      return `ID_${identities.length > 0 ? identities.join('|') : 'NONE'}`;
    });

    const snapshot = {
      rules: ctx.rules,
      capRules: ctx.capRules,
      holidays: allHolidays,
      generatedAt: new Date().toISOString(),
    };

    let totalSubsidy = 0, totalPay = 0, totalAmount = 0, totalCount = 0;
    for (const [, agg] of byCanteen) {
      totalSubsidy += agg.totalSubsidyCents;
      totalPay += agg.totalPayCents;
      totalAmount += agg.totalAmountCents;
      totalCount += agg.orderCount;
    }

    // 总单：SUMMARY 类型，承载所有差异记录
    const summarySheet = await store.createSettlementSheet({
      month,
      sheetType: 'SUMMARY',
      groupKey: 'summary',
      groupValue: '月度汇总',
      orderCount: totalCount,
      totalAmountCents: totalAmount,
      totalSubsidyCents: totalSubsidy,
      totalPayCents: totalPay,
      status: 'DRAFT',
      snapshotRules: snapshot,
    });

    const detailSheets = [];

    for (const [key, agg] of byCanteen) {
      const cidMatch = key.match(/^CANTEEN_(\d+)$/);
      const cid = cidMatch ? Number(cidMatch[1]) : null;
      const canteen = cid ? await store.getCanteenById(cid) : null;
      const sheet = await store.createSettlementSheet({
        month,
        canteenId: cid,
        sheetType: 'BY_CANTEEN',
        groupKey: 'canteen',
        groupValue: canteen ? canteen.name : (cid ? `助餐点${cid}` : '未知'),
        orderCount: agg.orderCount,
        totalAmountCents: agg.totalAmountCents,
        totalSubsidyCents: agg.totalSubsidyCents,
        totalPayCents: agg.totalPayCents,
        status: 'DRAFT',
        snapshotRules: snapshot,
      });
      detailSheets.push(sheet);
    }

    for (const [key, agg] of byLevel) {
      const level = (key.match(/^LEVEL_(.+)$/) || [])[1] || 'C';
      const sheet = await store.createSettlementSheet({
        month,
        sheetType: 'BY_LEVEL',
        groupKey: 'subsidyLevel',
        groupValue: level,
        orderCount: agg.orderCount,
        totalAmountCents: agg.totalAmountCents,
        totalSubsidyCents: agg.totalSubsidyCents,
        totalPayCents: agg.totalPayCents,
        status: 'DRAFT',
        snapshotRules: snapshot,
      });
      detailSheets.push(sheet);
    }

    for (const [key, agg] of byIdentity) {
      const idv = (key.match(/^ID_(.+)$/) || [])[1] || 'NONE';
      const sheet = await store.createSettlementSheet({
        month,
        sheetType: 'BY_IDENTITY',
        groupKey: 'identities',
        groupValue: idv,
        orderCount: agg.orderCount,
        totalAmountCents: agg.totalAmountCents,
        totalSubsidyCents: agg.totalSubsidyCents,
        totalPayCents: agg.totalPayCents,
        status: 'DRAFT',
        snapshotRules: snapshot,
      });
      detailSheets.push(sheet);
    }

    const allSheets = [summarySheet, ...detailSheets];

    const discrepancyMap = new Map();
    for (const d of discrepancies) {
      if (!discrepancyMap.has(d.issueType)) discrepancyMap.set(d.issueType, []);
      discrepancyMap.get(d.issueType).push(d);
    }

    // 差异记录统一挂在 SUMMARY 总单下
    for (const d of discrepancies) {
      await store.createSettlementDiscrepancy({
        settlementId: summarySheet.id,
        orderId: d.orderId,
        issueType: d.issueType,
        expectedCents: d.expectedCents,
        actualCents: d.actualCents,
        diffCents: d.diffCents,
        description: d.description,
      });
    }

    return sendData(res, 200, {
      month,
      summary: summarySheet,
      sheets: allSheets,
      detailSheetCount: detailSheets.length,
      discrepancyCount: discrepancies.length,
      discrepancyByType: Object.fromEntries(
        Array.from(discrepancyMap.entries()).map(([k, v]) => [k, v.length])
      ),
      orderCount: ctx.orders.length,
      effectiveOrderCount: totalCount,
      totals: {
        totalAmountCents: totalAmount,
        totalSubsidyCents: totalSubsidy,
        totalPayCents: totalPay,
      },
      capRules: ctx.capRules,
      holidayCount: allHolidays.length,
    });
  } catch (e) { return next(e); }
});

router.post('/recalc', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const { month, holidays: extraHolidays = [] } = req.body || {};
    if (!month) return sendError(res, 400, '月份不能为空');
    if (!/^\d{4}-\d{2}$/.test(month)) return sendError(res, 400, '月份格式不正确，应为 YYYY-MM');
    if (await store.isMonthLocked(month)) return sendError(res, 409, '该月份已锁定，不能重算');

    const ctx = await getContextForMonth(month);
    const allHolidays = Array.from(new Set([...ctx.holidays, ...(extraHolidays || []).map(toDateStr)]));

    const results = recalculateMonthOrders(
      ctx.orders, ctx.rules, ctx.elders, ctx.meals, allHolidays
    );

    const totalDiff = results.reduce((sum, r) => sum + Math.abs(r.diff.subsidyCents || 0), 0);
    const affectedCount = results.filter((r) =>
      r.diff.subsidyCents !== 0 || r.diff.payCents !== 0 || r.diff.amountCents !== 0
    ).length;

    const cancels = results.filter((r) => r.orderStatus === 'CANCELLED');
    const cancelledWithSubsidy = cancels.filter((r) => r.original.subsidyCents !== 0).length;

    return sendData(res, 200, {
      month,
      totalOrders: results.length,
      affectedCount,
      cancelledOrders: cancels.length,
      cancelledWithSubsidy,
      totalDiffCents: totalDiff,
      details: results.slice(0, 500),
      truncation: results.length > 500 ? results.length - 500 : 0,
      rules: ctx.rules,
      capRules: ctx.capRules,
      holidayCount: allHolidays.length,
    });
  } catch (e) { return next(e); }
});

router.get('/preview/order', async (req, res, next) => {
  try {
    const { elderId, mealId, qty = 1 } = req.query;
    if (!elderId || !mealId) return sendError(res, 400, '长者和餐次不能为空');

    const elder = await store.getElderById(Number(elderId));
    const meal = await store.getMealById(Number(mealId));
    if (!elder || !meal) return sendError(res, 400, '长者或餐次不存在');

    const month = getMonthKey(meal.serveDate);
    const firstDay = `${month}-01`;
    const rules = await store.listSubsidyRules({ status: 'ACTIVE', effectiveDate: firstDay });
    const usage = await store.getMonthlySubsidyUsage(Number(elderId), month);
    const capRules = extractCapRules(rules);
    const capCents = Number(capRules[elder.subsidyLevel] || 0);

    const allHolidays = await store.listHolidayDatesByMonth(month);
    const isHoliday = allHolidays.includes(toDateStr(meal.serveDate));

    const calc = calculateOrderSubsidy({
      elder,
      meal,
      qty: Number(qty) || 1,
      rules,
      isHoliday,
      monthlyUsedCents: usage?.usedCents || 0,
      monthlyCapCents: capCents,
      orderDate: meal.serveDate,
    });

    return sendData(res, 200, {
      ...calc,
      isHoliday,
      holidays: allHolidays,
      capRules,
    });
  } catch (e) { return next(e); }
});

router.get('/monthly-usage/:elderId/:month', async (req, res, next) => {
  try {
    const { elderId, month } = req.params;
    const eid = Number(elderId);
    const usage = await store.getMonthlySubsidyUsage(eid, month);
    const elder = await store.getElderById(eid);

    let capCents = 0;
    if (elder) {
      const firstDay = `${month}-01`;
      const rules = await store.listSubsidyRules({ status: 'ACTIVE', effectiveDate: firstDay });
      const capRules = extractCapRules(rules);
      capCents = Number(capRules[elder.subsidyLevel] || 0);
    }

    const usedCents = usage?.usedCents || 0;
    let status = 'NORMAL';
    if (capCents > 0) {
      if (usedCents >= capCents) status = 'CAP_REACHED';
      else if (usedCents >= capCents * 0.9) status = 'CAP_NEAR';
    }

    return sendData(res, 200, {
      elderId: eid,
      month,
      elderSubsidyLevel: elder?.subsidyLevel || 'C',
      usedCents,
      capCents,
      remainingCents: Math.max(0, capCents - usedCents),
      status,
    });
  } catch (e) { return next(e); }
});

/* ---------- 动态 id 路由：放在所有静态路径之后 ---------- */

router.get('/', async (req, res, next) => {
  try {
    const { month, canteenId, sheetType, status } = req.query;
    const f = {};
    if (month) f.month = month;
    if (canteenId !== undefined && canteenId !== '') f.canteenId = Number(canteenId);
    if (sheetType) f.sheetType = sheetType;
    if (status) f.status = status;
    return sendData(res, 200, await store.listSettlementSheets(f));
  } catch (e) { return next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const s = await store.getSettlementSheetById(id);
    if (!s) return sendError(res, 404, '结算单不存在');
    const discrepancies = await store.listSettlementDiscrepancies({ settlementId: id });
    return sendData(res, 200, { ...s, discrepancies });
  } catch (e) { return next(e); }
});

router.post('/:id/confirm', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const s = await store.getSettlementSheetById(id);
    if (!s) return sendError(res, 404, '结算单不存在');
    if (await store.isMonthLocked(s.month)) return sendError(res, 409, '该月份已锁定');
    const updated = await store.updateSettlementSheet(id, { status: 'CONFIRMED' });

    let lock = null;
    // 确认 SUMMARY 总单后自动锁定整个月
    if (s.sheetType === 'SUMMARY' && !(await store.isMonthLocked(s.month))) {
      lock = await store.lockMonthSettlement(s.month, req.user.id, '结算单确认后自动锁定');
    }
    return sendData(res, 200, { ...updated, monthLocked: !!lock, lock: lock || null });
  } catch (e) { return next(e); }
});

router.post('/:id/discrepancies/:discId/resolve', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const discId = parseId(req.params.discId);
    return sendData(res, 200, await store.resolveSettlementDiscrepancy(discId));
  } catch (e) { return next(e); }
});

module.exports = router;

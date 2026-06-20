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
} = require('../utils/subsidy-calculator');

const router = express.Router();
router.use(authRequired);

const MONTHLY_CAP_RULES = {
  A: 30000,
  B: 20000,
  C: 10000,
};

router.get('/', async (req, res, next) => {
  try {
    const { month, canteenId, sheetType, status } = req.query;
    const f = {};
    if (month) f.month = month;
    if (canteenId !== undefined) f.canteenId = Number(canteenId);
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

router.post('/generate', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { month, holidays = [] } = req.body || {};
    if (!month) return sendError(res, 400, '月份不能为空');
    if (await store.isMonthLocked(month)) return sendError(res, 409, '该月份已锁定，不能重新生成结算单');

    const rules = await store.listSubsidyRules({ status: 'ACTIVE', effectiveDate: `${month}-01` });
    const orders = await store.listOrdersWithDetails({ month });
    const elders = await store.listElders();
    const meals = await store.listMeals();

    const discrepancies = checkDiscrepancies(orders, rules, elders, meals, MONTHLY_CAP_RULES, holidays);

    await store.deleteSettlementSheetsByMonth(month);

    const byCanteen = aggregateSettlementByGroup(orders, (o) => String(o.canteenId));
    const byLevel = aggregateSettlementByGroup(orders, (o) => o.subsidyLevel || 'C');
    constByIdentity = aggregateSettlementByGroup(orders, (o) => {
      const identities = (o.identities || '').split(',').filter(Boolean);
      return identities.length > 0 ? identities.join(',') : 'NONE';
    });

    const results = [];
    const snapshot = { rules, capRules: MONTHLY_CAP_RULES, holidays };

    for (const [canteenId, agg] of byCanteen) {
      const canteen = await store.getCanteenById(Number(canteenId));
      const sheet = await store.createSettlementSheet({
        month,
        canteenId: Number(canteenId),
        sheetType: 'BY_CANTEEN',
        groupKey: 'canteen',
        groupValue: canteen?.name || `未知助餐点(${canteenId})`,
        orderCount: agg.orderCount,
        totalAmountCents: agg.totalAmountCents,
        totalSubsidyCents: agg.totalSubsidyCents,
        totalPayCents: agg.totalPayCents,
        status: 'DRAFT',
        snapshotRules: snapshot,
      });
      results.push(sheet);
    }

    for (const [level, agg] of byLevel) {
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
      results.push(sheet);
    }

    for (const [identity, agg] of byIdentity) {
      const sheet = await store.createSettlementSheet({
        month,
        sheetType: 'BY_IDENTITY',
        groupKey: 'identities',
        groupValue: identity,
        orderCount: agg.orderCount,
        totalAmountCents: agg.totalAmountCents,
        totalSubsidyCents: agg.totalSubsidyCents,
        totalPayCents: agg.totalPayCents,
        status: 'DRAFT',
        snapshotRules: snapshot,
      });
      results.push(sheet);
    }

    if (discrepancies.length > 0 && results.length > 0) {
      const settlementId = results[0].id;
      for (const d of discrepancies) {
        await store.createSettlementDiscrepancy({
          settlementId,
          orderId: d.orderId,
          issueType: d.issueType,
          expectedCents: d.expectedCents,
          actualCents: d.actualCents,
          diffCents: d.diffCents,
          description: d.description,
        });
      }
    }

    return sendData(res, 200, {
      sheets: results,
      discrepancyCount: discrepancies.length,
      orderCount: orders.length,
    });
  } catch (e) { return next(e); }
});

router.post('/:id/confirm', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const s = await store.getSettlementSheetById(id);
    if (!s) return sendError(res, 404, '结算单不存在');
    if (await store.isMonthLocked(s.month)) return sendError(res, 409, '该月份已锁定');
    return sendData(res, 200, await store.updateSettlementSheet(id, { status: 'CONFIRMED' }));
  } catch (e) { return next(e); }
});

router.post('/:id/discrepancies/:discId/resolve', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const discId = parseId(req.params.discId);
    return sendData(res, 200, await store.resolveSettlementDiscrepancy(discId));
  } catch (e) { return next(e); }
});

router.get('/locks', async (req, res, next) => {
  try {
    return sendData(res, 200, await store.listMonthlySettlementLocks());
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

router.get('/locks/:month', async (req, res, next) => {
  try {
    const { month } = req.params;
    const locked = await store.isMonthLocked(month);
    const lock = await store.getMonthlySettlementLock(month);
    return sendData(res, 200, { month, locked, lock });
  } catch (e) { return next(e); }
});

router.post('/recalc', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const { month, holidays = [] } = req.body || {};
    if (!month) return sendError(res, 400, '月份不能为空');
    if (await store.isMonthLocked(month)) return sendError(res, 409, '该月份已锁定，不能重算');

    const rules = await store.listSubsidyRules({ status: 'ACTIVE', effectiveDate: `${month}-01` });
    const orders = await store.listOrdersWithDetails({ month });
    const elders = await store.listElders();
    const meals = await store.listMeals();

    const results = recalculateMonthOrders(orders, rules, elders, meals, MONTHLY_CAP_RULES, holidays);
    const totalDiff = results.reduce((sum, r) => sum + Math.abs(r.diff.subsidyCents), 0);
    const affectedCount = results.filter((r) => r.diff.subsidyCents !== 0).length;

    return sendData(res, 200, {
      month,
      totalOrders: results.length,
      affectedCount,
      totalDiffCents: totalDiff,
      details: results,
      rules,
    });
  } catch (e) { return next(e); }
});

router.get('/preview/order', async (req, res, next) => {
  try {
    const { elderId, mealId, qty = 1, isHoliday = false } = req.query;
    if (!elderId || !mealId) return sendError(res, 400, '长者和餐次不能为空');

    const elder = await store.getElderById(Number(elderId));
    const meal = await store.getMealById(Number(mealId));
    if (!elder || !meal) return sendError(res, 400, '长者或餐次不存在');

    const month = getMonthKey(meal.serveDate);
    const rules = await store.listSubsidyRules({ status: 'ACTIVE', effectiveDate: meal.serveDate });
    const usage = await store.getMonthlySubsidyUsage(Number(elderId), month);
    const capCents = MONTHLY_CAP_RULES[elder.subsidyLevel] || 0;

    const calc = calculateOrderSubsidy({
      elder,
      meal,
      qty: Number(qty) || 1,
      rules,
      isHoliday: isHoliday === 'true',
      monthlyUsedCents: usage?.usedCents || 0,
      monthlyCapCents: capCents,
      orderDate: meal.serveDate,
    });

    return sendData(res, 200, calc);
  } catch (e) { return next(e); }
});

router.get('/monthly-usage/:elderId/:month', async (req, res, next) => {
  try {
    const { elderId, month } = req.params;
    const usage = await store.getMonthlySubsidyUsage(Number(elderId), month);
    const elder = await store.getElderById(Number(elderId));
    const capCents = elder ? (MONTHLY_CAP_RULES[elder.subsidyLevel] || 0) : 0;
    return sendData(res, 200, {
      elderId: Number(elderId),
      month,
      usedCents: usage?.usedCents || 0,
      capCents,
      remainingCents: capCents - (usage?.usedCents || 0),
      status: usage ? (
        usage.usedCents >= capCents ? 'CAP_REACHED' :
        usage.usedCents >= capCents * 0.9 ? 'CAP_NEAR' : 'NORMAL'
      ) : 'NORMAL',
    });
  } catch (e) { return next(e); }
});

module.exports = router;

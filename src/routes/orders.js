'use strict';

const express = require('express');
const store = require('../data/store');
const { authRequired, requireRole } = require('../auth');
const { sendData, sendError, parseId } = require('../utils/http');
const {
  calculateOrderSubsidy,
  getMonthKey,
  extractCapRules,
  toDateStr,
} = require('../utils/subsidy-calculator');

const router = express.Router();
router.use(authRequired);

async function getOrderContext(meal) {
  const serveDate = toDateStr(meal.serveDate || meal.serve_date);
  const month = getMonthKey(serveDate);
  const firstDay = `${month}-01`;
  const rules = await store.listSubsidyRules({ status: 'ACTIVE', effectiveDate: firstDay });
  const capRules = extractCapRules(rules);
  const holidays = await store.listHolidayDatesByMonth(month);
  return { month, firstDay, rules, capRules, holidays, serveDate };
}

router.get('/', async (req, res, next) => {
  try {
    const { elderId, mealId, status } = req.query;
    const f = {};
    if (status) f.status = status;
    if (elderId !== undefined && elderId !== '') f.elderId = Number(elderId);
    if (mealId !== undefined && mealId !== '') f.mealId = Number(mealId);
    const orders = await store.listOrders(f);
    const withDetails = await Promise.all(orders.map(async (o) => {
      const details = await store.listOrderSubsidyDetails({ orderId: o.id });
      return { ...o, subsidyDetails: details };
    }));
    return sendData(res, 200, withDetails);
  } catch (e) { return next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const o = await store.getOrderById(id);
    if (!o) return sendError(res, 404, '订餐记录不存在');
    const details = await store.listOrderSubsidyDetails({ orderId: id });
    return sendData(res, 200, { ...o, subsidyDetails: details });
  } catch (e) { return next(e); }
});

router.post('/', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { elderId, mealId, diningType = 'DINE_IN', qty = 1 } = req.body || {};
    if (elderId === undefined || elderId === null || mealId === undefined || mealId === null) {
      return sendError(res, 400, '长者和餐次不能为空');
    }
    const eid = Number(elderId);
    const mid = Number(mealId);

    const elder = await store.getElderById(eid);
    if (!elder) return sendError(res, 400, '长者不存在');
    const meal = await store.getMealById(mid);
    if (!meal) return sendError(res, 400, '餐次不存在');
    if (meal.status !== 'PUBLISHED') return sendError(res, 409, '该餐次未开放订餐');

    const ctx = await getOrderContext(meal);

    if (await store.isMonthLocked(ctx.month)) {
      return sendError(res, 409, '该月份已结算锁定，不能新增订餐');
    }

    const usage = await store.getMonthlySubsidyUsage(eid, ctx.month);
    const capCents = Number(ctx.capRules[elder.subsidyLevel] || 0);
    const isHoliday = ctx.holidays.includes(ctx.serveDate);

    const calc = calculateOrderSubsidy({
      elder,
      meal,
      qty: Number(qty) || 1,
      rules: ctx.rules,
      isHoliday,
      monthlyUsedCents: usage?.usedCents || 0,
      monthlyCapCents: capCents,
      orderDate: ctx.serveDate,
    });

    const order = await store.createOrder({
      elderId: eid,
      mealId: mid,
      diningType,
      qty: Number(qty) || 1,
      amountCents: calc.amountCents,
      subsidyCents: calc.netSubsidyCents,
      payCents: calc.payCents,
      status: 'RESERVED',
    });

    for (const bd of calc.breakdown) {
      if (!bd.ruleId) continue;
      await store.createOrderSubsidyDetail({
        orderId: order.id,
        ruleId: bd.ruleId,
        ruleCode: bd.ruleCode,
        ruleName: bd.ruleName,
        ruleType: bd.ruleType,
        amountCents: bd.amountCents,
      });
    }

    if (calc.netSubsidyCents > 0) {
      await store.upsertMonthlySubsidyUsage(eid, ctx.month, calc.netSubsidyCents, capCents);
    } else if (capCents > 0) {
      await store.upsertMonthlySubsidyUsage(eid, ctx.month, 0, capCents);
    }

    return sendData(res, 201, {
      ...order,
      subsidyDetails: calc.breakdown,
      monthlyUsage: calc.monthlyUsage,
      isHoliday,
      capCents,
    });
  } catch (e) { return next(e); }
});

router.post('/:id/serve', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const o = await store.getOrderById(id);
    if (!o) return sendError(res, 404, '订餐记录不存在');
    if (o.status !== 'RESERVED') return sendError(res, 409, '该订餐已核销或已取消');
    return sendData(res, 200, await store.updateOrder(id, { status: 'SERVED' }));
  } catch (e) { return next(e); }
});

router.post('/:id/cancel', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const o = await store.getOrderById(id);
    if (!o) return sendError(res, 404, '订餐记录不存在');
    if (o.status === 'SERVED') return sendError(res, 409, '已核销的订餐不能取消');
    if (o.status === 'CANCELLED') return sendError(res, 409, '该订餐已取消');

    const meal = await store.getMealById(o.mealId);
    const serveDate = toDateStr(meal?.serveDate || '');
    const month = meal ? getMonthKey(serveDate) : null;

    if (month && await store.isMonthLocked(month)) {
      return sendError(res, 409, '该月份已结算锁定，不能取消订餐');
    }

    const refundCents = Number(o.subsidyCents || 0);
    const elder = await store.getElderById(o.elderId);

    const updated = await store.updateOrder(id, {
      status: 'CANCELLED',
      subsidyCents: 0,
      payCents: o.amountCents,
    });

    const deletedDetails = await store.deleteOrderSubsidyDetailsByOrderId(id);

    let releasedCents = 0;
    if (month && refundCents > 0) {
      const capCents = elder?.subsidyLevel ? (await (async () => {
        const firstDay = `${month}-01`;
        const rules = await store.listSubsidyRules({ status: 'ACTIVE', effectiveDate: firstDay });
        const capRules = extractCapRules(rules);
        return Number(capRules[elder.subsidyLevel] || 0);
      })()) : 0;
      await store.upsertMonthlySubsidyUsage(o.elderId, month, -refundCents, capCents);
      releasedCents = refundCents;
    }

    return sendData(res, 200, {
      ...updated,
      refundCents,
      releasedCents,
      monthReleased: month,
      detailsDeleted: deletedDetails,
    });
  } catch (e) { return next(e); }
});

module.exports = router;

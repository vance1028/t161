'use strict';

const express = require('express');
const store = require('../data/store');
const { authRequired, requireRole } = require('../auth');
const { sendData, sendError, parseId } = require('../utils/http');
const { calculateOrderSubsidy, getMonthKey } = require('../utils/subsidy-calculator');

const router = express.Router();
router.use(authRequired);

const MONTHLY_CAP_RULES = {
  A: 30000,
  B: 20000,
  C: 10000,
};

router.get('/', async (req, res, next) => {
  try {
    const { elderId, mealId, status } = req.query;
    const f = { status };
    if (elderId !== undefined) f.elderId = Number(elderId);
    if (mealId !== undefined) f.mealId = Number(mealId);
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

/** POST /api/orders —— 长者订餐（实时计算补贴、占用月度额度）。 */
router.post('/', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { elderId, mealId, diningType = 'DINE_IN', qty = 1, isHoliday = false } = req.body || {};
    if (elderId === undefined || mealId === undefined) return sendError(res, 400, '长者和餐次不能为空');

    const elder = await store.getElderById(Number(elderId));
    if (!elder) return sendError(res, 400, '长者不存在');
    const meal = await store.getMealById(Number(mealId));
    if (!meal) return sendError(res, 400, '餐次不存在');
    if (meal.status !== 'PUBLISHED') return sendError(res, 409, '该餐次未开放订餐');

    const month = getMonthKey(meal.serveDate);
    if (await store.isMonthLocked(month)) {
      return sendError(res, 409, '该月份已结算锁定，不能新增订餐');
    }

    const rules = await store.listSubsidyRules({ status: 'ACTIVE', effectiveDate: meal.serveDate });
    const usage = await store.getMonthlySubsidyUsage(Number(elderId), month);
    const capCents = MONTHLY_CAP_RULES[elder.subsidyLevel] || 0;

    const calc = calculateOrderSubsidy({
      elder,
      meal,
      qty: Number(qty) || 1,
      rules,
      isHoliday: !!isHoliday,
      monthlyUsedCents: usage?.usedCents || 0,
      monthlyCapCents: capCents,
      orderDate: meal.serveDate,
    });

    const order = await store.createOrder({
      elderId: Number(elderId),
      mealId: Number(mealId),
      diningType,
      qty: Number(qty) || 1,
      amountCents: calc.amountCents,
      subsidyCents: calc.netSubsidyCents,
      payCents: calc.payCents,
      status: 'RESERVED',
    });

    for (const bd of calc.breakdown) {
      await store.createOrderSubsidyDetail({
        orderId: order.id,
        ruleId: bd.ruleId,
        ruleCode: bd.ruleCode,
        ruleName: bd.ruleName,
        ruleType: bd.ruleType,
        amountCents: bd.amountCents,
      });
    }

    await store.upsertMonthlySubsidyUsage(Number(elderId), month, calc.netSubsidyCents, capCents);

    return sendData(res, 201, {
      ...order,
      subsidyDetails: calc.breakdown,
      monthlyUsage: calc.monthlyUsage,
    });
  } catch (e) { return next(e); }
});

/** POST /api/orders/:id/serve —— 核销（取餐/送达）。 */
router.post('/:id/serve', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const o = await store.getOrderById(id);
    if (!o) return sendError(res, 404, '订餐记录不存在');
    if (o.status !== 'RESERVED') return sendError(res, 409, '该订餐已核销或已取消');
    return sendData(res, 200, await store.updateOrder(id, { status: 'SERVED' }));
  } catch (e) { return next(e); }
});

/** POST /api/orders/:id/cancel —— 取消订餐（回退补贴、释放月度额度）。 */
router.post('/:id/cancel', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const o = await store.getOrderById(id);
    if (!o) return sendError(res, 404, '订餐记录不存在');
    if (o.status === 'SERVED') return sendError(res, 409, '已核销的订餐不能取消');
    if (o.status === 'CANCELLED') return sendError(res, 409, '该订餐已取消');

    const meal = await store.getMealById(o.mealId);
    const month = meal ? getMonthKey(meal.serveDate) : null;

    if (month && await store.isMonthLocked(month)) {
      return sendError(res, 409, '该月份已结算锁定，不能取消订餐');
    }

    const refundCents = o.subsidyCents || 0;
    const updated = await store.updateOrder(id, {
      status: 'CANCELLED',
      subsidyCents: 0,
      payCents: o.amountCents,
    });

    await store.deleteOrderSubsidyDetailsByOrderId(id);

    if (month && refundCents > 0) {
      const elder = await store.getElderById(o.elderId);
      const capCents = elder ? (MONTHLY_CAP_RULES[elder.subsidyLevel] || 0) : 0;
      await store.upsertMonthlySubsidyUsage(o.elderId, month, -refundCents, capCents);
    }

    return sendData(res, 200, {
      ...updated,
      refundCents,
      monthReleased: month,
    });
  } catch (e) { return next(e); }
});

module.exports = router;

'use strict';

const SUBSIDY_TYPES = {
  LEVEL_BASE: 'LEVEL_BASE',
  IDENTITY_ADD: 'IDENTITY_ADD',
  MEAL_TYPE_ADD: 'MEAL_TYPE_ADD',
  HOLIDAY_ADD: 'HOLIDAY_ADD',
  MONTHLY_CAP: 'MONTHLY_CAP',
};

const IDENTITY_TYPES = ['LOW_INCOME', 'EXTREME_POOR', 'DISABLED', 'SENIOR_80', 'SENIOR_90', 'LONELY'];

const ORDER_STATUSES = {
  RESERVED: 'RESERVED',
  SERVED: 'SERVED',
  CANCELLED: 'CANCELLED',
};

function roundCents(amount) {
  return Math.round(amount);
}

function toDateStr(input) {
  if (!input) return '';
  if (typeof input === 'string') {
    if (input.length >= 10) return input.slice(0, 10);
    return input;
  }
  if (input instanceof Date) {
    const y = input.getFullYear();
    const m = String(input.getMonth() + 1).padStart(2, '0');
    const d = String(input.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(input).slice(0, 10);
}

function parseIdentities(identitiesStr) {
  if (!identitiesStr) return [];
  return String(identitiesStr).split(',').map((s) => s.trim()).filter(Boolean);
}

function isRuleActiveOnDate(rule, date) {
  if (rule.status !== 'ACTIVE') return false;
  const d = toDateStr(date);
  const ef = toDateStr(rule.effectiveFrom || rule.effective_from);
  const et = toDateStr(rule.effectiveTo || rule.effective_to);
  if (ef && d < ef) return false;
  if (et && d > et) return false;
  return true;
}

function ruleAppliesToMealType(rule, mealType) {
  if (!rule.mealTypes && !rule.meal_types) return true;
  const raw = rule.mealTypes || rule.meal_types || '';
  if (raw === '') return true;
  const types = String(raw).split(',').map((t) => t.trim()).filter(Boolean);
  if (types.length === 0) return true;
  return types.includes(mealType);
}

function matchLevelBaseRule(rule, elder) {
  if (rule.ruleType !== SUBSIDY_TYPES.LEVEL_BASE && rule.rule_type !== SUBSIDY_TYPES.LEVEL_BASE) return false;
  const conditionJson = rule.conditionJson || rule.condition_json || {};
  const cond = typeof conditionJson === 'string' ? JSON.parse(conditionJson) : conditionJson;
  if (!cond || !cond.level) return false;
  return cond.level === elder.subsidyLevel;
}

function matchIdentityRule(rule, elder) {
  if (rule.ruleType !== SUBSIDY_TYPES.IDENTITY_ADD && rule.rule_type !== SUBSIDY_TYPES.IDENTITY_ADD) return false;
  const conditionJson = rule.conditionJson || rule.condition_json || {};
  const cond = typeof conditionJson === 'string' ? JSON.parse(conditionJson) : conditionJson;
  if (!cond || !cond.identity) return false;
  const identities = parseIdentities(elder.identities);
  return identities.includes(cond.identity);
}

function matchMealTypeRule(rule, mealType) {
  if (rule.ruleType !== SUBSIDY_TYPES.MEAL_TYPE_ADD && rule.rule_type !== SUBSIDY_TYPES.MEAL_TYPE_ADD) return false;
  return ruleAppliesToMealType(rule, mealType);
}

function matchHolidayRule(rule, isHoliday) {
  if (rule.ruleType !== SUBSIDY_TYPES.HOLIDAY_ADD && rule.rule_type !== SUBSIDY_TYPES.HOLIDAY_ADD) return false;
  return (rule.isHoliday === 1 || rule.is_holiday === 1) && isHoliday === true;
}

function calculateRuleAmount(rule, mealPriceCents, qty) {
  const pct = Number(rule.percent || 0);
  const amt = Number(rule.amountCents ?? rule.amount_cents ?? 0);
  if (pct > 0) {
    return roundCents(mealPriceCents * qty * (pct / 100));
  }
  return roundCents(amt * qty);
}

function getMonthKey(dateStr) {
  return toDateStr(dateStr).slice(0, 7);
}

function extractCapRules(rules) {
  const cap = {};
  for (const rule of rules) {
    if (rule.ruleType !== SUBSIDY_TYPES.MONTHLY_CAP && rule.rule_type !== SUBSIDY_TYPES.MONTHLY_CAP) continue;
    if (rule.status !== 'ACTIVE') continue;
    const conditionJson = rule.conditionJson || rule.condition_json || {};
    const cond = typeof conditionJson === 'string' ? JSON.parse(conditionJson) : conditionJson;
    if (!cond || !cond.level) continue;
    const amt = Number(rule.amountCents ?? rule.amount_cents ?? 0);
    cap[cond.level] = (cap[cond.level] || 0) + amt;
  }
  return cap;
}

function getCapCentsByLevel(subsidyLevel, capRules) {
  if (!capRules) return 0;
  return Number(capRules[subsidyLevel] || 0);
}

function filterRulesByDate(rules, date) {
  const d = toDateStr(date);
  return rules.filter((r) => isRuleActiveOnDate(r, d));
}

function calculateOrderSubsidy(params) {
  const {
    elder,
    meal,
    qty = 1,
    rules,
    isHoliday = false,
    monthlyUsedCents = 0,
    monthlyCapCents = 0,
    orderDate,
  } = params;

  const priceCents = Number(meal.priceCents ?? meal.price_cents ?? 0);
  const mealType = meal.mealType || meal.meal_type || 'LUNCH';
  const amountCents = roundCents(priceCents * Number(qty || 1));

  const calcDate = orderDate || meal.serveDate || meal.serve_date;
  const activeRules = filterRulesByDate(rules || [], calcDate);

  const breakdown = [];
  let grossSubsidyCents = 0;

  const sortedRules = [...activeRules]
    .filter((r) => {
      const rt = r.ruleType || r.rule_type;
      return rt !== SUBSIDY_TYPES.MONTHLY_CAP;
    })
    .sort((a, b) => (a.priority || 0) - (b.priority || 0));

  for (const rule of sortedRules) {
    const rt = rule.ruleType || rule.rule_type;
    let matches = false;
    switch (rt) {
      case SUBSIDY_TYPES.LEVEL_BASE:
        matches = matchLevelBaseRule(rule, elder);
        break;
      case SUBSIDY_TYPES.IDENTITY_ADD:
        matches = matchIdentityRule(rule, elder);
        break;
      case SUBSIDY_TYPES.MEAL_TYPE_ADD:
        matches = matchMealTypeRule(rule, mealType);
        break;
      case SUBSIDY_TYPES.HOLIDAY_ADD:
        matches = matchHolidayRule(rule, isHoliday);
        break;
    }
    if (!matches) continue;
    const ruleAmount = calculateRuleAmount(rule, priceCents, Number(qty || 1));
    if (ruleAmount <= 0) continue;
    grossSubsidyCents += ruleAmount;
    breakdown.push({
      ruleId: Number(rule.id || 0),
      ruleCode: rule.code || '',
      ruleName: rule.name || '',
      ruleType: rt,
      amountCents: ruleAmount,
    });
  }

  if (grossSubsidyCents > amountCents) {
    const scale = amountCents / grossSubsidyCents;
    for (const b of breakdown) {
      b.amountCents = roundCents(b.amountCents * scale);
    }
    let s = breakdown.reduce((sum, b) => sum + b.amountCents, 0);
    if (s !== amountCents && breakdown.length > 0) {
      breakdown[breakdown.length - 1].amountCents += (amountCents - s);
    }
    grossSubsidyCents = amountCents;
  }

  const usedCents = Number(monthlyUsedCents || 0);
  const capCents = Number(monthlyCapCents || 0);
  const remainingCapCents = capCents > 0 ? Math.max(0, capCents - usedCents) : (grossSubsidyCents);
  const netSubsidyCents = capCents > 0
    ? Math.min(grossSubsidyCents, remainingCapCents)
    : grossSubsidyCents;
  const payCents = Math.max(0, amountCents - netSubsidyCents);

  const capAdjustmentCents = grossSubsidyCents - netSubsidyCents;

  let adjustedBreakdown = breakdown;
  if (capAdjustmentCents > 0 && grossSubsidyCents > 0) {
    const scale = netSubsidyCents / grossSubsidyCents;
    adjustedBreakdown = breakdown.map((b) => ({
      ...b,
      amountCents: roundCents(b.amountCents * scale),
    }));
    let s = adjustedBreakdown.reduce((sum, b) => sum + b.amountCents, 0);
    if (s !== netSubsidyCents && adjustedBreakdown.length > 0) {
      adjustedBreakdown[adjustedBreakdown.length - 1].amountCents += (netSubsidyCents - s);
    }
  }

  const nearCapThreshold = capCents > 0 ? capCents * 0.9 : 0;
  const afterUsed = usedCents + netSubsidyCents;
  let status = 'NORMAL';
  if (capCents > 0) {
    if (afterUsed >= capCents) status = 'CAP_REACHED';
    else if (afterUsed >= nearCapThreshold) status = 'CAP_NEAR';
  }

  return {
    amountCents,
    grossSubsidyCents,
    capAdjustmentCents,
    netSubsidyCents,
    payCents,
    breakdown: adjustedBreakdown,
    monthlyUsage: {
      beforeCents: usedCents,
      afterCents: afterUsed,
      capCents,
      remainingCents: Math.max(0, remainingCapCents - netSubsidyCents),
      status,
    },
  };
}

function normalizeOrderForAudit(order) {
  const serveDate = toDateStr(order.serveDate || order.serve_date);
  const mealType = order.mealType || order.meal_type || 'LUNCH';
  const mealPriceCents = Number(order.mealPriceCents ?? order.meal_price_cents ?? order.priceCents ?? order.price_cents ?? 0);
  return {
    id: Number(order.id || 0),
    elderId: Number(order.elderId ?? order.elder_id ?? 0),
    mealId: Number(order.mealId ?? order.meal_id ?? 0),
    canteenId: Number(order.canteenId ?? order.canteen_id ?? 0),
    subsidyLevel: order.subsidyLevel || order.subsidy_level || 'C',
    identities: order.identities || '',
    serveDate,
    mealType,
    mealPriceCents,
    qty: Number(order.qty || 1),
    amountCents: Number(order.amountCents ?? order.amount_cents ?? 0),
    subsidyCents: Number(order.subsidyCents ?? order.subsidy_cents ?? 0),
    payCents: Number(order.payCents ?? order.pay_cents ?? 0),
    status: order.status || 'RESERVED',
  };
}

function normalizeElderForAudit(elder) {
  return {
    id: Number(elder.id || 0),
    subsidyLevel: elder.subsidyLevel || elder.subsidy_level || 'C',
    identities: elder.identities || '',
  };
}

function normalizeMealForAudit(meal) {
  return {
    id: Number(meal.id || 0),
    serveDate: toDateStr(meal.serveDate || meal.serve_date),
    mealType: meal.mealType || meal.meal_type || 'LUNCH',
    priceCents: Number(meal.priceCents ?? meal.price_cents ?? 0),
  };
}

function checkDiscrepancies(orders, rules, elders, meals, holidays = []) {
  const discrepancies = [];
  const monthlyUsage = new Map();
  const capRules = extractCapRules(rules);

  const elderMap = new Map();
  for (const e of elders || []) elderMap.set(Number(e.id), normalizeElderForAudit(e));
  const mealMap = new Map();
  for (const m of meals || []) mealMap.set(Number(m.id), normalizeMealForAudit(m));
  const holidaySet = new Set((holidays || []).map((h) => toDateStr(h)));

  const normalizedOrders = (orders || []).map(normalizeOrderForAudit);
  normalizedOrders.sort((a, b) => {
    if (a.serveDate !== b.serveDate) return a.serveDate.localeCompare(b.serveDate);
    return a.id - b.id;
  });

  const cancelMap = new Map();

  for (const order of normalizedOrders) {
    const elder = elderMap.get(order.elderId);
    const meal = mealMap.get(order.mealId);

    if (order.status === ORDER_STATUSES.CANCELLED) {
      if (order.subsidyCents !== 0 || order.payCents !== order.amountCents) {
        discrepancies.push({
          orderId: order.id,
          issueType: 'CANCELLED_WITH_SUBSIDY',
          expectedCents: 0,
          actualCents: order.subsidyCents,
          diffCents: order.subsidyCents,
          description: `已取消订单仍有补贴${order.subsidyCents}分或自付${order.payCents}≠餐价${order.amountCents}，退订未回退`,
        });
      }
      cancelMap.set(order.id, true);
      continue;
    }

    if (!elder || !meal) {
      discrepancies.push({
        orderId: order.id,
        issueType: 'REF_MISSING',
        expectedCents: 0,
        actualCents: 0,
        diffCents: 0,
        description: `关联数据缺失：长者${!elder ? '不存在' : 'ok'}，餐次${!meal ? '不存在' : 'ok'}`,
      });
      continue;
    }

    const monthKey = getMonthKey(meal.serveDate);
    const usageKey = `${elder.id}-${monthKey}`;
    const usedCents = monthlyUsage.get(usageKey) || 0;
    const capCents = getCapCentsByLevel(elder.subsidyLevel, capRules);
    const isHoliday = holidaySet.has(meal.serveDate);

    const expected = calculateOrderSubsidy({
      elder,
      meal,
      qty: order.qty,
      rules,
      isHoliday,
      monthlyUsedCents: usedCents,
      monthlyCapCents: capCents,
      orderDate: meal.serveDate,
    });

    monthlyUsage.set(usageKey, usedCents + expected.netSubsidyCents);

    const expNet = expected.netSubsidyCents;
    const expPay = expected.payCents;
    const expAmt = expected.amountCents;

    if (Math.abs(expAmt - order.amountCents) > 0) {
      discrepancies.push({
        orderId: order.id,
        issueType: 'AMOUNT_MISMATCH',
        expectedCents: expAmt,
        actualCents: order.amountCents,
        diffCents: expAmt - order.amountCents,
        description: `餐价不符：预期${expAmt}分，实际${order.amountCents}分`,
      });
    }
    if (Math.abs(expNet - order.subsidyCents) > 0) {
      discrepancies.push({
        orderId: order.id,
        issueType: 'SUBSIDY_MISMATCH',
        expectedCents: expNet,
        actualCents: order.subsidyCents,
        diffCents: expNet - order.subsidyCents,
        description: `补贴不符：预期${expNet}分(已用${usedCents}+封顶${capCents})，实际${order.subsidyCents}分`,
      });
    }
    if (Math.abs(expPay - order.payCents) > 0) {
      discrepancies.push({
        orderId: order.id,
        issueType: 'PAY_MISMATCH',
        expectedCents: expPay,
        actualCents: order.payCents,
        diffCents: expPay - order.payCents,
        description: `自付不符：预期${expPay}分，实际${order.payCents}分`,
      });
    }
  }

  return discrepancies;
}

function recalculateMonthOrders(orders, rules, elders, meals, holidays = []) {
  const results = [];
  const monthlyUsage = new Map();
  const capRules = extractCapRules(rules);

  const elderMap = new Map();
  for (const e of elders || []) elderMap.set(Number(e.id), normalizeElderForAudit(e));
  const mealMap = new Map();
  for (const m of meals || []) mealMap.set(Number(m.id), normalizeMealForAudit(m));
  const holidaySet = new Set((holidays || []).map((h) => toDateStr(h)));

  const normalizedOrders = (orders || []).map(normalizeOrderForAudit);
  normalizedOrders.sort((a, b) => {
    if (a.serveDate !== b.serveDate) return a.serveDate.localeCompare(b.serveDate);
    return a.id - b.id;
  });

  for (const order of normalizedOrders) {
    const elder = elderMap.get(order.elderId);
    const meal = mealMap.get(order.mealId);
    if (!elder || !meal) continue;

    const monthKey = getMonthKey(meal.serveDate);
    const usageKey = `${elder.id}-${monthKey}`;
    const usedCents = monthlyUsage.get(usageKey) || 0;
    const capCents = getCapCentsByLevel(elder.subsidyLevel, capRules);
    const isHoliday = holidaySet.has(meal.serveDate);

    const isCancelled = order.status === ORDER_STATUSES.CANCELLED;
    const calc = calculateOrderSubsidy({
      elder,
      meal,
      qty: order.qty,
      rules,
      isHoliday,
      monthlyUsedCents: usedCents,
      monthlyCapCents: capCents,
      orderDate: meal.serveDate,
    });

    if (!isCancelled) {
      monthlyUsage.set(usageKey, usedCents + calc.netSubsidyCents);
    }

    results.push({
      orderId: order.id,
      orderStatus: order.status,
      serveDate: meal.serveDate,
      original: {
        amountCents: order.amountCents,
        subsidyCents: order.subsidyCents,
        payCents: order.payCents,
      },
      recalculated: {
        amountCents: isCancelled ? order.amountCents : calc.amountCents,
        subsidyCents: isCancelled ? 0 : calc.netSubsidyCents,
        payCents: isCancelled ? order.amountCents : calc.payCents,
        breakdown: isCancelled ? [] : calc.breakdown,
      },
      diff: {
        amountCents: (isCancelled ? order.amountCents : calc.amountCents) - order.amountCents,
        subsidyCents: (isCancelled ? 0 : calc.netSubsidyCents) - order.subsidyCents,
        payCents: (isCancelled ? order.amountCents : calc.payCents) - order.payCents,
      },
    });
  }

  return results;
}

function aggregateSettlementByGroup(orders, groupFn) {
  const groups = new Map();
  for (const rawOrder of orders || []) {
    const order = normalizeOrderForAudit(rawOrder);
    if (order.status === ORDER_STATUSES.CANCELLED) continue;
    const key = groupFn(order);
    if (!groups.has(key)) {
      groups.set(key, {
        orderCount: 0,
        totalAmountCents: 0,
        totalSubsidyCents: 0,
        totalPayCents: 0,
        orders: [],
      });
    }
    const g = groups.get(key);
    g.orderCount += 1;
    g.totalAmountCents += order.amountCents || 0;
    g.totalSubsidyCents += order.subsidyCents || 0;
    g.totalPayCents += order.payCents || 0;
    g.orders.push(order);
  }
  return groups;
}

module.exports = {
  SUBSIDY_TYPES,
  IDENTITY_TYPES,
  ORDER_STATUSES,
  roundCents,
  toDateStr,
  parseIdentities,
  isRuleActiveOnDate,
  ruleAppliesToMealType,
  calculateRuleAmount,
  getMonthKey,
  extractCapRules,
  getCapCentsByLevel,
  filterRulesByDate,
  calculateOrderSubsidy,
  normalizeOrderForAudit,
  normalizeElderForAudit,
  normalizeMealForAudit,
  aggregateSettlementByGroup,
  checkDiscrepancies,
  recalculateMonthOrders,
};

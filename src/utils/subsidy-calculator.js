'use strict';

const SUBSIDY_TYPES = {
  LEVEL_BASE: 'LEVEL_BASE',
  IDENTITY_ADD: 'IDENTITY_ADD',
  MEAL_TYPE_ADD: 'MEAL_TYPE_ADD',
  HOLIDAY_ADD: 'HOLIDAY_ADD',
};

const IDENTITY_TYPES = ['LOW_INCOME', 'EXTREME_POOR', 'DISABLED', 'SENIOR_80', 'SENIOR_90', 'LONELY'];

function roundCents(amount) {
  return Math.round(amount);
}

function parseIdentities(identitiesStr) {
  if (!identitiesStr) return [];
  return identitiesStr.split(',').map((s) => s.trim()).filter(Boolean);
}

function isRuleActiveOnDate(rule, date) {
  if (rule.status !== 'ACTIVE') return false;
  let d;
  if (typeof date === 'string') {
    d = date;
  } else if (date instanceof Date) {
    d = date.toISOString().slice(0, 10);
  } else {
    d = String(date);
  }
  if (rule.effectiveFrom && d < rule.effectiveFrom) return false;
  if (rule.effectiveTo && d > rule.effectiveTo) return false;
  return true;
}

function ruleAppliesToMealType(rule, mealType) {
  if (!rule.mealTypes || rule.mealTypes === '') return true;
  const types = rule.mealTypes.split(',').map((t) => t.trim());
  return types.includes(mealType);
}

function matchLevelBaseRule(rule, elder) {
  if (rule.ruleType !== SUBSIDY_TYPES.LEVEL_BASE) return false;
  if (!rule.conditionJson || !rule.conditionJson.level) return false;
  return rule.conditionJson.level === elder.subsidyLevel;
}

function matchIdentityRule(rule, elder) {
  if (rule.ruleType !== SUBSIDY_TYPES.IDENTITY_ADD) return false;
  if (!rule.conditionJson || !rule.conditionJson.identity) return false;
  const identities = parseIdentities(elder.identities);
  return identities.includes(rule.conditionJson.identity);
}

function matchMealTypeRule(rule, mealType) {
  if (rule.ruleType !== SUBSIDY_TYPES.MEAL_TYPE_ADD) return false;
  return ruleAppliesToMealType(rule, mealType);
}

function matchHolidayRule(rule, isHoliday) {
  if (rule.ruleType !== SUBSIDY_TYPES.HOLIDAY_ADD) return false;
  return rule.isHoliday === 1 && isHoliday === true;
}

function calculateRuleAmount(rule, mealPriceCents, qty) {
  if (rule.percent > 0) {
    return roundCents(mealPriceCents * qty * (rule.percent / 100));
  }
  return roundCents(rule.amountCents * qty);
}

function getMonthKey(dateStr) {
  const d = typeof dateStr === 'string' ? dateStr :
    dateStr instanceof Date ? dateStr.toISOString().slice(0, 10) :
    String(dateStr);
  return d.slice(0, 7);
}

function getCapCentsByLevel(subsidyLevel, capRules) {
  if (!capRules) return 0;
  return capRules[subsidyLevel] || 0;
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

  const amountCents = roundCents(meal.priceCents * qty);
  const applicableRules = [];
  const breakdown = [];
  let grossSubsidyCents = 0;

  const sortedRules = [...rules]
    .filter((r) => isRuleActiveOnDate(r, orderDate || meal.serveDate))
    .sort((a, b) => a.priority - b.priority);

  for (const rule of sortedRules) {
    let matches = false;
    switch (rule.ruleType) {
      case SUBSIDY_TYPES.LEVEL_BASE:
        matches = matchLevelBaseRule(rule, elder);
        break;
      case SUBSIDY_TYPES.IDENTITY_ADD:
        matches = matchIdentityRule(rule, elder);
        break;
      case SUBSIDY_TYPES.MEAL_TYPE_ADD:
        matches = matchMealTypeRule(rule, meal.mealType);
        break;
      case SUBSIDY_TYPES.HOLIDAY_ADD:
        matches = matchHolidayRule(rule, isHoliday);
        break;
    }
    if (matches) {
      applicableRules.push(rule);
      const ruleAmount = calculateRuleAmount(rule, meal.priceCents, qty);
      grossSubsidyCents += ruleAmount;
      breakdown.push({
        ruleId: rule.id,
        ruleCode: rule.code,
        ruleName: rule.name,
        ruleType: rule.ruleType,
        amountCents: ruleAmount,
      });
    }
  }

  if (grossSubsidyCents > amountCents) {
    grossSubsidyCents = amountCents;
  }

  const remainingCapCents = Math.max(0, monthlyCapCents - monthlyUsedCents);
  const netSubsidyCents = Math.min(grossSubsidyCents, remainingCapCents);
  const payCents = amountCents - netSubsidyCents;

  const capAdjustmentCents = grossSubsidyCents - netSubsidyCents;
  const nearCapThreshold = monthlyCapCents > 0 ? monthlyCapCents * 0.9 : 0;
  const status = monthlyCapCents > 0 ? (
    (monthlyUsedCents + netSubsidyCents) >= monthlyCapCents ? 'CAP_REACHED' :
    (monthlyUsedCents + netSubsidyCents) >= nearCapThreshold ? 'CAP_NEAR' : 'NORMAL'
  ) : 'NORMAL';

  const adjustedBreakdown = netSubsidyCents < grossSubsidyCents && grossSubsidyCents > 0
    ? breakdown.map((b) => ({
        ...b,
        amountCents: roundCents(b.amountCents * (netSubsidyCents / grossSubsidyCents)),
      }))
    : breakdown;

  const adjustedSum = adjustedBreakdown.reduce((sum, b) => sum + b.amountCents, 0);
  if (adjustedSum !== netSubsidyCents && adjustedBreakdown.length > 0) {
    adjustedBreakdown[adjustedBreakdown.length - 1].amountCents += (netSubsidyCents - adjustedSum);
  }

  return {
    amountCents,
    grossSubsidyCents,
    capAdjustmentCents,
    netSubsidyCents,
    payCents,
    breakdown: adjustedBreakdown,
    monthlyUsage: {
      beforeCents: monthlyUsedCents,
      afterCents: monthlyUsedCents + netSubsidyCents,
      capCents: monthlyCapCents,
      remainingCents: remainingCapCents - netSubsidyCents,
      status,
    },
  };
}

function recalcOrderWithNewRules(order, meal, elder, rules, monthlyUsedCents, monthlyCapCents, isHoliday) {
  return calculateOrderSubsidy({
    elder,
    meal,
    qty: order.qty,
    rules,
    isHoliday,
    monthlyUsedCents,
    monthlyCapCents,
    orderDate: meal.serveDate,
  });
}

function aggregateSettlementByGroup(orders, groupFn) {
  const groups = new Map();
  for (const order of orders) {
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

function checkDiscrepancies(orders, rules, elders, meals, capRules, holidays = []) {
  const discrepancies = [];
  const monthlyUsage = new Map();

  const sortedOrders = [...orders].sort((a, b) => {
    const ma = meals.find((m) => m.id === a.mealId);
    const mb = meals.find((m) => m.id === b.mealId);
    return (ma?.serveDate || '').localeCompare(mb?.serveDate || '');
  });

  for (const order of sortedOrders) {
    const elder = elders.find((e) => e.id === order.elderId);
    const meal = meals.find((m) => m.id === order.mealId);
    if (!elder || !meal) continue;

    const monthKey = getMonthKey(meal.serveDate);
    const usageKey = `${elder.id}-${monthKey}`;
    const usedCents = monthlyUsage.get(usageKey) || 0;
    const capCents = getCapCentsByLevel(elder.subsidyLevel, capRules);
    const isHoliday = holidays.includes(meal.serveDate);

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

    if (order.status === 'CANCELLED') {
      if (order.subsidyCents !== 0) {
        discrepancies.push({
          orderId: order.id,
          issueType: 'CANCELLED_WITH_SUBSIDY',
          expectedCents: 0,
          actualCents: order.subsidyCents,
          diffCents: order.subsidyCents,
          description: '已取消订单仍有补贴记录，退订未回退',
        });
      }
      continue;
    }

    if (Math.abs(expected.netSubsidyCents - (order.subsidyCents || 0)) > 0) {
      discrepancies.push({
        orderId: order.id,
        issueType: 'SUBSIDY_MISMATCH',
        expectedCents: expected.netSubsidyCents,
        actualCents: order.subsidyCents || 0,
        diffCents: expected.netSubsidyCents - (order.subsidyCents || 0),
        description: `补贴金额不符：预期${expected.netSubsidyCents}分，实际${order.subsidyCents || 0}分`,
      });
    }

    if (Math.abs(expected.payCents - (order.payCents || 0)) > 0) {
      discrepancies.push({
        orderId: order.id,
        issueType: 'PAY_MISMATCH',
        expectedCents: expected.payCents,
        actualCents: order.payCents || 0,
        diffCents: expected.payCents - (order.payCents || 0),
        description: `自付金额不符：预期${expected.payCents}分，实际${order.payCents || 0}分`,
      });
    }

    if (Math.abs(expected.amountCents - (order.amountCents || 0)) > 0) {
      discrepancies.push({
        orderId: order.id,
        issueType: 'AMOUNT_MISMATCH',
        expectedCents: expected.amountCents,
        actualCents: order.amountCents || 0,
        diffCents: expected.amountCents - (order.amountCents || 0),
        description: `餐价金额不符：预期${expected.amountCents}分，实际${order.amountCents || 0}分`,
      });
    }
  }

  return discrepancies;
}

function recalculateMonthOrders(orders, rules, elders, meals, capRules, holidays = []) {
  const monthlyUsage = new Map();
  const results = [];

  const sortedOrders = [...orders].sort((a, b) => {
    const ma = meals.find((m) => m.id === a.mealId);
    const mb = meals.find((m) => m.id === b.mealId);
    return (ma?.serveDate || '').localeCompare(mb?.serveDate || '');
  });

  for (const order of sortedOrders) {
    const elder = elders.find((e) => e.id === order.elderId);
    const meal = meals.find((m) => m.id === order.mealId);
    if (!elder || !meal) continue;

    const monthKey = getMonthKey(meal.serveDate);
    const usageKey = `${elder.id}-${monthKey}`;
    const usedCents = monthlyUsage.get(usageKey) || 0;
    const capCents = getCapCentsByLevel(elder.subsidyLevel, capRules);
    const isHoliday = holidays.includes(meal.serveDate);

    const calc = calculateOrderSubsidy({
      elder,
      meal,
      qty: order.qty,
      rules,
      isHoliday,
      monthlyUsedCents: order.status === 'CANCELLED' ? usedCents : usedCents,
      monthlyCapCents: capCents,
      orderDate: meal.serveDate,
    });

    if (order.status !== 'CANCELLED') {
      monthlyUsage.set(usageKey, usedCents + calc.netSubsidyCents);
    }

    results.push({
      orderId: order.id,
      original: {
        amountCents: order.amountCents,
        subsidyCents: order.subsidyCents,
        payCents: order.payCents,
      },
      recalculated: {
        amountCents: calc.amountCents,
        subsidyCents: calc.netSubsidyCents,
        payCents: calc.payCents,
        breakdown: calc.breakdown,
      },
      diff: {
        amountCents: calc.amountCents - (order.amountCents || 0),
        subsidyCents: calc.netSubsidyCents - (order.subsidyCents || 0),
        payCents: calc.payCents - (order.payCents || 0),
      },
    });
  }

  return results;
}

module.exports = {
  SUBSIDY_TYPES,
  IDENTITY_TYPES,
  roundCents,
  parseIdentities,
  isRuleActiveOnDate,
  calculateOrderSubsidy,
  recalcOrderWithNewRules,
  aggregateSettlementByGroup,
  checkDiscrepancies,
  recalculateMonthOrders,
  getMonthKey,
  getCapCentsByLevel,
};

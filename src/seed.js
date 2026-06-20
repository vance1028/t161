'use strict';

const store = require('./data/store');

async function seedSubsidyRules() {
  const today = new Date();
  const effectiveFrom = `${today.getFullYear()}-01-01`;

  await store.createSubsidyRule({
    code: 'LVL-A-BASE', name: 'A级基础补贴', ruleType: 'LEVEL_BASE', priority: 10,
    conditionJson: { level: 'A' }, amountCents: 600, effectiveFrom,
  });
  await store.createSubsidyRule({
    code: 'LVL-B-BASE', name: 'B级基础补贴', ruleType: 'LEVEL_BASE', priority: 10,
    conditionJson: { level: 'B' }, amountCents: 400, effectiveFrom,
  });
  await store.createSubsidyRule({
    code: 'LVL-C-BASE', name: 'C级基础补贴', ruleType: 'LEVEL_BASE', priority: 10,
    conditionJson: { level: 'C' }, amountCents: 200, effectiveFrom,
  });

  await store.createSubsidyRule({
    code: 'ID-LOWINCOME', name: '低保加补', ruleType: 'IDENTITY_ADD', priority: 20,
    conditionJson: { identity: 'LOW_INCOME' }, amountCents: 200, effectiveFrom,
  });
  await store.createSubsidyRule({
    code: 'ID-EXTREMEPOOR', name: '特困加补', ruleType: 'IDENTITY_ADD', priority: 20,
    conditionJson: { identity: 'EXTREME_POOR' }, amountCents: 300, effectiveFrom,
  });
  await store.createSubsidyRule({
    code: 'ID-DISABLED', name: '失能加补', ruleType: 'IDENTITY_ADD', priority: 20,
    conditionJson: { identity: 'DISABLED' }, amountCents: 200, effectiveFrom,
  });
  await store.createSubsidyRule({
    code: 'ID-SENIOR80', name: '80岁高龄加补', ruleType: 'IDENTITY_ADD', priority: 20,
    conditionJson: { identity: 'SENIOR_80' }, amountCents: 100, effectiveFrom,
  });

  await store.createSubsidyRule({
    code: 'MEAL-BREAKFAST', name: '早餐额外补贴', ruleType: 'MEAL_TYPE_ADD', priority: 30,
    amountCents: 100, mealTypes: 'BREAKFAST', effectiveFrom,
  });
  await store.createSubsidyRule({
    code: 'MEAL-DINNER', name: '晚餐额外补贴', ruleType: 'MEAL_TYPE_ADD', priority: 30,
    amountCents: 100, mealTypes: 'DINNER', effectiveFrom,
  });

  await store.createSubsidyRule({
    code: 'HOLIDAY-ADD', name: '节假日加补', ruleType: 'HOLIDAY_ADD', priority: 40,
    amountCents: 200, isHoliday: true, effectiveFrom,
  });
}

/**
 * 种子数据：管理员/食堂工作人员/观察员各一个账号，
 * 外加若干助餐点、长者、餐次与订餐，以及完整的补贴规则体系，
 * 方便本地起步与「功能迭代」类任务直接有数据可用。
 * 幂等：库中已有用户则跳过。
 */
async function seed() {
  if ((await store.countUsers()) > 0) return { skipped: true };

  await store.createUser({ username: 'admin', password: 'admin123', name: '系统管理员', role: 'ADMIN' });
  await store.createUser({ username: 'operator', password: 'operator123', name: '张师傅', role: 'OPERATOR' });
  await store.createUser({ username: 'viewer', password: 'viewer123', name: '李社工', role: 'VIEWER' });

  const c1 = await store.createCanteen({ code: 'CT-CG-001', name: '城关街道长者食堂', district: '城关区', address: '幸福路12号', capacity: 80, status: 'OPEN' });
  const c2 = await store.createCanteen({ code: 'CT-JN-002', name: '江南社区助餐点', district: '江南区', address: '滨河东路5号', capacity: 50, status: 'OPEN' });
  await store.createCanteen({ code: 'CT-GX-003', name: '高新颐养中心餐厅', district: '高新区', address: '科苑路88号', capacity: 60, status: 'CLOSED' });

  const e1 = await store.createElder({ code: 'E-0001', name: '王秀英', gender: 'F', age: 78, phone: '13800000001', subsidyLevel: 'A', identities: 'LOW_INCOME,DISABLED', dietary: '低盐、忌花生', canteenId: c1.id });
  const e2 = await store.createElder({ code: 'E-0002', name: '赵建国', gender: 'M', age: 82, phone: '13800000002', subsidyLevel: 'B', identities: 'SENIOR_80', dietary: '糖尿病、少糖', canteenId: c1.id });
  await store.createElder({ code: 'E-0003', name: '陈桂兰', gender: 'F', age: 69, phone: '13800000003', subsidyLevel: 'C', identities: '', dietary: '', canteenId: c2.id });

  const m1 = await store.createMeal({ canteenId: c1.id, serveDate: '2026-06-18', mealType: 'LUNCH', dishName: '清蒸鲈鱼套餐', priceCents: 1500, status: 'PUBLISHED' });
  const m2 = await store.createMeal({ canteenId: c1.id, serveDate: '2026-06-18', mealType: 'DINNER', dishName: '番茄牛腩面', priceCents: 1200, status: 'PUBLISHED' });
  await store.createMeal({ canteenId: c2.id, serveDate: '2026-06-18', mealType: 'LUNCH', dishName: '香菇鸡肉饭', priceCents: 1300, status: 'PUBLISHED' });

  await seedSubsidyRules();

  const o1 = await store.createOrder({ elderId: e1.id, mealId: m1.id, diningType: 'DINE_IN', qty: 1, amountCents: 1500, subsidyCents: 900, payCents: 600, status: 'RESERVED' });
  await store.updateOrder(o1.id, { status: 'SERVED' });
  await store.createOrder({ elderId: e2.id, mealId: m2.id, diningType: 'DELIVERY', qty: 1, amountCents: 1200, subsidyCents: 600, payCents: 600, status: 'RESERVED' });

  return { skipped: false, users: 3, canteens: 3, elders: 3, meals: 3, subsidyRules: 9, orders: 2 };
}

if (require.main === module) {
  const { getPool, ensureSchema, waitForDb, close } = require('./db');
  (async () => {
    await waitForDb();
    await ensureSchema();
    getPool();
    const result = await seed();
    // eslint-disable-next-line no-console
    console.log('种子数据写入结果:', JSON.stringify(result));
    await close();
  })().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { seed };

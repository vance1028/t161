'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { getPool, ensureSchema, resetAll, waitForDb, close } = require('../src/db');
const { seed } = require('../src/seed');
const { createApp } = require('../src/app');

const app = createApp();

test.before(async () => { await waitForDb(); await ensureSchema(); getPool(); });
test.beforeEach(async () => { await resetAll(); await seed(); });
test.after(async () => { await close(); });

async function loginAs(u, p) {
  const res = await request(app).post('/api/auth/login').send({ username: u, password: p });
  assert.strictEqual(res.status, 200, `登录失败: ${JSON.stringify(res.body)}`);
  return res.body.data.token;
}

test('健康检查无需鉴权', async () => {
  const res = await request(app).get('/api/health');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'ok');
});

test('登录返回 token，中文姓名不乱码', async () => {
  const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin123' });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.data.token);
  assert.strictEqual(res.body.data.user.name, '系统管理员');
});

test('错误密码 401', async () => {
  const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'bad' });
  assert.strictEqual(res.status, 401);
});

test('未带令牌访问受保护接口 401', async () => {
  const res = await request(app).get('/api/canteens');
  assert.strictEqual(res.status, 401);
});

test('助餐点列表读到种子数据，中文正确', async () => {
  const token = await loginAs('viewer', 'viewer123');
  const res = await request(app).get('/api/canteens').set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.length, 3);
  assert.ok(res.body.data.map((c) => c.name).includes('城关街道长者食堂'));
});

test('长者档案含中文忌口正确返回', async () => {
  const token = await loginAs('operator', 'operator123');
  const list = await request(app).get('/api/elders').set('Authorization', `Bearer ${token}`);
  assert.strictEqual(list.status, 200);
  const wang = list.body.data.find((e) => e.code === 'E-0001');
  assert.strictEqual(wang.name, '王秀英');
  assert.strictEqual(wang.dietary, '低盐、忌花生');
});

test('operator 新建长者并能查到（含中文）', async () => {
  const token = await loginAs('operator', 'operator123');
  const create = await request(app).post('/api/elders').set('Authorization', `Bearer ${token}`)
    .send({ code: 'E-9001', name: '孙桂芳', gender: 'F', age: 75, phone: '13900000000', subsidyLevel: 'B', dietary: '软烂、忌海鲜' });
  assert.strictEqual(create.status, 201, JSON.stringify(create.body));
  const id = create.body.data.id;
  const get = await request(app).get(`/api/elders/${id}`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(get.body.data.name, '孙桂芳');
  assert.strictEqual(get.body.data.dietary, '软烂、忌海鲜');
});

test('viewer 无权新建助餐点 403', async () => {
  const token = await loginAs('viewer', 'viewer123');
  const res = await request(app).post('/api/canteens').set('Authorization', `Bearer ${token}`)
    .send({ code: 'CT-X-001', name: '测试点', district: '某区' });
  assert.strictEqual(res.status, 403);
});

test('助餐点编号重复 409', async () => {
  const token = await loginAs('admin', 'admin123');
  const res = await request(app).post('/api/canteens').set('Authorization', `Bearer ${token}`)
    .send({ code: 'CT-CG-001', name: '重复', district: '某区' });
  assert.strictEqual(res.status, 409);
});

test('订餐：下单后核销，状态流转与重复核销拦截', async () => {
  const token = await loginAs('operator', 'operator123');
  const elders = (await request(app).get('/api/elders').set('Authorization', `Bearer ${token}`)).body.data;
  const meals = (await request(app).get('/api/meals').set('Authorization', `Bearer ${token}`)).body.data;
  const meal = meals.find((m) => m.status === 'PUBLISHED');
  const order = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
    .send({ elderId: elders[0].id, mealId: meal.id, diningType: 'DINE_IN', qty: 1 });
  assert.strictEqual(order.status, 201, JSON.stringify(order.body));
  assert.strictEqual(order.body.data.amountCents, meal.priceCents);
  const oid = order.body.data.id;

  const serve1 = await request(app).post(`/api/orders/${oid}/serve`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(serve1.status, 200);
  assert.strictEqual(serve1.body.data.status, 'SERVED');

  const serve2 = await request(app).post(`/api/orders/${oid}/serve`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(serve2.status, 409, '已核销不能重复核销');
});

test('删除助餐点需要 admin，operator 被拒 403', async () => {
  const token = await loginAs('operator', 'operator123');
  const list = (await request(app).get('/api/canteens').set('Authorization', `Bearer ${token}`)).body.data;
  const res = await request(app).delete(`/api/canteens/${list[0].id}`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 403);
});

test('不存在的接口 404', async () => {
  const res = await request(app).get('/api/not-exist');
  assert.strictEqual(res.status, 404);
});

/* ==========================================================
   分级补贴与结算系统测试
   ========================================================== */

test('补贴规则：列表包含 MONTHLY_CAP / LEVEL_BASE / IDENTITY_ADD / MEAL_TYPE_ADD / HOLIDAY_ADD', async () => {
  const token = await loginAs('viewer', 'viewer123');
  const res = await request(app).get('/api/subsidy-rules').set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const rules = res.body.data;
  const types = new Set(rules.map((r) => r.ruleType));
  assert.ok(types.has('MONTHLY_CAP'), '应包含 MONTHLY_CAP 规则类型');
  assert.ok(types.has('LEVEL_BASE'), '应包含 LEVEL_BASE 规则类型');
  assert.ok(types.has('IDENTITY_ADD'), '应包含 IDENTITY_ADD 规则类型');
  const capA = rules.find((r) => r.code === 'CAP-A');
  const capB = rules.find((r) => r.code === 'CAP-B');
  const capC = rules.find((r) => r.code === 'CAP-C');
  assert.ok(capA, 'CAP-A 规则存在');
  assert.strictEqual(capA.amountCents, 30000, 'A级封顶 300 元');
  assert.strictEqual(capB.amountCents, 20000, 'B级封顶 200 元');
  assert.strictEqual(capC.amountCents, 10000, 'C级封顶 100 元');
});

test('订餐：A 级长者（低保+失能），正确叠加基础+身份+封顶额度返回', async () => {
  const token = await loginAs('operator', 'operator123');
  const elders = (await request(app).get('/api/elders').set('Authorization', `Bearer ${token}`)).body.data;
  const meals = (await request(app).get('/api/meals').set('Authorization', `Bearer ${token}`)).body.data;
  const elder = elders.find((e) => e.code === 'E-0001'); // A级 低保+失能
  const meal = meals.find((m) => m.mealType === 'LUNCH' && m.serveDate === '2026-06-18' && m.priceCents === 1500);
  assert.ok(elder);
  assert.ok(meal);
  const order = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
    .send({ elderId: elder.id, mealId: meal.id, diningType: 'DINE_IN', qty: 1 });
  assert.strictEqual(order.status, 201, JSON.stringify(order.body));
  const data = order.body.data;
  assert.strictEqual(data.amountCents, 1500, '餐价 15 元 = 1500 分');
  const expectedGross = 600 /* LVL-A */ + 200 /* LOW_INCOME */ + 200 /* DISABLED */;
  assert.strictEqual(data.subsidyCents, expectedGross, `A 级基础6+低保2+失能2 = 10元即1000分；非节假日非早晚餐，实际${expectedGross}`);
  assert.strictEqual(data.payCents, 1500 - expectedGross, '个人自付 = 餐价 - 实际补贴');
  assert.ok(Array.isArray(data.subsidyDetails), '应返回补贴明细');
  assert.ok(data.subsidyDetails.length >= 3, '至少命中 3 条规则');
  const usage = await request(app)
    .get(`/api/settlements/monthly-usage/${elder.id}/2026-06`)
    .set('Authorization', `Bearer ${token}`);
  assert.strictEqual(usage.status, 200);
  assert.strictEqual(usage.body.data.usedCents, expectedGross, '月度已用额度 = 实际补贴');
  assert.strictEqual(usage.body.data.capCents, 30000, 'A 级封顶 300 元');
});

test('订餐：B 级长者（高龄）+ 晚餐，正确叠加基础+高龄+餐别加补', async () => {
  const token = await loginAs('operator', 'operator123');
  const elders = (await request(app).get('/api/elders').set('Authorization', `Bearer ${token}`)).body.data;
  const meals = (await request(app).get('/api/meals').set('Authorization', `Bearer ${token}`)).body.data;
  const elder = elders.find((e) => e.code === 'E-0002'); // B级 高龄80
  const meal = meals.find((m) => m.mealType === 'DINNER' && m.serveDate === '2026-06-18');
  assert.ok(elder);
  assert.ok(meal);
  const order = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
    .send({ elderId: elder.id, mealId: meal.id, diningType: 'DINE_IN', qty: 1 });
  assert.strictEqual(order.status, 201, JSON.stringify(order.body));
  const data = order.body.data;
  // LVL-B 400 + SENIOR_80 100 + MEAL-DINNER 100 = 600
  const expected = 400 + 100 + 100;
  assert.strictEqual(data.subsidyCents, expected, `B级4 + 高龄1 + 晚餐1 = 6元即600分，实际${expected}`);
});

test('退订：实际补贴归零，明细删除，月度额度释放', async () => {
  const token = await loginAs('operator', 'operator123');
  const elders = (await request(app).get('/api/elders').set('Authorization', `Bearer ${token}`)).body.data;
  const meals = (await request(app).get('/api/meals').set('Authorization', `Bearer ${token}`)).body.data;
  const elder = elders.find((e) => e.code === 'E-0001');
  const meal = meals.find((m) => m.mealType === 'LUNCH' && m.priceCents === 1500);
  assert.ok(meal, '应找到 15 元午餐');
  // 先下一单
  const order = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
    .send({ elderId: elder.id, mealId: meal.id, diningType: 'DINE_IN', qty: 1 });
  assert.strictEqual(order.status, 201);
  const oid = order.body.data.id;
  const subsidy = order.body.data.subsidyCents;
  const amountCents = order.body.data.amountCents;
  assert.ok(subsidy > 0, '下单应有补贴');

  // 查补贴明细存在
  const getBefore = await request(app).get(`/api/orders/${oid}`).set('Authorization', `Bearer ${token}`);
  assert.ok(getBefore.body.data.subsidyDetails.length > 0, '退订前应有补贴明细');

  // 查额度已累计
  const usageBefore = (await request(app)
    .get(`/api/settlements/monthly-usage/${elder.id}/2026-06`)
    .set('Authorization', `Bearer ${token}`)).body.data;
  assert.strictEqual(usageBefore.usedCents, subsidy, '退订前额度已累计');

  // 执行退订
  const cancel = await request(app).post(`/api/orders/${oid}/cancel`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(cancel.status, 200, JSON.stringify(cancel.body));
  assert.strictEqual(cancel.body.data.subsidyCents, 0, '退订后补贴应为 0');
  assert.strictEqual(cancel.body.data.payCents, amountCents, '退订后自付应等于餐价');
  assert.strictEqual(cancel.body.data.refundCents, subsidy, '退款金额应等于原补贴');
  assert.strictEqual(cancel.body.data.releasedCents, subsidy, '释放额度应等于原补贴');
  assert.ok(cancel.body.data.detailsDeleted > 0, '补贴明细应被删除');

  // 确认订单状态
  const getAfter = await request(app).get(`/api/orders/${oid}`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(getAfter.body.data.status, 'CANCELLED');
  assert.strictEqual(getAfter.body.data.subsidyDetails.length, 0, '退订后明细应为空');

  // 额度应释放
  const usageAfter = (await request(app)
    .get(`/api/settlements/monthly-usage/${elder.id}/2026-06`)
    .set('Authorization', `Bearer ${token}`)).body.data;
  assert.strictEqual(usageAfter.usedCents, 0, '退订后额度应归零');
});

test('节假日：节假日 CRUD 正常，订餐预览能自动识别', async () => {
  const admin = await loginAs('admin', 'admin123');
  const operator = await loginAs('operator', 'operator123');

  // 列表（种子里已经有元旦、端午、中秋、国庆）
  const list = await request(app).get('/api/settlements/holidays').set('Authorization', `Bearer ${admin}`);
  assert.strictEqual(list.status, 200);
  assert.ok(list.body.data.length >= 10, '至少含 10 条种子节假日');

  // 预览接口：端午节（2026-06-19）订午餐，节假日加补应生效
  // 先加一个 2026-06-19 的午餐
  const canteens = (await request(app).get('/api/canteens').set('Authorization', `Bearer ${admin}`)).body.data;
  const cid = canteens[0].id;
  const meal = await request(app).post('/api/meals').set('Authorization', `Bearer ${admin}`)
    .send({ canteenId: cid, serveDate: '2026-06-19', mealType: 'LUNCH', dishName: '端午特餐', priceCents: 2000, status: 'PUBLISHED' });
  assert.strictEqual(meal.status, 201, JSON.stringify(meal.body));
  const elders = (await request(app).get('/api/elders').set('Authorization', `Bearer ${operator}`)).body.data;
  const elder = elders.find((e) => e.code === 'E-0003'); // C级 无身份
  const preview = await request(app)
    .get(`/api/settlements/preview/order?elderId=${elder.id}&mealId=${meal.body.data.id}`)
    .set('Authorization', `Bearer ${operator}`);
  assert.strictEqual(preview.status, 200, JSON.stringify(preview.body));
  assert.strictEqual(preview.body.data.isHoliday, true, '2026-06-19 应被识别为端午节');
  // C级基础 200 + 节假日加补 200 = 400
  assert.strictEqual(preview.body.data.netSubsidyCents, 400, `C级基础2+节假日2=4元即400分，实际400`);
});

test('结算生成接口：路由不被 :id 抢占，返回 200 且三维度齐全', async () => {
  const token = await loginAs('operator', 'operator123');

  // 先加一些真实的带补贴的订单
  const elders = (await request(app).get('/api/elders').set('Authorization', `Bearer ${token}`)).body.data;
  const meals = (await request(app).get('/api/meals').set('Authorization', `Bearer ${token}`)).body.data;
  for (const meal of meals) {
    for (const elder of elders.slice(0, 2)) {
      await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
        .send({ elderId: elder.id, mealId: meal.id, diningType: 'DINE_IN', qty: 1 });
    }
  }

  // 访问 /locks 确认不被 /:id 抢占
  const locks = await request(app).get('/api/settlements/locks').set('Authorization', `Bearer ${token}`);
  assert.strictEqual(locks.status, 200, 'GET /locks 应返回 200（不能被 /:id 抢占为 404）');

  // 生成结算
  const gen = await request(app).post('/api/settlements/generate').set('Authorization', `Bearer ${token}`)
    .send({ month: '2026-06' });
  assert.strictEqual(gen.status, 200, `结算生成应 200，实际 ${gen.status}：${JSON.stringify(gen.body)}`);
  const { month, sheets, discrepancyCount, totals, capRules, holidayCount } = gen.body.data;
  assert.strictEqual(month, '2026-06');
  const types = sheets.map((s) => s.sheetType);
  assert.ok(types.includes('BY_CANTEEN'), '应有按助餐点维度');
  assert.ok(types.includes('BY_LEVEL'), '应有按等级维度');
  assert.ok(types.includes('BY_IDENTITY'), '应有按身份维度');
  assert.ok(Array.isArray(sheets) && sheets.length >= 3, `至少生成 3 张结算单，实际 ${sheets.length}`);
  assert.ok(totals.totalAmountCents > 0, '汇总金额应 > 0');
  assert.ok(totals.totalSubsidyCents > 0, '汇总补贴应 > 0');
  assert.strictEqual(capRules.A, 30000, '快照 capA=30000');
  assert.strictEqual(capRules.B, 20000, '快照 capB=20000');
  assert.strictEqual(capRules.C, 10000, '快照 capC=10000');
  assert.ok(holidayCount >= 1, '快照应包含当月节假日');
  assert.strictEqual(typeof discrepancyCount, 'number', '差异计数应是数字');

  // 列表与单条查询可用
  const list = await request(app).get('/api/settlements?month=2026-06').set('Authorization', `Bearer ${token}`);
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.body.data.length, sheets.length);
  const one = await request(app).get(`/api/settlements/${sheets[0].id}`).set('Authorization', `Bearer ${token}`);
  assert.strictEqual(one.status, 200);
  assert.ok('discrepancies' in one.body.data, '单条结算单应附带差异列表');
});

test('勾稽差异：退订后补贴未清零的订单能被识别为 CANCELLED_WITH_SUBSIDY', async () => {
  const admin = await loginAs('admin', 'admin123');
  const operator = await loginAs('operator', 'operator123');

  const elders = (await request(app).get('/api/elders').set('Authorization', `Bearer ${operator}`)).body.data;
  const meals = (await request(app).get('/api/meals').set('Authorization', `Bearer ${operator}`)).body.data;
  const elder = elders[0];
  const meal = meals[0];

  // 下单一笔有补贴的订单
  const order = await request(app).post('/api/orders').set('Authorization', `Bearer ${operator}`)
    .send({ elderId: elder.id, mealId: meal.id, diningType: 'DINE_IN', qty: 1 });
  assert.strictEqual(order.status, 201);
  const oid = order.body.data.id;
  assert.ok(order.body.data.subsidyCents > 0);

  // 模拟「退订未回退」：直接把订单改成 CANCELLED 但不清理 subsidy_cents
  const { getPool } = require('../src/db');
  await getPool().query('UPDATE orders SET status = ?, subsidy_cents = subsidy_cents WHERE id = ?', ['CANCELLED', oid]);

  // 生成结算
  const gen = await request(app).post('/api/settlements/generate').set('Authorization', `Bearer ${operator}`)
    .send({ month: '2026-06' });
  assert.strictEqual(gen.status, 200, JSON.stringify(gen.body));
  const { discrepancyByType } = gen.body.data;
  assert.ok(discrepancyByType && discrepancyByType.CANCELLED_WITH_SUBSIDY >= 1,
    `应识别出 CANCELLED_WITH_SUBSIDY 差异，实际 ${JSON.stringify(discrepancyByType)}`);
});

test('规则变更试算（recalc）：不修改库、返回差异统计，锁定后 409', async () => {
  const admin = await loginAs('admin', 'admin123');
  const operator = await loginAs('operator', 'operator123');

  // 先造订单
  const elders = (await request(app).get('/api/elders').set('Authorization', `Bearer ${operator}`)).body.data;
  const meals = (await request(app).get('/api/meals').set('Authorization', `Bearer ${operator}`)).body.data;
  for (const meal of meals.slice(0, 2)) {
    for (const elder of elders) {
      const res = await request(app).post('/api/orders').set('Authorization', `Bearer ${operator}`)
        .send({ elderId: elder.id, mealId: meal.id, diningType: 'DINE_IN', qty: 1 });
      assert.strictEqual(res.status, 201);
    }
  }

  // 重算（ADMIN 才能调）
  const recalc = await request(app).post('/api/settlements/recalc').set('Authorization', `Bearer ${admin}`)
    .send({ month: '2026-06' });
  assert.strictEqual(recalc.status, 200, `重算接口应 200，实际 ${recalc.status}：${JSON.stringify(recalc.body)}`);
  const d = recalc.body.data;
  assert.ok(d.totalOrders > 0, '总订单数应 > 0');
  assert.strictEqual(typeof d.affectedCount, 'number');
  assert.strictEqual(typeof d.totalDiffCents, 'number');
  assert.ok(Array.isArray(d.details), '应返回重算明细');

  // VIEWER / OPERATOR 无权调 recalc
  const viewer = await loginAs('viewer', 'viewer123');
  const fobidden1 = await request(app).post('/api/settlements/recalc').set('Authorization', `Bearer ${viewer}`)
    .send({ month: '2026-06' });
  assert.strictEqual(fobidden1.status, 403, 'VIEWER 无权重算');
  const fobidden2 = await request(app).post('/api/settlements/recalc').set('Authorization', `Bearer ${operator}`)
    .send({ month: '2026-06' });
  assert.strictEqual(fobidden2.status, 403, 'OPERATOR 无权重算');

  // 锁定
  const lock = await request(app).post('/api/settlements/locks/2026-06').set('Authorization', `Bearer ${admin}`)
    .send({ remark: '测试锁定' });
  assert.strictEqual(lock.status, 201, '锁定应 201');
  const checkLock = await request(app).get('/api/settlements/locks/2026-06').set('Authorization', `Bearer ${admin}`);
  assert.strictEqual(checkLock.status, 200);
  assert.strictEqual(checkLock.body.data.locked, true);

  // 锁定后 recalc 应 409
  const recalcLocked = await request(app).post('/api/settlements/recalc').set('Authorization', `Bearer ${admin}`)
    .send({ month: '2026-06' });
  assert.strictEqual(recalcLocked.status, 409, '锁定后重算应拒绝 409');

  // 锁定后 generate 应 409
  const genLocked = await request(app).post('/api/settlements/generate').set('Authorization', `Bearer ${operator}`)
    .send({ month: '2026-06' });
  assert.strictEqual(genLocked.status, 409, '锁定后生成结算应拒绝 409');

  // 锁定后订餐 409
  const orderLocked = await request(app).post('/api/orders').set('Authorization', `Bearer ${operator}`)
    .send({ elderId: elders[0].id, mealId: meals[0].id, diningType: 'DINE_IN', qty: 1 });
  assert.strictEqual(orderLocked.status, 409, '锁定后订餐应拒绝 409');
});

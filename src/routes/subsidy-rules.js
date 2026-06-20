'use strict';

const express = require('express');
const store = require('../data/store');
const { authRequired, requireRole } = require('../auth');
const { sendData, sendError, parseId } = require('../utils/http');

const router = express.Router();
router.use(authRequired);

router.get('/', async (req, res, next) => {
  try {
    const { ruleType, status, effectiveDate } = req.query;
    const f = {};
    if (ruleType) f.ruleType = ruleType;
    if (status) f.status = status;
    if (effectiveDate) f.effectiveDate = effectiveDate;
    return sendData(res, 200, await store.listSubsidyRules(f));
  } catch (e) { return next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const r = await store.getSubsidyRuleById(id);
    if (!r) return sendError(res, 404, '补贴规则不存在');
    return sendData(res, 200, r);
  } catch (e) { return next(e); }
});

router.post('/', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const { code, name, ruleType, effectiveFrom } = req.body || {};
    if (!code || !name || !ruleType || !effectiveFrom) return sendError(res, 400, '编号、名称、规则类型、生效日期不能为空');
    if (await store.getSubsidyRuleByCode(code)) return sendError(res, 409, '规则编号已存在');
    return sendData(res, 201, await store.createSubsidyRule(req.body));
  } catch (e) { return next(e); }
});

router.put('/:id', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!(await store.getSubsidyRuleById(id))) return sendError(res, 404, '补贴规则不存在');
    return sendData(res, 200, await store.updateSubsidyRule(id, req.body || {}));
  } catch (e) { return next(e); }
});

router.delete('/:id', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!(await store.getSubsidyRuleById(id))) return sendError(res, 404, '补贴规则不存在');
    const deleted = await store.deleteSubsidyRule(id);
    return sendData(res, 200, { id, deleted });
  } catch (e) { return next(e); }
});

module.exports = router;

'use strict';

/**
 * handlers 聚合出口
 *
 * router 通过这里访问执行器与数据查询能力。
 */

const actions = require('./actions');

// 数据查询能力复用原有 analyze（结构已经清晰，不重写）
let analyze;
try {
  analyze = require('../../src/analyze');
} catch (_) {
  analyze = {};
}

module.exports = {
  apply: actions.apply,
  doRemind: actions.doRemind,
  doNote: actions.doNote,
  doCampaign: actions.doCampaign,
  doProduct: actions.doProduct,
  doForget: actions.doForget,
  findDuplicate: actions.findDuplicate,
  analyze,
};

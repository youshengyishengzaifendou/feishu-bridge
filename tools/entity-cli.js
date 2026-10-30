'use strict';

/**
 * 实体与任务命令行 —— 不经过飞书/LLM 直接查改
 *
 * 用法：
 *   node tools/entity-cli.js stats
 *   node tools/entity-cli.js products
 *   node tools/entity-cli.js product 632
 *   node tools/entity-cli.js campaigns
 *   node tools/entity-cli.js assign "活动名" "产品名"     把活动挂到产品
 *   node tools/entity-cli.js tasks [open|done|all]
 *   node tools/entity-cli.js due                       列出当前该发的
 *   node tools/entity-cli.js search "白色632"
 *   node tools/entity-cli.js catalog                    打印给模型看的目录
 */

const db = require('../src/db');
const memory = require('../src/memory');
const catalog = require('../src/catalog');

const [cmd, ...rest] = process.argv.slice(2);

function pad(s, n) {
  const t = String(s ?? '');
  const w = [...t].length;
  return t + ' '.repeat(Math.max(0, n - w));
}

function main() {
  switch (cmd) {
    case 'stats': {
      const s = db.stats();
      console.log(`数据库 ${s.file}`);
      console.log(`  提醒   ${s.tasks.open} 待发 / ${s.tasks.done} 已完成`);
      console.log(`  产品   ${s.products}`);
      console.log(`  活动   ${s.campaigns}`);
      console.log(`  笔记   ${s.notes}`);
      console.log(`  已见   ${s.seen}`);
      console.log(`  待重试 ${s.queue}`);
      break;
    }

    case 'products': {
      for (const p of db.listProducts()) {
        console.log(`${pad(p.name, 22)} ${pad(p.series, 10)} ${pad(p.asin || '—', 13)} ${p.sku || '—'}`);
      }
      break;
    }

    case 'product': {
      const q = rest.join(' ');
      const hits = memory.findProducts(q, { limit: 3 });
      if (!hits.length) { console.log(`没找到「${q}」`); break; }
      for (const h of hits) {
        const card = memory.productCard(h.id);
        console.log(`\n${h.name}（${h.series}）`);
        console.log(`  ASIN ${h.asin || '—'}  SKU ${h.sku || '—'}  id ${h.id}`);
        console.log(`  活动 ${card.campaigns.length} 个${card.campaigns.length ? '：' + card.campaigns.map((c) => c.name).join('；') : ''}`);
        console.log(`  笔记 ${card.notes.length} 条  提醒 ${card.tasks.length} 条`);
      }
      break;
    }

    case 'campaigns': {
      for (const c of db.listCampaigns({ limit: 200 })) {
        const p = c.productId ? db.getProduct(c.productId) : null;
        console.log(`${pad(c.name, 52)} → ${p ? p.name : '【未归属】'}  (${c.type || '—'})`);
      }
      break;
    }

    case 'assign': {
      const [name, product] = rest;
      if (!name || !product) { console.log('用法: assign "活动名" "产品名"'); process.exitCode = 1; break; }
      const prods = memory.findProducts(product, { limit: 1 });
      if (!prods.length) { console.log(`没找到产品「${product}」`); process.exitCode = 1; break; }
      const r = memory.recordCampaign({ name, productId: prods[0].id });
      console.log(`已把「${r.campaign.name}」挂到「${r.product.name}」（依据：${r.resolvedBy}）`);
      break;
    }

    case 'tasks': {
      const mode = rest[0] || 'open';
      const done = mode === 'all' ? null : mode === 'done';
      const list = db.listTasks({ done, limit: 500 });
      for (const t of list) {
        const when = `${t.due.slice(0, 10)} ${t.due.slice(11, 16)}`;
        const state = t.done ? '✓' : (t.earliestMs <= Date.now() ? '!' : ' ');
        console.log(`${state} ${pad(when, 17)} ${pad(t.title, 40)} ${t.advance.join('/')}${t.repeat ? ` ${t.repeat.kind}` : ''}`);
      }
      console.log(`\n共 ${list.length} 条`);
      break;
    }

    case 'due': {
      const list = db.dueTasks(Date.now(), 50);
      if (!list.length) { console.log('当前没有到期待发的提醒'); break; }
      for (const t of list) {
        console.log(`! ${t.due.slice(0, 16)} ${t.title}  fired=[${t.fired.join(',')}]`);
      }
      break;
    }

    case 'search': {
      const q = rest.join(' ');
      const hits = db.search(q, { limit: 10 });
      if (!hits.length) { console.log(`「${q}」没有命中`); break; }
      for (const h of hits) {
        const label = h.kind === 'task' ? h.item.title
          : h.kind === 'product' ? h.item.name
          : h.kind === 'campaign' ? h.item.name
          : String(h.item.text).slice(0, 60);
        console.log(`${pad(h.kind, 10)} ${pad(h.score.toFixed(2), 8)} ${label}`);
      }
      break;
    }

    case 'catalog': {
      console.log(catalog.build({ force: true }));
      break;
    }

    default:
      console.log(`用法: node tools/entity-cli.js <stats|products|product|campaigns|assign|tasks|due|search|catalog>`);
  }
}

// 有些查询需要外部数据（catalog），包一层错误处理
try {
  main();
} catch (e) {
  console.error(`失败: ${e.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}

import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
const dir = new URL('../apps/patient/src/assets/poses/', import.meta.url).pathname, out = process.env.OUT;
const names = ['sitting-flex-thigh','sitting-flex-shin','sitting-ext-thigh','sitting-ext-shin','lying-flex-thigh','lying-flex-shin','lying-ext-thigh','lying-ext-shin'];
const pick = process.env.ONLY ? process.env.ONLY.split(',') : names;
const html = `<body style="margin:0;background:#fff;display:grid;grid-template-columns:repeat(2,${process.env.W ?? 600}px);gap:6px">${pick.map((n) => `<div>${readFileSync(dir + n + '.svg', 'utf8').replace('<svg ', `<svg width="${process.env.W ?? 600}" `)}<small style="font:12px sans-serif">${n}</small></div>`).join('')}</body>`;
const br = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const pg = await br.newPage({ viewport: { width: (Number(process.env.W ?? 600) + 6) * 2, height: 900 } });
await pg.setContent(html); await pg.screenshot({ path: out, fullPage: true }); await br.close();

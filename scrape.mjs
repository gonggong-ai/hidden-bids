// 스크립트로 목록을 불러오는 게시판(B형)을 실제 브라우저로 열어 공고 행을 뽑는다.
// 결과: data/hidden_b.json  → Apps Script(H04_실행.gs collectB_)가 읽어 원장에 합친다.
import { chromium } from 'playwright';
import fs from 'node:fs';

const sites = JSON.parse(fs.readFileSync(new URL('./sites.json', import.meta.url)));
const onlyOrg = process.env.ONLY || '';   // 특정 기관만 테스트: ONLY=세종대학교 node scrape.mjs

// 브라우저 안에서 실행되는 범용 추출기:
// "날짜가 보이는 가장 작은 덩어리"를 행으로 보고, 그 안에서 가장 긴 링크 글자를 제목으로 잡는다.
function extractInPage(listUrl) {
  const DATE = /(20\d{2})\s*[.\-\/년]\s*(\d{1,2})\s*[.\-\/월]\s*(\d{1,2})/g;
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const datesOf = (t) => {
    const out = []; let m; DATE.lastIndex = 0;
    while ((m = DATE.exec(t))) {
      const mo = +m[2], d = +m[3];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) out.push(`${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
    return out;
  };
  const skip = 'header,footer,nav,aside,script,style,noscript';
  const all = Array.from(document.querySelectorAll('tr,li,article,dl,div,a'));
  const cand = all.filter((el) => {
    if (el.closest(skip)) return false;
    const t = norm(el.innerText);
    if (t.length < 10 || t.length > 600) return false;
    DATE.lastIndex = 0;
    if (!DATE.test(t)) return false;
    return !!(el.tagName === 'A' || el.querySelector('a,[onclick]') || el.hasAttribute('onclick'));
  });
  const set = new Set(cand);
  // 가장 작은 덩어리만 (자식 중에 후보가 있으면 버림) — 단, 링크 하나만 있는 a는 부모 행을 선호
  const leaves = cand.filter((el) => !cand.some((o) => o !== el && el.contains(o) && o.tagName !== 'A'));
  const rows = []; const seen = new Set();
  for (const el of leaves) {
    const text = norm(el.innerText);
    const dates = datesOf(text);
    if (!dates.length) continue;
    const anchors = el.tagName === 'A' ? [el] : Array.from(el.querySelectorAll('a,[onclick]'));
    let best = null;
    for (const a of anchors) {
      let t = norm(a.getAttribute('title')) .length > norm(a.innerText).length ? norm(a.getAttribute('title')) : norm(a.innerText);
      t = t.replace(/(20\d{2})\s*[.\-\/]\s*\d{1,2}\s*[.\-\/]\s*\d{1,2}.*$/, '').replace(/\s*(새글|NEW|new|N)\s*$/, '').trim();
      if (t.length < 6) continue;
      if (!best || t.length > best.t.length) best = { t, a };
    }
    if (!best) continue;
    const href = best.a.getAttribute('href') || '';
    let link = listUrl;
    if (href && !/^(javascript:|#)/i.test(href)) { try { link = new URL(href, location.href).href; } catch (e) {} }
    const key = best.t + '|' + dates[0];
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ title: best.t, date: dates[0], dates: dates.slice(1).join(' '), link });
  }
  void set;
  return rows;
}

// pikk: <a href="/bid/5072"><article><div><div>발주기관</div><h3>공고명</h3></div> … 마감일: 2026.10.08
// 게시일이 없어서 date = 오늘(한국 시간), dates = '마감 yyyy-mm-dd', org = 실제 발주기관
function extractPikk() {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  return Array.from(document.querySelectorAll('a[href^="/bid/"]')).map((a) => {
    const h3 = a.querySelector('h3');
    if (!h3) return null;
    const orgEl = h3.previousElementSibling || (h3.parentElement && h3.parentElement.querySelector('div'));
    const m = norm(a.innerText).match(/마감일\s*[:：]\s*(20\d{2})[.\-](\d{1,2})[.\-](\d{1,2})/);
    const due = m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
    return { org: norm(orgEl && orgEl.innerText), title: norm(h3.innerText), date: today,
             dates: due ? '마감 ' + due : '', link: new URL(a.getAttribute('href'), location.href).href };
  }).filter((x) => x && x.org && x.title.length >= 6);
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext({
  locale: 'ko-KR',
  timezoneId: 'Asia/Seoul',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  ignoreHTTPSErrors: true
});
const out = { generatedAt: new Date().toISOString(), rows: [], report: [] };
const todo = sites.filter((s) => !onlyOrg || s.org === onlyOrg);

// 한 곳 읽기. 0행이면 원인 파악용으로 화면 제목·글자 수·날짜 개수·화면 뒤에서 부른 데이터 주소를 남긴다
async function scrapeOne(s) {
  const page = await context.newPage();
  const r = { org: s.org, url: s.url };
  const xhr = [];
  page.on('response', (resp) => {
    const t = resp.request().resourceType();
    if ((t === 'xhr' || t === 'fetch') && xhr.length < 8) xhr.push(resp.request().method() + ' ' + resp.status() + ' ' + resp.url().slice(0, 160));
  });
  const rows = [];
  try {
    const urls = s.pages && s.pageUrl ? Array.from({ length: s.pages }, (_, i) => s.pageUrl.replace('{p}', i + 1)) : [s.url];
    for (const u of urls) {
      const resp = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 });
      r.code = resp ? resp.status() : null;
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(s.wait || 2500);
      rows.push(...(await page.evaluate(s.mode === 'pikk' ? extractPikk : extractInPage, s.url)));
    }
    r.rows = rows.length;
    r.sample = rows.slice(0, 3).map((x) => `${x.date} ${x.org ? x.org + ' | ' : ''}${x.title}`);
    if (!rows.length) {
      r.debug = await page.evaluate(() => {
        const t = (document.body && document.body.innerText) || '';
        const d = (t.match(/20\d{2}\s*[.\-\/]\s*\d{1,2}\s*[.\-\/]\s*\d{1,2}/g) || []).length;
        return { title: document.title, finalUrl: location.href, textLen: t.length, dates: d, head: t.replace(/\s+/g, ' ').slice(0, 200) };
      });
      r.xhr = xhr;
    }
  } catch (e) {
    r.err = String(e.message || e).slice(0, 200);
  }
  await page.close();
  return { r, rows };
}

// 4곳씩 동시에 (사이트가 늘어도 20분 안에 끝나도록)
const results = new Array(todo.length);
let next = 0;
await Promise.all(Array.from({ length: Math.min(4, todo.length) }, async () => {
  while (next < todo.length) { const i = next++; results[i] = await scrapeOne(todo[i]); }
}));
results.forEach(({ r, rows }, i) => {
  const s = todo[i];
  out.report.push(r);
  for (const x of rows) out.rows.push({ org: s.org, site: s.url, ...x });   // pikk는 x.org(실제 발주기관)가 덮어씀
  console.log(`${r.err ? '❌' : r.rows ? '✅' : '⚠️'} ${s.org} | HTTP ${r.code ?? '-'} | 행 ${r.rows ?? 0}${r.err ? ' | ' + r.err : ''}`);
  (r.sample || []).forEach((x) => console.log('    · ' + x));
  if (r.debug) console.log('    ? ' + JSON.stringify(r.debug));
  (r.xhr || []).forEach((x) => console.log('    > ' + x));
});
await browser.close();

fs.mkdirSync(new URL('./data/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('./data/hidden_b.json', import.meta.url), JSON.stringify(out, null, 1));
console.log(`합계 ${out.rows.length}행 → data/hidden_b.json`);

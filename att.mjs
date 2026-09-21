// 구글 서버로는 첨부파일을 받을 수 없는 곳(받기 주소가 암호화돼 있거나 구글 서버 접속을 막는 곳)을
// 실제 브라우저로 열어 첨부파일을 받아 data/att/ 에 저장하고, 목록을 data/att_manifest.json 에 적는다.
// → Apps Script(H07_첨부.gs ghAtt_)가 이 목록을 읽어 드라이브 공고 폴더에 넣는다.
//   우리카드: 목록 화면에서 공고를 눌러 들어가야 상세가 뜨고, 첨부는 RAON K 부품(AES로 암호화된 주소)으로만 받아짐
//   하나금융그룹: 구글 서버에서 시간초과, 상세는 viewPage(번호) 로 여는 화면
//   한국여자농구연맹: 구글 서버에 403
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('./data/', import.meta.url).pathname;
const MAN = path.join(ROOT, 'att_manifest.json');
const MAX_AGE_DAYS = 60;          // 이 기간 안의 공고만
const BID = /입찰|제안|공고|선정|용역|구축|구매|도입/;
const NOT_BID = /채용|합격|모집 결과|당첨|이벤트/;

const man = fs.existsSync(MAN) ? JSON.parse(fs.readFileSync(MAN, 'utf8')) : { items: [] };
const have = new Set(man.items.filter((x) => x.files && x.files.length).map((x) => x.org + '|' + x.id));
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const cutoff = new Date(Date.now() + 9 * 3600e3 - MAX_AGE_DAYS * 86400e3).toISOString().slice(0, 10);
const safe = (s) => String(s).replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
const report = [];
const DEADLINE = Date.now() + 14 * 60e3;   // 전체 14분 안에 끝냄 (GitHub 작업 제한 30분)
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
function saveMan() { fs.mkdirSync(ROOT, { recursive: true }); man.generatedAt = new Date().toISOString(); man.report = report; fs.writeFileSync(MAN, JSON.stringify(man, null, 1)); }

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext({
  locale: 'ko-KR', timezoneId: 'Asia/Seoul', acceptDownloads: true, ignoreHTTPSErrors: true,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'
});
context.on('page', (p) => p.on('dialog', (d) => d.accept().catch(() => {})));   // 안내창이 뜨면 바로 닫음

function upsert(item) {
  const i = man.items.findIndex((x) => x.org === item.org && x.id === item.id);
  if (i >= 0) man.items[i] = item; else man.items.push(item);
}

async function saveDownload(dl, dir) {
  const name = safe(dl.suggestedFilename() || 'file');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  await dl.saveAs(p);
  return { name, path: path.relative(path.join(ROOT, '..'), p).split(path.sep).join('/'), bytes: fs.statSync(p).size };
}

// ── 우리카드 ─────────────────────────────────────────────
async function wooricard() {
  const org = '우리카드';
  const LIST = 'https://pc.wooricard.com/dcpc/yh1/cct/cct02/anc/H1CCT202S04.do';
  const page = await context.newPage();
  let resp = null;
  for (let t = 1; t <= 3 && !resp; t++) {   // 해외 접속이 가끔 끊겨서 세 번까지
    try {
      resp = await page.request.post('https://pc.wooricard.com/dcpc/yh1/cmn/bbs/searchBbsList.pwkjson', {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Proworks-Body': 'Y', 'Proworks-Lang': 'ko' },
        data: JSON.stringify({ bbsVo: { scBbsCode: '1012', bbsSearchKey: '', bbsSearchVal: '', pageIndex: '1', pageSize: 40 } }),
        timeout: 60000
      });
    } catch (e) { log(org, '목록 읽기 실패', t, String(e.message || e).slice(0, 80)); await page.waitForTimeout(10000); }
  }
  if (!resp) throw new Error('목록 데이터를 세 번 다 못 읽음');
  const list = ((await resp.json()).bbsList || [])
    .map((x) => ({ id: String(x.bbscttSn), title: String(x.sj || '').trim(), date: String(x.registDt || '').slice(0, 10).replace(/\./g, '-') }))
    .filter((x) => BID.test(x.title) && !NOT_BID.test(x.title) && (!x.date || x.date >= cutoff));
  log(org, '대상', list.length);
  for (const it of list) {
    if (have.has(org + '|' + it.id)) continue;
    if (Date.now() > DEADLINE) { log('시간 다 됨 — 다음 실행 때 이어서'); break; }
    const r = { org, id: it.id, title: it.title };
    log(org, it.id, it.title.slice(0, 40));
    try {
      await page.goto(LIST, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      let link = page.locator('a', { hasText: it.title.slice(0, 25) }).first();
      for (let pg = 2; pg <= 5 && !(await link.count()); pg++) {   // 첫 쪽에 없으면 2~5쪽 (쪽 번호 글자는 '페이지 2' 모양)
        await page.locator('[class*=pag] a', { hasText: new RegExp('(^|\\s)' + pg + '$') }).first().click().catch(() => {});
        await page.waitForTimeout(2000);
        link = page.locator('a', { hasText: it.title.slice(0, 25) }).first();
      }
      if (!(await link.count())) { r.err = '목록에서 제목을 못 찾음'; report.push(r); continue; }
      await link.click();
      await page.waitForSelector('.attachFile a.links', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(2500);   // RAON K 부품 준비
      const links = page.locator('.attachFile a.links');
      const n = await links.count();
      const dir = path.join(ROOT, 'att', 'wooricard', it.id);
      const files = [];
      for (let k = 0; k < n; k++) {
        try {
          const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), links.nth(k).click()]);
          files.push(await saveDownload(dl, dir));
          log('   받음', files[files.length - 1].name, files[files.length - 1].bytes);
        } catch (e) { r.fileErr = (r.fileErr || '') + ` #${k}:${String(e.message || e).slice(0, 80)}`; log('   실패', k, String(e.message || e).slice(0, 100)); if (!files.length) break; }
        await page.waitForTimeout(1500);
      }
      upsert({ org, id: it.id, title: it.title, date: it.date, link: LIST + '#sn=' + it.id, files, at: today });
      r.files = files.length; r.links = n;
      log('   링크', n, '파일', files.length);
      saveMan();
    } catch (e) { r.err = String(e.message || e).slice(0, 200); }
    report.push(r);
  }
  await page.close();
}

// ── 하나금융그룹 ─────────────────────────────────────────
async function hanafn() {
  const org = '하나금융그룹';
  const LIST = 'https://www.hanafn.com/mediaRoom/hanaNews/noticeList.do';
  const page = await context.newPage();
  await page.goto(LIST, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  const list = await page.evaluate(() => Array.from(document.querySelectorAll('a[onclick*="viewPage"]')).map((a) => {
    const id = (a.getAttribute('onclick').match(/viewPage\(\s*['"]?(\d+)/) || [])[1];
    const t = a.innerText.replace(/\s+/g, ' ').trim();
    const d = (t.match(/(20\d{2})[.\-](\d{2})[.\-](\d{2})/) || []);
    return { id, title: t.replace(/(20\d{2})[.\-]\d{2}[.\-]\d{2}.*$/, '').trim(), date: d[0] ? `${d[1]}-${d[2]}-${d[3]}` : '' };
  }).filter((x) => x.id));
  log(org, '목록', list.length);
  for (const it of list.filter((x) => /입찰|제안/.test(x.title) && (!x.date || x.date >= cutoff))) {
    if (have.has(org + '|' + it.id)) continue;
    if (Date.now() > DEADLINE) break;
    const r = { org, id: it.id, title: it.title };
    log(org, it.id, it.title.slice(0, 40));
    try {
      await page.goto(LIST, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await Promise.all([page.waitForNavigation({ timeout: 30000 }).catch(() => {}), page.evaluate((id) => window.viewPage(id), it.id)]);
      await page.waitForTimeout(2500);
      // 본문 안의 첨부만 (머리·꼬리 메뉴의 보고서 PDF 등은 빼려고 제목 영역 아래의 crossDownload 링크만)
      const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href*="crossDownload"]'))
        .filter((a) => !a.closest('header,footer,nav,.gnb,.footer'))
        .map((a) => ({ href: a.href, text: a.innerText.replace(/\s+/g, ' ').trim() })));
      const dir = path.join(ROOT, 'att', 'hanafn', it.id);
      const files = [];
      for (const l of links) {
        try {
          const res = await page.request.get(l.href, { headers: { Referer: page.url() }, timeout: 60000 });
          if (!res.ok()) continue;
          const cd = res.headers()['content-disposition'] || '';
          let name = (cd.match(/filename\*=UTF-8''([^;]+)/i) || [])[1];
          if (name) name = decodeURIComponent(name); else {
            const m = cd.match(/filename="?([^";]+)"?/i);
            name = m ? m[1] : '';
            if (/%[0-9A-F]{2}/i.test(name)) { try { name = decodeURIComponent(name); } catch (e) {} }
          }
          if (!name || !/\.[A-Za-z0-9]{2,5}$/.test(name)) name = safe(l.text || 'file') + (/(pdf)/i.test(res.headers()['content-type'] || '') ? '.pdf' : '');
          const body = await res.body();
          if (/text\/html/i.test(res.headers()['content-type'] || '') && body.length < 50000) continue;
          fs.mkdirSync(dir, { recursive: true });
          const p = path.join(dir, safe(name));
          fs.writeFileSync(p, body);
          files.push({ name: safe(name), path: path.relative(path.join(ROOT, '..'), p).split(path.sep).join('/'), bytes: body.length });
        } catch (e) { r.fileErr = (r.fileErr || '') + ' ' + String(e.message || e).slice(0, 80); }
      }
      upsert({ org, id: it.id, title: it.title, date: it.date, link: LIST, files, at: today });
      r.files = files.length; r.links = links.length;
      log('   링크', links.length, '파일', files.length);
      saveMan();
    } catch (e) { r.err = String(e.message || e).slice(0, 200); }
    report.push(r);
  }
  await page.close();
}

// ── 한국여자농구연맹(WKBL) ────────────────────────────────
// 구글 서버는 403으로 막히지만 GitHub 브라우저로는 열림. 첨부는 /data/ 아래 그냥 파일 주소
async function wkbl() {
  const org = '한국여자농구연맹';
  const LIST = 'https://www.wkbl.or.kr/m/news/notice_list.asp';
  const page = await context.newPage();
  await page.goto(LIST, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const list = await page.evaluate(() => Array.from(document.querySelectorAll('a[href*="notice_view"]')).map((a) => ({
    id: (a.getAttribute('href').match(/num=(\d+)/) || [])[1], title: a.innerText.replace(/\s+/g, ' ').trim(), href: a.href
  })).filter((x) => x.id));
  const seen = new Set();
  log(org, '목록', list.length);
  for (const it of list.filter((x) => /입찰|제안|용역|선정/.test(x.title))) {
    if (seen.has(it.id) || have.has(org + '|' + it.id)) continue;
    seen.add(it.id);
    if (Date.now() > DEADLINE) break;
    const r = { org, id: it.id, title: it.title };
    try {
      await page.goto(it.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const date = await page.evaluate(() => ((document.body.innerText.match(/(20\d{2})[.\-](\d{2})[.\-](\d{2})/) || [])[0] || '').replace(/\./g, '-'));
      const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]'))
        .filter((a) => /\/data\/|\.(hwp|hwpx|pdf|zip|docx?|xlsx?|pptx?)$/i.test(decodeURI(a.href)))
        .map((a) => a.href));
      const dir = path.join(ROOT, 'att', 'wkbl', it.id);
      const files = [];
      for (const u of [...new Set(links)]) {
        try {
          const res = await page.request.get(u, { headers: { Referer: page.url() }, timeout: 120000 });
          const body = await res.body();
          if (!res.ok() || (/text\/html/i.test(res.headers()['content-type'] || '') && body.length < 50000)) continue;
          const name = safe(decodeURIComponent(u.split('?')[0].split('/').pop()));
          fs.mkdirSync(dir, { recursive: true });
          const p = path.join(dir, name);
          fs.writeFileSync(p, body);
          files.push({ name, path: path.relative(path.join(ROOT, '..'), p).split(path.sep).join('/'), bytes: body.length });
        } catch (e) { r.fileErr = (r.fileErr || '') + ' ' + String(e.message || e).slice(0, 80); }
      }
      upsert({ org, id: it.id, title: it.title, date, link: it.href, files, at: today });
      r.files = files.length; r.links = links.length;
      log(org, it.id, it.title.slice(0, 30), '파일', files.length);
      saveMan();
    } catch (e) { r.err = String(e.message || e).slice(0, 200); }
    report.push(r);
  }
  await page.close();
}

// ── 신한라이프 ───────────────────────────────────────────
// 목록(cdhi0510)에서 제목을 눌러야 상세가 열리고, 첨부는 dp.Form.downloadShtm('DigitalPlattform','/repo/DigitalPlattform/…') 모양
// 실제 파일 주소는 /repo/DigitalPlattform → /bizxpress 로 바꾼 주소
async function shinhanlife() {
  const org = '신한라이프';
  const LIST = 'https://www.shinhanlife.co.kr/hp/cdhi0510.do';
  const page = await context.newPage();
  await page.goto(LIST, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('a.tit', { timeout: 30000 }).catch(() => {});
  const list = await page.evaluate(() => Array.from(document.querySelectorAll('li')).map((li) => {
    const a = li.querySelector('a.tit'); if (!a) return null;
    const d = (li.innerText.match(/(20\d{2})[.\-](\d{2})[.\-](\d{2})/) || []);
    return { id: a.getAttribute('data-key') || '', title: a.innerText.replace(/\s+/g, ' ').trim(), date: d[0] ? `${d[1]}-${d[2]}-${d[3]}` : '' };
  }).filter((x) => x && x.id));
  log(org, '목록', list.length);
  for (const it of list.filter((x) => !x.date || x.date >= cutoff)) {
    if (have.has(org + '|' + it.id)) continue;
    if (Date.now() > DEADLINE) break;
    const r = { org, id: it.id, title: it.title };
    try {
      await page.goto(LIST, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('a.tit', { timeout: 30000 });
      await Promise.all([page.waitForNavigation({ timeout: 30000 }).catch(() => {}), page.locator(`a.tit[data-key="${it.id}"]`).click()]);
      await page.waitForTimeout(3000);
      const files = await page.evaluate(() => Array.from(document.querySelectorAll('a[href*="downloadShtm"]')).map((a) => {
        const m = a.getAttribute('href').match(/downloadShtm\(\s*'[^']*'\s*,\s*'([^']+)'\s*,\s*'([^']*)'/);
        return m ? { url: location.origin + m[1].replace('/repo/DigitalPlattform', '/bizxpress'), name: m[2] || m[1].split('/').pop() } : null;
      }).filter(Boolean));
      const dir = path.join(ROOT, 'att', 'shinhanlife', it.id);
      const got = [];
      for (const f of files) {
        try {
          const res = await page.request.get(f.url, { headers: { Referer: page.url() }, timeout: 60000 });
          const body = await res.body();
          if (!res.ok() || body.length < 200) continue;
          fs.mkdirSync(dir, { recursive: true });
          const pth = path.join(dir, safe(f.name));
          fs.writeFileSync(pth, body);
          got.push({ name: safe(f.name), path: path.relative(path.join(ROOT, '..'), pth).split(path.sep).join('/'), bytes: body.length });
        } catch (e) { r.fileErr = (r.fileErr || '') + ' ' + String(e.message || e).slice(0, 80); }
      }
      upsert({ org, id: it.id, title: it.title, date: it.date, link: LIST, files: got, at: today });
      r.files = got.length; r.links = files.length;
      log(org, it.title.slice(0, 28), '파일', got.length);
      saveMan();
    } catch (e) { r.err = String(e.message || e).slice(0, 200); }
    report.push(r);
  }
  await page.close();
}

// ── 원광대학교 ───────────────────────────────────────────
// 목록(cntrc.jsp)에서 돋보기 버튼(fn_read)을 눌러야 상세가 열리고, 파일 목록은 화면에서 그려짐
// 내려받기는 POST /services/adapters/adapter_down_wfile.jsp (worklinkno·worklinkgub·filemngno·ofilename)
async function wku() {
  const org = '원광대학교';
  const LIST = 'https://intra.wku.ac.kr/services/contract/cntrc.jsp';
  const page = await context.newPage();
  for (const state of ['I', 'E']) {
    if (Date.now() > DEADLINE) break;
    await page.goto(LIST + '?state=' + state, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    const list = await page.evaluate(() => Array.from(document.querySelectorAll('.cards')).map((c) => {
      const b = c.querySelector('button[onclick*="fn_read"]');
      const t = c.querySelector('.title');
      const d = (c.innerText.match(/(20\d{2})[.\-](\d{2})[.\-](\d{2})/) || []);
      return b && t ? { id: (b.getAttribute('onclick').match(/fn_read\('([0-9a-f]{32})'\)/) || [])[1],
                        title: t.innerText.replace(/\s+/g, ' ').trim(), date: d[0] ? `${d[1]}-${d[2]}-${d[3]}` : '' } : null;
    }).filter((x) => x && x.id));
    log(org, state, '목록', list.length);
    for (const it of list.filter((x) => !x.date || x.date >= cutoff)) {
      if (have.has(org + '|' + it.id)) continue;
      if (Date.now() > DEADLINE) break;
      const r = { org, id: it.id, title: it.title };
      try {
        await page.goto(LIST + '?state=' + state, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(1500);
        await Promise.all([page.waitForNavigation({ timeout: 30000 }).catch(() => {}), page.evaluate((id) => window.fn_read(id), it.id)]);
        await page.waitForTimeout(2500);
        const files = await page.evaluate(() => Array.from(document.querySelectorAll('button[onclick*="fn_download"]')).map((b) => {
          const m = b.getAttribute('onclick').match(/fn_download\(\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\)/);
          return m ? { worklinkno: m[1], worklinkgub: m[2], filemngno: m[3], ofilename: m[4] } : null;
        }).filter(Boolean));
        const dir = path.join(ROOT, 'att', 'wku', it.id);
        const got = [];
        for (const f of files) {
          try {
            const res = await page.request.post('https://intra.wku.ac.kr/services/adapters/adapter_down_wfile.jsp', { form: f, timeout: 60000 });
            const body = await res.body();
            if (!res.ok() || body.length < 500 || /rtn_code/.test(body.slice(0, 40).toString())) continue;
            fs.mkdirSync(dir, { recursive: true });
            const pth = path.join(dir, safe(f.ofilename));
            fs.writeFileSync(pth, body);
            got.push({ name: safe(f.ofilename), path: path.relative(path.join(ROOT, '..'), pth).split(path.sep).join('/'), bytes: body.length });
          } catch (e) { r.fileErr = (r.fileErr || '') + ' ' + String(e.message || e).slice(0, 80); }
        }
        upsert({ org, id: it.id, title: it.title, date: it.date, link: LIST, files: got, at: today });
        r.files = got.length; r.links = files.length;
        log(org, it.title.slice(0, 26), '파일', got.length);
        saveMan();
      } catch (e) { r.err = String(e.message || e).slice(0, 200); }
      report.push(r);
    }
  }
  await page.close();
}

for (const job of [wooricard, hanafn, wkbl, shinhanlife, wku]) {
  try { await job(); } catch (e) { report.push({ job: job.name, err: String(e.message || e).slice(0, 200) }); }
}
await browser.close();

// 오래된 공고(90일 넘음)는 목록과 파일에서 지움 — 저장소가 너무 커지지 않게
const old = new Date(Date.now() - 90 * 86400e3).toISOString().slice(0, 10);
man.items = man.items.filter((x) => {
  if ((x.date || x.at || today) >= old) return true;
  (x.files || []).forEach((f) => { try { fs.unlinkSync(path.join(ROOT, '..', f.path)); } catch (e) {} });
  return false;
});
saveMan();
report.forEach((r) => console.log(`${r.err ? '❌' : '✅'} ${r.org || r.job} ${r.id || ''} ${(r.title || '').slice(0, 40)} | 링크 ${r.links ?? '-'} 파일 ${r.files ?? 0}${r.err ? ' | ' + r.err : ''}${r.fileErr ? ' | ' + r.fileErr : ''}`));
console.log(`첨부 목록 ${man.items.length}건 → data/att_manifest.json`);

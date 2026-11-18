const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {chromium} = require('playwright');

const root = path.resolve(__dirname, '..');
const indexedId = '11111111-1111-4111-8111-111111111111';
const deliveredId = '22222222-2222-4222-8222-222222222222';
const cases = [indexedId, deliveredId].map((id, i) => ({
  id, inquiry_number:'PA-FIXTURE-'+i, event_name:'Fixture '+i, status:'waiting_customer', submission_source:'public_form'
}));
const longBody = 'お世話になっております。\n\n原文3行目\n'+('長文メールの続きです。無改行でも折り返します。'.repeat(40)+'\n').repeat(6)+'原文の末尾です。';
const sentAt = '2026-11-15T03:00:00Z';
const indexed = Array.from({length:12}, (_, i) => ({
  inquiry_id:indexedId, gmail_message_id:'gmail-'+i, direction:'inbound', received_at:sentAt,
  subject:'Gmail '+i, from_address:'fixture@example.invalid', to_addresses:['desk@example.invalid'],
  body_text:i<2?undefined:longBody, snippet:'Do not substitute this snippet for the original body',
  attachment_metadata:i===0?[{id:'part1',filename:'資料.pdf',mime_type:'application/pdf'}]:[]
}));
const deliveries = Array.from({length:12}, (_, i) => ({
  id:'delivery-'+i, inquiry_id:deliveredId, status:'sent', message_type:'content_hearing_follow_up',
  gmail_message_id:'outgoing-'+i, body:i===11?'':longBody,
  recipient:'fixture@example.invalid', subject:'配送 '+i, sent_at:sentAt
}));
deliveries[10] = {...deliveries[10], status:'failed', error_summary:'mail_outcome_unknown'};
const merged = {...deliveries[0], id:'merged-delivery', inquiry_id:deliveredId, gmail_message_id:'merged'};
const mergedIndex = {
  inquiry_id:deliveredId, gmail_message_id:'merged', direction:'outbound', sent_at:sentAt, subject:'合流', body_text:longBody
};

async function main() {
  const writes = [], errors = [];
  let releaseBody;
  let bodyGate;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url,'http://127.0.0.1');
    if (url.pathname === '/api/pa-workspace-read') {
      const route = url.searchParams.get('path');
      const data = {
        '/data/cases':{cases,progress:[]},
        ['/data/mail/'+indexedId]:indexed,
        ['/data/mail/'+deliveredId]:[mergedIndex,mergedIndex],
        ['/data/case/'+deliveredId+'/deliveries']:[...deliveries,merged],
        ['/data/commercial/'+indexedId]:{estimates:[],offers:[],billings:[]},
        ['/data/commercial/'+deliveredId]:{estimates:[],offers:[],billings:[]}
      };
      res.setHeader('Content-Type','application/json');
      if (route.endsWith('/gmail-0')) {
        await bodyGate;
        return res.end(JSON.stringify({ok:true,result:{inquiry_id:indexedId,gmail_message_id:'gmail-0',body_text:longBody}}));
      }
      if (route.endsWith('/gmail-1')) {
        res.statusCode = 500;
        return res.end(JSON.stringify({ok:false,error:'fixture_read_error'}));
      }
      return res.end(JSON.stringify({ok:true,result:data[route]??[]}));
    }
    const file = path.resolve(root,'.'+url.pathname);
    if (!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()) {
      res.writeHead(404);return res.end();
    }
    const types = {'.mjs':'text/javascript','.js':'text/javascript','.html':'text/html','.css':'text/css','.png':'image/png'};
    res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');
    return res.end(fs.readFileSync(file));
  });
  let browser;
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin = 'http://127.0.0.1:'+server.address().port;
    browser = await chromium.launch();
    for (const width of [1440,390]) {
      bodyGate = new Promise(resolve=>{releaseBody=resolve;});
      const page = await browser.newPage({viewport:{width,height:900}});
      page.setDefaultTimeout(8000);
      page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/*',route=>{
        if (new URL(route.request().url()).origin!==origin) return route.abort();
        if (route.request().method()==='GET') return route.continue();
        writes.push(route.request().method());return route.abort();
      });
      await page.route('**/pa-ui/js/integration.mjs',route=>route.fulfill({contentType:'text/javascript',body:`
        const session={access_token:'fixture-owner-token',user:{id:'owner'},expires_at:9999999999};
        export const workspaceAuth={restore:async()=>session,current:async()=>session};
        export const readUrl=p=>'/api/pa-workspace-read?path='+encodeURIComponent(p);
        export const legacyUrl=id=>'/pa-admin-legacy.html?case='+id;`}));
      const open = id=>page.goto(origin+'/pa-admin.html?case='+id+'&tab=conversation&mail-view=readonly');
      const body = card=>card.locator('.mail-excerpt');
      const toggle = card=>card.locator('[data-body-read]');
      const folded = async card=>{
        assert.equal(await toggle(card).getAttribute('aria-expanded'),'false');
        assert(await body(card).evaluate(n=>{
          const css=getComputedStyle(n);
          return css.webkitLineClamp==='3'&&n.clientHeight <= Math.ceil(parseFloat(css.lineHeight)*3)&&n.getBoundingClientRect().width>0;
        }));
      };
      const exercise = async card=>{
        await folded(card);
        assert.match(await body(card).textContent(),/^原文3行目 長文メールの続きです。/u);
        await card.getByRole('button',{name:'全文を表示',exact:true}).click();
        assert.equal(await toggle(card).getAttribute('aria-expanded'),'true');
        assert.equal(await body(card).textContent(),longBody);
        await card.getByRole('button',{name:'閉じる',exact:true}).click();
        await folded(card);
      };
      await open(indexedId);
      const incoming = page.locator('[data-message="gmail-0"]');
      await incoming.evaluate(node=>node.scrollIntoView());
      await incoming.getByRole('button',{name:'本文を取得中…'}).waitFor();
      await folded(incoming);
      releaseBody();
      await incoming.getByRole('button',{name:'全文を表示',exact:true}).waitFor();
      assert.equal(await incoming.getByRole('button',{name:'返信',exact:true}).isEnabled(),false);
      assert.equal(await incoming.getByText('資料.pdf',{exact:true}).count(),1);
      assert.equal(await incoming.locator('.mail-address').innerText(),'差出人 fixture@example.invalid\n宛先 desk@example.invalid');
      assert.equal(await incoming.locator('.mail-heading time').count(),1);
      await exercise(incoming);
      const failed = page.locator('[data-message="gmail-1"]');
      await failed.evaluate(node=>node.scrollIntoView());
      await failed.getByRole('button',{name:'本文を再取得',exact:true}).waitFor();
      await folded(failed);
      assert.match(await body(failed).textContent(),/取得に失敗/);
      assert.equal(await page.locator('[data-message]').count(),12);
      for (const card of await page.locator('[data-message]').all()) await folded(card);

      await page.locator('[data-case="'+deliveredId+'"]').click();
      await page.getByRole('button',{name:'やり取り',exact:true}).click();
      const outgoing = page.locator('[data-delivery-id="delivery-0"]');
      await outgoing.waitFor();
      assert.equal(await page.locator('[data-message="gmail-0"]').count(),0);
      assert.equal(await page.locator('[data-message="merged"]').count(),1);
      assert.equal(await page.locator('[data-delivery-id]').count(),12);
      assert.equal(await outgoing.locator('.mail-address').innerText(),'差出人 ARA-TECH\n宛先 fixture@example.invalid');
      assert.match(await outgoing.locator('.mail-heading').innerText(),/送信済み/);
      assert.equal(await outgoing.getByRole('button',{name:'HTML本文を表示'}).count(),1);
      await exercise(outgoing);
      await exercise(page.locator('[data-message="merged"]'));
      for (const card of await page.locator('[data-delivery-id]').all()) await folded(card);
      const empty = page.locator('[data-delivery-id="delivery-11"]');
      assert.equal(await body(empty).textContent(),'取得成功 / 空本文');
      assert.equal(await toggle(empty).isHidden(),true);
      const unknown = page.locator('[data-delivery-id="delivery-10"]');
      assert.match(await unknown.locator('.mail-heading').innerText(),/配送結果未確定/);
      assert.equal(await unknown.getByRole('button',{name:/再送|HTML本文/}).count(),0);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await outgoing.getByRole('button',{name:'全文を表示',exact:true}).click();
      await open(deliveredId);
      await outgoing.waitFor();
      await folded(outgoing);
      await page.close();
      console.log('PASS '+width+'px: 12 Gmail and 12 delivery cards, original three-line preview, full and close, loading/error/empty, dedup, case switch/reload, reply/attachment/HTML and UNKNOWN');
    }
    assert.deepEqual(writes,[]);
    assert.deepEqual(errors,[]);
  } finally {
    releaseBody?.();
    await browser?.close();
    await new Promise(resolve=>server.close(resolve));
  }
}

main().catch(error=>{console.error(error);process.exitCode=1;});

const assert = require('node:assert/strict');
const mail = require('../api/_pa-mail.cjs');
const security = require('../api/_request-security.cjs');
const id = '11111111-1111-4111-8111-111111111111';
const recipient = 'customer@example.invalid';
const body = '一行目\n二行目\n\n<script>&「見積」</script>';
const subject = 'お問い合わせについて';
let userChecks = 0;
let caseReads = 0;
mail.verifyAdmin = async token => {
  userChecks++;
  if (token !== 'fixture') throw Error('not_authorized');
  return {id};
};
mail.getInquiry = async inquiryId => {
  caseReads++;
  assert.equal(inquiryId,id);
  return {id,email:recipient,submission_source:'public_form'};
};
security.checkRateLimit = async () => assert.fail('Preview must not update a rate-limit bucket');
mail.sendContentHearingAndFinalize = async () => assert.fail('Preview must not send or write');
global.fetch = async () => assert.fail('Preview must not reach Gmail or the database outside the case read');
const handler = require('../api/pa-mail.js');

async function request(overrides = {}, token = 'fixture') {
  const response = {
    setHeader(){},
    status(code){this.code=code;return this;},
    json(data){return {code:this.code,data};}
  };
  return handler({
    method:'POST',headers:{host:'ara-tech.cc',origin:'https://ara-tech.cc',authorization:'Bearer '+token},
    body:{action:'preview_content_hearing',inquiry_id:id,expected_recipient:recipient,subject,body,...overrides}
  },response);
}

(async()=>{
  const {code,data}=await request();
  assert.equal(code,200);
  const raw=mail.buildRawMessage({
    to:recipient,subject,body:mail.normalizeCustomerBody(body),messageType:mail.CONTENT_HEARING_TYPE,
    config:{signature:'ARA-TECH',senderName:'ARA-TECH'}
  });
  const mime=Buffer.from(raw,'base64url').toString();
  const htmlPart=mime.match(/Content-Type: text\/html[^\r\n]*\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]+?)\r\n--/i);
  assert.ok(htmlPart,'outbound MIME contains HTML');
  assert.equal(data.html,Buffer.from(htmlPart[1],'base64').toString());
  for(const fragment of ['background:#007bff','background:#ffffff','logo-horizontal-white.png',
    'logo-horizontal-black.png','aratechsound@gmail.com','https://ara-tech.cc','公式LINE',
    'ara-tech-line-official-qr.png','一行目<br>二行目</p><p','&lt;script&gt;&amp;「見積」&lt;/script&gt;']){
    assert.ok(data.html.includes(fragment),fragment);
  }
  assert.equal((await request({expected_recipient:'other@example.invalid'})).code,400);
  assert.equal((await request({},'invalid')).code,401);
  assert.equal(userChecks,3);
  assert.equal(caseReads,2);
  console.log('PAUI-093 HTML preview equals outbound MIME; authenticated read only');
})().catch(error=>{console.error(error);process.exitCode=1;});

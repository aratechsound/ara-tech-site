const assert = require('node:assert/strict');
const { createFixture } = require('./helpers/pa-contract-fixture.cjs');
const gmail = require('../api/_pa-gmail.cjs');

(async () => {
  const fixture = await createFixture();
  try {
    const preview = await gmail.replyPreview({
      inquiryId: fixture.inquiryId, actorId: fixture.actorId, body: 'CC binding fixture',
      ccAddresses: ['venue@example.invalid']
    }, fixture.fetchImpl);
    assert.deepEqual(preview.cc_addresses, ['venue@example.invalid']);
    await gmail.sendReply({
      inquiryId: fixture.inquiryId, actorId: fixture.actorId, body: 'CC binding fixture',
      ccAddresses: ['venue@example.invalid'], confirmationToken: preview.confirmation_token
    }, fixture.fetchImpl);
    const raw = Buffer.from(fixture.state.lastRaw.raw, 'base64url').toString('utf8');
    assert.match(raw, /^Cc: venue@example\.invalid$/mu);
    await assert.rejects(gmail.replyPreview({
      inquiryId: fixture.inquiryId, actorId: fixture.actorId, body: 'must reject',
      ccAddresses: ['outsider@example.invalid']
    }, fixture.fetchImpl), /invalid_reply_cc/);
    await assert.rejects(gmail.sendReply({
      inquiryId: fixture.inquiryId, actorId: fixture.actorId, body: 'CC binding fixture',
      ccAddresses: [], confirmationToken: preview.confirmation_token
    }, fixture.fetchImpl), /invalid_confirmation/);
    console.log('PASS PA-EST-004R1 CC: thread participant allow-list, MIME Cc, preview/send binding, outsider rejection');
  } finally { await fixture.db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

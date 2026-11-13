const assert = require('node:assert/strict');

async function verify() {
  const {conversationTimeline, customerInbound, deliveryOutcome, timelineDate} =
    await import('../pa-ui/js/conversation-timeline.mjs');
  const inquiry = {id: 'case', submission_source: 'public_form', received_at: '2026-11-13T01:58:49Z'};
  const delivery = {
    id: 'attempt1', inquiry_id: 'case', message_type: 'customer_receipt',
    gmail_message_id: 'receipt', status: 'sent', sent_at: '2026-11-13T01:58:51Z'
  };
  const internal = {...delivery, id: 'attempt2', message_type: 'internal_new_inquiry', gmail_message_id: 'internal'};
  const receipt = {inquiry_id: 'case', direction: 'outbound', gmail_message_id: 'receipt', sent_at: delivery.sent_at};
  const inbound = {...receipt, direction: 'inbound', gmail_message_id: 'reply', received_at: '2026-11-13T03:00:00Z'};
  const initial = conversationTimeline(inquiry, [], [delivery, internal]);
  assert.deepEqual(initial.map(x => x.key), ['mail:internal', 'mail:receipt', 'form']);
  assert.equal(initial.filter(customerInbound).length, 0);
  const merged = conversationTimeline(inquiry, [inbound, receipt, receipt, {...inbound, gmail_message_id:'internal'}],
    [delivery, internal, {...delivery, id:'attempt3'}, {...delivery, inquiry_id:'foreign'}]);
  assert.deepEqual(merged.map(x => x.key), ['mail:reply', 'mail:internal', 'mail:receipt', 'form']);
  assert.equal(merged[2].deliveries.length, 2);
  assert.deepEqual(merged.filter(customerInbound).map(x => x.message.gmail_message_id), ['reply']);
  assert.equal(deliveryOutcome({status:'failed'}), '送信失敗');
  assert.equal(deliveryOutcome({status:'failed', error_summary:'mail_outcome_unknown'}), '配送結果未確定');
  assert.equal(deliveryOutcome({status:'sending'}), '配送結果未確定');
  assert.match(timelineDate(inquiry.received_at), /10:58:49 JST$/);
  const large = Array.from({length:1200}, (_, i) => ({...receipt, gmail_message_id:'mail'+i}));
  const first = conversationTimeline(inquiry, large, []);
  const second = conversationTimeline(inquiry, large.reverse(), []);
  assert.deepEqual(first.map(x => x.key), second.map(x => x.key));
  assert.equal(first.length, 1201);
  console.log('PAUI092 timeline PASS: form, receipts, internal notification, dedup, attribution, outcomes, JST and stable ordering');
}
verify().catch(error => { console.error(error); process.exitCode = 1; });

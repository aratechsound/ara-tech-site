const mailId = /^[A-Za-z0-9_-]{1,256}$/;

export function deliveryOutcome(delivery) {
  const {status, error_summary: error = ''} = delivery;
  if (/unknown|uncertain|timeout|gmail_send_invalid|supabase_/i.test(error || '')) return '配送結果未確定';
  if (status === 'sent') return '送信済み';
  if (status === 'failed') return '送信失敗';
  return '配送結果未確定';
}

export function deliveryLabel(delivery) {
  if (delivery.message_type === 'customer_receipt') return '受付確認メール';
  if (delivery.message_type === 'internal_new_inquiry' || /_internal$/.test(delivery.message_type || '')) return '内部通知';
  return '業務案内・配送';
}

export function timelineDate(value) {
  if (!Number.isFinite(Date.parse(value))) return '日時未取得';
  return new Date(value).toLocaleString('ja-JP', {timeZone: 'Asia/Tokyo'}) + ' JST';
}

export function conversationTimeline(inquiry, messages, deliveries) {
  const rows = new Map();
  for (const message of messages) {
    if (message.inquiry_id !== inquiry.id || !mailId.test(message.gmail_message_id || '')) continue;
    const key = 'mail:' + message.gmail_message_id;
    if (!rows.has(key)) rows.set(key, {
      key, kind: 'mail', message, deliveries: [], at: message.received_at || message.sent_at
    });
  }
  for (const delivery of deliveries) {
    if (delivery.inquiry_id !== inquiry.id || !delivery.id) continue;
    const key = mailId.test(delivery.gmail_message_id || '')
      ? 'mail:' + delivery.gmail_message_id : 'delivery:' + delivery.id;
    if (!rows.has(key)) rows.set(key, {key, kind: 'delivery', deliveries: []});
    const entry = rows.get(key);
    if (!entry.deliveries.some(attempt => attempt.id === delivery.id)) entry.deliveries.push(delivery);
  }
  for (const entry of rows.values()) {
    entry.deliveries.sort((a, b) => deliveryTime(b) - deliveryTime(a) || a.id.localeCompare(b.id));
    if (!entry.at || entry.message?.direction === 'inbound' && entry.deliveries.length) {
      entry.at = deliveryDate(entry.deliveries[0]) || entry.at;
    }
  }
  if (inquiry.submission_source === 'public_form') {
    rows.set('form', {key: 'form', kind: 'form', at: inquiry.received_at || inquiry.created_at});
  }
  return [...rows.values()].sort((a, b) => epoch(b.at) - epoch(a.at) || a.key.localeCompare(b.key));
}

function epoch(value) {
  return Date.parse(value) || 0;
}

export function deliveryDate(delivery) {
  return delivery?.sent_at || delivery?.failed_at || delivery?.requested_at;
}

function deliveryTime(delivery) {
  return epoch(deliveryDate(delivery));
}

export function customerInbound(entry) {
  return entry?.message?.direction === 'inbound' && entry.deliveries.length === 0;
}

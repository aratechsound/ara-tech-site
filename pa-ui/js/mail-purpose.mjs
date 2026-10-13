// Deterministic, verbatim excerpts. Never infer intent or generate a summary.
const greeting=/^(?:(?:いつも)?(?:大変)?お世話になっております|お世話になります|こんにちは|こんばんは|おはようございます|初めまして|はじめまして|Hello|Hi|Good morning|Good afternoon|Good evening)[。.!！、,\s]*$/iu;
const thanks=/^(?:(?:ご連絡|ご返信|ご回答|お問い合わせ|お問合せ)(?:いただき|をいただき)?(?:まして)?(?:、)?(?:誠に)?ありがとうございます|Thank you for (?:your (?:email|message|reply|response)|getting back to me)|Thanks for (?:your (?:email|message|reply)|getting back to me))[。.!！\s]*$/iu;
const introduction=/^(?:(?:ARA-TECH|株式会社[\p{L}・ー＆& .-]{1,35}|[\p{L}・ー＆& .-]{1,35}(?:株式会社|実行委員会))の[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}・ー .]{1,20}(?:です|と申します)|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}・ー .]{1,20}と申します|My name is [\p{L} .'-]{1,45})[。.!！\s]*$/iu;
const organization=/^(?:株式会社[\p{L}・ー＆& .-]{1,35}|[\p{L}・ー＆& .-]{1,35}株式会社)$/u;
const name=/^[\p{L}・ー .]{1,20}(?:です|と申します)[。\s]*$/u;
const salutation=/^(?:Dear [\p{L} .'-]{1,45}[,:]|[\p{L}・ー .]{1,30}(?:様|御中))$/iu;
const signature=/^(?:--|Sent from my (?:iPhone|iPad|Android)|iPhoneから送信|Androidから送信|Best regards,?|Kind regards,?|Sincerely,?)\s*$/iu;
const quote=/^(?:>|On .{0,250}wrote:|[-_]{3,}\s*(?:Original Message|Forwarded|元のメッセージ)|Begin forwarded message:|転送されたメッセージ|\d{4}[年/.-].{0,160}(?:書きました|wrote):?\s*$|(?:差出人|From):\s*.+)/iu;

export function purposeExcerpt(text) {
  const lines=String(text||'').replace(/\r\n?/g,'\n').split('\n'),body=[];
  for(const raw of lines){
    const s=raw.trim();
    if(quote.test(s))break;
    if(body.length&&signature.test(s))break;
    if(s)body.push(raw);
  }
  let start=0;
  while(start<body.length){
    const s=body[start].trim();
    if(greeting.test(s)||thanks.test(s)||introduction.test(s)||salutation.test(s)){start++;continue;}
    // Only recognize a two-line introduction when both lines are unambiguous.
    if(organization.test(s)&&name.test(body[start+1]?.trim()||'')){start+=2;continue;}
    break;
  }
  // A boilerplate-only mail still shows its original text, never a fabricated empty body.
  return body.slice(start<body.length?start:0,(start<body.length?start:0)+3).join('\n');
}

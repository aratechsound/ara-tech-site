// Deterministic, verbatim excerpts. Never infer intent or generate a summary.
const greeting=/^(?:(?:いつも)?(?:大変)?お世話になっております|お世話になります|こんにちは|こんばんは|おはようございます|初めまして|はじめまして|Hello|Hi|Good morning|Good afternoon|Good evening)[。.!！、,\s]*$/iu;
const thanks=/^(?:(?:ご連絡|ご返信|ご回答|お問い合わせ|お問合せ)(?:いただき|をいただき)?(?:まして)?(?:、)?(?:誠に)?ありがとうございます|Thank you for (?:your (?:email|message|reply|response)|getting back to me)|Thanks for (?:your (?:email|message|reply)|getting back to me))[。.!！\s]*$/iu;
const introduction=/^(?:(?:ARA-TECH|株式会社[\p{L}・ー＆& .-]{1,35}|[\p{L}・ー＆& .-]{1,35}(?:株式会社|実行委員会))の[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}・ー .]{1,20}(?:です|と申します)|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}・ー .]{1,20}と申します|My name is [\p{L} .'-]{1,45})[。.!！\s]*$/iu;
const brand=/^ARA-TECH$/iu;
const organization=/^(?:株式会社[\p{L}・ー＆& .-]{1,35}|[\p{L}・ー＆& .-]{1,35}株式会社)$/u;
const name=/^[\p{L}・ー .]{1,20}(?:です|と申します)[。\s]*$/u;
const salutation=/^(?:Dear [\p{L} .'-]{1,45}[,:]|[\p{L}・ー .]{1,30}(?:様|御中))$/iu;
const signature=/^(?:--|Sent from my (?:iPhone|iPad|Android)|iPhoneから送信|Androidから送信|Best regards,?|Kind regards,?|Sincerely,?)\s*$/iu;
const quote=/^(?:>|On .{0,250}wrote:|[-_]{3,}\s*(?:Original Message|Forwarded|元のメッセージ)|Begin forwarded message:|転送されたメッセージ|\d{4}[年/.-].{0,160}(?:書きました|wrote):?\s*$|(?:差出人|From):\s*.+)/iu;
const header=/^(?:From|To|Cc|Date|Sent|Subject|差出人|送信者|宛先|送信日時|件名)\s*[:：]\s*\S/iu;
const inquiryThanks=/^(?:このたび|この度)は[、,]?.{0,120}お問い合わせ(?:を)?(?:いただき|頂き)[、,]?(?:誠に)?ありがとうござ(?:います|いました)[。！!]?$/u;
const delayedReply=/^(?:また[、,]?)?ご?(?:連絡|返信|返事|回答)が遅くな(?:り(?:まして)?|って)[、,]?(?:大変|誠に)?申し訳(?:ございません|ありません)(?:でした)?[。！!]?$/u;
const delayExplanation=/^(?:今年|先月|今月|この時期)は[^。]{0,110}(?:案件が集中|現場対応)[^。]{0,85}(?:ため|ので)[、,]ご(?:連絡|返信|回答)までお時間をいただいてしまいました。?$/u;
const businessPreamble=/^(?:改めまして[、,]?)?(?:イベント|お問い合わせ|ご相談|ご依頼)の内容についてご(?:案内|説明)させていただきます。?$/u;
const greetingLine=value=>[greeting,thanks,introduction,salutation,inquiryThanks,delayedReply,delayExplanation,businessPreamble].some(pattern=>pattern.test(value));

export function purposeExcerpt(text) {
  const lines=String(text||'').replace(/\r\n?/g,'\n').split('\n'),body=[];
  let first=lines.findIndex(line=>line.trim());
  if(first<0)return '';
  let headerEnd=first;
  while(header.test(lines[headerEnd]?.trim()||''))headerEnd++;
  if(headerEnd-first>1)first=headerEnd;
  for(let index=first;index<lines.length;index++){
    const raw=lines[index];
    const s=raw.trim();
    if(s.startsWith('>'))continue;
    if(quote.test(s))break;
    if(signature.test(s))break;
    if(brand.test(s)){
      const following=lines.slice(index+1,index+8).map(line=>line.trim()).filter(Boolean);
      if(!salutation.test(following[0]||'')&&following.some(line=>/^(?:Email|Web)\s*[:：]/iu.test(line)))break;
    }
    if(s)body.push(raw);
  }
  let start=0;
  while(start<body.length){
    const s=body[start].trim();
    if(greetingLine(s)){start++;continue;}
    const inline=s.match(/^(.+?[。.!！、])\s*(\S.*)$/u);
    if(inline&&greeting.test(inline[1])){body[start]=inline[2];continue;}
    const next=body[start+1]?.trim()||'';
    // An organization on its own might be the topic. Require a recipient or name line.
    if(((brand.test(s)||organization.test(s))&&salutation.test(next))||
       (organization.test(s)&&name.test(next))){start+=2;continue;}
    break;
  }
  // A boilerplate-only mail still shows its original text, never a fabricated empty body.
  return body.slice(start<body.length?start:0,(start<body.length?start:0)+3).join('\n');
}

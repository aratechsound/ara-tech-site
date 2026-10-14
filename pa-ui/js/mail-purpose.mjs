// Deterministic, verbatim excerpts. Never infer intent or generate a summary.
const greeting=/^(?:(?:いつも)?(?:大変)?お世話になっております|お世話になります|こんにちは|こんばんは|おはようございます|初めまして|はじめまして|Hello|Hi|Good morning|Good afternoon|Good evening)[。.!！、,\s]*$/iu;
const thanks=/^(?:(?:ご連絡|ご返信|ご回答|ご確認|お問い合わせ|お問合せ)(?:いただき|をいただき)?(?:まして)?(?:、)?(?:誠に)?ありがとうございます|Thank you for (?:your (?:email|message|reply|response)|getting back to me)|Thanks for (?:your (?:email|message|reply)|getting back to me))[。.!！\s]*$/iu;
const introduction=/^(?:(?:ARA-TECH|株式会社[\p{L}・ー＆& .-]{1,35}|[\p{L}・ー＆& .-]{1,35}(?:株式会社|実行委員会))の[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}・ー .]{1,20}(?:です|と申します)|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}・ー .]{1,20}と申します|My name is [\p{L} .'-]{1,45})[。.!！\s]*$/iu;
const organization=/^(?:株式会社[\p{L}・ー＆& .-]{1,35}|[\p{L}・ー＆& .-]{1,35}株式会社)$/u;
const name=/^[\p{L}・ー .]{1,20}(?:です|と申します)[。\s]*$/u;
const salutation=/^(?:Dear [\p{L} .'-]{1,45}[,:]|[\p{L}・ー .\s]{1,30}(?:様|御中))$/iu;
const phoneticIntroduction=/^ARA-TECHの[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}・ー\s]{1,20}[（(][\p{Script=Katakana}ー\s]{1,20}[）)](?:です|と申します)[。.!！\s]*$/u;
const recipientOrganization=/^(?:ARA-TECH|[\p{L}・ー\s]{1,40}(?:産業観光課|実行委員会))$/u;
const signature=/^(?:--|Sent from my (?:iPhone|iPad|Android)|iPhoneから送信|Androidから送信|Best regards,?|Kind regards,?|Sincerely,?)\s*$/iu;
const quote=/^(?:>|On .{0,250}wrote:|[-_]{3,}\s*(?:Original Message|Forwarded|元のメッセージ)|Begin forwarded message:|転送されたメッセージ|\d{4}[年/.-].{0,160}(?:書きました|wrote):?\s*$|(?:差出人|From):\s*.+)/iu;

// These predicates remove only entire, unambiguous boilerplate lines. Match a
// normalized copy, but retain original spelling, numbers and punctuation.
const extraGreeting=/^(?:(?:いつも|平素より|平素は|日頃より|日ごろより|毎度|大変|誠に)\s*)*(?:お世話になっております|お世話になります|お世話になってます|お世話になっておりまして|ありがとうございます|先日はありがとうございました|お忙しいところ失礼いたします|よろしくお願いいたします|よろしくお願い致します)[。.!！、,\s]*$/u;
const extraIntroduction=/^(?:ARA[-‐‑–—ー\s]?TECH(?:の|\s)+[\p{L}・ー\s]{1,35}(?:です|でございます|と申します)|(?:株式会社|有限会社)[\p{L}・ー＆& .-]{1,65}の(?:[\p{L}・ー\s]{1,30})(?:です|でございます|と申します))[。.!！\s]*$/iu;
const extraSalutation=/^[\p{L}・ー＆& .()（）-]{1,150}(?:様|御中|各位)[。\s]*$/u;
const bullet=/^\s*(?:[・●○▪■□*-]|\d+[.)）]|[①-⑳])\s*/u;
const dependent=/^\s*(?:ただし|但し|ただ、|しかし|なお[、,]|そのため|その場合|この場合|上記|いずれも|まだ|未確定|確定では|取消では|変更では|希望であり|あくまで)/u;
function boilerplate(line){const s=line.trim().normalize('NFKC');return s.length<=180&&(greeting.test(s)||thanks.test(s)||introduction.test(s)||salutation.test(s)||extraGreeting.test(s)||extraIntroduction.test(s)||extraSalutation.test(s));}
function score(text){
  let value=0;
  if(/お願い|ください|いただけ|ご確認|確認|教えて|依頼|でしょうか|ですか|ますか|可能|[?？]|希望|変更|追加|取消|キャンセル|中止|不要|取りやめ|未定|未確定|期限|までに|見積|請求|受注|回答|送付|添付/u.test(text))value+=4;
  if(/\d[\d,.\/:年年月日時分\s-]*(?:円|万円|台|本|個|枚|名|人|日|時|分|月)|[￥¥]\s*\d/u.test(text))value+=3;
  if(/できません|ではありません|しません|未確定|未確認|取消|中止|希望/u.test(text))value+=3;
  if(/搬入|搬出|車種|台数|マイク|電源|会場|数量|金額|日時|納期/u.test(text))value++;
  return value;
}
function signatureStart(lines,index,hasBody){
  if(!hasBody)return false;const s=lines[index].trim();if(signature.test(s))return true;
  // A divider alone is ambiguous (it can precede important conditions).
  if(!/^(?:[-_=＊*━─]{4,}|ARA[-‐‑–—ー\s]?TECH)$/iu.test(s))return false;
  const following=lines.slice(index+1,index+5).join('\n');
  return /(?:^|\n)\s*(?:TEL|FAX|E-?mail|電話|メール|住所|〒)\s*[:：\d]/iu.test(following);
}
function units(lines){
  const result=[];let pending=[];
  function flush(){if(pending.length){result.push(pending.join('\n'));pending=[];}}
  for(const raw of lines){
    if(!raw.trim()){flush();continue;}
    if(bullet.test(raw)||pending.length&&/[。！？!?．.]\s*$/u.test(pending.at(-1)))flush();
    const sentences=raw.match(/[^。！？!?]+(?:[。！？!?]+|$)/gu)||[raw];
    for(let i=0;i<sentences.length;i++){pending.push(sentences[i]);if(i<sentences.length-1)flush();}
  }
  flush();const grouped=[];
  for(const text of result){if(grouped.length&&dependent.test(text))grouped[grouped.length-1]+='\n'+text;else grouped.push(text);}
  return grouped;
}

export function purposeExcerpt(text) {
  const lines=String(text||'').replace(/\r\n?/g,'\n').split('\n'),body=[];
  for(let index=0;index<lines.length;index++){
    const raw=lines[index];
    const s=raw.trim();
    if(quote.test(s))break;
    if(signatureStart(lines,index,body.some(line=>line.trim())))break;
    body.push(raw);
  }
  let start=0;
  while(start<body.length){
    const s=body[start].trim();
    if(!s||boilerplate(s)||phoneticIntroduction.test(s)){start++;continue;}
    if(recipientOrganization.test(s)&&salutation.test(body[start+1]?.trim()||'')){start+=2;continue;}
    // Remove two complete boilerplate sentences only; preserve the remaining original substring.
    const combined=/^(お世話になります。|お世話になっております。)\s*(ARA-TECHの[^。]{1,60}。)\s*/u.exec(s);
    if(combined&&(introduction.test(combined[2])||phoneticIntroduction.test(combined[2]))){
      const rest=s.slice(combined[0].length);if(rest){body[start]=rest;break;}start++;continue;
    }
    // A folded salutation must end in an explicit addressee marker. Do not
    // infer that an arbitrary committee/name pair is an introduction.
    const addressEnd=body.slice(start,start+4).findIndex(line=>extraSalutation.test(line.trim()));
    if(addressEnd>0&&body.slice(start,start+addressEnd).every(line=>line.trim().length<=100&&/^[\p{L}・ー＆& .()（）-]+$/u.test(line.trim()))){start+=addressEnd+1;continue;}
    // Only recognize a two-line introduction when both lines are unambiguous.
    if(organization.test(s)&&name.test(body[start+1]?.trim()||'')){start+=2;continue;}
    break;
  }
  // Preserve already-good short excerpts and uncertain/boilerplate-only mail.
  const useful=body.slice(start<body.length?start:0),nonempty=useful.filter(line=>line.trim());
  if(nonempty.length<=3)return nonempty.join('\n');
  // Preserve the accepted three-line prefix when there are no additional
  // specific matters later. This also retains its original wrapping/indent.
  if(nonempty.slice(0,3).some(line=>score(line)>0)&&!nonempty.slice(3).some(line=>score(line)>0))return nonempty.slice(0,3).join('\n');
  const candidates=units(useful),ranked=candidates.map((text,index)=>({text,index,score:score(text)}));
  if(!ranked.some(item=>item.score>0))return nonempty.slice(0,3).join('\n');
  // Select complete units, then restore original order. Folding whitespace is
  // the only text transformation; no paraphrase, fact inference or mid-unit cut.
  return ranked.filter(item=>item.score>0).sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,3).sort((a,b)=>a.index-b.index)
    .map(item=>item.text.replace(/\n[ \t]*/gu,' ').trimEnd()).join('\n');
}

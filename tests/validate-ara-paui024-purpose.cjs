'use strict';
const assert=require('node:assert/strict');
(async()=>{
 const {purposeExcerpt}=await import('../pa-ui/js/mail-purpose.mjs');
 const cases=[
  ['Full width salutation and phonetic introduction','架空　担当 様\nお世話になっております。\nARA-TECHの架空（カクウ）です。\n数量を3本へ変更します。','数量を3本へ変更します。'],
  ['Two line ARA salutation','ARA-TECH\n架空　様\nお世話になっております。\n用件は添付の通りです。','用件は添付の通りです。'],
  ['Combined greeting and introduction','お世話になります。ARA-TECHの架空です。\nご確認いただきありがとうございます。\n台数は2台です。','台数は2台です。'],
  ['Combined with original purpose retained','お世話になります。ARA-TECHの架空です。台数は2台です。','台数は2台です。'],
  ['Uncertain recipient line retained','会場の配置を変更\n架空 様\n2台です。','会場の配置を変更\n架空 様\n2台です。'],
  ['Uncertain phonetic introduction contains condition','ARA-TECHの架空（カクウ）です。中止です。','ARA-TECHの架空（カクウ）です。中止です。'],
  ['Japanese greeting, self introduction, thanks','お世話になっております。\nARA-TECHの荒殿です。\nご連絡ありがとうございます。\n今回は11万円のご予算に合わせ、\n音響のみの構成をご提案しました。','今回は11万円のご予算に合わせ、\n音響のみの構成をご提案しました。'],
  ['No greeting and exact conditions','11万円、11月1日、2台でお願いします。\n雨天の場合は中止です。','11万円、11月1日、2台でお願いします。\n雨天の場合は中止です。'],
  ['Two-line introduction','いつもお世話になっております。\n株式会社テスト\n田中です。\n会場を変更してください。','会場を変更してください。'],
  ['Thanks then purpose','ご返信いただきありがとうございます。\n予算は110,000円（税込）です。','予算は110,000円（税込）です。'],
  ['Purpose at first line never skipped','今回は11万円です。\nお世話になっております。\n条件は添付の通りです。','今回は11万円です。\nお世話になっております。\n条件は添付の通りです。'],
  ['Quote and signature','本文です。\n2台です。\n--\n担当\n> 旧本文','本文です。\n2台です。'],
  ['English greetings and thanks','Dear Alex,\nHello!\nMy name is Alex.\nThank you for your email.\nPlease supply 2 speakers on November 1 for JPY 110,000.\nBest regards,\nAlex','Please supply 2 speakers on November 1 for JPY 110,000.'],
  ['English quoted history','Hi,\nPlease confirm 2 units.\nOn Tue Alex wrote:\nOld request','Please confirm 2 units.'],
  ['Short mail','承知しました。','承知しました。'],
  ['Empty mail','',''],
  ['Quote only','> 古い本文',''],
  ['Uncertain thank you contains condition','ご連絡ありがとうございます。ただし11万円では対応できません。\n12万円が必要です。','ご連絡ありがとうございます。ただし11万円では対応できません。\n12万円が必要です。'],
  ['Uncertain self introduction','田中です。11月1日は中止です。','田中です。11月1日は中止です。'],
  ['All boilerplate fallback','お世話になっております。\nご連絡ありがとうございます。','お世話になっております。\nご連絡ありがとうございます。'],
  ['Unmarked signature ambiguity kept','本文です。\n担当者名\n会社住所','本文です。\n担当者名\n会社住所'],
  ['Original indentation and numeric punctuation','お世話になります。\n  予算：￥110,000（税別）\n  2026/11/01 09:00、数量2、条件付き','  予算：￥110,000（税別）\n  2026/11/01 09:00、数量2、条件付き'],
  ['Three original lines','一行目\n二行目\n三行目\n四行目','一行目\n二行目\n三行目'],
  ['No truncation inside money','x'.repeat(700)+'110,000円','x'.repeat(700)+'110,000円'],
  ['Uncertain organization preserved','テスト実行委員会\n田中です。\n11万円です。','テスト実行委員会\n田中です。\n11万円です。'],
  ['Greeting with valuable content stays','Hello, please cancel November 1.','Hello, please cancel November 1.'],
  ['Purpose must not look like self introduction','音響のみの構成です。\n自動取得した架空の本文です。','音響のみの構成です。\n自動取得した架空の本文です。'],
  ['English purpose is not a name','This is a cancellation.','This is a cancellation.'],
  ['Ambiguous divider does not erase conditions','用件です。\n----\n予算は11万円までです。','用件です。\n----\n予算は11万円までです。']
 ];
 for(const [label,source,expected] of cases){assert.equal(purposeExcerpt(source),expected,label);for(const line of expected.split('\n'))assert(source.includes(line),label+' verbatim');}
 console.log('PASS purpose excerpts: '+cases.length+' cases, verbatim amounts/dates/conditions, uncertainty fallback, no AI');
})().catch(e=>{console.error(e);process.exitCode=1;});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {visibleAttachments,carouselPosition,carouselMove} from '../../pa-ui/js/carousel-model.mjs';
import {mailAttachments} from '../../pa-ui/js/mail-model.mjs';
const tests=[];const check=(name,fn)=>{fn();tests.push({name,status:'PASS'});};
for(const n of [0,1,2,4,5,10])check('Visible capacity '+n,()=>assert.equal(visibleAttachments(n),Math.min(4,n)));
check('Rightmost initial offset enables left only',()=>assert.deepEqual(carouselPosition({scrollLeft:0,clientWidth:389,scrollWidth:983}),{maximum:594,offset:0,canLeft:true,canRight:false}));
check('Left arrow advances to later files using negative RTL scroll',()=>assert.equal(carouselMove({scrollLeft:0,clientWidth:389,scrollWidth:983},'left',396),-396));
check('Right arrow returns to first attachment',()=>assert.equal(carouselMove({scrollLeft:-396,clientWidth:389,scrollWidth:983},'right',396),0));
check('Left edge clamps at final file',()=>assert.equal(carouselMove({scrollLeft:-396,clientWidth:389,scrollWidth:983},'left',396),-594));
check('Four attachments have no movement',()=>assert.deepEqual(carouselPosition({scrollLeft:0,clientWidth:389,scrollWidth:389}),{maximum:0,offset:0,canLeft:false,canRight:false}));
check('Fractional geometry keeps boundary arrows stable',()=>assert.equal(carouselPosition({scrollLeft:-593.75,clientWidth:389,scrollWidth:983}).canLeft,false));
check('Ten same-kind attachments remain separate and in original order',()=>{
 const row={gmail_message_id:'mail10',attachment_metadata:Array.from({length:10},(_,i)=>({id:'ref'+i,filename:'ステージプロット_バンド'+i+'.pdf',mime_type:'application/pdf'}))};const before=JSON.stringify(row),items=mailAttachments(row);
 assert.equal(items.length,10);assert.deepEqual(items.map(x=>x.asset_id),row.attachment_metadata.map(x=>x.id));assert.equal(JSON.stringify(row),before);assert(items.every(x=>x.message_id==='mail10'));
});
check('No grouping files or grouping dependency in R2 mail rendering',()=>{
 const js=new URL('../../pa-ui/js/',import.meta.url);assert(!fs.existsSync(new URL('attachment-groups.mjs',js)));assert(!fs.existsSync(new URL('attachment-group-model.mjs',js)));
 const desk=fs.readFileSync(new URL('desk.mjs',js),'utf8'),carousel=fs.readFileSync(new URL('mail-carousel.mjs',js),'utf8');assert(!/groupAttachments|createAttachmentGroups|attachment-groups/.test(desk+carousel));assert(carousel.includes('gallery.mount(track,items'));
});
check('Vertical wheel events are not intercepted',()=>{const code=fs.readFileSync(new URL('../../pa-ui/js/mail-carousel.mjs',import.meta.url),'utf8');assert(!/addEventListener\(['"]wheel/.test(code));});
fs.writeFileSync(new URL('./CAROUSEL_TESTS.local.json',import.meta.url),JSON.stringify({task_id:'PAUI-014-R2',mode:'LOCAL_UNIT_ONLY',total:tests.length,tests},null,2));console.log(JSON.stringify({passed:tests.length,total:tests.length}));

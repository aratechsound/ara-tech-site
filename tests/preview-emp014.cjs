// Loopback fixture for official CUA visual review. No production credentials or connections.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {PDFDocument,StandardFonts}=require('pdf-lib');
const root=path.resolve(__dirname,'..'),pdfRoot='C:/Users/user/Documents/Codex/2026-10-06/task-13/outputs';
const caseId='20000000-0000-4000-8000-000000000001',time='2026-10-06T01:00:00Z';
const event={event_name:'EMP-014 Local Fixture Festival',event_date:'2026-10-18',event_time:'10:00–15:00',venue:'Local QA Hall',venue_address:'Synthetic venue address'};
const categories=['timetable','script','layout','other','performer'],cards=categories.map((category,n)=>({id:'card-'+n,ref:'card-'+n,category,title:category,card_kind:n<2?'fixed':'collection',owner_kind:'shared',can_edit:true,current_version_id:'v-'+n,versions:[{id:'v-'+n,ref:'v-'+n,display_filename:(n===2?'Long_filename_'.repeat(14):category)+'_LOCAL_FIXTURE.pdf',mime_type:'application/pdf',version_label:'1',created_at:time,source_created_at:time,contributor_kind:'shared'}]}));
const photos=[{id:'photo-1',ref:'photo-1',display_filename:'Venue_LOCAL_FIXTURE.png',mime_type:'image/png',owner_kind:'shared',can_edit:true,created_at:time,contributor_kind:'shared'}];
let shared={GENERAL:{active:true,exists:true,grade:'GENERAL',share_url:'/staff-portal#'+'a'.repeat(64)},TECHNICAL:{active:true,exists:true,grade:'TECHNICAL',url_redisplay:false}};
async function main(){const doc=await PDFDocument.create(),page=doc.addPage([600,340]),font=await doc.embedFont(StandardFonts.Helvetica);page.drawText('EMP-014 synthetic local fixture PDF',{x:24,y:280,font,size:22});const pdf=Buffer.from(await doc.save());
 const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://127.0.0.1');res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' blob: data:; font-src 'self'; worker-src 'self' blob:");
  const json=result=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,result}));};
  if(url.pathname.startsWith('/api/')){let raw='';for await(const c of req)raw+=c;const input=JSON.parse(raw||'{}');
   if(input.action==='download'){
    if(input.asset_kind==='photo'){res.setHeader('Content-Type','image/svg+xml');return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="450"><rect width="600" height="450" fill="#e4eef7"/><text x="40" y="220" font-family="sans-serif" font-size="24" fill="#31546d">EMP-014 LOCAL PHOTO FIXTURE</text></svg>');}
    res.setHeader('Content-Type','application/pdf');return res.end(pdf);
   }
   if(input.action==='read'){
    if(url.pathname==='/api/staff-portal'){const grade=/EMP014_QA_GRADE=TECHNICAL/.test(req.headers.cookie||'')?'TECHNICAL':'GENERAL';return json({grade,event:{name:event.event_name,date:event.event_date,time:event.event_time,venue:event.venue,timezone:'Asia/Tokyo'},documents:[...cards.filter(c=>grade==='TECHNICAL'||c.category!=='performer').map(c=>({section:c.category==='performer'?'performer':'common',category:c.category,ref:c.versions[0].ref,kind:'version',title:c.title,filename:c.versions[0].display_filename,mime_type:'application/pdf',version_label:'1',updated_at:time})),{section:'common',category:'photo',ref:'photo-1',kind:'photo',title:'Venue',filename:'Venue_LOCAL_FIXTURE.png',mime_type:'image/png',version_label:null,updated_at:time}]});}
    return json({event,cards,photos});
   }
   if(input.action.startsWith('staff_link_')){const action=input.action.slice(11),grade=input.grade;if(!shared[grade])throw Error('fixture grade');if(action==='status')return json({...shared[grade],timezone:'Asia/Tokyo'});if(action==='revoke')shared[grade]={active:false,exists:false,revoked:true,grade};if(['create','rotate'].includes(action))shared[grade]={active:true,exists:true,grade,share_url:'/staff-portal#'+(grade==='GENERAL'?'c':'d').repeat(64)};return json(shared[grade]);}
   if(input.action==='stage_plot_list')return json([]);if(input.action==='candidates')return json([]);if(input.action==='candidate_list')return json({pending_count:0,candidates:[],cards:[]});if(input.action==='exchange')return json({expires_at:'2026-10-19T14:59:00Z'});throw Error('fixture action');
  }
  if(url.pathname==='/fixture-deps.mjs'){res.setHeader('Content-Type','text/javascript');return res.end(`import * as pdfjsLib from '/pdfjs/pdf.min.mjs';globalThis.__PA_PORTAL_TEST_DEPS__={pdfjsLib,createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:'SYNTHETIC_ADMIN'}}})},from:(table)=>{const result={data:table==='pa_inquiries'?${JSON.stringify(event)}:{confirmed_event_date:'2026-10-18'},error:null};const chain={select:()=>chain,eq:()=>chain,is:()=>chain,maybeSingle:async()=>result};return chain;}})};`);}
  let file;if(url.pathname.startsWith('/pdfjs/'))file=path.join(pdfRoot,path.basename(url.pathname));else if(['/event-portal','/admin-preview'].includes(url.pathname)||url.pathname.startsWith('/pa/cases/'))file=path.join(root,'pa-case-portal.html');else if(url.pathname==='/staff-portal')file=path.join(root,'pa-staff-portal.html');else file=path.join(root,decodeURIComponent(url.pathname).replace(/^\//,''));
  if(!file.startsWith(root+path.sep)&&!file.startsWith(path.resolve(pdfRoot)+path.sep))throw Error('fixture path');if(!fs.existsSync(file)){res.statusCode=404;return res.end('not found');}
  res.setHeader('Content-Type',/\.(mjs|js)$/.test(file)?'text/javascript':/\.css$/.test(file)?'text/css':/\.html$/.test(file)?'text/html':'image/png');
  if(file.endsWith('.html')){if(url.searchParams.has('fixture'))res.setHeader('Set-Cookie','EMP014_QA_GRADE='+(url.searchParams.get('fixture')==='technical'?'TECHNICAL':'GENERAL')+'; Path=/; SameSite=Strict');let html=fs.readFileSync(file,'utf8');html=html.replace(/<link[^>]*href="https:\/\/fonts[^>]*>/g,'').replace('<script type="module" src="/js/pa-case-portal.js','<script type="module" src="/fixture-deps.mjs"></script><script type="module" src="/js/pa-case-portal.js');return res.end(html);}
  return res.end(fs.readFileSync(file));
 }catch(e){res.statusCode=500;res.end('local fixture error');console.error('fixture error:',e.message);}});
 server.listen(4175,'127.0.0.1',()=>console.log('EMP014 official CUA fixture http://127.0.0.1:4175/pa/cases/'+caseId+'/portal; organizer /event-portal; staff /staff-portal?fixture=general or technical; loopback only'));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

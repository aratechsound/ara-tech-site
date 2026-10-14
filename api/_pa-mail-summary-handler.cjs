'use strict';
const {createReadHandler}=require('./_pa-workspace-read.cjs');
const {createSummaryService}=require('./_pa-mail-summary.cjs');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAIL=/^[A-Za-z0-9_-]{1,256}$/;
function createHandler({read,service=createSummaryService()}={}) {
  // Reuse exactly the normal Owner JWT, work_admins, case/thread/message ACL
  // path. No service role, unsigned JWT decoding or browser-supplied body.
  return async(req,res)=>{
    res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
    const send=(v,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(v));};
    try{
      if(!['GET','POST'].includes(req.method))return send({ok:false,code:'method_refused'},405);
      const url=new URL(req.url,'https://ara-tech.cc');
      if(req.headers['sec-fetch-site']==='cross-site'||req.headers.origin&&req.headers.origin!=='https://'+req.headers.host)
        return send({ok:false,code:'origin_refused'},403);
      if(req.method==='POST'&&req.headers.origin!=='https://'+req.headers.host)return send({ok:false,code:'origin_required'},403);
      if([...url.searchParams.keys()].some(k=>!['case','thread','message'].includes(k))||['case','thread','message'].some(k=>url.searchParams.getAll(k).length!==1))
        return send({ok:false,code:'query_refused'},400);
      const [id,thread,message]=['case','thread','message'].map(k=>url.searchParams.get(k));
      if(!UUID.test(id)||!MAIL.test(thread)||!MAIL.test(message))return send({ok:false,code:'invalid_identity'},400);
      read ||= createReadHandler();
      let status=200,raw;
      await read({method:'GET',headers:req.headers,url:'/api/pa-workspace-read?path='+encodeURIComponent('/data/mail-summary-source/'+id+'/'+thread+'/'+message)},
        {setHeader(){},set statusCode(v){status=v;},end(v){raw=v;}});
      const data=JSON.parse(raw);
      if(status!==200||data.ok!==true)return send({ok:false,code:data.code||'read_unavailable'},status===200?503:status);
      const source=data.result;
      if(source.inquiry_id!==id||source.gmail_thread_id!==thread||source.gmail_message_id!==message)return send({ok:false,code:'mail_binding_mismatch'},403);
      // Verified Owner identity survives token refresh without duplicate billing.
      if(!UUID.test(source.owner_id))return send({ok:false,code:'owner_binding_mismatch'},403);
      const owner=source.owner_id;
      return send({ok:true,result:await service.run({owner,source,generate:req.method==='POST'})});
    }catch{return send({ok:false,code:'summary_unavailable'},503);}
  };
}
function summaryRequest(req){
  let url;try{url=new URL(req.url,'https://ara-tech.cc');}catch{return null;}
  if(url.pathname!=='/api/pa-gmail'||!url.searchParams.has('mail_summary'))return null;
  if(url.searchParams.getAll('mail_summary').length===1&&url.searchParams.get('mail_summary')==='1')url.searchParams.delete('mail_summary');
  return {method:req.method,headers:req.headers,url:url.pathname+url.search};
}
const dispatchSummary=createHandler();
module.exports={createHandler,summaryRequest,dispatchSummary};

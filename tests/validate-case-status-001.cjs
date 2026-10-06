const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..');
(async()=>{
    const m=await import(pathToFileURL(path.join(root,'js/pa-formal-order-status.mjs')));
    const inquiry={id:'existing',status:'waiting_customer_reply',case_type:'PA_EVENT'};
    const canonical={formal_contract_id:'accepted-v7',booking_confirmed_on:'2026-09-17',estimate_approved_on:'2026-09-17'};
    assert.equal(m.formalOrderDisplayStatus(inquiry,canonical),m.formalOrderStatus);
    assert.equal(m.formalOrderDisplayStatus(inquiry,{booking_confirmed_on:'2026-09-17',estimate_approved_on:'2026-09-17'}),m.formalOrderStatus);
    for(const progress of [{},{booking_confirmed_on:'2026-09-17'},{estimate_approved_on:'2026-09-17'}])
        assert.equal(m.formalOrderDisplayStatus(inquiry,progress),'waiting_customer_reply');
    for(const status of ['closed','cancelled','declined','schedule_unavailable','on_hold'])
        assert.equal(m.formalOrderDisplayStatus({...inquiry,status},canonical),status);
    for(const bad of [{...inquiry,case_type:'AV_INSTALL'},{...inquiry,deleted_at:'today'}])
        assert.equal(m.formalOrderDisplayStatus(bad,canonical),'waiting_customer_reply');
    assert.equal(m.formalOrderDisplayStatus(inquiry,{...canonical,is_on_hold:true}),'waiting_customer_reply');
    assert.equal(m.formalOrderDisplayStatus(inquiry,{...canonical,closed_at:'today'}),'waiting_customer_reply');
    const reads=[];
    const client=(bad=false,error=false)=>({from:table=>({select:columns=>({eq:(key,id)=>({single:async()=>{
        reads.push({table,columns,key,id});return {data:table==='pa_inquiries'?inquiry:bad?{}:canonical,error:error?{message:'denied'}:null};
    }})})})});
    assert.deepEqual(await m.verifyExistingFormalOrder(client(),'existing'),canonical);
    assert.equal(reads.length,2);
    assert.ok(reads.every(r=>r.id==='existing'&&!/amount|email/.test(r.columns)));
    await assert.rejects(m.verifyExistingFormalOrder(client(true),'existing'));
    await assert.rejects(m.verifyExistingFormalOrder(client(false,true),'existing'));
    const js=fs.readFileSync(path.join(root,'js/pa-admin.js'),'utf8');
    const html=fs.readFileSync(path.join(root,'pa-admin.html'),'utf8');
    assert.match(html.match(/<select id="case-status"[\s\S]*?<\/select>/)[0],/formal_order_confirmed/);
    assert.match(html.match(/<select id="case-status-filter"[\s\S]*?<\/select>/)[0],/formal_order_confirmed/);
    assert.match(js,/stateCell.append\(statusBadge\(formalOrderDisplayStatus\(item, progress\)\)\)/);
    const dispatch=js.slice(js.indexOf('const saveCase = async () => {'),js.indexOf('const randomToken ='));
    let verified=0;
    const scope=vm.createContext({$:()=>({value:m.formalOrderStatus}),formalOrderStatus:m.formalOrderStatus,confirmExistingFormalOrder:async()=>verified++});
    await vm.runInContext(dispatch+'\nsaveCase();',scope);
    assert.equal(verified,1); // Generic payload/PATCH/insert cannot be reached.
    const handler=js.slice(js.indexOf('const confirmExistingFormalOrder = async () => {'),js.indexOf('const saveCase = async () => {'));
    const exercise=async(mode)=>{
        const button={disabled:false},messages=[];let loads=0,opens=0;
        const current={...inquiry};
        const context=vm.createContext({currentCase:current,caseSelectionSerial:1,$:()=>button,caseStatusMessage:{},clearMessage:()=>{},supabase:{},
            verifyExistingFormalOrder:async()=>{if(mode==='failure')throw Error('no formal record');if(mode==='switched')context.caseSelectionSerial++;},
            loadCases:async()=>loads++,openCase:async()=>opens++,setMessage:(a,text,type)=>messages.push(type)});
        await vm.runInContext(handler+'\nconfirmExistingFormalOrder();',context);
        assert.equal(button.disabled,false);return {loads,opens,messages};
    };
    assert.deepEqual(await exercise('failure'),{loads:0,opens:0,messages:['error']});
    assert.deepEqual(await exercise('switched'),{loads:0,opens:0,messages:[]});
    assert.deepEqual(await exercise('success'),{loads:1,opens:1,messages:['success']});
    console.log('PASS CASE-STATUS-001: accepted/legacy authority projection, holds/closure, verified reads only, generic writes excluded, stale selection/error guards, list/filter/menu');
})().catch(e=>{console.error(e);process.exitCode=1;});

const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{const base='http://127.0.0.1:8875',checks=[];
for(const scenario of ['off','ok','misconfig','missing_policy','bad_gate','bad_site_key','bad_hostname','unset_gate','empty_gate']){
 await fetch(base+'/fixture-control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scenario})});
 const r=await fetch(base+'/api/pa-inquiry?general_config=1'),body=await r.json();const expected=scenario==='off'?'LEGACY':scenario==='ok'?'COMMON':'UNAVAILABLE';assert.equal(body.mode,expected);assert.equal(r.status,expected==='UNAVAILABLE'?503:200);assert.equal(/secret|fixture-only/.test(JSON.stringify(body)),false);checks.push({scenario,http_status:r.status,body,result:'PASS'});
}
await fetch(base+'/fixture-control',{method:'POST',headers:{'content-type':'application/json'},body:'{"scenario":"ok"}'});
fs.writeFileSync(path.resolve(__dirname,'../../../outputs/ARA-CASE-001R3-audit/CONFIG_API_READBACK.json'),JSON.stringify({checks,result:'PASS'},null,2));console.log('Config API 9 PASS');})().catch(e=>{console.error(e);process.exit(1)});

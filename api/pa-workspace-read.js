const {createReadHandler}=require('./_pa-workspace-read.cjs');
const {ROUTE,createDiagnosticHandler}=require('./_pa-release-diagnostic.cjs');
const read=createReadHandler(),diagnostic=createDiagnosticHandler();
module.exports=(req,res)=>{
  let route;try{route=new URL(req.url,'https://ara-tech.cc').searchParams.get('path');}catch{return read(req,res);}
  return route===ROUTE?diagnostic(req,res):read(req,res);
};

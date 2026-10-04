from pathlib import Path
import os,subprocess,json,time
node=r'C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
base=Path(r'C:\Users\user\Documents\Codex\ARA-TECH\ara-tech-site');candidate=Path(__file__).resolve().parents[1]
env=os.environ.copy();env['NODE_PATH']=r'C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules;C:\Users\user\Documents\Codex\ARA-TECH\ara-tech-site\node_modules';env['PA_PGLITE_MODULE']=str(base/'node_modules/@electric-sql/pglite')
tests=['validate-pam-002-gmail-case-communication.cjs','validate-pam-004-gmail-attachments.cjs','validate-pam-005-gmail-reply-attachments.cjs','validate-pam-007-gmail-direct-sent-reconciliation.cjs','validate-pa-managed-send-case-binding.cjs','validate-pa-contract.cjs','validate-pa-contract-v4.cjs','validate-pa-est-005a-receipt-service-summary.cjs','validate-pa-est-010r1.cjs','validate-pa-est-010r2-display.mjs','validate-pa-est-010r3-display-guard.mjs']
results=[]
for t in tests:
 for label,root in [('candidate',candidate)]:
  if not (root/'tests'/t).exists():results.append(dict(test=t,version=label,result='NOT_FOUND'));continue
  try:
   p=subprocess.run([node,str(root/'tests'/t)],cwd=root,env=env,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=120)
   results.append(dict(test=t,version=label,exit_code=p.returncode,result='PASS' if p.returncode==0 else 'FAIL',stdout=p.stdout,stderr=p.stderr))
   print(label,t,p.returncode,flush=True)
  except subprocess.TimeoutExpired as e: results.append(dict(test=t,version=label,result='TIMEOUT'));print(label,t,'TIMEOUT',flush=True)
(candidate.parent.parent/'outputs/ARA-CASE-001R2-audit/REGRESSION_FINAL.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf8')

from pathlib import Path
import subprocess,shutil,json,hashlib
root=Path(__file__).resolve().parents[1]; task=root.parent.parent
mirror=task/'work/r3-regression'
mirror.mkdir(exist_ok=True)
files=subprocess.check_output(['git','ls-files'],cwd=root,text=True).splitlines()
records=[]
for name in files:
 p=root/name
 if not p.is_file():continue
 target=mirror/name;target.parent.mkdir(parents=True,exist_ok=True)
 data=p.read_bytes()
 if name.startswith('tests/'):
  text=data.decode('utf8')
  text=text.replace('ARA-CASE-001R2-audit','ARA-CASE-001R3-audit').replace('ara_case_r2_verify','ara_case_r3_verify').replace('ara_case_r2_guards','ara_case_r3_guards').replace('55442','55444').replace('55443','55445').replace('8872','8874')
  text=text.replace('postgrest-final.conf','postgrest-r3.conf').replace('postgrest-guards.conf','postgrest-r3-guards.conf')
  data=text.encode('utf8')
 target.write_bytes(data)
 records.append({'path':name,'submitted_sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'test_copy_sha256':hashlib.sha256(data).hexdigest(),'changed_only_test_isolation':data!=p.read_bytes()})
# New R3 untracked tests are copied as well, without transforming acceptance logic.
for p in root.glob('tests/*r3*'):
 if p.is_file():shutil.copy2(p,mirror/'tests'/p.name)
font=root/'api/contract-fonts/NotoSansJP.ttf'
if font.exists():
 (mirror/'api/contract-fonts').mkdir(exist_ok=True);shutil.copy2(font,mirror/'api/contract-fonts/NotoSansJP.ttf')
if not (mirror/'node_modules').exists():subprocess.run(['powershell','-NoProfile','-Command',f"New-Item -ItemType Junction -Path '{mirror/'node_modules'}' -Target '{root/'node_modules'}' | Out-Null"],check=True)
(task/'outputs/ARA-CASE-001R3-audit/REGRESSION_ISOLATION.json').write_text(json.dumps({'scope':'Production modules byte identical to submitted worktree. Test-only copies change audit destination, fresh database/port and config filename; no assertion edits.', 'files':records},indent=2),encoding='utf8')
print(str(mirror))

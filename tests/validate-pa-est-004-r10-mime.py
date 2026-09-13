import base64
import json
import os
import pathlib
import subprocess
from email import policy
from email.parser import BytesParser

ROOT = pathlib.Path(__file__).resolve().parent.parent
NAMES = [
    "見積書 2026.10.18 龍姫湖まつり.pdf",
    "音響・電源配置図.pdf",
    "タイムテーブル（改訂版）.pdf",
    "spaces and (parentheses).pdf",
]
NODE = os.environ.get("NODE_BINARY", "node")
SCRIPT = r"""
const mail = require(process.argv[1]);
const names = JSON.parse(process.argv[2]);
process.stdout.write(mail.buildRawMessage({
  to: 'recipient@example.test', subject: 'R10 MIME parser fixture', body: 'Fixture', messageType: 'customer_receipt',
  attachments: names.map((filename, index) => ({ filename, mime_type: 'application/pdf', data: Buffer.from(`%PDF-${index}`).toString('base64url') })),
  config: { senderAddress: 'sender@example.test', senderName: 'ARA-TECH', replyTo: 'sender@example.test', signature: 'ARA-TECH' }
}));
"""
result = subprocess.run([NODE, "-e", SCRIPT, str(ROOT / "api" / "_pa-mail.cjs"), json.dumps(NAMES, ensure_ascii=False)], check=True, capture_output=True)
message = BytesParser(policy=policy.default).parsebytes(base64.urlsafe_b64decode(result.stdout + b"=" * (-len(result.stdout) % 4)))
parts = list(message.iter_attachments())
parsed_filenames = [part.get_filename() for part in parts]
if parsed_filenames != NAMES:
    raise AssertionError(f"Content-Disposition filename did not preserve Unicode: {parsed_filenames!r}")
parsed_names = [part.get_param("name", header="content-type") for part in parts]
if parsed_names != NAMES:
    raise AssertionError(f"Content-Type name did not preserve Unicode: {parsed_names!r}")
print("PASS PA-EST-004R10 MIME parser: Python stdlib recovered all original Unicode filenames")

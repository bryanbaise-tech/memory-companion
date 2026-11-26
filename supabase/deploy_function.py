"""Deploy one edge function: python3 supabase/deploy_function.py <name>"""
import json, os, sys, uuid, urllib.request, urllib.error
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mgmt import REF, TOKEN
name = sys.argv[1]
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "functions", name, "index.ts"), "rb").read()
b = "----mc" + uuid.uuid4().hex
meta = json.dumps({"entrypoint_path": "index.ts", "name": name, "verify_jwt": False}).encode()
body = (f'--{b}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n').encode() + meta + b"\r\n" + \
       (f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="index.ts"\r\nContent-Type: application/typescript\r\n\r\n').encode() + src + b"\r\n" + \
       f"--{b}--\r\n".encode()
req = urllib.request.Request(f"https://api.supabase.com/v1/projects/{REF}/functions/deploy?slug={name}", data=body,
                             headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "multipart/form-data; boundary=" + b}, method="POST")
try:
    with urllib.request.urlopen(req, timeout=180) as r:
        d = json.loads(r.read()); print("deployed", d.get("slug"), d.get("status"), "v", d.get("version"))
except urllib.error.HTTPError as e:
    print("ERR", e.code, e.read()[:800]); sys.exit(1)

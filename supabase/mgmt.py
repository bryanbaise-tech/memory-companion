"""Small helper for the Supabase Management API (token read from .supabase-token, never printed)."""
import json, os, sys, urllib.request, urllib.error
HERE = os.path.dirname(os.path.abspath(__file__))
REF = "hekxmgammddlkdxtjvfd"
TOKEN = open(os.path.join(HERE, "..", ".supabase-token")).read().strip()

def call(method, path, body=None, raw=False):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{REF}{path}",
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"},
        method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            data = r.read()
            return r.status, (data if raw else (json.loads(data) if data else None))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:1000]

def sql(q):
    return call("POST", "/database/query", {"query": q})

if __name__ == "__main__":
    print(sql(sys.argv[1]))

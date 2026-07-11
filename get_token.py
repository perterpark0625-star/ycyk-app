# get_token.py - ????OCR Access Token???config.js
import urllib.request, json, os, re

BASE = os.path.dirname(os.path.abspath(__file__))
CFG_PATH = os.path.join(BASE, "baidu_config.json")

if not os.path.exists(CFG_PATH):
    print("???? baidu_config.json: {\"api_key\": \"xxx\", \"secret_key\": \"xxx\"}")
    exit(1)

cfg = json.load(open(CFG_PATH, "r", encoding="utf-8"))
url = f"https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id={cfg['api_key']}&client_secret={cfg['secret_key']}"
resp = urllib.request.urlopen(url, timeout=10).read()
data = json.loads(resp)

if "access_token" not in data:
    print("??Token??:", data)
    exit(1)

token = data["access_token"]
expires = data["expires_in"]
print(f"Token: {token}")
print(f"???: {expires}? = {expires//86400}?")

# Update config.js
config_path = os.path.join(BASE, "js", "config.js")
if os.path.exists(config_path):
    content = open(config_path, "r", encoding="utf-8").read()
    content = re.sub(r'BUILTIN_TOKEN:\s*"[^"]*"', f'BUILTIN_TOKEN: "{token}"', content)
    open(config_path, "w", encoding="utf-8").write(content)
    print("config.js ???")
else:
    print("config.js ????????")

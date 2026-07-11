from http.server import BaseHTTPRequestHandler
import json
import urllib.request
import os

API_KEY = os.environ.get("BAIDU_API_KEY", "")
SECRET_KEY = os.environ.get("BAIDU_SECRET_KEY", "")

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            url = "https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=" + API_KEY + "&client_secret=" + SECRET_KEY
            req = urllib.request.Request(url)
            resp = urllib.request.urlopen(req, timeout=10).read()
            data = json.loads(resp)
            
            body = json.dumps({
                "access_token": data.get("access_token", ""),
                "expires_in": data.get("expires_in", 0)
            }, ensure_ascii=False).encode("utf-8")
            
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            body = json.dumps({"error": str(e)}).encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

"""
Local web server for Memory Companion.

- Serves the app files and tells the browser never to use stale copies.
- Optional ElevenLabs voice: the API key stays on this computer (in the file
  `.elevenlabs-key` next to this script, or the ELEVENLABS_API_KEY environment
  variable) and is never sent to the web page. The page asks this server for
  audio, and the server asks ElevenLabs.
- Every phrase is saved in `.voice-cache/` after the first time, so repeated
  phrases (reminders, messages) cost nothing to play again.
"""
import hashlib
import http.server
import json
import os
import socketserver
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(HERE, ".voice-cache")
API = "https://api.elevenlabs.io/v1"
MODEL = os.environ.get("ELEVENLABS_MODEL", "eleven_multilingual_v2")  # supports the speed setting
MAX_CHARS = 2500


def api_key():
    key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if key:
        return key
    try:
        with open(os.path.join(HERE, ".elevenlabs-key"), encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def eleven(path, body=None, accept="application/json"):
    req = urllib.request.Request(
        API + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"xi-api-key": api_key(), "Content-Type": "application/json", "Accept": accept},
        method="POST" if body is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=HERE, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, *args):
        pass  # keep the terminal quiet

    # Never serve the key file or the cache folder listing.
    def send_head(self):
        p = self.path.split("?")[0]
        if p.startswith("/.elevenlabs-key") or p.startswith("/.voice-cache") or p.startswith("/.git"):
            self.send_error(404)
            return None
        return super().send_head()

    def reply_json(self, obj, status=200):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/api/voice/status"):
            return self.reply_json({"enabled": bool(api_key())})
        if self.path.startswith("/api/voice/voices"):
            if not api_key():
                return self.reply_json({"error": "No ElevenLabs key"}, 400)
            try:
                data = json.loads(eleven("/voices"))
            except urllib.error.HTTPError as e:
                return self.reply_json({"error": f"ElevenLabs said {e.code}"}, 502)
            except Exception as e:  # network down, etc.
                return self.reply_json({"error": str(e)}, 502)
            voices = [
                {
                    "id": v.get("voice_id"),
                    "name": v.get("name"),
                    "labels": v.get("labels") or {},
                    "description": v.get("description") or "",
                    "preview": v.get("preview_url") or "",
                }
                for v in data.get("voices", [])
            ]
            return self.reply_json({"voices": voices})
        return super().do_GET()

    def do_POST(self):
        if not self.path.startswith("/api/voice/speak"):
            return self.send_error(404)
        if not api_key():
            return self.reply_json({"error": "No ElevenLabs key"}, 400)
        try:
            length = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(min(length, 20000)) or b"{}")
            text = str(req.get("text", "")).strip()[:MAX_CHARS]
            voice_id = "".join(c for c in str(req.get("voiceId", "")) if c.isalnum())
            speed = min(1.2, max(0.7, float(req.get("speed", 0.9))))
        except (ValueError, TypeError):
            return self.reply_json({"error": "Bad request"}, 400)
        if not text or not voice_id:
            return self.reply_json({"error": "Missing text or voice"}, 400)

        key = hashlib.sha256(f"{MODEL}|{voice_id}|{speed}|{text}".encode()).hexdigest()
        path = os.path.join(CACHE_DIR, key + ".mp3")
        if not os.path.exists(path):
            body = {
                "text": text,
                "model_id": MODEL,
                "voice_settings": {
                    "stability": 0.65,        # steady, unhurried delivery
                    "similarity_boost": 0.75,
                    "style": 0.15,            # a little warmth, nothing theatrical
                    "use_speaker_boost": True,
                    "speed": speed,
                },
            }
            try:
                audio = eleven(f"/text-to-speech/{voice_id}?output_format=mp3_44100_128", body, accept="audio/mpeg")
            except urllib.error.HTTPError as e:
                detail = ""
                try:
                    detail = json.loads(e.read()).get("detail", "")
                    if isinstance(detail, dict):
                        detail = detail.get("message", "")
                except Exception:
                    pass
                return self.reply_json({"error": f"ElevenLabs said {e.code}. {detail}".strip()}, 502)
            except Exception as e:
                return self.reply_json({"error": str(e)}, 502)
            os.makedirs(CACHE_DIR, exist_ok=True)
            with open(path, "wb") as f:
                f.write(audio)

        with open(path, "rb") as f:
            audio = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    print(f"ElevenLabs voice: {'ON' if api_key() else 'off (no key yet)'}")
    Server(("", port), Handler).serve_forever()

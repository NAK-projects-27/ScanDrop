#!/usr/bin/env python3
"""
Private Phone -> Laptop Scanner Server
======================================

Everything stays on your own machine / local network.
No cloud, no Firebase, no accounts, no external database.

Requirements:
  - Python 3.7+ (you have 3.13). Standard library only.

Run:
  python server.py

Then:
  - Laptop:  http://localhost:8000/?mode=laptop
  - Phone:   http://<YOUR-LAPTOP-IP>:8000/?mode=phone
             (the script prints your IP addresses on startup)

Both devices must be on the SAME Wi-Fi / network (or the phone hotspot).

Optional flags:
  python server.py --port 8000
  python server.py --save        (also append scans to scans_log.jsonl)
"""

import argparse
import ipaddress
import json
import os
import socket
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

# ------------------------------------------------------------
# In-memory store for scans, keyed by room code
# ------------------------------------------------------------
STORE_LOCK = threading.Lock()
ROOMS = {}          # room -> list of scan dicts
NEXT_ID = {"n": 1}  # simple incrementing id

SAVE_TO_FILE = False
SAVE_PATH = "scans_log.jsonl"
STATIC_DIR = os.path.dirname(os.path.abspath(__file__))
MAX_SCANS_PER_ROOM = 500


def add_scan(room, payload):
    with STORE_LOCK:
        scan_id = NEXT_ID["n"]
        NEXT_ID["n"] += 1

        record = {
            "id": scan_id,
            "room": room,
            "type": payload.get("type", "unknown"),
            "value": payload.get("value", ""),
            "format": payload.get("format", ""),
            "fileName": payload.get("fileName", ""),
            "imageDataUrl": payload.get("imageDataUrl", ""),
            "createdAt": int(time.time() * 1000),
        }

        ROOMS.setdefault(room, []).append(record)

        if len(ROOMS[room]) > MAX_SCANS_PER_ROOM:
            ROOMS[room] = ROOMS[room][-MAX_SCANS_PER_ROOM:]

    if SAVE_TO_FILE:
        try:
            log_record = dict(record)
            if log_record.get("imageDataUrl"):
                log_record["imageDataUrl"] = "[image omitted from log]"
            with open(SAVE_PATH, "a", encoding="utf-8") as f:
                f.write(json.dumps(log_record) + "\n")
        except Exception as e:
            print("Could not write to log file:", e)

    return record


def get_scans(room, since_id):
    with STORE_LOCK:
        scans = ROOMS.get(room, [])
        if since_id <= 0:
            return list(scans)
        return [s for s in scans if s["id"] > since_id]


def clear_room(room):
    with STORE_LOCK:
        ROOMS[room] = []


# ------------------------------------------------------------
# HTTP handler
# ------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path):
        safe_path = os.path.normpath(path).lstrip("/\\")
        full = os.path.join(STATIC_DIR, safe_path)

        if not os.path.abspath(full).startswith(os.path.abspath(STATIC_DIR)):
            self.send_error(403, "Forbidden")
            return

        if os.path.isdir(full):
            full = os.path.join(full, "index.html")

        if not os.path.isfile(full):
            self.send_error(404, "Not found")
            return

        ctype = "application/octet-stream"
        if full.endswith(".html"):
            ctype = "text/html; charset=utf-8"
        elif full.endswith(".css"):
            ctype = "text/css; charset=utf-8"
        elif full.endswith(".js"):
            ctype = "text/javascript; charset=utf-8"
        elif full.endswith(".json"):
            ctype = "application/json"
        elif full.endswith(".png"):
            ctype = "image/png"
        elif full.endswith(".jpg") or full.endswith(".jpeg"):
            ctype = "image/jpeg"

        try:
            with open(full, "rb") as f:
                data = f.read()
        except Exception:
            self.send_error(500, "Read error")
            return

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/scans":
            params = _parse_query(parsed.query)
            room = params.get("room", "default")
            since = _to_int(params.get("since", "0"))
            scans = get_scans(room, since)
            self._send_json({"ok": True, "scans": scans})
            return

        if path == "/api/ping":
            self._send_json({"ok": True, "time": int(time.time() * 1000)})
            return

        if path == "/":
            path = "/index.html"
        self._send_file(path)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length > 0 else b""

        if path == "/api/scan":
            try:
                payload = json.loads(raw.decode("utf-8"))
            except Exception:
                self._send_json({"ok": False, "error": "Invalid JSON"}, status=400)
                return

            room = str(payload.get("room", "default"))[:80]
            record = add_scan(room, payload)
            self._send_json({"ok": True, "id": record["id"]})
            return

        if path == "/api/clear":
            try:
                payload = json.loads(raw.decode("utf-8"))
            except Exception:
                payload = {}
            room = str(payload.get("room", "default"))[:80]
            clear_room(room)
            self._send_json({"ok": True})
            return

        self._send_json({"ok": False, "error": "Unknown endpoint"}, status=404)


def _parse_query(q):
    out = {}
    if not q:
        return out
    for part in q.split("&"):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k] = v
        else:
            out[part] = ""
    return out


def _to_int(v):
    try:
        return int(v)
    except Exception:
        return 0


def get_local_ips():
    ips = set()
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None):
            addr = info[4][0]
            try:
                ip = ipaddress.ip_address(addr)
                if ip.version == 4 and not ip.is_loopback:
                    ips.add(str(ip))
            except ValueError:
                pass
    except Exception:
        pass

    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass

    return sorted(ips)


def main():
    global SAVE_TO_FILE

    parser = argparse.ArgumentParser(description="Private phone-to-laptop scanner server")
    parser.add_argument("--port", type=int, default=8000, help="Port to listen on (default 8000)")
    parser.add_argument("--save", action="store_true", help="Also append scans to scans_log.jsonl")
    args = parser.parse_args()

    SAVE_TO_FILE = args.save

    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)

    ips = get_local_ips()

    print("=" * 60)
    print("  PRIVATE SCANNER SERVER RUNNING")
    print("  All data stays on your machine / local network.")
    print("=" * 60)
    print()
    print("On THIS laptop, open:")
    print("   http://localhost:%d/?mode=laptop" % args.port)
    print()
    print("On your PHONE (same Wi-Fi / hotspot), open ONE of these:")
    if ips:
        for ip in ips:
            print("   http://%s:%d/?mode=phone" % (ip, args.port))
    else:
        print("   http://<your-laptop-ip>:%d/?mode=phone" % args.port)
    print()
    print("Tip: use the same Room code on phone and laptop.")
    if SAVE_TO_FILE:
        print("Saving scans to: %s" % os.path.abspath(SAVE_PATH))
    print()
    print("Press Ctrl+C to stop.")
    print("Started at", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    print()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down. Scan data in memory is cleared.")
        server.shutdown()


if __name__ == "__main__":
    main()

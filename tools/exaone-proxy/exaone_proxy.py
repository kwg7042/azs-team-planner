# -*- coding: utf-8 -*-
"""AZS 팀플래너용 EXAONE 로컬 프록시 (표준 라이브러리만 사용, 설치할 패키지 없음)

왜 필요한가
  · 브라우저(팀플래너)는 EXAONE API를 직접 부르면 막히거나(CORS) API 키가 노출됩니다.
  · 이 프록시를 내 PC에서 켜 두면 팀플래너가 http://localhost:8787 로 요청하고,
    프록시가 내 API 키를 붙여 EXAONE에 대신 전달합니다. 키는 내 PC 밖으로 나가지 않습니다.

사용법 (Windows)
  1) 이 파일과 EXAONE_proxy_start.bat 을 같은 폴더에 둡니다.
  2) EXAONE_proxy_start.bat 더블클릭 (또는: python exaone_proxy.py)
  3) 처음 한 번만 API 키를 물어봅니다 → 같은 폴더의 exaone_proxy_config.json 에 저장
  4) 창을 켜 둔 채로 팀플래너에서 EXAONE 기능을 사용합니다. 끝낼 때는 Ctrl+C

옵션
  python exaone_proxy.py --reset     API 키/주소 다시 입력
  python exaone_proxy.py --port 8787 포트 변경 (팀플래너 AI 설정의 프록시 URL도 같이 바꿔야 함)
  환경변수 EXAONE_API_KEY / EXAONE_BASE_URL / EXAONE_PROXY_TIMEOUT 이 있으면 설정 파일보다 우선
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = 2
HOST = "127.0.0.1"
DEFAULT_PORT = 8787
DEFAULT_BASE_URL = "https://api.lgresearch.ai/v1"
CONFIG_PATH = Path(__file__).with_name("exaone_proxy_config.json")
# 특허 도면 해석은 수 분 걸릴 수 있어 기본 15분 대기
READ_TIMEOUT = int(os.environ.get("EXAONE_PROXY_TIMEOUT", "900"))
MAX_BODY = 60 * 1024 * 1024  # 도면 이미지가 들어가므로 넉넉하게 (60MB)

# 팀플래너 주소만 허용 (다른 사이트가 내 키로 EXAONE을 쓰지 못하게)
ALLOWED_ORIGIN_PATTERNS = [
    re.compile(r"^https://kwg7042\.github\.io$"),
    re.compile(r"^http://(localhost|127\.0\.0\.1)(:\d+)?$"),
]


def origin_allowed(origin: str) -> bool:
    return any(p.match(origin or "") for p in ALLOWED_ORIGIN_PATTERNS)


def normalize_url(base_url: str) -> str:
    url = (base_url or DEFAULT_BASE_URL).strip().rstrip("/")
    return url if url.endswith("/chat/completions") else url + "/chat/completions"


def load_config(reset: bool = False) -> dict:
    cfg: dict = {}
    if CONFIG_PATH.exists() and not reset:
        try:
            cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            cfg = {}
    if os.environ.get("EXAONE_API_KEY"):
        cfg["api_key"] = os.environ["EXAONE_API_KEY"]
    if os.environ.get("EXAONE_BASE_URL"):
        cfg["base_url"] = os.environ["EXAONE_BASE_URL"]
    if not cfg.get("api_key"):
        print("=" * 60)
        print(" EXAONE API 키를 입력하세요 (입력해도 화면에 보이지 않습니다)")
        print(" 키는 이 PC의 exaone_proxy_config.json 에만 저장됩니다.")
        print("=" * 60)
        key = getpass.getpass(" API 키: ").strip()
        if not key:
            print("API 키가 없어서 종료합니다.")
            sys.exit(1)
        base = input(f" 엔드포인트 주소 (그냥 Enter = {DEFAULT_BASE_URL}): ").strip()
        cfg = {"api_key": key, "base_url": base or DEFAULT_BASE_URL}
        try:
            CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f" 저장했습니다: {CONFIG_PATH}")
        except OSError as exc:
            print(f" (설정 파일 저장 실패: {exc}) 이번 실행에만 사용합니다.")
    cfg.setdefault("base_url", DEFAULT_BASE_URL)
    return cfg


class Handler(BaseHTTPRequestHandler):
    server_version = f"AZS-ExaoneProxy/{VERSION}"
    protocol_version = "HTTP/1.1"
    api_key = ""
    target_url = ""

    # --- CORS ---------------------------------------------------------
    def _cors(self) -> None:
        origin = self.headers.get("Origin", "")
        if origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            # 크롬의 사설망 접근(Private Network Access) 사전 요청 대응
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Vary", "Origin")

    def _send(self, status: int, body: bytes, ctype: str = "application/json; charset=utf-8") -> None:
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, data: dict) -> None:
        self._send(status, json.dumps(data, ensure_ascii=False).encode("utf-8"))

    # --- 요청 처리 ----------------------------------------------------
    def do_OPTIONS(self) -> None:  # noqa: N802
        # 204에는 본문을 보내면 안 됨 (keep-alive 연결에서 다음 응답이 깨짐)
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        # 팀플래너가 '프록시가 켜져 있는지' 확인할 때 사용
        self._json(200, {"ok": True, "service": "azs-exaone-proxy", "version": VERSION})

    def do_POST(self) -> None:  # noqa: N802
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if length <= 0 or length > MAX_BODY:
            self.close_connection = True  # 본문을 안 읽었으니 연결을 닫아 다음 요청이 꼬이지 않게
            self._json(400, {"error": "요청 본문이 없거나 너무 큽니다."})
            return
        body = self.rfile.read(length)  # 거절하더라도 본문은 먼저 다 읽음 (keep-alive 연결 보호)
        origin = self.headers.get("Origin", "")
        if origin and not origin_allowed(origin):
            self._json(403, {"error": f"허용되지 않은 주소에서 온 요청입니다: {origin}"})
            return
        try:
            json.loads(body)
        except ValueError:
            self._json(400, {"error": "JSON 형식이 아닙니다."})
            return
        req = urllib.request.Request(
            self.target_url,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=READ_TIMEOUT) as res:
                self._send(res.status, res.read())
        except urllib.error.HTTPError as exc:
            data = exc.read() or json.dumps({"error": str(exc)}).encode("utf-8")
            hint = {401: "API 키가 틀렸거나 만료되었습니다 (--reset 으로 다시 입력)",
                    403: "이 키로 접근이 허용되지 않았습니다",
                    404: "엔드포인트 주소나 모델명이 맞지 않습니다",
                    429: "요청이 너무 많습니다. 잠시 후 다시 시도하세요"}.get(exc.code)
            if hint:
                print(f"[EXAONE] {exc.code}: {hint}")
            self._send(exc.code, data)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            print(f"[EXAONE] 연결 실패: {exc}")
            self._json(502, {"error": f"프록시가 EXAONE 서버에 연결하지 못했습니다: {exc}"})

    def log_message(self, fmt: str, *args) -> None:
        print(f"[프록시] {self.address_string()} - {fmt % args}")


def main() -> None:
    ap = argparse.ArgumentParser(description="AZS 팀플래너 EXAONE 로컬 프록시")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--reset", action="store_true", help="API 키/주소 다시 입력")
    args = ap.parse_args()

    cfg = load_config(reset=args.reset)
    Handler.api_key = cfg["api_key"]
    Handler.target_url = normalize_url(cfg.get("base_url"))
    try:
        server = ThreadingHTTPServer((HOST, args.port), Handler)
    except OSError as exc:
        print(f"포트 {args.port}을(를) 열 수 없습니다 ({exc}).")
        print("이미 프록시가 켜져 있거나 다른 프로그램이 쓰고 있습니다. 켜져 있는 창이 있으면 그대로 쓰면 됩니다.")
        sys.exit(1)
    print("=" * 60)
    print(f" EXAONE 로컬 프록시 실행 중: http://localhost:{args.port}")
    print(f" 전달 주소: {Handler.target_url}")
    print(f" 최대 대기: {READ_TIMEOUT}초")
    print(" 이 창을 켜 둔 채로 팀플래너를 사용하세요. 종료: Ctrl+C")
    print(" (브라우저가 '이 기기의 다른 앱/서비스 접근' 권한을 물으면 '허용')")
    print("=" * 60)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n프록시를 종료합니다.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

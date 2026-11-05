# -*- coding: utf-8 -*-
"""AZS 팀플래너용 EXAONE 로컬 프록시 (표준 라이브러리만 사용, 설치할 패키지 없음)

왜 필요한가
  · 브라우저(팀플래너)는 EXAONE API를 직접 부르면 막히거나(CORS) API 키가 노출됩니다.
  · 이 프록시를 내 PC에서 켜 두면 팀플래너가 http://localhost:8787 로 요청하고,
    프록시가 내 API 키를 붙여 EXAONE에 대신 전달합니다. 키는 내 PC 밖으로 나가지 않습니다.

팀 공유 (다른 사람 PC에서도 EXAONE 쓰기)
  · API 키가 있는 사람이 EXAONE_proxy_share_start.bat (= python exaone_proxy.py --share) 로 켜 두면
    팀원 브라우저가 Firebase(exaone_jobs)에 요청을 올리고, 이 PC가 대신 EXAONE을 불러 결과를 돌려줍니다.
    다른 사람은 아무것도 설치하지 않아도 됩니다. (키는 이 PC 밖으로 나가지 않음, 사용량은 이 키로 계산)

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
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = 4
HOST = "127.0.0.1"
DEFAULT_PORT = 8787
DEFAULT_BASE_URL = "https://api.lgresearch.ai/v1"
CONFIG_PATH = Path(__file__).with_name("exaone_proxy_config.json")
# 특허 도면 해석은 수 분 걸릴 수 있어 기본 15분 대기
READ_TIMEOUT = int(os.environ.get("EXAONE_PROXY_TIMEOUT", "900"))
MAX_BODY = 60 * 1024 * 1024  # 도면 이미지가 들어가므로 넉넉하게 (60MB)
# 팀 공유(--share): 팀플래너 Firebase 주소
FIREBASE_URL = os.environ.get("AZS_FIREBASE_URL", "https://azs-planner-default-rtdb.firebaseio.com").rstrip("/")
RELAY_MAX_JOBS = 2  # 동시에 처리할 팀원 요청 수

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


CHECK_MODEL = os.environ.get("EXAONE_CHECK_MODEL", "exaone-v4.5_33b")


def call_exaone(target_url: str, api_key: str, body: bytes, timeout: int = 0) -> tuple[int, bytes]:
    """EXAONE에 그대로 전달하고 (상태 코드, 응답 본문)을 돌려줌. 연결 실패는 502."""
    req = urllib.request.Request(
        target_url, data=body, method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json", "Authorization": f"Bearer {api_key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout or READ_TIMEOUT) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as exc:
        data = exc.read() or json.dumps({"error": str(exc)}).encode("utf-8")
        hint = {401: "API 키가 틀렸거나 이 주소용 키가 아닙니다 → 프록시 창을 닫고 다시 실행하면 키를 다시 확인해요",
                403: "이 키로 접근이 허용되지 않았습니다",
                404: "엔드포인트 주소나 모델명이 맞지 않습니다",
                429: "요청이 너무 많습니다. 잠시 후 다시 시도하세요"}.get(exc.code)
        if hint:
            print(f"[EXAONE] {exc.code}: {hint}")
        return exc.code, data
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        print(f"[EXAONE] 연결 실패: {exc}")
        return 502, json.dumps({"error": f"프록시가 EXAONE 서버에 연결하지 못했습니다: {exc}"}, ensure_ascii=False).encode("utf-8")


def _read_old_config(folder: Path) -> dict:
    """예전 ExaOne 폴더 설정(exaone_config.json / .env)이 같은 폴더에 있으면 그 값을 씀 (이미 되던 키·주소)"""
    out: dict = {}
    js = folder / "exaone_config.json"
    if js.exists():
        try:
            d = json.loads(js.read_text(encoding="utf-8"))
            for k in ("api_key", "base_url"):
                if d.get(k) and "여기에" not in str(d.get(k)):
                    out[k] = str(d[k]).strip()
        except (OSError, ValueError):
            pass
    env = folder / ".env"
    if env.exists():
        try:
            for line in env.read_text(encoding="utf-8").splitlines():
                m = re.match(r"\s*(EXAONE_API_KEY|EXAONE_BASE_URL)\s*=\s*(.+?)\s*$", line)
                if m and "여기에" not in m.group(2):
                    out["api_key" if m.group(1) == "EXAONE_API_KEY" else "base_url"] = m.group(2).strip().strip('"').strip("'")
        except OSError:
            pass
    return out


# 예전 ExaOne 폴더(exaone_client.py / *exaone_local_proxy*.py 가 있는 곳)를 내 문서 폴더 아래에서 자동으로 찾기
_SKIP_DIRS = {"appdata", "node_modules", "__pycache__", "site-packages", "venv", ".venv", "env", "library",
              "program files", "program files (x86)", "windows", "$recycle.bin", "anaconda3", "miniconda3"}


def find_old_configs(limit_sec: float = 10.0, max_depth: int = 7) -> list:
    roots = [CONFIG_PATH.parent, CONFIG_PATH.parent.parent, Path.home()]
    found, seen, t0 = [], set(), time.time()
    for root in roots:
        try:
            root = root.resolve()
        except OSError:
            continue
        base_depth = len(root.parts)
        for dirpath, dirnames, filenames in os.walk(root):
            if time.time() - t0 > limit_sec:
                return found
            d = Path(dirpath)
            if len(d.parts) - base_depth >= max_depth:
                dirnames[:] = []
            dirnames[:] = [x for x in dirnames if not x.startswith(".") and x.lower() not in _SKIP_DIRS]
            names = set(filenames)
            if ("exaone_client.py" in names or any("exaone_local_proxy" in f for f in names)) and d not in seen:
                seen.add(d)
                cfg = _read_old_config(d)
                if cfg.get("api_key"):
                    found.append((d, cfg))
            if root == CONFIG_PATH.parent or root == CONFIG_PATH.parent.parent:
                dirnames[:] = dirnames if len(d.parts) - base_depth < 2 else []
    return found


def offer_old_config(cfg: dict, exclude_key: str = "") -> dict:
    print(" 예전에 쓰던 EXAONE 설정(ExaOne 폴더)을 찾는 중… (최대 10초)")
    for folder, old in find_old_configs():
        if old.get("api_key") == exclude_key and (old.get("base_url") or DEFAULT_BASE_URL) == (cfg.get("base_url") or DEFAULT_BASE_URL):
            continue
        print(f" 찾았습니다: {folder}")
        print(f"   주소 {normalize_url(old.get('base_url') or DEFAULT_BASE_URL)} · 키 {mask(old['api_key'])}")
        ans = input(" 이 설정을 쓸까요? (Enter = 예 / n = 아니오): ").strip().lower()
        if ans in ("", "y", "yes", "예", "ㅇ"):
            new = dict(cfg, api_key=_clean_key(old["api_key"]), base_url=old.get("base_url") or DEFAULT_BASE_URL)
            save_config(new)
            return new
    print(" 예전 설정을 찾지 못했습니다.")
    return {}


def _clean_key(key: str) -> str:
    key = (key or "").strip().strip('"').strip("'")
    if key.lower().startswith("bearer "):
        key = key[7:].strip()
    return re.sub(r"[\s\x00-\x1f]", "", key)  # 붙여넣기로 섞인 공백·제어문자 제거


def save_config(cfg: dict) -> None:
    try:
        CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f" 저장했습니다: {CONFIG_PATH}")
    except OSError as exc:
        print(f" (설정 파일 저장 실패: {exc}) 이번 실행에만 사용합니다.")


def ask_key(cfg: dict) -> dict:
    print("=" * 60)
    print(" EXAONE API 키를 입력하세요 (입력해도 화면에 보이지 않습니다 · 붙여넣기는 마우스 우클릭)")
    print(" 키는 이 PC의 exaone_proxy_config.json 에만 저장됩니다.")
    print("=" * 60)
    key = _clean_key(getpass.getpass(" API 키: "))
    if not key:
        print("API 키가 없어서 종료합니다.")
        sys.exit(1)
    cur = cfg.get("base_url") or DEFAULT_BASE_URL
    print(" 엔드포인트 주소: 회사에서 받은 안내(또는 예전 ExaOne 폴더 .env 의 EXAONE_BASE_URL)에 적힌 주소")
    base = input(f" 엔드포인트 주소 (그냥 Enter = {cur}): ").strip()
    cfg = dict(cfg, api_key=key, base_url=base or cur)
    save_config(cfg)
    return cfg


def load_config(reset: bool = False) -> dict:
    cfg: dict = {}
    if CONFIG_PATH.exists() and not reset:
        try:
            cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            cfg = {}
    if not cfg.get("api_key") and not reset:
        old = _read_old_config(CONFIG_PATH.parent)
        if old.get("api_key"):
            print(" 예전 EXAONE 설정(exaone_config.json/.env)을 찾아서 그 키·주소를 사용합니다.")
            cfg.update(old)
    if os.environ.get("EXAONE_API_KEY"):
        cfg["api_key"] = os.environ["EXAONE_API_KEY"]
    if os.environ.get("EXAONE_BASE_URL"):
        cfg["base_url"] = os.environ["EXAONE_BASE_URL"]
    if not cfg.get("api_key") and not reset:
        cfg = offer_old_config(cfg) or cfg
    if not cfg.get("api_key"):
        cfg = ask_key(cfg)
    cfg["api_key"] = _clean_key(cfg["api_key"])
    cfg.setdefault("base_url", DEFAULT_BASE_URL)
    return cfg


def mask(key: str) -> str:
    return key[:4] + "…" + key[-4:] if len(key) > 10 else "…"


def check_key(cfg: dict) -> dict:
    """시작할 때 아주 짧은 요청으로 키·주소 확인. 401/403/404면 그 자리에서 다시 입력 (최대 3번)"""
    for attempt in range(4):
        url = normalize_url(cfg.get("base_url"))
        print(f" EXAONE 연결 확인 중… (주소 {url}, 키 {mask(cfg['api_key'])})")
        body = json.dumps({"model": CHECK_MODEL, "messages": [{"role": "user", "content": "ping"}], "max_tokens": 1,
                           "chat_template_kwargs": {"enable_thinking": False}}).encode("utf-8")
        code, data = call_exaone(url, cfg["api_key"], body, timeout=60)
        if 200 <= code < 300:
            print(" ✅ EXAONE 연결 확인 완료")
            return cfg
        if code in (401, 403, 404) and attempt < 3:
            why = {401: "API 키가 맞지 않습니다 (키가 틀렸거나 만료, 또는 이 키에 맞는 주소가 아님)",
                   403: "이 키로 접근이 허용되지 않았습니다", 404: "엔드포인트 주소나 모델명이 맞지 않습니다"}[code]
            print(f" ❌ {code}: {why}")
            print(f"    서버 응답: {data[:200].decode('utf-8', 'replace')}")
            if attempt == 0:
                found = offer_old_config(cfg, exclude_key=cfg["api_key"])
                if found:
                    cfg = found
                    continue
            print(" 키와 주소를 다시 입력해 주세요. (그만하려면 창을 닫으세요)")
            cfg = ask_key(cfg)
            continue
        if code in (401, 403, 404):
            print(f" ❌ {code}: 키·주소 확인에 계속 실패했습니다. 회사에서 받은 키·주소를 확인한 뒤 다시 실행하세요.")
            return cfg
        print(f" ⚠️ 연결 확인을 못 했습니다 ({code}). 일단 켜 두고, 요청이 오면 다시 시도합니다.")
        return cfg
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
        status, data = call_exaone(self.target_url, self.api_key, body)
        self._send(status, data)

    def log_message(self, fmt: str, *args) -> None:
        print(f"[프록시] {self.address_string()} - {fmt % args}")


# ---------------------------------------------------------------------
# 팀 공유: Firebase의 exaone_jobs에 올라온 팀원 요청을 이 PC가 대신 처리
#  · 브라우저: exaone_jobs/{id} = {status:'pending', payload:'<JSON>', from, at}
#  · 이 PC: status를 'working'으로 선점(ETag 조건부 쓰기) → EXAONE 호출 → {status:'done', code, body}
#  · exaone_relay/worker 에 15초마다 '켜져 있음' 표시 (팀플래너 설정창에 보임)
# ---------------------------------------------------------------------
class FirebaseREST:
    def __init__(self, base: str) -> None:
        self.base = base

    def call(self, method: str, path: str, data=None, query: str = "", headers=None, timeout: int = 30):
        url = f"{self.base}/{path}.json" + (f"?{query}" if query else "")
        body = None if data is None else json.dumps(data, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(url, data=body, method=method, headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                raw = res.read()
                return res.status, res.headers, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as exc:
            return exc.code, exc.headers, None


class RelayWorker(threading.Thread):
    def __init__(self, name: str, target_url: str, api_key: str) -> None:
        super().__init__(daemon=True)
        self.name_shown, self.target_url, self.api_key = name, target_url, api_key
        self.fb = FirebaseREST(FIREBASE_URL)
        self.active: set[str] = set()
        self.seen: dict[str, float] = {}
        self.lock = threading.Lock()
        self.last_hb = 0.0
        self.last_clean = 0.0
        self.fail_count = 0

    def heartbeat(self) -> None:
        self.fb.call("PUT", "exaone_relay/worker", {"name": self.name_shown, "at": {".sv": "timestamp"}, "version": VERSION, "busy": len(self.active)})
        self.last_hb = time.time()

    def claim(self, key: str) -> bool:
        st, hd, val = self.fb.call("GET", f"exaone_jobs/{key}/status", headers={"X-Firebase-ETag": "true"})
        if st != 200 or val != "pending":
            return False
        etag = hd.get("ETag") if hd else None
        if not etag:
            return False
        st2, _, _ = self.fb.call("PUT", f"exaone_jobs/{key}/status", "working", headers={"if-match": etag})
        return st2 == 200  # 412면 다른 PC가 먼저 가져감

    def process(self, key: str) -> None:
        t0 = time.time()
        try:
            st, _, job = self.fb.call("GET", f"exaone_jobs/{key}", timeout=60)
            if st != 200 or not isinstance(job, dict) or not isinstance(job.get("payload"), str):
                return
            who = str(job.get("from") or "팀원")
            print(f"[팀 공유] {who}님 요청 처리 중… ({len(job['payload']) // 1024}KB)")
            code, data = call_exaone(self.target_url, self.api_key, job["payload"].encode("utf-8"))
            # 그사이 요청자가 취소해서 지웠으면 다시 만들지 않음
            st3, _, cur = self.fb.call("GET", f"exaone_jobs/{key}/status")
            if cur is None:
                print(f"[팀 공유] {who}님 요청이 취소되어 결과를 버립니다.")
                return
            self.fb.call("PATCH", f"exaone_jobs/{key}", {
                "status": "done", "code": code, "body": data.decode("utf-8", "replace"),
                "by": self.name_shown, "doneAt": {".sv": "timestamp"},
            }, timeout=60)
            print(f"[팀 공유] {who}님 요청 완료 ({code}, {round(time.time() - t0)}초)")
        except Exception as exc:  # noqa: BLE001 - 워커는 멈추지 않게
            print(f"[팀 공유] 처리 중 오류: {exc}")
            self.fb.call("PATCH", f"exaone_jobs/{key}", {"status": "done", "code": 502,
                         "body": json.dumps({"error": f"공유 프록시 처리 오류: {exc}"}, ensure_ascii=False)})
        finally:
            with self.lock:
                self.active.discard(key)

    def cleanup(self) -> None:
        # 30분 넘게 남아 있는 요청(브라우저를 닫아 못 지운 것) 정리
        self.last_clean = time.time()
        st, _, keys = self.fb.call("GET", "exaone_jobs", query="shallow=true")
        if st != 200 or not isinstance(keys, dict):
            return
        now_ms = time.time() * 1000
        for key in keys:
            if key in self.active:
                continue
            _, _, at = self.fb.call("GET", f"exaone_jobs/{key}/at")
            if not isinstance(at, (int, float)):
                _, _, at = self.fb.call("GET", f"exaone_jobs/{key}/doneAt")
            if not isinstance(at, (int, float)) or now_ms - at > 30 * 60 * 1000:
                self.fb.call("DELETE", f"exaone_jobs/{key}")

    def run(self) -> None:
        print(f"[팀 공유] 켜짐 — 팀원 요청을 이 PC의 키로 처리합니다 (표시 이름: {self.name_shown})")
        while True:
            try:
                if time.time() - self.last_hb > 15:
                    self.heartbeat()
                if time.time() - self.last_clean > 600:
                    self.cleanup()
                st, _, keys = self.fb.call("GET", "exaone_jobs", query="shallow=true")
                if st == 200 and isinstance(keys, dict):
                    for key in sorted(keys):
                        if key in self.seen or len(self.active) >= RELAY_MAX_JOBS:
                            continue
                        self.seen[key] = time.time()
                        if self.claim(key):
                            with self.lock:
                                self.active.add(key)
                            threading.Thread(target=self.process, args=(key,), daemon=True).start()
                # 오래된 기록 정리
                for k in [k for k, t in self.seen.items() if time.time() - t > 3600]:
                    self.seen.pop(k, None)
                if self.fail_count:
                    print("[팀 공유] Firebase 연결이 다시 됐습니다.")
                self.fail_count = 0
            except Exception as exc:  # noqa: BLE001
                self.fail_count += 1
                if self.fail_count in (1, 10) or self.fail_count % 60 == 0:
                    print(f"[팀 공유] Firebase 연결 오류 (계속 다시 시도): {exc}")
            time.sleep(1.5)


def main() -> None:
    ap = argparse.ArgumentParser(description="AZS 팀플래너 EXAONE 로컬 프록시")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--reset", action="store_true", help="API 키/주소 다시 입력")
    ap.add_argument("--share", action="store_true", help="팀 공유: 다른 사람 PC의 EXAONE 요청도 이 PC가 대신 처리")
    ap.add_argument("--no-check", action="store_true", help="시작할 때 키 확인 생략")
    args = ap.parse_args()

    cfg = load_config(reset=args.reset)
    if not args.no_check:
        cfg = check_key(cfg)
    if args.share and not cfg.get("share_name"):
        name = input(" 팀원에게 보일 공유 PC 이름 (예: 김원근): ").strip() or socket.gethostname()
        cfg["share_name"] = name
        try:
            CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError:
            pass
    print(f" 사용 중인 주소: {normalize_url(cfg.get('base_url'))} · 키 {mask(cfg['api_key'])}")
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
    if args.share:
        print(f" 팀 공유 켜짐: 다른 사람도 팀플래너에서 EXAONE을 쓸 수 있습니다 (Firebase: {FIREBASE_URL})")
    print("=" * 60)
    if args.share:
        RelayWorker(cfg.get("share_name") or socket.gethostname(), Handler.target_url, Handler.api_key).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n프록시를 종료합니다.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

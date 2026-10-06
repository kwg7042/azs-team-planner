#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
카톡이슈 데이터 자동 갱신 (GitHub Actions용)
============================================
PC에서 돌던 두 스크립트를 하나로 합친 서버용 버전.
  - 260807_카톡_수집분류_v1.3.py : Gmail에서 카톡/WhatsApp 내보내기 zip 수집 + 방 판별 + 누적 병합
  - 260807_이슈조회_빌드_v1.1.py : 메시지 구조화 → window.ISSUE_DATA

PC와 다른 점
------------
- 누적본(_accumulated.txt)을 파일로 두지 않는다. 사이트에 올라가 있는 암호문
  `_issues_data.enc.js` 자체를 복호화해 누적 베이스로 쓰고, 새 메시지만 이어붙인 뒤
  다시 암호화한다. (저장소가 공개이므로 평문은 어디에도 남기지 않는다)
- 처리한 메일 id 기록 대신 최근 N일(`--days`) 메일만 조회한다. 내보내기는 전체 대화가
  들어 있고 중복은 병합 단계에서 걸러지므로 같은 메일을 다시 읽어도 결과는 같다.
- 로그에는 폴더명과 건수만 남긴다(Actions 로그는 공개). 대화 내용·방 이름·발신자는 출력하지 않는다.

환경변수(GitHub Secrets)
------------------------
  GMAIL_TOKEN_JSON  : PC의 token_gmail.json 내용 그대로 (refresh_token 포함)
  ISSUE_PASSWORD    : 카톡이슈 탭 팀 암호 (기존 암호문을 풀 수 있어야 함)
  KAKAO_ROOM_RULES  : (선택) PC의 방_폴더_매핑.json 내용. 없으면 기본 키워드 사용

사용법
------
  python tools/kakao_issue_sync.py --enc path/to/_issues_data.enc.js [--days 3]
"""

import argparse
import base64
import io
import json
import os
import re
import sys
import zipfile
from collections import Counter
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# 방 설정 (260807_이슈조회_빌드_v1.1.py 와 동일)
# (폴더, 방 표시이름, 시차변환 여부, 소스 형식)
# ---------------------------------------------------------------------------
ROOMS = [
    ("DNC_인텍", "DNC 인텍 업무", True, "kakao"),
    ("DNC_샘플대응", "[DNC]샘플생산재개", True, "kakao"),
    ("AZS_팀", "AZS 공정기술팀", False, "kakao"),
    ("DNC_DSK", "ESHG DNC (LG&OEM)", True, "kakao"),
    ("전극", "전극 공급", True, "kakao"),
    ("DNC_WEB", "DNC WEB TORN AND JAM UPDATE", False, "whatsapp"),
]
ROOM_INFO = {f: {"room": r, "convert": c, "source": s} for f, r, c, s in ROOMS}

# 방_폴더_매핑.json 이 Secret으로 주어지지 않았을 때 쓰는 기본 판별 키워드.
# 앞쪽 규칙이 먼저 매칭되므로 구체적인 키워드를 먼저 둔다.
DEFAULT_RULES = [
    {"folder": "DNC_WEB", "room": "DNC WEB TORN AND JAM UPDATE", "keywords": ["DNC WEB", "TORN AND JAM"]},
    {"folder": "DNC_인텍", "room": "DNC 인텍 업무", "keywords": ["인텍"]},
    {"folder": "DNC_샘플대응", "room": "[DNC]샘플생산재개", "keywords": ["샘플생산재개", "샘플 생산 재개"]},
    {"folder": "AZS_팀", "room": "AZS 공정기술팀", "keywords": ["AZS 공정기술팀", "공정기술팀"]},
    {"folder": "DNC_DSK", "room": "ESHG DNC (LG&OEM)", "keywords": ["ESHG DNC", "LG&OEM", "LG_OEM"]},
    {"folder": "전극", "room": "전극 공급", "keywords": ["전극 공급", "전극공급"]},
]

GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
GMAIL_QUERY = 'filename:zip (Kakaotalk OR WhatsApp OR "WhatsApp 대화")'

RE_FILENAME_ROOM = re.compile(r"Kakaotalk[_ ]?Chat[_ ](.+)", re.IGNORECASE)
RE_WA_FILENAME_ROOM = re.compile(r"^(.*?)\s*님과의\s*WhatsApp\s*대화", re.IGNORECASE)
RE_FIRSTLINE_ROOM = re.compile(r"^(.*?)\s*님과 카카오톡 대화")

# --- 파서 (260807_이슈조회_빌드_v1.1.py 그대로) ---
RE_MSG = re.compile(
    r"^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(오전|오후)\s*(\d{1,2}):(\d{2})\s*(,|:)\s*(.*)$"
)
RE_WA_SLASH = re.compile(
    r"^(\d{1,2})/(\d{1,2})/(\d{1,2})\s+(AM|PM|오전|오후)\s+(\d{1,2}):(\d{2})\s*-\s*(.*)$"
)
RE_WA_DOT = re.compile(
    r"^\[?\s*(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?\s*(오전|오후)\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\]?\s*(?:-\s*)?(.*)$"
)
RE_DAY = re.compile(r"^\d{4}년\s*\d{1,2}월\s*\d{1,2}일")
RE_SKIP = re.compile(r"^(Talk_.*\.txt\s*$|저장한 날짜|#)")

PBKDF2_ITER = 250000  # index.html decryptEnc 와 동일


def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def to_24h(ampm, hour):
    h = int(hour)
    if ampm in ("오전", "AM"):
        return 0 if h == 12 else h
    return 12 if h == 12 else h + 12


def parse_messages(lines):
    msgs = []
    cur = None
    for line in lines:
        if RE_SKIP.match(line) or RE_DAY.match(line):
            continue
        m = RE_MSG.match(line)
        if m:
            y, mo, d, ampm, hh, mm, sep, rest = m.groups()
            h24 = to_24h(ampm, hh)
            iso = f"{int(y):04d}-{int(mo):02d}-{int(d):02d}T{h24:02d}:{int(mm):02d}"
            if sep == ",":
                if " : " in rest:
                    sender, text = rest.split(" : ", 1)
                else:
                    sender, text = "", rest
                is_sys = 0
            else:
                sender, text = "", rest
                is_sys = 1
            cur = [iso, sender.strip(), text.rstrip(), is_sys]
            msgs.append(cur)
        else:
            if cur is not None and line.strip():
                cur[2] = (cur[2] + "\n" + line).rstrip()
    return msgs


def parse_messages_whatsapp(lines):
    msgs = []
    cur = None
    for raw in lines:
        line = raw.replace("‎", "").replace("‏", "")
        if RE_SKIP.match(line) or RE_DAY.match(line):
            continue
        iso = None
        m = RE_WA_SLASH.match(line)
        if m:
            yy, mo, d, ampm, hh, mm, rest = m.groups()
            iso = f"{2000 + int(yy):04d}-{int(mo):02d}-{int(d):02d}T{to_24h(ampm, hh):02d}:{int(mm):02d}"
        else:
            m = RE_WA_DOT.match(line)
            if m:
                y, mo, d, ampm, hh, mm, _ss, rest = m.groups()
                iso = f"{int(y):04d}-{int(mo):02d}-{int(d):02d}T{to_24h(ampm, hh):02d}:{int(mm):02d}"
        if iso is not None:
            sender, text, is_sys = "", rest, 1
            if ": " in rest:
                head, tail = rest.split(": ", 1)
                if head and len(head) <= 40 and "\n" not in head:
                    sender, text, is_sys = head.strip(), tail, 0
            cur = [iso, sender, text.rstrip(), is_sys]
            msgs.append(cur)
        else:
            if cur is not None and line.strip():
                cur[2] = (cur[2] + "\n" + line).rstrip()
    return msgs


PARSERS = {"kakao": parse_messages, "whatsapp": parse_messages_whatsapp}


# ---------------------------------------------------------------------------
# 방 판별 (260807_카톡_수집분류_v1.3.py 와 같은 규칙)
# ---------------------------------------------------------------------------
def load_rules():
    raw = os.environ.get("KAKAO_ROOM_RULES", "").strip()
    if not raw:
        return DEFAULT_RULES
    cfg = json.loads(raw)
    rules = cfg["rules"] if isinstance(cfg, dict) else cfg
    unknown = sorted({r["folder"] for r in rules} - set(ROOM_INFO))
    if unknown:
        log(f"⚠️  매핑에 빌드 대상이 아닌 폴더가 있어 무시됨: {', '.join(unknown)}")
    return rules


def identify_folder(text, rules):
    if not text:
        return None
    low = text.lower()
    for rule in rules:
        for kw in rule["keywords"]:
            if kw.lower() in low:
                return rule["folder"] if rule["folder"] in ROOM_INFO else None
    return None


def room_from_filename(fname):
    stem = Path(fname).stem
    for rx in (RE_FILENAME_ROOM, RE_WA_FILENAME_ROOM):
        m = rx.match(stem)
        if m:
            return m.group(1).strip()
    return None


def folder_from_filename(fname, rules):
    return identify_folder(room_from_filename(fname), rules) or identify_folder(fname, rules)


def folder_from_text(text, rules):
    first = text.split("\n", 1)[0].strip().lstrip("﻿")
    m = RE_FIRSTLINE_ROOM.match(first)
    return identify_folder(m.group(1).strip() if m else first, rules)


# ---------------------------------------------------------------------------
# 암호화 (index.html decryptEnc 와 같은 형식: base64(salt16 | iv12 | ciphertext+tag))
# ---------------------------------------------------------------------------
def _derive_key(password, salt):
    import hashlib
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITER, dklen=32)


def decrypt_payload(b64, password):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    raw = base64.b64decode(b64)
    salt, iv, ct = raw[:16], raw[16:28], raw[28:]
    pt = AESGCM(_derive_key(password, salt)).decrypt(iv, ct, None)
    return json.loads(pt.decode("utf-8"))


def encrypt_payload(obj, password):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    salt, iv = os.urandom(16), os.urandom(12)
    pt = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ct = AESGCM(_derive_key(password, salt)).encrypt(iv, pt, None)
    return base64.b64encode(salt + iv + ct).decode("ascii")


RE_ENC = re.compile(r'window\.ISSUE_ENC\s*=\s*"([A-Za-z0-9+/=]+)"')


def read_enc_file(path):
    m = RE_ENC.search(Path(path).read_text(encoding="utf-8"))
    if not m:
        raise SystemExit(f"❌ {path} 에서 window.ISSUE_ENC 를 찾지 못했습니다.")
    return m.group(1)


def write_enc_file(path, b64):
    Path(path).write_text(f'window.ISSUE_ENC="{b64}";\n', encoding="utf-8")


# ---------------------------------------------------------------------------
# 누적 병합: 기존 메시지 뒤에 새 메시지만 이어붙인다.
# 같은 (시각, 발신자, 본문, 시스템) 메시지가 한 내보내기에 여러 번 있으면 그 횟수만큼 유지한다.
# ---------------------------------------------------------------------------
def merge_room(existing, new_msgs):
    have = Counter(tuple(m) for m in existing)
    seen = Counter()
    added = []
    for m in new_msgs:
        k = tuple(m)
        seen[k] += 1
        if seen[k] > have[k]:
            have[k] += 1
            added.append(list(m))
    return existing + added, len(added)


def merge_export(payload, folder, text):
    info = ROOM_INFO[folder]
    msgs = PARSERS[info["source"]](text.splitlines())
    rooms = payload.setdefault("rooms", [])
    room = next((r for r in rooms if r.get("folder") == folder), None)
    if room is None:
        room = {"folder": folder, "room": info["room"], "convert": info["convert"], "msgs": []}
        rooms.append(room)
    room["msgs"], added = merge_room(room.get("msgs") or [], msgs)
    return len(msgs), added


# ---------------------------------------------------------------------------
# Gmail
# ---------------------------------------------------------------------------
def gmail_service():
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

    raw = os.environ.get("GMAIL_TOKEN_JSON", "").strip()
    if not raw:
        raise SystemExit("❌ GMAIL_TOKEN_JSON Secret 이 비어 있습니다.")
    creds = Credentials.from_authorized_user_info(json.loads(raw), GMAIL_SCOPES)
    if not creds.valid:
        if not creds.refresh_token:
            raise SystemExit("❌ token_gmail.json 에 refresh_token 이 없습니다. PC에서 다시 인증해 주세요.")
        try:
            creds.refresh(Request())
        except Exception as e:  # 토큰 만료/취소
            raise SystemExit(f"❌ Gmail 토큰 갱신 실패({type(e).__name__}). PC에서 재인증 후 Secret 을 갱신해 주세요.")
    return build("gmail", "v1", credentials=creds, cache_discovery=False)


def _walk_parts(part):
    yield part
    for p in part.get("parts") or []:
        yield from _walk_parts(p)


def iter_exports(service, days, rules):
    """(folder, txt 내용) 을 오래된 메일부터 내보낸다."""
    q = f"{GMAIL_QUERY} newer_than:{days}d"
    ids, token = [], None
    while True:
        res = service.users().messages().list(userId="me", q=q, maxResults=100, pageToken=token).execute()
        ids += [m["id"] for m in res.get("messages", [])]
        token = res.get("nextPageToken")
        if not token or len(ids) >= 500:
            break
    log(f"최근 {days}일 내보내기 메일 {len(ids)}건")
    skipped = 0
    for mid in reversed(ids):  # 목록은 최신순 → 오래된 것부터 병합
        msg = service.users().messages().get(userId="me", id=mid).execute()
        for part in _walk_parts(msg.get("payload", {})):
            fname = part.get("filename") or ""
            att_id = (part.get("body") or {}).get("attachmentId")
            if not fname.lower().endswith(".zip") or not att_id:
                continue
            folder = folder_from_filename(fname, rules)
            att = service.users().messages().attachments().get(userId="me", messageId=mid, id=att_id).execute()
            data = base64.urlsafe_b64decode(att["data"])
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                for name in z.namelist():
                    if not name.lower().endswith(".txt"):
                        continue
                    text = z.read(name).decode("utf-8-sig", errors="ignore")
                    f = folder or folder_from_text(text, rules)
                    if not f:
                        skipped += 1
                        continue
                    yield f, text
    if skipped:
        log(f"대상 방이 아닌 대화 {skipped}건 건너뜀")


# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--enc", required=True, help="사이트의 _issues_data.enc.js 경로 (읽고 덮어씀)")
    ap.add_argument("--days", type=int, default=3, help="최근 며칠 메일을 볼지")
    args = ap.parse_args()

    password = os.environ.get("ISSUE_PASSWORD", "")
    if not password:
        raise SystemExit("❌ ISSUE_PASSWORD Secret 이 비어 있습니다.")

    try:
        payload = decrypt_payload(read_enc_file(args.enc), password)
    except SystemExit:
        raise
    except Exception:
        raise SystemExit("❌ 기존 암호문을 풀지 못했습니다. ISSUE_PASSWORD 가 사이트 팀 암호와 같은지 확인해 주세요.")
    before = {r["folder"]: len(r.get("msgs") or []) for r in payload.get("rooms", [])}
    log("기존 데이터: " + ", ".join(f"{k} {v}" for k, v in before.items()))

    rules = load_rules()
    added_by = Counter()
    for folder, text in iter_exports(gmail_service(), args.days, rules):
        parsed, added = merge_export(payload, folder, text)
        added_by[folder] += added
        log(f"{folder}: 내보내기 {parsed}개 중 새 메시지 {added}개")

    total_added = sum(added_by.values())
    changed = total_added > 0
    if changed:
        payload["generated"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        write_enc_file(args.enc, encrypt_payload(payload, password))
        log(f"완료: 새 메시지 {total_added}개 반영, 암호문 갱신")
    else:
        log("새 메시지 없음 → 파일 변경 안 함")

    gh_out = os.environ.get("GITHUB_OUTPUT")
    if gh_out:
        with open(gh_out, "a", encoding="utf-8") as f:
            f.write(f"changed={'true' if changed else 'false'}\nadded={total_added}\n")


if __name__ == "__main__":
    main()

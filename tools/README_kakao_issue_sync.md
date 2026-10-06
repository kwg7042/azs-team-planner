# 카톡이슈 자동 갱신 (GitHub Actions)

`.github/workflows/kakao-issue-sync.yml` 이 매일 한국시간 09:00에
`tools/kakao_issue_sync.py` 를 실행해 Gmail의 카톡/WhatsApp 내보내기 메일을 읽고
gh-pages 의 `_issues_data.enc.js` 에 새 메시지만 이어붙여 다시 암호화합니다. PC가 꺼져 있어도 됩니다.

## Secrets (Settings → Secrets and variables → Actions → New repository secret)

| 이름 | 값 |
|---|---|
| `GMAIL_TOKEN_JSON` | PC 스크립트 폴더의 `token_gmail.json` 파일 내용 전체 |
| `ISSUE_PASSWORD` | 카톡이슈 탭 팀 암호 (지금 사이트 암호문을 푸는 암호) |
| `KAKAO_ROOM_RULES` | (선택) `방_폴더_매핑.json` 파일 내용 전체. 없으면 스크립트의 기본 키워드 사용 |

- Google Cloud Console → OAuth 동의 화면이 **테스트** 상태면 refresh token 이 7일마다 만료됩니다. **프로덕션으로 게시**해 두세요.
- 처음 한 번은 Actions → 카톡이슈 데이터 갱신 → Run workflow 에서 days 를 30으로 실행하면 그동안 쌓인 메일을 반영합니다.
- 평문 대화는 저장소·로그 어디에도 남지 않습니다(로그에는 폴더명과 건수만).

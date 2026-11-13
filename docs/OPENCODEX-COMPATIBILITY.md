# OpenCodex 2.100.2 호환과 텔레메트리

이 저장소의 재현용 기준은 OpenCodex `2.100.2`, Bun `1.4.4`입니다. 기존 설치의 다른 제품 버전은 선택 업데이트에서 유지합니다.

## 익명 제품 텔레메트리 끄기

이미지 기본 환경과 `stack`의 Podman 실행 인자, 감독 프로세스의 자식 환경에 아래 값을 적용합니다.

```text
OCX_TELEMETRY=0
DO_NOT_TRACK=1
CAVEMAN_TELEMETRY=0
```

이 개인용 스택에서는 제품 텔레메트리를 항상 끕니다. `.env`나 OpenCodex 화면에 동의가 저장돼 있어도 다시 켜지지 않습니다.
새 이미지 적용을 위한 컨테이너 재생성이 필요하며, 이미 실행 중인 프로세스에는 소스 파일 변경만으로 반영되지 않습니다.
동의 안내를 수락하거나 동의 기록을 조작하지 않습니다. OpenCodex의 공식 환경변수 opt-out이 안내와 전송을 차단합니다.

이 설정은 OpenCodex/Caveman의 선택적 제품 텔레메트리에 대한 정책입니다. 모델 제공자 API 호출,
로컬 사용량 통계·CCR 원문 복구·모델 요청에 필요한 메타데이터는 별도 기능입니다.

## 헤더와 메타데이터

- Caveman compat 경로에서 `session_id`, `session-id`, `thread-id`, `x-client-request-id`, `version`, `x-codex-app-version`과 기존 turn·subagent 메타데이터를 전달합니다.
- `client_metadata` 본문과 `x-reasoning-included`, `x-codex-turn-state`, 사용량·재시도 응답 헤더를 보존합니다. OpenCodex가 생성한 turn-state handle을 원본 토큰으로 되돌리지 않습니다.
- 서버 인증 모드에서는 클라이언트 OAuth/API 키·계정 헤더와 `x-oai-attestation`, `x-openai-agent-assertion`을 브릿지와 게이트웨이에서 제거합니다.
- Pool의 installation ID 분리와 최종 모델·서비스 등급에 따른 routing hint 생성은 OpenCodex가 수행합니다. 스택에서 재작성하거나 무작위 ID를 추가하지 않습니다.
- Caveman 4.0.1이 금지한 `user-agent`는 compat allowlist에 추가하지 않습니다. 무조건적인 헤더 전체 전달도 설정하지 않습니다.

검증 근거: [2.100.2 릴리스](https://github.com/lidge-jun/opencodex/releases/tag/v2.100.2),
[Codex 전송 계약](https://github.com/lidge-jun/opencodex/blob/v2.100.2/src/codex/forward-transport-headers.ts),
[텔레메트리 환경변수 우선순위](https://github.com/lidge-jun/opencodex/blob/v2.100.2/src/telemetry/consent.ts).

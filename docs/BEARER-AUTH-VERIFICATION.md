# 기본 openai provider의 서버 접속 키 검증

검증일: 2026-10-06. Windows Desktop 내장 `codex-cli 0.160.0`을 사용했습니다.

## 결론

기본 `openai` provider에서 API 키 로그인으로 서버 전용 접속 키를 보내고,
서버가 자신의 모델 인증으로 교체하는 연결은 동작했습니다. 로컬 브리지는 사용하지 않았습니다.
하지만 같은 API 키 로그인에서 `remoteControl/enable`은 아래 오류로 거부됐습니다.

```text
remote control requires ChatGPT authentication; API key auth is not supported
```

따라서 이 방식을 Android Remote까지 유지하는 기존 구성의 대체재로 배포하지 않습니다.
로컬 추론 성공과 ChatGPT Remote 사용 가능 여부는 별개입니다.

## 검증 환경과 범위

- 별도 임시 Podman 컨테이너에서 HTTPS 접속 키 검증과 서버 인증 교체를 수행했습니다.
- HTTPS는 전용 테스트 CA와 IP SAN을 가진 서버 인증서를 사용했고, 클라이언트에 해당 CA만 명시적으로 전달했습니다. 인증서 검증을 끄지 않았습니다.
- 임시 방화벽 규칙은 테스트 PC 하나만 허용했습니다. 인터넷 공개나 공인 인증서 배포 테스트는 아닙니다.
- 서버의 기존 Codex 로그인 파일을 읽기 전용으로 마운트했습니다. 새 디바이스 로그인이나 계정 풀 등록은 수행하지 않았습니다.
- 검증용 서버가 인증을 교체한 뒤 기존 Caveman/OpenCodex 경로로 전달했습니다. 완전히 독립된 사용자 스택의 설치 검증은 아닙니다.
- 클라이언트는 별도 Codex 홈에서 `login --with-api-key`를 실행했습니다. 이 홈에는 테스트 접속 키만 있고 ChatGPT 토큰은 없었습니다.
- 실제 Desktop 창의 로그인을 바꾸지 않았습니다. Desktop 내장 CLI와 app-server 프로토콜을 검증했으며 Android UI 조작은 하지 않았습니다.

## 결과

| 항목 | 결과 |
|---|---|
| 접속 키 누락 / 오입력 | 모두 HTTP 401 |
| 올바른 접속 키 | HTTP 200 |
| 기본 provider | `openai` |
| 모델 호출 | 실제 응답 성공, `BEARER_DIRECT_OK` 확인 |
| 서버 인증 교체 | 클라이언트 계정 헤더 없이 서버 저장 계정으로 요청, upstream HTTP 200 |
| 저장된 세션 조회 | provider 필터 기본값, source `exec` 지정으로 조회 성공 |
| 세션 재개 | app-server `thread/resume` 성공, provider `openai` 유지 |
| 계정 종류 조회 | `apiKey` |
| Remote 활성화 | 오류 -32600, ChatGPT 인증 요구 |
| 운영 Windows 로그인·설정 | 전후 SHA-256 동일 |

초기 테스트의 단일 self-signed CA 인증서는 모델 요청 연결에 실패했습니다.
테스트 CA와 `CA:FALSE` 서버 인증서를 분리한 후 같은 설정에서 호출이 성공했습니다.
또한 ephemeral Remote 시작에서 잠깐 `connecting`이 반환된 것은 연결 성공으로 계산하지 않았습니다.
일반 Remote 활성화의 명시적 인증 오류를 판정 근거로 사용했습니다.

검증 후 임시 컨테이너·포트·방화벽 규칙·접속 키·서버 인증서 개인키를 제거했습니다.
기존 Podman 모델 서비스와 클라이언트 연결은 유지했습니다.

## 설계에 미치는 영향

- API 키 방식은 로컬 모델 요청용 선택 모드로 검토할 수 있지만 Remote 호환 모드라고 표시하면 안 됩니다.
- Remote가 필수라면 클라이언트의 ChatGPT 로그인과 서버 접속 인증을 동시에 유지하는 별도 방식을 검증해야 합니다.
- 사용자가 보낸 계정 ID 헤더만으로 권한을 부여하거나, 서버 접속 키를 모델 서비스로 그대로 전달하면 안 됩니다.

[공식 인증 문서](https://learn.chatgpt.com/docs/auth)도 API 키 로그인과 ChatGPT 계정 기반 원격/클라우드 기능의 범위를 구분합니다.

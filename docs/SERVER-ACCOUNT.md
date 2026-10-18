# 서버 메인 계정으로 인증

클라이언트의 OpenAI 토큰을 보내지 않고, 서버에 로그인한 본인 계정으로 모델을 사용할 수 있습니다.
서버 접속용 `x-caveman-gateway-key`는 계속 필수입니다. 배포 하나는 사용자 한 명의 기기들만 공유합니다.

Caveman의 로컬 압축에는 Caveman 계정 로그인이 필요하지 않습니다. 다만 기본 프록시는 호출자가 보낸
모델 제공자 인증을 전달할 수 있습니다. 이 스택의 `server` 모드는 그 인증을 Caveman 앞에서 제거하고,
OpenCodex가 저장된 서버 계정으로 인증하도록 구성한 방식입니다. 게이트웨이 접속 인증과 모델 인증은 별개입니다.
참고: [Caveman 로컬 기능과 계정](https://github.com/JuliusBrussee/caveman/blob/main/docs/technical/product-model.md),
[제공자 인증](https://github.com/JuliusBrussee/caveman/blob/main/docs/technical/provider-authentication.md).

```text
클라이언트 → 게이트웨이 키 → Caveman(모델 인증 없음)
          → OpenCodex(서버 메인 계정 인증 추가) → 모델
```

## 최초 메인 로그인

서버 저장소에서 실행하고 표시된 디바이스 코드를 본인 브라우저에서 승인합니다.

```bash
./stack codex login --device-auth
./stack codex login status
```

인증은 컨테이너 `/state/codex/auth.json`, 호스트 `data/state/codex/auth.json`에 저장됩니다.
OpenCodex 웹의 풀 계정 추가와는 별개입니다. 2.88.0의 메인 계정 재인증 버튼은 기존 메인 로그인과
같은 계정으로 갱신하는 기능이므로, 인증이 없으면 `native_main_unavailable`을 반환합니다.
현재 로그인을 프로필로 저장하는 기능도 이미 존재하는 로그인을 보관하는 기능입니다.

로그인 후 OpenCodex 관리 화면에서 **메인 계정**을 선택합니다. 선택은 우선 사용을 뜻하며,
다른 풀 계정도 등록돼 있다면 사용량·오류 정책에 따라 전환될 수 있습니다.

## 게이트웨이에서 클라이언트 인증 제거

이 기능이 포함된 소스를 빌드해 배포하고 `.env`를 다음과 같이 설정합니다.

```dotenv
CLIENT_AUTH_MODE=server
```

OpenCodex의 계정 선택 모드는 `pool`을 유지합니다.

```bash
./stack account-mode pool
```

이때 사용하는 계정이 네이티브 **메인 계정**이어도 `pool`은 요청의 계정 선택 방식입니다.
현재 연결의 내부 OpenCodex 포트는 무인증 loopback 수신기이므로 `direct`로 바꾸면
헤더가 없는 요청에서 서버 메인 인증을 대신 쓰지 못할 수 있습니다.

설정만 변경할 때는 기존 `./stack down` / `./stack up` 절차를 사용합니다. 소스 변경이 있으면
이미지도 갱신해야 하며, `./stack update`는 저장소의 고정 패키지 버전을 사용하므로 현재 실행 버전과
맞는 manifest를 준비하세요. 변경 전에 백업하고 작업 중인 요청이 없는 시점에 전환합니다.

`server`에서는 Authorization, ChatGPT 계정 ID, API 키, 조직·프로젝트, 쿠키 헤더를
Caveman과 이미지·검색·compact 우회 경로 모두에서 제거합니다. OpenCodex가 모델 전송 직전에
서버 인증을 선택합니다. `forward`는 기존 전달 방식이며 누락 시 기본값입니다.
알 수 없는 값은 시작 오류로 처리합니다. 인증된 `/v1/stack-info`의 `clientAuthMode`로 확인합니다.

## 클라이언트에서도 인증 전송 끄기

게이트웨이의 제거 기능은 Caveman 이후를 보호합니다. 클라이언트에서 게이트웨이까지도 OpenAI 토큰을
보내지 않으려면 아래 중 현재 제공자 방식에 맞는 설정을 적용합니다.

### 기본 openai 제공자와 native bridge

이 버전의 native bridge를 설치하고 해당 클라이언트의
`<CODEX_HOME>/caveman-stack/native-bridge.json`에 다음 필드를 추가합니다.

```json
{"clientAuthMode":"server"}
```

위 내용으로 파일 전체를 교체하지 말고 기존 주소·키 경로·포트 등의 필드와 함께 저장합니다.
설정은 다음 요청부터 읽습니다. 이전 버전 브리지라면 설치기를 다시 실행해 코드를 갱신해야 합니다.
설치기는 기존 `clientAuthMode`를 보존합니다. `/healthz`의 `clientAuthMode`가 `server`인지 확인합니다.

Windows PowerShell에서는 기본 Codex 홈 기준으로 다음과 같이 설정을 보존해 수정할 수 있습니다.

```powershell
$bridgeFile = Join-Path $env:USERPROFILE '.codex\caveman-stack\native-bridge.json'
Copy-Item -LiteralPath $bridgeFile -Destination ($bridgeFile + '.backup')
$bridgeConfig = Get-Content -LiteralPath $bridgeFile -Raw | ConvertFrom-Json
$bridgeConfig | Add-Member -NotePropertyName clientAuthMode -NotePropertyValue server -Force
[System.IO.File]::WriteAllText($bridgeFile, ($bridgeConfig | ConvertTo-Json -Depth 20), [System.Text.UTF8Encoding]::new($false))
```

이 방식은 로컬 Codex의 ChatGPT 로그인 파일을 삭제하지 않습니다. Remote 등 기본 제공자의 로그인 기반
기능은 로컬 상태를 유지하고, 브리지가 모델 요청의 인증 헤더를 LAN으로 보내기 전에 제거합니다.

### 사용자 정의 제공자

새 CLI 옵션은 로컬 OpenAI 로그인 없이 모델 요청을 보내는 사용자 정의 제공자를 설정합니다.
아래 경로와 서버 주소는 실제 설치 위치로 바꿉니다.

```bash
node scripts/client.mjs configure \
  --provider caveman_stack --client-auth-mode server \
  --url https://SERVER:18787/v1 --key-file /absolute/private/gateway-key \
  --codex-home /absolute/codex-home
```

선택한 제공자의 `requires_openai_auth=false`를 저장하고 기존 인증 override를 제거합니다.
다른 제공자와 로그인 파일은 유지합니다. 재설정 시 옵션을 생략해도 기존 `server` 선택이 보존됩니다.
`--auth-file`과 함께 사용하지 않습니다. 기본 `openai` 제공자는 이 옵션 대신 위 브리지 설정을 사용합니다.
사용자 정의 제공자에서 Desktop·Remote·내장 도구 전체의 동작까지 보장하는 설정은 아닙니다.

## 검증과 복구

다음 검사는 서버 계정만으로 합성 입력의 스트리밍·압축·정확한 원문 복구를 검증합니다.

```bash
python3 scripts/smoke.py --url https://SERVER:18787/v1 \
  --key-file /absolute/private/gateway-key --server-account \
  --state-dir /absolute/stack/data/state --mcp
```

게이트웨이 로그에는 헤더 값 대신 `client_auth_mode`, `forwarded_authorization_present`,
`forwarded_account_id_present`만 추가 기록합니다. `server`에서는 두 전달 여부가 모두 false여야 합니다.
원복은 게이트웨이 `.env`와 각 브리지 JSON을 `forward`로 돌리고 게이트웨이를 재시작합니다.
사용자 정의 제공자는 `reconfigure --client-auth-mode forward` 후 Codex를 재시작합니다.
이 작업은 서버에 저장된 메인 로그인을 로그아웃시키지 않습니다.

2026-10-18 UTC 서버 검증: 실제 네이티브 메인 로그인, 게이트웨이 `server` 모드,
Linux native bridge의 인증 제거를 확인했습니다. OpenAI 로그인 파일이 없는 별도 Codex CLI가
게이트웨이 키만으로 응답했고, 합성 입력의 SSE·압축·HTTP MCP 원문 복구(66,392바이트)가 통과했습니다.
브리지에 넣은 가짜 인증 헤더는 LAN 게이트웨이에 도달하기 전에 제거됐습니다.
Windows 실제 앱과 ImageGen은 이 변경 후 별도로 실행하지 않았습니다.

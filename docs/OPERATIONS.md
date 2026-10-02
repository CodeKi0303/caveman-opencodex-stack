# 운영

## 재부팅 시 시작

일반 사용자 systemd 예시입니다. `/absolute/path`를 clone 위치로 교체합니다.
`~/.config/systemd/user/caveman-stack.service`:

```ini
[Unit]
Description=Caveman OpenCodex Podman stack
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/absolute/path/caveman-podman
ExecStart=/absolute/path/caveman-podman/stack up
ExecStop=/absolute/path/caveman-podman/stack down
TimeoutStartSec=120
TimeoutStopSec=60

[Install]
WantedBy=default.target
```

최초 `stack build` 후 기존 수동 실행 컨테이너를 `./stack down`으로 종료한 뒤:

```bash
systemctl --user daemon-reload
systemctl --user enable --now caveman-stack.service
```

로그아웃 이후에도 시작되게 하려면 시스템 관리자가 `loginctl enable-linger <사용자>`를 설정합니다.
이 oneshot unit은 부팅 시작/정지를 제공합니다. 컨테이너 crash의 자동 복구·알림은 포함하지 않습니다.
운영 감시가 필요한 조직은 자체 Podman Quadlet/모니터링 기준에 통합하세요.

## 클라이언트 카탈로그 자동 동기화

서버는 컨테이너의 카탈로그 작업이 시작 시와 기본 15분마다 OpenCodex 목록을 읽습니다.
`.env`의 `CATALOG_REFRESH_SECONDS`로 주기를 변경합니다(기본 `900`, 최소 `60`).
조회·검증 실패 시 마지막 정상 파일을 유지하고 최대 30초 후 재시도하며, 내용이 같으면 다시 쓰지 않습니다.
즉시 갱신은 `./stack catalog`입니다. 서버용 cron/systemd 타이머를 추가할 필요가 없습니다.

클라이언트는 `configure`로 최초 연결한 뒤, 사용하는 **각 Codex 홈**에 별도 예약을 설치합니다:

```bash
node scripts/schedule.mjs install --url http://192.168.50.61:18787/v1 --key-file /absolute/path/gateway-key --codex-home /absolute/path/.codex
node scripts/schedule.mjs status --codex-home /absolute/path/.codex
node scripts/schedule.mjs remove --codex-home /absolute/path/.codex
```

경로에 공백이 있으면 쉘에 맞게 따옴표로 감쌉니다. 예약 명령줄에는 비밀 키 값이 아닌 파일 경로만 들어갑니다.
`--interval-minutes`는 기본 `15`이며, 60의 양의 약수인 분 단위를 지원합니다(예: `5`, `10`, `15`, `30`, `60`).
같은 Codex 홈으로 `install`을 다시 실행하면 주소·키 경로·주기를 갱신합니다. 예약 이름에는 홈 경로의 해시가 포함되어 중복 생성을 피합니다.
설치·삭제는 명시적인 명령에서만 실행하며 테스트와 모듈 import는 예약을 만들지 않습니다.

| 환경 | 실행 방식 | 동작 조건 |
|---|---|---|
| Windows | 현재 사용자, 제한 권한 Scheduled Task; PowerShell `-WindowStyle Hidden` | 사용자 로그인 시 + 주기 실행. 관리자·SYSTEM·사용자 암호를 사용하지 않습니다. |
| Linux/WSL | `~/.config/systemd/user/` 아래 service/timer (`XDG_CONFIG_HOME` 지원) | 사용자 systemd 시작 시 + 달력 기반 주기, `Persistent=true`로 중단 중 지난 예약을 시작 후 보충합니다. |

Windows에서는 로그인한 사용자 세션이 필요합니다. Linux에서는 실행 중인 사용자 systemd 관리자가 필요합니다.
WSL은 systemd가 활성화된 배포판에서 등록하세요. WSL이 꺼진 동안에는 실행되지 않으며,
Windows의 예약이 WSL 배포판을 자동으로 부팅하지는 않습니다. 로그아웃 중에도 Linux 사용자 서비스를 유지하려면
관리자가 해당 사용자에 대한 linger를 별도로 설정해야 합니다.

동기화는 셸 초기화 파일을 읽지 않고 절대 경로의 Node와 `scripts/client.mjs sync`를 실행합니다.
회사 프록시·추가 CA 환경변수는 예약 작업/사용자 systemd 환경에도 전달되어야 합니다.
저장소·Node·키 파일의 경로를 옮기면 `install`을 다시 실행하세요.

설치 기록은 `<CODEX_HOME>/caveman-sync-schedule/config.json`, 마지막 실행 시각·종료 코드·출력은
같은 디렉터리의 `last-run.json`에 기록합니다. 이 로그는 매번 교체되어 누적되지 않습니다.
`status`는 Windows 예약 상태/최근 결과 또는 systemd 활성 상태/다음 실행 시간을 보여줍니다.
`remove`는 이 도구가 소유한 예약과 기록만 제거하고 Codex 설정·카탈로그·키 파일을 유지합니다.

`sync`는 ETag로 변경 여부를 확인하고 내용이 같으면 설정·캐시·백업을 다시 쓰지 않습니다.
기존 주소·키·MCP가 잘못되어도 자동 동기화는 연결 설정을 바꾸지 않습니다. 이 경우 다음을 실행합니다:

```bash
node scripts/client.mjs reconfigure --url http://192.168.50.61:18787/v1 --key-file /absolute/path/gateway-key --codex-home /absolute/path/.codex
node scripts/client.mjs doctor --url http://192.168.50.61:18787/v1 --key-file /absolute/path/gateway-key --codex-home /absolute/path/.codex
```

`reconfigure`는 현재 선택된 기존 provider를 수정합니다. 다른 항목을 수정하려면 `--provider ID`를 추가하며,
그 경우 현재 provider 선택은 그대로 유지됩니다. `doctor`는 파일을 수정하지 않고 로그인 메타데이터·카탈로그·MCP 연결을 확인합니다.

`model_catalog_json`은 HTTP URL이 아닌 **로컬 JSON 파일 경로**이며 Codex 시작 시 읽습니다.
자동 다운로드 후에도 실행 중인 Codex 앱/CLI의 카탈로그가 바뀌었다고 보장할 수 없습니다.
새 모델을 사용할 때 Codex를 완전히 재시작하세요. Windows와 WSL은 각각의 홈·프로세스를 확인합니다.
근거: [OpenAI 설정 레퍼런스](https://developers.openai.com/codex/config-reference/).

## 원문 복구 MCP

`http://192.168.50.61:18787/mcp`는 Streamable HTTP MCP이며 `/v1/catalog`와 같은
`x-caveman-gateway-key` 헤더로 인증합니다. 모델용 ChatGPT 로그인과는 별도입니다.
`http_headers` 또는 `env_http_headers`를 사용하는 설정 예시는 [README](../README.md#6-원문-복구와-지원-범위)에 있습니다.
`configure`와 `reconfigure`는 `http_headers` 방식으로 복구 MCP를 함께 등록합니다.
MCP 연결을 저장한 후 Codex 연결을 재시작합니다. 서버에 별도 `native-main` 로그인은 필요하지 않습니다.
본인의 Windows/WSL 클라이언트는 같은 CCR DB를 공유하며 계정별 원문 격리를 제공하지 않습니다.

## 프록시와 인증 장애 구분

- TCP 연결 불가: 호스트 바인딩·Podman publish·회사/호스트 방화벽 확인.
- TLS 실패: 서버 인증서 SAN·CA 체인·클라이언트 trust store 확인.
- `Gateway key required`: 모델 로그인과 별개인 gateway key 확인.
- upstream 401: 사용자 Codex 로그인이나 OpenCodex 계정 상태 확인.
- 413: reverse proxy, gateway, Caveman, OpenCodex 각 본문 제한 확인.
- 모델이 안 보임: `stack catalog` → 클라이언트 `sync` 또는 예약 `status`/`last-run.json` 확인 → Desktop/CLI 완전 재시작.
- MCP 401: `/mcp` 주소와 `x-caveman-gateway-key` 헤더 확인. `Authorization`만 설정하면 게이트웨이 인증을 통과하지 못합니다.
- 카탈로그에 있어도 모델 호출 실패: 실제 계정 권한·제공자 지원·서비스 제한 확인.

게이트웨이는 요청 본문·키·Authorization·query를 기록하지 않습니다.
OpenCodex/Caveman 자체 로그·DB와 원문은 별도 민감 데이터입니다. 로그 전체를 공개 이슈에 붙이지 마세요.
기존 네이티브 설치 데이터를 자동 import하지 않으며 migration은 별도 백업과 검증 후 진행해야 합니다.

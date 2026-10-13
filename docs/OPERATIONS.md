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

## Git과 최신 안정 버전 업데이트

```bash
./stack git-update
```

작업 트리와 추적 브랜치를 확인하고 `git pull --ff-only` 후 새 소스의 업데이트 명령을 실행합니다.
미커밋 변경이 있으면 멈추며 자동 stash/reset을 하지 않습니다. 기존 운영 서버에 직접 수정한 파일이 있다면
먼저 백업·비교하고 Git에 통합하세요. `git pull`만으로 실행 서비스가 바뀌지는 않습니다.
이미 소스를 가져왔거나 의도한 미커밋 변경을 시험할 때는 `./stack update --latest`를 사용합니다.

최신 조회 대상은 `@caveman-ai/cli`, `@bitkyc08/opencodex`, 컨테이너의 `@openai/codex`입니다.
npm `latest`가 정확한 정식 버전일 때만 선택하며 프리릴리스는 거부합니다. SDK/TOML/Node 이미지는
저장소 고정 버전을 유지합니다. 임시 빌드 컨텍스트에 exact 버전과 lockfile을 생성하고 후보 검증 후 배포합니다.
실제 선택 버전, 소스 커밋, 변경 여부, 결과와 manifest는 `data/releases/<실행 ID>/`에 보관합니다.
원본 `package.json`은 유지되므로 실행 버전 확인에는 컨테이너 또는 release 기록을 사용합니다.
기존 `./stack update`는 현재 manifest 버전 그대로 배포하는 명령입니다.

최신 안정 버전도 호환성을 보장하지 않습니다. 상태/카탈로그 검사 후 실제 사용 모델·도구를 확인하고
문제가 있으면 백업으로 롤백합니다. 이 명령은 호스트의 Codex Desktop/CLI를 업그레이드하지 않으며
클라이언트 카탈로그 동기화는 여전히 수동입니다. 정기 업데이트 작업은 등록하지 않습니다.

### systemd 일회성 작업에서 컨테이너가 종료되는 문제

일부 Podman 버전은 `INVOCATION_ID`가 있는 systemd 작업에서 실행하면 conmon을 호출한 작업의
cgroup에 남깁니다. 업데이트 스크립트가 성공해도 작업 종료 시 conmon에 종료 신호가 전달될 수 있습니다.
이 프로젝트의 Podman 실행 래퍼는 `INVOCATION_ID`, `SYSTEMD_EXEC_PID`, `NOTIFY_SOCKET`을 자식 환경에서
제거합니다. systemd 작업에서 detached 컨테이너를 시작할 때는 별도 transient scope를 만들어
slirp4netns/rootlessport 같은 네트워크 보조 프로세스도 업데이트 작업과 분리합니다.
rootless 실행은 사용자 systemd manager를 사용하며, scope 생성에 실패하면 우회하지 않고 중단합니다.
AppArmor나 capability 제한을 해제하지 않습니다.
관련 upstream 보고: https://github.com/podman-container-tools/podman/issues/29582

2026-10-13 조사에서는 실제 모델 응답 성공 후 일회성 업데이트 작업 완료와 동시에 종료가 시작됐습니다.
격리 재현에서 기존 conmon은 업데이트 unit cgroup에 남았습니다. 환경 변수 제거만으로는 컨테이너가
살아도 포트 전달 프로세스가 종료되어 접속이 끊길 수 있었습니다. 별도 scope 적용 후에는 작업 완료
뒤에도 컨테이너와 HTTP 연결이 유지됐습니다. Caveman/OpenCodex 자체의 시작 실패와 구분합니다.

호스트 AppArmor의 중첩 crun 프로파일 간 신호 거부도 발견됐습니다. 기존 감독 코드는 이를 시작 실패로
잘못 표시한 뒤 반복 `kill EACCES`를 처리하지 못했습니다. 이제 시작/종료 오류와 종료 이유를 별도로 기록합니다.
이 방어 코드는 호스트 정책 자체를 변경하지 않으므로 신호 거부가 계속되면 호스트 Podman/crun/AppArmor
정책을 별도로 확인합니다. `systemctl is-active`가 oneshot의 `active`를 반환해도 실제 컨테이너 생존을
보장하지 않습니다. 업데이트 작업이 끝난 뒤 `podman ps`와 실제 API를 다시 확인하세요.

## Remote와 기본 openai 연결 운영

Remote를 사용하는 클라이언트는 [README의 브리지 설치 절차](../README.md#windows에서-기본-openai-provider-사용)를 따릅니다.
Windows는 로그인 예약 `Caveman Native OpenAI Bridge`, Linux/WSL은
`caveman-native-bridge.service`가 로컬 브리지를 유지합니다. 이 프로세스는 모델 요청을
전달하는 데 필요하며 주기적인 카탈로그 다운로드를 실행하지 않습니다.

- Windows: `Get-ScheduledTask -TaskName 'Caveman Native OpenAI Bridge'`로 실행 상태 확인.
- Linux root: `systemctl status caveman-native-bridge.service` 확인.
- Linux/WSL 사용자: `systemctl --user status caveman-native-bridge.service` 확인.
- 각 클라이언트: `client.mjs doctor --url <실제 게이트웨이 /v1 주소> --key-file <키 파일>`로 브리지·카탈로그·MCP 확인.

`openai_base_url`은 해당 PC의 loopback 브리지입니다. `--url`은 브리지가 가리키는
원격 게이트웨이 주소와 같아야 합니다. 서버 자체에서 실행하더라도 `BIND_ADDRESS`가 LAN IP라면
`127.0.0.1:18787`로 바꾸면 접속할 수 없습니다. Windows와 WSL 포트는 각각 18788/18789처럼 구분합니다.

브리지 업데이트는 Git 업데이트 후 해당 플랫폼 설치기를 다시 실행합니다. Linux는 런타임 복사본을
사용하므로 `git pull`만으로 실행 코드가 교체되지 않습니다. 설치 후 `doctor`를 확인합니다.
서버의 모델 처리 경로는 계속 Podman이며 클라이언트 브리지만 바뀌면 컨테이너 재빌드가 필요하지 않습니다.

기존 대화의 provider 변경은 설치·업데이트에 포함하지 않습니다. 세션 DB와 JSONL 기록, byte offset의
일관성이 필요한 별도 일회성 작업입니다. 이미 완료한 이력 변환을 재실행하지 말고 백업은 각 PC에 보관합니다.
Android 목록 표시는 앱에서 연결을 다시 열어 확인하며, `doctor` 성공만으로 목록 표시까지 보장하지 않습니다.

## 클라이언트 카탈로그 동기화

기본은 서버 기동·배포 시 갱신과 클라이언트 수동 다운로드입니다.
서버의 일회성 시작 작업은 실패 시 최대 3회 시도하고 종료합니다.
기존 정상 파일은 유지하며, 갱신 실패 때문에 실행 중인 모델 서비스 전체를 종료하지 않습니다.
`stack up/update`는 준비 상태 이후 카탈로그를 별도로 확인합니다.
서버 모델 설정을 바꾼 뒤에는 `./stack catalog`를 실행하세요.
`CATALOG_REFRESH_SECONDS`는 0.3.0부터 사용하지 않습니다.

최초 `configure` 또는 기존 연결의 `reconfigure`가 별도 `caveman-client.json`을 저장합니다.
이 파일은 예약 설정과 독립적이며 URL·키 파일 경로·Codex 홈·Node 실행 경로만 포함합니다.

```bash
node scripts/client.mjs reconfigure --url http://192.168.50.61:18787/v1 --key-file /absolute/path/gateway-key --codex-home /absolute/path/.codex
npm run sync -- --codex-home /absolute/path/.codex
node scripts/schedule.mjs remove --codex-home /absolute/path/.codex
```

위 순서로 기존 Windows 작업 및 Linux/WSL 사용자 타이머를 전환합니다.
예약 제거는 Codex 설정·로그인·카탈로그·키·수동 설정을 지우지 않습니다.
예약을 제거해도 다른 사용자 서비스가 사용할 수 있는 systemd linger 설정은 변경하지 않습니다.

Windows의 `Sync-Catalog.vbs`는 숨김 PowerShell로 GUI를 열어 즉시 한 번 동기화합니다.
`지금 동기화`로 재시도할 수 있고, 결과를 확인한 뒤 창을 닫습니다. 실행 중에는 중복 버튼 입력과
창 닫기를 제한하며, 네트워크 요청에 제한 시간을 적용합니다. GUI는 Windows 홈만 대상으로 합니다.
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-shortcut.ps1`로 바탕화면 바로가기를 만듭니다.
콘솔에서는 `npm run sync`, Node만 설치된 환경에서는 `node scripts/manual-sync.mjs`를 사용합니다.

변경 없는 동기화는 ETag/304를 사용하며 파일·캐시·백업을 다시 쓰지 않습니다.
네트워크·인증·검증 실패 시 마지막 정상 파일을 보존합니다. 실행 중인 Codex가 새 목록을
다시 읽도록 변경이 있을 때만 재시작을 안내하며, 앱을 자동으로 종료하지 않습니다.

명시적으로 자동 다운로드를 원하는 사용자에게만 기존 `schedule.mjs install/status/remove`를 제공합니다.
설치 시 `--url`, `--key-file`, `--codex-home`을 지정하고 필요하면 `--interval-minutes`를 설정합니다.
이 선택 기능은 기본 15분, Windows 사용자 예약 또는 Linux/WSL 사용자 systemd 타이머를 사용합니다.
WSL 종료 중에는 실행되지 않습니다. 기본 배포 절차에서는 이 기능을 호출하지 않습니다.

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

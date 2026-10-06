# caveman-opencodex-stack

Linux에서 **Codex → 게이트웨이 → Caveman 압축 프록시 → OpenCodex → 선택한 제공자의 모델**을 실행하는 배포 저장소입니다.
Caveman이 요청의 압축 가능한 입력(예: 긴 도구 결과)을 줄여 OpenCodex로 전달하고,
OpenCodex는 설정된 제공자·모델 정책에 따라 해당 모델 API로 요청을 전달합니다.
모든 입력이 압축되는 것은 아니며 압축 조건에 맞지 않는 내용은 유지합니다.
호스트에는 **Podman 5+, slirp4netns, Python 3.11+, Git**이 필요합니다. 클라이언트 설정 도구는 Node.js 22.13+를 사용하며, 환경변수 기반 회사 프록시를 쓰는 클라이언트는 Node.js 24.14+를 권장합니다.
Windows/WSL Codex는 HTTP(S)로 접속하므로 작업 파일과 도구 실행은 각 PC에 남습니다.
개인 사용 기준으로 본인의 여러 클라이언트가 같은 게이트웨이와 압축 원문 DB를 공유합니다.

```text
Windows / WSL / Linux Codex (각자의 로그인)
    │ 게이트웨이 키 + 기존 모델 인증
    ▼
호스트 <서버 LAN IP>:18787 (기본 LAN 공개, TLS 설정 가능)
    │ Podman 컨테이너 내부 :8080
    ├─ POST /v1/responses → Caveman :8787 [입력 압축] → OpenCodex :10101
    ├─ 이미지·검색·compact → OpenCodex :10101
    ├─ GET /v1/models → OpenCodex :10101
    ├─ GET /v1/catalog → 공통 카탈로그 파일 (ETag)
    └─ /mcp → Caveman 원문 복구 도구 → 공유 CCR DB

OpenCodex → 선택한 제공자의 모델 API (인터넷 / 사내 서버 / 호스트)

관리자 브라우저 → <서버 LAN IP>:20100 → OpenCodex 관리 UI :10100
                 별도 관리자 토큰으로 인증
```

두 프로젝트를 fork하거나 소스를 복사해 합치지 않습니다. 이 저장소는 연결 코드·운영 명령만 관리하며,
빌드할 때 `package-lock.json`으로 고정된 upstream 패키지를 설치합니다.
현재 고정 버전은 OpenCodex **2.75.0**, Caveman CLI **1.3.4**, Codex CLI **0.160.0**입니다.
Caveman companion 바이너리는 해당 CLI의 서명 검증 설치기가 선택합니다(이 버전: `bin-v1.1.7`).
이 서버의 기존 네이티브 설치와 데이터는 사용하거나 변경하지 않습니다.

배포 라이선스는 두 프로젝트가 다릅니다. OpenCodex는 MIT지만, 고정한 Caveman release의
proxy/MCP 엔진은 **BSL-1.1**입니다. 해당 Additional Use Grant는 자체 트래픽의 사내 self-hosted
운영을 허용하고, 제3자에게 hosted/managed/embedded 서비스로 제공하는 경우 별도 상업 라이선스를 요구합니다.
[정확한 release 고지](THIRD_PARTY.md)를 함께 확인하세요.

## 1. 시작

일반 Linux 사용자로 실행하는 rootless Podman을 권장합니다. `sudo podman`과 `podman`의 저장소는 다릅니다.

```bash
git clone https://github.com/CodeKi0303/caveman-opencodex-stack.git caveman-podman
cd caveman-podman
./stack init
# 필요하면 .env와 certs/ 설정: 아래 회사망 안내 참고
./stack build
./stack up
./stack status
```

`init`은 `.env`, `secrets/gateway-key`, `secrets/admin-key`를 생성합니다. 기존 키는 덮어쓰지 않습니다.
`up`은 프록시의 준비 상태를 확인하고 공통 카탈로그를 생성합니다.
카탈로그는 기동·업데이트 시 한 번 갱신합니다. 컨테이너의 초기 시도는 최대 3회 후 종료하며, 주기적인 갱신 작업은 없습니다.
서버에서 Codex `native-main` 로그인을 새로 만들 필요도 없습니다. 클라이언트의 기존 모델 인증을 전달합니다.

기본 설정은 API `18787`, 관리 UI `20100`을 모든 IPv4 인터페이스에 공개합니다.
`0.0.0.0`은 리스닝 주소이며 브라우저에서는 실제 서버 IP를 사용합니다.
특정 LAN에만 공개하려면 `.env`에서 다음처럼 설정하세요(주소는 실제 서버 주소로 교체):

```dotenv
BIND_ADDRESS=192.168.50.61
PORT=18787
ADMIN_BIND_ADDRESS=192.168.50.61
ADMIN_PORT=20100
```

| 용도 | 위 예시의 접속 주소 | 인증 |
|---|---|---|
| Codex 모델 연결 | `http://192.168.50.61:18787/v1` | 게이트웨이 키 + 모델 제공자 인증 |
| 모델 카탈로그 | `http://192.168.50.61:18787/v1/catalog` | 동일한 게이트웨이 키 |
| 원문 복구 MCP | `http://192.168.50.61:18787/mcp` | 동일한 게이트웨이 키 |
| OpenCodex 관리 웹페이지 | `http://192.168.50.61:20100/` | `secrets/admin-key`의 관리자 토큰 |

기존 `.env`는 `init`이 덮어쓰지 않으므로 직접 변경하고 `./stack down && ./stack up`으로 적용합니다.
기본 포트는 기존 서비스의 `8787`·`10100`과 충돌하지 않습니다.
관리 화면에서 관리자 토큰을 요구하면 서버의 `secrets/admin-key`를 사용하며 일반 사용자에게 배포하지 않습니다.
회사망에서는 필요한 두 포트에 대한 접근을 허용하고, API에는 게이트웨이 TLS를,
관리 UI에는 HTTPS reverse proxy를 적용하세요. `GATEWAY_TLS_*`는 관리 UI에 적용되지 않습니다.

## 2. 클라이언트 연결과 모델 목록

**Android Remote를 함께 쓰는 개인 사용자는 아래의 기본 `openai` provider + 로컬 브리지
설치 절차를 권장합니다.** 일부 앱 버전의 기본 세션 목록은 provider별로 필터링되어 사용자 정의
provider로 생성한 대화가 누락될 수 있습니다. 아래 일반 연결 예시는 브리지 없이
`caveman_stack` provider를 사용하는 방식입니다. 이미 기본 `openai` 브리지가 설정된 경우
`configure`를 다시 실행해도 해당 연결을 유지하고, 브리지가 정지했으면 설정 변경을 거부합니다.

서버의 `secrets/gateway-key` 파일을 본인의 Windows/WSL 클라이언트에 보관합니다.
**관리자 키·사용자의 auth.json·CCR DB는 복사하지 않습니다.** 각 Codex 클라이언트에서 로그인합니다.

Windows PowerShell / Linux / WSL에서 저장소를 clone하고 Codex를 완전히 닫은 다음:

```bash
npm ci --ignore-scripts
node scripts/client.mjs configure --url https://codex-proxy.example.com:18787/v1 --key-file /path/to/gateway-key
```

`npm ci --ignore-scripts`는 클라이언트 설정 도구가 사용하는 고정 버전의 의존성을 설치합니다.
예약 설치만으로 Node나 npm 의존성을 설치하지는 않습니다.

Windows 예시:

```powershell
node .\scripts\client.mjs configure --url https://codex-proxy.example.com:18787/v1 --key-file C:\Users\me\caveman-private\gateway-key
```

현재 사용자의 `CODEX_HOME` 또는 기본 `~/.codex`에 provider·카탈로그·HTTP 복구 MCP를 연결합니다.
필요하면 `--codex-home`으로 경로를 명시합니다. 기존 로그인·기본 모델은 유지합니다.
키는 사용자 Codex 설정 파일에 저장되며 터미널에 출력하지 않습니다. 변경 전 파일은
`~/.codex/before-caveman-<시각>-<임의값>/`에 백업됩니다. 카탈로그만 갱신할 때는 `sync`를 사용하세요.

| 명령 | 용도 |
|---|---|
| `configure` | 기본 `caveman_stack` provider를 만들거나 갱신하고 선택합니다. 카탈로그와 `/mcp`도 연결합니다. |
| `reconfigure` | 현재 선택된 기존 provider의 주소·게이트웨이 키와 `/mcp`를 갱신합니다. 다른 provider로 선택을 바꾸지 않습니다. `--provider ID`로 수정 대상을 명시할 수 있습니다. |
| `sync` | 카탈로그만 동기화합니다. provider 주소·인증·MCP 설정은 수정하지 않습니다. |
| `doctor` | 설정 불일치, 로컬 로그인 메타데이터, 카탈로그 접근과 MCP 도구 목록을 읽기 전용으로 확인합니다. 모델 추론이나 자동 로그인은 수행하지 않습니다. |

이전에 `8787`로 연결했거나 게이트웨이 키를 교체했다면 `sync` 대신 연결 설정부터 갱신합니다:

```bash
node scripts/client.mjs reconfigure --url http://192.168.50.61:18787/v1 --key-file /path/to/gateway-key --codex-home /path/to/.codex
node scripts/client.mjs doctor --url http://192.168.50.61:18787/v1 --key-file /path/to/gateway-key --codex-home /path/to/.codex
```

서버 카탈로그는 기동·업데이트 시 갱신됩니다. 서버 모델 설정을 바꿨거나 즉시 갱신하려면:

```bash
# 서버: 현재 OpenCodex가 제공하는 목록을 공통 카탈로그로 갱신
./stack catalog

# 각 클라이언트: 동일 목록을 다운로드하고 캐시 갱신
node scripts/client.mjs sync --url https://codex-proxy.example.com:18787/v1 --key-file /path/to/gateway-key
```

마지막으로 Codex 앱/CLI를 완전히 재시작합니다. Desktop 내장 CLI는 서버 CLI와 별개이므로
Desktop도 업데이트해야 할 수 있습니다. `catalog`는 **설치된 OpenCodex가 제공하는 목록**을 내보내며,
계정별 실제 사용 권한을 보장하지 않습니다. 새 모델을 모르는 버전이라면 다음 업데이트 절차를 먼저 실행하세요.
카탈로그의 시스템 지침을 직접 생성하거나 다른 모델 행을 복제하지 않습니다.
카탈로그 API는 `ETag`를 반환하고, 같은 버전의 `If-None-Match` 요청에는 본문 없이 `304`를 반환합니다.
클라이언트 `sync`도 변경이 없으면 설정·캐시·백업을 다시 쓰지 않습니다. 통신이나 카탈로그 검증이 실패하면 기존 파일을 유지합니다.

기본 사용 방식은 **수동 동기화**입니다. `configure` 또는 `reconfigure`가
`<CODEX_HOME>/caveman-client.json`에 서버 주소·키 파일 경로·Node 경로를 저장합니다.
키 값과 로그인 정보는 이 파일에 넣지 않으며 Git에도 포함하지 않습니다.

```bash
npm run sync
# 다른 Codex 홈을 사용하는 경우
npm run sync -- --codex-home /path/to/.codex
```

Windows에서는 저장소의 **`Sync-Catalog.vbs`를 더블클릭**합니다.
콘솔 없이 결과 창이 열리고 즉시 동기화합니다. 변경이 있는 경우에만 Codex 재시작을 안내합니다.
Windows Script Host와 Windows PowerShell 5.1이 필요합니다. Script Host를 차단한 PC에서는
`npm run sync`를 사용하거나 PowerShell에서 `scripts/sync-gui.ps1`을 실행합니다.
바탕화면 바로가기는 다음 명령으로 등록할 수 있습니다:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-shortcut.ps1
```

이 GUI는 현재 Windows의 Codex 홈만 동기화합니다. WSL·원격 PC에서는 해당 환경에서
`npm run sync` 또는 `node scripts/manual-sync.mjs`를 실행합니다.
연결 정보를 바꾸거나 Node 경로를 옮기면 `reconfigure`를 다시 실행하세요.
저장소를 옮긴 경우 기존 바로가기를 제거하고 새 위치에서 다시 등록합니다.

0.2.0 예약 설치 사용자는 **reconfigure → 수동 동기화 확인 → 예약 제거** 순서로 전환합니다.
`node scripts/schedule.mjs remove --codex-home <경로>`는 예약과 예약 전용 기록만 제거하며
수동 설정·로그인·카탈로그·키는 유지합니다. 기본 설치·업데이트는 예약을 등록하지 않습니다.
명시적으로 자동 갱신을 원하는 사용자를 위해 기존 `schedule.mjs install`은 선택 기능으로 유지합니다.
자세한 절차는 [운영 가이드](docs/OPERATIONS.md#클라이언트-카탈로그-동기화)를 참고하세요.

### Windows에서 기본 `openai` provider 사용

Codex Remote에서 기존 세션과 새 세션의 provider ID를 `openai`로 맞추려면 기본 provider와
로컬 브리지를 함께 사용합니다. 기본 `openai` provider는 사용자 정의 게이트웨이 헤더를
설정할 수 없으므로 브리지가 `127.0.0.1`에서 요청을 받아 게이트웨이 키를 추가합니다.
Codex 로그인 인증과 계정 헤더는 그대로 서버로 전달하며, 서버의 기존 키 인증도 유지합니다.

```powershell
# 로그인 시 자동 시작하는 로컬 브리지를 설치하고 즉시 상태 확인
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-native-bridge.ps1 `
  -UpstreamUrl http://192.168.50.61:18787/v1 `
  -KeyFile C:\Users\me\caveman-private\gateway-key

# 기본 provider를 선택하고 로컬 브리지로 모델 요청을 전달
node .\scripts\client.mjs configure --provider openai `
  --url http://192.168.50.61:18787/v1 `
  --key-file C:\Users\me\caveman-private\gateway-key `
  --bridge-url http://127.0.0.1:18788/v1
```

설치기는 현재 사용자에게 `Caveman Native OpenAI Bridge` 로그인 예약을 등록합니다.
이 예약은 콘솔 창 없이 브리지를 계속 실행하고 비정상 종료 시 재시도합니다.
모델 목록 동기화 주기는 등록하지 않습니다. `-CodexHome`, `-Port`, `-NodePath`로 설치 위치와
실행 경로를 지정할 수 있습니다. 저장소와 Node 실행 파일은 설치 후에도 해당 위치에 있어야 합니다.
변경 전 설정과 기존 예약은 `caveman-stack/native-bridge-backups/`에 백업됩니다.
같은 이름의 다른 예약이나 소유권을 확인할 수 없는 포트 사용 프로세스는 중지하지 않습니다.

`openai_base_url`은 로컬 브리지를 가리키고, 복구 MCP와 수동 카탈로그 동기화는 계속 원격 서버를
사용합니다. `model_providers.openai` 테이블은 만들지 않습니다. 설정 적용 후 Codex를 재시작하면
새 세션은 `openai` provider로 생성됩니다. **기존 세션의 provider 기록은 이 명령으로 바뀌지 않습니다.**
기존 세션을 전환하려면 Codex를 종료한 상태에서 세션 DB와 대화 파일을 함께 백업하고 별도로
마이그레이션해야 합니다. 파일의 byte offset을 참조하는 기록도 있어 JSONL 전체를 다시 저장하면 안 됩니다.

### Linux·WSL에서 기본 `openai` provider 사용

Linux에서는 같은 브리지를 systemd 서비스로 설치합니다. 일반 사용자와 WSL은 `--user`,
root가 운영하는 서버는 `--system`을 사용합니다. systemd와 Node.js 22.13 이상이 필요합니다.

```bash
# WSL 사용자 예시: Windows의 18788과 구분하여 18789 사용
node scripts/install-native-bridge-linux.mjs --user \
  --upstream-url http://192.168.50.61:18787/v1 \
  --key-file "$HOME/.codex/caveman-stack/gateway-key" --port 18789
node scripts/client.mjs configure --provider openai \
  --url http://192.168.50.61:18787/v1 \
  --key-file "$HOME/.codex/caveman-stack/gateway-key" \
  --bridge-url http://127.0.0.1:18789/v1

# 서버 root 예시: 실제 게이트웨이가 바인딩된 주소 사용
node scripts/install-native-bridge-linux.mjs --system \
  --codex-home /root/.codex --upstream-url http://192.168.50.61:18787/v1 \
  --key-file /root/.codex/caveman-stack/gateway-key
```

서비스 이름은 `caveman-native-bridge.service`입니다. `--node-path`로 Node 실행 파일을 지정할 수
있으며 기본값은 설치기를 실행한 Node입니다. 브리지 코드는 `<CODEX_HOME>/caveman-stack/`에
복사하므로 서비스 기동에 Windows 드라이브나 원본 저장소가 필요하지 않습니다.
키 내용은 서비스 파일에 넣지 않습니다. 설치기는 상태·프로세스 ID와 실제 카탈로그 접근을
확인하고, 실패하면 이전 파일과 서비스 실행 상태를 복구합니다. 변경 전 파일은 같은 디렉터리의
`native-bridge-backups/`에 저장합니다. 기존 서비스나 런타임 코드가 외부에서 수정된 경우 교체를 거부합니다.

사용자 서비스는 사용자 systemd 관리자가 시작될 때 기동합니다. 로그인 전에도 필요하면 관리자가
`loginctl enable-linger <사용자>`를 한 번 설정합니다. 설치기는 linger 설정이나 카탈로그 타이머를
변경하지 않습니다. WSL은 배포판 자체가 실행 중이어야 하며 Windows 종료 후 WSL까지 자동 기동하는
설정은 별도입니다. 상태는 `systemctl --user status caveman-native-bridge.service`로 확인합니다.
시스템 서비스는 `--user`를 빼고 확인합니다. 설치 이후 `configure --provider openai`를 실행하고
Codex를 재시작해야 새 provider 설정이 적용됩니다.

## 3. 설정 위치

### 로컬 웹 제어 페이지

`scripts/install-control-panel.ps1`로 설치하면 `http://127.0.0.1:18786/`와 바탕화면
`Caveman Control` 바로가기를 사용할 수 있습니다. Pod 주소·키, 이 PC의 압축 ON/OFF,
카탈로그 수동 동기화, SSH를 통한 서버 패키지 버전 확인·업데이트를 제공합니다.
서버와 로컬 브리지를 먼저 업데이트해야 하며, 자세한 설정과 복구 범위는
[로컬 제어 페이지 운영 안내](docs/LOCAL-CONTROL.md)를 참고하세요.

| 바꿀 내용 | 위치 / 명령 |
|---|---|
| 공개 주소·포트, 요청 제한, 프록시, TLS | `.env` → `down` / `up` |
| 압축 또는 통과 비교 | `.env`의 `CAVEMAN_MODE=compress` 또는 `record` |
| 게이트웨이 키 | `secrets/gateway-key` (키 교체 후 서버 재시작·클라이언트 갱신) |
| OpenCodex 제공자·계정·모델 정책 | 관리 UI에서 설정 또는 `data/state/opencodex/config.json`을 중지 후 편집 |
| OpenCodex 관리 UI | `http://<서버 LAN IP>:20100/`, `.env`의 `ADMIN_PORT`로 변경 |
| 관리 UI 공개 인터페이스 | `ADMIN_BIND_ADDRESS` (빈 값이면 `BIND_ADDRESS`와 동일) |
| 관리자 UI 토큰 | `secrets/admin-key` (필요할 때 로컬에서 확인) |
| 공통 카탈로그 | `data/state/catalog/models.json`, `./stack catalog`로 생성 |
| 서버 카탈로그 갱신 | 기동·업데이트 시 1회, 이후 `./stack catalog` |
| 클라이언트 수동 동기화 | `npm run sync`, Windows `Sync-Catalog.vbs` 더블클릭 |
| 압축 원문 DB | `data/state/caveman/ccr.db` |
| 로그 | `./stack logs` |

관리 UI를 로컬에서만 쓰려면 `ADMIN_BIND_ADDRESS=127.0.0.1`, 공개하지 않으려면 `ADMIN_PORT=`로 설정합니다.
관리 API 인증은 OpenCodex의 별도 관리자 토큰으로 유지합니다. 컨테이너 내부의 인증 없는
`10101` 및 Caveman `8787`은 호스트에 직접 공개하지 않습니다.

OpenCodex에 외부 제공자를 추가할 때는 제공자의 URL·API 형식(어댑터)·인증·모델을 설정합니다.
사내 다른 서버는 해당 LAN 주소/DNS를 사용합니다. 같은 호스트의 루프백 서버는
`NETWORK=slirp4netns:allow_host_loopback=true`와 `host.containers.internal`을 사용할 수 있습니다.
이 경우에도 Codex의 접속 주소는 게이트웨이로 유지해야 Caveman 압축을 경유합니다.
`20100` 관리 포트를 Codex 모델 연결 주소로 사용하면 Caveman을 우회합니다.

## 4. 업데이트·백업·복구

```bash
./stack backup                 # 잠시 중지 → 일관된 DB 복사 → 재기동
# package.json의 버전을 검토해서 변경한 다음
./stack lock                   # 잠금 파일 갱신 (호스트 npm 불필요)
./stack update
```

`update`는 새 이미지 빌드 → 이전 이미지 ID/DB 백업 → 복제 DB를 이용한 격리 후보 기동·카탈로그 확인
→ 운영 교체 → 준비 상태·카탈로그 확인 순서로 실행합니다. 운영 교체 단계가 실패하면 이전 이미지와 DB로 복원합니다.
빌드/후보 검증 실패 시 이전 서비스가 유지됩니다. 실제 모델 API 테스트는 계정 비용·인증이 필요하므로 자동 상태 검사와 구분합니다.
업데이트에는 짧은 중단이 있습니다. 사용 중인 Codex/MCP를 닫고 유지보수 시간에 실행하세요.
무인 `latest` 자동 교체 대신 검토 가능한 버전·잠금 파일 변경을 Git으로 배포합니다.

```bash
./stack rollback backups/20261002-120000
```

백업은 비밀 정보와 원문을 포함합니다. Git 제외 대상이며 접근 권한을 유지하세요.
롤백은 이미지와 런타임 DB를 복원합니다. `.env`의 옛 사본은 백업의 `stack.env`에 있으며 필요하면 별도로 복원합니다.
현재 키는 자동으로 예전 키로 돌리지 않습니다. `data/active-image`는 실제 사용 중인 이미지 ID를 기록합니다.

## 5. 회사 프록시·인증서

[회사망 설정](docs/CORPORATE-NETWORK.md)에 이미지 pull / build / runtime / Windows·WSL 설정을 구분했습니다.
회사 루트 CA는 `certs/company-root.crt` 등 PEM 형식으로 넣습니다. 빌드 시 secret mount로 전달하고,
실행 시 시스템 CA와 합친 bundle을 Node/Bun/Go 계열 TLS 클라이언트에 전달합니다.
인증서 검증을 끄는 설정은 제공하지 않습니다.

## 6. 원문 복구와 지원 범위

입력 압축과 출력 축약 스킬은 별개입니다. 출력용 Caveman 스킬은 이 저장소가 Codex에 강제로 설치하지 않습니다.
Windows/WSL에서도 게이트웨이의 Streamable HTTP MCP로 원문을 복구할 수 있습니다.
위의 `configure` 또는 `reconfigure`가 같은 키로 `[mcp_servers.caveman]`을 자동 설정하므로 별도 등록은 필요 없습니다.
수동으로 환경변수 인증을 사용하려는 경우, 게이트웨이 키를 `CAVEMAN_GATEWAY_KEY`에 설정하고 Codex가 그 환경을 상속하도록 시작한 뒤
기존 MCP 테이블을 아래 형태로 편집합니다. 같은 테이블을 중복 추가하지 마세요. `/v1/mcp`가 아닌 **`/mcp`**입니다.

```toml
[mcp_servers.caveman]
url = "http://192.168.50.61:18787/mcp"
env_http_headers = { "x-caveman-gateway-key" = "CAVEMAN_GATEWAY_KEY" }
```

키는 모델 연결·카탈로그 다운로드와 같습니다. 키 자체를 명령 인수에 넣지 마세요.
환경변수 대신 `http_headers`의 같은 헤더명으로 사용자 설정 파일에 저장할 수도 있습니다.
서버가 요구하는 헤더는 `x-caveman-gateway-key`이므로 `bearer_token_env_var`만으로 대체할 수 없습니다.
저장 후 Codex/MCP 연결을 재시작합니다. 공식 지원 설정은 [OpenAI MCP 문서](https://developers.openai.com/codex/mcp/)를 참고하세요.

같은 Linux 호스트에서는 기존 stdio 연결도 사용할 수 있습니다:

```toml
[mcp_servers.caveman]
command = "/absolute/path/to/caveman-podman/stack"
args = ["mcp"]
```

HTTP MCP는 서버의 원문 복구 도구를 호출하며, Windows/WSL 작업 파일의 실행 위치를 바꾸지 않습니다.
**원문 DB와 복구 도구에는 사용자별 격리가 없습니다.** 같은 키를 가진 클라이언트는 개인용 공유 CCR 원문에 접근합니다.
서로 다른 사용자/팀을 분리해야 한다면 별도 컨테이너·키·포트·데이터 디렉터리로 운용하세요.

게이트웨이는 Responses HTTP/SSE, 모델 목록·카탈로그, 원문 복구 MCP, 이미지 generations/edits, alpha/search, responses/compact를 연결합니다.
경로를 연결했다는 것과 upstream이 지원한다는 것은 다릅니다. WebSocket·음성 및 모든 OpenAI API의 포괄 지원은 하지 않습니다.

## 7. 검증과 GitHub 배포

```bash
node --test tests/*.test.mjs
python3 -m py_compile stack
git diff --check
# 선택: 계정 인증을 명시적으로 사용해 실제 모델/SSE/압축/원문 복구 확인
python3 scripts/smoke.py --key-file secrets/gateway-key --auth-file ~/.codex/auth.json --state-dir data/state
```

인증, 경로별 압축/우회, 스트리밍 전달, 업로드 제한, CIDR, 클라이언트 설정·카탈로그를 검증합니다.
GitHub Actions는 이 검사를 실행하며 Docker/Podman 이미지를 자동 게시하지 않습니다.

`.env`, `secrets/`, `certs/`, `data/`, `backups/`, 모델 카탈로그·로그·DB는 Git과 빌드 context에서 제외합니다.
인증서와 키를 소스에 넣지 마세요. [라이선스와 배포 경계](THIRD_PARTY.md)를 확인하세요.

```bash
git add .
git commit -m "Add Podman Caveman and OpenCodex stack"
git remote add origin https://github.com/CodeKi0303/caveman-opencodex-stack.git
git push -u origin main
```

서버 재부팅 시 자동 시작 예시는 [운영 가이드](docs/OPERATIONS.md)에 있습니다.
버전별 변경은 [변경 기록](CHANGELOG.md)을 참고하세요.

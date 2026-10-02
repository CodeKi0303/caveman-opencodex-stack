# caveman-opencodex-stack

Linux에서 **Codex → 게이트웨이 → Caveman 압축 프록시 → OpenCodex → 선택한 제공자의 모델**을 실행하는 배포 저장소입니다.
Caveman이 요청의 압축 가능한 입력(예: 긴 도구 결과)을 줄여 OpenCodex로 전달하고,
OpenCodex는 설정된 제공자·모델 정책에 따라 해당 모델 API로 요청을 전달합니다.
모든 입력이 압축되는 것은 아니며 압축 조건에 맞지 않는 내용은 유지합니다.
호스트에는 **Podman 5+, slirp4netns, Python 3.11+, Git**이 필요합니다. 클라이언트 설정 도구는 Node.js 22.13+를 사용하며, 환경변수 기반 회사 프록시를 쓰는 클라이언트는 Node.js 24.14+를 권장합니다.
Windows/WSL Codex는 HTTP(S)로 접속하므로 작업 파일과 도구 실행은 각 PC에 남습니다.

```text
Windows / WSL / Linux Codex (각자의 로그인)
    │ 게이트웨이 키 + 기존 모델 인증
    ▼
호스트 <서버 LAN IP>:18787 (기본 LAN 공개, TLS 설정 가능)
    │ Podman 컨테이너 내부 :8080
    ├─ POST /v1/responses → Caveman :8787 [입력 압축] → OpenCodex :10101
    ├─ 이미지·검색·compact → OpenCodex :10101
    ├─ GET /v1/models → OpenCodex :10101
    └─ GET /v1/catalog → 공통 카탈로그 파일

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
`up`은 세 프로세스의 준비 상태를 확인하고 공통 카탈로그를 생성합니다.

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
| OpenCodex 관리 웹페이지 | `http://192.168.50.61:20100/` | `secrets/admin-key`의 관리자 토큰 |

기존 `.env`는 `init`이 덮어쓰지 않으므로 직접 변경하고 `./stack down && ./stack up`으로 적용합니다.
기본 포트는 기존 서비스의 `8787`·`10100`과 충돌하지 않습니다.
관리 화면에서 관리자 토큰을 요구하면 서버의 `secrets/admin-key`를 사용하며 일반 사용자에게 배포하지 않습니다.
회사망에서는 필요한 두 포트에 대한 접근을 허용하고, API에는 게이트웨이 TLS를,
관리 UI에는 HTTPS reverse proxy를 적용하세요. `GATEWAY_TLS_*`는 관리 UI에 적용되지 않습니다.

## 2. 클라이언트 연결과 모델 목록

서버 담당자는 `secrets/gateway-key` 파일만 각 사용자에게 안전한 경로로 전달합니다.
**관리자 키·사용자의 auth.json·CCR DB는 전달하지 않습니다.** 사용자는 자기 Codex에서 로그인합니다.

Windows PowerShell / Linux / WSL에서 저장소를 clone하고 Codex를 완전히 닫은 다음:

```bash
node scripts/client.mjs configure --url https://codex-proxy.example.com:18787/v1 --key-file /path/to/gateway-key
```

Windows 예시:

```powershell
node .\scripts\client.mjs configure --url https://codex-proxy.example.com:18787/v1 --key-file C:\Users\me\caveman-private\gateway-key
```

현재 사용자의 `CODEX_HOME` 또는 기본 `~/.codex`에 provider와 카탈로그를 연결합니다.
필요하면 `--codex-home`으로 경로를 명시합니다. 기존 로그인·기본 모델은 유지합니다.
키는 사용자 Codex 설정 파일에 저장되며 터미널에 출력하지 않습니다. 변경 전 파일은
`~/.codex/before-caveman-<시각>/`에 백업됩니다. 이미 provider가 있으면 `configure` 대신 `sync`를 사용하세요.

새 모델이 나왔을 때:

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

## 3. 설정 위치

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
같은 Linux 호스트의 Codex는 아래 stdio MCP를 등록할 수 있습니다:

```toml
[mcp_servers.caveman]
command = "/absolute/path/to/caveman-podman/stack"
args = ["mcp"]
```

WSL/Windows가 다른 호스트에 있으면 HTTP 모델 연결만으로 이 로컬 MCP를 실행할 수 없습니다.
SSH stdio MCP나 별도로 인증된 MCP 전송을 연결해야 합니다. 모델 요청용 SSH 터널은 필요하지 않습니다.
예: `ssh -T user@server /absolute/path/to/caveman-podman/stack mcp`.
이는 원격 MCP 명령만 실행하며 Windows 작업을 원격 작업으로 전환하지 않습니다.

**원문 DB와 복구 도구에는 사용자별 격리가 없습니다.** 회사에서 서로 다른 사용자/팀의 원문을 분리하려면
사용자 또는 보안 경계별로 별도 clone·컨테이너·키·포트·데이터 디렉터리를 운용하세요.
공유 키 하나로 다중 사용자 접근 권한·감사 체계를 제공하는 제품은 아닙니다.

게이트웨이는 Responses HTTP/SSE, 모델 목록, 이미지 generations/edits, alpha/search, responses/compact만 연결합니다.
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

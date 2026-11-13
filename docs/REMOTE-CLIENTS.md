# SSH로 여러 PC의 로컬 브릿지 관리

웹 제어 페이지에서 PC를 등록하면, 선택한 PC 또는 등록한 전체 PC에 **현재 제어 페이지에 저장된 Pod 주소·게이트웨이 키·Caveman 압축 ON/OFF·클라이언트 인증 모드**를 적용할 수 있습니다. 각 PC의 브릿지는 계속 그 PC의 `127.0.0.1`에서 실행됩니다. Pod나 원격 PC에 새 관리 포트를 공개하지 않습니다.

## 준비

- 대상 PC에 이 프로젝트의 native bridge와 웹 제어 서비스를 설치하고 실행해 둡니다. 설정 적용에는 이번 버전의 제어 서비스가 필요합니다. 이전 버전에서도 상태 조회·카탈로그 동기화·진단은 가능합니다.
- 대상 PC에 Node.js 22.13 이상이 필요합니다. Linux/WSL에는 Python 3, Windows SSH에는 PowerShell이 필요합니다.
- 제어 페이지를 실행하는 **운영체제 사용자**가 대상 PC에 SSH로 접속할 수 있어야 합니다. 비밀번호 입력 대신 SSH 키, `ssh-agent`, 기존 SSH config의 호스트 별칭을 사용합니다. 처음에는 같은 사용자로 직접 SSH 접속해 호스트 키를 확인합니다. 자동 작업은 `StrictHostKeyChecking=yes`, `BatchMode=yes`를 사용합니다.
- SSH 계정이 대상 Codex와 브릿지 설정을 사용하는 계정이어야 합니다. WSL은 WSL의 SSH 주소·포트로 등록합니다. Windows와 WSL은 서로 다른 PC 항목으로 등록할 수 있습니다.

## 등록할 값

| 값 | 예시/설명 |
|---|---|
| 표시 이름 | 작업 PC, WSL, 원격 Linux |
| SSH 대상 | `codeki@192.168.50.62` 또는 SSH config의 `work-pc` 별칭 |
| SSH 포트 | 기본 `22`; WSL 별도 SSH 포트도 가능 |
| 플랫폼 | Linux/WSL 또는 Windows |
| 설정 파일 경로 | Linux: `/home/codeki/.codex/caveman-stack/native-bridge.json` |
| 설정 파일 경로 | Windows: `C:\Users\codek\.codex\caveman-stack\native-bridge.json` |
| SSH 키 파일 | **제어 페이지가 실행되는 PC**의 개인 키 경로. 생략하면 SSH config/agent 사용 |
| Node 경로(선택) | 자동 탐색이 안 될 때만 대상 PC의 Node 실행파일 절대 경로 |

`/home/codeki/.codex/config.toml` 또는 Windows의 `...\.codex\config.toml`을 입력해도 해당 Codex 홈의 `caveman-stack/native-bridge.json`으로 변환됩니다. 키를 붙여넣거나 OAuth 파일을 지정하지 않습니다. Node 실행 경로는 설치기가 남긴 manifest에서 자동 탐색하므로 NVM 설치도 지원합니다.

## 작업

- **상태 조회**: 각 PC에서 사용하는 Pod 주소, 브릿지/게이트웨이 상태, 모델 개수, 설정 적용 지원 여부를 확인합니다.
- **현재 Pod 설정 적용**: 제어 페이지에 저장된 연결을 선택한 PC로 전달합니다. 대상 PC의 SSH 관리 설정, 로컬 포트, 다른 Codex 설정, OAuth 로그인은 유지합니다. 설정과 카탈로그를 기존 제어 API를 통해 백업·갱신합니다. 인증키는 SSH stdin 안에서만 전달되며 명령 인자, 작업 결과, 로그에 넣지 않습니다.
- **모델 목록 동기화**: 각 PC가 현재 연결된 Pod의 카탈로그를 내려받습니다. 이 작업 자체로 Pod 주소를 바꾸지 않습니다.
- **진단**: 해당 PC에서 브릿지, 카탈로그, 원문 복구 MCP, 설정을 검사합니다.

여러 PC 작업은 PC별 결과를 표시합니다. 한 PC가 꺼져 있거나 SSH가 실패해도 나머지 PC는 진행합니다. 성공한 PC의 변경을 다른 PC의 실패 때문에 되돌리지 않습니다. 변경된 카탈로그와 MCP 설정은 해당 PC의 Codex 재시작/재접속 후 확실히 반영됩니다. 실행 중인 Codex 프로세스는 강제로 종료하지 않습니다.

등록 목록은 제어 페이지의 `native-bridge.json` 옆 **`remote-clients.json`**에만 저장합니다. 개인 설정과 SSH 키를 Git에 커밋하지 않습니다. PC 등록을 지워도 원격 PC의 브릿지나 설정 파일을 삭제하지 않습니다.

## 오류

- `REMOTE_CONTROL_UPGRADE_REQUIRED`: 대상 PC의 프로젝트와 제어 서비스를 업데이트한 다음 적용합니다.
- `REMOTE_CONTROL_UNAVAILABLE`: 대상의 로컬 제어 서비스가 꺼져 있거나 `controlPort`가 일치하지 않습니다.
- `REMOTE_CONTROL_CONFIG_MISMATCH`: 입력한 설정 파일과 실행 중인 제어 서비스가 다른 설치를 가리킵니다.
- `REMOTE_SSH_FAILED`: SSH 키, 계정, 호스트 키, 포트를 확인합니다. 같은 OS 사용자로 터미널에서 접속해 확인합니다.
- `REMOTE_BOOTSTRAP_FAILED`: 대상 설정 경로, Python/PowerShell, Node 설치를 확인하고 필요하면 Node 절대 경로를 지정합니다.
- `LOCAL_MANAGEMENT_LOCKED`: Pod 호스트에서 로컬 서버 관리로 설치한 제어 페이지는 다른 Pod 주소로 전환할 수 없습니다. 해당 호스트의 서버 관리 설정을 먼저 별도로 정리해야 합니다.

자동 발견이나 실시간 전체 동기화 기능은 아닙니다. 등록한 PC에 사용자가 선택한 작업을 실행하며, 각 PC의 연결 상태는 독립적입니다.

관리 페이지가 실행되는 PC 자체는 기존 로컬 버튼으로 관리하세요. 같은 제어 서비스를 SSH 대상에 등록해 작업을 다시 보내면 중복 작업 방지로 `REMOTE_CLIENT_BUSY`가 반환됩니다.

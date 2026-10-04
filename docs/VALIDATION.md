# 검증 기록

## 0.3.0 수동 동기화 전환 (2026-10-04)

- Windows 전체 Node 테스트 45개 통과·2개 제외, WSL 변경 기능 테스트 19개 및 Python 수명 주기 테스트 3개 통과. GitHub Windows/Linux CI 성공.
- 실제 Windows PowerShell 5.1 GUI 실행 경로와 수동 CLI가 같은 설정으로 정상 동기화. 숨김 런처에서도 결과 창이 표시되는 것을 확인.
- Windows 바탕화면 바로가기 등록. Windows·WSL·원격 Linux 예약 제거 후 수동 동기화 성공.
- 서버 `stack update` 성공, 컨테이너 healthy. 시작 로그 `catalog_startup_finished: ok=true` 확인 후 카탈로그 작업 프로세스가 종료됨.
- 실제 GPT-6.1 Sol 응답·Caveman 압축·HTTP MCP 원문 66,392바이트 복구 성공.
- 연결 정보는 예약과 분리된 로컬 파일에 보관. 실제 키·토큰은 Git 포함 파일에서 검출되지 않음.

아래 0.2.0 예약 기록은 당시의 검증 이력이며 현재 운영 정책은 수동 동기화입니다.

## 0.2.0 실제 적용 (2026-10-03)

- GitHub Actions의 Windows·Linux 검증 모두 성공. 각 OS에서 Node 42개 통과·다른 OS 전용 2개 제외, Linux Python 3개 통과.
- 실제 고정 Caveman 바이너리로 계정·세션·하위 작업 헤더 전달 확인.
- `stack update`의 상태 백업·격리 후보 기동·카탈로그 확인·운영 교체 성공. 운영 컨테이너 `healthy`, 부팅 서비스 활성화 유지.
- 실제 GPT-6.1 Sol SSE 완료와 압축 기록 확인. 합성 원문 66,392바이트를 인증된 HTTP MCP로 정확히 복구.
- `/mcp`와 `/v1/catalog`의 무인증 요청은 401. 복구 도구 목록에는 `caveman_retrieve`만 노출.
- Windows, WSL Ubuntu 24.04, 원격 Linux Codex 홈 모두 HTTP MCP로 전환하고 `doctor` 경고 없이 통과.
- 세 클라이언트의 15분 예약을 실제 설치·실행하고 종료 코드 0 확인. 변경 없는 동기화는 304를 받고 파일·백업을 추가로 만들지 않음.
- Linux/WSL 사용자 타이머는 linger를 활성화. WSL이 종료된 동안에는 실행되지 않으며 별도 자동 부팅은 설정하지 않음.
- 세 클라이언트 `auth.json`의 변경 전후 해시 일치. 서버 컨테이너에는 사용자 OAuth 파일 없음.
- Git 포함 파일에서 현재 실제 토큰·게이트웨이 키 문자열 검출 없음.

원격 Linux에는 이미지의 Node 24.14.1 실행 파일과 클라이언트용 JS 의존성만 호스트에 추출했습니다.
서버 프로세스는 계속 Podman 컨테이너에서 실행됩니다. 설정 파일과 통신을 검증했으며,
실행 중인 Codex Desktop/CLI의 설정 재로딩은 자동으로 수행하지 않았습니다. 클라이언트 연결을 재시작해야 합니다.

## HTTP 복구 종단 간 확인

실제 모델 호출과 압축·원문 복구를 함께 확인하려면 서버 호스트에서 다음을 실행합니다.
인증 파일은 해당 클라이언트의 로컬 파일을 읽으며 컨테이너로 복사하지 않습니다.

```bash
python3 scripts/smoke.py --url http://192.168.50.61:18787/v1 --key-file secrets/gateway-key --auth-file /root/.codex/auth.json --state-dir data/state --mcp
```

이 명령은 합성 데이터로 모델 요청을 한 번 보내므로 해당 계정의 사용량을 소비합니다.
Responses/SSE 완료, Caveman 압축 기록, CCR 원문, 인증된 HTTP MCP의 동일 원문 반환을 확인합니다.
출력에는 인증 값과 원문을 포함하지 않습니다.

## 0.2.0 클라이언트 예약 테스트 (2026-10-03)

Windows와 WSL Ubuntu 24.04에서 `node --test tests/schedule.test.mjs`를 실행했습니다.
Windows는 6개 통과·Linux 전용 1개 제외, WSL은 5개 통과·Windows 전용 2개 제외입니다.
사용자 범위·경로 인용·Codex 홈별 동일 예약 갱신·소유권 확인·모의 설치/삭제와
예약 실행기의 클라이언트 인수·종료 코드·마지막 로그 교체를 검사했습니다.
Windows PowerShell 5.1에서 BOM 없는 UTF-8 설정의 한글 경로로 테스트 실행기를 호출하는 것도 확인했습니다.
테스트는 실제 Scheduled Task나 systemd 예약을 등록하지 않습니다.
WSL의 `systemd-analyze calendar`로 15분 및 매시간 달력 표현식을 확인했습니다.
실제 로그인/재부팅 후 실행과 실제 예약 등록은 이 테스트 결과에 포함하지 않습니다.

2026-10-02, Ubuntu 26.04 amd64 / Podman 5.7.0에서 수행했습니다.

- 실제 이미지 빌드 및 Caveman 서명/checksum 검증 설치 성공.
- `slirp4netns` 네트워크, 호스트 루프백 18787에서 기동·준비 상태·카탈로그 생성 성공.
- 실제 계정의 GPT-6.1 Sol Responses/SSE 완료, 요청/응답 모델 이름 일치.
- 합성 500개 도구 결과 입력 압축 및 SQLite CCR 원문 바이트 일치 확인.
- Node 테스트 7개: 인증, CIDR, 경로/우회, 스트리밍, 본문 제한, 클라이언트 TOML,
  사설 CA 미신뢰 거절·명시적 신뢰 성공.
- Python 테스트: 소켓 제외 백업, 후보 교체 실패 시 이전 이미지/DB 복구.
- 실제 `stack update`의 백업·격리 후보·운영 교체 성공.
- 실제 `stack rollback`의 이전 image ID 및 전체 CCR 원문 일치 확인.
- Git 포함 대상에서 실제 인증 토큰/게이트웨이 키 없음 확인. 운영 데이터 제외 확인.

초기 검증 후 컨테이너를 종료했으며, 이후 LAN 공개 요청에 따라 같은 Podman 구성을 다시 기동했습니다.
기존 네이티브 Caveman/OpenCodex 서버는 교체하지 않았습니다.
이 호스트에서의 컨테이너 검증은 root 소유 Podman + userspace 네트워크로 수행했습니다.
Rootless/SELinux 조합, ARM64, 실제 회사 NTLM/Kerberos·proxy 장비, Windows Desktop 화면까지의
종단 간 검증은 아직 수행하지 않았습니다. TLS 테스트는 테스트용 사설 CA를 사용했습니다.
모델 inference 검증은 일반 상태 검사와 별도로 `scripts/smoke.py`로 실행했습니다.

## LAN 및 관리 UI 공개 (2026-10-02)

- Podman 실행 상태: `192.168.50.61:18787` → 게이트웨이 `8080`,
  `192.168.50.61:20100` → OpenCodex 관리 UI `10100`.
- 서버에서 LAN 주소로 UI HTTP 200, 관리 API 무인증 401 / 관리자 토큰 인증 200 확인.
- 게이트웨이 모델 목록 무인증 401 / 게이트웨이 키 인증 200 확인.
- 내부 `10101` 및 Caveman `8787`은 Podman 호스트 포트로 공개하지 않음.
- Node 7개 및 Python 3개 테스트 통과. Python에는 LAN/루프백 관리 포트 선택,
  관리 포트 비활성화, 격리 후보 포트 비공개 검증을 추가함.
- 설정 변경 전 `.env`는 `backups/lan-settings-20261002-070657/stack.env`에 보관.
  복구: `./stack down` → 해당 파일을 `.env`로 복사 → 필요 시 `./stack up`.
- 이번 변경에서는 실제 모델 추론을 재호출하지 않았으며 Windows 브라우저에서의 접속은 별도 확인 필요.
- 현재 두 LAN 포트는 HTTP이며 관리 UI의 HTTPS는 별도 reverse proxy 구성이 필요함.

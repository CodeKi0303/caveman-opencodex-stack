# 검증 기록

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

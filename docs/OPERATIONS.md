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

## 프록시와 인증 장애 구분

- TCP 연결 불가: 호스트 바인딩·Podman publish·회사/호스트 방화벽 확인.
- TLS 실패: 서버 인증서 SAN·CA 체인·클라이언트 trust store 확인.
- `Gateway key required`: 모델 로그인과 별개인 gateway key 확인.
- upstream 401: 사용자 Codex 로그인이나 OpenCodex 계정 상태 확인.
- 413: reverse proxy, gateway, Caveman, OpenCodex 각 본문 제한 확인.
- 모델이 안 보임: `stack catalog` → 클라이언트 `sync` → Desktop/CLI 완전 재시작.
- 카탈로그에 있어도 모델 호출 실패: 실제 계정 권한·제공자 지원·서비스 제한 확인.

게이트웨이는 요청 본문·키·Authorization·query를 기록하지 않습니다.
OpenCodex/Caveman 자체 로그·DB와 원문은 별도 민감 데이터입니다. 로그 전체를 공개 이슈에 붙이지 마세요.
기존 네이티브 설치 데이터를 자동 import하지 않으며 migration은 별도 백업과 검증 후 진행해야 합니다.

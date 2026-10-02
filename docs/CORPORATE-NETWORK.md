# 회사 프록시와 CA 인증서

## 1. 이미지 pull: Linux 호스트

Podman이 base image를 다운로드하는 시점에는 컨테이너가 아직 없습니다.
기본 `NETWORK`/`BUILD_NETWORK`는 `slirp4netns`입니다. 회사 호스트의 bridge forwarding 차단에
영향받지 않는 userspace 네트워크이며 호스트에 `slirp4netns` 패키지가 필요합니다.
조직이 관리하는 Podman 네트워크가 있다면 `.env`에서 해당 이름으로 바꿀 수 있습니다.
회사 CA를 **호스트** 신뢰 저장소에도 설치해야 합니다. Ubuntu/Debian 예시:

```bash
sudo install -m 0644 company-root.crt /usr/local/share/ca-certificates/company-root.crt
sudo update-ca-certificates
```

사설 registry만을 위한 CA는 Podman의 `~/.config/containers/certs.d/<registry[:port]>/ca.crt`를 사용합니다.
회사 프록시에서 image pull이 막히면 실행 셸에도 `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`를 설정하세요.
비밀번호가 포함된 URL을 shell history나 공유 문서에 붙이지 마세요.

## 2. 이미지 build: npm과 Caveman binary

`.env`의 proxy 값은 `stack build`가 Podman 환경으로 전달합니다.
`certs/*.crt`, `certs/*.pem`을 모아 Podman build secret으로 npm/Node에 제공합니다.
인증서나 proxy 비밀번호를 Containerfile의 `ARG`/`ENV`로 하드코딩하지 않습니다.

허용할 외부 도메인: 사용 base image registry, `registry.npmjs.org`, `github.com`,
GitHub release download hosts(`release-assets.githubusercontent.com` 등), 모델 제공자가 요구하는 호스트.
폐쇄망에서는 검증된 이미지를 연결된 빌더에서 만들고 사내 registry로 반입하세요.
이미지에는 pinned third-party 패키지와 바이너리가 포함되므로 해당 고지를 함께 배포합니다.

## 3. 실행 중 통신

`.env` 예시 (예제 주소를 실제 회사 주소로 교체):

```ini
HTTP_PROXY=http://proxy.corp.example:8080
HTTPS_PROXY=http://proxy.corp.example:8080
NO_PROXY=localhost,127.0.0.1,::1,.corp.example
```

`certs/company-root.crt`를 넣은 후 `./stack down && ./stack up`.
Node/Bun용 `NODE_EXTRA_CA_CERTS`, 기타 TLS 클라이언트용 `SSL_CERT_FILE` 등을 런타임에 설정합니다.
내부 Caveman→OpenCodex 경로가 회사 프록시로 나가지 않도록 루프백을 NO_PROXY에 항상 추가합니다.
프록시 URL은 컨테이너 관리자에게 inspect로 보일 수 있으므로 rootless 사용자·호스트 접근 권한을 관리하세요.
NTLM/Kerberos 등 특수 인증은 조직이 제공하는 로컬 proxy agent/인증 방식을 사용해야 하며 이 저장소가 구현하지 않습니다.

## 4. 들어오는 LAN HTTPS

`certs/server.crt`에 서버 인증서 체인, `secrets/server.key`에 개인 키를 둡니다.

```ini
BIND_ADDRESS=10.20.30.40
PORT=18787
GATEWAY_TLS_CERT=/certs/server.crt
GATEWAY_TLS_KEY=/run/secrets/server.key
```

인증서 SAN은 사용자가 접속하는 DNS/IP와 일치해야 합니다. 사용자는 `https://.../v1`로 접속합니다.
이 경우 모델/API 키를 포함한 요청은 TLS로 전달됩니다. 회사 reverse proxy에서 TLS를 종료할 수도 있습니다.
SSE 버퍼링을 끄고 충분한 timeout과 256MiB 본문 제한을 설정하세요. client cert 인증은 reverse proxy에 맡깁니다.
Rootless 포트 포워딩·reverse proxy는 소스 IP를 바꿀 수 있으므로 `ALLOWED_CIDRS`만 믿지 말고 호스트 방화벽을 적용하세요.

OpenCodex 관리 UI는 별도 `ADMIN_PORT=20100`이며 `ADMIN_BIND_ADDRESS`가 비어 있으면
`BIND_ADDRESS`와 같은 인터페이스에 공개됩니다. 관리자 토큰은 `secrets/admin-key`입니다.
위 `GATEWAY_TLS_*`는 게이트웨이 전용이며 관리 UI는 HTTP입니다. 관리 UI를 HTTPS로 제공하려면
회사 reverse proxy에서 TLS를 종료하고 `ADMIN_BIND_ADDRESS=127.0.0.1`로 upstream을 제한하거나
관리망 인터페이스에 바인딩하세요. 게이트웨이의 `ALLOWED_CIDRS`는 관리 포트에 적용되지 않습니다.

## 5. 클라이언트

Windows와 WSL은 서로 다른 인증서 저장소와 Codex 홈을 사용합니다.
회사 CA를 각 OS의 정책에 따라 설치하고 Node 카탈로그 도구에는 필요 시 다음처럼 추가합니다:

```powershell
$env:NODE_EXTRA_CA_CERTS = 'C:\Company\company-root.crt'
$env:NODE_USE_ENV_PROXY = '1' # Node 24.14+; 필요 시 HTTP_PROXY/HTTPS_PROXY도 설정
node .\scripts\client.mjs sync --url https://codex-proxy.corp.example:18787/v1 --key-file C:\Private\gateway-key
```

```bash
NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/path/to/company-root.crt node scripts/client.mjs sync \
  --url https://codex-proxy.corp.example:18787/v1 --key-file /path/to/gateway-key
```

Codex Desktop 자체의 인증서·proxy 적용은 해당 앱 실행 환경에도 반영해야 합니다.
Node 환경변수만 설정했다고 Desktop의 TLS 설정까지 바뀌지는 않습니다.

참고: [Podman build secrets/proxy](https://docs.podman.io/en/stable/markdown/podman-build.1.html),
[Podman 실행 설정](https://docs.podman.io/en/stable/markdown/podman-run.1.html).

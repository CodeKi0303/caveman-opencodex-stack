# Podman 컨테이너의 Codex 로그인

계정의 디바이스 코드 로그인이 허용되면 기존 명령을 사용할 수 있습니다.

```bash
./stack codex login --device-auth
```

디바이스 코드 인증을 사용할 수 없으면 **브라우저 OAuth 폴백**을 실행합니다.

```bash
./stack codex login
./stack codex login status
```

로그인 중에만 컨테이너의 `0.0.0.0:1456`에서 Codex의 `127.0.0.1:1455`로 콜백을 전달합니다.
호스트에는 기본적으로 `--publish 127.0.0.1:1455:1456`을 적용합니다.
모델 API가 LAN에 열려 있어도 OAuth 콜백 포트는 호스트 루프백에만 열립니다.
로그인이 완료되거나 실패하거나 중단되면 릴레이가 종료됩니다. 15분을 넘긴 로그인도 종료됩니다.
`--device-auth`, `--with-api-key`, `login status`는 기존 Codex 명령 그대로 실행하며 릴레이를 열지 않습니다.

## 원격 Linux 또는 WSL에서 로그인

브라우저를 실행할 PC에서 먼저 SSH 터널을 열고 유지합니다.

```bash
ssh -N -L 1455:127.0.0.1:1455 USER@SERVER
```

다른 터미널로 같은 서버에 접속해 저장소에서 `./stack codex login`을 실행합니다.
출력된 로그인 주소를 **터널을 연 PC의 브라우저**에서 열어 승인합니다.
브라우저의 `localhost:1455` 콜백이 SSH 터널과 Podman 매핑을 거쳐 컨테이너로 도착합니다.
승인 후 터널을 종료해도 됩니다. 로컬 브라우저 PC의1455포트를 다른 로그인에 사용 중이면 먼저 해당 로그인을 마칩니다.
WSL에서도 브라우저에서 WSL 콜백에 접근할 수 없는 경우 같은 SSH 터널 방식을 사용합니다.

로그인 정보는 기존 `CODEX_HOME=/state/codex`에 유지됩니다.
호스트의 `data/state/codex/auth.json`에 대응하며, 클라이언트 PC의 로그인 파일을 복사하지 않습니다.
릴레이는 콜백 URL이나 토큰을 로그에 남기지 않습니다.

## 포트 변경과 기존 설치 적용

`.env`에서 다른 **호스트** 포트를 지정할 수 있습니다. 주소는 항상 `127.0.0.1`입니다.

```dotenv
CODEX_OAUTH_PORT=2455
```

이 경우 터널은 `ssh -N -L 1455:127.0.0.1:2455 USER@SERVER`로 만듭니다.
여러 배포는 각자 다른 호스트 포트를 지정합니다. 빈 `CODEX_OAUTH_PORT=`는 브라우저 로그인용 포트 게시를 끕니다.

이미 실행 중인 컨테이너의 포트 매핑은 변경할 수 없습니다. 새 코드로 이미지를 빌드하고 컨테이너를
재생성하는 업데이트가 필요합니다. `./stack update --latest`는 현재 코드를 사용해 세 구성요소를 최신
안정 버전으로 갱신합니다. `./stack git-update`는 깨끗한 Git 작업 트리에서 소스 pull도 함께 수행합니다.
로그인 명령은 올바른 포트 매핑이 없으면 재생성이 필요하다는 안내를 출력하고 시작하지 않습니다.
검증용 후보 컨테이너에는 이 호스트 포트를 게시하지 않습니다.

공식 동작: [OpenAI Docs의 headless 인증 및 SSH 콜백 폴백](https://learn.chatgpt.com/docs/auth#fallback-forward-the-localhost-callback-over-ssh).

# TeamClaw

OpenCode 기반의 로컬 AI 에이전트, 당신의 AI 파트너

> **당신의 파트너, 함께.**

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | 한국어

## 주요 기능

- **3단 레이아웃** — 사이드바, 채팅 영역, 상세 패널
- **OpenCode 통합** — 완전한 Agent 기능 지원
- **MCP 지원** — Model Context Protocol, 엔터프라이즈 시스템 연동
- **Skills / 플러그인 확장** — 확장 가능한 스킬 시스템
- **로컬 파일 작업** — 권한 관리가 있는 파일 읽기/쓰기

## UI 스크린샷

### 홈

![TeamClaw 홈](images/home.png)

### 채널

![TeamClaw 채널](images/channel.png)

### 팀

![TeamClaw 팀](images/team.png)

## 기술 스택

- **데스크톱**: Tauri 2.0 (Rust)
- **프론트엔드**: React 19 + TypeScript
- **스타일링**: Tailwind CSS 4
- **상태 관리**: Zustand
- **Agent**: OpenCode
- **에디터**: Tiptap (Markdown/HTML), CodeMirror 6 (코드)
- **Diff**: 커스텀 Diff 렌더러, Shiki 구문 강조

## 설치

[GitHub Releases](https://github.com/different-ai-studio/teamclaw/releases)에서 플랫폼별 설치 패키지를 다운로드하세요 (macOS는 `.dmg`).

### macOS에서 "손상됨" 메시지가 표시될 때

네트워크에서 다운로드하여 설치한 후 앱을 열 때 **"손상됨"** 또는 **"개발자를 확인할 수 없어 열 수 없습니다"** 메시지가 표시되면, macOS 보안 정책(Gatekeeper) 때문입니다. 터미널에서 다음 명령을 실행하여 제한을 해제하면 정상적으로 열 수 있습니다:

```bash
xattr -cr /Applications/TeamClaw.app
```

그 후 TeamClaw를 정상적으로 열 수 있습니다. 리포지토리에 Apple 개발자 서명과 공증이 구성되어 있으면 이 단계가 필요하지 않습니다.

## 개발

### 필수 요구 사항

- Node.js >= 20
- pnpm >= 10
- Rust >= 1.70
- OpenCode CLI

### OpenCode CLI 설치

```bash
# macOS / Linux
curl -fsSL https://opencode.ai/install | bash

# 또는 npm으로 설치
npm install -g opencode
```

### 빠른 시작

```bash
# 1. 의존성 설치
pnpm install

# 2. OpenCode sidecar 바이너리 다운로드 (필수, git에 포함되지 않음)
./src-tauri/binaries/download-opencode.sh

# 3. Tauri 개발 모드 시작
pnpm tauri dev
```

시작 후 TeamClaw 인터페이스에서 Workspace 디렉토리를 선택하세요.

### OpenCode 업데이트

OpenCode는 자주 릴리스되므로 다음 명령으로 언제든 최신 버전으로 업데이트할 수 있습니다:

```bash
pnpm update-opencode
```

이미 최신 버전이면 자동으로 건너뜁니다. 버전 지정도 가능: `pnpm update-opencode -- v1.2.1`

> **개발 모드 (선택사항)**: sidecar를 다운로드하지 않고 OpenCode Server를 별도로 실행할 수도 있습니다:
>
> ```bash
> cd /path/to/your/workspace && opencode serve --port 13141
> OPENCODE_DEV_MODE=true pnpm tauri dev
> ```

## 팀 협업

TeamClaw는 Git 리포지토리를 통한 팀 협업을 지원하며, 팀원들은 Skills, MCP 설정, 지식 베이스를 공유할 수 있습니다.

### 팀 공유 리포지토리 설정

1. **Settings** > **Team** 열기
2. 팀 Git 리포지토리 URL 입력 (HTTPS 또는 SSH 지원)
3. "연결" 버튼 클릭
4. TeamClaw가 자동으로:
   - 로컬 Git 리포지토리 초기화
   - 원격 리포지토리 내용 가져오기
   - 화이트리스트 `.gitignore` 생성 (공유 레이어 디렉토리만 동기화)

### 공유 내용

팀 리포지토리는 다음 내용을 자동 동기화합니다:

- **Skills**: `.agent/skills/` — 공유 Agent 스킬
- **MCP 설정**: `.mcp/` — MCP 서버 설정
- **지식 베이스**: `knowledge/` — 팀 지식 베이스 문서

개인 파일과 작업공간 설정은 동기화되지 않아 개인정보가 보호됩니다.

### 자동 동기화

- 앱 시작 시 최신 내용 자동 동기화
- Settings > Team에서 수동 트리거 가능
- 마지막 동기화 시간 확인 가능

### 참고 사항

- 작업공간에 이미 `.git` 디렉토리가 있으면 사용할 수 없습니다 (충돌 방지)
- Git 인증(SSH 키 또는 HTTPS 토큰) 설정 필요
- 공유 레이어 파일은 원격 리포지토리를 우선하며, 로컬 수정사항은 덮어쓰여집니다

### 개발 명령어

```bash
# 프론트엔드만 시작 (Tauri 없음)
pnpm dev

# 전체 Tauri 앱 시작
pnpm tauri dev

# 또는 별칭 사용
pnpm tauri:dev
```

### 빌드

```bash
pnpm tauri:build
```

### 테스트

#### 단위 테스트

```bash
# 모든 단위 테스트 실행
pnpm test:unit

# 감시 모드로 테스트 실행
pnpm --filter @teamclaw/app test:unit --watch
```

#### E2E 테스트 (Tauri-mcp)

E2E 테스트는 `tauri-mcp`를 사용하여 실행 중인 Tauri 앱과 상호작용하며, 네이티브 UI 자동화를 제공합니다.

**필수 조건:**

- `tauri-mcp` 설치: `cargo install tauri-mcp`
- Tauri 앱 빌드: `pnpm tauri:build`

**E2E 테스트 실행 (저장소 루트에서; Tauri 빌드 및 tauri-mcp 필요):**

```bash
# 전체 E2E 실행
pnpm test:e2e

# 카테고리별
pnpm test:e2e:regression
pnpm test:e2e:performance
pnpm test:e2e:e2e
pnpm test:e2e:functional

# Smoke만
pnpm test:smoke
```

자세한 내용은 `[packages/app/e2e/README.md](./packages/app/e2e/README.md)` 및 `tests/` 참조.

## 프로젝트 구조

```
teamclaw/
├── packages/
│   └── app/                 # React 프론트엔드
│       └── src/
│           ├── components/
│           │   ├── editors/      # 파일 에디터
│           │   ├── diff/         # Diff 렌더러
│           │   └── ...           # 기타 UI 컴포넌트
│           ├── hooks/
│           ├── lib/
│           ├── stores/
│           └── styles/
├── src-tauri/              # Tauri 백엔드
│   └── src/
│       └── commands/       # Rust 명령
├── doc/                    # 문서
└── package.json
```

## 에디터 아키텍처

파일 에디터는 파일 타입에 따라 전문 에디터로 라우팅됩니다:

- **Markdown 파일** (`.md`, `.mdx`): Tiptap WYSIWYG 에디터, Markdown 확장, 미리보기 전환, 클립보드 이미지 붙여넣기/업로드 지원
- **HTML 파일** (`.html`, `.htm`): Tiptap HTML 에디터, 샌드박스 iframe 미리보기
- **코드 파일** (기타): CodeMirror 6, 구문 강조, 줄 번호, 코드 접기, Git gutter 장식

### Diff 렌더러

커스텀 Diff 렌더러는 Agent 우선 코드 리뷰 경험을 제공합니다:

- unified diff를 구조화된 AST(파일 > hunk > 줄)로 파싱
- 줄 수준, hunk 수준, 파일 수준 선택 지원
- Agent 채팅과 통합, "Agent에게 보내기"로 Review, Explain, Refactor, Generate Patch 지원
- 대용량 diff 가상 스크롤 (IntersectionObserver 기반 지연 렌더링)
- Shiki를 통한 구문 강조, 온디맨드 언어 로드

## License

MIT

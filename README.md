# Tomcat for VSCode

VSCode에서 로컬 Apache Tomcat 서버를 등록·배포·실행/디버그하고, JSP·Java 코드를 저장 즉시 반영해서 확인할 수 있게 해주는 확장 프로그램입니다.

## 빠른 시작

1. 사이드바(액티비티바의 Tomcat 아이콘, 또는 탐색기 하단 "TOMCAT SERVERS")에서 **+** → Tomcat 설치 폴더(`CATALINA_HOME`) 선택.
2. 서버 우클릭 → **Deploy WAR...** 또는 **Deploy Exploded Folder...** 로 애플리케이션 등록.
   - Maven/Gradle 프로젝트라면 이때 **라이브 리로드**를 켤지 물어봅니다 (아래 참고).
3. 서버의 ▶ (Start) 또는 🐞 (Debug) 클릭.
4. 배포된 앱 우클릭 → **Open in Browser** 로 확인.
5. 코드를 수정하면 대부분 저장 즉시(또는 아주 짧은 지연 후) 자동으로 반영됩니다.

## 서버 관리

- **서버 등록**: 로컬 Apache Tomcat(`CATALINA_HOME`) 폴더를 등록해 사이드바에서 관리합니다.
- **시작 / 디버그 / 중지 / 재시작**: 클릭 한 번으로 제어. 디버그는 JPDA(기본 포트 8000)로 실행되며, VSCode Java 디버거(**Debugger for Java** 확장 필요)가 자동으로 attach됩니다.
- **실행 상태 표시**: 서버·앱 옆에 `●`(실행/디버그 중) / `◐`(전환 중) / `○`(중지됨) 로 한눈에 확인. 서버가 완전히 기동되면 알림도 뜹니다.
- **콘솔 로그**: 서버별 Output 채널로 실시간 확인. Start/Debug 시 자동으로 열립니다.
- **VSCode 종료 시 자동 정리**: 정상 종료 시 실행 중이던 Tomcat 프로세스에 종료 신호를 보냅니다(강제 종료 시에는 보장되지 않음).

## 배포

- **Deploy WAR...**: `.war` 파일을 `webapps/` 로 복사합니다.
- **Deploy Exploded Folder...**: 빌드 출력 폴더(`WEB-INF` 포함)를 가리키는 컨텍스트 XML을 생성합니다.
  - 폴더 안에 `META-INF/context.xml`이 있으면 자동 감지해 `path`/`Resource`/`Environment` 등을 그대로 쓸지 물어봅니다.
- **Undeploy**: 배포 항목과 관련 파일을 정리합니다.
- **전체 재시작 없는 반영**: 배포·Undeploy는 Tomcat 자체의 `autoDeploy` 가 처리합니다 — 서버가 실행 중이면 보통 수 초~15초 내로 그 앱만 배포/제거되고, 다른 앱이나 서버 프로세스 자체에는 영향 없습니다.
- **기본 웹앱 제외** (기본 켜짐, `tomcat.excludeDefaultWebapps`): `ROOT`/`docs`/`examples`/`host-manager` 를 자동 배포에서 제외합니다. `manager` 는 "Reload Context Now" 에 필요해 제외 대상에서 빠집니다.
- **멀티 컨텍스트**: 서버 하나에 여러 앱을 원하는 만큼 배포할 수 있습니다.

## 라이브 리로드 (Maven/Gradle)

빌드 산출물 폴더(`target/<artifactId>` 등)를 exploded로 배포할 때, 소스 웹앱 폴더(기본 `src/main/webapp`, `tomcat.webappSourceDir` 로 변경 가능)를 자동 감지해서 라이브 리로드를 켤지 물어봅니다.

| 변경 종류 | 반영 방식 |
|---|---|
| JSP / HTML / CSS / JS | 소스 폴더를 계속 감시하다가 저장 즉시 배포 폴더로 복사 |
| Java 클래스 / 리소스 (컴파일 후) | `target/classes`(또는 Gradle의 `build/classes`+`build/resources`)를 감시하다가 변경 즉시 `WEB-INF/classes` 로 복사 |
| 메서드 **본문**만 수정 (디버그 모드) | VSCode Java 디버거의 핫스왑으로 즉시·조용히 반영 |
| 필드/메서드/클래스 **추가** 같은 구조적 변경 | 자동 반영 안 됨 → **Reload Context Now** 로 수동 반영 |

**이 확장은 `mvn`/`gradle`을 직접 실행하지 않습니다** (단, 아래 "시작 전 빌드"/"Build Now" 두 가지 예외는 있음). 컴파일은 VSCode의 Java 자동 빌드(저장 시), 터미널의 수동 빌드, 다른 도구 등 기존 빌드 체계가 담당하고, 이 확장은 그 산출물을 감시해서 복사만 합니다 — PATH·인코딩·JDK 버전 문제가 생길 여지가 없습니다.

**자동 컨텍스트 리로드 켜기/끄기** (`reloadable`): 라이브 리로드를 켤 때 이 앱을 보통 디버그 모드로 쓰는지 물어봅니다.
- **디버거로 실행** → 자동 리로드 끄기 권장. 메서드 본문 변경은 핫스왑, 구조적 변경만 수동 리로드.
- **디버거 없이 실행** → 자동 리로드 켜기. 클래스 변경마다 Tomcat이 컨텍스트를 통째로 다시 로드합니다(세션 등 상태 초기화, 다소 무거움).
- 배포된 앱 우클릭 → **Toggle Auto Context Reload** 로 언제든 전환 가능. `META-INF/context.xml`에서 감지한 리소스 설정은 전환해도 유지됩니다.

**빌드 관련 명령**:
- **시작 전 빌드** (`tomcat.buildBeforeStart`, 기본 켜짐): Tomcat이 뜨기 직전 딱 한 번 컴파일을 실행하고 기다립니다. 실패해도 경고만 남기고 계속 시작됩니다.
- **Build Now (mvn/gradle)**: 배포된 앱 우클릭 → 언제든 수동으로 빌드 + `WEB-INF/classes` 동기화를 한 번에 실행.
- **Force Resync Classes Now**: 빌드는 안 하고, 지금 있는 산출물만 다시 동기화.
- 둘 다 서버의 **Set Java Home** 과 같은 JDK로 실행되고, `tomcat.mavenCommand`/`tomcat.gradleCommand` 로 명령(래퍼 경로 등)을 바꿀 수 있습니다.

## 즉시 리로드 (Reload Context Now)

배포된 앱 우클릭 → **Reload Context Now (No Restart)** 로 Tomcat **Manager API** 를 통해 그 컨텍스트만 1~2초 내에 다시 로드합니다(전체 서버 재시작 없음).

- 최초 사용 시 `conf/tomcat-users.xml`에 `manager-script` 권한의 전용 계정을 자동 생성합니다(비밀번호는 VSCode SecretStorage에만 저장). 활성화에 처음 한 번만 서버 재시작이 필요합니다.
- Tomcat 배포판에 `webapps/manager` 가 포함되어 있어야 합니다(표준 전체 배포판은 기본 포함).
- 인증 실패(401) 시 서버 우클릭 → **Reset Manager Credentials...** 로 계정을 새로 만들 수 있고, "Reload Context Now" 실행 중 401이 뜨면 같은 동작을 바로 제안합니다.
- 응답 대기 시간은 기본 45초이며 `tomcat.managerRequestTimeoutSeconds` 로 조정 가능합니다(빈이 많은 큰 애플리케이션은 리로드 자체가 오래 걸릴 수 있음).

## 핫스왑 실패 알림

디버그 모드에서 저장 시 VSCode Java 디버거가 자체적으로 핫스왑을 시도합니다. 실패한 것으로 보이면(구조적 변경일 때 흔함) 알림으로 안내하고 "Reload Context Now" 를 제안합니다. Java 디버거의 정확한 내부 이벤트 스펙까지는 확정할 수 없어 패턴 매칭 기반 best-effort 감지이며, 원본 이벤트는 출력 채널에도 기록됩니다.

## 서버별 설정

모두 서버 우클릭 메뉴에서 조정하며, 값은 `settings.json`의 `tomcat.servers` 에 저장됩니다(사이드바 상단 톱니바퀴 아이콘 또는 **Tomcat: Open Settings** 로 확인).

| 항목 | 명령 | 비고 |
|---|---|---|
| HTTP/디버그 포트 | Edit Ports | 다음 시작 시 적용, 실행 중이면 자동 재시작 |
| JAVA_HOME | Set Java Home... | 다음 시작 시 적용, 실행 중이면 자동 재시작 |
| 로그 레벨 | Set Log Level... | `conf/logging.properties` 갱신, 다음 시작 시 적용 |
| VM 옵션 | Edit VM Options... | `CATALINA_OPTS` 에 추가, 다음 시작 시 적용 |

## 전역 설정 (`tomcat.*`)

| 설정 | 기본값 | 설명 |
|---|---|---|
| `defaultLogLevel` | `INFO` | 서버별로 지정 안 했을 때의 기본 로그 레벨 |
| `webappSourceDir` | `src/main/webapp` | 라이브 리로드 웹앱 소스 자동 감지 경로 |
| `javaAutoBuild` | `true` | 컴파일 산출물 → `WEB-INF/classes` 자동 미러링 여부 |
| `buildBeforeStart` | `true` | Tomcat 시작 전 1회 빌드 실행 여부 |
| `mavenCommand` / `gradleCommand` | `mvn` / `gradle` | 빌드에 사용할 명령(래퍼 자동 감지) |
| `excludeDefaultWebapps` | `true` | 기본 번들 웹앱 자동 배포 제외 여부 |
| `managerRequestTimeoutSeconds` | `45` | Manager API 요청 타임아웃(초) |

## 요구 사항

- Apache Tomcat 로컬 설치 (https://tomcat.apache.org/)
- Java 디버깅에는 VSCode **Debugger for Java** (`vscjava.vscode-java-debug`, 보통 Extension Pack for Java에 포함) 필요
- macOS/Linux는 `bin/catalina.sh` 실행 권한 필요(확장이 자동으로 `chmod +x` 시도)

## 알려진 제한 사항

- 원격 Tomcat 서버는 지원하지 않습니다(로컬 설치만 대상).
- 라이브 리로드 자동 감지는 `src/main/webapp` 관례를 따르는 단일/단순 다중 모듈 프로젝트 기준입니다. 복잡한 커스텀 구조에서는 자동 감지가 안 될 수 있으며, 이 경우 폴더를 직접 선택하면 됩니다.
- 라이브 소스 동기화는 파일을 있는 그대로 복사합니다. Maven 리소스 필터링(`${...}` 치환)처럼 빌드 중 파일 내용이 가공되는 프로젝트는 가공 전 원본이 복사될 수 있습니다 — 이런 경우 오버레이를 끄고 필요할 때만 재배포하세요.
- 컨텍스트 리로드 시 애플리케이션이 만든 스레드(예: `ScheduledThreadPoolExecutor`)가 제대로 정리되지 않으면 Tomcat이 "probable memory leak" 경고를 남길 수 있습니다. Tomcat 자체의 제약이며, 애플리케이션 쪽에서 `@PreDestroy`/`contextDestroyed` 로 정리하면 해결됩니다.
- Java 저장 후 "Applying code changes" 지연은 VSCode의 **Debugger for Java** 확장 자체 기능이라 이 확장에서 손볼 수 있는 부분이 아닙니다. Windows 백신 예외 목록에 프로젝트/JDK 폴더를 추가하면 개선되는 경우가 많습니다.

지난 버전에서 수정된 이슈(데이터 손실 버그 등)는 [CHANGELOG.md](./CHANGELOG.md) 를 참고하세요.

## 개발자용: 빌드 & 패키징

```bash
npm install
npm run compile
```

VSCode에서 이 폴더를 열고 `F5` 로 확장 개발 호스트를 실행하면 바로 테스트할 수 있습니다.

```bash
npm install -g @vscode/vsce
vsce package
```

생성된 `.vsix` 는 VSCode의 "Extensions: Install from VSIX..." 로 설치합니다.

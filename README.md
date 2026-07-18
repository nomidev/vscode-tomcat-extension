# Tomcat for VSCode

IntelliJ IDEA의 Tomcat 통합과 유사한 경험을 VSCode에서 제공하는 확장 프로그램입니다.

## 기능

- **서버 등록**: 로컬에 설치된 Apache Tomcat(`CATALINA_HOME`) 폴더를 등록해 사이드바에서 관리합니다. 액티비티바의 전용 Tomcat 아이콘, 또는 VSCode 기본 **탐색기(Explorer)** 사이드바 하단의 "TOMCAT SERVERS" 섹션 — 둘 중 편한 쪽에서 접근할 수 있습니다(같은 데이터를 보여줍니다).
- **시작 / 디버그 / 중지 / 재시작**: 사이드바 아이콘 클릭 한 번으로 제어합니다. 디버그 모드는 JPDA(포트 기본값 8000)로 실행되며, 시작 배너가 감지되면 자동으로 VSCode Java 디버거(`Debugger for Java` 확장 필요)가 attach 됩니다.
- **멀티 컨텍스트 배포**: 서버 하나에 여러 애플리케이션(컨텍스트)을 동시에 배포할 수 있습니다. WAR/exploded 를 원하는 만큼 반복 등록하면 사이드바 트리에 모두 나열됩니다.
- **배포**
  - **Deploy WAR...**: `.war` 파일을 선택하면 `webapps/` 로 복사됩니다.
  - **Deploy Exploded Folder...**: `WEB-INF` 를 포함한 빌드 출력 폴더를 그대로 가리키는 `context.xml`(`conf/Catalina/localhost/<app>.xml`, `docBase` 지정)을 생성합니다. IntelliJ의 "Artifact (exploded)" 배포처럼, 파일을 다시 빌드하면 war 재복사 없이 즉시 반영됩니다(`reloadable="true"`).
    - 선택한 폴더 안에 `META-INF/context.xml` 이 있으면 자동으로 감지하여, 그 안에 정의된 컨텍스트 경로(`path`)와 속성(`Resource`, `Environment` 등 하위 엘리먼트 포함)을 그대로 사용할지 직접 입력할지 선택할 수 있습니다.
    - **Maven/Gradle 프로젝트 라이브 리로드**: `target/<artifactId>`(Maven) 또는 `build/exploded-<name>` 등(Gradle)처럼 빌드 산출물 폴더를 배포 대상으로 선택하면, 프로젝트 루트(`pom.xml`/`build.gradle`/`build.gradle.kts`/`settings.gradle(.kts)` 중 하나가 있는 가장 가까운 상위 폴더)를 기준으로 `src/main/webapp`(Maven·Gradle war 플러그인 공통 기본값)을 자동 감지하여 활성화할지 물어봅니다.
      - **복사가 아니라 링크**: 활성화하면 JSP/HTML/CSS/JS 파일을 복사하는 대신 **디렉터리 정션/심볼릭 링크(Windows는 junction, macOS/Linux는 symlink)** 로 소스 폴더를 배포 폴더에 그대로 연결합니다. 실제로 소스 폴더의 파일을 직접 가리키므로, 저장하는 즉시 별도의 복사·워처 지연 없이 바로 반영됩니다. 링크 생성이 불가능한 환경에서는 자동으로 하드링크 → 복사 순으로 대체됩니다. `WEB-INF/classes`, `WEB-INF/lib` 는 항상 빌드 산출물 그대로 유지되고 절대 링크되지 않습니다.
      - **Java/XML(리소스) 변경도 자동 반영 — 단, 이 확장은 `mvn`/`gradle` 을 직접 실행하지 않습니다.** 대신 Maven의 `target/classes`, Gradle의 `build/classes/java/main`+`build/resources/main` 처럼 **이미 컴파일된 산출물 폴더**를 계속 감시하다가, 그 폴더에 뭔가 쓰여지는 즉시 배포된 `WEB-INF/classes` 로 그대로 복사합니다. 실제 컴파일은 VSCode의 Java 언어 서버가 파일을 저장할 때마다 하는 자동 빌드(Eclipse JDT 기반, 기본적으로 켜져 있음)가 담당하며, 터미널에서 직접 `mvn`/`gradle` 을 돌리거나 다른 IDE로 빌드해도 똑같이 감지되어 반영됩니다. `mvn` 실행 파일 PATH 문제나 콘솔 인코딩 문제 자체가 생기지 않습니다.
      - **자동 컨텍스트 리로드는 선택할 수 있습니다 (`reloadable`)**: 라이브 리로드를 켤 때, 이 앱을 보통 **디버그 모드로 실행**하는지 **일반 실행**하는지 물어봅니다.
        - **디버거로 실행 (자동 리로드 끄기 권장)**: WEB-INF/classes 가 바뀔 때마다 Tomcat이 컨텍스트 전체를 파괴·재생성하지 않습니다. 대신 메서드 **본문만** 바뀐 경우 디버거(JPDA)가 조용히·즉시 핫스왑하고, 필드·메서드·클래스 **추가** 같은 구조적 변경만 **"Reload Context Now"** 로 수동 반영하면 됩니다.
        - **디버거 없이 실행 (자동 리로드 켜기)**: 핫스왑을 해줄 디버거가 없으니, 클래스가 바뀔 때마다 Tomcat이 컨텍스트를 자동으로 다시 로드해야 변경사항이 보입니다(세션 등 상태 초기화, 다소 무거움) — 그래도 모든 변경이 자동으로 반영됩니다.
        - 나중에 언제든 배포된 앱 우클릭 → **"Toggle Auto Context Reload"** 로 전환할 수 있습니다. 원래 `META-INF/context.xml` 에서 감지된 `<Resource>`/`<Environment>`(예: JNDI DataSource) 는 리로드 방식을 바꿔도 그대로 유지됩니다.
      - 표준 경로가 아닌 경우(예: Gradle에서 `war { webAppDirName = "..." }` 로 커스텀 설정) `tomcat.webappSourceDir` 설정으로 웹앱 소스 자동 감지 경로를 바꿀 수 있고, 자동 감지가 안 되더라도 항상 폴더를 직접 선택할 수 있습니다.
      - 아직 `target/classes` 등이 없거나(한 번도 빌드 안 한 경우) 갱신이 안 되는 것 같으면, 배포된 앱 우클릭 → **"Force Resync Classes Now"** 로 지금 있는 내용을 즉시 다시 동기화해볼 수 있습니다. `tomcat.javaAutoBuild` 설정으로 이 기능 전체를 끌 수 있습니다.
      - 이미 배포된 앱은 우클릭 → **"Enable Live Source Reload (Maven/Gradle)..."** 로 나중에 켜거나 끌 수 있습니다.
- **Undeploy**: 배포된 앱을 목록에서 제거하고 관련 파일/설정을 정리합니다.
- **전체 재시작 없는 반영**: WAR/exploded 배포·Undeploy는 Tomcat 자체의 `autoDeploy` 기능이 처리합니다 — 서버가 실행 중이면 새로 생기거나 바뀌거나 지워진 배포 파일을 Tomcat이 백그라운드에서 주기적으로(보통 수 초~15초 내) 감지해 **그 앱만** 배포/재로드/제거합니다. 이 확장은 더 이상 배포할 때마다 Tomcat 프로세스 전체를 재시작하지 않습니다(다른 실행 중인 앱에도 영향 없음, JVM 재기동 대기 시간도 없음).
- **즉시 리로드 (Reload Context Now)**: 라이브 리로드가 켜진 앱은 자동 컨텍스트 리로드가 꺼져있으므로(위 참고), 필드·메서드·클래스 추가처럼 디버거 핫스왑이 처리 못 하는 구조적 변경을 반영하려면 이 명령이 필요합니다. 배포된 앱을 우클릭 → **"Reload Context Now (No Restart)"** 로 Tomcat **Manager API**를 통해 그 컨텍스트만 1~2초 내에 다시 로드합니다(전체 서버 재시작 없음). 라이브 리로드를 안 쓰는 일반 WAR 배포 등은 여전히 Tomcat의 `autoDeploy` 가 새/변경/삭제된 배포를 백그라운드에서 자동으로 처리합니다. IntelliJ의 Tomcat 통합이 서버를 재시작하지 않고 개별 배포를 갱신하는 것과 같은 방식입니다. 최초 사용 시 `conf/tomcat-users.xml`에 `manager-script` 권한을 가진 전용 계정을 자동 생성하며(비밀번호는 VSCode SecretStorage에만 저장, `settings.json`에는 절대 기록되지 않습니다), 이 계정이 활성화되려면 처음 한 번만 서버 재시작이 필요합니다(안내 메시지에서 바로 재시작할 수 있습니다). 이후로는 재시작 없이 계속 즉시 리로드를 사용할 수 있습니다. Tomcat 배포판에 `webapps/manager` 가 포함되어 있어야 합니다(표준 전체 배포판은 기본 포함). 인증에 실패(401)하면 서버 우클릭 → **"Reset Manager Credentials..."** 로 계정을 새로 만들고 재시작하면 됩니다 — "Reload Context Now" 실행 중 401이 뜨면 같은 동작을 바로 제안합니다.
- **콘솔 로그**: 서버별 Output 채널로 `catalina.out` 스트림을 실시간으로 확인합니다. Start/Debug 실행 시 로그 패널이 자동으로 열립니다.
- **브라우저에서 열기**: 배포된 앱 컨텍스트를 바로 `http://localhost:<port>/<context>/` 로 엽니다.
- **포트 편집**: HTTP 포트와 디버그(JPDA) 포트를 서버별로 설정합니다.
- **Java 버전(JAVA_HOME) 설정**: 서버 우클릭 → **Set Java Home...** 으로 이 Tomcat 인스턴스가 사용할 JDK 폴더를 지정할 수 있습니다(설정하지 않으면 시스템 기본 JAVA_HOME 사용). 여러 서버마다 다른 JDK를 지정해 IntelliJ처럼 서버별 Java 버전을 분리할 수 있습니다.
- **기본 웹앱 제외 (기본 켜짐)**: 서버 시작 시 `conf/server.xml` 의 `<Host>` 에 `deployIgnore` 속성을 추가해서 Tomcat 번들 기본 앱(`ROOT`, `docs`, `examples`, `host-manager`)이 아예 실행되지 않게 합니다. `manager` 앱은 "Reload Context Now" 에 필요해서 제외 대상에서 빠집니다. 이미 `deployIgnore` 를 직접 설정해뒀다면 덮어쓰지 않습니다. `tomcat.excludeDefaultWebapps` 설정으로 끌 수 있습니다.
- **로그 레벨 설정**: 서버 우클릭 → **Set Log Level...** 으로 `SEVERE / WARNING / INFO / CONFIG / FINE / FINER / FINEST` 중 선택합니다. 서버별로 지정하지 않으면 `tomcat.defaultLogLevel` 설정값을 사용합니다. 서버 시작 시 `conf/logging.properties` 의 루트 로거 및 콘솔/파일 핸들러 레벨을 자동으로 갱신해서 적용합니다.
- **VM(JVM) 옵션 설정**: 서버 우클릭 → **Edit VM Options...** 으로 `-Xms256m -Xmx1024m -Dspring.profiles.active=local` 같은 JVM 옵션을 지정할 수 있습니다. 서버 시작 시 `CATALINA_OPTS` 에 추가되어 전달됩니다(기존 환경변수의 `CATALINA_OPTS` 가 있다면 뒤에 이어붙입니다).
- **VSCode 종료 시 서버 자동 종료**: VSCode 창/앱을 정상적으로 닫으면 확장이 비활성화되면서 실행 중이던 모든 Tomcat 프로세스에 자동으로 종료 신호(SIGTERM)를 보내고, JVM 종료 훅이 처리할 시간을 잠깐 기다립니다. 강제 종료(kill -9, 작업 관리자로 강제 종료 등)처럼 비정상적으로 VSCode 프로세스 자체가 즉시 죽는 경우에는 이 훅이 실행되지 않아 Tomcat이 남아있을 수 있습니다 — 이 경우 별도로 프로세스를 종료해주세요.
- **VSCode 설정에서 확인/편집**: 등록된 서버 목록, 포트, JAVA_HOME, 로그 레벨, 배포된 앱까지 모든 설정이 `settings.json`의 `tomcat.servers` / `tomcat.defaultLogLevel` 에 저장됩니다. 사이드바 상단의 톱니바퀴 아이콘(또는 **Tomcat: Open Settings**) 을 누르면 Settings UI에서 바로 확인할 수 있습니다.

## 요구 사항

- Apache Tomcat이 로컬에 설치되어 있어야 합니다 (다운로드: https://tomcat.apache.org/).
- Java 디버깅을 사용하려면 VSCode의 **Debugger for Java** (`vscjava.vscode-java-debug`, 보통 Extension Pack for Java에 포함) 확장이 설치되어 있어야 합니다.
- macOS/Linux에서는 `bin/catalina.sh` 에 실행 권한이 필요합니다(확장이 자동으로 `chmod +x` 를 시도합니다).

## 빌드 및 실행 (개발자용)

```bash
npm install
npm run compile
```

VSCode에서 이 폴더를 열고 `F5`를 눌러 확장 개발 호스트(Extension Development Host)를 실행하면 바로 테스트할 수 있습니다.

## 배포용 vsix 패키징

```bash
npm install -g @vscode/vsce
vsce package
```

생성된 `.vsix` 파일은 VSCode의 "Extensions: Install from VSIX..." 명령으로 설치할 수 있습니다.

## 사용 흐름

1. 사이드바에서 **+** (Add Server) → Tomcat 설치 폴더 선택 → 이름 지정.
2. 서버 우클릭(또는 인라인 아이콘) → **Deploy WAR...** 또는 **Deploy Exploded Folder...** 로 애플리케이션 등록.
3. 서버의 ▶ (Start) 또는 🐞 (Debug) 아이콘 클릭.
4. 배포된 앱 우클릭 → **Open in Browser** 로 확인.
5. 코드를 수정한 뒤 exploded 배포는 재빌드만으로, WAR 배포는 다시 **Deploy WAR...** 로 반영됩니다 — 서버가 실행 중이면 Tomcat 이 자동으로 감지해 배포하며(수 초 내), 그마저 기다리기 싫으면 앱 우클릭 → **Reload Context Now** 로 즉시 반영할 수 있습니다.
6. 필요하면 서버 우클릭 → **Set Log Level...** 로 로그 레벨을 조정하고, 사이드바 상단 톱니바퀴 아이콘으로 현재 설정을 `settings.json` 에서 확인합니다.

## 설정 저장 위치

이 확장의 모든 서버 설정(`tomcat.servers`)과 기본 로그 레벨(`tomcat.defaultLogLevel`)은 VSCode의 **User Settings**(`settings.json`)에 저장됩니다. `Ctrl/Cmd+,` 로 설정을 열고 "tomcat" 으로 검색하면 현재 등록된 서버들과 각 서버의 포트/JAVA_HOME/로그 레벨/배포된 앱을 확인할 수 있습니다. 이전 버전(0.1.0 이전)에서 사용하던 내부 저장소 데이터는 최초 실행 시 자동으로 새 설정 형식으로 마이그레이션됩니다.

## 알려진 제한 사항

- 원격 Tomcat 서버 연결은 아직 지원하지 않습니다(로컬 설치만 대상).
- Maven/Gradle 자체 빌드(`mvn compile`, `gradle classes` 등)는 이 확장이 실행하지 않습니다. VSCode의 Java 자동 빌드(저장 시), 터미널에서의 수동 빌드, 다른 도구 등으로 `target/classes`(또는 `build/classes`, `build/resources`)가 갱신되어야 하며, 이 확장은 그 결과물을 감시해서 `WEB-INF/classes` 로 미러링만 합니다. 필드/메서드/클래스 추가처럼 Java 디버거(JPDA)의 핫스왑이 지원하지 않는 구조적 변경은 Tomcat의 컨텍스트 재로드(자동, 또는 "Reload Context Now")가 필요합니다.
- 라이브 소스 오버레이 자동 감지는 `src/main/webapp` 관례(설정으로 변경 가능)를 따르는 단일/단순 다중 모듈 프로젝트를 기준으로 합니다. 복잡한 커스텀 빌드 구조에서는 자동 감지가 안 될 수 있으며, 이 경우 폴더를 직접 선택하면 됩니다.
- 라이브 소스 동기화는 소스 폴더의 파일을 있는 그대로 docBase 에 복사합니다. Maven 리소스 필터링(`<filtering>true</filtering>` 로 `web.xml` 등에서 `${...}` 치환을 사용하는 경우)처럼 빌드 과정에서 파일 내용이 가공되는 프로젝트라면, 가공 전 원본이 그대로 복사되어 치환이 적용되지 않을 수 있습니다. 이런 경우는 오버레이를 끄고 필요할 때만 재배포하는 방식을 권장합니다.
- 0.1.0 초기 버전에서는 Tomcat의 `<Resources><PreResources>` 기능으로 오버레이를 구현했으나, 일부 Tomcat 8.0.x 빌드에서 `DirResourceSet` NullPointerException 으로 컨텍스트 시작이 실패하는 문제가 있어 파일 동기화 방식으로 교체했습니다. 이전 버전에서 이미 배포한 앱에 예전 방식의 `<Resources>` 블록이 남아있다면, 그 앱을 우클릭 → **Enable Live Source Reload (Maven/Gradle)...** 를 다시 실행해 정리하세요.
- **"Reload Context Now" 사용 중 401 Unauthorized**: 저장된 Manager 계정 정보가 실제 `conf/tomcat-users.xml` 내용과 어긋난 경우입니다(수동으로 그 파일을 편집했거나, 이전 시도 중 파일이 예상과 다르게 바뀐 경우 등). 이런 경우 확장이 자동으로 "자격 증명 초기화 후 재시작"을 제안합니다 — 수락하면 새 계정을 만들고 서버를 재시작하며, 이후부터 다시 정상 동작합니다. 수동으로 하려면 서버 우클릭 → **Reset Manager Credentials...**.
- **컨텍스트 리로드(Reload Context Now / 자동 리로드) 시 "probable memory leak" 경고**: 애플리케이션이 만든 `ScheduledThreadPoolExecutor` 등 백그라운드 스레드가 컨텍스트 종료 시점에 제대로 정리되지 않으면 Tomcat이 이런 경고를 남깁니다. Tomcat 자체의 알려진 제약(리로드는 애플리케이션이 만든 스레드까지 강제로 죽이지는 못함)이라 이 확장이 직접 고칠 수 있는 부분은 아니며, 애플리케이션 쪽에서 `@Scheduled`/`ThreadPoolTaskExecutor`/커스텀 `ScheduledExecutorService` 등을 `@PreDestroy`나 `ServletContextListener#contextDestroyed` 에서 확실히 `shutdown()` 하도록 정리하면 사라집니다. 개발 세션 중 리로드를 아주 여러 번 반복하면 누수가 누적될 수 있으니, 오래 켜두고 작업할 때는 가끔 서버를 완전히 재시작해 초기화해주는 것도 방법입니다.

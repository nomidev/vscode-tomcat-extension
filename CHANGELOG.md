# Changelog

## 0.10.x
- 라이브 소스/클래스 동기화 로그가 파일 변경마다 한 줄씩 찍혀 출력 채널이 너무 시끄러웠던 문제 수정: 짧은 시간(약 250ms) 안에 몰린 변경을 모아서 한 줄 요약으로 출력하도록 변경.

## 0.9.x
- 빌드 명령 체이닝 버그 수정: `chcp` 실패 시 `&&` 때문에 뒤따르는 `mvn`/`gradle` 자체가 실행되지 않던 문제 (`&`로 변경, Windows System32 PATH 방어적 보강).
- 배포된 앱 우클릭 → **Build Now (mvn/gradle)** 추가: Maven/Gradle 자동 감지 후 수동으로 빌드 트리거.
- **시작 전 빌드**(`tomcat.buildBeforeStart`, 기본 켜짐): 라이브 리로드가 켜진 Maven/Gradle 앱은 Tomcat 기동 직전 컴파일을 한 번 실행.
- 핫스왑 실패 감지 시 알림 및 "Reload Context Now" 제안 (best-effort).
- "Reload Context Now" 등 Manager API 요청 타임아웃을 8초 → 45초로 상향, `tomcat.managerRequestTimeoutSeconds` 로 조정 가능하게 변경.

## 0.8.0
- **(중요, 데이터 손실 수정)** 라이브 소스 리로드가 디렉터리 정션/심볼릭 링크로 소스 폴더를 배포 폴더에 직접 연결하던 방식을 되돌림: Windows에서 `mvn clean` 실행 시 일부 재귀 삭제 로직이 정션을 통과해 실제 `src/main/webapp` 파일을 지우는 문제가 있어, 파일 복사 방식으로 전환.

## 0.7.x
- Tomcat 7+ 컨텍스트 XML의 `path` 속성이 무시되고 경고를 유발하는 문제 수정 (파일명으로만 경로 결정).
- README에서 IntelliJ 관련 문구 정리.

## 0.6.x
- "Toggle Auto Context Reload" 등 설정 변경 후 실행 중인 서버에 실제로 반영되지 않던 버그 수정 (`ensureContextReloaded` 로직 통합).
- 디버거가 stdout 청크 분리로 인해 attach되지 않던 버그 수정 (누적 버퍼 + 안전장치 attach).
- `Edit Ports`/`Set Java Home` 변경 후 재시작이 누락되던 문제 수정.
- context.xml 생성 시 XML 특수문자 이스케이프 추가.
- AJP 커넥터 자동 비활성화 기능 추가 후 원복 (사용자 요청).

## 0.5.x
- Java/리소스 자동 빌드에서 `mvn`/`gradle` 직접 실행을 완전히 제거하고, 이미 컴파일된 산출물(`target/classes` 등)을 감시해 `WEB-INF/classes` 로 미러링하는 방식으로 전환 (PATH/인코딩/JDK 버전 문제 회피).
- 배포/undeploy 시 Tomcat 프로세스 전체 재시작 제거, Tomcat 자체 `autoDeploy` 에 위임. "Reload Context Now"(Manager API) 추가.

## 0.4.x
- Tomcat의 `<Resources><PreResources>` 오버레이 방식이 일부 8.0.x 빌드에서 `DirResourceSet` NullPointerException 을 유발해 파일 동기화 방식으로 교체.
- Maven/Gradle 자동 감지, `tomcat.webappSourceDir` 설정 추가.

## 0.1.0 – 0.3.x
- 서버 등록/시작/중지/디버그, WAR·exploded 배포, 로그 레벨/VM 옵션/JAVA_HOME 설정, VSCode 설정(`settings.json`) 기반 저장 등 기본 기능 구축.

# Changelog

## 0.14.1
- **"Deploy Exploded Folder"에서 이미 빌드된 앱을 안 빌드된 것으로 잘못 판단하던 문제 수정**: 프로젝트 루트 폴더(WEB-INF 없음)를 선택하면 무조건 "아직 빌드 안 됨"으로 취급해 새로 빌드를 제안했는데, 정작 `target/`(Maven) 등에 이미 빌드된 결과물이 있어도 확인하지 않았습니다. 이제 프로젝트 루트를 선택하면 먼저 기존 빌드 결과물이 있는지 찾아보고, 있으면 "기존 빌드 사용" / "다시 빌드" 중에서 고를 수 있습니다.

## 0.14.x
- **Deploy Exploded Folder: 안 빌드된 프로젝트면 자동 빌드**: 지금까지는 반드시 이미 빌드된(WEB-INF 포함) exploded 폴더를 선택해야 했습니다. 이제 아직 안 빌드된 Maven/Gradle 프로젝트 폴더를 선택해도, 감지된 프로젝트를 그 자리에서 빌드해서(Maven: `war:exploded`, Gradle: `war` 빌드 후 압축 해제) 자동으로 exploded 배포에 등록합니다. 빌드 로그는 별도 "Tomcat: Build (...)" 출력 채널에 표시됩니다.
- **앱 상태가 배포 완료 전에 "실행 중"으로 잘못 표시되던 문제 수정**: 서버 전체 기동 완료 배너("Server startup in")가 뜨거나 20초 안전망 타임아웃이 지나면 아직 "배포 중"인 앱을 무조건 "실행 중"으로 넘겨버리던 로직을 제거했습니다. Host의 `startStopThreads` 설정 등으로 앱이 병렬/백그라운드로 배포되는 경우 이 배너가 해당 앱의 배포 완료보다 먼저 뜰 수 있어, 로그가 계속 올라오는 중에도 상태만 앞서 "실행 중"으로 바뀌는 원인이 됐습니다. 이제는 그 앱 자신의 실제 배포 완료/오류 로그 라인이 감지될 때만 상태가 바뀝니다(로그 리스너는 프로세스가 살아있는 한 계속 동작하므로 시간 제한 없이 기다립니다).

## 0.13.x
- **앱별 실행 상태 표시**: 지금까지는 서버가 실행/디버그 중이면 그 서버에 배포된 앱들이 전부 "실행 중"으로 한꺼번에 표시됐습니다. 이제 Tomcat이 각 앱을 실제로 배포/기동하는 로그(HostConfig의 deploy 시작·완료·오류, 컨텍스트 startup 실패)를 앱별로 추적해서, 서버가 떠도 아직 배포 중인 앱은 "◐ 배포 중...", 기동에 실패한 앱은 "✕ 배포 실패"로 개별 표시합니다. 서버 실행 중 새로 배포하거나 undeploy한 앱도 즉시 반영됩니다.

## 0.12.x
- **기동 중 오류 감지 시 서버 실행 자동 취소**: `Failed to start component`, `LifecycleException`, `Address already in use`(포트 충돌), `BindException` 등 Tomcat이 실제로 뜨지 못했음을 뜻하는 치명적 로그가 기동 과정(`starting` 상태) 중 감지되면, 더 기다리지 않고 즉시 프로세스를 종료하고 실행 취소 처리 + 오류 메시지 표시. 서버가 이미 정상 기동된 이후 앱에서 발생하는 로그는 대상이 아님(오탐 방지).

## 0.11.x
- 핫스왑(코드 교체) 실패 감지 시 알림만 띄우던 것을 **자동 "Reload Context Now" 실행**으로 강화 (`tomcat.autoReloadOnHotSwapFailure`, 기본 켜짐). 대형/복잡한 프로젝트에서 JDWP 핫스왑이 불안정해도 매번 수동 개입 없이 항상 반영되도록 함.

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

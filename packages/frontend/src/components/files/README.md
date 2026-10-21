# Files UI

## 파일 이동과 폴더 탐색을 구분한다

파일 탭의 `FilesWorkspace`와 사이드바 `FileTree`는 파일·폴더 메뉴에서
선택 모드에 들어가지 않아도 **폴더로 이동** 작업을 제공한다.
선택된 항목의 메뉴에서 이동하면 선택 전체를 대상으로 하고,
선택되지 않은 항목의 메뉴에서는 그 항목만 이동한다.

`FilesWorkspace`의 **이 폴더 열기**는 폴더 탐색이다. 파일을 옮기는
**폴더로 이동**과 문구 및 동작을 구분한다. 파일 탭과 사이드바는 같은 폴더 선택 모달을 사용한다.
파일 탭에서는 Project 루트 위로 탐색하지 못하게 제한하며, 이동 후
기존 mutation 갱신 및 되돌리기 기록을 유지한다. 부모·자식 동시 선택은
상위 경로로 압축해 중복 이동을 방지한다.
이동 취소는 오류로 표시하지 않고, 대상 경로는 현재 Project 루트 또는
그 하위 경로로 제한한다. 실제 접근 권한은 backend가 검증한다.

- 구현: `FilesWorkspace.tsx`, `FileTree.tsx`
- 회귀 검사: `FilesWorkspace.operations.source.test.ts`
- 검증 범위: source contract 검사와 frontend typecheck. 실제 브라우저에서의
  이동, 다중 선택, 이름 충돌 동작은 별도 live 검증이 필요하다.

## 잘라내기·붙여넣기

파일 탭과 사이드바는 `file-store`의 앱 내부 클립보드를 공유한다.
`mode: cut`은 경로만 기록하며, 폴더에 붙여넣을 때 rename API로 이동한다.
기존 mode가 없는 클립보드와 기본 저장 동작은 복사로 취급한다.
파일 탭에서는 폴더 메뉴 및 현재 폴더 붙여넣기 버튼을 제공한다.
성공한 항목은 클립보드에서 제거하고, 실패한 항목만 남겨 재시도한다.
자기 자신 하위로 이동하는 작업은 거부하며, 같은 폴더 이동은 생략한다.
파일 탭의 잘라내기 이동은 mutation 갱신과 열린 경로 갱신을 사용하지만
폴더 선택 이동과 달리 되돌리기 기록은 생성하지 않는다.

- 공통 이동 처리: `fileClipboard.ts`
- 동작 테스트: `fileClipboard.test.ts` (부분 실패, 자기 하위 이동, 중복 선택)
- 배포 및 브라우저 검증은 별도로 수행한다.


## Agent Home file navigation

- File tree listings classify symbolic links using target metadata in both `getFileTree` and `getFileTreeAsync` (`backend/services/workspace/file-system.ts`). A link to a directory navigates inside the existing `FilesWorkspace`, without opening a second sidebar tree. Existing path authorization remains responsible for target access.
- Known file selections from Agent Home and FilesWorkspace pass `isDirectory: false` to `useFileOpenActions`; extensionless files must not be inferred to be directories. Unstructured path links retain the directory heuristic.
- Agent Home exposes an explicit AI team destination. Its system tab close button stays visible on desktop; returning to the team preserves the home tab, while closing removes it.
- The external-share management tab is labelled “External share links” (Korean: “외부 공유 링크”); the existing external share API and revocation behavior remain unchanged.
- Regression coverage: `file-system.test.ts`, `useFileOpenActions.source.test.ts`. These checks do not establish deployed browser behavior.

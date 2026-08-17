# Project Files API decisions

- 이 모듈은 core file HTTP boundary만 소유하며 filesystem policy를 복제하지 않는다.
- coarse root와 Project ACL 호환 판정은 `project-files-access.ts` 한 곳에 둔다.
- upload와 streaming preview는 abort/cleanup integration contract가 준비되기 전 이동하지 않는다.
- Router는 기존 protected zone에 `/`로 mount해 URL을 보존한다.

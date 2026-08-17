# Samples

- `report.md`: 제목, 본문, 인용, Mermaid, 표, 코드, 수식, 각주를 포함한 최소 출판 fixture
- 생성 명령:

```bash
bash ../scripts/build.sh report.md report.pdf build/report
```

Runtime Box에서 실행하면 `report.pdf`, `build/report/publication.typ`, 검증 기록이 생성된다. PDF는 binary golden file로 상시 보관하기보다 toolchain 또는 template 변경 때 다시 생성하고 시각 비교한다.

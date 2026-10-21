# Execution routing

## Command interpretation and lifecycle

`command-structure.ts` extracts argv from a bounded shell subset for lifecycle
hints. Quoted arguments remain individual tokens: never turn argv back into shell
source to match a service name. Comments are ignored; pipelines and command
separators make the whole request compound, so they supply no automatic lifecycle
hint. Unquoted environment assignment prefixes and executable absolute paths are
supported. This is NOT a shell interpreter or security parser.

Simple file redirections (<, >, >>, with optional numeric fd) are supported and
excluded from argv. Shell operators and multiple commands are explicitly compound
and never automatically promoted. Only single invocations supply service hints
and ports; quoted NAME=value is not an assignment. Ports come from the recognized
service invocation, not arbitrary source text; duplicates remain ambiguous.

Expansion, heredocs/descriptor duplication, shell control structures, escaped syntax and
shell wrappers (`sh -c`, `bash -c`, eval/source) intentionally yield unknown.
Other wrappers such as sudo/env/timeout are not inferred as services. Unknown
commands remain foreground under existing timeouts; callers needing a durable
process must explicitly request Job/Service. Do not silently implement wrapper
recursion without a bounded, tested shell grammar. Generic `--watch`, `--reload`,
`--host`, `bun run` or `deno run` no longer imply a service by themselves.

`command-classifier.ts` preserves existing risky-pattern and credential suppression
rules; those are separate from lifecycle hints and not replaced with this parser.
`lifecycle-policy.ts` owns explicit override > managed download > inferred service
or heavy job > foreground. The broker remains responsible for authority, secure
run, service admission, dispatch and persistence. Explicit lifecycle is not an
authorization bypass. Provider selection and compatibility identifiers are unchanged.

User-facing ordinary execution errors use Project execution wording. Runtime Box
compatibility errors identify the compatibility route only where actually used.
Do not infer Docker use from `Workbench*`/`RuntimeBoxError` internal class names.

Tests: `command-structure.test.ts`, `../runtime-box/command-classifier.test.ts`,
`../runtime-box/workbench-execution-broker.test.ts`. The search-pipeline regression
asserts foreground execution and zero Service/Job creation calls. Local tests are
not production deployment or real user/browser verification.

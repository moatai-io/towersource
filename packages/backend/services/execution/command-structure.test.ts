import { expect,it } from 'vitest';
import { analyzeCommandStructure } from './command-structure.js';
import { classifyCommand } from './command-classifier.js';
import { chooseExecutionLifecycle } from './lifecycle-policy.js';
import { extractPortFromCommand } from './command-classifier.js';
import { inspectCommandStructure } from './command-structure.js';
it('treats quoted second-line executable as compound',()=>{expect(inspectCommandStructure('uvicorn app:app\n"echo" done').kind).toBe('compound');});
it.each([
 ['echo --port 9999; uvicorn app:app --port 8000',undefined],
 ['uvicorn app:app --port 8000 > server.log',8000],
 ['uvicorn app:app --port=8123',8123],
 ['python3 -m http.server 8123',8123],
 ['uvicorn app:app --port 8000 --port 9000',undefined],
 ['uvicorn app:app --port 80',undefined],
 ['uvicorn app:app > port:9999.log',undefined],
] as const)('extracts port from executable only: %s',(command,port)=>{expect(extractPortFromCommand(command)).toBe(port);});
const lifecycle = (command: string) => chooseExecutionLifecycle({managedDownload:false,classification:classifyCommand(command)});
it.each([
 "find . | grep -Ei 'automat|schedule|cron|자동|예약|refresh|sync' | head -60\ncat .tower/skills/task-schedule/SKILL.md",
 "grep uvicorn README.md", "echo cron", "printf '%s' 'npm run dev'", "cat --watch.txt",
 "grep -- '--watch' README.md", "echo npm test", "echo hello # uvicorn app:app",
 "cat <<'EOF'\ncron\nuvicorn app:app\nEOF", "python -c 'print(\"uvicorn\")'",
 "bash -c 'uvicorn app:app'", 'env UNKNOWN=1 bash -c "$COMMAND"',
 'if true; then uvicorn app:app; fi', 'echo $(uvicorn app:app)',
 'uvicorn --help','uvicorn --version','npm run build','bun run script.ts','deno run task.ts',
])('does not auto-promote data or unknown syntax: %s', command=>{expect(lifecycle(command)).not.toBe('service');});
it.each(['uvicorn app:app','PORT=8000 uvicorn app:app','/usr/bin/uvicorn app:app',
 'npm run dev','npm start','python3 -m http.server 8000','python -m uvicorn app:app',
 'node --watch task.js','tsx watch task.ts','cron'])('recognizes executable service: %s',command=>{expect(lifecycle(command)).toBe('service');});
it('keeps quoted data in individual argv tokens',()=>{expect(analyzeCommandStructure("grep 'npm run dev' README.md")).toEqual([['grep','npm run dev','README.md']]);});
it('returns unknown on unbalanced quotes and overly long input',()=>{expect(analyzeCommandStructure("echo 'hello")).toBeNull();expect(analyzeCommandStructure('x'.repeat(32769))).toBeNull();});
it('honors explicit lifecycle and managed downloads',()=>{
 const classification=classifyCommand('uvicorn app:app');
 expect(chooseExecutionLifecycle({classification,managedDownload:true})).toBe('job');
 expect(chooseExecutionLifecycle({classification,managedDownload:true,explicit:'foreground'})).toBe('foreground');
 expect(chooseExecutionLifecycle({classification:classifyCommand('bash -c "$RUN"'),managedDownload:false,explicit:'service'})).toBe('service');
});
it.each([
 'node -e "console.log(1)" --watch', 'node task.js --watch',
 'node -- task.js --watch', 'vitest --watch=false',
 'echo "cron" # --watch', 'grep uvicorn ./*.md',
 'cr*', 'npm run "$SCRIPT"', 'timeout 5 uvicorn app:app',
 'env MODE=dev uvicorn app:app', 'bash -c "npm run dev"',
])('does not infer service from data, wrappers or expansion: %s',command=>{
 expect(lifecycle(command)).not.toBe('service');
});
it.each(['npx vite preview','vite preview','node --watch task.js','tsc --watch','vitest --watch=true'])('keeps unambiguous watch/preview service: %s',command=>{
 expect(lifecycle(command)).toBe('service');
});
it.each(['grep "npm test" README.md','echo pytest','node -e "vitest"','npm run "echo npm test"'])('does not infer heavy job from data: %s',command=>{
 expect(lifecycle(command)).toBe('foreground');
});
it.each(['false && uvicorn app:app','npm run dev & npm test','echo text; npm run dev','echo ok\nuvicorn app:app','"A=1" uvicorn app:app',"'A'=1 uvicorn app:app"])('does not promote compounds or quoted assignment: %s',command=>{
 expect(lifecycle(command)).toBe('foreground');
});
it.each(['npm test > result.log','npm test 2> errors.log','npm test >> result.log','npm test < input.txt','npm test > "result log.txt"'])('preserves Job routing with simple redirection: %s',command=>{expect(lifecycle(command)).toBe('job');});
it.each(['uvicorn app:app > server.log',"MODE='dev' uvicorn app:app",'uvicorn app:app 2>> errors.log'])('preserves Service routing with simple redirection: %s',command=>{expect(lifecycle(command)).toBe('service');});
it.each(['npm test >','npm test 2>&1','npm test << EOF\ncron\nEOF'])('leaves unsupported redirection uncertain: %s',command=>{expect(lifecycle(command)).toBe('foreground');});

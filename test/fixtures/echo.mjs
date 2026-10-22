// test/fixtures/echo.mjs — print one line, then stay alive.
process.stdout.write(`${process.argv[2] ?? "hello-job"}\n`);
const ms = Number(process.argv[3] ?? 5000);
setTimeout(() => process.exit(0), ms);

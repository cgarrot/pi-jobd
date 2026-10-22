// test/fixtures/sleep.mjs — a job that stays alive without shell syntax.
const ms = Number(process.argv[2] ?? 5000);
setTimeout(() => process.exit(0), ms);

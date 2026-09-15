// No workflow/model logic. EOF on the caller-owned pipe releases flock, including after a crash.
process.stdout.write('locked\n');
process.stdin.resume();
process.stdin.on('end',()=>process.exit(0));

// Adapted from ai-cli-mcp v2.25.0. See LICENSE.ai-cli-mcp and docs/UPSTREAM.md.
'use strict';
const { spawn: nativeSpawn, spawnSync } = require('node:child_process');
const { appendFileSync, readFileSync, closeSync, mkdirSync, openSync, renameSync, writeFileSync, existsSync } = require('node:fs');
const { join, dirname } = require('node:path');
const {processIdentity: identity,powershell} = require('./aw-platform.cjs');
const SIGNAL_EXIT_CODES = {
    SIGHUP: 129,
    SIGINT: 130,
    SIGTERM: 143,
};
function spawnCli(command, args, options) {
    if (process.platform === 'win32') {
        return require('./aw-spawn.cjs')(command, args, options);
    }
    return nativeSpawn(command, args, options);
}
// Launched inside the Windows Job Object, with raw inherited log/stdin handles.
if (process.argv[2] === '--windows-child') {
    const plan = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    const worker = spawnCli(plan.command, plan.args, {cwd: plan.cwd, env: plan.env, stdio: 'inherit', windowsHide: true});
    worker.once('error', error => {process.stderr.write(error.message + '\n'); process.exit(1);});
    worker.once('exit', code => process.exit(code ?? 1));
    return;
}
let [stateDir, cwdKey, command, ...args] = process.argv.slice(2);
if (!stateDir || !cwdKey || !command) {
    process.stderr.write('Usage: detached-runner.cjs <state-dir> <cwd-key> <command> [...args]\n');
    process.exit(2);
}
// The prepared request is written by the trusted wrapper, never supplied by model output.
const prepared = process.env.AW_PREPARED_COMMAND
    ? JSON.parse(readFileSync(process.env.AW_PREPARED_COMMAND, 'utf8')) : null;
if (prepared) {
    if (!['linux', 'win32'].includes(process.platform)) throw new Error('Prepared execution supports Linux/WSL and Windows');
    command = prepared.command;
    args = prepared.args;
}
const pid = process.pid;
const processDir = join(stateDir, 'cwds', cwdKey, String(pid));
const stdoutPath = join(processDir, 'stdout.log');
const stderrPath = join(processDir, 'stderr.log');
const exitStatusPath = join(processDir, 'exit-status.json');
const childPidPath = join(processDir, 'child-pid');
mkdirSync(processDir, { recursive: true });
let child;
let finished = false;
let terminationExitCode;
let terminationReason;
let timeoutTimer;
let killTimer;
let cancelTimer;
let runnerIdentity;
function writeReceipt() {
    if (!prepared) return;
    const temp = `${prepared.receipt}.${pid}.tmp`;
    runnerIdentity = identity(pid);
    if (!runnerIdentity) throw new Error('Cannot establish runner process identity');
    writeFileSync(temp, JSON.stringify({identity: runnerIdentity, process_dir: processDir}), {mode: 0o600});
    renameSync(temp, prepared.receipt);
}
function signalChild(signal) {
    if (prepared && process.platform !== 'win32') { process.kill(-child.pid, signal); return true; }
    return child.kill(signal);
}
function appendRunnerError(error) {
    try {
        appendFileSync(stderrPath, `\nDetached runner error: ${error.message}\n`);
    }
    catch {
        // There is nowhere else safe to report an error from a detached process.
    }
}
function writeExitStatus(status, exitCode) {
    const tempPath = `${exitStatusPath}.${pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify({ status, exitCode, reason: terminationReason }, null, 2)}\n`);
    renameSync(tempPath, exitStatusPath);
}
function finish(status, exitCode) {
    if (finished) {
        return;
    }
    finished = true;
    clearTimeout(timeoutTimer);
    clearTimeout(killTimer);
    clearInterval(cancelTimer);
    // A provider may exit before its descendants. Reap its isolated group before reporting completion.
    if (prepared && child?.pid && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
            if (error.code !== 'ESRCH') appendRunnerError(error);
        }
    }
    try {
        writeExitStatus(status, exitCode);
    }
    catch (error) {
        appendRunnerError(error);
        process.exit(1);
    }
    process.exit(exitCode);
}
function terminateChild(signal, exitCode) {
    if (terminationExitCode !== undefined) {
        return;
    }
    terminationExitCode = exitCode;
    if (!child || !child.pid) {
        finish('failed', terminationExitCode);
        return;
    }
    try {
        if (process.platform === 'win32' && (signal === 'SIGTERM' || signal === 'SIGKILL')) {
            const result = spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
                stdio: 'ignore',
                windowsHide: true,
            });
            if (result.status === 0) {
                return;
            }
        }
        if (prepared) {
            killTimer = setTimeout(() => {
                try { signalChild('SIGKILL'); } catch (error) {
                    if (error.code !== 'ESRCH') appendRunnerError(error);
                }
            }, 1500);
        }
        if (!signalChild(signal)) {
            finish('failed', terminationExitCode);
        }
    }
    catch (error) {
        appendRunnerError(error);
        finish('failed', terminationExitCode);
    }
}
function handleSignal(signal) {
    terminationReason ||= 'signal';
    terminateChild(signal, SIGNAL_EXIT_CODES[signal] || 1);
}
function attachChildListeners() {
    child.once('error', (error) => {
        appendRunnerError(error);
        finish('failed', terminationExitCode || 1);
    });
    child.once('close', (code, signal) => {
        if (terminationExitCode !== undefined) {
            finish('failed', terminationExitCode);
            return;
        }
        const exitCode = code === null ? SIGNAL_EXIT_CODES[signal] || 1 : code;
        finish(exitCode === 0 ? 'completed' : 'failed', exitCode);
    });
}
function closeLogDescriptors() {
    let closeError;
    for (const fd of [stdinFd, stdoutFd, stderrFd]) {
        if (fd === undefined) {
            continue;
        }
        try {
            closeSync(fd);
        }
        catch (error) {
            closeError ||= error;
            appendRunnerError(error);
        }
    }
    if (closeError && child && !finished) {
        terminateChild('SIGKILL', 1);
    }
}
for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
    process.on(signal, () => handleSignal(signal));
}
let stdinFd;
let stdoutFd;
let stderrFd;
try {
    writeReceipt();
    if (prepared) stdinFd = openSync(prepared.stdin_file, 'r');
    stdoutFd = openSync(stdoutPath, 'w', 0o600);
    stderrFd = openSync(stderrPath, 'w', 0o600);
    const windowsJob = prepared && process.platform === 'win32';
    child = spawnCli(windowsJob ? powershell() : command, windowsJob ?
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(__dirname, 'aw-windows-job.ps1')] : args, {
        cwd: prepared ? prepared.cwd : process.cwd(),
        env: windowsJob ? {...prepared.env, AW_JOB_NODE: process.execPath, AW_JOB_RUNNER: __filename,
            AW_JOB_PLAN: process.env.AW_PREPARED_COMMAND, AW_JOB_OWNER: String(pid)} : prepared ? prepared.env : process.env,
        detached: Boolean(prepared) && !windowsJob,
        stdio: [stdinFd === undefined ? 'ignore' : stdinFd, stdoutFd, stderrFd],
        windowsHide: true,
    });
    attachChildListeners();
    if (windowsJob) cancelTimer = setInterval(() => {
        const file = join(dirname(prepared.receipt), 'cancel.json');
        if (!existsSync(file)) return;
        try {
            const requested = JSON.parse(readFileSync(file, 'utf8'));
            if (JSON.stringify(requested.identity) === JSON.stringify(runnerIdentity)) handleSignal('SIGTERM');
        } catch (error) { appendRunnerError(error); }
    }, 100);
    if (prepared) timeoutTimer = setTimeout(() => {
        terminationReason = 'timeout';
        terminateChild('SIGTERM', 124);
    }, prepared.timeout_seconds * 1000);
    if (child.pid) {
        try {
            writeFileSync(childPidPath, `${child.pid}\n`);
        }
        catch (error) {
            appendRunnerError(error);
            terminateChild('SIGKILL', 1);
        }
    }
}
catch (error) {
    appendRunnerError(error);
    finish('failed', 1);
}
finally {
    closeLogDescriptors();
}

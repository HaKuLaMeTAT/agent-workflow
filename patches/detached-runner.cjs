// Adapted from ai-cli-mcp v2.25.0. See LICENSE.ai-cli-mcp and docs/UPSTREAM.md.
'use strict';
const { spawn: nativeSpawn, spawnSync } = require('node:child_process');
const { appendFileSync, readFileSync, closeSync, mkdirSync, openSync, renameSync, writeFileSync, } = require('node:fs');
const { join } = require('node:path');
const SIGNAL_EXIT_CODES = {
    SIGHUP: 129,
    SIGINT: 130,
    SIGTERM: 143,
};
function spawnCli(command, args, options) {
    if (process.platform === 'win32') {
        return require('cross-spawn')(command, args, options);
    }
    return nativeSpawn(command, args, options);
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
    if (process.platform !== 'linux') throw new Error('Prepared execution is Linux/WSL only');
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
function identity(pid) {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return {pid, start_ticks: raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19],
        boot_id: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()};
}
function writeReceipt() {
    if (!prepared) return;
    const temp = `${prepared.receipt}.${pid}.tmp`;
    writeFileSync(temp, JSON.stringify({identity: identity(pid), process_dir: processDir}), {mode: 0o600});
    renameSync(temp, prepared.receipt);
}
function signalChild(signal) {
    if (prepared) { process.kill(-child.pid, signal); return true; }
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
    // A provider may exit before its descendants. Reap its isolated group before reporting completion.
    if (prepared && child?.pid) {
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
    child = spawnCli(command, args, {
        cwd: prepared ? prepared.cwd : process.cwd(),
        env: prepared ? prepared.env : process.env,
        detached: Boolean(prepared),
        stdio: [stdinFd === undefined ? 'ignore' : stdinFd, stdoutFd, stderrFd],
        windowsHide: true,
    });
    attachChildListeners();
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

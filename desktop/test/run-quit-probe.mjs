// Loads the desktop shell and checks that a window close either ends the
// process (no edits, or the user confirmed Exit) or leaves it open (Cancel).
//
//   node test/run-quit-probe.mjs
//
// Requires the `electron` devDependency and a display. Pass --no-sandbox,
// which this script does, when the host cannot set up chrome-sandbox.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electron = require('electron');
const desktopDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(mode) {
    return new Promise((resolve) => {
        const child = spawn(electron, ['.', '--no-sandbox', '--disable-gpu', `--quit-probe=${mode}`], {
            cwd: desktopDir,
            env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let out = '';
        const take = (chunk) => {
            const text = String(chunk);
            out += text;
            process.stdout.write(text);
        };
        child.stdout.on('data', take);
        child.stderr.on('data', take);
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve({ mode, code: null, out, timedOut: true });
        }, 20000);
        child.on('exit', (code) => {
            clearTimeout(timer);
            resolve({ mode, code, out, timedOut: false });
        });
    });
}

function passed(mode, result) {
    if (result.timedOut || result.code !== 0) return false;
    if (result.out.includes('[quit-probe] FAIL')) return false;
    if (mode === 'stay') return result.out.includes('[quit-probe] OK: window stayed open');
    return result.out.includes('[quit-probe] OK: window closed');
}

const modes = ['clean', 'quit', 'menu', 'stay'];
let failed = 0;
for (const mode of modes) {
    process.stdout.write(`\n--- quit-probe ${mode} ---\n`);
    const result = await run(mode);
    const ok = passed(mode, result);
    if (!ok) failed += 1;
    process.stdout.write(`--- ${mode}: ${ok ? 'PASS' : 'FAIL'} (code ${result.code}${result.timedOut ? ', timed out' : ''}) ---\n`);
}

if (failed) {
    process.stderr.write(`${failed} quit-probe mode(s) failed\n`);
    process.exit(1);
}
process.stdout.write('quit-probe: all modes passed\n');

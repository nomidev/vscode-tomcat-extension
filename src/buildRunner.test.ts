import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommandForExecution } from './buildRunner';

test('prepends chcp for cmd.exe on Windows', () => {
  assert.equal(buildCommandForExecution('mvn compile -q', 'win32', 'C:\\Windows\\System32\\cmd.exe'), 'chcp 65001>nul && mvn compile -q');
});

test('skips chcp for non-cmd shells on Windows', () => {
  assert.equal(buildCommandForExecution('mvn compile -q', 'win32', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), 'mvn compile -q');
});

test('does not change commands on non-Windows platforms', () => {
  assert.equal(buildCommandForExecution('mvn compile -q', 'linux', 'bash'), 'mvn compile -q');
});

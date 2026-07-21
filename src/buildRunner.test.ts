import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommandForExecution, buildExecutionEnvironment } from './buildRunner';

test('keeps the build command unchanged on Windows cmd.exe', () => {
  assert.equal(buildCommandForExecution('mvn compile -q', 'win32', 'C:\\Windows\\System32\\cmd.exe'), 'mvn compile -q');
});

test('keeps the build command unchanged for PowerShell on Windows', () => {
  assert.equal(buildCommandForExecution('mvn compile -q', 'win32', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), 'mvn compile -q');
});

test('keeps the build command unchanged when the Windows shell is unknown', () => {
  assert.equal(buildCommandForExecution('mvn compile -q', 'win32', ''), 'mvn compile -q');
});

test('keeps the build command unchanged on non-Windows platforms', () => {
  assert.equal(buildCommandForExecution('mvn compile -q', 'linux', 'bash'), 'mvn compile -q');
});

test('preserves existing PATH entries when JAVA_HOME is set', () => {
  const env = buildExecutionEnvironment({ PATH: 'C:\\Windows\\System32' }, 'C:\\jdk8');
  assert.equal(env.JAVA_HOME, 'C:\\jdk8');
  assert.equal(env.PATH, 'C:\\jdk8\\bin;C:\\Windows\\System32');
  assert.equal(env.Path, 'C:\\jdk8\\bin;C:\\Windows\\System32');
});

test('uses Path when PATH is missing on Windows', () => {
  const env = buildExecutionEnvironment({ Path: 'C:\\Windows\\System32' }, 'C:\\jdk8');
  assert.equal(env.PATH, 'C:\\jdk8\\bin;C:\\Windows\\System32');
  assert.equal(env.Path, 'C:\\jdk8\\bin;C:\\Windows\\System32');
});

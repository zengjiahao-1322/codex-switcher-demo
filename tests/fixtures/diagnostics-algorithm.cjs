'use strict';
const fs = require('node:fs');
const { redact, log, readRecent } = require('../../src/diagnostics/event-log.cjs');
const [inputFile, outputFile] = process.argv.slice(2);
const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
let output;
if (input.op === 'otherInstallAction')
  output = require('../../src/platform/app-lifecycle.cjs').otherInstallAction(
    input.old,
    input.current,
  );
else if (input.op === 'windowsProxyEnv')
  output = require('../../src/platform/platform.cjs').windowsProxyEnv(input.value);
else if (input.op === 'redact') output = redact(input.value);
else if (input.op === 'log') {
  log(input.bridge, input.event, input.fields);
  output = readRecent(input.bridge, 2000);
} else throw Error('Unknown fixture operation');
fs.writeFileSync(outputFile, JSON.stringify(output));

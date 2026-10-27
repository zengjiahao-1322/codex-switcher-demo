'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { tap } = require('node:test/reporters');

module.exports = async function* (source) {
  const tests = [];
  async function* capture() {
    for await (const event of source) {
      if (['test:pass', 'test:fail'].includes(event.type) && event.data.nesting === 0)
        tests.push({
          file: path.basename(event.data.file),
          name: event.data.name,
          status: event.type.slice(5),
          skipped: !!event.data.skip,
        });
      yield event;
    }
    const file = process.env.SWITCHER_TEST_INVENTORY;
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(tests, null, 2));
    }
  }
  yield* tap(capture());
};

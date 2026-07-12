'use strict';

// A stand-in for a real agent CLI, used only by the integration test. It stays
// alive, and every time it receives something on stdin it echoes a compact
// marker so the test can assert what the wrapper injected.
process.stdout.write('mock-agent ready\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  const s = String(d).replace(/[\r\n]+/g, ' ').slice(0, 24);
  process.stdout.write('GOT[' + s + ']\n');
});
process.stdin.resume();
setInterval(() => {}, 1 << 30);

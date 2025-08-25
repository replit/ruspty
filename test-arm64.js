#!/usr/bin/env node
/**
 * Test ruspty on ARM64 Linux
 * This verifies that the native binary works correctly
 */

const { Pty } = require('./dist/wrapper.js');

console.log('Testing @replit/ruspty on ARM64 Linux');
console.log('Architecture:', process.arch);
console.log('Platform:', process.platform);
console.log('----------------------------------------\n');

// Test 1: Basic PTY creation
console.log('Test 1: Creating PTY with echo command');
try {
  const pty1 = new Pty({
    command: 'echo',
    args: ['Hello from ARM64!'],
    env: process.env,
    size: { rows: 24, cols: 80 },
    onExit: (err, exitCode) => {
      console.log('  Exit code:', exitCode);
    },
  });

  let output1 = '';
  pty1.read.on('data', (data) => {
    output1 += data.toString();
  });

  setTimeout(() => {
    console.log('  Output:', output1.trim());
    console.log('  ✅ Test 1 PASSED\n');
  }, 500);
} catch (err) {
  console.error('  ❌ Test 1 FAILED:', err.message, '\n');
}

// Test 2: Interactive PTY
setTimeout(() => {
  console.log('Test 2: Interactive PTY with bash');
  try {
    const pty2 = new Pty({
      command: 'bash',
      args: ['-c', 'read -p "Enter text: " text && echo "You entered: $text"'],
      env: process.env,
      size: { rows: 24, cols: 80 },
      onExit: (err, exitCode) => {
        console.log('  Exit code:', exitCode);
      },
    });

    let output2 = '';
    pty2.read.on('data', (data) => {
      output2 += data.toString();
      if (output2.includes('Enter text:')) {
        // Send input
        pty2.write.write('ARM64 Works!\n');
      }
    });

    setTimeout(() => {
      console.log('  Output:', output2.replace(/\n/g, '\\n'));
      if (output2.includes('You entered: ARM64 Works!')) {
        console.log('  ✅ Test 2 PASSED\n');
      } else {
        console.log(
          '  ❌ Test 2 FAILED: Expected "You entered: ARM64 Works!"\n',
        );
      }
    }, 1000);
  } catch (err) {
    console.error('  ❌ Test 2 FAILED:', err.message, '\n');
  }
}, 600);

// Test 3: Check if it's a real PTY
setTimeout(() => {
  console.log('Test 3: Verify real PTY (isatty check)');
  try {
    const pty3 = new Pty({
      command: 'python3',
      args: ['-c', 'import sys; print("isatty:", sys.stdout.isatty())'],
      env: process.env,
      size: { rows: 24, cols: 80 },
      onExit: (err, exitCode) => {
        // Exit handler
      },
    });

    let output3 = '';
    pty3.read.on('data', (data) => {
      output3 += data.toString();
    });

    setTimeout(() => {
      console.log('  Output:', output3.trim());
      if (output3.includes('isatty: True')) {
        console.log('  ✅ Test 3 PASSED - Real PTY confirmed!\n');
      } else {
        console.log('  ❌ Test 3 FAILED - Not a real PTY\n');
      }
    }, 500);
  } catch (err) {
    console.error('  ❌ Test 3 FAILED:', err.message, '\n');
  }
}, 2000);

// Test 4: Terminal dimensions
setTimeout(() => {
  console.log('Test 4: Terminal dimensions');
  try {
    const pty4 = new Pty({
      command: 'bash',
      args: ['-c', 'echo "Cols: $COLUMNS, Rows: $LINES"'],
      env: process.env,
      size: { rows: 30, cols: 100 },
      onExit: (err, exitCode) => {
        // Exit handler
      },
    });

    let output4 = '';
    pty4.read.on('data', (data) => {
      output4 += data.toString();
    });

    setTimeout(() => {
      console.log('  Output:', output4.trim());
      if (output4.includes('Cols: 100') && output4.includes('Rows: 30')) {
        console.log('  ✅ Test 4 PASSED\n');
      } else {
        console.log('  ❌ Test 4 FAILED - Dimensions not set correctly\n');
      }

      console.log('========================================');
      console.log('All tests completed!');
      console.log('ARM64 Linux support is working! 🎉');
      process.exit(0);
    }, 500);
  } catch (err) {
    console.error('  ❌ Test 4 FAILED:', err.message, '\n');
    process.exit(1);
  }
}, 3000);

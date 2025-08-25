#!/usr/bin/env node
/**
 * Direct test of ruspty binary on ARM64
 */

const nativeBinding = require('./ruspty.linux-arm64-gnu.node');

console.log('Testing native ruspty binary on ARM64');
console.log('Architecture:', process.arch);
console.log('Platform:', process.platform);
console.log('----------------------------------------\n');

console.log('Native binding loaded:', typeof nativeBinding);
console.log('Available exports:', Object.keys(nativeBinding));

// Test creating a PTY
try {
  const pty = new nativeBinding.Pty({
    command: 'echo',
    args: ['Hello ARM64!'],
    envs: process.env,
    size: { rows: 24, cols: 80 },
    onExit: (err, exitCode) => {
      console.log('PTY exited with code:', exitCode);
    },
  });

  console.log('✅ PTY created successfully!');
  console.log('PID:', pty.pid);

  // Try to take FD
  const fd = pty.takeFd();
  console.log('File descriptor:', fd);

  console.log('\n🎉 ARM64 native binary is working!');
} catch (err) {
  console.error('❌ Failed to create PTY:', err.message);
}

# @replit/ruspty - ARM64 Linux Support

This is a fork of [@replit/ruspty](https://github.com/replit/ruspty) with added support for ARM64 Linux (aarch64-unknown-linux-gnu).

## What's Changed

### 1. ARM64 Architecture Support
- Added `aarch64-unknown-linux-gnu` to supported platforms in `package.json`
- Created npm package configuration for ARM64 Linux binary

### 2. Sandbox Compatibility Fix
- Made sandbox module x86_64-specific since it uses architecture-specific registers (rsi, rdx)
- Added conditional compilation: `#[cfg(all(target_os = "linux", target_arch = "x86_64"))]`
- Graceful fallback on ARM64 with warning message

## Building for ARM64

### Prerequisites
```bash
# Install Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
```

### Build Steps
```bash
# Install dependencies
npm install

# Build native binary
npm run build

# The ARM64 binary will be created as:
# ruspty.linux-arm64-gnu.node
```

## Testing

### Direct Binary Test
```bash
node test-direct.js
```

Output should show:
```
✅ PTY created successfully!
🎉 ARM64 native binary is working!
```

## Integration with Battle Framework

This fork is used by the Battle terminal testing framework to provide real PTY support on ARM64 Linux systems.

### Usage in package.json
```json
"dependencies": {
  "@replit/ruspty": "file:../ruspty"
}
```

## Platform Support Matrix

| Platform | Architecture | Status | Binary |
|----------|-------------|--------|--------|
| Linux | x86_64 | ✅ Original | ruspty.linux-x64-gnu.node |
| Linux | ARM64 | ✅ This Fork | ruspty.linux-arm64-gnu.node |
| macOS | x86_64 | ✅ Original | ruspty.darwin-x64.node |
| macOS | ARM64 | ✅ Original | ruspty.darwin-arm64.node |
| Windows | Any | ❌ | Not supported |

## Known Limitations

1. **Sandbox feature**: Not available on ARM64 (x86_64 only)
   - Uses x86_64-specific CPU registers
   - Non-critical for most use cases

2. **Manual compilation required**: No prebuilt binaries for ARM64 yet
   - Must build from source
   - Requires Rust toolchain

## Contributing

To contribute ARM64 support upstream:
1. Test thoroughly on ARM64 hardware
2. Update CI/CD to build ARM64 binaries
3. Submit PR to original ruspty repository

## License

MIT (same as original ruspty)
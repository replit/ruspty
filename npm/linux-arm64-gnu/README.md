# `@replit/ruspty-linux-arm64-gnu`

This is the **aarch64-unknown-linux-gnu** binary for `@replit/ruspty`

## ARM64 Linux Support

This binary provides native PTY support for ARM64 Linux systems (aarch64).

### Requirements
- Linux ARM64 (aarch64) architecture
- glibc 2.17 or later

### Building from source
If you need to rebuild this binary:

```bash
cd ../../
npm install
npm run build
```

The binary will be generated as `ruspty.linux-arm64-gnu.node`
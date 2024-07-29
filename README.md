# `@replit/ruspty` - PTY for JavaScript through Rust FFI

A very thin wrapper around PTYs and processes.

```ts
const { Pty } = require('@replit/ruspty');
const fs = require('fs');

const pty = new Pty({
  command: '/bin/sh',
  args: [],
  envs: {},
  size: { rows: 24, cols: 80 },
  onExit: (...result) => {
    // TODO: Handle process exit.
  },
});

const read = pty.read;
const write = pty.write;

read.on('data', (chunk) => {
  // TODO: Handle data.
});
write.write('echo hello\n');
```

The biggest difference from existing PTY libraries is that this one works with Bun, and doesn't cross the FFI bridge for every input/output instead requiring the consumer to deal with the `fd` of the PTY.

## Local Development

- `npm install`
- `npm run build`
- `npm run test`
- `RUST_LOG=debug npm run test` (Run tests with visible log statements)

## Publishing

Following ["Publish It" section from `napi-rs` docs](https://napi.rs/docs/introduction/simple-package#publish-it):

1. `git clean -f && npm install && npm run build`
2. `npm version [major|minor|patch]`
3. Send that as a Pull Request to GitHub. Ensure that the commit message consisting **only** of `x.y.z` - this is how the CI decides to publish to `npm`!

`NPM_TOKEN` is part of the repo secrets, generated [like this](https://httptoolkit.com/blog/automatic-npm-publish-gha/).

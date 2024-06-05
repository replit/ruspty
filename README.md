# `@replit/ruspty` - PTY for JavaScript through Rust FFI

Running:

- `npm install`
- `npm run build` / `npm run build:debug`
- `npm run test`

The code mainly targets Node on Linux.

The biggest difference from existing PTY libraries is that this one works with Bun, and doesn't cross the FFI bridge for every input/output instead requiring the consumer to deal with the `fd` of the PTY.

## Publishing

Following ["Publish It" section from `napi-rs` docs](https://napi.rs/docs/introduction/simple-package#publish-it):

1. `git clean -f && bun install && npm run build`
2. `npm version [major|minor|patch]`
3. Send that as a Pull Request to GitHub. Ensure that the commit message consisting **only** of `x.y.z` - this is how the CI decides to publish to `npm`!

`NPM_TOKEN` is part of the repo secrets, generated [like this](https://httptoolkit.com/blog/automatic-npm-publish-gha/).

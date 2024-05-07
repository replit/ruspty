# `@replit/ruspty` - PTY for Bun (and Node) through Rust FFI

Running:

- `bun install`
- `bun run build` / `bun run build:debug`
- `bun test:linux` on Linux
- `npm run test:darwin` on macOS

The code mainly targets Bun on Linux.

The biggest difference from existing PTY libraries is that this one works with Bun, and doesn't cross the FFI bridge for every input/output instead requiring the consumer to deal with the `fd` of the PTY.

**WARNING**: as of 2024-05-06 there's a [bug in Bun](https://github.com/oven-sh/bun/issues/9907) which prevents us from using `fd` with Bun, and a temporary workaround with `onData` handler was introduced in `v2.0.1`. Check out Linux tests for usage.

## Publishing

Following ["Publish It" section from `napi-rs` docs](https://napi.rs/docs/introduction/simple-package#publish-it):

1. Create a new branch
2. `npm version [major|minor|patch]`
3. `git push --follow-tags`
4. Merge the branch with commit message consisting **only** of `x.y.z` - this is how the CI decides to publish to `npm`!

`NPM_TOKEN` is part of the repo secrets, generated [like this](https://httptoolkit.com/blog/automatic-npm-publish-gha/).


# `@replit/ruspty` - PTY for Bun (and Node) through Rust FFI

Running:

- `bun install`
- `bun run build`
- `bun test`

The code mainly targets Bun, but does work in Node too.

The biggest difference from existing PTY libraries is that this one works with Bun, and doesn't cross the FFI bridge for every input/output instead requiring the consumer to deal with the `fd` of the PTY.

The Rust PTY implementation is cargo-culted from [Alacritty's Unix TTY code](https://github.com/alacritty/alacritty/blob/master/alacritty_terminal/src/tty/unix.rs).


## Publishing

Following ["Publish It" section from `napi-rs` docs](https://napi.rs/docs/introduction/simple-package#publish-it):

- `npm version [major|minor|patch]`
- `git push --follow tags`

Github Action should take care of publishing after that.

`NPM_TOKEN` is part of the repo secrets, generated [like this](https://httptoolkit.com/blog/automatic-npm-publish-gha/).


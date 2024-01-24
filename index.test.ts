import fs from "fs";
import { Pty } from "./index";

describe("PTY", () => {
  const CWD = process.cwd();

  test("spawns and exits", (done) => {
    const message = "hello from a pty";

    const pty = new Pty(
      "/bin/echo",
      [message],
      {},
      CWD,
      [80, 24],
      (err, exitCode) => {
        expect(err).toBeNull();
        expect(exitCode).toBe(0);
        done();
      },
    );

    const readStream = fs.createReadStream("", { fd: pty.fd });

    readStream.on("data", (chunk) => {
      expect(chunk.toString()).toBe(message + "\r\n");
    });
  });

  test("captures an exit code", (done) => {
    new Pty(
      "/bin/sh",
      ["-c", "exit 17"],
      {},
      CWD,
      [80, 24],
      (err, exitCode) => {
        expect(err).toBeNull();
        expect(exitCode).toBe(17);
        done();
      },
    );
  });

  test("can be written to", (done) => {
    const message = "hello cat";

    const pty = new Pty("/bin/cat", [], {}, CWD, [80, 24], () => {});

    const readStream = fs.createReadStream("", { fd: pty.fd });
    const writeStream = fs.createWriteStream("", { fd: pty.fd });

    readStream.on("data", (chunk) => {
      expect(chunk.toString()).toBe(message);
      done();
    });

    writeStream.write(message);
  });

  test("can be resized", (done) => {
    const pty = new Pty("/bin/sh", [], {}, CWD, [80, 24], () => {});

    const readStream = fs.createReadStream("", { fd: pty.fd });
    const writeStream = fs.createWriteStream("", { fd: pty.fd });

    let buffer = "";

    readStream.on("data", (chunk) => {
      buffer += chunk.toString();

      if (buffer.includes("done1\r\n")) {
        expect(buffer).toContain("24 80");
        pty.resize([100, 60]);
        buffer = "";
        writeStream.write("stty size; echo 'done2'\n");
      }

      if (buffer.includes("done2\r\n")) {
        expect(buffer).toContain("60 100");
        done();
      }
    });

    writeStream.write("stty size; echo 'done1'\n");
  });

  test("respects working directory", (done) => {
    const pty = new Pty("/bin/pwd", [], {}, CWD, [80, 24], (err, exitCode) => {
      expect(err).toBeNull();
      expect(exitCode).toBe(0);
      done();
    });

    const readStream = fs.createReadStream("", { fd: pty.fd });

    readStream.on("data", (chunk) => {
      expect(chunk.toString()).toBe(`${CWD}\r\n`);
    });
  });

  test("respects env", (done) => {
    const message = "hello from env";
    let buffer = "";

    const pty = new Pty(
      "/bin/sh",
      ["-c", "sleep 0.1s && echo $ENV_VARIABLE; exit"],
      {
        ENV_VARIABLE: message,
      },
      CWD,
      [80, 24],
      (err, exitCode) => {
        expect(err).toBeNull();
        expect(exitCode).toBe(0);
        expect(buffer).toBe(message + "\r\n");

        done();
      },
    );

    const readStream = fs.createReadStream("", { fd: pty.fd });

    readStream.on("data", (chunk) => {
      buffer += chunk.toString();
    });
  });

  test("works with Bun.read & Bun.write", (done) => {
    const message = "hello bun";

    const pty = new Pty("/bin/cat", [], {}, CWD, [80, 24], () => {});

    const file = Bun.file(pty.fd);

    async function read() {
      const stream = file.stream();

      for await (const chunk of stream) {
        expect(Buffer.from(chunk).toString()).toBe(message);
        done();
      }
    }

    read();

    Bun.write(pty.fd, message);
  });
});

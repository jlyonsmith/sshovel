import fs from "fs-extra"

/*
Checks and ensures that a directory exists.

Example:

{
  assert: "directoryExists",
  with: {
    path: "/path/to/dir"
  }
}
*/

export class DirectoryExistsAsserter {
  constructor(container) {
    this.fs = container.fs || fs
  }

  async assert(args) {
    try {
      return (await this.fs.lstat(args.path)).isDirectory()
    } catch (error) {
      return false
    }
  }

  async run(args) {
    try {
      await this.fs.mkdir(args.path)
      return true
    } catch (error) {
      return false
    }
  }
}

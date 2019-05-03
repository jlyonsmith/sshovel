const fs = require("fs-extra")

/*
Checks and ensures that a file exists.

Example:

{
  assert: "fileExists",
  with: {
    path: "/path/to/file"
  }
}
*/

class FileContains {
  async assert(args) {
    try {
      return (await fs.lstat(args.path)).isFile()
    } catch (error) {
      return false
    }
  }

  async actualize(args) {
    try {
      await this.fs.writeFile(args.path, "a test")
      // NOTE: probably should use ensureFile()
      return true
    } catch (error) {
      return false
    }
  }
}

module.exports.FileContains = FileContains
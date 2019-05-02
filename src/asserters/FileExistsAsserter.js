import fs from "fs-extra"

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

export class FileExistsAsserter {
  async assert(args) {
    try {
      return (await fs.lstat(args.path)).isFile()
    } catch (error) {
      return false
    }
  }

  async run(args) {
    try {
<<<<<<< HEAD
      await this.fs.ensureFile(args.path)
=======
      await fs.writeFile(args.path)
>>>>>>> 749cf5b7d0730b996f2835e9517b21d4afdf754d
      return true
    } catch (error) {
      return false
    }
  }
}

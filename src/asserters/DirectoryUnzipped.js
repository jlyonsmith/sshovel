import fs from "fs-extra"
import yauzl from "yauzl-promise"
import * as util from "../util"
import path from "path"
import { ScriptError } from "../ScriptError"

/*
Checks and ensures that a .zip file is unzipped to a directory.

Example:

    {
      assert: "DirectoryUnzipped",
      with: {
        zipPath: "${consulZipPath}",
        to: "./xyz",
      },
    }
*/

export class DirectoryUnzipped {
  constructor(container) {
    this.fs = container.fs || fs
    this.yauzl = container.yauzl || yauzl
    this.util = container.util || util
    this.expandStringNode = container.expandStringNode
  }

  async assert(assertNode) {
    const withNode = assertNode.value.with
    const { zip: zipPathNode, to: toPathNode } = withNode.value

    if (!zipPathNode || zipPathNode.type !== "string") {
      throw new ScriptError(
        "'zip' must be supplied and be a string",
        zipPathNode || withNode
      )
    }

    if (!toPathNode || toPathNode.type !== "string") {
      throw new ScriptError(
        "'to' must be supplied and be a string",
        toPathNode || withNode
      )
    }

    this.expandedZipPath = this.expandStringNode(zipPathNode)
    this.expandedToPath = this.expandStringNode(toPathNode)

    if (!(await this.util.fileExists(this.fs, this.expandedZipPath))) {
      throw new ScriptError(
        `Zip file ${this.expandedZipPath} does not exist`,
        zipPathNode
      )
    }

    if (!(await this.util.dirExists(this.fs, this.expandedToPath))) {
      return false
    }

    let zipFile = null

    try {
      zipFile = await this.yauzl.open(this.expandedZipPath)
      await zipFile.walkEntries(async (entry) => {
        const targetPath = path.join(this.expandedToPath, entry.fileName)
        const entryIsDir = entry.fileName.endsWith("/")
        // This will throw if the file or directory is not present
        const stat = await this.fs.lstat(targetPath)

        if (!entryIsDir && stat.isDirectory()) {
          throw new Error(
            `Existing '${targetPath}' is a directory and zip file entry is a file`
          )
        } else if (entry.uncompressedSize !== stat.size) {
          throw new Error(
            `File size ${stat.size} of '${targetPath} does not match zip file entry of ${entry.uncompressedSize}`
          )
        }
      })
    } catch (e) {
      return false
    } finally {
      if (zipFile) {
        await zipFile.close()
      }
    }

    return true
  }

  async rectify() {
    let zipFile = null

    try {
      zipFile = await this.yauzl.open(this.expandedZipPath)
      await zipFile.walkEntries(async (entry) => {
        const targetPath = path.join(this.expandedToPath, entry.fileName)
        const entryIsDir = entry.fileName.endsWith("/")
        const targetDir = entryIsDir ? targetPath : path.dirname(targetPath)

        if (!(await this.util.dirExists(this.fs, targetDir))) {
          await this.fs.ensureDir(targetDir)
        }

        if (!entryIsDir) {
          const readable = await entry.openReadStream()
          const writeable = await this.fs.createWriteStream(targetPath)

          await this.util.pipeToPromise(readable, writeable)
        }
      })
    } finally {
      if (zipFile) {
        await zipFile.close()
      }
    }
  }

  result() {
    return { zip: this.expandedZipPath, to: this.expandedToPath }
  }
}
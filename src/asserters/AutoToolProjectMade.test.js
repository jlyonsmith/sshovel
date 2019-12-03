import { AutoToolProjectMade } from "./AutoToolProjectMade"
import { createAssertNode } from "../testUtil"
import { ScriptError } from "../ScriptError"
import { PathInfo } from "../util"

test("assert", async () => {
  const container = {
    process: {
      geteuid: () => 1,
      getgroups: () => [1, 2],
    },
    expandStringNode: (node) => node.value,
    childProcess: {
      exec: async (command) => {
        if (command.endsWith("foo")) {
          return {}
        } else if (command.endsWith("bar")) {
          const error = new Error()

          error.code = 2
          throw error
        }
      },
    },
    util: {
      pathInfo: async () =>
        new PathInfo(
          {
            isFile: () => true,
            uid: 1,
            gid: 1,
            mode: 0o777,
          },
          container
        ),
    },
  }

  const asserter = new AutoToolProjectMade(container)

  // Bad command
  await expect(asserter.assert(createAssertNode(asserter, {}))).rejects.toThrow(
    ScriptError
  )
  await expect(
    asserter.assert(createAssertNode(asserter, { directory: 1 }))
  ).rejects.toThrow(ScriptError)
  await expect(
    asserter.assert(createAssertNode(asserter, { directory: "", args: 1 }))
  ).rejects.toThrow(ScriptError)

  // All made
  await expect(
    asserter.assert(
      createAssertNode(asserter, { directory: "/xyz", args: "foo" })
    )
  ).resolves.toBe(true)

  // All not made
  await expect(
    asserter.assert(
      createAssertNode(asserter, { directory: "/xyz", args: "bar" })
    )
  ).resolves.toBe(false)
})

test("rectify", async () => {
  const container = { childProcess: {} }
  const asserter = new AutoToolProjectMade(container)

  // Good config
  container.childProcess.exec = async () => ({})
  await expect(asserter.rectify()).resolves.toBeUndefined()

  // Bad config
  asserter.assertNode = createAssertNode(asserter, {})
  container.childProcess.exec = async () => {
    throw new Error("unknown")
  }
  await expect(asserter.rectify()).rejects.toThrow(ScriptError)
})

test("result", () => {
  const asserter = new AutoToolProjectMade({})

  asserter.expandedDirectory = "blah"
  asserter.expandedTarget = "blah"

  expect(asserter.result()).toEqual({
    directory: asserter.expandedDirectory,
    args: asserter.expandedTarget,
  })
})

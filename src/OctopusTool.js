import parseArgs from "minimist"
import * as version from "./version"
import { SSH } from "./ssh"
import { SFTP } from "./sftp"
import fs from "fs-extra"
import vm from "vm"
import path from "path"
import JSON5 from "@johnls/json5"
import autobind from "autobind-decorator"
import merge from "merge"
import * as asserters from "./asserters"
import util from "./util"
import ora from "ora"
import { ScriptError } from "./ScriptError"
import semver from "semver"

@autobind
export class OctopusTool {
  constructor(container = {}) {
    this.toolName = container.toolName
    this.fs = container.fs || fs
    this.log = container.log
    this.util = container.util || util
    this.asserters = container.asserters || asserters
    this.process = container.process || process
    this.ora = container.ora || ora
    this.createSsh = container.createSsh || ((options) => new SSH(options))
    this.createSftp = container.createSftp || ((options) => new SFTP(options))
    this.debug = container.debug
  }

  static minNodeVersion = "v10.17.0"

  async assertHasNode(ssh) {
    let result = await ssh.run("node --version", {
      noThrow: true,
    })

    return (
      result.exitCode === 0 &&
      result.output.length > 0 &&
      semver.gte(semver.clean(result.output[0]), OctopusTool.minNodeVersion)
    )
  }

  async rectifyHasNode(ssh, sftp) {
    let result = null
    const nodeMajorVersion = semver.major(OctopusTool.minNodeVersion)
    const installNodeScript = `#!/bin/bash
    VERSION=$(grep -Eo "\\(Red Hat|\\(Ubuntu" /proc/version)
    case $VERSION in
      "(Red Hat")
        curl -sL https://rpm.nodesource.com/setup_${nodeMajorVersion}.x | bash -
        yum clean all
        yum makecache fast
        yum install -y -q make
        yum install -y -q nodejs node-gyp
        ;;
      "(Ubuntu")
        curl -sL https://deb.nodesource.com/setup_${nodeMajorVersion}.x | bash -
        apt update
        apt install -y -q g++ make
        apt install -y -q nodejs node-gyp
        ;;
      *)
        echo Unsupported Linux distro
        exit 255
        ;;
    esac
  `

    this.log.info("Checking remote system clock")
    result = await ssh.run('bash -c "echo /$(date)"', {
      noThrow: true,
    })

    if (
      result.exitCode !== 0 ||
      result.output.length === 0 ||
      !result.output[0].startsWith("/")
    ) {
      throw new Error("Unable to get remote host date & time")
    }

    const remoteDate = new Date(result.output[0].substring(1))
    const localDate = new Date()

    if (
      remoteDate.getFullYear() !== localDate.getFullYear() ||
      remoteDate.getMonth() !== localDate.getMonth() ||
      remoteDate.getDate() !== localDate.getDate()
    ) {
      throw new Error("Remote system clock is more than 24 hours out of sync.")
    }

    const remoteTempFilePath = (await ssh.run("mktemp")).output[0]

    this.log.info(
      `Created remote Node.js install script${
        this.debug ? " (" + remoteTempFilePath + ")" : ""
      }`
    )

    await sftp.putContent(remoteTempFilePath, installNodeScript)

    this.log.info(`Running Node.js install script; this could take a while`)
    result = await ssh.run(`bash ${remoteTempFilePath}`, {
      sudo: true,
      noThrow: true,
    })

    if (result.exitCode === 0) {
      result = await ssh.run("node --version", {
        noThrow: true,
      })

      if (
        result.exitCode === 0 &&
        semver.gte(semver.clean(result.output[0]), OctopusTool.minNodeVersion)
      ) {
        return
      }
    }

    throw new Error(
      `Unable to install Node.js ${OctopusTool.minNodeVersion} on remote host`
    )
  }

  async assertHasOctopus(ssh) {
    let result = await ssh.run("octopus --version", {
      noThrow: true,
    })

    return (
      result.exitCode === 0 &&
      result.output.length > 0 &&
      result.output[0].startsWith(version.shortVersion)
    )
  }

  async rectifyHasOctopus(ssh) {
    this.log.info("Installing Octopus")
    // NOTE: See https://github.com/nodejs/node-gyp/issues/454#issuecomment-58792114 for why "--unsafe-perm"
    let result = await ssh.run("npm install -g --unsafe-perm @johnls/octopus", {
      sudo: true,
      noThrow: true,
    })

    if (result.exitCode === 0) {
      result = await ssh.run("octopus --version", {
        noThrow: true,
      })

      if (
        result.exitCode === 0 &&
        result.output[0].startsWith(version.shortVersion)
      ) {
        return
      }
    }

    throw new Error(
      `Unable to install Octopus ${version.shortVersion} on remote host`
    )
  }

  async readScriptFile(scriptPath) {
    const scriptNode = JSON5.parse(await this.fs.readFile(scriptPath), {
      wantNodes: true,
    })
    const createArrayNode = () => ({
      line: 0,
      column: 0,
      type: "array",
      value: [],
    })
    const createObjectNode = () => ({
      line: 0,
      column: 0,
      type: "object",
      value: {},
    })
    const addFilename = (node) => {
      node.filename = scriptPath

      switch (node.type) {
        case "null":
        case "number":
        case "boolean":
          break
        case "object":
          for (const [key, value] of Object.entries(node.value)) {
            addFilename(value)
          }
          break
        case "array":
          for (const value of node.value) {
            addFilename(value)
          }
          break
      }
    }

    if (scriptNode.type !== "object") {
      throw new ScriptError(
        "Script must have an object as the root",
        scriptNode
      )
    }

    let {
      includes: includesNode,
      settings: settingsNode,
      vars: varsNode,
      assertions: assertionsNode,
    } = scriptNode.value

    if (!includesNode) {
      scriptNode.value.includes = includesNode = createArrayNode()
    }

    if (!settingsNode) {
      scriptNode.value.settings = settingsNode = createObjectNode()
    }

    if (!varsNode) {
      scriptNode.value.vars = varsNode = createObjectNode()
    }

    if (!assertionsNode) {
      scriptNode.value.assertions = assertionsNode = createArrayNode([])
    }

    addFilename(scriptNode)

    if (includesNode.type !== "array") {
      throw new ScriptError("'include' must be an array", includesNode)
    }

    for (const includeNode of includesNode.value) {
      if (includeNode.type !== "string") {
        throw new ScriptError(
          "'include' array item must be a string",
          includeNode
        )
      }
    }

    if (settingsNode.type !== "object") {
      throw new ScriptError("'settings' must be an object", settingsNode)
    }

    const { description: descriptionNode } = settingsNode.value

    if (descriptionNode && descriptionNode.type !== "string") {
      throw new ScriptError("'description' must be a string", descriptionNode)
    }

    if (varsNode.type !== "object") {
      throw new ScriptError("'vars' must be an object", varsNode)
    }

    if (assertionsNode.type !== "array") {
      throw new ScriptError("'assertions' must be an array", assertionsNode)
    }

    for (const assertionNode of assertionsNode.value) {
      if (assertionNode.type !== "object") {
        throw new ScriptError("Assertion must be an object", assertionNode)
      }

      const {
        description: descriptionNode,
        when: whenNode,
        assert: assertNode,
        with: withNode,
      } = assertionNode.value

      if (assertNode) {
        if (assertNode.type !== "string") {
          throw new ScriptError("'assert' must be a string", assertNode)
        }
      } else {
        throw new ScriptError("'assert' property is not present", assertionNode)
      }

      if (descriptionNode && descriptionNode.type !== "string") {
        throw new ScriptError("'description' must be a string", descriptionNode)
      }

      if (
        whenNode &&
        !(whenNode.type === "string" || whenNode.type === "boolean")
      ) {
        throw new ScriptError("'when' must be a string or boolean", whenNode)
      }

      if (withNode && withNode.type !== "object") {
        throw new ScriptError("'with' must be an object", withNode)
      }
    }

    return scriptNode
  }

  async createRunContext(scriptNode, options = {}) {
    const { vars: varsNode } = scriptNode.value
    const osInfo = await this.util.osInfo()
    const runContext = vm.createContext({
      env: process.env,
      os: osInfo,
      user: this.util.userInfo(),
      sys: {
        scriptFile: scriptNode.filename,
        scriptDir: path.dirname(scriptNode.filename),
      },
      fs: {
        readFile: (fileName) =>
          this.fs.readFileSync(fileName, { encoding: "utf8" }),
      },
      path: {
        join: (...paths) => path.join(...paths),
        dirname: (filename) => path.dirname(filename),
      },
      vars: {},
    })
    const expandStringNode = (node) => {
      if (!node.type || node.type !== "string") {
        throw new Error("Must pass in a string node to expand")
      }

      if (node.value.startsWith("{") && node.value.endsWith("}")) {
        try {
          return new vm.Script(node.value).runInContext(runContext)
        } catch (e) {
          throw new ScriptError(`Bad script. ${e.message}`, node)
        }
      } else {
        return node.value
      }
    }

    if (varsNode) {
      const processNode = (node, expand) => {
        if (node.value !== null && node.type === "object") {
          const newValue = {}

          Object.entries(node.value).map(([k, v]) => {
            newValue[k] = processNode(v, k === "local" ? true : expand)
          })

          return newValue
        } else if (node.type === "array") {
          return node.value.map((i) => processNode(i, expand))
        } else if (node.type === "string") {
          if (expand) {
            const newValue = expandStringNode(node)

            node.value = newValue
            return newValue
          } else {
            return node.value
          }
        } else {
          return node.value
        }
      }

      runContext.vars = processNode(varsNode, options.inRunScriptLocally)
    }

    return { runContext, expandStringNode }
  }

  async mergeIncludeNodes(scriptNode, scriptDir, includesNode) {
    if (!includesNode) {
      return
    }

    for (const includeNode of includesNode.value) {
      const newScriptNode = await this.readScriptFile(
        path.resolve(scriptDir, includeNode.value)
      )

      await this.mergeIncludeNodes(
        scriptNode,
        newScriptNode.filename,
        newScriptNode.includesNodes
      )

      const {
        settings: settingsNode,
        vars: varsNode,
        assertions: assertionsNode,
      } = scriptNode.value
      const {
        settings: newSettingsNode,
        vars: newVarsNode,
        assertions: newAssertionsNode,
      } = newScriptNode.value

      settingsNode.value = merge.recursive(
        settingsNode.value,
        newSettingsNode.value
      )
      varsNode.value = merge.recursive(varsNode.value, newVarsNode.value)
      assertionsNode.value = [
        ...assertionsNode.value,
        ...newAssertionsNode.value,
      ]
    }
  }

  async flattenScript(scriptNode) {
    const {
      includes: includesNode,
      settings: settingsNode,
      vars: varsNode,
      assertions: assertionsNode,
    } = scriptNode.value

    await this.mergeIncludeNodes(
      scriptNode,
      path.dirname(scriptNode.filename),
      includesNode
    )

    const settings = JSON5.simplify(settingsNode)
    const vars = JSON5.simplify(varsNode)
    const assertions = JSON5.simplify(assertionsNode)

    for (let i = 0; i < assertions.length; i++) {
      assertions[i]._assertNode = assertionsNode.value[i]
    }

    return {
      vars,
      settings,
      assertions,
    }
  }

  async runScriptLocally(scriptPath, options = {}) {
    const scriptNode = await this.readScriptFile(scriptPath)
    const state = await this.flattenScript(scriptNode)
    const scriptHasBecomes = !!state.assertions.find((assertion) =>
      assertion.hasOwnProperty("become")
    )
    let sudo = null

    if (scriptHasBecomes) {
      if (!this.util.runningAsRoot()) {
        throw new Error(
          "Script requires becoming another user and it is not running as root"
        )
      }

      sudo = {
        uid: parseInt(this.process.env["SUDO_UID"]),
        gid: parseInt(this.process.env["SUDO_GID"]),
      }

      this.process.setegid(sudo.gid)
      this.process.seteuid(sudo.uid)
    }

    // TODO: Document 'settings'
    // TODO: Document 'vars'
    // TODO: Document Javascript modules
    // TODO: Check 'settings' for disk space requirements and fail if there is insufficient

    Object.assign(
      state,
      await this.createRunContext(scriptNode, { inRunScriptLocally: true })
    )

    if (this.debug && Object.keys(state.runContext.vars).length > 0) {
      this.log.info(JSON5.stringify(state.runContext.vars, null, "  "))
    }

    if (state.settings && Object.keys(state.settings).length > 0) {
      this.log.output(
        JSON5.stringify({ description: state.settings.description })
      )
    }

    let spinner = (spinner = this.ora({
      text: "",
      spinner: options.noAnimation ? { frames: [">"] } : "dots",
      color: "green",
    }))

    for (const assertion of state.assertions) {
      const asserterConstructor = this.asserters[assertion.assert]

      if (!asserterConstructor) {
        throw new ScriptError(
          `${assertion.assert} is not a valid asserter`,
          assertion._assertNode
        )
      }

      const asserter = new asserterConstructor({
        expandStringNode: state.expandStringNode,
      })
      const { when: whenNode } = assertion._assertNode.value

      if (whenNode) {
        if (
          (whenNode.type === "boolean" && !whenNode.value) ||
          (whenNode.type === "string" && !state.expandStringNode(whenNode))
        ) {
          continue
        }
      }

      let output = {}
      let rectified = false

      if (assertion.become) {
        this.process.setegid(0)
        this.process.seteuid(0)
      } else if (sudo !== null) {
        this.process.setegid(sudo.gid)
        this.process.seteuid(sudo.uid)
      }

      spinner.start(assertion.assert)

      if (!(await asserter.assert(assertion._assertNode))) {
        await asserter.rectify()
        rectified = true
        output.rectified = assertion.assert
      } else {
        output.asserted = assertion.assert
      }

      if (assertion.description) {
        output.description = assertion.description
      }

      spinner.stop()

      output.result = asserter.result(rectified)
      // TODO: Add result into array of results in context
      this.log.output(JSON5.stringify(output))
    }

    if (sudo !== null) {
      this.process.setegid(sudo.gid)
      this.process.seteuid(sudo.uid)
    }
  }

  async runScriptRemotely(scriptPath, options) {
    // TODO: Remote script errors are not displaying with the original file/line/offset
    const scriptNode = await this.readScriptFile(scriptPath)
    const state = Object.assign(
      await this.flattenScript(scriptNode),
      await this.createRunContext(scriptNode, { inRunScriptLocally: false })
    )
    const newScript = JSON.stringify(
      {
        settings: state.settings,
        vars: state.runContext.vars,
        assertions: state.assertions,
      },
      (key, value) => (key.startsWith("_") ? undefined : value),
      this.debug ? "  " : null
    )
    const scriptHasBecomes = !!state.assertions.find((assertion) =>
      assertion.hasOwnProperty("become")
    )

    if (this.debug) {
      this.log.info("Script after local processing:\n" + newScript)
    }

    let remoteTempFile = null
    let ssh = null
    let sftp = null

    try {
      this.log.info(`Connecting to ${options.host}`)

      ssh = this.createSsh({ debug: this.debug })

      const connectOptions = {
        host: options.host,
        port: options.port,
        user: options.user,
        identity: options.identity,
      }

      await ssh.connect(connectOptions)

      sftp = this.createSftp({ debug: this.debug })

      await sftp.connect(
        Object.assign(connectOptions, {
          loginPasswordPrompts: ssh.loginPasswordPrompts,
        })
      )

      const hasNode = await this.assertHasNode(ssh)
      const hasOctopus = hasNode && (await this.assertHasOctopus(ssh))

      if (!hasNode) {
        this.log.warning(`Node not found; attempting to rectify.`)
        await this.rectifyHasNode(ssh, sftp)
      }

      if (!hasOctopus) {
        this.log.warning(
          `Octopus with version ${version.shortVersion} not found; attempting to rectify`
        )
        await this.rectifyHasOctopus(ssh)
      }

      remoteTempFile = (await ssh.run("mktemp")).output[0]

      this.log.info(
        `Uploading remote script file${
          this.debug ? " (" + remoteTempFile + ")" : ""
        }`
      )

      await sftp.putContent(remoteTempFile, newScript)

      this.log.info(
        `Running Octopus script on remote${scriptHasBecomes ? " as root" : ""}`
      )

      let spinner = this.ora({
        text: line.substring(2),
        spinner: options.noAnimation ? { frames: [">"] } : "dots",
        color: "green",
      })

      await ssh.run(`octopus --noAnimation ${remoteTempFile}`, {
        sudo: scriptHasBecomes,
        logOutput: (line) => {
          spinner.stop()
          this.log.output(line)
        },
        logError: (line) => {
          spinner.stop()
          this.log.outputError(line)
        },
        logStart: (line) => {
          spinner.start(line.substring(2))
        },
        noThrow: true,
      })
    } finally {
      if (remoteTempFile && !this.debug) {
        this.log.info("Deleting remote temp file")
        await ssh.run(`rm ${remoteTempFile}`)
      }

      if (sftp) {
        sftp.close()
      }

      ssh.close()
      this.log.info(`Disconnected from ${options.host}`)
    }
  }

  async run(argv) {
    const options = {
      boolean: ["help", "version", "debug", "noAnimation"],
      string: ["host", "hostFile", "user", "port", "identity"],
      alias: {
        f: "hostFile",
        h: "host",
        i: "identity",
        p: "port",
        u: "user",
        d: "debug",
      },
    }
    const args = parseArgs(argv, options)

    this.debug = args.debug

    if (args.version) {
      this.log.info(`${version.fullVersion}`)
      return
    }

    if (args.help) {
      this.log.info(`
Usage: ${this.toolName} [options] <script-file>

Description:

Runs an Octopus configuration script. If a host or hostFile file is
given then the script will be run on those hosts using SSH. Node.js
and Octopus will be installed on the remote hosts if not already
present. For installation to work the SSH user must have sudo
permissions on the host. If passwords are required for login or
sudo the tool will prompt.

Arguments:
  --help                    Shows this help
  --version                 Shows the tool version
  --host, -h <host>         Remote host name. Default is to run the script
                            directly on the local system
  --port, -p <port>         Remote port number; default is 22
  --user, -u <user>         Remote user name; defaults to current user
  --identity, -i <key>      User identity file
  --hostFile, -f <file>     JSON5 file containing multiple host names
  --noAnimation             Disable spinner animation for long running
                            assertions
`)
      return
    }

    if (args._.length !== 1) {
      throw new Error("Please specify just one script file")
    }

    const scriptPath = path.resolve(args._[0])

    if (
      (args.port || args.user || args.identity) &&
      !args.host &&
      !args.hostFile
    ) {
      throw new Error(
        "'host' or 'hostFile' must be specified with 'port', 'user', 'identity' and arguments"
      )
    }

    let hosts = null

    if (args.host || args.hostFile) {
      hosts = []

      if (args.hostFile) {
        hosts = hosts.concat(JSON5.parse(await this.fs.readFile(args.hostFile)))
      }

      if (args.host) {
        hosts.push({
          host: args.host,
          port: this.util.parsePort(args.port),
          user: args.user,
          identity: args.identity,
        })
      }
    }

    if (hosts) {
      let failures = 0

      for (const host of hosts) {
        try {
          await this.runScriptRemotely(scriptPath, {
            host: host.host,
            port: this.util.parsePort(host.port),
            user: host.user,
            identity: host.identity,
          })
        } catch (error) {
          this.log.error(this.debug ? error : error.message)
          failures += 1
        }
      }

      if (failures > 0) {
        throw new Error(`${failures} hosts were not updated`)
      }
    } else {
      await this.runScriptLocally(scriptPath, {
        spinner: true,
        noAnimation: args.noAnimation,
      })
    }
  }
}

import parseArgs from "minimist"
import { fullVersion } from "./version"
import readlinePassword from "@johnls/readline-password"
import NodeSSH from "node-ssh"
import os from "os"
import autobind from "autobind-decorator"
import validate from "./Validator"
import JSON5 from "json5"
import fs from "fs-extra"
import chalk from "chalk"

@autobind
export class OctopusTool {
  constructor(toolName, log, options) {
    options = options || {}
    this.toolName = toolName
    this.log = log
    this.debug = options.debug
    this.validationConstraints = {
      description: {
        isString: true,
      },
      vars: {
        isObject: true,
      },
      assertions: {
        presence: true,
        isArray: true,
        isAssertion: true, // an assertion contains an "assert" object and a "with" object
      },
    }
  }

  static bootstrapScript = `#!/bin/bash
curl -sL https://deb.nodesource.com/setup_10.x -o ./nodesource_setup.sh
sudo bash ./nodesource_setup.sh
sudo apt -y -q install nodejs
node --version > node_version.txt`

  async createConnection(options) {
    let ssh = new NodeSSH()

    await ssh.connect({
      username: options.username,
      host: options.host,
      port: options.port,
      password: options.password,
      agent: options.agent,
      tryKeyboard: !!options.onKeyboardInteractive,
      onKeyboardInteractive: options.onKeyboardInteractive,
      debug: this.debug ? (detail) => this.log.info(detail) : null,
    })

    this.log.info(
      `CONNECTED: ${options.username}@${options.host}:${options.port}`
    )

    return ssh
  }

  async bootstrapRemote(ssh, username, password, forceBootstrap) {
    const logResult = (result) => {
      this.log.info("STDOUT: " + result.stdout)
      this.log.info("STDERR: " + result.stderr)
    }
    this.log.info("BOOTSTRAP: Creating /opt/octopus directory")
    let result = await ssh.execCommand(
      `sudo mkdir -p /opt/octopus/asserters; sudo chown ${username}:${username} /opt/octopus/asserters`,
      {
        options: { pty: !!password },
        stdin: password + "\n",
      }
    )
    if (result.code !== 0) {
      logResult(result)
    }

    this.log.info("BOOTSTRAP: Creating /opt/octopus/bootstrap.sh script")
    result = await ssh.execCommand(
      `sudo bash -c 'echo "${OctopusTool.bootstrapScript}" > ./bootstrap.sh'`,
      {
        options: { pty: !!password },
        cwd: "/opt/octopus",
        stdin: password + "\n",
      }
    )
    if (result.code !== 0) {
      logResult(result)
    }

    this.log.info(`BOOTSTRAP: Moving Asserters to: /opt/octopus/asserters `)
    try {
      await ssh.putDirectory(
        `${__dirname}/asserters`,
        "/opt/octopus/asserters",
        { recursive: true }
      )
    } catch (ex) {
      this.log.info(
        `Error copying: ${this.printObj(ex)}  ${ex.constructor.name}`
      )
    }

    let runBootstrap = true
    let nodeVersion = "unknown"

    if (!forceBootstrap) {
      this.log.info("BOOTSTRAP: Check if boostrap needs to be run")
      result = await ssh.execCommand("cat node_version.txt", {
        options: { pty: !!password },
        cwd: "/opt/octopus",
        stdin: password + "\n",
      })
      if (result.code == 0) {
        nodeVersion = result.stdout.split("\n")[1]
        runBootstrap = !(nodeVersion == OctopusTool.targetNodeVersion)
      }
    }

    if (runBootstrap) {
      this.log.info("BOOTSTRAP: Running /opt/octopus/bootstrap.sh script")
      result = await ssh.execCommand("sudo bash ./bootstrap.sh", {
        options: { pty: !!password },
        cwd: "/opt/octopus",
        stdin: password + "\n",
      })
      // this.log.info(result)
      if (result.code !== 0) {
        logResult(result)
      }
    } else {
      this.log.info(
        `BOOTSTRAP: Node is up to date: ${nodeVersion}.  Bootstrap skipped`
      )
    }
  }

  async processAssertions(ssh, username, password, assertScript) {
    assertScript = this.expandAssertVariables(assertScript)
    // this.log.info(`Run assertions: ${this.printObj(assertScript)}`)
    const vars = assertScript.vars || {}
    const asserts = assertScript.assertions || []
    let scriptSuccess = true
    let an
    let description
    for (an = 0; an < asserts.length; an++) {
      const assertionSpec = asserts[an]

      const assertionName = assertionSpec.assert
      description =
        assertionSpec.description || `Step ${an + 1}: (${assertionName})`
      const runAs = assertionSpec.runAs || ""

      const args = assertionSpec.with || {}
      const argsString = JSON.stringify(args)
      const args64 = Buffer.from(argsString).toString("base64")
      const sudo = runAs == "sudo" ? "sudo" : ""
      const command = `${sudo} node doAssert.js ${assertionName} base64 ${args64}`

      this.log.info(
        `=============================================================`
      )
      this.log.info(`>>> ${description}\n -------------------------------`)
      //this.log.info(`Run assertion ${command} \n --------------------------`)
      const assertSuccess = await this.runAssertion(
        ssh,
        username,
        password,
        command
      )
      if (!assertSuccess) {
        scriptSuccess = false
        break
      }
    }

    this.log.info(
      chalk.blue(
        `=============================================================`
      )
    )
    if (scriptSuccess) {
      this.log.info(chalk.green(">>> Script Completed Successfully"))
    } else {
      this.log.info(
        chalk.red(`>>> Script Failed at step ${an} (${description})`)
      )
    }
    this.log.info(
      chalk.blue(
        `=============================================================`
      )
    )
  }

  async runAssertion(ssh, username, password, command) {
    const result = await ssh.execCommand(command, {
      options: { pty: !!password },
      cwd: "/opt/octopus/asserters",
      stdin: password + "\n",
    })
    const success = result.code == 0
    const response = result.stdout
    if (success) {
      this.log.info(
        chalk.green(`Assertion Success: ${success}\nResponse:\n${response}`)
      )
    } else {
      this.log.info(
        chalk.red(`Assertion Success: ${success}\nResponse:\n${response}`)
      )
    }

    return success
  }

  expandAssertVariables(assertionScript) {
    const varExpander = (tpl, args) =>
      tpl.replace(/\${(\w+)}/g, (_, v) => args[v])
    const variables = assertionScript.vars || {}
    const assertions = assertionScript.assertions || {}
    const assertionsString = JSON.stringify(assertions)
    const expanded = varExpander(assertionsString, variables)
    return { vars: variables, assertions: JSON.parse(expanded) }
  }

  printObj(obj) {
    return JSON.stringify(obj, null, 2)
  }

  async run(argv) {
    const options = {
      boolean: ["help", "version", "force-bootstrap"],
      string: ["host", "hosts-file", "user", "port", "password"],
      alias: {
        h: "host",
        u: "user",
        p: "port",
        f: "hosts-file",
        P: "password",
        F: "force-bootstrap",
      },
    }
    const args = parseArgs(argv, options)

    this.debug = args.debug

    if (args.version) {
      this.log.info(`${fullVersion}`)
      return 0
    }

    if (args.help) {
      this.log.info(`
Usage: ${this.toolName} [options] <script-file>

Description:

Runs an Octopus configuration script on one or more hosts over SSH.

Options:
  --help              Shows this help
  --version           Shows the tool version
  --host, -h          The SSH host name
  --user, -u          The SSH user name
  --port, -p          The SSH port number
  --password, -P      SSH password
  --hosts-file, -f    JSON5 file containing multiple host names
  --force-bootstrap, -F Force execution of node bootstrap
`)
      return 0
    }

    const assertFile = args._[0]

    if (!assertFile) {
      throw new Error("Please specify a script file")
    }

    const forceBootstrap = args["force-bootstrap"]

    const assertScript = JSON5.parse(await fs.readFile(assertFile))
    const validityCheck = validate(assertScript, this.validationConstraints)

    let validationMessage =
      validityCheck || "Validation complete: no errors found."
    let ssh = null

    try {
      const userInfo = os.userInfo()

      ssh = await this.createConnection({
        username: args.user || userInfo.username,
        host: args.host || "localhost",
        port: args.port ? parseInt(args.port) : 22,
        password: args.password,
        agent: process.env["SSH_AUTH_SOCK"],
        onKeyboardInteractive: async (
          name,
          instructions,
          instructionsLang,
          prompts,
          finish
        ) => {
          const rl = readlinePassword.createInstance(
            process.stdin,
            process.stdout
          )
          let responses = []

          for (const prompt of prompts) {
            responses.push(await rl.passwordAsync(prompt))
          }
          rl.close()
          finish(responses)
        },
      })

      await this.bootstrapRemote(ssh, args.user, args.password, forceBootstrap)
      await this.processAssertions(ssh, args.user, args.password, assertScript)
    } finally {
      if (ssh) {
        ssh.dispose()
        this.log.info("DISCONNECTED")
      }

      process.stdin.unref() // To free the Node event loop
    }

    return 0
  }

  printObj(object) {
    return JSON.stringify(object, null, 2)
  }
}

import fs from "fs-extra"

/*
Checks and ensures that a user is enabled.

Example:

{
  assert: "userEnabled",
  with: {
    name: "userName"
  }
}
*/

export class UserEnabledAsserter {
  async assert(args) {
    try {
      // TODO : check if user is enabled using something from https://www.thegeekdiary.com/unix-linux-how-to-lock-or-disable-an-user-account/
      return false
    } catch (error) {
      return false
    }
  }

  async run(args) {
    try {
      // TODO : enable the user
      return true
    } catch (error) {
      return false
    }
  }
}
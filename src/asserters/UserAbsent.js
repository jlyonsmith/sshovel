import fs from "fs-extra"

/*
Checks and ensures that a user is absent.

Example:

{
  assert: "userAbsent",
  with: {
    name: "userName"
  }
}
*/

export class UserAbsentAsserter {
  async assert(args) {
    try {
      // TODO : check if user is absent using something from https://stackoverflow.com/questions/14810684/check-whether-a-user-exists
      return false
    } catch (error) {
      return false
    }
  }

  async run(args) {
    try {
      // TODO : remove the user
      return true
    } catch (error) {
      return false
    }
  }
}

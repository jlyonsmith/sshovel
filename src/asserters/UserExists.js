import fs from "fs-extra"

/*
Checks and ensures that a user exists.

Example:

{
  assert: "userExists",
  with: {
    name: "userName"
  }
}
*/

export class UserExistsAsserter {
  async assert(args) {
    try {
      // TODO : check if user exists using something from https://stackoverflow.com/questions/14810684/check-whether-a-user-exists
      return false
    } catch (error) {
      return false
    }
  }

  async run(args) {
    try {
      // TODO : create the user
      return true
    } catch (error) {
      return false
    }
  }
}

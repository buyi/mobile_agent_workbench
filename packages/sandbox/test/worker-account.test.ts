import { expect, test } from "bun:test"
import { parseDirectoryAttributes } from "../src/worker-account"

test("dscl native IsHidden and standard account fields parse without losing colon-bearing values", () => {
  const attributes = parseDirectoryAttributes("dsAttrTypeNative:IsHidden: 1\nUniqueID: 420\ndsAttrTypeStandard:PrimaryGroupID: 420\nNFSHomeDirectory: /private/var/loopit/name:worker\nUserShell: /usr/bin/false\nPassword: *\n")
  expect(attributes).toEqual({ IsHidden: "1", UniqueID: "420", PrimaryGroupID: "420", NFSHomeDirectory: "/private/var/loopit/name:worker", UserShell: "/usr/bin/false", Password: "*" })
})

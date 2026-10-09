import { expect, test } from "bun:test"
import { publicProbeIPv4 } from "./public-network"

test("public TCP endpoint cannot be a hostname, private or special-use address", () => {
  for (const value of ["", "localhost", "www.apple.com", "127.0.0.1", "127.1", "2130706433", "0177.0.0.1", "127.0.0.1:443", "::1",
    "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.1.1", "100.64.0.1", "100.127.255.255",
    "0.0.0.0", "192.0.0.1", "192.0.2.1", "192.88.99.1", "198.18.0.1", "198.19.0.1", "198.51.100.1", "203.0.113.1",
    "224.0.0.1", "240.0.0.1", "255.255.255.255", " 1.1.1.1", "1.1.1.1\n"]) expect(() => publicProbeIPv4(value)).toThrow()
})

test("public TCP endpoint preserves the exact IPv4 for baseline and denial", () => {
  expect(publicProbeIPv4()).toBe("1.1.1.1")
  for (const ip of ["111.132.47.193", "172.66.147.243", "104.16.124.96"]) expect(publicProbeIPv4(ip)).toBe(ip)
})

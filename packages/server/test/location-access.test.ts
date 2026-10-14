import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

const permissionTest = process.platform === "win32" || process.getuid?.() === 0 ? it.live.skip : it.live

permissionTest(
  "maps an unreadable location directory to 403 instead of 500",
  () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const secret = path.join(tmp.path, "secret")
      const project = path.join(secret, "project")
      yield* Effect.promise(async () => {
        await fs.mkdir(project, { recursive: true })
        await fs.mkdir(path.join(tmp.path, "config"), { recursive: true })
        await fs.chmod(secret, 0o000)
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.chmod(secret, 0o755)))

      const server = yield* startServer(path.join(tmp.path, "config"))
      const url = new URL("/api/location", server.base)
      url.searchParams.set("location[directory]", project)
      const response = yield* Effect.promise(() => fetch(url, { headers: server.headers }))
      expect(response.status).toBe(403)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        _tag: "ForbiddenError",
        message: `Access denied to directory: ${project}`,
      })
    }),
  15_000,
)

it.live(
  "maps a missing location directory to 404 instead of 500",
  () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "config"), { recursive: true }))
      const missing = path.join(tmp.path, "absent")

      const server = yield* startServer(path.join(tmp.path, "config"))
      const url = new URL("/api/location", server.base)
      url.searchParams.set("location[directory]", missing)
      const response = yield* Effect.promise(() => fetch(url, { headers: server.headers }))
      expect(response.status).toBe(404)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        _tag: "LocationNotFoundError",
      })
    }),
  15_000,
)

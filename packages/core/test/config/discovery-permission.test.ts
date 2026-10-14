import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, FileSystem, Layer, PlatformError } from "effect"
import { ConfigDiscovery } from "@opencode/core/config/discovery"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { filesystem } from "@opencode/util/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { it } from "../lib/effect"

// Config discovery walks every ancestor of the location with `fs.resolve`,
// which only tolerates NotFound. Any other failure (PermissionDenied, or the
// macOS Unknown+EPERM privacy shape) becomes a defect, and the defect escapes
// layer construction as an HTTP 500 on /api/location.
// The global roots live under the temp dir so the only unreadable path in the
// fixture is the one the test controls.
const globalLayer = (base: string) =>
  Global.layerWith({
    home: path.join(base, "home"),
    data: path.join(base, "data"),
    cache: path.join(base, "cache"),
    config: path.join(base, "config"),
    state: path.join(base, "state"),
    tmp: path.join(base, "tmp"),
    bin: path.join(base, "cache", "bin"),
    log: path.join(base, "data", "log"),
    repos: path.join(base, "data", "repos"),
  })

const discoveryLayer = (directory: string, base: string, fsutil: Layer.Layer<FSUtil.Service>) =>
  Layer.mergeAll(
    fsutil,
    Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
    globalLayer(base),
  )

const dieReasons = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.filter(Cause.isDieReason) : []

const withTmp = <A, E, R>(f: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(tmp.path)))

const permissionTest = process.platform === "win32" || process.getuid?.() === 0 ? it.live.skip : it.live

describe("ConfigDiscovery permission handling", () => {
  permissionTest("tolerates a PermissionDenied (EACCES) unreadable ancestor", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const secret = path.join(dir, "secret")
        const project = path.join(secret, "project")
        yield* Effect.promise(async () => {
          await fs.mkdir(project, { recursive: true })
          await fs.chmod(secret, 0o000)
        })
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.chmod(secret, 0o755)))

        const exit = yield* ConfigDiscovery.discover().pipe(
          Effect.exit,
          Effect.provide(discoveryLayer(project, dir, LayerNode.compile(FSUtil.node))),
        )

        expect(dieReasons(exit)).toEqual([])
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    ),
  )

  it.live("tolerates the macOS Unknown+EPERM privacy shape from realPath", () =>
    withTmp((dir) =>
      Effect.gen(function* () {
        const project = path.join(dir, "project")
        yield* Effect.promise(() => fs.mkdir(project, { recursive: true }))
        const cause = PlatformError.systemError({
          _tag: "Unknown",
          module: "FileSystem",
          method: "realPath",
          pathOrDescriptor: project,
          cause: Object.assign(new Error("EPERM"), { code: "EPERM" }),
        })
        const patchedFileSystem = Layer.effect(
          FileSystem.FileSystem,
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            return {
              ...fs,
              realPath: (target: string) => (target === project ? Effect.fail(cause) : fs.realPath(target)),
            }
          }),
        ).pipe(Layer.provide(LayerNode.compile(filesystem)))
        const fsutil = LayerNode.compile(FSUtil.node, {
          replacements: [filesystem.replace(patchedFileSystem)],
        })

        const exit = yield* ConfigDiscovery.discover().pipe(
          Effect.exit,
          Effect.provide(discoveryLayer(project, dir, fsutil)),
        )

        expect(dieReasons(exit)).toEqual([])
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    ),
  )
})

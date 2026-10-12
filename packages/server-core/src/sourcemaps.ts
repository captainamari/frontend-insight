import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, readdir, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import type { RowDataPacket } from "mysql2/promise";
import type { MySqlStore } from "./mysql-store.js";
import type { Principal } from "./model.js";
import {
  type RuntimeDiagnostics,
  DiagnosticAccessError,
} from "./runtime-diagnostics.js";
import { parseErrorStack } from "./error-stack.js";
import {
  canonicalAsset,
  parseSourceMap,
  SOURCEMAP_LIMITS as L,
  SourceMapError,
  type MappedFrame,
} from "./sourcemap-parser.js";
export {
  canonicalAsset,
  parseSourceMap,
  SOURCEMAP_LIMITS,
  SourceMapError,
} from "./sourcemap-parser.js";
export const sha256 = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
export interface SourceMapUpload {
  release: string;
  build: string;
  asset: string;
  assetSha256: string;
  mapSha256: string;
  javascript: string;
  map: string;
  retentionDays: number;
}
interface Artifact extends RowDataPacket {
  id: string;
  project_id: string;
  release_id: string;
  build_id: string;
  asset: string;
  asset_sha256: string;
  map_sha256: string;
  byte_size: number;
  state: string;
  expires_at: Date;
}
export interface SourceMapping {
  state: string;
  derived: true;
  coordinateBase: string;
  frames: (MappedFrame & {
    errorPath: string;
    compiled: ReturnType<typeof parseErrorStack>["frames"][number];
    artifactId?: string;
  })[];
  artifacts: Record<string, unknown>[];
}
export class SourceMaps {
  readonly root: string;
  constructor(
    private readonly mysql: MySqlStore,
    private readonly diagnostics: RuntimeDiagnostics,
    root = process.env.FI_SOURCEMAP_DIR ?? "/var/lib/frontend-insight/sourcemaps",
  ) {
    this.root = resolve(root);
  }
  private path(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new SourceMapError("invalid_id");
    return resolve(this.root, id + ".map");
  }
  private async rows(project: string, id: string) {
    const [rows] = await this.mysql.pool.query<Artifact[]>(
      "SELECT * FROM diagnostic_sourcemaps WHERE project_id=? AND id=?",
      [project, id],
    );
    return rows[0];
  }
  private valid(r: Artifact | undefined) {
    if (!r) throw new SourceMapError("not_found");
    if (r.state !== "ready") throw new SourceMapError(r.state);
    if (new Date(r.expires_at).getTime() <= Date.now())
      throw new SourceMapError("expired");
    return r;
  }
  private metadata(r: Artifact) {
    return {
      id: r.id,
      release: r.release_id,
      build: r.build_id,
      asset: r.asset,
      assetSha256: r.asset_sha256,
      mapSha256: r.map_sha256,
      bytes: r.byte_size,
      state: r.state,
      expiresAt: new Date(r.expires_at).toISOString(),
    };
  }
  async issue(p: Principal, project: string, days: number) {
    await this.diagnostics.manage(p, project, "upload-credential");
    if (!Number.isInteger(days) || days < 1 || days > 30)
      throw new SourceMapError("credential_expiry");
    const id = randomUUID(),
      token = "fi_sm_" + randomBytes(32).toString("hex"),
      expiresAt = new Date(Date.now() + days * 86400000);
    await this.mysql.pool.execute(
      "INSERT INTO diagnostic_upload_credentials(id,project_id,token_hash,created_by,expires_at) VALUES(?,?,?,?,?)",
      [id, project, sha256(token), p.userId, expiresAt],
    );
    await this.diagnostics.audit(
      p.userId,
      project,
      id,
      "sourcemap.credential.issue",
      "success",
    );
    return {
      id,
      token,
      expiresAt: expiresAt.toISOString(),
      purpose: "sourcemap.upload",
    };
  }
  async revoke(p: Principal, project: string, id: string) {
    await this.diagnostics.manage(p, project, id);
    await this.mysql.pool.execute(
      "UPDATE diagnostic_upload_credentials SET revoked=TRUE WHERE project_id=? AND id=?",
      [project, id],
    );
    await this.diagnostics.audit(
      p.userId,
      project,
      id,
      "sourcemap.credential.revoke",
      "success",
    );
    return { id, revoked: true };
  }
  async uploadCredential(token: string, project: string) {
    const [rows] = await this.mysql.pool.query<RowDataPacket[]>(
      `SELECT c.id FROM diagnostic_upload_credentials c JOIN users u ON u.id=c.created_by JOIN projects p ON p.id=c.project_id WHERE c.token_hash=? AND c.project_id=? AND c.revoked=FALSE AND c.expires_at>NOW(3) AND u.status='active' AND u.global_role='admin' AND p.status='active'`,
      [sha256(token), project],
    );
    if (!rows[0]) {
      await this.diagnostics.audit(
        null,
        project,
        "upload-credential",
        "sourcemap.upload",
        "forbidden",
      );
      throw new DiagnosticAccessError("SOURCEMAP_UPLOAD_FORBIDDEN");
    }
    return String(rows[0].id);
  }
  async upload(token: string, project: string, input: SourceMapUpload) {
    const credential = await this.uploadCredential(token, project);
    let id = "upload";
    try {
      if (
        !/^[A-Za-z0-9_.-]{1,64}$/.test(input.release) ||
        !/^[A-Za-z0-9_.-]{1,64}$/.test(input.build) ||
        !Number.isInteger(input.retentionDays) ||
        input.retentionDays < 1 ||
        input.retentionDays > 90
      )
        throw new SourceMapError("invalid_identity");
      const asset = canonicalAsset(input.asset);
      id = sha256(JSON.stringify([project, input.release, input.build, asset]));
      if (
        input.javascript.length > Math.ceil(L.assetBytes / 3) * 4 ||
        input.map.length > Math.ceil(L.mapBytes / 3) * 4
      )
        throw new SourceMapError("upload_budget");
      const js = Buffer.from(input.javascript, "base64"),
        map = Buffer.from(input.map, "base64");
      if (
        js.toString("base64") !== input.javascript ||
        map.toString("base64") !== input.map
      )
        throw new SourceMapError("invalid_encoding");
      if (js.length > L.assetBytes || map.length > L.mapBytes)
        throw new SourceMapError("upload_budget");
      if (sha256(js) !== input.assetSha256 || sha256(map) !== input.mapSha256)
        throw new SourceMapError("checksum_mismatch");
      const parsed = await parseSourceMap(map.toString("utf8"));
      if (parsed.state !== "ready") throw new SourceMapError(parsed.state);
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const c = await this.mysql.pool.getConnection();
      let temporary: string | undefined;
      try {
        await c.beginTransaction();
        await c.query("SELECT id FROM projects WHERE id=? FOR UPDATE", [project]);
        // serialize project quota/identity decisions; check credential again after parsing.
        const [liveCredential] = await c.query<RowDataPacket[]>(
          "SELECT id FROM diagnostic_upload_credentials WHERE id=? AND project_id=? AND revoked=FALSE AND expires_at>NOW(3) FOR UPDATE",
          [credential, project],
        );
        if (!liveCredential.length)
          throw new DiagnosticAccessError("SOURCEMAP_UPLOAD_FORBIDDEN");
        const existing = await this.rows(project, id);
        if (existing) {
          this.valid(existing);
          if (
            existing.asset_sha256 !== input.assetSha256 ||
            existing.map_sha256 !== input.mapSha256
          )
            throw new SourceMapError("identity_conflict");
          // Retry may repair a missing file, but never overwrite conflicting bytes.
          try {
            const old = await this.file(existing);
            if (sha256(old) !== input.mapSha256)
              throw new SourceMapError("storage_corrupt");
          } catch (e) {
            if (!(e instanceof SourceMapError) || e.state !== "storage_missing")
              throw e;
          }
        } else {
          const [quota] = await c.query<RowDataPacket[]>(
            "SELECT COUNT(*) AS n,COALESCE(SUM(byte_size),0) AS bytes FROM diagnostic_sourcemaps WHERE project_id=?",
            [project],
          );
          if (
            Number(quota[0]!.n) >= L.projectFiles ||
            Number(quota[0]!.bytes) + map.length > L.projectBytes
          )
            throw new SourceMapError("project_budget");
        }
        temporary = this.path(id) + "." + randomUUID() + ".tmp";
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(map);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, this.path(id));
        temporary = undefined;
        if (!existing)
          await c.execute(
            "INSERT INTO diagnostic_sourcemaps(id,project_id,release_id,build_id,asset,asset_sha256,map_sha256,byte_size,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
            [
              id,
              project,
              input.release,
              input.build,
              asset,
              input.assetSha256,
              input.mapSha256,
              map.length,
              new Date(Date.now() + input.retentionDays * 86400000),
            ],
          );
        await c.execute(
          "INSERT INTO diagnostic_audit(actor_user_id,project_id,object_id,action,result) VALUES(NULL,?,?,?,?)",
          [
            project,
            `${credential}:${id}`,
            "sourcemap.upload",
            existing ? "idempotent" : "created",
          ],
        );
        await c.commit();
        return {
          ...this.metadata((await this.rows(project, id))!),
          idempotent: Boolean(existing),
        };
      } catch (e) {
        await c.rollback();
        throw e;
      } finally {
        c.release();
        if (temporary) await unlink(temporary).catch(() => {});
      }
    } catch (e) {
      await this.diagnostics.audit(
        null,
        project,
        `${credential}:${id}`,
        "sourcemap.upload",
        e instanceof SourceMapError ? e.state : "failed",
      );
      if (e instanceof SourceMapError || e instanceof DiagnosticAccessError) throw e;
      throw new SourceMapError("storage_unavailable");
    }
  }
  private async file(r: Artifact) {
    try {
      const h = await open(this.path(r.id), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await h.stat();
        if (!stat.isFile() || stat.size > L.mapBytes)
          throw new SourceMapError("storage_corrupt");
        const bytes = await h.readFile();
        if (sha256(bytes) !== r.map_sha256) throw new SourceMapError("storage_corrupt");
        return bytes;
      } finally {
        await h.close();
      }
    } catch (e) {
      if (e instanceof SourceMapError) throw e;
      throw new SourceMapError(
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? "storage_missing"
          : "storage_unavailable",
      );
    }
  }
  async list(p: Principal, project: string) {
    await this.diagnostics.manage(p, project, "artifacts");
    const [rows] = await this.mysql.pool.query<Artifact[]>(
      "SELECT * FROM diagnostic_sourcemaps WHERE project_id=? ORDER BY created_at DESC LIMIT 200",
      [project],
    );
    await this.diagnostics.manage(p, project, "artifacts");
    await this.diagnostics.audit(
      p.userId,
      project,
      "artifacts",
      "sourcemap.list",
      "success",
    );
    return rows.map((r) => this.metadata(r));
  }
  async remove(p: Principal, project: string, id: string) {
    await this.diagnostics.manage(p, project, id);
    // Tombstone first. Failure to unlink never restores access; periodic cleanup retries.
    const c = await this.mysql.pool.getConnection();
    try {
      await c.beginTransaction();
      await c.query("SELECT id FROM projects WHERE id=? FOR UPDATE", [project]);
      await c.execute(
        "UPDATE diagnostic_sourcemaps SET state='deleted' WHERE project_id=? AND id=?",
        [project, id],
      );
      await c.commit();
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
    const row = await this.rows(project, id);
    if (row) await unlink(this.path(id)).catch(() => {});
    await this.diagnostics.audit(p.userId, project, id, "sourcemap.delete", "success");
    return { id, state: "deleted" };
  }
  async download(p: Principal, project: string, id: string) {
    await this.diagnostics.authorize(p, project, id, "diagnostics.export");
    const row = this.valid(await this.rows(project, id)),
      bytes = await this.file(row);
    this.valid(await this.rows(project, id));
    await this.diagnostics.authorize(p, project, id, "diagnostics.export");
    await this.diagnostics.audit(
      p.userId,
      project,
      id,
      "sourcemap.download",
      "success",
    );
    return bytes;
  }
  async map(
    p: Principal,
    project: string,
    event: string,
    raw: Record<string, unknown>,
    release: string | null,
  ): Promise<SourceMapping> {
    await this.diagnostics.authorize(p, project, event, "diagnostics.read");
    const result: SourceMapping = {
      state: "no_frames",
      derived: true,
      coordinateBase: "编译栈与显示行列均从1开始；SourceMap内部列从0开始",
      frames: [],
      artifacts: [],
    };
    const identity = raw.sourceMap as
      | {
          release?: string;
          build?: string;
          baseUrl?: string;
          assets?: { url: string; sha256: string }[];
        }
      | undefined;
    const collect = (error: unknown, path: string, depth: number) => {
      if (!error || typeof error !== "object" || depth > 4) return;
      const e = error as Record<string, unknown>;
      for (const compiled of parseErrorStack(e.stack).frames) {
        if (result.frames.length >= L.frames) {
          result.state = "frame_budget";
          break;
        }
        result.frames.push({ errorPath: path, compiled, state: "identity_missing" });
      }
      collect(e.cause, path + ".cause", depth + 1);
      if (Array.isArray(e.errors))
        e.errors
          .slice(0, 32)
          .forEach((child, i) => collect(child, `${path}.errors[${i}]`, depth + 1));
    };
    collect(raw.error ?? raw, "error", 0);
    const groups = new Map<string, typeof result.frames>();
    for (const frame of result.frames) {
      if (
        !frame.compiled.file ||
        !frame.compiled.line ||
        !frame.compiled.column ||
        frame.compiled.eval ||
        frame.compiled.native
      ) {
        frame.state = "unmappable_frame";
        continue;
      }
      if (!identity?.release || !identity.build || !Array.isArray(identity.assets))
        continue;
      if (identity.release !== release) {
        frame.state = "version_mismatch";
        continue;
      }
      try {
        const asset = canonicalAsset(frame.compiled.file, identity.baseUrl);
        const matches = identity.assets.filter(
          (a) => canonicalAsset(a.url, identity.baseUrl) === asset,
        );
        if (matches.length > 1) {
          frame.state = "ambiguous_asset";
          continue;
        }
        if (!matches.length) {
          frame.state = "asset_mismatch";
          continue;
        }
        const id = sha256(
          JSON.stringify([project, identity.release, identity.build, asset]),
        );
        const row = this.valid(await this.rows(project, id));
        if (row.asset_sha256 !== matches[0]!.sha256) {
          frame.state = "checksum_mismatch";
          continue;
        }
        frame.artifactId = id;
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id)!.push(frame);
      } catch (e) {
        frame.state = e instanceof SourceMapError ? e.state : "storage_unavailable";
      }
    }
    for (const [id, frames] of groups) {
      try {
        const row = this.valid(await this.rows(project, id));
        const parsed = await parseSourceMap(
          (await this.file(row)).toString("utf8"),
          frames.map((f) => ({ line: f.compiled.line!, column: f.compiled.column! })),
        );
        this.valid(await this.rows(project, id));
        frames.forEach((f, i) =>
          Object.assign(f, parsed.frames[i] ?? { state: parsed.state }),
        );
        result.artifacts.push(this.metadata(row));
      } catch (e) {
        frames.forEach((f) => {
          f.state = e instanceof SourceMapError ? e.state : "storage_unavailable";
        });
      }
    }
    // Recheck all artifacts after asynchronous work; no derived result cache.
    for (const [id, frames] of groups) {
      try {
        this.valid(await this.rows(project, id));
      } catch (e) {
        frames.forEach((f) => {
          delete f.original;
          delete f.snippet;
          f.state = e instanceof SourceMapError ? e.state : "storage_unavailable";
        });
      }
    }
    if (result.state !== "frame_budget" && result.frames.length) {
      const ok = result.frames.filter((f) => f.original).length;
      result.state =
        ok === result.frames.length ? "success" : ok ? "partial" : "failed";
    }
    if (Buffer.byteLength(JSON.stringify(result)) > L.outputBytes) {
      result.frames.forEach((f) => {
        delete f.snippet;
        delete f.original;
        f.state = "output_budget";
      });
      result.artifacts = [];
      result.state = "output_budget";
    }
    await this.diagnostics.authorize(p, project, event, "diagnostics.read");
    await this.diagnostics.audit(
      p.userId,
      project,
      event,
      "sourcemap.map",
      result.state,
    );
    return result;
  }
  async cleanup() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.mysql.pool.execute(
      "UPDATE diagnostic_sourcemaps SET state='expired' WHERE state='ready' AND expires_at<=NOW(3)",
    );
    const [rows] = await this.mysql.pool.query<Artifact[]>(
      "SELECT * FROM diagnostic_sourcemaps WHERE state<>'ready' LIMIT 1000",
    );
    for (const r of rows) await unlink(this.path(r.id)).catch(() => {});
    // Crash orphan files are bounded by upload quotas/rate and reclaimed after one hour.
    let seen = 0;
    for (const name of await readdir(this.root)) {
      if (++seen > 10000) break;
      if (!/^[a-f0-9]{64}\.map(?:\.[a-f0-9-]{36}\.tmp)?$/.test(name)) continue;
      const path = resolve(this.root, name),
        stat = await lstat(path);
      if (Date.now() - stat.mtimeMs < 3600000) continue;
      const [r] = await this.mysql.pool.query<RowDataPacket[]>(
        "SELECT id FROM diagnostic_sourcemaps WHERE id=?",
        [name.slice(0, 64)],
      );
      if (name.endsWith(".tmp") || !r.length) await unlink(path).catch(() => {});
    }
    await this.mysql.pool.execute(
      "DELETE FROM diagnostic_sourcemaps WHERE state<>'ready' AND expires_at<DATE_SUB(NOW(),INTERVAL 90 DAY)",
    );
    await this.mysql.pool.execute(
      "DELETE FROM diagnostic_upload_credentials WHERE expires_at<DATE_SUB(NOW(),INTERVAL 90 DAY)",
    );
    return { state: "cleaned" };
  }
}

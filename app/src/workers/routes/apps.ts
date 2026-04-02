import { Hono } from "hono";
import type { Env, AppManifest } from "../../types";

type AppsApp = {
  Bindings: Env;
  Variables: {
    userId: string;
    email: string;
  };
};

const apps = new Hono<AppsApp>();

interface DbAppRow {
  id: string;
  name: string;
  slug: string;
  manifest_json: string;
  status: string;
  entry_url: string;
  auth_type: string;
  created_at: string;
}

function validateManifest(
  body: unknown,
): { valid: true; manifest: AppManifest } | { valid: false; error: string } {
  const m = body as Record<string, unknown>;
  const required = [
    "id",
    "name",
    "version",
    "description",
    "author",
    "category",
    "auth",
    "entry_url",
    "iframe",
    "tools",
    "completion_events",
  ];
  for (const field of required) {
    if (m[field] === undefined || m[field] === null) {
      return { valid: false, error: `Missing required field: ${field}` };
    }
  }

  if (typeof m.id !== "string" || m.id.length === 0) {
    return { valid: false, error: "id must be a non-empty string" };
  }
  if (typeof m.entry_url !== "string" || m.entry_url.length === 0) {
    return { valid: false, error: "entry_url must be a non-empty string" };
  }

  const tools = m.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    return { valid: false, error: "tools must be a non-empty array" };
  }

  for (let i = 0; i < tools.length; i++) {
    const t = tools[i] as Record<string, unknown>;
    if (!t.name || !t.description) {
      return {
        valid: false,
        error: `tools[${i}] must have name and description`,
      };
    }
    const params = t.parameters as Record<string, unknown> | undefined;
    if (!params || params.type !== "object") {
      return {
        valid: false,
        error: `tools[${i}].parameters must have type "object"`,
      };
    }
  }

  return { valid: true, manifest: m as unknown as AppManifest };
}

async function rebuildAppList(db: D1Database, kv: KVNamespace): Promise<void> {
  const { results } = await db
    .prepare(
      "SELECT id, name, manifest_json, entry_url, auth_type FROM apps WHERE status = 'approved'",
    )
    .all<{
      id: string;
      name: string;
      manifest_json: string;
      entry_url: string;
      auth_type: string;
    }>();

  const summaries = results.map((row) => {
    let description = "";
    let category = "";
    try {
      const manifest = JSON.parse(row.manifest_json) as AppManifest;
      description = manifest.description;
      category = manifest.category;
    } catch {
      /* skip */
    }
    return {
      id: row.id,
      name: row.name,
      description,
      category,
      authType: row.auth_type,
      entryUrl: row.entry_url,
    };
  });

  await kv.put("app:list", JSON.stringify(summaries));
}

// ── POST /register ──────────────────────────────────────────────────────

apps.post("/register", async (c) => {
  const body = await c.req.json();
  const validation = validateManifest(body);
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  const manifest = validation.manifest;
  const slug = manifest.id.toLowerCase().replace(/[^a-z0-9-]/g, "-");

  await c.env.APP_MANIFESTS.put(
    `app:${manifest.id}`,
    JSON.stringify(manifest),
  );

  await c.env.DB.prepare(
    `INSERT INTO apps (id, name, slug, manifest_json, status, entry_url, auth_type)
     VALUES (?, ?, ?, ?, 'approved', ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       slug = excluded.slug,
       manifest_json = excluded.manifest_json,
       status = 'approved',
       entry_url = excluded.entry_url,
       auth_type = excluded.auth_type`,
  )
    .bind(
      manifest.id,
      manifest.name,
      slug,
      JSON.stringify(manifest),
      manifest.entry_url,
      manifest.auth.type,
    )
    .run();

  await rebuildAppList(c.env.DB, c.env.APP_MANIFESTS);

  return c.json(
    {
      id: manifest.id,
      name: manifest.name,
      slug,
      status: "approved",
      entryUrl: manifest.entry_url,
      authType: manifest.auth.type,
    },
    201,
  );
});

// ── GET / ────────────────────────────────────────────────────────────────

apps.get("/", async (c) => {
  const cached = await c.env.APP_MANIFESTS.get("app:list", "text");
  if (cached) {
    return c.json(JSON.parse(cached));
  }

  const { results } = await c.env.DB.prepare(
    "SELECT id, name, slug, manifest_json, entry_url, auth_type FROM apps WHERE status = 'approved'",
  ).all<DbAppRow>();

  const list = results.map((row) => {
    let description = "";
    let category = "";
    try {
      const manifest = JSON.parse(row.manifest_json) as AppManifest;
      description = manifest.description;
      category = manifest.category;
    } catch {
      /* skip */
    }
    return {
      id: row.id,
      name: row.name,
      description,
      category,
      authType: row.auth_type,
      entryUrl: row.entry_url,
    };
  });

  return c.json(list);
});

// ── GET /:id/manifest ────────────────────────────────────────────────────

apps.get("/:id/manifest", async (c) => {
  const appId = c.req.param("id");
  const manifest = await c.env.APP_MANIFESTS.get<AppManifest>(
    `app:${appId}`,
    "json",
  );

  if (!manifest) {
    return c.json({ error: "App not found" }, 404);
  }

  return c.json(manifest);
});

export default apps;

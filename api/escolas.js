import { attachDatabasePool } from '@vercel/functions';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Pool } = pg;
const connectionString =
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL ||
  process.env.POSTGRES_PRISMA_URL;

const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
});

attachDatabasePool(pool);

const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schools (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

async function query(text, params) {
  if (!connectionString) {
    throw new Error('Configure DATABASE_URL ou POSTGRES_URL no projeto da Vercel.');
  }
  return pool.query(text, params);
}

async function ensureTable() {
  await query(TABLE_SQL);
}

function normalizeSchool(raw) {
  const school = raw && typeof raw === 'object' ? raw : {};
  const id = String(school.id || randomUUID());
  const updatedAt = school.updatedAt || new Date().toISOString();
  return { ...school, id, updatedAt };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    await ensureTable();

    if (req.method === 'GET') {
      const { rows } = await query(`
        SELECT data
        FROM schools
        ORDER BY updated_at DESC
      `);
      return res.status(200).json(rows.map((row) => row.data));
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '[]') : req.body;
      const payload = Array.isArray(body) ? body : body?.schools;
      if (!Array.isArray(payload)) {
        return res.status(400).json({ error: 'Envie uma lista de escolas.' });
      }

      const schools = payload.map(normalizeSchool);
      const ids = schools.map((school) => school.id);

      for (const school of schools) {
        await query(`
          INSERT INTO schools (id, data, updated_at)
          VALUES ($1, $2::jsonb, NOW())
          ON CONFLICT (id)
          DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
        `, [school.id, JSON.stringify(school)]);
      }

      if (ids.length) {
        await query('DELETE FROM schools WHERE NOT (id = ANY($1::text[]))', [ids]);
      } else {
        await query('DELETE FROM schools');
      }

      return res.status(200).json({ ok: true, count: schools.length });
    }

    return res.status(405).json({ error: 'Metodo nao permitido.' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: 'Erro ao acessar o banco de dados.',
      detail: error.message
    });
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { TODOS, ROLES_INICIALES } from './permisos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS roles (
  id SERIAL PRIMARY KEY,
  nombre TEXT UNIQUE NOT NULL,
  descripcion TEXT NOT NULL DEFAULT '',
  sistema BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS rol_permisos (
  rol_id INT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permiso TEXT NOT NULL,
  PRIMARY KEY (rol_id, permiso)
);
CREATE TABLE IF NOT EXISTS usuarios (
  id SERIAL PRIMARY KEY,
  usuario TEXT UNIQUE NOT NULL,
  nombre TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  rol_id INT NOT NULL REFERENCES roles(id),
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  creado TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS personal (
  id SERIAL PRIMARY KEY,
  dni TEXT UNIQUE NOT NULL,
  nombre TEXT NOT NULL,
  apellido TEXT NOT NULL,
  telefono TEXT NOT NULL DEFAULT '',
  observaciones TEXT NOT NULL DEFAULT '',
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  creado TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS turnos (
  id SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL,
  fecha TEXT NOT NULL,          -- YYYY-MM-DD (día en que arranca el turno)
  hora_inicio TEXT NOT NULL,    -- HH:MM
  hora_fin TEXT NOT NULL,       -- HH:MM (si es menor al inicio, termina al día siguiente)
  puesto TEXT NOT NULL DEFAULT '',
  tolerancia INT NOT NULL DEFAULT 10,
  color TEXT NOT NULL DEFAULT '#6366f1',
  creado TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS turnos_fecha_idx ON turnos(fecha);
-- Cada asignación es una fila de la planilla: quién debe presentarse en qué turno y cuándo marcó.
CREATE TABLE IF NOT EXISTS asignaciones (
  id SERIAL PRIMARY KEY,
  turno_id INT NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
  personal_id INT NOT NULL REFERENCES personal(id) ON DELETE CASCADE,
  puesto TEXT NOT NULL DEFAULT '',
  entrada TIMESTAMPTZ,
  salida TIMESTAMPTZ,
  entrada_por INT REFERENCES usuarios(id) ON DELETE SET NULL,
  salida_por INT REFERENCES usuarios(id) ON DELETE SET NULL,
  observaciones TEXT NOT NULL DEFAULT '',
  UNIQUE (turno_id, personal_id)
);
CREATE TABLE IF NOT EXISTS auditoria (
  id SERIAL PRIMARY KEY,
  usuario_id INT REFERENCES usuarios(id) ON DELETE SET NULL,
  accion TEXT NOT NULL,
  detalle TEXT NOT NULL DEFAULT '',
  fecha TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let impl;

export async function initDb() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    const pool = new pg.Pool({
      connectionString: url,
      ssl: local || process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
      max: 5,
    });
    pool.on('error', (e) => console.error('Error en conexión inactiva de Postgres:', e.message));
    impl = {
      kind: 'Postgres',
      query: (sql, params) => pool.query(sql, params),
      exec: (sql) => pool.query(sql),
      async transaction(fn) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const r = await fn({ query: (s, p) => c.query(s, p) });
          await c.query('COMMIT');
          return r;
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        } finally {
          c.release();
        }
      },
    };
  } else {
    // Sin DATABASE_URL: Postgres embebido (PGlite) guardado en ./data. Ideal para probar en la PC.
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = process.env.PGLITE_DIR || path.join(__dirname, '..', 'data', 'pglite');
    fs.mkdirSync(dir, { recursive: true });
    const db = new PGlite(dir);
    await db.waitReady;
    impl = {
      kind: `PGlite local (${dir})`,
      query: (sql, params) => db.query(sql, params),
      exec: (sql) => db.exec(sql),
      transaction: (fn) => db.transaction((t) => fn({ query: (s, p) => t.query(s, p) })),
    };
  }
  await impl.exec(SCHEMA);
  await seed();
  return impl.kind;
}

export const query = async (sql, params = []) => (await impl.query(sql, params)).rows;
export const one = async (sql, params = []) => (await query(sql, params))[0] || null;
export const tx = (fn) =>
  impl.transaction((t) => fn({ query: async (s, p = []) => (await t.query(s, p)).rows }));

async function seed() {
  let admin = await one('SELECT id FROM roles WHERE sistema');
  if (!admin) {
    admin = await one(
      `INSERT INTO roles (nombre, descripcion, sistema) VALUES ('Administrador', 'Acceso total al sistema', TRUE) RETURNING id`,
    );
    for (const r of ROLES_INICIALES) {
      const rol = await one(
        'INSERT INTO roles (nombre, descripcion) VALUES ($1, $2) ON CONFLICT (nombre) DO NOTHING RETURNING id',
        [r.nombre, r.descripcion],
      );
      if (!rol) continue;
      for (const p of r.permisos) await query('INSERT INTO rol_permisos VALUES ($1, $2)', [rol.id, p]);
    }
  }
  // El rol de sistema siempre tiene todos los permisos (incluso los que se agreguen en el futuro).
  for (const p of TODOS) {
    await query('INSERT INTO rol_permisos VALUES ($1, $2) ON CONFLICT DO NOTHING', [admin.id, p]);
  }

  const { n } = await one('SELECT COUNT(*)::int AS n FROM usuarios');
  if (!n) {
    const usuario = (process.env.ADMIN_USER || 'admin').toLowerCase();
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    await query('INSERT INTO usuarios (usuario, nombre, password_hash, rol_id) VALUES ($1, $2, $3, $4)', [
      usuario,
      'Administrador',
      await bcrypt.hash(password, 10),
      admin.id,
    ]);
    console.log(`Usuario inicial creado: "${usuario}"${process.env.ADMIN_PASSWORD ? '' : ' / contraseña "admin123" (¡cambiala!)'}`);
  }
}

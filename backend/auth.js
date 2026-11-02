import crypto from 'node:crypto';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { query, one } from './db.js';

const SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
  console.warn('JWT_SECRET no definido: se generó uno temporal (las sesiones se cierran al reiniciar).');
}
const HORAS_SESION = Number(process.env.SESSION_HOURS) || 24;

export async function cargarUsuario(id) {
  const u = await one(
    `SELECT u.id, u.usuario, u.nombre, u.activo, u.rol_id, r.nombre AS rol, r.sistema
       FROM usuarios u JOIN roles r ON r.id = u.rol_id WHERE u.id = $1`,
    [id],
  );
  if (!u) return null;
  u.permisos = (await query('SELECT permiso FROM rol_permisos WHERE rol_id = $1', [u.rol_id])).map((p) => p.permiso);
  return u;
}

// Verifica el token y recarga usuario + permisos en cada request,
// así un cambio de rol o una baja se aplica al instante.
export async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  let payload;
  try {
    payload = jwt.verify(token, SECRET);
  } catch {
    return res.status(401).json({ error: 'Sesión vencida o inválida' });
  }
  const u = await cargarUsuario(payload.id);
  if (!u || !u.activo) return res.status(401).json({ error: 'Usuario inexistente o dado de baja' });
  req.user = u;
  next();
}

export const tiene = (req, p) => req.user.permisos.includes(p);

// Requiere al menos uno de los permisos indicados.
export const can =
  (...permisos) =>
  (req, res, next) =>
    permisos.some((p) => tiene(req, p)) ? next() : res.status(403).json({ error: 'No tenés permiso para esta acción' });

export async function log(req, accion, detalle = '') {
  try {
    await query('INSERT INTO auditoria (usuario_id, accion, detalle) VALUES ($1, $2, $3)', [
      req.user?.id ?? null,
      accion,
      String(detalle).slice(0, 500),
    ]);
  } catch (e) {
    console.error('No se pudo registrar auditoría:', e.message);
  }
}

// Límite simple de intentos de login por IP (10 fallos cada 15 minutos).
const intentos = new Map();
const VENTANA = 15 * 60 * 1000;
function bloqueado(ip) {
  const e = intentos.get(ip);
  if (e && Date.now() - e.desde > VENTANA) intentos.delete(ip);
  return (intentos.get(ip)?.n ?? 0) >= 10;
}
function fallo(ip) {
  const e = intentos.get(ip) ?? { n: 0, desde: Date.now() };
  e.n++;
  intentos.set(ip, e);
}

export const authRouter = Router();

authRouter.post('/login', async (req, res) => {
  if (bloqueado(req.ip)) return res.status(429).json({ error: 'Demasiados intentos. Probá de nuevo en 15 minutos.' });
  const usuario = String(req.body.usuario || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const u = await one('SELECT id, password_hash, activo FROM usuarios WHERE usuario = $1', [usuario]);
  if (!u || !u.activo || !(await bcrypt.compare(password, u.password_hash))) {
    fallo(req.ip);
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
  intentos.delete(req.ip);
  const token = jwt.sign({ id: u.id }, SECRET, { expiresIn: `${HORAS_SESION}h` });
  req.user = { id: u.id };
  await log(req, 'sesion.ingreso', `IP ${req.ip}`);
  res.json({ token, user: await cargarUsuario(u.id) });
});

authRouter.get('/me', auth, (req, res) => res.json(req.user));

authRouter.post('/password', auth, async (req, res) => {
  const { actual = '', nueva = '' } = req.body;
  if (String(nueva).length < 6) return res.status(400).json({ error: 'La contraseña nueva debe tener al menos 6 caracteres' });
  const u = await one('SELECT password_hash FROM usuarios WHERE id = $1', [req.user.id]);
  if (!(await bcrypt.compare(String(actual), u.password_hash))) {
    return res.status(400).json({ error: 'La contraseña actual no es correcta' });
  }
  await query('UPDATE usuarios SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(String(nueva), 10), req.user.id]);
  await log(req, 'sesion.cambio_clave');
  res.json({ ok: true });
});

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query, one, tx } from './db.js';
import { auth, can, tiene, log } from './auth.js';
import { PERMISOS } from './permisos.js';

const r = Router();
r.use(auth);
r.param('id', (req, res, next, v) => (/^\d{1,9}$/.test(v) ? next() : bad(res, 'ID inválido')));

const bad = (res, error, status = 400) => res.status(status).json({ error });
const txt = (s, max = 200) => String(s ?? '').trim().slice(0, max);
const soloDigitos = (s) => String(s ?? '').replace(/\D/g, '');
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const nombrePersona = (p) => `${p.apellido}, ${p.nombre} (DNI ${p.dni})`;

// ───────────────────────── Roles y permisos ─────────────────────────

r.get('/permisos', can('roles.gestionar'), (req, res) => {
  res.json(Object.entries(PERMISOS).map(([codigo, descripcion]) => ({ codigo, descripcion })));
});

r.get('/roles', can('roles.gestionar', 'usuarios.gestionar'), async (req, res) => {
  res.json(
    await query(`
      SELECT r.id, r.nombre, r.descripcion, r.sistema,
        (SELECT COALESCE(json_agg(permiso ORDER BY permiso), '[]'::json) FROM rol_permisos WHERE rol_id = r.id) AS permisos,
        (SELECT COUNT(*)::int FROM usuarios WHERE rol_id = r.id) AS usuarios
      FROM roles r ORDER BY r.sistema DESC, r.nombre`),
  );
});

const permisosValidos = (arr) => [...new Set((Array.isArray(arr) ? arr : []).filter((p) => PERMISOS[p]))];

r.post('/roles', can('roles.gestionar'), async (req, res) => {
  const nombre = txt(req.body.nombre, 60);
  if (!nombre) return bad(res, 'El nombre del rol es obligatorio');
  const permisos = permisosValidos(req.body.permisos);
  const rol = await tx(async (t) => {
    const [rol] = await t.query('INSERT INTO roles (nombre, descripcion) VALUES ($1, $2) RETURNING id', [
      nombre,
      txt(req.body.descripcion),
    ]);
    for (const p of permisos) await t.query('INSERT INTO rol_permisos VALUES ($1, $2)', [rol.id, p]);
    return rol;
  });
  await log(req, 'rol.crear', `${nombre}: ${permisos.join(', ')}`);
  res.status(201).json(rol);
});

r.put('/roles/:id', can('roles.gestionar'), async (req, res) => {
  const rol = await one('SELECT * FROM roles WHERE id = $1', [req.params.id]);
  if (!rol) return bad(res, 'Rol inexistente', 404);
  const descripcion = txt(req.body.descripcion);
  if (rol.sistema) {
    // El rol Administrador no se renombra ni pierde permisos: evita quedarse sin acceso.
    await query('UPDATE roles SET descripcion = $1 WHERE id = $2', [descripcion, rol.id]);
    return res.json({ ok: true });
  }
  const nombre = txt(req.body.nombre, 60);
  if (!nombre) return bad(res, 'El nombre del rol es obligatorio');
  const permisos = permisosValidos(req.body.permisos);
  await tx(async (t) => {
    await t.query('UPDATE roles SET nombre = $1, descripcion = $2 WHERE id = $3', [nombre, descripcion, rol.id]);
    await t.query('DELETE FROM rol_permisos WHERE rol_id = $1', [rol.id]);
    for (const p of permisos) await t.query('INSERT INTO rol_permisos VALUES ($1, $2)', [rol.id, p]);
  });
  await log(req, 'rol.editar', `${nombre}: ${permisos.join(', ')}`);
  res.json({ ok: true });
});

r.delete('/roles/:id', can('roles.gestionar'), async (req, res) => {
  const rol = await one(
    'SELECT r.*, (SELECT COUNT(*)::int FROM usuarios WHERE rol_id = r.id) AS usuarios FROM roles r WHERE id = $1',
    [req.params.id],
  );
  if (!rol) return bad(res, 'Rol inexistente', 404);
  if (rol.sistema) return bad(res, 'El rol Administrador no se puede eliminar');
  if (rol.usuarios) return bad(res, `El rol tiene ${rol.usuarios} usuario(s). Reasignalos antes de eliminarlo.`);
  await query('DELETE FROM roles WHERE id = $1', [rol.id]);
  await log(req, 'rol.eliminar', rol.nombre);
  res.json({ ok: true });
});

// ───────────────────────── Usuarios ─────────────────────────

r.get('/usuarios', can('usuarios.gestionar'), async (req, res) => {
  res.json(
    await query(`
      SELECT u.id, u.usuario, u.nombre, u.activo, u.rol_id, u.creado, r.nombre AS rol, r.sistema
      FROM usuarios u JOIN roles r ON r.id = u.rol_id ORDER BY u.nombre`),
  );
});

// Impide dejar el sistema sin ningún administrador activo.
async function quedaOtroAdmin(exceptoId) {
  const x = await one(
    'SELECT COUNT(*)::int AS n FROM usuarios u JOIN roles r ON r.id = u.rol_id WHERE r.sistema AND u.activo AND u.id <> $1',
    [exceptoId],
  );
  return x.n > 0;
}

async function validarRol(req, rolId) {
  const rol = await one('SELECT id, sistema FROM roles WHERE id = $1', [Number(rolId) || 0]);
  if (!rol) return 'Elegí un rol válido';
  // Sólo quien administra roles puede otorgar el rol Administrador.
  if (rol.sistema && !tiene(req, 'roles.gestionar')) return 'Sólo un administrador puede asignar el rol Administrador';
  return null;
}

r.post('/usuarios', can('usuarios.gestionar'), async (req, res) => {
  const usuario = txt(req.body.usuario, 30).toLowerCase();
  const nombre = txt(req.body.nombre, 80);
  const password = String(req.body.password || '');
  if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) return bad(res, 'Usuario: 3 a 30 caracteres (letras, números, punto, guion)');
  if (!nombre) return bad(res, 'El nombre es obligatorio');
  if (password.length < 6) return bad(res, 'La contraseña debe tener al menos 6 caracteres');
  const err = await validarRol(req, req.body.rol_id);
  if (err) return bad(res, err);
  const u = await one(
    'INSERT INTO usuarios (usuario, nombre, password_hash, rol_id, activo) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [usuario, nombre, await bcrypt.hash(password, 10), Number(req.body.rol_id), req.body.activo !== false],
  );
  await log(req, 'usuario.crear', usuario);
  res.status(201).json(u);
});

r.put('/usuarios/:id', can('usuarios.gestionar'), async (req, res) => {
  const u = await one('SELECT u.*, r.sistema FROM usuarios u JOIN roles r ON r.id = u.rol_id WHERE u.id = $1', [
    req.params.id,
  ]);
  if (!u) return bad(res, 'Usuario inexistente', 404);
  const nombre = txt(req.body.nombre, 80);
  const activo = req.body.activo !== false;
  const rolId = Number(req.body.rol_id) || u.rol_id;
  if (!nombre) return bad(res, 'El nombre es obligatorio');
  if (u.sistema && !tiene(req, 'roles.gestionar')) return bad(res, 'Sólo un administrador puede modificar a otro administrador', 403);
  if (rolId !== u.rol_id) {
    const err = await validarRol(req, rolId);
    if (err) return bad(res, err);
  }
  const esYo = u.id === req.user.id;
  if (esYo && (!activo || rolId !== u.rol_id)) return bad(res, 'No podés darte de baja ni cambiarte el rol a vos mismo');
  if (u.sistema && u.activo && (!activo || rolId !== u.rol_id) && !(await quedaOtroAdmin(u.id))) {
    return bad(res, 'Tiene que quedar al menos un Administrador activo');
  }
  await query('UPDATE usuarios SET nombre = $1, rol_id = $2, activo = $3 WHERE id = $4', [nombre, rolId, activo, u.id]);
  if (req.body.password) {
    if (String(req.body.password).length < 6) return bad(res, 'La contraseña debe tener al menos 6 caracteres');
    await query('UPDATE usuarios SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(String(req.body.password), 10), u.id]);
  }
  await log(req, 'usuario.editar', `${u.usuario}${req.body.password ? ' (nueva contraseña)' : ''}${activo ? '' : ' (baja)'}`);
  res.json({ ok: true });
});

r.delete('/usuarios/:id', can('usuarios.gestionar'), async (req, res) => {
  const u = await one('SELECT u.*, r.sistema FROM usuarios u JOIN roles r ON r.id = u.rol_id WHERE u.id = $1', [
    req.params.id,
  ]);
  if (!u) return bad(res, 'Usuario inexistente', 404);
  if (u.id === req.user.id) return bad(res, 'No podés eliminar tu propio usuario');
  if (u.sistema && !tiene(req, 'roles.gestionar')) return bad(res, 'Sólo un administrador puede eliminar a otro administrador', 403);
  if (u.sistema && !(await quedaOtroAdmin(u.id))) return bad(res, 'Tiene que quedar al menos un Administrador activo');
  await query('DELETE FROM usuarios WHERE id = $1', [u.id]);
  await log(req, 'usuario.eliminar', u.usuario);
  res.json({ ok: true });
});

// ───────────────────────── Personal ─────────────────────────

r.get('/personal', can('personal.ver', 'turnos.gestionar'), async (req, res) => {
  res.json(
    await query(`
      SELECT p.*, (SELECT COUNT(*)::int FROM asignaciones a WHERE a.personal_id = p.id) AS turnos
      FROM personal p ORDER BY p.apellido, p.nombre`),
  );
});

function datosPersona(b) {
  const p = {
    dni: soloDigitos(b.dni),
    nombre: txt(b.nombre, 60),
    apellido: txt(b.apellido, 60),
    telefono: txt(b.telefono, 40),
    observaciones: txt(b.observaciones, 300),
    activo: b.activo !== false,
  };
  if (p.dni.length < 6 || p.dni.length > 9) return { error: 'DNI inválido (6 a 9 dígitos)' };
  if (!p.nombre || !p.apellido) return { error: 'Nombre y apellido son obligatorios' };
  return { p };
}

r.post('/personal', can('personal.gestionar'), async (req, res) => {
  const { p, error } = datosPersona(req.body);
  if (error) return bad(res, error);
  const row = await one(
    `INSERT INTO personal (dni, nombre, apellido, telefono, observaciones, activo)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [p.dni, p.nombre, p.apellido, p.telefono, p.observaciones, p.activo],
  );
  await log(req, 'personal.crear', nombrePersona(row));
  res.status(201).json(row);
});

r.put('/personal/:id', can('personal.gestionar'), async (req, res) => {
  const { p, error } = datosPersona(req.body);
  if (error) return bad(res, error);
  const row = await one(
    `UPDATE personal SET dni = $1, nombre = $2, apellido = $3, telefono = $4, observaciones = $5, activo = $6
     WHERE id = $7 RETURNING *`,
    [p.dni, p.nombre, p.apellido, p.telefono, p.observaciones, p.activo, req.params.id],
  );
  if (!row) return bad(res, 'Persona inexistente', 404);
  await log(req, 'personal.editar', nombrePersona(row) + (row.activo ? '' : ' (baja)'));
  res.json(row);
});

r.delete('/personal/:id', can('personal.gestionar'), async (req, res) => {
  const p = await one(
    `SELECT p.*, (SELECT COUNT(*)::int FROM asignaciones WHERE personal_id = p.id AND entrada IS NOT NULL) AS marcas
     FROM personal p WHERE id = $1`,
    [req.params.id],
  );
  if (!p) return bad(res, 'Persona inexistente', 404);
  if (p.marcas) return bad(res, 'Tiene asistencias registradas: desactivala en lugar de eliminarla');
  await query('DELETE FROM personal WHERE id = $1', [p.id]);
  await log(req, 'personal.eliminar', nombrePersona(p));
  res.json({ ok: true });
});

// Importación masiva: una persona por línea → DNI; Nombre; Apellido; Teléfono (opcional).
r.post('/personal/importar', can('personal.gestionar'), async (req, res) => {
  const lineas = String(req.body.texto || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let creados = 0;
  let actualizados = 0;
  const errores = [];
  for (const [i, linea] of lineas.entries()) {
    const cols = linea.split(/\t|;|,/).map((c) => c.trim());
    if (i === 0 && !/\d/.test(cols[0])) continue; // encabezado
    const { p, error } = datosPersona({ dni: cols[0], nombre: cols[1], apellido: cols[2], telefono: cols[3] });
    if (error) {
      errores.push(`Línea ${i + 1}: ${error} → "${linea.slice(0, 60)}"`);
      continue;
    }
    const row = await one(
      `INSERT INTO personal (dni, nombre, apellido, telefono) VALUES ($1, $2, $3, $4)
       ON CONFLICT (dni) DO UPDATE SET nombre = EXCLUDED.nombre, apellido = EXCLUDED.apellido,
         telefono = CASE WHEN EXCLUDED.telefono = '' THEN personal.telefono ELSE EXCLUDED.telefono END
       RETURNING (xmax = 0) AS nuevo`,
      [p.dni, p.nombre, p.apellido, p.telefono],
    );
    row.nuevo ? creados++ : actualizados++;
  }
  await log(req, 'personal.importar', `${creados} nuevos, ${actualizados} actualizados, ${errores.length} errores`);
  res.json({ creados, actualizados, errores });
});

// ───────────────────────── Turnos (plantilla de horarios) ─────────────────────────

const SEL_TURNOS = `
  SELECT t.*,
    (SELECT COUNT(*)::int FROM asignaciones a WHERE a.turno_id = t.id) AS asignados,
    (SELECT COUNT(*)::int FROM asignaciones a WHERE a.turno_id = t.id AND a.entrada IS NOT NULL) AS ingresaron
  FROM turnos t`;

r.get('/turnos', can('turnos.ver'), async (req, res) => {
  const fecha = String(req.query.fecha || '');
  res.json(
    FECHA.test(fecha)
      ? await query(`${SEL_TURNOS} WHERE t.fecha = $1 ORDER BY t.hora_inicio, t.nombre`, [fecha])
      : await query(`${SEL_TURNOS} ORDER BY t.fecha, t.hora_inicio, t.nombre`),
  );
});

// Liviano: lo usa la pantalla de asistencia para elegir la fecha por defecto.
r.get('/turnos/resumen', can('asistencia.ver', 'turnos.ver'), async (req, res) => {
  res.json(await query('SELECT id, fecha, hora_inicio, hora_fin FROM turnos ORDER BY fecha, hora_inicio'));
});

r.get('/turnos/:id', can('turnos.ver'), async (req, res) => {
  const turno = await one(`${SEL_TURNOS} WHERE t.id = $1`, [req.params.id]);
  if (!turno) return bad(res, 'Turno inexistente', 404);
  turno.asignaciones = await query(
    'SELECT id, personal_id, puesto, entrada, salida FROM asignaciones WHERE turno_id = $1',
    [turno.id],
  );
  res.json(turno);
});

function datosTurno(b) {
  const t = {
    nombre: txt(b.nombre, 60),
    fecha: String(b.fecha || ''),
    hora_inicio: String(b.hora_inicio || ''),
    hora_fin: String(b.hora_fin || ''),
    puesto: txt(b.puesto, 100),
    tolerancia: Math.max(0, Math.min(240, parseInt(b.tolerancia, 10) || 0)),
    color: /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#6366f1',
  };
  if (!t.nombre) return { error: 'El nombre del turno es obligatorio' };
  if (!FECHA.test(t.fecha)) return { error: 'Fecha inválida' };
  if (!HORA.test(t.hora_inicio) || !HORA.test(t.hora_fin)) return { error: 'Horario inválido (HH:MM)' };
  return { t };
}

r.post('/turnos', can('turnos.gestionar'), async (req, res) => {
  const { t, error } = datosTurno(req.body);
  if (error) return bad(res, error);
  const row = await one(
    `INSERT INTO turnos (nombre, fecha, hora_inicio, hora_fin, puesto, tolerancia, color)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [t.nombre, t.fecha, t.hora_inicio, t.hora_fin, t.puesto, t.tolerancia, t.color],
  );
  await log(req, 'turno.crear', `${t.nombre} ${t.fecha} ${t.hora_inicio}-${t.hora_fin}`);
  res.status(201).json(row);
});

r.put('/turnos/:id', can('turnos.gestionar'), async (req, res) => {
  const { t, error } = datosTurno(req.body);
  if (error) return bad(res, error);
  const row = await one(
    `UPDATE turnos SET nombre = $1, fecha = $2, hora_inicio = $3, hora_fin = $4, puesto = $5, tolerancia = $6, color = $7
     WHERE id = $8 RETURNING *`,
    [t.nombre, t.fecha, t.hora_inicio, t.hora_fin, t.puesto, t.tolerancia, t.color, req.params.id],
  );
  if (!row) return bad(res, 'Turno inexistente', 404);
  await log(req, 'turno.editar', `${t.nombre} ${t.fecha} ${t.hora_inicio}-${t.hora_fin}`);
  res.json(row);
});

r.delete('/turnos/:id', can('turnos.gestionar'), async (req, res) => {
  const t = await one('SELECT * FROM turnos WHERE id = $1', [req.params.id]);
  if (!t) return bad(res, 'Turno inexistente', 404);
  await query('DELETE FROM turnos WHERE id = $1', [t.id]);
  await log(req, 'turno.eliminar', `${t.nombre} ${t.fecha}`);
  res.json({ ok: true });
});

// Define exactamente quiénes deben presentarse en el turno.
// Quien ya tiene la entrada marcada no se quita, para no perder el registro.
r.put('/turnos/:id/personal', can('turnos.gestionar'), async (req, res) => {
  const turno = await one('SELECT * FROM turnos WHERE id = $1', [req.params.id]);
  if (!turno) return bad(res, 'Turno inexistente', 404);
  const ids = new Set((Array.isArray(req.body.personal_ids) ? req.body.personal_ids : []).map(Number).filter(Number.isInteger));
  const resultado = await tx(async (t) => {
    const actuales = await t.query('SELECT id, personal_id, entrada FROM asignaciones WHERE turno_id = $1', [turno.id]);
    const yaEstan = new Set(actuales.map((a) => a.personal_id));
    let agregados = 0;
    let quitados = 0;
    let conservados = 0;
    for (const pid of ids) {
      if (yaEstan.has(pid)) continue;
      const ins = await t.query(
        'INSERT INTO asignaciones (turno_id, personal_id) SELECT $1, id FROM personal WHERE id = $2 ON CONFLICT DO NOTHING RETURNING id',
        [turno.id, pid],
      );
      agregados += ins.length;
    }
    for (const a of actuales) {
      if (ids.has(a.personal_id)) continue;
      if (a.entrada) conservados++;
      else {
        await t.query('DELETE FROM asignaciones WHERE id = $1', [a.id]);
        quitados++;
      }
    }
    return { agregados, quitados, conservados };
  });
  await log(req, 'turno.asignar', `${turno.nombre} ${turno.fecha}: +${resultado.agregados} / -${resultado.quitados}`);
  res.json(resultado);
});

r.post('/turnos/:id/duplicar', can('turnos.gestionar'), async (req, res) => {
  const t = await one('SELECT * FROM turnos WHERE id = $1', [req.params.id]);
  if (!t) return bad(res, 'Turno inexistente', 404);
  const fecha = String(req.body.fecha || '');
  if (!FECHA.test(fecha)) return bad(res, 'Fecha inválida');
  const nuevo = await tx(async (q) => {
    const [n] = await q.query(
      `INSERT INTO turnos (nombre, fecha, hora_inicio, hora_fin, puesto, tolerancia, color)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [txt(req.body.nombre, 60) || t.nombre, fecha, t.hora_inicio, t.hora_fin, t.puesto, t.tolerancia, t.color],
    );
    if (req.body.con_personal !== false) {
      await q.query(
        'INSERT INTO asignaciones (turno_id, personal_id, puesto) SELECT $1, personal_id, puesto FROM asignaciones WHERE turno_id = $2',
        [n.id, t.id],
      );
    }
    return n;
  });
  await log(req, 'turno.duplicar', `${t.nombre} ${t.fecha} → ${fecha}`);
  res.status(201).json(nuevo);
});

// ───────────────────────── Asistencia ─────────────────────────

const SEL_REG = `
  SELECT a.id, a.turno_id, a.personal_id, a.puesto, a.entrada, a.salida, a.observaciones,
         a.entrada_por AS entrada_por_id, a.salida_por AS salida_por_id,
         ue.nombre AS entrada_por, us.nombre AS salida_por,
         p.dni, p.nombre, p.apellido, p.telefono, t.nombre AS turno, t.fecha
  FROM asignaciones a
  JOIN personal p ON p.id = a.personal_id
  JOIN turnos t ON t.id = a.turno_id
  LEFT JOIN usuarios ue ON ue.id = a.entrada_por
  LEFT JOIN usuarios us ON us.id = a.salida_por`;

const registro = (id) => one(`${SEL_REG} WHERE a.id = $1`, [id]);

r.get('/asistencia', can('asistencia.ver'), async (req, res) => {
  const fecha = String(req.query.fecha || '');
  if (!FECHA.test(fecha)) return bad(res, 'Fecha inválida');
  const turnos = await query('SELECT * FROM turnos WHERE fecha = $1 ORDER BY hora_inicio, nombre', [fecha]);
  const registros = await query(`${SEL_REG} WHERE t.fecha = $1 ORDER BY p.apellido, p.nombre`, [fecha]);
  res.json({ turnos, registros, servidor: new Date().toISOString() });
});

r.post('/asistencia/:id/entrada', can('asistencia.marcar'), async (req, res) => {
  const ok = await one(
    'UPDATE asignaciones SET entrada = now(), entrada_por = $2 WHERE id = $1 AND entrada IS NULL RETURNING id',
    [req.params.id, req.user.id],
  );
  const reg = await registro(req.params.id);
  if (!reg) return bad(res, 'Registro inexistente', 404);
  if (!ok) return res.status(409).json({ error: `${reg.apellido}, ${reg.nombre} ya tenía la entrada marcada`, registro: reg });
  await log(req, 'asistencia.entrada', `${nombrePersona(reg)} – ${reg.turno}`);
  res.json(reg);
});

r.post('/asistencia/:id/salida', can('asistencia.marcar'), async (req, res) => {
  const ok = await one(
    `UPDATE asignaciones SET salida = now(), salida_por = $2
     WHERE id = $1 AND entrada IS NOT NULL AND salida IS NULL RETURNING id`,
    [req.params.id, req.user.id],
  );
  const reg = await registro(req.params.id);
  if (!reg) return bad(res, 'Registro inexistente', 404);
  if (!ok) {
    const error = reg.entrada ? 'Ya tenía la salida marcada' : 'Primero hay que marcar la entrada';
    return res.status(409).json({ error, registro: reg });
  }
  await log(req, 'asistencia.salida', `${nombrePersona(reg)} – ${reg.turno}`);
  res.json(reg);
});

// Deshacer una marca: cualquiera puede deshacer la suya dentro de 5 minutos (dedo rápido);
// después hace falta el permiso de corregir.
r.post('/asistencia/:id/anular', can('asistencia.marcar', 'asistencia.corregir'), async (req, res) => {
  const campo = req.body.campo === 'salida' ? 'salida' : 'entrada';
  const reg = await registro(req.params.id);
  if (!reg) return bad(res, 'Registro inexistente', 404);
  if (!reg[campo]) return bad(res, `No tiene ${campo} marcada`);
  if (campo === 'entrada' && reg.salida) return bad(res, 'Primero anulá la salida');
  const propia = reg[`${campo}_por_id`] === req.user.id && Date.now() - new Date(reg[campo]).getTime() < 5 * 60 * 1000;
  if (!propia && !tiene(req, 'asistencia.corregir')) {
    return bad(res, 'Sólo podés deshacer tus propias marcas de los últimos 5 minutos. Pedile a un jefe que lo corrija.', 403);
  }
  await query(`UPDATE asignaciones SET ${campo} = NULL, ${campo}_por = NULL WHERE id = $1`, [reg.id]);
  await log(req, `asistencia.anular_${campo}`, `${nombrePersona(reg)} – ${reg.turno}`);
  res.json(await registro(reg.id));
});

// Corrección manual de horarios (por ejemplo, alguien que entró y no se marcó a tiempo).
r.put('/asistencia/:id', can('asistencia.corregir'), async (req, res) => {
  const reg = await registro(req.params.id);
  if (!reg) return bad(res, 'Registro inexistente', 404);
  const fecha = (v) => (v === null || v === '' ? null : Number.isNaN(Date.parse(v)) ? undefined : new Date(v));
  const entrada = fecha(req.body.entrada);
  const salida = fecha(req.body.salida);
  if (entrada === undefined || salida === undefined) return bad(res, 'Fecha u hora inválida');
  if (salida && !entrada) return bad(res, 'No puede haber salida sin entrada');
  if (salida && entrada && salida < entrada) return bad(res, 'La salida no puede ser anterior a la entrada');
  const cambio = (a, b) => (a ? a.getTime() : null) !== (b ? new Date(b).getTime() : null);
  await query(
    `UPDATE asignaciones SET entrada = $2, salida = $3, puesto = $4, observaciones = $5,
       entrada_por = CASE WHEN $6::boolean THEN $8::int ELSE entrada_por END,
       salida_por = CASE WHEN $7::boolean THEN $8::int ELSE salida_por END
     WHERE id = $1`,
    [
      reg.id,
      entrada,
      salida,
      txt(req.body.puesto ?? reg.puesto, 100),
      txt(req.body.observaciones ?? reg.observaciones, 300),
      cambio(entrada, reg.entrada),
      cambio(salida, reg.salida),
      req.user.id,
    ],
  );
  const nuevo = await registro(reg.id);
  const hora = (d) => (d ? new Date(d).toISOString() : '—');
  await log(req, 'asistencia.corregir', `${nombrePersona(reg)} – ${reg.turno}: entrada ${hora(nuevo.entrada)}, salida ${hora(nuevo.salida)}`);
  res.json(nuevo);
});

r.put('/asistencia/:id/observaciones', can('asistencia.marcar', 'asistencia.corregir'), async (req, res) => {
  const row = await one('UPDATE asignaciones SET observaciones = $2 WHERE id = $1 RETURNING id', [
    req.params.id,
    txt(req.body.observaciones, 300),
  ]);
  if (!row) return bad(res, 'Registro inexistente', 404);
  res.json(await registro(row.id));
});

// Alta rápida desde la puerta: agrega a alguien al turno (y lo crea en el padrón si no existe).
r.post('/asistencia/agregar', can('turnos.gestionar'), async (req, res) => {
  const turno = await one('SELECT * FROM turnos WHERE id = $1', [Number(req.body.turno_id) || 0]);
  if (!turno) return bad(res, 'Elegí un turno');
  const dni = soloDigitos(req.body.dni);
  let p = await one('SELECT * FROM personal WHERE dni = $1', [dni]);
  if (!p) {
    if (!tiene(req, 'personal.gestionar')) return bad(res, 'Ese DNI no está en el padrón y no tenés permiso para darlo de alta', 403);
    const { p: datos, error } = datosPersona(req.body);
    if (error) return bad(res, error);
    p = await one('INSERT INTO personal (dni, nombre, apellido, telefono) VALUES ($1, $2, $3, $4) RETURNING *', [
      datos.dni,
      datos.nombre,
      datos.apellido,
      datos.telefono,
    ]);
    await log(req, 'personal.crear', nombrePersona(p));
  } else if (!p.activo) {
    return bad(res, `${p.apellido}, ${p.nombre} está dado de baja en el padrón de personal`);
  }
  const a = await one(
    'INSERT INTO asignaciones (turno_id, personal_id, puesto) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id',
    [turno.id, p.id, txt(req.body.puesto, 100)],
  );
  if (!a) return bad(res, `${p.apellido}, ${p.nombre} ya está en el turno ${turno.nombre}`, 409);
  await log(req, 'turno.asignar', `${nombrePersona(p)} → ${turno.nombre} ${turno.fecha}`);
  res.status(201).json(await registro(a.id));
});

// ───────────────────────── Auditoría ─────────────────────────

r.get('/auditoria', can('auditoria.ver'), async (req, res) => {
  res.json(
    await query(`
      SELECT a.id, a.accion, a.detalle, a.fecha, u.nombre AS usuario
      FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
      ORDER BY a.id DESC LIMIT 1000`),
  );
});

export default r;
